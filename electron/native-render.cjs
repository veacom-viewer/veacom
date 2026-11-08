const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MessageChannelMain } = require('electron');
const { coreErrorText } = require('./i18n.cjs');

async function putBitmap(window, target, revision, frame, bytes) {
  const { port1, port2 } = new MessageChannelMain();
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Display frame timed out')), 10_000);
      port1.once('message', ({ data }) => data === true ? resolve() : reject(new Error('Invalid display frame')));
      port1.once('close', () => reject(new Error('Display frame receiver closed')));
      port1.start();
      window.webContents.mainFrame.postMessage('imaging:bitmap', { target, revision, width:frame.width, height:frame.height, bytes }, [port2]);
    });
  } finally { clearTimeout(timeout); port1.close(); }
}

class NativePresenter {
  constructor(directory, sharedTexture) {
    this.sharedTexture = sharedTexture;
    this.name = 'com.veacom.surface.' + randomUUID();
    const native = { exports: {} };
    const file = process.platform === 'darwin' ? 'libveacom_presenter.dylib' : 'veacom_presenter.dll';
    process.dlopen(native, path.join(directory, file));
    this.native = native.exports;
    this.receiver = this.native.open(this.name);
    this.nextLease = 0;
    this.queue = Promise.resolve();
    this.slots = [0, 1, 2];
    this.waiters = [];
  }
  async slot() {
    if (this.slots.length) return this.slots.pop();
    if (this.waiters.length >= 32) throw new Error('Display queue is full');
    return new Promise(resolve => this.waiters.push(resolve));
  }
  free(slot) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(slot);
    else this.slots.push(slot);
  }
  async present(broker, engine, window, route, target, revision, body, validate = () => {}, forceBitmap = false) {
    const slot = await this.slot();
    // Only one producer reply is received at a time. Presentation and compositor release can overlap.
    let resume;
    const previous = this.queue;
    this.queue = new Promise(resolve => { resume = resolve; });
    await previous;
    let surface, imported, finished = false, compositorOwns = false, freed = false;
    const freeWhenDone = () => {
      if (finished && !compositorOwns && !freed) { freed = true; this.free(slot); }
    };
    const dropSurface = () => {
      try { if (surface) this.native.release(surface); } finally { surface = undefined; compositorOwns = false; freeWhenDone(); }
    };
    try {
      const lease = this.nextLease = this.nextLease % 0x7fffffff + 1;
      validate();
      const current = engine.connection();
      const pid = engine.current.child.pid;
      const check = frame => {
        if (frame.lease !== lease || frame.width !== body.width || frame.height !== body.height) throw new Error('Unexpected display frame');
        validate();
      };
      // The Tesla T4 driver resets when Chromium composites shared clinical frames around video export.
      // Keep Rust rendering on D3D12 and transfer the finished pixels for this adapter.
      if (process.platform === 'win32' && this.adapterGeneration !== current.generation) {
        const { value } = await broker.requestJson('renderInfo', {}, current.generation);
        this.readbackOnT4 = /\b(?:Tesla |NVIDIA )T4\b/i.test(value.renderer);
        this.adapterGeneration = current.generation;
      }
      if (!forceBitmap && !this.readbackOnT4 && this.bitmapGeneration !== current.generation) {
        try {
          const { value: frame } = await broker.requestJson(route, { ...body, lease, slot, bitmap:false }, current.generation);
          check(frame);
          surface = this.native.receive(this.receiver, pid, lease, frame.handle);
          compositorOwns = true;
          imported = this.sharedTexture.importSharedTexture({
            textureInfo: { codedSize: { width: frame.width, height: frame.height }, pixelFormat: 'bgra',
              handle: process.platform === 'darwin' ? { ioSurface: surface } : { ntHandle: surface } },
            allReferencesReleased: dropSurface,
          });
          await this.sharedTexture.sendSharedTexture({ frame: window.webContents.mainFrame, importedSharedTexture: imported }, target, revision);
          return { lease, gpuCompleteMs: frame.gpuCompleteMs, adapter: frame.adapter, transport:'shared' };
        } catch (error) {
          validate();
          if (engine.connection().generation !== current.generation) throw error;
          if (!imported) dropSurface();
          this.bitmapGeneration = current.generation;
        }
      }
      const response = await current.request(route, { ...body, lease, slot:null, bitmap:true }, { signal:broker.epoch.signal });
      if (!response.ok) throw new Error(coreErrorText(await response.text()));
      const meta = response.headers.get('x-frame-info');
      const length = body.width * body.height * 4;
      if (!meta || meta.length > 8192 || response.headers.get('content-type') !== 'application/vnd.veacom.rgba' ||
          Number(response.headers.get('content-length')) !== length) throw new Error('Invalid bitmap reply');
      const frame = JSON.parse(Buffer.from(meta,'hex').toString('utf8'));
      check(frame);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== length) throw new Error('Incomplete bitmap reply');
      validate();
      await putBitmap(window, target, revision, frame, bytes);
      return { lease, gpuCompleteMs: frame.gpuCompleteMs, adapter: frame.adapter, transport:'bitmap' };
    } finally {
      finished = true;
      try { if (imported) imported.release(); else dropSurface(); }
      finally { freeWhenDone(); resume(); }
    }
  }
}
module.exports = { NativePresenter };
