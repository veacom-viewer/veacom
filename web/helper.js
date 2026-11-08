// A thread lent to the engine (engine/src/helpers.rs): the threads build is set up on this Worker with the engine
// Worker's own module and memory, then works on the engine's parallel runs until the page closes.
self.onmessage = async ({ data }) => {
  self.onmessage = null;
  const engine = await import('./engine/pkg-threads/veacom_web_engine.js');
  engine.initSync({ module: data.module, memory: data.memory });
  self.postMessage('ready');
  engine.helperMain();
};
