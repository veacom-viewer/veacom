// `window.veacom` for the browser (viewer.veacom.app): the same bridge the desktop's preload offers, with the engine in
// a Web Worker instead of a separate process. Files never leave the computer: the user's own File objects go to the
// Worker, which reads them where they are.
//
// As on the desktop, a file choice becomes a one-time capability the page passes back to import, series carry the
// engine generation they belong to, and a crashed engine is replaced by a fresh one with the next generation.
import type { CoreState, DesktopBridge, ImportResult, Series, UpdateStatus } from '../model';
import { coreErrorText, coreText } from '../i18n/core';
import { t } from '../i18n';
import { handOverPixels } from '../imaging/pixelHandoff';
import type { EngineExport, EngineInfo, EnginePixels, EngineRequest } from './engine.worker';
import { checkDecoderConfig, checkSample, mp4Header } from './mp4';
import { zipStored, type ZipEntry } from './zip';

type Request = EngineRequest extends infer R ? R extends { id: number } ? Omit<R, 'id'> : never : never;
/** A request sent or waiting. `abandoned`: its caller gave up, so its answer is dropped. `cancelled`: Cancel set the
 * engine's flag for it, which its answer clears. */
type Pending = { resolve: (value: never) => void; reject: (error: Error) => void; busy: boolean; op: Request['op']; abandoned?: boolean; cancelled?: boolean };
interface CallOptions {
  /** A job the progress bar shows (an import, a whole series): Cancel reaches it. */
  busy?: boolean;
  /** The caller's own abort: a request still waiting is dropped, a whole series still decoding is stopped. */
  signal?: AbortSignal;
  /** Told the request's number as soon as it waits, so it can be cancelled before it starts. */
  onQueued?: (id: number) => void;
}
interface SelectedFile { path: string; file: File }
interface Selection { files: SelectedFile[]; roots: string[]; zip: boolean }
type Progress = { id?: number; running: boolean; stage: string; completed: number; total: number; cancelled: boolean };

const LOCALE_KEY = 'veacom.locale';
/** How long a cancelled job may take to stop before the engine is replaced. */
const CANCEL_GRACE_MS = 8000;
/** After a crash the engine starts again after these pauses, as the desktop's engine process does
 * (electron/engine-process.cjs). One more crash leaves it stopped until the page is reloaded, rather than restarting an
 * engine that cannot start (a module that fails to load, say) for ever. */
const RESTART_DELAYS_MS = [250, 1000];
/** How many series one confirmation of a full cleanup lists (see `reviewPixels`). */
const REVIEW_PAGE = 12;
/** How long the threads build's helpers may take to start before the engine runs on one thread instead. */
const HELPER_START_MS = 15_000;

function storedLocale(): 'tr' | 'en' {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === 'tr' || saved === 'en') return saved;
  } catch { /* No storage (private window): the browser's language decides. */ }
  return navigator.language.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

/** Files from the last drop on the page, taken before the interface's own drop handler (see `watchDrops`). */
let dropped: { files: File[]; entries: FileSystemEntry[] } | null = null;

/** The files of dropped folders can only be read through the drop's entries, and only while the drop event runs: this
 * capture-phase listener keeps them for `importFiles`, which the interface calls from its own drop handler. */
export function watchDrops(): void {
  document.addEventListener('drop', event => {
    const transfer = event.dataTransfer;
    if (!transfer?.types.includes('Files')) return;
    dropped = {
      files: Array.from(transfer.files),
      entries: Array.from(transfer.items).map(item => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => Boolean(entry)),
    };
  }, true);
}

async function walk(root: FileSystemEntry): Promise<SelectedFile[]> {
  const found: { path: string; entry: FileSystemFileEntry }[] = [];
  const visit = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) { found.push({ path, entry: entry as FileSystemFileEntry }); return; }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      await Promise.all(batch.map(child => visit(child, `${path}/${child.name}`)));
    }
  };
  await visit(root, root.name);
  return Promise.all(found.map(({ path, entry }) => new Promise<{ path: string; file: File }>((resolve, reject) => entry.file(file => resolve({ path, file }), reject))));
}

type FileHandle = { kind: 'file'; name: string; getFile(): Promise<File> };
type FolderHandle = { kind: 'directory'; name: string; values(): AsyncIterable<FileHandle | FolderHandle> };
type FolderPicker = (options: { mode: 'read'; id?: string }) => Promise<FolderHandle>;

/** Every file in a folder chosen with the File System Access API, by its path from the folder. */
async function readFolder(folder: FolderHandle): Promise<SelectedFile[]> {
  const found: { path: string; handle: FileHandle }[] = [];
  const visit = async (handle: FolderHandle, path: string): Promise<void> => {
    const folders: Promise<void>[] = [];
    for await (const entry of handle.values()) {
      if (entry.kind === 'file') found.push({ path: `${path}/${entry.name}`, handle: entry });
      else folders.push(visit(entry, `${path}/${entry.name}`));
    }
    await Promise.all(folders);
  };
  await visit(folder, folder.name);
  return Promise.all(found.map(async ({ path, handle }) => ({ path, file: await handle.getFile() })));
}

/** Asks the browser for files: several, a folder (with everything inside it, a disc's too) or a ZIP. */
function chooseFiles(kind: 'files' | 'folder' | 'archive'): Promise<SelectedFile[][]> {
  // Chrome and Edge ask "Upload N files to this site?" for a folder chosen the classic way, although nothing is
  // uploaded; their folder picker only asks to let the site view the files. Other browsers ask nothing either way.
  const picker = (window as { showDirectoryPicker?: FolderPicker }).showDirectoryPicker;
  if (kind === 'folder' && picker) {
    return picker.call(window, { mode: 'read', id: 'veacom-open' }).then(async folder => [await readFolder(folder)], (error: Error) => {
      if (error?.name === 'AbortError') return [];
      throw error;
    });
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = kind !== 'archive';
    if (kind === 'folder') input.webkitdirectory = true;
    if (kind === 'archive') input.accept = '.zip,application/zip';
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [], file => ({ path: file.webkitRelativePath || file.name, file }));
      if (kind !== 'folder') { resolve(files.map(file => [file])); return; }
      const folders = new Map<string, SelectedFile[]>();
      for (const file of files) {
        const name = file.path.split('/')[0];
        const folder = folders.get(name);
        if (folder) folder.push(file);
        else folders.set(name, [file]);
      }
      resolve([...folders.values()]);
    }, { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

/** A file name without folders or characters file systems refuse. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'VEAcom';
}

function download(name: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.rel = 'noopener';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function createWebBridge(): DesktopBridge {
  let locale = storedLocale();
  let generation = 0, restartCount = 0, crashes = 0, requestId = 0, selectionNumber = 0;
  let worker: Worker | undefined;
  let state: CoreState = { status: 'starting', generation: 0, restartCount: 0 };
  let progress: Progress = { running: false, stage: '', completed: 0, total: 0, cancelled: false };
  let cancelTimer: ReturnType<typeof setTimeout> | undefined, restartTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, Pending>();
  const stateListeners = new Set<(state: CoreState) => void>();
  const selections = new Map<string, Selection>();
  const known = new Map<string, number>();
  /** Each series as the engine last listed it: its catalog revision, and what the export review names it by. */
  const described = new Map<string, Series>();
  // The cancel flag the engine reads while it works: the bridge request id, or zero. Only a cross-origin
  // isolated page has shared memory. Elsewhere (a host without the site's headers) the single-thread engine runs and
  // cannot see a flag while it works, so a Cancel there replaces the engine once CANCEL_GRACE_MS have passed.
  const cancel = self.crossOriginIsolated ? new Int32Array(new SharedArrayBuffer(4)) : null;
  // In the threads build, the same flag and the progress record inside the engine's own shared memory: while a decode
  // runs on the pool, the engine's Worker waits for it and passes nothing on.
  let shared: { cancel: Int32Array; progress: Uint32Array } | null = null;
  // The DICOM export under way, for its Cancel.
  let exporting: { id: number; cancelled: boolean } | null = null;
  // The threads build's helper Workers, started here for the engine Worker (see startHelpers).
  let helpers: Worker[] = [];

  const publish = (next: CoreState) => { state = next; for (const listener of stateListeners) listener({ ...state }); };
  const setCancel = (value: number) => { if (cancel) Atomics.store(cancel, 0, value); if (shared) Atomics.store(shared.cancel, 0, value); };

  /** Fails every request sent or waiting: the engine that had them answers none. */
  function failPending(): void {
    for (const { reject } of pending.values()) reject(new Error(t('engine.restartedReopen')));
    pending.clear();
  }

  /** A new engine generation: whatever the old engine was doing fails, and the interface hears of it. */
  function start(message?: string): void {
    clearTimeout(restartTimer);
    failPending();
    generation++;
    spawn();
    publish({ status: 'ready', generation, restartCount, ...(message ? { message } : {}) });
  }

  /** The engine crashed or could not start. It starts again after a pause, as on the desktop, but not a third time. */
  function crashed(): void {
    restartCount++;
    stop();
    failPending();
    if (crashes >= RESTART_DELAYS_MS.length) {
      publish({ status: 'failed', generation, restartCount, message: t('engine.reloadPage') });
      return;
    }
    publish({ status: 'restarting', generation, restartCount, message: t('engine.restartingNow') });
    restartTimer = setTimeout(() => start(t('engine.restartedEmpty')), RESTART_DELAYS_MS[crashes++]);
  }

  // WebAssembly memory only grows. Once every series is closed and nothing runs, a fresh engine Worker takes the old
  // one's place and the browser gets its memory back. Nothing open refers to the old engine, so the generation stays.
  let releaseWhenIdle = false, releases = 0;
  function releaseMemory(): void {
    // Files being imported fill the catalog again, and series listed since are open: nothing to give back. Asked again
    // when the requests have drained, since an import answered by then has added its series.
    if (known.size || [...pending.values()].some(request => request.op === 'import' && !request.abandoned)) {
      releaseWhenIdle = false;
      return;
    }
    releaseWhenIdle = pending.size > 0;
    if (releaseWhenIdle) return;
    spawn();
    // For the measurement tools (web/tools): how many times the memory was given back.
    document.documentElement.dataset.engineReleases = String(++releases);
  }
  const releaseWhenDrained = () => { if (releaseWhenIdle && !pending.size) setTimeout(() => { if (releaseWhenIdle) releaseMemory(); }); };

  // Requests wait here and go to the engine one at a time, as it works through them in order. A slice for the screen
  // (or a series' tags, or the list) goes ahead of whole series waiting before it: a series of 400 CT slices takes
  // seconds to decode, a slice milliseconds, and the first image should not wait for the series.
  let queue: { id: number; request: Request }[] = [];
  let inFlight: number | null = null, dispatching = false;
  const QUICK: ReadonlySet<string> = new Set(['frame', 'tags', 'list']);
  function dispatch(): void {
    dispatching = false;
    if (!worker || inFlight !== null || !queue.length) return;
    const first = queue.findIndex(item => item.request.op !== 'volume');
    const [next] = queue.splice(first > 0 && QUICK.has(queue[first].request.op) ? first : 0, 1);
    inFlight = next.id;
    worker.postMessage({ id: next.id, ...next.request });
  }
  // Requests made together (a series and its first slice) are sorted before the first one goes out.
  const dispatchSoon = () => { if (!dispatching) { dispatching = true; setTimeout(dispatch); } };

  /** Ends the engine Worker and its helpers, and forgets what was waiting for them. */
  function stop(): void {
    worker?.terminate();
    worker = undefined;
    for (const helper of helpers) helper.terminate();
    helpers = [];
    queue = []; inFlight = null;
    known.clear(); clearTimeout(cancelTimer); cancelTimer = undefined; shared = null; setCancel(0);
    progress = { running: false, stage: '', completed: 0, total: 0, cancelled: false };
  }

  /** A fresh engine Worker, in place of the old one. */
  function spawn(): void {
    stop();
    const own = worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    own.onmessage = ({ data }) => {
      if (own !== worker) return;
      if (data.type === 'progress') {
        if (data.value.id === inFlight && data.value.running) progress = data.value;
        return;
      }
      if (data.type === 'helpers') { startHelpers(own, data); return; }
      if (data.id !== inFlight) return;
      const request = pending.get(data.id);
      if (!request) return;
      inFlight = null;
      pending.delete(data.id);
      releaseWhenDrained();
      if (request.cancelled) { clearTimeout(cancelTimer); cancelTimer = undefined; setCancel(0); }
      if (data.fatal) {
        console.error('The imaging engine stopped:', data.error, data.detail ?? '');
        request.reject(new Error(t('engine.restartedReopen')));
        crashed();
        return;
      }
      dispatch();
      if (request.abandoned) return;
      if (data.ok) { request.resolve(data.value as never); return; }
      request.reject(new Error(coreErrorText(data.error, locale)));
    };
    // A module that does not load, or an error outside any request.
    own.onerror = () => { if (own === worker) crashed(); };
    void call<EngineInfo>({ op: 'init', ...(cancel ? { cancel: cancel.buffer as SharedArrayBuffer } : {}) }).then(info => {
      if (own !== worker) return;
      if (info.shared) shared = { cancel: new Int32Array(info.shared.buffer, info.shared.cancel, 1), progress: new Uint32Array(info.shared.buffer, info.shared.progress, 4) };
      // For the measurement tools (web/tools): how many threads decode.
      document.documentElement.dataset.engineThreads = String(info.threads);
    }, () => {});
  }

  /** Starts the threads build's helper Workers for the engine Worker `engine`, on its module and memory, and tells it on
   * `port` whether they all started. They are started here rather than in the engine Worker so that one that stops (a
   * panic aborts the threads build) reaches the page, which then replaces the engine: an engine run waiting for that
   * helper would otherwise wait for ever, and its Worker could hear nothing. */
  function startHelpers(engine: Worker, request: { module: WebAssembly.Module; memory: WebAssembly.Memory; count: number; port: MessagePort }): void {
    const started: Worker[] = [];
    let waiting = request.count, settled = false;
    const settle = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Not started: the engine runs on one thread instead, without these.
      if (error) { for (const helper of started) helper.terminate(); helpers = helpers.filter(helper => !started.includes(helper)); }
      request.port.postMessage(error ? { ok: false, error } : { ok: true });
      request.port.close();
    };
    const stopped = (error: string) => { if (!settled) settle(error); else if (engine === worker) crashed(); };
    const timer = setTimeout(() => settle('the threads did not start in time'), HELPER_START_MS);
    for (let index = 0; index < request.count; index++) {
      const helper = new Worker(new URL('./engine.helper.ts', import.meta.url), { type: 'module' });
      started.push(helper); helpers.push(helper);
      helper.onmessage = ({ data }) => {
        if (data?.type === 'ready') { if (--waiting === 0) settle(); return; }
        if (data?.type === 'failed') {
          console.error('An engine thread stopped:', data.error);
          stopped(String(data.error || 'a thread stopped'));
        }
      };
      helper.onerror = () => stopped('a thread could not start');
      helper.postMessage({ module: request.module, memory: request.memory });
    }
  }

  function call<T>(request: Request, { busy = false, signal, onQueued }: CallOptions = {}): Promise<T> {
    // Stopped for good (see crashed): nothing would answer.
    if (state.status === 'failed') return Promise.reject(new Error(state.message ?? t('engine.unavailable')));
    if (signal?.aborted) return Promise.reject(signal.reason);
    do { requestId = (requestId + 1) >>> 0; } while (!requestId || pending.has(requestId));
    const id = requestId;
    onQueued?.(id);
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: never) => void, reject, busy, op: request.op });
      // New files keep the engine busy again: no release waits any more.
      if (request.op === 'import') releaseWhenIdle = false;
      queue.push({ id, request });
      signal?.addEventListener('abort', () => abandon(id, signal.reason), { once: true });
      dispatchSoon();
    });
  }

  /** Takes a request out of the queue before it starts: false once it has started (or ended). */
  function unqueue(id: number): boolean {
    const at = queue.findIndex(item => item.id === id);
    if (at < 0) return false;
    queue.splice(at, 1);
    pending.delete(id);
    releaseWhenDrained();
    return true;
  }

  /** A request its caller gave up on (a slice scrolled past, a series left): dropped while it waits, and its answer
   * ignored once it runs. A whole series still decoding is stopped, as the desktop stops a request the interface
   * abandons: the single engine thread would otherwise decode it before what the reader is waiting for. */
  function abandon(id: number, reason: unknown): void {
    const request = pending.get(id);
    if (!request || request.abandoned) return;
    request.abandoned = true;
    request.reject(reason instanceof Error ? reason : new DOMException('The request was abandoned.', 'AbortError'));
    if (unqueue(id)) return;
    if (id === inFlight && request.busy) { request.cancelled = true; setCancel(id); }
  }

  function cancelRequest(id: number, error: Error): boolean {
    const request = pending.get(id);
    if (!request) return false;
    if (unqueue(id)) { request.reject(error); return true; }
    if (id !== inFlight) return false;
    request.cancelled = true;
    setCancel(id);
    cancelTimer ??= setTimeout(() => {
      if (id === inFlight && pending.get(id) === request) { restartCount++; start(t('engine.restartedEmpty')); }
    }, CANCEL_GRACE_MS);
    return true;
  }

  /** Progress belongs to the busy request being dispatched, including while it waits for its first engine report. */
  function currentProgress(): Progress {
    const active = inFlight !== null && (pending.get(inFlight)?.busy || (progress.running && progress.id === inFlight));
    const id = active ? inFlight : queue.find(job => pending.get(job.id)?.busy)?.id;
    if (id == null) return { ...progress, running: false };
    const request = pending.get(id)!;
    const current = progress.id === id ? { ...progress } : {
      id, running: true, stage: request.op === 'volume' ? 'decode' : 'import', completed: 0, total: 0, cancelled: false,
    };
    current.cancelled ||= Boolean(request.cancelled);
    if (!shared || id !== inFlight) return current;
    const record = shared.progress;
    if (Atomics.load(record, 3) === id && Atomics.load(record, 0)) {
      current.completed = Atomics.load(record, 1);
      current.total = Atomics.load(record, 2);
    }
    return current;
  }

  function requireGeneration(value: number): void {
    if (value !== generation) throw new Error(t('engine.restartedReopen'));
  }

  function catalog(result: ImportResult): ImportResult {
    const series = result.series.map(item => ({ ...item, engineGeneration: generation }) as Series);
    for (const item of series) { known.set(item.id, generation); described.set(item.id, item); }
    return { ...result, series };
  }

  /** A full cleanup keeps the pixels. As the desktop asks in its own window, the reader confirms here that the selected
   * series show no identifying text: in the browser's own dialog, which the page's content cannot draw, with the
   * desktop's texts, and like the desktop a page of series at a time, so every one is shown.
   *
   * Unlike the desktop's window this is no approval from outside the page, as nothing in a page can approve above the
   * page itself. A page changed to skip it (from the browser's developer tools, or by an attack) could as well export
   * without any cleanup, which needs no review. So in the browser it is a check for the reader, not a security
   * boundary (web/README.md). */
  function reviewPixels(ids: string[], frame?: number): boolean {
    const label = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu, ' ').slice(0, 80);
    const lines = ids.map(id => {
      const item = described.get(id);
      return (item && [item.patientName, item.patientId, item.description, item.studyUid, item.uid].map(label).filter(Boolean).join(' · ')) || id;
    });
    const pages = Math.ceil(lines.length / REVIEW_PAGE);
    for (let page = 0; page < pages; page++) {
      const from = page * REVIEW_PAGE, shown = lines.slice(from, from + REVIEW_PAGE);
      const position = pages === 1 ? '' : t(page + 1 < pages ? 'export.reviewPageNext' : 'export.reviewPageLast', { from: from + 1, to: from + shown.length, total: lines.length });
      if (!window.confirm([t('export.reviewTitle'), t('export.reviewMessage', { count: ids.length }), t('export.reviewDetail'), shown.join('\n'), position,
        frame === undefined ? '' : t('export.reviewSlice', { n: frame + 1 })].filter(Boolean).join('\n\n'))) return false;
    }
    return true;
  }

  function remember(groups: SelectedFile[][]): string[] {
    const selected = groups.filter(group => group.length).map(files => ({ name: files[0].path.split('/')[0], files }));
    if (!selected.length) return [];
    const counts = new Map<string, number>();
    for (const { name } of selected) counts.set(name, (counts.get(name) ?? 0) + 1);
    const folder = `/in/${++selectionNumber}`;
    const files: SelectedFile[] = [], roots: string[] = [];
    for (const root of selected) {
      // Keep unambiguous siblings together for DICOMDIR. Each colliding file or folder gets its own parent.
      const parent = counts.get(root.name) === 1 ? folder : `/in/${++selectionNumber}`;
      roots.push(`${parent}/${root.name}`);
      if (new Set(root.files.map(item => item.path)).size !== root.files.length) throw new Error(t('import.duplicatePaths'));
      for (const { path, file } of root.files) files.push({ path: `${parent}/${path}`, file });
    }
    const token = `import:${crypto.randomUUID()}`;
    const zip = selected.some(root => root.files[0].path === root.name && root.name.toLowerCase().endsWith('.zip'));
    selections.set(token, { files, roots, zip });
    return [token];
  }

  const updates: UpdateStatus = { phase: 'manual', currentVersion: 'web', message: '', canDownload: false, canInstall: false, sourceBuild: true };
  const unsupported = (key: Parameters<typeof t>[0]) => () => Promise.reject(new Error(t(key)));
  // Pictures and videos being exported, gathered here until they are downloaded.
  const pictures = new Map<string, { name: string; files: ZipEntry[] }>();
  const videos = new Map<string, { name: string; fps: number; config?: { width: number; height: number; config: Uint8Array<ArrayBuffer> };
    samples: Uint8Array<ArrayBuffer>[]; sizes: number[]; keyFrames: number[] }>();

  start();

  return {
    web: true,
    // No disc burning, no folder of its own to write to, no ZIP re-encoding (JPEG-LS is not in the browser's engine),
    // no self-update, and no feedback service the page may reach.
    // A page cannot find a disc or offer the import window; folders, files and ZIPs open through the browser's pickers
    // (a disc's folder among them).
    features: { discBurning: false, usbExport: false, exportFolder: false, zipExport: false, importWindow: false, discImport: false, updates: false, feedback: false },
    get locale() { return locale; },
    async setLocale(value) { locale = value; try { localStorage.setItem(LOCALE_KEY, value); } catch { /* Not kept. */ } },
    takeStartupPaths: async () => [],
    getCoreState: async () => ({ ...state }),
    onCoreState(listener) { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },

    async openPaths(kind) { return remember(await chooseFiles(kind)); },
    async importFiles(files) {
      const drop = dropped;
      dropped = null;
      const same = drop && drop.files.length === files.length && drop.files.every((file, i) => file === files[i]);
      return remember(same && drop.entries.length ? await Promise.all(drop.entries.map(walk)) : files.map(file => [{ path: file.name, file }]));
    },
    async importSelected(capabilities) {
      const chosen = capabilities.map(token => selections.get(token));
      if (!chosen.length || chosen.some(selection => !selection)) throw new Error('This file selection is invalid or expired. Choose it again.');
      for (const token of capabilities) selections.delete(token);
      const files = chosen.flatMap(selection => selection!.files), roots = chosen.flatMap(selection => selection!.roots);
      const result = catalog(await call<ImportResult>({ op: 'import', files, roots }, { busy: true }));
      return { ...result, source: chosen.some(selection => selection!.zip) ? 'zip' : 'disk' };
    },
    // The engine answers one request at a time, so it cannot publish series while an import runs: every series
    // arrives with the import's own result.
    async importEarly() { return { import: 0, series: [] }; },
    async listSeries() { return catalog(await call<ImportResult>({ op: 'list' })); },
    async getProgress() { return currentProgress(); },
    async cancelOperation(id) {
      const shown = currentProgress();
      if (!shown.running || shown.id === undefined || (id !== undefined && id !== shown.id)) return { requested: false };
      const error = new Error(coreText({ code: 'job.cancelled', text: 'Operation cancelled' }, locale));
      return { requested: cancelRequest(shown.id, error) };
    },
    async getTags(seriesId, requestGeneration, frame, revision) {
      requireGeneration(requestGeneration);
      // The catalog revision the tag panel shows, as on the desktop: the engine refuses it for a series imported again
      // since, rather than answering with the new series' tags.
      return call({ op: 'tags', seriesId, ...(revision === undefined ? {} : { revision }), ...(frame === undefined ? {} : { frame }) });
    },
    // A region's statistics or a window from the source pixels (imaging/nativeMeasurements.ts).
    async measure(seriesId, requestGeneration, revision, operation) {
      requireGeneration(requestGeneration);
      return call({ op: 'sample', seriesId, revision, operation: JSON.stringify(operation) });
    },
    async removeSeries(ids, requestGeneration) {
      requireGeneration(requestGeneration);
      const mine = [...new Set(ids)].filter(id => known.get(id) === generation);
      if (!mine.length) return { removed: 0 };
      const result = await call<{ removed: number; remaining: number }>({ op: 'remove', ids: mine });
      for (const id of mine) { known.delete(id); described.delete(id); }
      if (result.remaining === 0 && requestGeneration === generation) releaseMemory();
      return result;
    },
    getPixels: () => Promise.reject(new Error('The browser build hands pixels over with fetchPixels.')),
    async fetchPixels({ seriesId, generation: requestGeneration, revision, index }, signal) {
      requireGeneration(requestGeneration);
      if (known.get(seriesId) !== generation) throw new Error(t('engine.seriesNotOpen'));
      const pixels = await (index === undefined
        ? call<EnginePixels>({ op: 'volume', seriesId, revision }, { busy: true, signal })
        : call<EnginePixels>({ op: 'frame', seriesId, index, revision }, { signal }));
      const headers = new Headers({
        'Content-Type': 'application/octet-stream', 'Content-Length': String(pixels.bytes.byteLength),
        'X-Pixel-Type': pixels.pixelType, 'X-Components': String(pixels.components),
      });
      if (pixels.index !== undefined) headers.set('X-Source-Frame-Index', String(pixels.index));
      if (pixels.sopInstanceUid) headers.set('X-SOP-Instance-UID', pixels.sopInstanceUid);
      if (pixels.sourceFrameNumber !== undefined) headers.set('X-Source-Frame-Number', String(pixels.sourceFrameNumber));
      // The engine's bytes arrive in an ArrayBuffer of their own, moved from the Worker without a copy, and go on to the
      // interface the same way.
      const { bytes } = pixels;
      const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer as ArrayBuffer : bytes.slice().buffer;
      return handOverPixels(own, headers);
    },

    openExternal: async url => { window.open(url, '_blank', 'noopener,noreferrer'); },
    async saveFile(suggestedName, data) { download(suggestedName, new Blob([data])); return suggestedName; },
    copyText: text => navigator.clipboard.writeText(text),

    // Exports end in the browser's downloads: DICOM (with a DICOMDIR when asked) and pictures as one ZIP, video as MP4.
    async exportDicom(seriesIds, options) {
      const ids = Array.isArray(seriesIds) ? seriesIds : [seriesIds];
      if (options.engineGeneration !== undefined) requireGeneration(options.engineGeneration);
      if (ids.some(id => known.get(id) !== generation)) throw new Error(t('engine.seriesNotOpen'));
      // A full cleanup exports only the revisions the reader reviewed; declined, nothing is exported.
      const full = options.anonymize && Boolean(options.full);
      if (full && !reviewPixels(ids, options.frame)) return null;
      const reviewed = full ? Object.fromEntries(ids.flatMap(id => { const revision = described.get(id)?.catalogRevision; return revision === undefined ? [] : [[id, revision]]; })) : {};
      const job = { id: 0, cancelled: false };
      exporting = job;
      try {
        const exported = await call<EngineExport>({ op: 'export', ids, ...(options.frame === undefined ? {} : { frame: options.frame }),
          options: { anonymize: options.anonymize, full: Boolean(options.full), dicomdir: options.dicomdir, decompress: Boolean(options.decompress) }, reviewed },
          { onQueued: id => { job.id = id; } });
        // Cancelled as the engine finished: nothing is downloaded, as a cancelled desktop export leaves nothing behind.
        if (job.cancelled) throw new Error(t('export.cancelled'));
        const name = `${exported.result.directory.split('/').pop() || 'VEACOM'}.zip`;
        download(name, zipStored(exported.files));
        return { ...exported.result, directory: name };
      } finally {
        if (exporting === job) exporting = null;
      }
    },
    // The export dialog's and the status bar's Cancel: an export still waiting never starts; one under way stops at the
    // engine's next file (the engine then drops what it wrote), and an engine that does not stop is replaced.
    async cancelExport() {
      const job = exporting;
      if (!job || job.cancelled) return;
      job.cancelled = true;
      cancelRequest(job.id, new Error(t('export.cancelled')));
    },
    async beginImages(suggestedName) {
      const id = crypto.randomUUID();
      pictures.set(id, { name: `${safeName(suggestedName)}.zip`, files: [] });
      return { id, directory: `${safeName(suggestedName)}.zip` };
    },
    async appendImage(id, name, data) {
      const job = pictures.get(id);
      if (!job) throw new Error(t('video.inactive'));
      job.files.push({ name: safeName(name), bytes: new Uint8Array(data) });
    },
    async finishImages(id) {
      const job = pictures.get(id);
      pictures.delete(id);
      if (!job?.files.length) throw new Error(t('video.noFrames'));
      download(job.name, zipStored(job.files));
      return job.name;
    },
    async cancelImages(id) { pictures.delete(id); },
    async beginVideo(suggestedName, fps) {
      if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error(t('video.frameRate'));
      const id = crypto.randomUUID();
      videos.set(id, { name: `${safeName(suggestedName.replace(/\.mp4$/i, ''))}.mp4`, fps, samples: [], sizes: [], keyFrames: [] });
      return { id };
    },
    async configureVideo(id, { width, height, description }) {
      const job = videos.get(id);
      if (!job) throw new Error(t('video.inactive'));
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width * height > 36_000_000) throw new Error('Invalid video size.');
      job.config = { width, height, config: checkDecoderConfig(description) };
    },
    async appendVideo(id, sample, key) {
      const job = videos.get(id);
      if (!job?.config) throw new Error(t('video.inactive'));
      if (!job.sizes.length && !key) throw new Error('A video must start with a key frame.');
      const bytes = checkSample(sample);
      if (key) job.keyFrames.push(job.sizes.length);
      job.samples.push(bytes); job.sizes.push(bytes.length);
    },
    async finishVideo(id) {
      const job = videos.get(id);
      videos.delete(id);
      if (!job?.config || !job.sizes.length) throw new Error(t('video.noFrames'));
      const header = mp4Header({ ...job.config, fps: job.fps, sizes: job.sizes, keyFrames: job.keyFrames });
      download(job.name, new Blob([header, ...job.samples], { type: 'video/mp4' }));
      return job.name;
    },
    async cancelVideo(id) { videos.delete(id); },
    getAiConfig: async () => ({ enabled: false, configured: false, model: '' }),
    configureAi: unsupported('export.desktopRequired'),
    askSecondOpinion: unsupported('export.desktopRequired'),
    getVersion: () => 'web',
    getUpdateStatus: async () => updates,
    checkForUpdates: async () => updates,
    downloadUpdate: async () => updates,
    installUpdate: async () => updates,
    openUpdateNotes: async () => {},
    onUpdateStatus: () => () => {},
  };
}
