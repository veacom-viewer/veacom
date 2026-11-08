const { randomUUID } = require('node:crypto');

function createImagingTestHooks() {
  const gates = new Map(), imports = [];
  return {
    afterImport: (paths, result) => imports.push({ paths: [...paths], result }),
    beforePixel: async (descriptor, signal) => {
      for (const gate of [...gates.values()]) {
        if (gate.kind !== descriptor.kind || (gate.index !== undefined && gate.index !== descriptor.index)) continue;
        gate.observed ??= descriptor;
        for (const done of gate.observers.splice(0)) done(descriptor);
        await new Promise((resolve, reject) => {
          const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
          if (signal.aborted) { abort(); return; }
          signal.addEventListener('abort', abort, { once: true });
          gate.released.then(() => { signal.removeEventListener('abort', abort); resolve(); });
        });
      }
    },
    api: {
      getImportEvents: () => imports.map(value => ({ ...value, paths: [...value.paths] })),
      holdPixelRequests: (kind, index) => {
        if (!['volume', 'frame'].includes(kind) || (index !== undefined && (!Number.isSafeInteger(index) || index < 0))) throw new Error('Invalid test pixel gate.');
        let release; const released = new Promise(resolve => { release = resolve; });
        const id = randomUUID(); gates.set(id, { kind, index, released, release, observers: [] }); return id;
      },
      waitForHeldPixelRequest: id => {
        const gate = gates.get(id); if (!gate) throw new Error('Unknown test pixel gate.');
        return gate.observed ? Promise.resolve(gate.observed) : new Promise(resolve => gate.observers.push(resolve));
      },
      releasePixelRequests: id => { const gate = gates.get(id); if (gate) { gates.delete(id); gate.release(); } },
    },
  };
}
module.exports = { createImagingTestHooks };
