'use strict';
// PNG, JPEG and BMP pictures in an import are decoded here, by Chromium's own image decoders, and not in the imaging
// engine, which runs with the user's full rights and parses no image format but DICOM (native/src/pictures.rs). The
// engine hands each picture's bytes over and receives its size, or its samples.
//
// The decoding runs in renderers of its own: sandboxed, their blank page with JavaScript off, an in-memory session that
// refuses every request and permission, and no window. Their preload (picture-preload.cjs) decodes and answers on that
// renderer's own channel, and main checks every answer before the engine checks it again. A picture that crashes or
// hangs a renderer fails, with any decoded beside it there; the next picture gets a fresh renderer.
const path = require('node:path');
const { CHUNK } = require('./engine-pipe.cjs');
const { setTimeout: delay } = require('node:timers/promises');
const { WebContentsView, session } = require('electron');

// The engine's frame limit, in RGB samples (native/src/pictures.rs MAX_SAMPLES): no answer carries a larger picture.
const MAX_SAMPLES = 64 * 1024 * 1024;
const configured = new WeakSet();

function pictureSession() {
  // No "persist:" prefix: nothing this session holds outlives the app.
  const pictures = session.fromPartition('veacom-pictures');
  if (!configured.has(pictures)) {
    pictures.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    pictures.setPermissionCheckHandler(() => false);
    pictures.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    configured.add(pictures);
  }
  return pictures;
}

// The view, not just its webContents, must stay referenced while the renderer is in use: a view the garbage collector
// takes destroys its webContents with it, mid-load or mid-decode.
function openRenderer() {
  const view = new WebContentsView({ webPreferences: { session: pictureSession(), preload: path.join(__dirname, 'picture-preload.cjs'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, javascript: false, webSecurity: true,
    webgl: false, spellcheck: false, disableDialogs: true, navigateOnDragDrop: false, backgroundThrottling: false } });
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', event => event.preventDefault());
  return view;
}

/** A renderer's answer for `want` ('probe', 'size' or 'pixels'), checked: { width, height } and, for pixels, rgba. */
function checkedAnswer(answer, want) {
  if (!answer || typeof answer !== 'object') throw new Error('The picture decoder gave no answer');
  if (typeof answer.error === 'string') throw new Error(answer.error.slice(0, 300) || 'The picture could not be decoded');
  const { width, height } = answer;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error('The picture decoder gave no size');
  if (want === 'probe' || want === 'size') return { width, height };
  const { rgba } = answer;
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4 || width * height * 3 > MAX_SAMPLES) throw new Error('The picture decoder gave the wrong number of samples');
  return { width, height, rgba };
}

/**
 * Decodes pictures in up to `renderers` renderers, `concurrency` at a time in each: the first opens for the first
 * picture, another only while those open are busy, and all close once no picture has come for `idleMs`. A picture not
 * answered after `timeoutMs` takes its renderer down with it. Sizes come from headers alone (picture-preload.cjs), and
 * the engine asks for the samples of as many pictures at once as its decode workers allow for their size, so that many
 * at a time stays within memory.
 */
function createPictureDecoder({ renderers = 2, concurrency = 8, idleMs = 30_000, timeoutMs = 60_000, open = openRenderer } = {}) {
  const opened = [], queue = [];
  let nextId = 1, idleTimer, closed = false;

  function retire(renderer, error) {
    const index = opened.indexOf(renderer);
    if (index >= 0) opened.splice(index, 1);
    for (const job of renderer.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    renderer.pending.clear();
    if (!renderer.contents.isDestroyed()) renderer.contents.close();
  }
  function start() {
    const view = open(), contents = view.webContents, renderer = { view, contents, pending: new Map(), ready: false, active: 0 };
    contents.ipc.on('picture:decoded', (event, id, answer) => {
      const job = renderer.pending.get(id);
      if (!job || job.bytes !== null || event.senderFrame !== contents.mainFrame) return;
      renderer.pending.delete(id);
      clearTimeout(job.timer);
      try { job.resolve(checkedAnswer(answer, job.want)); } catch (error) { job.reject(error); }
    });
    contents.on('render-process-gone', (_event, details) => retire(renderer, new Error(`The picture decoder stopped (${details?.reason ?? 'gone'})`)));
    opened.push(renderer);
    contents.loadURL('about:blank').then(() => {
      renderer.ready = true;
      for (const [id, job] of renderer.pending) send(renderer, id, job);
    }).catch(error => retire(renderer, error));
    return renderer;
  }
  // The least busy renderer with room for one more picture; another one if every open one is busy.
  function pick() {
    const free = opened.filter(renderer => renderer.active < concurrency).sort((a, b) => a.active - b.active)[0];
    if (free?.active === 0 || (opened.length >= renderers)) return free;
    return start();
  }
  function send(renderer, id, job) {
    const bytes = job.bytes;
    job.bytes = null;
    try { renderer.contents.send('picture:decode', id, bytes, job.want); }
    catch (error) { retire(renderer, error); }
  }
  function run(renderer, bytes, want) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => retire(renderer, new Error('The picture decoder did not answer in time')), timeoutMs);
      const job = { bytes, want, resolve, reject, timer };
      renderer.pending.set(id, job);
      if (renderer.ready) send(renderer, id, job);
    });
  }
  function retireWhenIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      for (const renderer of [...opened]) if (!renderer.active) retire(renderer, new Error('The picture decoder closed'));
    }, idleMs);
  }
  function prepare(paths) {
    if (closed || opened.length || !paths.some(name => /\.(png|jpe?g|bmp)$/i.test(name))) return;
    try { start(); } catch { return; } // A decode retries and reports any failure to open its sandbox.
    retireWhenIdle();
  }
  function pump() {
    while (queue.length) {
      const renderer = pick();
      if (!renderer) return;
      const job = queue.shift();
      renderer.active++;
      run(renderer, job.bytes, job.want).then(job.resolve, job.reject).finally(() => {
        renderer.active--;
        pump();
        if (!closed && !queue.length && opened.length && opened.every(each => !each.active)) {
          retireWhenIdle();
        }
      });
    }
  }
  /** Resolves to { width, height } for 'size', and with rgba (four bytes a pixel, rows top first) for 'pixels'. */
  function decode(bytes, want) {
    if (closed) return Promise.reject(new Error('The picture decoder closed'));
    if (!(bytes instanceof Uint8Array) || !['probe', 'size', 'pixels'].includes(want)) return Promise.reject(new Error('Invalid picture request'));
    clearTimeout(idleTimer);
    return new Promise((resolve, reject) => { queue.push({ bytes, want, resolve, reject }); pump(); });
  }
  function close() {
    closed = true;
    clearTimeout(idleTimer);
    for (const job of queue.splice(0)) job.reject(new Error('The picture decoder closed'));
    for (const renderer of [...opened]) retire(renderer, new Error('The picture decoder closed'));
  }
  /** The decoding renderers' process ids (for the desktop checks). */
  function processIds() { return opened.filter(renderer => !renderer.contents.isDestroyed()).map(renderer => renderer.contents.getOSProcessId()); }
  return { prepare, decode, close, processIds };
}

// Return RGBA one pipe chunk at a time. A valid picture can exceed the 16 MiB request limit.
async function sendPictureAnswer(connection, metadata, rgba, signal, retryMs) {
  let offset = 0;
  do {
    const data = rgba.subarray(offset, offset + CHUNK);
    const body = { ...metadata, offset, more: offset + data.length < rgba.length };
    const response = await connection.request('pictureAnswer', body, { data, signal });
    if (response.status === 404) return; // The engine cancelled this picture.
    if (response.status === 503) {
      await delay(retryMs, undefined, { signal });
      continue;
    }
    if (response.status !== 204) throw new Error('Invalid picture acknowledgement');
    offset += data.length;
    if (!body.more) return;
  } while (true);
}

/** Take pictures from this engine generation and return each answer over the same private pipe. */
function servePictures({ engine, decode, pollers = 8, retryMs = 1000 }) {
  let stopped = false, controller = new AbortController();
  // A state change (a restart, a stop) ends the requests to the engine that was; the next go to the one that is.
  const onState = () => { controller.abort(); controller = new AbortController(); };
  engine.on('state', onState);
  async function poll() {
    while (!stopped) {
      const signal = controller.signal;
      try {
        const connection = engine.connection();
        const response = await connection.request('pictureNext', undefined, { signal });
        if (response.status === 204) continue;
        const id = response.headers.get('X-Picture-Id'), want = response.headers.get('X-Picture-Want');
        if (response.status !== 200 || !/^\d{1,20}$/.test(id ?? '') || !['probe', 'size', 'pixels'].includes(want)) throw new Error('Invalid picture request');
        const bytes = new Uint8Array(await response.arrayBuffer());
        let metadata, rgba = new Uint8Array(0);
        try {
          const picture = await decode(bytes, want);
          metadata = { id, width: picture.width, height: picture.height };
          if (want === 'pixels') rgba = picture.rgba;
        } catch (error) { metadata = { id, error: String(error?.message || 'The picture could not be decoded').slice(0, 300) }; }
        await sendPictureAnswer(connection, metadata, rgba, signal, retryMs);
      } catch {
        if (!stopped && !signal.aborted) await delay(retryMs, undefined, { signal }).catch(() => {});
      }
    }
  }
  for (let index = 0; index < pollers; index++) void poll();
  return () => { stopped = true; engine.off('state', onState); controller.abort(); };
}

module.exports = { createPictureDecoder, servePictures, checkedAnswer, MAX_SAMPLES };
