import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter, getEventListeners } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { createPictureDecoder, servePictures, checkedAnswer } = require('../electron/picture-decoder.cjs');

type Answer = { width?: number; height?: number; rgba?: Uint8Array; error?: string } | null;
type Contents = ReturnType<typeof fakeContents>;
// A stand-in for a decoding renderer: it answers each picture as `answer` says, from its main frame unless told otherwise.
function fakeContents(pid: number, answer: (bytes: Uint8Array, want: string) => Answer | 'never', frame?: object) {
  const events = new EventEmitter(), ipc = new EventEmitter(), mainFrame = {};
  let destroyed = false;
  return {
    ipc, mainFrame, events,
    on: (name: string, listener: (...args: unknown[]) => void) => events.on(name, listener),
    loadURL: async (url: string) => { assert.equal(url, 'about:blank'); },
    send: (channel: string, id: number, bytes: Uint8Array, want: string) => {
      assert.equal(channel, 'picture:decode');
      const result = answer(bytes, want);
      if (result !== 'never') setTimeout(() => ipc.emit('picture:decoded', { senderFrame: frame ?? mainFrame }, id, result), 1);
    },
    close: () => { destroyed = true; }, isDestroyed: () => destroyed, getOSProcessId: () => pid,
  };
}
function fakeRenderers(answer: (bytes: Uint8Array, want: string) => Answer | 'never', frame?: object) {
  const opened: Contents[] = [];
  return { opened, open: () => { const webContents = fakeContents(100 + opened.length, answer, frame); opened.push(webContents); return { webContents }; } };
}
const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const rgba = (width: number, height: number) => new Uint8Array(width * height * 4).fill(7);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('picture decoder', () => {
  it('runs nothing in its renderers but its own preload, which loads no packages', () => {
    const preload = readFileSync(new URL('../electron/picture-preload.cjs', import.meta.url), 'utf8');
    assert.deepEqual([...preload.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]), ['electron']);
    assert.doesNotMatch(preload, /^\s*import\s|\bimport\(|contextBridge|exposeInMainWorld/m);
    const decoder = readFileSync(new URL('../electron/picture-decoder.cjs', import.meta.url), 'utf8');
    for (const setting of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'javascript: false', "loadURL('about:blank')"]) {
      assert.ok(decoder.includes(setting), setting);
    }
  });

  it('checks every answer from a renderer before the engine sees it', () => {
    assert.deepEqual(checkedAnswer({ width: 2, height: 1 }, 'size'), { width: 2, height: 1 });
    assert.deepEqual(checkedAnswer({ width: 2, height: 1, rgba: rgba(2, 1) }, 'pixels'), { width: 2, height: 1, rgba: rgba(2, 1) });
    assert.throws(() => checkedAnswer({ error: 'The source image could not be decoded.' }, 'size'), { message: /could not be decoded/ });
    assert.throws(() => checkedAnswer(null, 'size'), { message: /no answer/ });
    assert.throws(() => checkedAnswer({ width: 0, height: 1 }, 'size'), { message: /no size/ });
    assert.throws(() => checkedAnswer({ width: 2.5, height: 1 }, 'size'), { message: /no size/ });
    assert.throws(() => checkedAnswer({ width: 2, height: 1, rgba: rgba(1, 1) }, 'pixels'), { message: /wrong number/ });
    assert.throws(() => checkedAnswer({ width: 2, height: 1, rgba: [...rgba(2, 1)] }, 'pixels'), { message: /wrong number/ });
    assert.throws(() => checkedAnswer({ width: 5000, height: 5000, rgba: rgba(1, 1) }, 'pixels'), { message: /wrong number/ });
  });

  it('refuses an oversized JPEG before creating a bitmap even if its display size fits', async () => {
    let handler!: (event: object, id: number, bytes: Uint8Array, want: string) => Promise<void>;
    let answer: Answer = null, bitmapCalls = 0, headerReads = 0;
    const ipcRenderer = {
      on: (_channel: string, callback: typeof handler) => { handler = callback; },
      send: (_channel: string, _id: number, result: Answer) => { answer = result; },
    };
    class Image {
      naturalWidth = 2500; naturalHeight = 2500;
      onload!: () => void;
      set src(_url: string) { headerReads++; this.onload(); }
    }
    const preload = readFileSync(new URL('../electron/picture-preload.cjs', import.meta.url), 'utf8');
    runInNewContext(preload, { require: () => ({ ipcRenderer }), Image, Blob, URL,
      createImageBitmap: () => { bitmapCalls++; throw Error('unexpected bitmap'); } });
    // A JPEG SOF declares 5000 × 5000 encoded pixels.
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0x13, 0x88, 0x13, 0x88, 1, 1, 0x11, 0, 0xff, 0xda);
    await handler({}, 1, jpeg, 'size');
    await handler({}, 2, jpeg.slice(), 'pixels');
    assert.equal(headerReads, 1);
    assert.equal((answer as Answer)?.error, 'Frame exceeds the supported 64 million sample limit');
    const changed = jpeg.slice(); changed[13] ^= 1;
    await handler({}, 3, changed, 'pixels');
    assert.equal(headerReads, 2);
    assert.equal(bitmapCalls, 0);
    assert.equal((answer as Answer)?.error, 'Frame exceeds the supported 64 million sample limit');
  });

  it('decodes in one renderer, opens another only while the first is busy, and closes them when idle', async () => {
    const renderers = fakeRenderers((_bytes, want) => want === 'size' ? { width: 3, height: 2 } : { width: 3, height: 2, rgba: rgba(3, 2) });
    const decoder = createPictureDecoder({ open: renderers.open, renderers: 2, concurrency: 2, idleMs: 20 });
    assert.deepEqual(await decoder.decode(picture, 'size'), { width: 3, height: 2 });
    assert.equal(renderers.opened.length, 1);
    const many = await Promise.all(Array.from({ length: 9 }, () => decoder.decode(picture, 'pixels')));
    assert.ok(many.every(answer => answer.rgba.length === 24));
    assert.equal(renderers.opened.length, 2);
    assert.deepEqual(decoder.processIds(), [100, 101]);
    await pause(60);
    assert.ok(renderers.opened.every(contents => contents.isDestroyed()));
    assert.deepEqual(decoder.processIds(), []);
    await assert.rejects(decoder.decode([1, 2], 'size'), { message: /Invalid picture request/ });
    await assert.rejects(decoder.decode(picture, 'thumbnail'), { message: /Invalid picture request/ });
    decoder.close();
  });

  it('prepares one sandbox for a selected picture and reuses it for decoding', async () => {
    const renderers = fakeRenderers(() => ({ width: 1, height: 1 }));
    const decoder = createPictureDecoder({ open: renderers.open, idleMs: 20 });
    decoder.prepare(['CT/001.dcm']);
    assert.equal(renderers.opened.length, 0);
    decoder.prepare(['image.PNG']);
    decoder.prepare(['image.jpg']);
    assert.equal(renderers.opened.length, 1);
    assert.deepEqual(await decoder.decode(picture, 'size'), { width: 1, height: 1 });
    assert.equal(renderers.opened.length, 1);
    await pause(60);
    assert.deepEqual(decoder.processIds(), []);
    decoder.close();
  });

  it('closes an unused file-dialog sandbox immediately for DICOM or cancellation', async () => {
    const renderers = fakeRenderers(() => ({ width: 1, height: 1 }));
    const decoder = createPictureDecoder({ open: renderers.open });
    try {
      for (const paths of [[], ['one.dcm']]) {
        const finish = decoder.prepareFileDialog();
        assert.equal(decoder.processIds().length, 1);
        finish(paths);
        assert.deepEqual(decoder.processIds(), []);
      }
      const finish = decoder.prepareFileDialog();
      finish(['one.PNG']);
      await decoder.decode(picture, 'size');
      assert.equal(renderers.opened.length, 3);
      assert.equal(decoder.processIds().length, 1);
    } finally { decoder.close(); }
  });

  it('ignores answers from any other frame, and gives up on a renderer that does not answer', async () => {
    const renderers = fakeRenderers(() => ({ width: 1, height: 1 }), { foreign: true });
    const decoder = createPictureDecoder({ open: renderers.open, timeoutMs: 30 });
    await assert.rejects(decoder.decode(picture, 'size'), { message: /did not answer in time/ });
    assert.equal(renderers.opened[0].isDestroyed(), true);
    decoder.close();
  });

  it('replaces a renderer that does not load', async () => {
    const renderers = fakeRenderers(() => ({ width: 1, height: 1 }));
    const decoder = createPictureDecoder({ open: () => {
      const view = renderers.open();
      if (renderers.opened.length === 1) view.webContents.loadURL = async () => { throw new Error("ERR_FAILED (-2) loading 'about:blank'"); };
      return view;
    } });
    await assert.rejects(decoder.decode(picture, 'size'), { message: /ERR_FAILED/ });
    assert.equal(renderers.opened[0].isDestroyed(), true);
    assert.deepEqual(await decoder.decode(picture, 'size'), { width: 1, height: 1 });
    decoder.close();
  });

  it('times out a stalled load and serves the queued picture in a fresh renderer', async () => {
    const renderers = fakeRenderers(() => ({ width: 2, height: 1 }));
    const decoder = createPictureDecoder({ renderers: 1, concurrency: 1, timeoutMs: 40, open: () => {
      const view = renderers.open();
      if (renderers.opened.length === 1) view.webContents.loadURL = () => new Promise<void>(() => {});
      return view;
    } });
    try {
      const stuck = assert.rejects(decoder.decode(picture, 'size'), /did not answer in time/);
      const next = decoder.decode(picture, 'size');
      await stuck;
      assert.deepEqual(await next, { width: 2, height: 1 });
      assert.equal(renderers.opened[0].isDestroyed(), true);
    } finally { decoder.close(); }
  });

  it('fails the pictures of a renderer that stops, and decodes the next in a fresh one', async () => {
    let crash = true;
    const renderers = fakeRenderers(() => crash ? 'never' : { width: 1, height: 1 });
    const decoder = createPictureDecoder({ open: renderers.open });
    const lost = decoder.decode(picture, 'size');
    await pause(5);
    renderers.opened[0].events.emit('render-process-gone', {}, { reason: 'crashed' });
    await assert.rejects(lost, { message: /The picture decoder stopped \(crashed\)/ });
    crash = false;
    assert.deepEqual(await decoder.decode(picture, 'size'), { width: 1, height: 1 });
    assert.equal(renderers.opened.length, 2);
    decoder.close();
    assert.equal(renderers.opened[1].isDestroyed(), true);
  });
});

describe('serving the engine\'s pictures', () => {
  it('removes the abort listener after each retry delay', async () => {
    const listeners: number[] = [];
    let resolve!: () => void;
    const retried = new Promise<void>(done => { resolve = done; });
    const request = async (_op: string, _body: unknown, { signal }: { signal: AbortSignal }) => {
      listeners.push(getEventListeners(signal, 'abort').length);
      if (listeners.length === 5) resolve();
      throw new Error('Disconnected');
    };
    const engine = Object.assign(new EventEmitter(), { connection: () => ({ request }) });
    const stop = servePictures({ engine, pollers: 1, retryMs: 1, decode: () => {} });
    try {
      await retried;
      assert.deepEqual(listeners, [0, 0, 0, 0, 0]);
    } finally { stop(); }
  });

  function fakeEngine(want: 'size' | 'pixels', busyOnce = false) {
    type Part = { id: string; width?: number; height?: number; error?: string; offset: number; more: boolean };
    const answers: Array<{ body: Part; data: Uint8Array }> = [];
    let handed = false, done!: () => void;
    const completed = new Promise<void>(resolve => { done = resolve; });
    const request = async (op: string, body: Part, { data, signal }: { data: Uint8Array; signal: AbortSignal }) => {
      if (op === 'pictureAnswer') {
        answers.push({ body, data });
        if (busyOnce) { busyOnce = false; return new Response(null, { status: 503 }); }
        if (!body.more) done();
        return new Response(null, { status: 204 });
      }
      assert.equal(op, 'pictureNext');
      if (!handed) {
        handed = true;
        return new Response(picture, { headers: { 'X-Picture-Id': '42', 'X-Picture-Want': want } });
      }
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    return { engine: Object.assign(new EventEmitter(), { connection: () => ({ request }) }), answers, completed };
  }

  it('takes each picture, decodes it and answers with its size and samples', async () => {
    const { engine, answers, completed } = fakeEngine('pixels');
    const stop = servePictures({ engine, pollers: 2, decode: async (bytes: Uint8Array, want: string) => {
      assert.deepEqual([...bytes], [...picture]);
      assert.equal(want, 'pixels');
      return { width: 2, height: 1, rgba: rgba(2, 1) };
    } });
    try { await completed; } finally { stop(); }
    assert.deepEqual(answers, [{ body: { id: '42', width: 2, height: 1, offset: 0, more: false }, data: rgba(2, 1) }]);
    assert.equal(engine.listenerCount('state'), 0);
  });

  it('retries a busy pipe at the same offset and sends the remaining samples in order', async () => {
    const { engine, answers, completed } = fakeEngine('pixels', true);
    const { CHUNK } = require('../electron/engine-pipe.cjs');
    const pixels = rgba(513, 512);
    pixels[CHUNK] = 99;
    const stop = servePictures({ engine, pollers: 1, retryMs: 1, decode: async () => ({ width: 513, height: 512, rgba: pixels }) });
    try { await completed; } finally { stop(); }
    assert.deepEqual(answers.map(({ body }) => [body.offset, body.more]), [[0, true], [0, true], [CHUNK, false]]);
    assert.deepEqual(Buffer.concat(answers.slice(1).map(part => part.data)), Buffer.from(pixels));
  });

  it('preserves the decoder error in the pipe reply', async () => {
    const { engine, answers, completed } = fakeEngine('size');
    const error = 'Décodage impossible\nencore';
    const stop = servePictures({ engine, pollers: 1, decode: async () => { throw new Error(error); } });
    try { await completed; } finally { stop(); }
    assert.deepEqual(answers, [{ body: { id: '42', error, offset: 0, more: false }, data: new Uint8Array(0) }]);
  });
});
