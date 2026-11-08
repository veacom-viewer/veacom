// The engine runs here, off the page's thread. FileReaderSync (used by the engine to read File.slice())
// exists only in Workers. `?threads=N` on the page (passed on to this Worker): N > 1 uses the threads build on N
// threads, this one and N - 1 helpers (only where the page is cross-origin isolated); 1 the single-thread build.
// Without it: half the cores, at most 4.
// The site's Trusted Types rule holds in Workers too: the helpers are started from here, and only this site's scripts
// may be started.
import { readHeads } from './file-heads.js';

self.trustedTypes?.createPolicy('default', {
  createScriptURL: (url) => {
    if (new URL(url, self.location.href).origin !== self.location.origin) throw new TypeError('Only this site\'s scripts may be started.');
    return url;
  },
});
const asked = new URL(self.location.href).searchParams.get('threads');
const THREADS = asked ? Number(asked) : Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

// Starts `count` helper Workers on the threads build's module and memory (helper.js). A browser that cannot start a
// Worker from a Worker, or a helper that fails to load, would leave the start waiting for ever: then, or after 15 s,
// the single-thread build is used instead.
const helpers = [];
async function startHelpers(threaded, count) {
  const [module, memory] = threaded.helperSetup();
  let timer;
  const started = Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const helper = new Worker(new URL('./helper.js', import.meta.url), { type: 'module' });
    helpers.push(helper);
    helper.onmessage = () => resolve();
    helper.onerror = () => reject(new Error('a thread could not start'));
    helper.postMessage({ module, memory });
  }));
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the threads did not start in time')), 15000); });
  try {
    await Promise.race([Promise.all(started), late]);
  } catch (error) {
    for (const helper of helpers.splice(0)) helper.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

let engine;
let threads = 1;
async function load() {
  if (THREADS > 1 && self.crossOriginIsolated) {
    try {
      const threaded = await import('./engine/pkg-threads/veacom_web_engine.js');
      const exports = await threaded.default();
      await startHelpers(threaded, THREADS - 1);
      threads = THREADS;
      // ?hold=N: hold a series' files for the threads only up to N bytes (to time a series too large to hold).
      const hold = new URL(self.location.href).searchParams.get('hold');
      if (hold != null) threaded.setHoldLimit(Number(hold));
      return { engine: threaded, exports };
    } catch (error) {
      console.warn('The threads could not start; using one thread.', error);
    }
  }
  const single = await import('./engine/pkg/veacom_web_engine.js');
  return { engine: single, exports: await single.default() };
}
const ready = load().then((loaded) => {
  engine = loaded.engine;
  return loaded.exports;
});
// A panic's message is written to console.error just before the engine stops; it goes with the crash report.
Error.stackTraceLimit = 60;
let lastError = '';
const consoleError = console.error.bind(console);
console.error = (...args) => {
  lastError = args.map(String).join(' ').slice(0, 20000);
  consoleError(...args);
};
const THUMBNAIL = 160;
let series = [];

function compact(list) {
  return list.map((s) => ({ description: s.description, modality: s.modality, images: s.dimensions[2] }));
}

const middle = (index) => Math.floor((series[index].dimensions[2] - 1) / 2);

// The middle image of a series under its default window; RGBA, columns × rows.
function render(index) {
  const [width, height] = series[index].dimensions;
  return { width, height, rgba: engine.renderFrame(index, middle(index)) };
}

function thumbnail({ width, height, rgba }) {
  const scale = THUMBNAIL / Math.max(width, height);
  return createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer), width, height), {
    resizeWidth: Math.max(1, Math.round(width * scale)),
    resizeHeight: Math.max(1, Math.round(height * scale)),
    resizeQuality: 'medium',
  });
}

function sendFrame(index, image, time) {
  self.postMessage({ type: 'frame', series: index, width: image.width, height: image.height, rgba: image.rgba, frame: time }, [image.rgba.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    await ready;
    if (data.type === 'show') {
      sendFrame(data.series, render(data.series), null);
      return;
    }
    if (data.type !== 'open') return;
    const t0 = performance.now();
    engine.reset();
    series = [];
    const heads = data.prefetch ? await readHeads(data.files) : [];
    const prefetched = performance.now() - t0;
    data.files.forEach(({ path, file }, i) => engine.addFile(`/in/${path}`, file, heads[i]));
    const result = JSON.parse(engine.importPaths(data.roots.map((root) => `/in/${root}`)));
    series = result.series;
    const listed = performance.now() - t0;
    const [listReads, listBytes, listReadMs] = engine.fileReads();
    self.postMessage({ type: 'listed', series: compact(series), warnings: result.warnings, listed, prefetched: data.prefetch ? prefetched : null, listReads, listBytes, listReadMs, extracted: engine.extractedBytes() });

    // The first series' middle image first, as large as it is; then a thumbnail of every series.
    const t1 = performance.now();
    const first = render(0);
    const kept = { ...first, rgba: first.rgba.slice() };
    sendFrame(0, first, performance.now() - t1);

    const t2 = performance.now();
    for (let index = 0; index < series.length; index++) {
      try {
        const bitmap = await thumbnail(index === 0 ? kept : render(index));
        self.postMessage({ type: 'thumb', series: index, bitmap }, [bitmap]);
      } catch (error) {
        self.postMessage({ type: 'thumb', series: index, error: String(error?.message ?? error) });
      }
    }
    self.postMessage({ type: 'thumbs', thumbs: performance.now() - t2 });

    if (data.volume) {
      const t3 = performance.now();
      const samples = engine.decodeVolume(0);
      self.postMessage({ type: 'volume', samples, volume: performance.now() - t3 });
    }
    // Optional, after the timings: a SHA-1 of every decoded series with its value type, to compare transfer syntaxes.
    if (data.checksum) {
      const checksums = [];
      for (let index = 0; index < series.length; index++) {
        const { bytes, pixelType } = engine.volumeBytes(index);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
        checksums.push(`${pixelType}:${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`);
      }
      self.postMessage({ type: 'checksums', checksums });
    }
    // WebAssembly memory only grows: this is the most the engine has held since the page opened.
    self.postMessage({ type: 'done', memory: (await ready).memory.buffer.byteLength, threads });
  } catch (error) {
    // The engine's own messages about the files arrive as plain Errors. Anything else is the engine
    // crashing: a WebAssembly trap (decoder fault, panic, out of memory), a stack overflow, a script error.
    // Its state cannot be trusted any more, so the page replaces this Worker.
    const fatal = error?.constructor !== Error;
    self.postMessage({ type: 'error', message: String(error?.message ?? error), fatal, detail: fatal ? lastError : undefined });
  }
};
