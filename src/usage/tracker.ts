// Usage timings in the renderer: one event per user action, so "how long, and how many actions, does
// X take?" can be answered afterwards in SQL (telemetry/clickhouse/ux-views.sql) for any X.
//
// An action is a click, a shortcut, a drag (pointer down to up), a wheel or key-repeat burst, or a drop.
// Each carries a stable action id (src/usage/actions.ts), the input kind, a monotonic time and the coarse
// state after it (modality, plane, layout, tool, window class) plus `changed`: which parts of the state
// it changed, compared with the previous event, so an action that changed nothing is visible as such.
// State that changes without an action (a series finishing loading) is reported as an `auto` event, so
// every change is attributed to exactly one event.
//
// Never recorded: names, IDs, UIDs, dates, paths, DICOM header text, typed text, pixels. Facet values
// stay in this module (they are compared, never sent); only their names leave it.
// Events reach the main process (electron/usage.cjs) only after the user has agreed to share them.

export type InputKind = 'mouse' | 'key' | 'wheel' | 'drag' | 'drop' | 'touch' | 'auto';
export type Surface = 'welcome' | 'viewer' | '3d' | 'assessment';

/** Parts of the state an action can change, most important first (`changed` keeps this order). */
export const FACETS = ['series', 'plane', 'window', 'zoom', 'layout', 'screen', 'slice', 'pan', 'tool', 'marks', 'scene',
  'orient', 'color', 'cross', 'seg', 'fusion', 'link', 'overlay', 'panel', 'menu', 'dialog', 'lang', 'prefs'] as const;
export type Facet = typeof FACETS[number];

export interface UsageSnapshot {
  surface: Surface;
  layout: string;
  tool: string;
  modality: string;
  plane: string;
  window: string;
  wl?: string;
  zoom?: number;
  seriesIndex: number;
  slicePct: number;
  /** Comparable values per facet. Never sent. */
  facets: Partial<Record<Facet, string>>;
}

export interface UsageEvent {
  name: 'ux.action' | 'ux.state' | 'ux.milestone' | 'ux.study.open' | 'ux.study.first_image' | 'ux.study.close';
  trace: string;
  span: string;
  /** Milliseconds since 1970 (performance.timeOrigin plus the monotonic clock). */
  start: number;
  duration: number;
  attributes: Record<string, string | number>;
}

export interface StudyInfo { modalities: string[]; series: number; slices: number; source?: string; result: 'ok' | 'empty' | 'error' }

interface Open {
  id: string; input: InputKind; start: number; last: number; steps: number;
  result?: string; hoverMs?: number; burst: boolean; ended: boolean; timer?: ReturnType<typeof setTimeout>;
}

/** Handle for a gesture that lasts (a drag): end it when the pointer is released. */
export interface GestureHandle { end(options?: { id?: string; result?: 'ok' | 'cancel'; input?: InputKind }): void; setResult(result: 'ok' | 'cancel'): void; }

const BURST_GAP = 400;      // wheel ticks, key repeats and slider steps closer than this are one action
const SETTLE = 120;         // time for React to commit an action's effect before the state is read
const AUTO_SETTLE = 300;    // state changes without an action are reported once they settle
const RING = 5000;
const SEND_EVERY = 2000;
const MODALITY = /^[A-Z]{1,8}$/;

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), value => value.toString(16).padStart(2, '0')).join('');
const clock = () => performance.now();
const epoch = (time: number) => Math.round((performance.timeOrigin + time) * 1000) / 1000;

/** The bucket a study's image count falls in: never the exact count. */
export function sliceBucket(count: number): string {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count < 10) return '2-9';
  if (count < 100) return '10-99';
  if (count < 500) return '100-499';
  if (count < 1000) return '500-999';
  if (count < 2000) return '1000-1999';
  return '2000+';
}

export function modalityMix(values: Iterable<string>): string {
  const codes = [...new Set([...values].map(value => MODALITY.test(value) ? value : 'OT'))].sort();
  return codes.slice(0, 16).join(',');
}

/** Facets whose values differ, in FACETS order, kept within the 100 characters an attribute may hold. */
export function changedFacets(before: UsageSnapshot | null, after: UsageSnapshot | null): string {
  if (!after) return '';
  const names: string[] = [];
  let length = 0;
  for (const facet of FACETS) {
    if ((before?.facets[facet] ?? '') === (after.facets[facet] ?? '')) continue;
    if (length + facet.length + (names.length ? 1 : 0) > 100) break;
    length += facet.length + (names.length ? 1 : 0); names.push(facet);
  }
  return names.join(',');
}

function stateAttributes(state: UsageSnapshot | null): Record<string, string | number> {
  if (!state) return {};
  const values: Record<string, string | number> = { 'veacom.surface': state.surface, 'veacom.layout': state.layout, 'veacom.tool': state.tool,
    'veacom.modality': MODALITY.test(state.modality) ? state.modality : 'none', 'veacom.plane': state.plane, 'veacom.window': state.window,
    'veacom.series_index': state.seriesIndex, 'veacom.slice_pct': state.slicePct };
  if (state.wl) values['veacom.wl'] = state.wl;
  if (state.zoom !== undefined && Number.isFinite(state.zoom)) values['veacom.zoom'] = Math.round(state.zoom * 100) / 100;
  return values;
}

export class UsageTracker {
  private provider: () => UsageSnapshot | null = () => null;
  private sink: ((events: UsageEvent[], final: boolean) => void) | null = null;
  private sharing = false;
  private queue: UsageEvent[] = [];
  private ring: UsageEvent[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  session = hex(16);
  private trace = this.session;
  private traceStart = clock();
  private study: { trace: string; start: number; series: Set<string>; firstImage: boolean; actions: number } | null = null;
  private last: UsageSnapshot | null = null;
  private open: Open | null = null;
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSince = 0;
  private hoverStart: number | null = null;
  private diagnostics: boolean;

  constructor(diagnostics = false) { this.diagnostics = diagnostics; }
  private get active(): boolean { return this.sharing || this.diagnostics; }
  /** The App's state, read after each action settles. */
  setStateProvider(provider: () => UsageSnapshot | null): void { this.provider = provider; if (this.active && !this.last) this.last = this.read(); }
  /** Where events go once the user agrees; until then they stay in this window's recent list only. */
  setSink(sink: ((events: UsageEvent[], final: boolean) => void) | null): void { this.sink = sink; }
  setSharing(sharing: boolean): void {
    if (sharing === this.sharing) return;
    this.sharing = sharing;
    if (this.open?.timer) clearTimeout(this.open.timer);
    if (this.sendTimer) clearTimeout(this.sendTimer);
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.open = null; this.sendTimer = null; this.autoTimer = null; this.queue = []; this.study = null;
    if (!this.diagnostics) this.ring = [];
    this.session = hex(16); this.trace = this.session; this.traceStart = clock();
    this.last = this.active ? this.read() : null; this.touched = {}; this.hoverStart = null;
  }

  private read(): UsageSnapshot | null {
    let state: UsageSnapshot | null;
    try { state = this.provider(); } catch { return null; }
    if (!state) return null;
    const facets = { ...state.facets };
    for (const [facet, count] of Object.entries(this.touched) as [Facet, number][]) facets[facet] = `${facets[facet] ?? ''}#${count}`;
    return { ...state, facets };
  }
  private base(name: UsageEvent['name'], start: number, duration: number, attributes: Record<string, string | number>): UsageEvent {
    return { name, trace: this.trace, span: hex(8), start: epoch(start), duration: Math.max(0, Math.round(duration * 1000) / 1000),
      attributes: { 'veacom.seq': ++this.seq, 'veacom.t_ms': Math.max(0, Math.round(start - this.traceStart)), ...attributes } };
  }
  private emit(event: UsageEvent): void {
    if (this.diagnostics) { this.ring.push(event); if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING); }
    if (!this.sharing || !this.sink) return;
    this.queue.push(event);
    if (this.queue.length >= 50) this.flush();
    else if (!this.sendTimer) this.sendTimer = setTimeout(() => this.flush(), SEND_EVERY);
  }
  /** Hands queued events to the main process. `final` is used while the page unloads. */
  flush(final = false): void {
    if (this.sendTimer) { clearTimeout(this.sendTimer); this.sendTimer = null; }
    if (!this.queue.length || !this.sink) return;
    const events = this.queue; this.queue = [];
    try { this.sink(events, final); } catch { /* Usage timings never interrupt the viewer. */ }
  }

  // ---- Actions ---------------------------------------------------------------------------------

  /** A discrete action (click, key, drop). With `burst`, repeats closer than 400 ms are one action. */
  action(id: string, input: InputKind, options: { burst?: boolean; hoverMs?: number; result?: 'ok' | 'cancel'; absorb?: string } = {}): void {
    if (!this.active) return;
    const now = clock(), open = this.open;
    if (options.burst && open && open.burst && open.ended && open.id === id && open.input === input && now - open.last < BURST_GAP) {
      open.last = now; open.steps++; this.schedule(open, BURST_GAP); return;
    }
    if (options.absorb && this.absorb(options.absorb, now)) { /* A double-click replaces its first click. */ }
    this.start({ id, input, start: now, last: now, steps: 1, burst: Boolean(options.burst), ended: true, hoverMs: options.hoverMs, result: options.result });
    this.schedule(this.open!, options.burst ? BURST_GAP : SETTLE);
  }

  /** A gesture with a duration (a drag). The action is reported when it ends and its effect settles. */
  begin(id: string, input: InputKind): GestureHandle {
    if (!this.active) return { setResult() {}, end() {} };
    const entry: Open = { id, input, start: clock(), last: clock(), steps: 1, burst: false, ended: false };
    this.start(entry);
    return {
      setResult: result => { entry.result = result; },
      end: ({ id: rename, result, input: kind } = {}) => {
        if (entry.ended) return;
        entry.ended = true; entry.last = clock();
        if (rename) entry.id = rename;
        if (kind) entry.input = kind;
        if (result) entry.result = result;
        if (this.open === entry) this.schedule(entry, SETTLE);
      },
    };
  }

  /** The action still open (a click that also completed a measurement) succeeded or was cancelled. */
  markResult(result: 'ok' | 'cancel'): void { if (this.open) this.open.result = result; }

  /**
   * Something the app finished (3D ready, a video written, a series loaded): marks a task's end; not a user
   * action. It leaves any action in progress open (a scroll while a series loads stays one scroll).
   */
  milestone(id: string, result: 'ok' | 'cancel' | 'error' = 'ok'): void {
    if (!this.active) return;
    const state = this.read();
    this.emit(this.base('ux.milestone', clock(), 0, { 'veacom.action': id, 'veacom.input': 'auto', 'veacom.result': result, ...stateAttributes(state) }));
  }

  /** Where the pointer entered the toolbar, for the hover time before a toolbar click. */
  toolbarHover(inside: boolean): void { if (this.active) this.hoverStart = inside ? clock() : null; }
  /** Time on the toolbar since the pointer entered it or since its last click there (the search for the next button). */
  hoverTime(): number | undefined {
    if (this.hoverStart === null) return undefined;
    const now = clock(), elapsed = Math.round(now - this.hoverStart);
    this.hoverStart = now; return elapsed;
  }

  /**
   * State that lives inside a component (the 3D scene, a dialog's fields, the filmstrip's search) changed:
   * counted so an action there is not mistaken for one that changed nothing.
   */
  touch(facet: Facet): void { if (this.active) this.touched[facet] = (this.touched[facet] ?? 0) + 1; }
  private touched: Partial<Record<Facet, number>> = {};

  private start(entry: Open): void {
    if (this.open) this.close(this.open);
    this.reportAuto();
    this.open = entry;
  }
  private schedule(entry: Open, delay: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { if (this.open === entry) this.close(entry); }, delay);
  }
  private absorb(prefix: string, now: number): boolean {
    if (this.open && this.open.id.startsWith(prefix) && now - this.open.start < 600) {
      if (this.open.timer) clearTimeout(this.open.timer);
      this.open = null; return true;
    }
    const previous = this.ring.at(-1);
    if (previous?.name === 'ux.action' && String(previous.attributes['veacom.action']).startsWith(prefix)
      && epoch(now) - previous.start < 600 && !previous.attributes['veacom.changed']) {
      this.ring.pop();
      const queued = this.queue.indexOf(previous); if (queued >= 0) this.queue.splice(queued, 1);
      if (this.study) this.study.actions--;
      return true;
    }
    return false;
  }
  private close(entry: Open): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.open === entry) this.open = null;
    const after = this.read();
    const changed = changedFacets(this.last, after);
    this.last = after ?? this.last;
    if (this.study) this.study.actions++;
    const attributes: Record<string, string | number> = { 'veacom.action': entry.id, 'veacom.input': entry.input, ...stateAttributes(after) };
    if (changed) attributes['veacom.changed'] = changed;
    if (entry.steps > 1) attributes['veacom.steps'] = entry.steps;
    if (entry.hoverMs !== undefined) attributes['veacom.hover_ms'] = Math.min(3_600_000, entry.hoverMs);
    if (entry.result) attributes['veacom.result'] = entry.result;
    this.emit(this.base('ux.action', entry.start, entry.last - entry.start, attributes));
  }
  /** Closes an action still settling, so what has happened so far is counted (tests, unload). */
  settle(): void { if (this.open) { if (!this.open.ended) this.open.ended = true; this.close(this.open); } this.reportAuto(); }

  // ---- State changes without an action -----------------------------------------------------------

  /** Called after each render: a change nobody asked for is reported once it settles. */
  observe(): void {
    if (!this.active || this.open || this.autoTimer) return;
    const now = this.read();
    if (!changedFacets(this.last, now)) return;
    this.autoSince = clock();
    this.autoTimer = setTimeout(() => { this.autoTimer = null; if (!this.open) this.reportAuto(); }, AUTO_SETTLE);
  }
  private reportAuto(): void {
    if (!this.active) return;
    if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = null; }
    const now = this.read(), changed = changedFacets(this.last, now);
    if (!changed) return;
    this.last = now;
    this.emit(this.base('ux.state', this.autoSince || clock(), 0, { 'veacom.input': 'auto', 'veacom.changed': changed, ...stateAttributes(now) }));
    this.autoSince = 0;
  }

  // ---- Studies ----------------------------------------------------------------------------------

  /**
   * A study starts opening: later events belong to it (a new random id per open). `startAt` (the monotonic
   * clock) dates it earlier: a study given at launch starts when the window was created.
   */
  beginStudy(trigger: string, startAt?: number): void {
    if (!this.active) return;
    this.settle();
    this.closeStudy('replaced');
    const start = startAt ?? clock();
    this.trace = hex(16); this.traceStart = start;
    this.study = { trace: this.trace, start, series: new Set(), firstImage: false, actions: 0 };
    this.pendingTrigger = trigger;
  }
  private pendingTrigger = 'other';

  /** The import finished (or failed): what kind of study it is, never what it contains. */
  studyOpened(info: StudyInfo, seriesIds: Iterable<string>): void {
    if (!this.active) return;
    if (!this.study) this.beginStudy('other');
    const study = this.study!;
    for (const id of seriesIds) study.series.add(id);
    const attributes: Record<string, string | number> = { 'veacom.trigger': this.pendingTrigger, 'veacom.result': info.result, 'veacom.session': this.session,
      'veacom.study.series': Math.max(0, Math.min(100000, Math.round(info.series))), 'veacom.study.slices': sliceBucket(info.slices) };
    const mix = modalityMix(info.modalities);
    if (mix) attributes['veacom.study.modality'] = mix;
    if (info.source && ['disk', 'cd', 'zip', 'network'].includes(info.source)) attributes['veacom.study.source'] = info.source;
    this.emit(this.base('ux.study.open', study.start, clock() - study.start, attributes));
  }

  /** A frame was drawn: the first one of the study's own series is its first image. */
  frameShown(seriesId: string | undefined): void {
    const study = this.study;
    if (!study || study.firstImage || !seriesId || !study.series.has(seriesId)) return;
    study.firstImage = true;
    // For tools/browser-bench, which reads the browser build's opening step by step from the page's timeline.
    if (typeof performance !== 'undefined') performance.mark('veacom:first-image');
    this.settle();
    // An instant at the moment the image appeared: its t_ms is the time from opening to the first image.
    const state = this.read(), changed = changedFacets(this.last, state);
    this.last = state ?? this.last;
    this.emit(this.base('ux.study.first_image', clock(), 0, { 'veacom.input': 'auto', ...(changed ? { 'veacom.changed': changed } : {}), ...stateAttributes(state) }));
  }

  /** The study is replaced by another or the app closes. */
  closeStudy(reason: 'replaced' | 'quit'): void {
    const study = this.study; if (!study) return;
    this.settle();
    this.emit(this.base('ux.study.close', clock(), 0, { 'veacom.result': reason, 'veacom.steps': study.actions, ...stateAttributes(this.read()) }));
    this.study = null;
  }

  // ---- Tests ------------------------------------------------------------------------------------

  /** The recent events of this window (the desktop checks count actions with these). */
  events(): UsageEvent[] { return [...this.ring]; }
}

export const usage = new UsageTracker(typeof window !== 'undefined' && Boolean(window.veacom?.localUsageCheck));
