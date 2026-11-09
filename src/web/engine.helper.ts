// A thread lent to the engine (web/engine/src/helpers.rs), started by the page (src/web/bridge.ts): the threads build is
// set up on this Worker with the engine Worker's own module and memory, then works on the engine's parallel runs
// (decoding a series' frames) until the page closes. It reads no files of its own: what it decodes is already in the
// shared memory.
//
// The threads build aborts on a panic. Then `helperMain` throws here, and the page hears of it and replaces the engine:
// a run that lent this thread work would otherwise wait for it for ever.
type ThreadedEngine = typeof import('../../web/engine/pkg-threads/veacom_web_engine.js');

type Shared = { module: WebAssembly.Module; memory: WebAssembly.Memory };
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<Shared>) => void) | null };

async function help({ module, memory }: Shared): Promise<void> {
  try {
    const engine: ThreadedEngine = await import('../../web/engine/pkg-threads/veacom_web_engine.js');
    engine.initSync({ module, memory });
    scope.postMessage({ type: 'ready' });
    engine.helperMain();
  } catch (error) {
    scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = ({ data }) => {
  scope.onmessage = null;
  void help(data);
};
