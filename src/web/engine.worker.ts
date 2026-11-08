// The engine (native/, compiled to WebAssembly in web/engine) runs here, off the page's thread. Requests arrive one at
// a time and are answered in order, as the desktop engine's job queue does. While a request runs the engine sends its
// progress record itself, and stops when the page sets the shared cancel flag (src/web/bridge.ts).
//
// Where the page is cross-origin isolated, the threads build is used: a series is decoded on this Worker's thread and
// on a few helper Workers that share the module's memory (engine.helper.ts, web/engine/src/helpers.rs). To leave the
// computer room, the engine works on at most half its cores and never more than 4; the helpers sleep when there is
// nothing to decode. Elsewhere, or if the helpers cannot start, the single-thread build runs.
import { ownScript } from './trusted-types';

// The site's Trusted Types rule holds in Workers too: the helpers are started from here, and only this site's scripts
// may be started.
(self as { trustedTypes?: { createPolicy(name: string, rules: object): unknown } }).trustedTypes?.createPolicy('default', { createScriptURL: ownScript });

type Engine = typeof import('../../web/engine/pkg/veacom_web_engine.js');
type ThreadedEngine = typeof import('../../web/engine/pkg-threads/veacom_web_engine.js');

const THREADS = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
/** Kept so the helpers live as long as this Worker. */
const helpers: Worker[] = [];

/** Starts `count` helper Workers on the threads build's module and memory. A browser that cannot start a Worker from
 * a Worker, or a helper that fails to load, would leave the start waiting for ever: then, or after 15 s, the
 * single-thread build is used instead. */
async function startHelpers(threaded: ThreadedEngine, count: number): Promise<void> {
  const [module, memory] = threaded.helperSetup() as [WebAssembly.Module, WebAssembly.Memory];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Array.from({ length: count }, () => new Promise<void>((resolve, reject) => {
    const helper = new Worker(new URL('./engine.helper.ts', import.meta.url), { type: 'module' });
    helpers.push(helper);
    helper.onmessage = () => resolve();
    helper.onerror = () => reject(new Error('a thread could not start'));
    helper.postMessage({ module, memory });
  }));
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the threads did not start in time')), 15_000); });
  try {
    await Promise.race([Promise.all(started), late]);
  } catch (error) {
    for (const helper of helpers.splice(0)) helper.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function load(): Promise<{ engine: Engine; threads: number; memory: WebAssembly.Memory }> {
  if (self.crossOriginIsolated && THREADS > 1) {
    try {
      const threaded: ThreadedEngine = await import('../../web/engine/pkg-threads/veacom_web_engine.js');
      const exports = await threaded.default();
      await startHelpers(threaded, THREADS - 1);
      return { engine: threaded as unknown as Engine, threads: THREADS, memory: exports.memory };
    } catch (error) {
      console.warn('The threaded engine could not start; using one thread.', error);
    }
  }
  const single: Engine = await import('../../web/engine/pkg/veacom_web_engine.js');
  const exports = await single.default();
  return { engine: single, threads: 1, memory: exports.memory };
}
let engine: Engine;

export type EngineRequest =
  | { id: number; op: 'init'; cancel: SharedArrayBuffer }
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
const scope = self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<EngineRequest>) => void) | null };

// A panic's message is written to console.error just before the engine stops; it goes with the crash report.
let lastError = '';
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => { lastError = args.map(String).join(' ').slice(0, 4000); consoleError(...args); };

/** Each file's first 64 KiB, read many at a time, so the engine parses headers from memory (see web/RAPOR.md). */
async function heads(files: { file: File }[]): Promise<(Uint8Array | undefined)[]> {
  if (files.length > 20_000) return [];
  const result: (Uint8Array | undefined)[] = [];
  for (let start = 0; start < files.length; start += 256) {
    const batch = files.slice(start, start + 256);
    result.push(...await Promise.all(batch.map(({ file }) => file.slice(0, 65536).arrayBuffer().then(buffer => new Uint8Array(buffer), () => undefined))));
  }
  return result;
}

scope.onmessage = async ({ data }) => {
  try {
    const loaded = await ready;
    let value: unknown, transfer: Transferable[] = [];
    switch (data.op) {
      case 'init': {
        engine.watch((record: string) => scope.postMessage({ type: 'progress', value: JSON.parse(record) }), new Int32Array(data.cancel));
        // In the threads build the module's memory is shared: the page reads progress and sets the cancel flag in it.
        const [cancel, progress] = engine.sharedState();
        const shared = loaded.memory.buffer instanceof SharedArrayBuffer ? { buffer: loaded.memory.buffer, cancel, progress } : undefined;
        value = { threads: loaded.threads, shared } satisfies EngineInfo;
        break;
      }
      case 'import': {
        const first = await heads(data.files);
        data.files.forEach(({ path, file }, i) => engine.addFile(path, file, first[i]));
        value = JSON.parse(engine.importPaths(data.roots));
        break;
      }
      case 'list': value = JSON.parse(engine.listSeries()); break;
      case 'remove': value = JSON.parse(engine.removeSeries(data.ids)); break;
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
        const pixels = (data.op === 'volume' ? engine.volume(data.seriesId, data.revision) : engine.frame(data.seriesId, data.index, data.revision)) as EnginePixels;
        value = pixels; transfer = [pixels.bytes.buffer];
        break;
      }
    }
    scope.postMessage({ id: data.id, ok: true, value }, transfer);
  } catch (error) {
    // The engine's own messages arrive as plain Errors holding its JSON body. Anything else is the engine crashing
    // (a WebAssembly trap, a stack overflow): its state cannot be trusted any more, and the page replaces this Worker.
    const fatal = (error as Error)?.constructor !== Error;
    scope.postMessage({ id: data.id, ok: false, error: String((error as Error)?.message ?? error), fatal, detail: fatal ? lastError : undefined });
  }
};
