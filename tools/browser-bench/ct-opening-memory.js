(() => {
  let memory;
  window.openingMemory = [];
  window.openingMessages = [];
  const original = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(value, ...rest) {
    if (value?.memory instanceof WebAssembly.Memory) memory = value.memory;
    return original.call(this, value, ...rest);
  };
  window.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({data}) => {
        const n = data?.value?.bytes?.byteLength;
        if (n) window.openingMessages.push([Date.now(), n, data.value.index ?? null]);
      });
    }
  };
  window.recordOpeningMemory = () => {
    window.openingMemory.push([Date.now(), memory?.buffer.byteLength ?? 0, performance.memory?.usedJSHeapSize ?? 0]);
  };
  new PerformanceObserver(() => window.recordOpeningMemory()).observe({entryTypes:['mark']});
})();
