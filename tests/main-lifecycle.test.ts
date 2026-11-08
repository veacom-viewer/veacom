import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// electron/main.cjs started against a stand-in `electron` module and engine. The stand-in quits in Electron's
// documented order: before-quit; then each window closes unless its page holds the unload (an export runs) and
// the user answers "Wait"; then will-quit; then the process ends.

const require = createRequire(import.meta.url);
const Module = require('node:module') as { _load: (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown };
const electronFolder = path.resolve('electron');
const mainFile = path.join(electronFolder, 'main.cjs');
const engineFixture = path.resolve('tests/fixtures/main-engine.cjs');
const description = Buffer.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0]);
const sample = (...payload: number[]) => Buffer.from([0, 0, 0, payload.length, ...payload]);
type Preventable = { defaultPrevented: boolean; preventDefault: () => void };
const preventable = (): Preventable => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
const originalLoad = Module._load;
const cleanups: Array<() => Promise<void>> = [];

async function waitFor(condition: () => boolean, what: string, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function start({ primary = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'veacom-main-test-'));
  const desktop = path.join(root, 'desktop'), elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(desktop); fs.mkdirSync(elsewhere);
  const paths: Record<string, string> = { userData: path.join(root, 'user-data'), desktop, temp: os.tmpdir() };
  const page = { holdsUnload: false, answer: 1, onPrompt: () => {} };
  const state = { exited: false, prompts: 0, focused: 0, revealed: [] as string[] };
  class WebContents extends EventEmitter {
    mainFrame = { url: 'veacom://app/index.html' };
    session = { setPermissionRequestHandler() {} };
    setWindowOpenHandler() {} send() {} openDevTools() {}
    isDestroyed() { return false; }
  }
  class BrowserWindow extends EventEmitter {
    static all: BrowserWindow[] = [];
    webContents = new WebContents();
    closed = false;
    constructor() { super(); BrowserWindow.all.push(this); }
    setMenuBarVisibility() {} show() {} restore() {}
    focus() { state.focused++; }
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.closed; }
    isVisible() { return !this.closed; }
    isMinimized() { return false; }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    setName() {}, getVersion: () => '0.1.0-test', getAppMetrics: () => [], getGPUFeatureStatus: () => ({}),
    setPath(name: string, value: string) { paths[name] = value; },
    getPath: (name: string) => paths[name] ?? os.tmpdir(),
    requestSingleInstanceLock: () => primary,
    quit() {
      const before = preventable(); app.emit('before-quit', before);
      if (before.defaultPrevented) return;
      for (const window of BrowserWindow.all.filter(item => !item.closed)) {
        if (page.holdsUnload) {
          const unload = preventable(); window.webContents.emit('will-prevent-unload', unload);
          if (!unload.defaultPrevented) return;
        }
        window.closed = true;
      }
      const willQuit = preventable(); app.emit('will-quit', willQuit);
      if (!willQuit.defaultPrevented) state.exited = true;
    },
  });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const electron = {
    app, BrowserWindow,
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn), on() {}, removeListener() {}, removeHandler() {} },
    dialog: {
      showMessageBoxSync: () => { state.prompts++; page.onPrompt(); return page.answer; },
      showOpenDialog: async () => ({ canceled: false, filePaths: [elsewhere] }),
      showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }), showErrorBox() {},
    },
    clipboard: { writeText() {} }, nativeTheme: {}, net: { fetch: (...args: Parameters<typeof fetch>) => fetch(...args) },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    shell: { openPath: async (target: string) => { state.revealed.push(target); return ''; }, showItemInFolder: (target: string) => { state.revealed.push(target); }, openExternal: async () => {} },
    safeStorage: { isEncryptionAvailable: () => false },
    // The import window's own view and session (import-view.cjs); not opened by these tests.
    session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, protocol: { handle() {} } }) },
    WebContentsView: class {},
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === './engine-process.cjs' && parent?.filename === mainFile) {
      const { EngineProcess } = originalLoad.call(this, request, parent, isMain) as { EngineProcess: new (options: object) => object };
      return { EngineProcess: class extends EngineProcess {
        constructor(options: object) { super({ ...options, binary: process.execPath, args: [engineFixture], stderr: () => {} }); }
      } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(electronFolder + path.sep)) delete require.cache[key];
  process.env.VEACOM_USER_DATA = paths.userData;
  process.env.VEACOM_LOCALE = 'en';
  require(mainFile);
  const window = () => BrowserWindow.all[0];
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ senderFrame: window().webContents.mainFrame }, ...args);
  const invoke = async (channel: string, ...args: unknown[]) => call(channel, ...args);
  const harness = { app, page, state, desktop, elsewhere, handlers, window, call, invoke,
    temporary: () => fs.readdirSync(desktop).filter(name => name.startsWith('.veacom-video-')) };
  cleanups.push(async () => {
    if (!state.exited) {
      page.holdsUnload = false; page.answer = 0;
      app.quit();
      await waitFor(() => state.exited, 'the app to quit');
    }
    Module._load = originalLoad;
    delete process.env.VEACOM_USER_DATA;
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (primary) await waitFor(() => handlers.has('video:begin'), 'main.cjs to register its handlers');
  return harness;
}

async function runningVideo(harness: Awaited<ReturnType<typeof start>>) {
  const job = await harness.invoke('video:begin', 'clip', 10) as { id: string };
  await harness.invoke('video:configure', job.id, { width: 16, height: 16, description });
  await harness.invoke('video:append', job.id, sample(0x65, 1), true);
  return job;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  Module._load = originalLoad;
});

describe('desktop app lifecycle', () => {
  it('asks before stopping anything when Cmd+Q meets a running export, and "Wait" leaves everything working', async () => {
    const app = await start();
    const job = await runningVideo(app);
    assert.equal(app.temporary().length, 1);
    let atPrompt: unknown;
    app.page.holdsUnload = true; app.page.answer = 1; // "Wait", the dialog's default button
    app.page.onPrompt = () => { atPrompt = { engine: (app.call('core:state') as { status: string }).status, videoFolders: app.temporary().length }; };
    app.app.quit();
    await waitFor(() => app.state.prompts === 1, 'the export prompt');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(atPrompt, { engine: 'ready', videoFolders: 1 });
    assert.equal(app.state.exited, false);
    assert.equal((app.call('core:state') as { status: string }).status, 'ready');
    assert.equal(await app.invoke('video:append', job.id, sample(0x41, 2), false), undefined);

    // "Close anyway": now the services stop, the video's temporary samples go, and the app ends.
    app.page.answer = 0;
    app.app.quit();
    await waitFor(() => app.state.exited, 'the app to quit');
    assert.equal((app.call('core:state') as { status: string }).status, 'stopped');
    assert.equal(app.temporary().length, 0);
  });

  it('ends a crashed page\'s exports but keeps video and picture export available to the reloaded page', async () => {
    const app = await start();
    const job = await runningVideo(app);
    const pictures = await app.invoke('images:begin', 'SYNTHETIC - CT', true) as { id: string; directory: string };
    await app.invoke('images:append', pictures.id, '001.png', new Uint8Array([1, 2, 3]).buffer);
    app.window().webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await waitFor(() => !app.temporary().length && !fs.existsSync(pictures.directory), 'the crashed page\'s exports to be removed');
    await assert.rejects(app.invoke('video:append', job.id, sample(0x41, 2), false), { message: /no longer active/ });

    const next = await app.invoke('video:begin', 'after-reload', 10) as { id: string };
    assert.equal(typeof next.id, 'string');
    await app.invoke('video:cancel', next.id);
    const pictures2 = await app.invoke('images:begin', 'SYNTHETIC - CT', true) as { id: unknown };
    assert.equal(typeof pictures2.id, 'string');
  });

  it('shows any export of this session in its folder, also after the export folder changed', async () => {
    const app = await start();
    const job = await runningVideo(app);
    const video = await app.invoke('video:finish', job.id) as string;
    assert.equal(path.dirname(video), app.desktop);
    assert.equal(await app.invoke('export:chooseFolder'), app.elsewhere);
    assert.equal(await app.invoke('export:reveal', video), undefined);
    assert.deepEqual(app.state.revealed, [video]);
  });

  it('stops a DICOM export in the engine when the status bar cancels it, and reports nothing as saved', async () => {
    const app = await start();
    const exporting = app.invoke('dicom:export', ['series-1'], { anonymize: false, dicomdir: false, here: true });
    exporting.catch(() => {});
    // The engine holds the export until its operation is cancelled.
    await new Promise(resolve => setTimeout(resolve, 300));
    await app.invoke('dicom:cancel');
    await assert.rejects(exporting, { message: /Export cancelled/ });
    assert.deepEqual(fs.readdirSync(app.desktop), []);
  });

  it('leaves a second launch to the first one: it quits before starting an engine', async () => {
    const second = await start({ primary: false });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(second.state.exited, true);
    assert.equal(second.handlers.size, 0);
  });

  it('brings the first window forward when VEAcom is launched again', async () => {
    const app = await start();
    app.app.emit('second-instance', {}, [], process.cwd());
    assert.equal(app.state.focused, 1);
  });
});
