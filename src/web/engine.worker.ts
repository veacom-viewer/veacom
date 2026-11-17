// The engine (native/, compiled to WebAssembly in web/engine) runs here, off the page's thread. Requests arrive one at
// a time and are answered in order, as the desktop engine's job queue does. While a request runs the engine sends its
// progress record itself, and stops when the page sets the shared cancel flag (src/web/bridge.ts).
//
// Where the page is cross-origin isolated, the threads build is used: a series is decoded on this Worker's thread and
// on a few helper Workers that share the module's memory (engine.helper.ts, web/engine/src/helpers.rs). To leave the
// computer room, the engine works on at most half its cores and never more than 4; the helpers sleep when there is
// nothing to do. Each helper reads the files it was sent. A separate Worker decodes PNG, JPEG and BMP on the same
// shared memory, including when there are no helpers. Without isolation or if startup fails, the single-thread build
// runs and refuses pictures.

import { readHeads } from '../../web/file-heads.js';
import type { HelperFiles } from './engine.helper';

type Engine = typeof import('../../web/engine/pkg/veacom_web_engine.js');
type ThreadedEngine = typeof import('../../web/engine/pkg-threads/veacom_web_engine.js');

const THREADS = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

// One channel to each helper, for the page's files (`shareFiles`), and the batches it has not answered yet.
let helperPorts: MessagePort[] = [];
let batches = 0;
const waiting = new Map<number, { left: number; done: () => void; shared: Promise<void> }>();
// A helper takes a batch the moment it is woken; one that has not after this long has stopped, and the page replaces
// the engine. Until then a series is decoded from files held in memory, as without the helpers' files.
const SHARE_TIMEOUT_MS = 5000;

/** Asks the page to start `count` helper Workers and the picture decoder on the threads build's module and memory, and
 * waits for its answer.
 * The page starts them, not this Worker: the threads build aborts on a panic, and a helper that stops so must reach the
 * page, which then replaces the engine. Sent here, its error would wait for this Worker, which may be the very thread
 * waiting for that helper. The page gives up after 15 s; then the single-thread build is used. Each helper also gets
 * one end of a channel to this Worker, for the page's files. */
function startHelpers(threaded: ThreadedEngine, count: number): Promise<void> {
  const [module, memory] = threaded.helperSetup() as [WebAssembly.Module, WebAssembly.Memory];
  const { port1, port2 } = new MessageChannel();
  const channels = Array.from({ length: count }, () => new MessageChannel());
  return new Promise((resolve, reject) => {
    port1.onmessage = ({ data }) => {
      port1.close();
      if (!data.ok) { reject(new Error(data.error || 'the threads did not start')); return; }
      helperPorts = channels.map(channel => channel.port1);
      for (const port of helperPorts) {
        port.onmessage = ({ data: answer }: MessageEvent<{ took: number }>) => {
          const batch = waiting.get(answer.took);
          if (batch && --batch.left === 0) { waiting.delete(answer.took); batch.done(); }
        };
      }
      resolve();
    };
    const files = channels.map(channel => channel.port2);
    scope.postMessage({ type: 'helpers', module, memory, count, port: port2, files }, [port2, ...files]);
  });
}

/** Sends every helper these page files, by the numbers the engine knows them by, and waits until each has taken them;
 * then the engine reads them on every thread (`filesOnHelpers`). */
function shareFiles(threaded: ThreadedEngine, ids: number[], files: File[]): void {
  if (!helperPorts.length || !ids.length) return;
  const batch = ++batches;
  let finish!: () => void;
  const shared = new Promise<void>(resolve => { finish = resolve; });
  const timer = setTimeout(() => { waiting.delete(batch); finish(); }, SHARE_TIMEOUT_MS);
  waiting.set(batch, { left: helperPorts.length, shared, done: () => {
    clearTimeout(timer);
    threaded.filesOnHelpers(Uint32Array.from(ids));
    finish();
  } });
  const message: HelperFiles = { batch, ids, files };
  for (const port of helperPorts) port.postMessage(message);
  threaded.wakeHelpers();
}

async function load(): Promise<{ engine: Engine; threaded?: ThreadedEngine; threads: number; memory: WebAssembly.Memory }> {
  if (self.crossOriginIsolated) {
    try {
      const threaded: ThreadedEngine = await import('../../web/engine/pkg-threads/veacom_web_engine.js');
      const exports = await threaded.default();
      await startHelpers(threaded, THREADS - 1);
      return { engine: threaded as unknown as Engine, threaded, threads: THREADS, memory: exports.memory };
    } catch (error) {
      console.warn('The threaded engine could not start; using one thread.', error);
    }
  }
  const single: Engine = await import('../../web/engine/pkg/veacom_web_engine.js');
  const exports = await single.default();
  return { engine: single, threads: 1, memory: exports.memory };
}
let engine: Engine;

// The page's files by the number the engine knows each by (`addFile`), for reading a series' files here before it is
// decoded (`prepareVolume`); and the page's cancel flag, when it has shared memory.
const pageFiles = new Map<number, File>();
let cancelFlag: Int32Array | undefined;
const READS_AT_ONCE = 8;

/** Lets go of the files the engine no longer lists, here and on the helpers: an import and a removal forget those no
 * series reads from. */
function forgetUnlisted(): void {
  const listed = new Set(engine.listedFiles());
  const gone = [...pageFiles.keys()].filter(id => !listed.has(id));
  for (const id of gone) pageFiles.delete(id);
  if (!gone.length) return;
  const message: HelperFiles = { forget: gone };
  for (const port of helperPorts) port.postMessage(message);
}

let preparingVolume: { id: number; stop: () => void } | undefined;

async function prepareVolume(threaded: ThreadedEngine, seriesId: string, request: number): Promise<void> {
  let active = true;
  const cancelled = () => !active || (cancelFlag !== undefined && (Atomics.load(cancelFlag, 0) >>> 0) === request);
  const stopped = new Promise<void>(resolve => {
    preparingVolume = { id: request, stop: () => { active = false; resolve(); } };
  });
  const preload = async () => {
    const beforeSharing = threaded.volumeFiles(seriesId);
    if (!beforeSharing) return;
    const pending = waiting.size > 0;
    if (pending) await Promise.all(Array.from(waiting.values(), batch => batch.shared));
    if (cancelled()) return;
    const ids = pending ? threaded.volumeFiles(seriesId) : beforeSharing;
    if (!ids?.length) return;
    let next = 0;
    const read = async () => {
      while (next < ids.length && !cancelled()) {
        const id = ids[next++], file = pageFiles.get(id);
        if (!file) continue;
        let bytes: ArrayBuffer;
        try { bytes = await file.arrayBuffer(); }
        catch { continue; } // The engine retries unreadable files and reports the error.
        if (!cancelled()) threaded.holdFile(id, new Uint8Array(bytes));
      }
    };
    await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, ids.length) }, read));
  };
  try {
    await Promise.race([preload(), stopped]);
    if (cancelled()) throw new Error(JSON.stringify({ note: { code: 'job.cancelled', text: 'Operation cancelled' } }));
  } catch (error) {
    threaded.releaseHeldFiles();
    throw error;
  } finally {
    // Reads already started can finish after the bridge clears this request's shared flag.
    active = false;
    preparingVolume = undefined;
  }
}

export type EngineRequest =
  // `cancel`: the page's cancel flag, where the page is cross-origin isolated and so has shared memory.
  | { id: number; op: 'init'; cancel?: SharedArrayBuffer }
  | { id: number; op: 'import'; files: { path: string; file: File }[]; roots: string[] }
  | { id: number; op: 'list' }
  | { id: number; op: 'remove'; ids: string[] }
  // `revision`: the catalog revision the request was made for; the engine refuses it for a series imported again since.
  | { id: number; op: 'volume'; seriesId: string; revision?: number }
  | { id: number; op: 'frame'; seriesId: string; index: number; revision?: number }
  | { id: number; op: 'tags'; seriesId: string; frame?: number; revision?: number }
  | { id: number; op: 'sample'; seriesId: string; revision: number; operation: string }
  // `reviewed`: the catalog revision of each series whose pixels the reader reviewed (a full cleanup needs it).
  | { id: number; op: 'export'; ids: string[]; frame?: number; options: { anonymize: boolean; full?: boolean; dicomdir: boolean; decompress?: boolean }; reviewed: Record<string, number> };

/** How the engine runs: its thread count and, in the threads build, where the shared cancel flag and progress record
 * are (byte addresses in the module's shared memory). */
export interface EngineInfo { threads: number; shared?: { buffer: SharedArrayBuffer; cancel: number; progress: number } }
export interface EngineExport { result: { directory: string; files: number; warnings: string[] }; files: { name: string; bytes: Uint8Array }[] }
export interface EnginePixels { bytes: Uint8Array; pixelType: string; components: number; index?: number; sopInstanceUid?: string; sourceFrameNumber?: number }

const ready = load().then(loaded => { engine = loaded.engine; return loaded; });
const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<EngineRequest | { cancelVolume: number }>) => void) | null };

// A panic's message is written to console.error just before the engine stops; it goes with the crash report.
let lastError = '';
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => { lastError = args.map(String).join(' ').slice(0, 4000); consoleError(...args); };

async function answer(data: EngineRequest): Promise<void> {
  let loaded: Awaited<typeof ready>;
  try {
    loaded = await ready;
  } catch (error) {
    // The engine did not load (its module could not be fetched or compiled): nothing here can answer any request. The
    // page treats this as a crash, so it replaces this Worker and stops trying after a few attempts. wasm-bindgen
    // reports a failed fetch as a plain Error, which below would read as one of the engine's own answers.
    scope.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error), fatal: true, detail: 'The engine could not load.' });
    return;
  }
  try {
    let value: unknown, transfer: Transferable[] = [];
    engine.beginRequest(data.id);
    switch (data.op) {
      case 'init': {
        // Without shared memory the page cannot reach a flag while the engine works; this one stays 0.
        engine.watch((record: string) => scope.postMessage({ type: 'progress', value: JSON.parse(record) }), new Int32Array(data.cancel ?? new ArrayBuffer(4)));
        cancelFlag = data.cancel ? new Int32Array(data.cancel) : undefined;
        // In the threads build the module's memory is shared: the page reads progress and sets the cancel flag in it.
        // SharedArrayBuffer itself exists only where the page is cross-origin isolated.
        const [cancel, progress] = engine.sharedState();
        const shared = typeof SharedArrayBuffer === 'function' && loaded.memory.buffer instanceof SharedArrayBuffer ? { buffer: loaded.memory.buffer, cancel, progress } : undefined;
        value = { threads: loaded.threads, shared } satisfies EngineInfo;
        break;
      }
      case 'import': {
        const first = await readHeads(data.files);
        const ids: number[] = [];
        try {
          for (const [i, { path, file }] of data.files.entries()) {
            const id = engine.addFile(path, file, first[i]);
            ids.push(id);
            pageFiles.set(id, file);
          }
          value = JSON.parse(engine.importPaths(data.roots));
        } finally {
          if (ids.length < data.files.length) engine.pruneFiles();
          forgetUnlisted();
        }
        // The helpers take the files the import kept while the page asks for its first images; decoding a series waits
        // for them.
        if (loaded.threaded) {
          const kept = ids.flatMap(id => { const file = pageFiles.get(id); return file ? [{ id, file }] : []; });
          shareFiles(loaded.threaded, kept.map(({ id }) => id), kept.map(({ file }) => file));
        }
        break;
      }
      case 'list': value = JSON.parse(engine.listSeries()); break;
      case 'remove': value = JSON.parse(engine.removeSeries(data.ids)); forgetUnlisted(); break;
      case 'tags': value = JSON.parse(engine.tags(data.seriesId, data.frame, data.revision)); break;
      case 'sample': value = JSON.parse(engine.sample(data.seriesId, data.revision, data.operation)); break;
      case 'export': {
        const exported = engine.exportDicom(data.ids, data.frame, JSON.stringify(data.options), JSON.stringify(data.reviewed)) as { result: string; files: { name: string; bytes: Uint8Array }[] };
        value = { result: JSON.parse(exported.result), files: exported.files };
        transfer = exported.files.map(file => file.bytes.buffer);
        break;
      }
      case 'volume':
      case 'frame': {
        if (data.op === 'volume' && loaded.threaded) {
          await prepareVolume(loaded.threaded, data.seriesId, data.id);
        }
        const pixels =(data.op === 'volume' ? engine.volume(data.seriesId, data.revision) : engine.frame(data.seriesId, data.index, data.revision)) as EnginePixels;
        value = pixels; transfer = [pixels.bytes.buffer];
        break;
      }
    }
    scope.postMessage({ id: data.id, ok: true, value }, transfer);
  } catch (error) {
    // The engine's own messages arrive as plain Errors holding its JSON body. Anything else is the engine crashing
    // (a WebAssembly trap, a stack overflow): its state cannot be trusted any more, and the page replaces this Worker.
    const fatal = !(error instanceof Error && error.constructor === Error);
    scope.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error), fatal, detail: fatal ? lastError : undefined });
  }
}

scope.onmessage = ({ data }) => {
  if ('cancelVolume' in data) {
    if (preparingVolume?.id === data.cancelVolume) preparingVolume.stop();
  } else { void answer(data); }
};
