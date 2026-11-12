// A thread lent to the engine (engine/src/helpers.rs): the threads build is set up on this Worker with the engine
// Worker's own module and memory, then works on the engine's parallel runs until the page closes. The engine returns
// to this Worker now and then (`helperServe`); this measurement page sends it no files.
self.onmessage = async ({ data }) => {
  self.onmessage = null;
  const engine = await import('./engine/pkg-threads/veacom_web_engine.js');
  engine.initSync({ module: data.module, memory: data.memory });
  self.postMessage('ready');
  for (;;) {
    engine.helperServe(1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
