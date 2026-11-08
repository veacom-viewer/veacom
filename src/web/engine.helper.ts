// A thread lent to the engine (web/engine/src/helpers.rs): the threads build is set up on this Worker with the engine
// Worker's own module and memory, then works on the engine's parallel runs (decoding a series' frames) until the page
// closes. It reads no files of its own: what it decodes is already in the shared memory.
type ThreadedEngine = typeof import('../../web/engine/pkg-threads/veacom_web_engine.js');

const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<{ module: WebAssembly.Module; memory: WebAssembly.Memory }>) => void) | null };

scope.onmessage = async ({ data }) => {
  scope.onmessage = null;
  const engine: ThreadedEngine = await import('../../web/engine/pkg-threads/veacom_web_engine.js');
  engine.initSync({ module: data.module, memory: data.memory });
  scope.postMessage('ready');
  engine.helperMain();
};
