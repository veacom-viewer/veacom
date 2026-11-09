// Arrangements: how a study lays itself out, as data (src/arrangements/builtin.ts, docs/arrangements.md). This module
// matches them against a study, turns a match into panes, and reads and writes the ones a reader kept.
import type { Plane, Series, ViewState } from '../model';
import type { MessageKey } from '../i18n';
import { acquiredPlane, getPlaneFrame, sliceAtWorld } from '../imaging/geometry';
import { bodyWeightFactor, windowFor, windowIn, type QuantityUnit, type QuantityWindow } from '../imaging/quantity';
import { findRole, frameInView, ofKind, type RoleSpec } from './roles';
import { BUILTIN_ARRANGEMENTS, PET_FOLLOW_UP } from './builtin';
import { studyKey } from '../domain/patient';

export { findRole, frameInView, ROLE_RANKS, type RoleRank, type RoleSpec } from './roles';

/** The gamma camera views a pane can open on (CID 26, as NM readers abbreviate them). */
export const VIEWS = ['ANT', 'POST', 'RAO', 'LAO', 'RPO', 'LPO', 'R LAT', 'L LAT'] as const;

/** When an arrangement is tried: a study opens, the reader asks for a screen (the nuclear medicine screen in the fusion
 * button's menu), one series is picked into a pane, several are picked together, or the fusion button is pressed. */
export type Trigger = 'open' | 'screen' | 'pick' | 'pick-several' | 'fuse';
/** The arrangements a reader can keep: a whole screen, laid out when a study opens or when asked for. */
const keepable = (arrangement: Arrangement) => arrangement.when === 'open' || arrangement.when === 'screen';
/** What a pane shows of its series: the series itself, the series with another one fused over it, or a whole-volume MIP. */
export type PaneShow = 'plain' | 'fused' | 'mip';
export type Palette = NonNullable<ViewState['palette']>;
export interface PaneDisplay { palette?: Palette; invert?: boolean; window?: QuantityWindow }
export interface PaneSpec {
  role: string;
  /** The plane shown; the plane a series was acquired in shows its own slices. Unset: the acquired plane. */
  plane?: Plane;
  show?: PaneShow;
  /** For `fused`: the role drawn over this pane's series. */
  over?: string;
  /** For gamma camera frames: the view of the frame the pane opens on, such as `ANT` or `POST`. */
  view?: string;
  display?: PaneDisplay;
}
export interface Arrangement {
  id: string;
  when: Trigger;
  /** What the notices call it. */
  name?: MessageKey;
  /** `picked` is the series the reader picked, or shows in the active pane; its spec is a filter it must pass. */
  roles: Readonly<Record<string, RoleSpec>>;
  /** Rows × columns. `keep`: the panes on screen, only when there are as many as the arrangement lists. For several
   * picked series: by their count. */
  grid?: readonly [number, number] | 'keep' | Readonly<Record<number, readonly [number, number]>>;
  /** For several picked series, one `picked` pane stands for each of them. */
  panes: readonly PaneSpec[];
  /** `crosshair`: positions and the crosshair follow across panes in one frame of reference. `none`: each pane pages
   * on its own. */
  link?: 'crosshair' | 'none';
  /** `shared`: the panes showing the arrangement's PETs keep one SUV scale. Windowing one gives the others the same SUV
   * range, and inverting or recolouring one does the same to them. */
  scale?: 'shared';
  notice?: { key: MessageKey; params?: Readonly<Record<string, string>> };
  /** For several picked series: at most this many. */
  max?: number;
  /** Set on a reader's kept variant of a built-in arrangement. */
  kept?: boolean;
}
export interface PlannedPane { spec: PaneSpec; series: Series }
export interface Plan { arrangement: Arrangement; roles: Record<string, Series>; grid: [number, number] | null; panes: PlannedPane[] }
export interface MatchContext {
  /** The series the roles are found among: the study that opened, or every series for a pick. */
  series: readonly Series[];
  picked?: readonly Series[];
  /** How many panes are on screen. */
  panes?: number;
  /** Every series loaded, where roles in another study (`study: 'prior'`) are found: a study opens with its prior. */
  session?: readonly Series[];
}

/** The plan of the first arrangement for `trigger` whose roles are all found, or null. */
export function match(arrangements: readonly Arrangement[], trigger: Trigger, context: MatchContext): Plan | null {
  for (const arrangement of arrangements) {
    if (arrangement.when !== trigger) continue;
    const plan = planFor(arrangement, context);
    if (plan) return plan;
  }
  return null;
}

/** The series of every role, anchors first; null when a role has nothing to fill it. An anchor takes the best series
 * it ranks that leaves every role found beside it filled: a SPECT with no CT in its frame of reference gives way to the
 * next SPECT, as a PET without its CT gives way to the next PET. */
export function resolveRoles(arrangement: Arrangement, series: readonly Series[], picked?: Series, session: readonly Series[] = series): Record<string, Series> | null {
  const roles: Record<string, Series> = {};
  const pickedSpec = Object.hasOwn(arrangement.roles, 'picked') ? arrangement.roles.picked : undefined;
  if (pickedSpec) { if (!picked || !ofKind(pickedSpec, picked)) return null; roles.picked = picked; }
  else if (picked) roles.picked = picked;
  const pending = Object.entries(arrangement.roles).filter(([name]) => name !== 'picked');
  // Each role after its anchor; a role whose anchor nothing can fill leaves the arrangement unfilled.
  const placed = new Set(Object.keys(roles)), order: typeof pending = [];
  while (order.length < pending.length) {
    const next = pending.find(([name, spec]) => !placed.has(name) && (!spec.of || placed.has(spec.of)));
    if (!next) return null;
    order.push(next);
    placed.add(next[0]);
  }
  // Whether the roles from `index` on can all be filled: each takes the best series it ranks with which the rest can.
  const fill = (index: number): boolean => {
    if (index === order.length) return true;
    const [name, spec] = order[index];
    const found = findRole(spec, spec.study === 'prior' ? session : series, spec.of ? roles[spec.of] : null, item => {
      roles[name] = item;
      return fill(index + 1);
    });
    if (!found) { delete roles[name]; return false; }
    roles[name] = found;
    return fill(index + 1);
  };
  return fill(0) ? roles : null;
}

function planFor(arrangement: Arrangement, context: MatchContext): Plan | null {
  const picked = context.picked ?? [];
  if (arrangement.when === 'pick-several') {
    const items = picked.filter(item => !item.segmentation).slice(0, arrangement.max ?? 6);
    if (!items.length || !arrangement.grid || typeof arrangement.grid === 'string' || Array.isArray(arrangement.grid)) return null;
    const grid = (arrangement.grid as Readonly<Record<number, readonly [number, number]>>)[items.length] ?? [1, 1];
    const spec = arrangement.panes[0] ?? { role: 'picked' };
    return { arrangement, roles: {}, grid: [grid[0], grid[1]], panes: items.map(series => ({ spec, series })) };
  }
  if (arrangement.grid === 'keep' && context.panes !== arrangement.panes.length) return null;
  const roles = resolveRoles(arrangement, context.series, picked[0], context.session ?? context.series);
  if (!roles) return null;
  const grid = Array.isArray(arrangement.grid) ? [arrangement.grid[0], arrangement.grid[1]] as [number, number] : null;
  // Pane roles are plain strings the types do not tie to `roles`: a pane whose role is unfilled leaves no plan.
  if (!arrangement.panes.every(spec => Object.hasOwn(roles, spec.role))) return null;
  return { arrangement, roles, grid, panes: arrangement.panes.map(spec => ({ spec, series: roles[spec.role] })) };
}

/** A repeat study can share a quantitative window only if both PETs can be displayed in SUVbw. */
export function sharesSuvScale(plan: Plan): boolean {
  return plan.arrangement.scale === 'shared' && Object.values(plan.roles).every(series => bodyWeightFactor(series) !== null);
}

/** A pane's view: `base` (how the series opens anywhere) in the pane's plane, with its projection and display. */
export function paneView(series: Series, spec: PaneSpec, base: ViewState): ViewState {
  let view: ViewState = { ...base, pan: [...base.pan] };
  if (spec.show === 'mip' && series.canReconstruct) {
    view = { ...view, mode: 'mpr', plane: 'coronal', oblique: undefined, slab: undefined, projection: 'mip', slice: 0 };
  } else if (spec.plane && spec.plane !== acquiredPlane(series) && series.canReconstruct) {
    const center = getPlaneFrame(series, view).center, next: ViewState = { ...view, mode: 'mpr', plane: spec.plane, oblique: [0, 0] };
    view = { ...next, slice: sliceAtWorld(series, next, center) };
  }
  const frame = spec.view ? frameInView(series, spec.view) : -1;
  if (frame >= 0) {
    const common = base.windowMode === 'manual' ? base : series;
    view = { ...view, slice: frame, windowMode: 'manual', sharedWindow: true, windowCenter: common.windowCenter, windowWidth: common.windowWidth };
  }
  const display = spec.display;
  if (display?.palette) view.palette = display.palette === 'gray' ? undefined : display.palette;
  if (display?.invert !== undefined) view.inverted = display.invert;
  const window = display?.window && windowFor(series, display.window);
  if (window) view = { ...view, ...window, windowMode: 'manual' };
  return view;
}

/** The role a fused pane's overlay comes from, in a plan. */
export const overlayRole = (plan: Plan) => plan.panes.find(pane => pane.spec.show === 'fused')?.spec.over ?? null;

// A reader's kept arrangements: per built-in screen, the panes as they rearranged them, or, for one laid out when a
// study opens, `off` when they kept the screen VEAcom shows without it. A screen opened on request is never `off`: the
// reader who does not want it does not ask for it.
export const KEPT_STORAGE = 'veacom:arrangements:v1';
export type KeptVariant = { grid: [number, number]; panes: PaneSpec[] } | { off: true };
export type Kept = Record<string, KeptVariant>;

const PLANES: readonly Plane[] = ['axial', 'coronal', 'sagittal'];
const SHOWS: readonly PaneShow[] = ['plain', 'fused', 'mip'];
const PALETTES: readonly Palette[] = ['gray', 'hot', 'ge', 'rainbow'];
const UNITS: readonly QuantityUnit[] = ['SUV', 'HU'];

function validPane(value: unknown, roles: Readonly<Record<string, RoleSpec>>): PaneSpec | null {
  if (!value || typeof value !== 'object') return null;
  const pane = value as Record<string, unknown>;
  if (typeof pane.role !== 'string' || !(pane.role in roles) || pane.role === 'picked') return null;
  const result: PaneSpec = { role: pane.role };
  if (pane.plane !== undefined) { if (!PLANES.includes(pane.plane as Plane)) return null; result.plane = pane.plane as Plane; }
  if (pane.show !== undefined) { if (!SHOWS.includes(pane.show as PaneShow)) return null; result.show = pane.show as PaneShow; }
  if (result.show === 'fused') { if (typeof pane.over !== 'string' || !(pane.over in roles) || pane.over === pane.role) return null; result.over = pane.over; }
  if (pane.view !== undefined) { if (!VIEWS.includes(pane.view as typeof VIEWS[number])) return null; result.view = pane.view as string; }
  if (pane.display !== undefined) {
    if (!pane.display || typeof pane.display !== 'object') return null;
    const display = pane.display as Record<string, unknown>, kept: PaneDisplay = {};
    if (display.palette !== undefined) { if (!PALETTES.includes(display.palette as Palette)) return null; kept.palette = display.palette as Palette; }
    if (display.invert !== undefined) { if (typeof display.invert !== 'boolean') return null; kept.invert = display.invert; }
    if (display.window !== undefined) {
      const window = display.window as Record<string, unknown> | null;
      if (!window || !UNITS.includes(window.unit as QuantityUnit) || typeof window.from !== 'number' || typeof window.to !== 'number'
        || !Number.isFinite(window.from) || !Number.isFinite(window.to) || !(window.to > window.from)) return null;
      kept.window = { unit: window.unit as QuantityUnit, from: window.from, to: window.to };
    }
    result.display = kept;
  }
  return result;
}

/** Kept arrangements as stored, checked as `readSettings` checks the workspace: anything unknown or malformed is dropped. */
export function readKept(raw: string | null, builtins: readonly Arrangement[] = BUILTIN_ARRANGEMENTS): Kept {
  let stored: unknown;
  try { stored = JSON.parse(raw ?? 'null'); } catch { return {}; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const kept: Kept = {};
  for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
    const builtin = builtins.find(item => item.id === id && keepable(item));
    if (!builtin || !value || typeof value !== 'object') continue;
    const variant = value as Record<string, unknown>;
    if (variant.off === true) { if (builtin.when === 'open') kept[id] = { off: true }; continue; }
    const grid = variant.grid;
    if (!Array.isArray(grid) || grid.length !== 2 || !grid.every(n => Number.isInteger(n) && n >= 1 && n <= 5)) continue;
    if (!Array.isArray(variant.panes) || !variant.panes.length || variant.panes.length > grid[0] * grid[1]) continue;
    const panes = variant.panes.map(pane => validPane(pane, builtin.roles));
    if (panes.every((pane): pane is PaneSpec => pane !== null)) kept[id] = { grid: [grid[0], grid[1]], panes };
  }
  return kept;
}

/** A saved opt-out controls automatic opening. An explicit request can always open the built-in screen. */
export function withKept(kept: Kept, builtins: readonly Arrangement[] = BUILTIN_ARRANGEMENTS): Arrangement[] {
  return builtins.flatMap(arrangement => {
    if (!Object.hasOwn(kept, arrangement.id) || !keepable(arrangement)) return [arrangement];
    const variant = kept[arrangement.id];
    if ('off' in variant) return arrangement.when === 'screen' ? [arrangement] : [];
    return [{ ...arrangement, grid: variant.grid, panes: variant.panes, kept: true }];
  });
}

export function matchOnOpen(kept: Kept, context: MatchContext): Plan | null {
  const automatic = withKept(kept).filter(rule => rule.id !== PET_FOLLOW_UP.id || rule.kept);
  return match(automatic, 'open', context);
}

/** Match roles in the active patient’s study. Only an explicitly defined prior role searches the wider session. */
export function activeStudyContext(active: Series, session: Series[]): MatchContext {
  const key = studyKey(active);
  return { series: session.filter(item => studyKey(item) === key), session };
}

/** What a pane on screen shows, for keeping: its series and view, and the series fused over it, if any. */
export interface ShownPane { seriesId: string | null; view: ViewState; fusedWith: string | null }

/** The arrangement as the reader has rearranged it: each pane's role, plane, what it shows, the gamma camera view of
 * its frame and its look (palette, invert, and its window in the series' quantity). Null when a pane shows a series
 * that fills no role. */
export function deriveKept(plan: Plan, panes: readonly ShownPane[], grid: [number, number]): KeptVariant | null {
  const roleOf = (id: string | null) => id === null ? null : Object.entries(plan.roles).find(([name, series]) => name !== 'picked' && series.id === id) ?? null;
  const specs: PaneSpec[] = [];
  for (const pane of panes) {
    const role = roleOf(pane.seriesId);
    if (!role) return null;
    const [name, series] = role, view = pane.view;
    const spec: PaneSpec = { role: name };
    if (view.projection) { spec.plane = 'coronal'; spec.show = 'mip'; }
    else {
      spec.plane = view.mode === 'mpr' && series.canReconstruct ? view.plane : acquiredPlane(series) ?? 'axial';
      const over = roleOf(pane.fusedWith);
      if (over) { spec.show = 'fused'; spec.over = over[0]; } else spec.show = 'plain';
      const camera = series.frameMetadata?.[view.slice]?.nm?.view;
      if (camera && VIEWS.includes(camera as typeof VIEWS[number])) spec.view = camera;
    }
    const display: PaneDisplay = { palette: view.palette ?? 'gray', invert: view.inverted };
    if (view.windowMode === 'manual') {
      const unit: QuantityUnit = series.modality === 'PT' ? 'SUV' : 'HU', window = windowIn(series, view, unit);
      const round = (value: number) => Math.round(value * 100) / 100;
      if (window && window.to > window.from) display.window = { unit, from: round(window.from), to: round(window.to) };
    }
    spec.display = display;
    specs.push(spec);
  }
  return specs.length ? { grid, panes: specs } : null;
}

