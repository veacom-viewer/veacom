const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');

const repo = path.resolve(__dirname, '..');
const work = path.resolve(repo, '..', 'work');
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const equal = argument.indexOf('='); return [argument.slice(2, equal), argument.slice(equal + 1)];
}));
const appPath = path.resolve(options.app || repo);
const study = path.resolve(options.study || path.join(work, 'bench-studies', 'studies', 'ct-1000'));
const output = path.resolve(options.output || path.join(work, 'load-profile.json'));
const runs = Number(options.runs || 1);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function run(index) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-load-profile-'));
  const errors = [], processLog = [];
  const launchedAt = performance.now();
  const desktop = await electron.launch({ args: [appPath],
    ...(options.executable ? { executablePath: options.executable } : {}),
    env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90_000 });
  desktop.process().stderr?.on('data', data => processLog.push(data.toString()));
  try {
    const page = await desktop.firstWindow();
    // Real input from the computer would change what is measured; the window shows without taking it.
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => window.__VEACOM_TEST__ && document.querySelector('[data-testid="veacom-app"]')?.getAttribute('data-ready') === 'true', undefined, { timeout: 60_000 });
    const startupToReadyMs = performance.now() - launchedAt;
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
    await page.evaluate(freshShader => {
      const proof = { started: null, requests: [], bodyReads: [], gpuCalls: [], canvasCalls: [], composites: [], frames: [], longTasks: [], rafGaps: [], states: [] };
      window.__VEACOM_LOAD_PROFILE__ = proof;
      const time = () => performance.now();
      // Optional diagnostic: rename one uniform and its lookup to bypass shader caches without changing pixel math.
      const imageUniform = freshShader ? `uImage_probe_${crypto.randomUUID().replaceAll('-', '')}` : 'uImage';
      const responses = new WeakMap();
      const fetchOriginal = window.fetch;
      window.fetch = async function (...args) {
        const started = time();
        const url = typeof args[0] === 'string' ? args[0] : args[0].url || String(args[0]);
        const request = { path: new URL(url, location.href).pathname, started };
        proof.requests.push(request);
        try {
          const response = await fetchOriginal.apply(this, args);
          request.headers = time(); request.status = response.status;
          request.pixelType = response.headers.get('X-Pixel-Type');
          responses.set(response, request); return response;
        } catch (error) { request.failed = time(); request.error = error.message; throw error; }
      };
      for (const method of ['arrayBuffer', 'json']) {
        const original = Response.prototype[method];
        Response.prototype[method] = async function (...args) {
          const request = responses.get(this);
          const record = { path: request?.path || new URL(this.url).pathname, method, started: time() };
          proof.bodyReads.push(record);
          try {
            const result = await original.apply(this, args); record.finished = time();
            if (method === 'arrayBuffer') record.bytes = result.byteLength;
            if (record.path === '/import' && result.series) record.series = result.series.map(series => ({ id: series.id, dimensions: series.dimensions, pixelType: series.pixelType }));
            return result;
          } catch (error) { record.finished = time(); record.error = error.message; throw error; }
        };
      }
      // Pixel bodies are read from the response's stream (readPixels in src/api.ts), not with arrayBuffer().
      const streams = new WeakMap(), bodyGetter = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get;
      Object.defineProperty(Response.prototype, 'body', { configurable: true, get() {
        const stream = bodyGetter.call(this), request = responses.get(this);
        if (stream && request) streams.set(stream, request.path);
        return stream;
      } });
      const getReader = ReadableStream.prototype.getReader;
      ReadableStream.prototype.getReader = function (...args) {
        const reader = getReader.apply(this, args);
        if (!streams.has(this)) return reader;
        const record = { path: streams.get(this), method: `stream:${args[0]?.mode ?? 'default'}`, started: time(), bytes: 0, reads: 0 };
        proof.bodyReads.push(record);
        const read = reader.read;
        reader.read = async function (...readArgs) {
          try {
            const result = await read.apply(this, readArgs);
            record.reads++;
            if (result.done) record.finished = time(); else record.bytes += result.value.byteLength;
            return result;
          } catch (error) { record.finished = time(); record.error = error.message; throw error; }
        };
        return reader;
      };
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        const started = time();
        try { return getContext.apply(this, args); }
        finally { proof.canvasCalls.push({ method: `getContext:${args[0]}`, started, finished: time(), dimensions: [this.width, this.height] }); }
      };
      for (const property of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property);
        Object.defineProperty(HTMLCanvasElement.prototype, property, { ...descriptor, set(value) {
          const started = time();
          try { descriptor.set.call(this, value); }
          finally { proof.canvasCalls.push({ method: `set:${property}`, started, finished: time(), value }); }
        } });
      }
      for (const method of ['texImage2D', 'texImage3D', 'texSubImage3D', 'shaderSource', 'compileShader', 'linkProgram', 'getShaderParameter', 'getProgramParameter', 'getParameter', 'getUniformLocation', 'useProgram', 'viewport', 'getError', 'drawArrays']) {
        const original = WebGL2RenderingContext.prototype[method];
        if (!original) continue;
        WebGL2RenderingContext.prototype[method] = function (...args) {
          const started = time();
          if (method === 'shaderSource' && freshShader) args[1] = args[1].replace(/\buImage\b/g, imageUniform);
          if (method === 'getUniformLocation' && args[1] === 'uImage') args[1] = imageUniform;
          try { return original.apply(this, args); }
          finally {
            const record = { method, started, finished: time() };
            if (method === 'shaderSource') { record.characters = args[1].length; record.stage = args[1].includes('gl_Position') ? 'vertex' : 'fragment'; }
            if (method === 'getProgramParameter' || method === 'getShaderParameter') record.parameter = args[1];
            if (method === 'texImage2D') { record.dimensions = args.slice(3, 5); record.bytes = args[8]?.byteLength ?? null; record.internalFormat = args[2]; }
            if (method === 'texImage3D') { record.dimensions = args.slice(3, 6); record.bytes = args[9]?.byteLength ?? null; record.internalFormat = args[2]; }
            if (method === 'texSubImage3D') { record.dimensions = args.slice(5, 8); record.bytes = args[10]?.byteLength ?? null; }
            proof.gpuCalls.push(record);
          }
        };
      }
      const composite = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        const started = time();
        try { return composite.apply(this, args); }
        finally { proof.composites.push({ started, finished: time(), source: args[0].constructor.name,
          sourceSize: [args[0].width, args[0].height], targetSize: [this.canvas.width, this.canvas.height], testId: this.canvas.dataset?.testid ?? null }); }
      };
      document.addEventListener('veacom:frame', event => {
        const state = window.__VEACOM_TEST__.state();
        proof.frames.push({ at: time(), ...event.detail, dimensions: state.dimensions, fullVolumeLoaded: state.fullVolumeLoaded,
          renderer: event.target.dataset.renderer });
      });
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) proof.longTasks.push({ started: entry.startTime, duration: entry.duration });
      });
      observer.observe({ type: 'longtask', buffered: false });
      let previous, priorState = '';
      function frame(at) {
        if (previous !== undefined) proof.rafGaps.push({ at, gap: at - previous });
        previous = at;
        const state = window.__VEACOM_TEST__.state(), key = JSON.stringify([state.dimensions, state.fullVolumeLoaded, state.pendingLoads]);
        if (key !== priorState) { proof.states.push({ at, dimensions: state.dimensions, fullVolumeLoaded: state.fullVolumeLoaded, pendingLoads: state.pendingLoads }); priorState = key; }
        if (!proof.stopped) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
      proof.finish = () => { proof.stopped = true; observer.disconnect(); };
    }, options['fresh-shader'] === 'true');
    const capabilities = await privileged.authorizeImportPaths(desktop, [study]);
    await page.evaluate(capabilities => {
      const proof = window.__VEACOM_LOAD_PROFILE__;
      proof.started = performance.now();
      window.__VEACOM_TEST__.importPaths(capabilities).then(() => { proof.importReturned = performance.now(); });
    }, capabilities);
    await page.waitForFunction(() => window.__VEACOM_LOAD_PROFILE__.frames.some(frame => frame.fullVolumeLoaded && frame.dimensions?.[2] > 1), undefined, { timeout: 120_000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const proof = await page.evaluate(() => {
      const proof = window.__VEACOM_LOAD_PROFILE__; proof.finish(); delete proof.finish;
      proof.finished = performance.now(); return proof;
    });
    const gpu = await desktop.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic') }));
    const started = proof.started;
    const fullUpload = proof.gpuCalls.find(call => call.method === 'texImage3D' && call.dimensions?.[2] > 1);
    const preview = proof.frames.find(frame => !fullUpload || frame.at < fullUpload.started);
    const full = fullUpload ? proof.frames.find(frame => frame.at >= fullUpload.finished)
      : proof.frames.find(frame => frame.fullVolumeLoaded && frame.dimensions?.[2] > 1);
    const fullBody = proof.bodyReads.find(read => read.path.startsWith('/_imaging/volume/'));
    const previewBody = proof.bodyReads.find(read => read.path.startsWith('/_imaging/frame/'));
    const fullRequest = proof.requests.find(request => request.path.startsWith('/_imaging/volume/'));
    const previewRequest = proof.requests.find(request => request.path.startsWith('/_imaging/frame/'));
    const longest = entries => [...entries].sort((a, b) => (b.finished - b.started) - (a.finished - a.started)).slice(0, 10);
    const summary = {
      startupToReadyMs,
      indexReadyMs: proof.importReturned - started,
      indexTimingKind: 'Renderer import action resolved after typed IPC catalog delivery and UI dispatch; not the former direct HTTP JSON-body timing.',
      previewHeadersMs: previewRequest?.headers - started, previewBodyReadyMs: previewBody?.finished - started,
      fullHeadersMs: fullRequest?.headers - started, fullBodyReadyMs: fullBody?.finished - started,
      fullBodyReadMs: fullBody?.finished - fullBody?.started, fullPayloadBytes: fullBody?.bytes,
      firstPreviewRenderSubmitMs: preview ? preview.at - started : null,
      firstFullRenderSubmitMs: full ? full.at - started : null,
      fullFrameClassification: fullUpload ? 'First frame event following a volume texture upload; avoids stale React test-hook metadata.' : 'Full-volume test-hook state.',
      fullRendererCpuMs: full?.renderSubmitMs, previewRendererCpuMs: preview?.renderSubmitMs,
      shaderStatusChecks: proof.gpuCalls.filter(call => call.method === 'getShaderParameter').length,
      linkStatusChecks: proof.gpuCalls.filter(call => call.method === 'getProgramParameter' && call.parameter === 0x8B82).length,
      completionPolls: proof.gpuCalls.filter(call => call.method === 'getProgramParameter' && call.parameter === 0x91B1).length,
      fragmentShaderCharacters: proof.gpuCalls.filter(call => call.method === 'shaderSource' && call.stage === 'fragment').map(call => call.characters),
      firstProgramLeadMs: proof.gpuCalls.find(call => call.method === 'drawArrays')?.started - proof.gpuCalls.find(call => call.method === 'linkProgram')?.finished,
      largestRafGapMs: Math.max(...proof.rafGaps.map(frame => frame.gap)),
      longestGpuCalls: longest(proof.gpuCalls).map(call => ({ ...call, durationMs: call.finished - call.started, relativeStartMs: call.started - started })),
      longestCanvasCalls: longest(proof.canvasCalls).map(call => ({ ...call, durationMs: call.finished - call.started, relativeStartMs: call.started - started })),
      longestComposites: longest(proof.composites).map(call => ({ ...call, durationMs: call.finished - call.started, relativeStartMs: call.started - started })),
    };
    const pixels = await page.locator('canvas[data-renderer]').first().evaluate(canvas => ({ png: canvas.toDataURL(), width: canvas.width, height: canvas.height, slice: canvas.dataset.slice }));
    return { index, summary, proof, gpu, pixels: { hash: sha256(pixels.png), width: pixels.width, height: pixels.height, slice: pixels.slice }, errors, processLog };
  } finally { await desktop.close(); await fs.rm(profile, { recursive: true, force: true }); }
}

(async () => {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const files = (await fs.readdir(path.join(appPath, 'dist', 'assets'))).filter(file => /^index-.*\.js$/.test(file));
  const builds = {};
  for (const file of ['electron/main.cjs', ...files.map(file => `dist/assets/${file}`)]) builds[file] = sha256(await fs.readFile(path.join(appPath, file)));
  const result = { study, appPath, platform: process.platform, builds, freshShaderProbe: options['fresh-shader'] === 'true',
    method: 'Fresh Electron process with production UI; import begins after startup. Timings use browser performance.now. WebGL calls and canvas composites are CPU completion timings, not GPU fence or screen presentation timings. Filesystem caches are not flushed.', runs: [] };
  for (let index = 0; index < runs; index++) {
    const measured = await run(index + 1); result.runs.push(measured);
    await fs.writeFile(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ run: index + 1, ...measured.summary, errors: measured.errors }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
