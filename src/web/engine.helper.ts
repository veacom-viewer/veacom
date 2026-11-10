// A thread lent to the engine (web/engine/src/helpers.rs), started by the page (src/web/bridge.ts): the threads build is
// set up on this Worker with the engine Worker's own module and memory, then works on the engine's parallel runs
// (decoding a series' frames) until the page closes.
//
// The engine Worker sends it the page's files on `files` (engine.worker.ts), so that those runs read the files here
// too: a File can be read only on a Worker that was given it. The engine waits in `helperServe` for a run; it returns
// after a run, after waiting a second, and when the engine Worker wakes the helpers to send them files, so that the
// files' message reaches this Worker. Each batch is answered once it is taken.
//
// The threads build aborts on a panic. Then the engine's calls throw here, and the page hears of it and replaces the
// engine: a run that lent this thread work would otherwise wait for it for ever.
type ThreadedEngine = typeof import('../../web/engine/pkg-threads/veacom_web_engine.js');

type Shared = { module: WebAssembly.Module; memory: WebAssembly.Memory; files: MessagePort };
/** From the engine Worker: files to take, answered with `{ took: batch }`, and numbers of files to let go of. */
export type HelperFiles = { batch: number; ids: number[]; files: File[] } | { forget: number[] };
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<Shared>) => void) | null };

const WAIT_MS = 1000;

// Back to this Worker's events for a moment: a message posted to itself, which queues behind the ones already sent.
const tick = new MessageChannel();
const nextTask = () => new Promise<void>(resolve => {
  tick.port1.onmessage = () => { resolve(); };
  tick.port2.postMessage(undefined);
});

async function help({ module, memory, files }: Shared): Promise<void> {
  try {
    const engine: ThreadedEngine = await import('../../web/engine/pkg-threads/veacom_web_engine.js');
    engine.initSync({ module, memory });
    files.onmessage = ({ data }: MessageEvent<HelperFiles>) => {
      if ('forget' in data) { engine.helperForgetFiles(Uint32Array.from(data.forget)); return; }
      engine.helperTakeFiles(Uint32Array.from(data.ids), data.files);
      files.postMessage({ took: data.batch });
    };
    scope.postMessage({ type: 'ready' });
    for (;;) {
      engine.helperServe(WAIT_MS);
      await nextTask();
    }
  } catch (error) {
    scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = ({ data }) => {
  scope.onmessage = null;
  void help(data);
};
