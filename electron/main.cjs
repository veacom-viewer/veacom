const { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, net, shell, nativeTheme, systemPreferences } = require('electron');
const path = require('node:path');
app.setName('VEAcom');
if (process.env.VEACOM_USER_DATA) app.setPath('userData', path.resolve(process.env.VEACOM_USER_DATA));
// One VEAcom per user data folder: a second launch brings the first window forward instead. Two copies would share
// the usage-sharing choice and its local copy on disk, so turning sharing off in one would not stop the other.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
const crashes = primary ? require('./crash-reports.cjs').registerCrashReports(app) : null;

const { reviewExportPixels } = require('./export-review.cjs');
const { MAX_EXPORT_SERIES } = require('./export-limits.mjs');
const { createImportView } = require('./import-view.cjs');
const { registerUsageHandlers } = require('./usage.cjs');
const { JS_EXCEPTIONS } = require('./crash-schema.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { EngineProcess } = require('./engine-process.cjs');
const { createHash, randomUUID } = require('node:crypto');
const { ImagingBroker, validateApplicationSender } = require('./imaging-broker.cjs');
const { createPictureDecoder, servePictures } = require('./picture-decoder.cjs');
const i18n = require('./i18n.cjs');
const { t, coreErrorText } = i18n;

protocol.registerSchemesAsPrivileged([{ scheme: 'veacom', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
nativeTheme.themeSource = 'dark';
// Once macOS has recorded a crash of the app, its next start asks "The last time you opened VEAcom, it unexpectedly quit
// while reopening windows. Do you want to try to reopen its windows again?" before the app is ready: no window and no
// engine until someone answers. VEAcom opens its own window at every start and has nothing for macOS to reopen, so it
// ignores macOS's saved window state, as SDL does for every app (registerUserDefaults in
// src/video/cocoa/SDL_cocoaevents.m) and Electron's own tests do (electron/electron#51488). Registered, so it holds only
// while this process runs and nothing is written to disk. macOS logs "ApplePersistenceIgnoreState: Existing state will
// not be touched" once per start.
if (process.platform === 'darwin') systemPreferences.registerDefaults({ ApplePersistenceIgnoreState: true });
// Linux CI has no GPU, and Chromium refuses WebGL on the Mesa software driver it finds there (llvmpipe) rather than
// falling back as Windows does with WARP. VEACOM_SOFTWARE_GL=llvmpipe lets a development run use that driver, so the
// desktop checks draw in .github/workflows/ci.yml. A packaged app ignores it.
if (!app.isPackaged && process.platform === 'linux' && process.env.VEACOM_SOFTWARE_GL === 'llvmpipe') app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.on('second-instance', () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
});
let window;
let engine;
let imaging;
let disposeMedia;
let resetPictures;
let disposeUpdates;
let pictureDecoder;
let stopPictures;
let usage;
let quitting = false;
const root = path.resolve(__dirname, '..');
const devUrl = process.env.VEACOM_DEV_URL;
if (devUrl && new URL(devUrl).hostname !== '127.0.0.1') throw new Error('Development UI must be local.');

function createEngine() {
  const executable = process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core';
  const binary = process.env.VEACOM_CORE_PATH || (app.isPackaged ? path.join(process.resourcesPath, 'native', executable) : path.join(root, 'native', 'target', 'release', executable));
  const manager = new EngineProcess({ binary });
  manager.on('incident', ({ reason, code, signal, work }) => crashes?.record('engine', reason,
    { code, signal, work, recovery: manager.closed ? 'unknown' : 'pending' }));
  manager.on('state', state => {
    if (state.status === 'ready') crashes?.settleEngine('restarted');
    if (state.status === 'failed') crashes?.settleEngine('failed');
    if (state.status === 'stopped') crashes?.settleEngine('unknown');
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('core:state', state);
  });
  return manager;
}

// Engine exports under way, by the id each was given, with the engine that runs it. Cancel stops them at their next
// file, and the engine then removes what they wrote. An export takes as long as it takes: only the engine stopping ends
// its request early (engine-pipe.cjs has no deadline).
const engineExports = new Map();
async function engineAnswer(response) {
  if (!response.ok) throw new Error(coreErrorText(await response.text()));
  return response.json();
}
async function engineExport(connection, request, imaging) {
  if (request.anonymize && request.full) {
    const selected = request.seriesIds.map(id => imaging.requireSeries(id, connection.generation));
    const reviewedRevisions = await reviewExportPixels(dialog, window, selected, t, request.frame);
    if (!reviewedRevisions) return null;
    request = { ...request, reviewedRevisions };
  }
  const operation = randomUUID();
  engineExports.set(operation, connection);
  try { return await engineAnswer(await connection.request('export', { ...request, operation })); }
  finally { engineExports.delete(operation); }
}
async function cancelEngineExports() {
  await Promise.all([...engineExports].map(([operation, connection]) => connection.request('exportCancel', { operation })
    .then(response => response.arrayBuffer()).catch(() => null)));
}

function validateSender(event) {
  validateApplicationSender(event, window, devUrl ? new URL(devUrl).origin : undefined);
}
function handle(channel, fn) { ipcMain.handle(channel, (event, ...args) => { validateSender(event); return fn(...args); }); }
function seriesSelection(value) {
  const ids = Array.isArray(value) ? value : [value];
  if (!ids.length || ids.length > MAX_EXPORT_SERIES || ids.some(id => typeof id !== 'string' || !id.length)) throw new Error(t('export.chooseSeries'));
  return { seriesIds: [...new Set(ids)] };
}

app.whenReady().then(async () => {
  if (!primary) return;
  // Before anything can fail, so the "could not start" box is in the user's language.
  i18n.load(app.getPath('userData'));
  crashes?.setStage('engine-start');
  engine = createEngine();
  await engine.start();
  crashes?.setStage('window-create');
  // The engine parses no picture format: PNG, JPEG and BMP files it meets go to a sandboxed renderer (picture-decoder.cjs).
  pictureDecoder = createPictureDecoder();
  stopPictures = servePictures({ engine, decode: pictureDecoder.decode });
  const testHooks = process.env.VEACOM_TEST_MODE === '1' ? require('./imaging-test-hooks.cjs').createImagingTestHooks() : undefined;
  imaging = new ImagingBroker({ engine, devOrigin: devUrl ? new URL(devUrl).origin : undefined,
    beforePixel: testHooks?.beforePixel, afterImport: testHooks?.afterImport, preparePictures: pictureDecoder.prepare });
  // A study named on the command line starts importing while the window loads.
  const studyArgument = process.argv.indexOf('--study');
  const startupStudy = studyArgument >= 0 && process.argv[studyArgument + 1] ? [path.resolve(process.argv[studyArgument + 1])] : [];
  let startupCapabilities = startupStudy.length ? imaging.authorizeImportPaths(startupStudy).then(capabilities => { imaging.prefetchImport(capabilities); return capabilities; }) : null;
  startupCapabilities?.catch(() => {});
  const assets = path.join(root, 'dist');
  // The application's files with its content security policy; the import window's view serves them too (import-view.cjs).
  const serveFile = async url => {
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(assets, relative);
    if (!file.startsWith(assets + path.sep)) return new Response('Forbidden', { status: 403 });
    const result = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers(result.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'");
    return new Response(result.body, { status: result.status, headers });
  };
  protocol.handle('veacom', async request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    if (url.pathname.startsWith('/_imaging/')) return imaging.pixelResponse(request);
    return serveFile(url);
  });
  // No separate title bar: the toolbar row carries the window controls (macOS traffic lights inset on the left,
  // Windows/Linux caption buttons overlaid on the right) and its empty space drags the window. titleBarOverlay
  // exposes the controls' area to CSS (env(titlebar-area-*)) in CSS pixels, so the room left for them follows
  // the page zoom. On macOS that area is 2y + 14 px tall: y = 15 centres the lights in the 44 px toolbar.
  // The title 'VEAcom' still names the window for the Dock, taskbar and window switchers.
  const chrome = process.platform === 'darwin'
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 }, titleBarOverlay: true }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#16181d', symbolColor: '#e4e7ec', height: 44 } };
  window = new BrowserWindow({ width: 1500, height: 960, minWidth: 900, minHeight: 640, backgroundColor: '#111519', title: 'VEAcom', show: false, ...chrome, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    // The preload reads the saved language from here, so the first frame is already in it.
    additionalArguments: [`--veacom-locale=${i18n.getLocale()}`, `--veacom-version=${app.getVersion()}`, `--veacom-local-usage-check=${process.env.VEACOM_USAGE_CHECK_LOCAL === '1' ? 1 : 0}`] } });
  const nextRendererFault = new Map();
  const reportRendererFault = (reason, exception) => {
    const key = exception ? reason + '/' + exception : reason, now = performance.now();
    if (!crashes || quitting || now < (nextRendererFault.get(key) ?? 0)) return;
    nextRendererFault.set(key, now + 60_000);
    crashes.record('renderer', reason, { exception });
  };
  ipcMain.on('fault:renderer', (event, reason, exception) => {
    try { validateSender(event); } catch { return; }
    if (['render-failed', 'uncaught-exception', 'unhandled-rejection'].includes(reason) && JS_EXCEPTIONS.includes(exception)) {
      reportRendererFault(reason, exception);
    }
  });
  let unresponsive = false;
  window.on('unresponsive', () => {
    if (!unresponsive) reportRendererFault('unresponsive');
    unresponsive = true;
  });
  window.on('responsive', () => { unresponsive = false; });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  // The page holds the window open while an export runs (App.tsx): ask before closing it half done.
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, { type: 'warning', title: t('export.quitTitle'), message: t('export.quitMessage'), detail: t('export.quitDetail'),
      buttons: [t('export.quitAnyway'), t('export.quitStay')], defaultId: 1, cancelId: 1, noLink: true });
    if (choice === 0) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window.show());
  // A crashed page ends the exports it had started here (their temporary files go); a reload can start new ones.
  window.webContents.on('render-process-gone', () => {
    Promise.allSettled([disposeMedia?.reset(), resetPictures?.()]).then(results => {
      for (const result of results) if (result.status === 'rejected') process.stderr.write(`Export cleanup failed: ${result.reason?.message}\n`);
    });
  });
  // Navigation starts before the remaining modules load. Every handler below is registered in this same
  // task, so the page cannot invoke one before it exists.
  const loading = window.loadURL(devUrl || 'veacom://app/index.html');
  handle('core:state', () => engine.state());
  handle('app:locale', locale => { i18n.setLocale(locale); });
  handle('imaging:series', () => imaging.listSeries());
  handle('imaging:import', capabilities => imaging.importSelected(capabilities));
  handle('imaging:progress', () => imaging.getProgress());
  handle('imaging:early', (capabilities, after) => imaging.importEarly(capabilities, after));
  handle('imaging:cancel', id => imaging.cancelOperation(id));
  handle('imaging:measure', (...args) => imaging.measure(...args));
  handle('imaging:tags', (id, generation, frame, revision) => imaging.getTags(id, generation, frame, revision));
  handle('imaging:remove', (ids, generation) => imaging.removeSeries(ids, generation));
  handle('imaging:pixels', request => imaging.getPixels(request));
  handle('files:drop-capabilities', paths => imaging.authorizeImportPaths(paths));
  handle('files:startup', () => { const pending = startupCapabilities; startupCapabilities = null; return pending ?? []; });
  // A packaged app adds no switch for PCs without a usable graphics driver. Chromium 156 (Electron 45) already draws
  // WebGL in software on Windows through Direct3D WARP. On the Windows VM with its GPU disabled, adding
  // --enable-unsafe-swiftshader swapped WARP for SwiftShader, whose first WebGL context was lost at startup
  // before it drew; on macOS, Electron 45 ships without the Vulkan loader SwiftShader needs. The renderer
  // reads this status and tells the user when drawing runs in software.
  handle('gpu:status', () => { const status = app.getGPUFeatureStatus(); return { webgl: status.webgl, gpuCompositing: status.gpu_compositing }; });
  if (process.env.VEACOM_TEST_MODE === '1') app.__VEACOM_PRIVILEGED_TEST__ = {
    ...testHooks.api,
    authorizeImportPaths: paths => imaging.authorizeImportPaths(paths),
    // The engine's generation; and a request to it straight from main, for checks that compare the engine's own state
    // with what the page shows. The engine's pipes stay here: a check gets the answer, never a way to reach the engine.
    coreConnection: () => ({ generation: engine.connection().generation }),
    coreRequest: async (op, body) => {
      const connection = engine.connection(), response = await connection.request(op, body);
      const bytes = Buffer.from(await response.arrayBuffer());
      const json = (response.headers.get('Content-Type') || '').includes('json') ? JSON.parse(bytes.toString('utf8')) : undefined;
      return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), json, generation: connection.generation };
    },
    pictureDecoderProcesses: () => pictureDecoder.processIds(),
  };
  handle('links:open', async value => {
    if (typeof value !== 'string') throw new Error('Invalid link.');
    const url = new URL(value);
    const allowed = url.hostname === 'radiopaedia.org' || url.hostname === 'www.radiopaedia.org' || (url.hostname === 'claude.ai' && url.pathname === '/new');
    if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port) throw new Error(t('links.notAllowed'));
    await shell.openExternal(url.href);
  });
  handle('files:open', async kind => {
    if (!['files', 'folder', 'archive'].includes(kind)) throw new Error('Invalid import type.');
    const finish = kind === 'files' ? pictureDecoder.prepareFileDialog() : undefined;
    let paths = [];
    try {
      const selected = await dialog.showOpenDialog(window, { title: t('dialog.openStudy'), properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'], ...(kind === 'archive' ? { filters: [{ name: t('dialog.archives'), extensions: ['zip'] }] } : {}) });
      if (!selected.canceled) paths = selected.filePaths;
      return paths.length ? imaging.authorizeImportPaths(paths) : [];
    } finally { finish?.(paths); }
  });
  // The import window, in a view of its own (import-view.cjs): this page only opens it, right after the user's own
  // click or key press, and receives import capabilities for what the user opened there.
  const importView = createImportView({ app, window: () => window, devUrl, locale: () => i18n.getLocale(), authorize: paths => imaging.authorizeImportPaths(paths), serve: serveFile });
  window.webContents.on('did-start-loading', () => importView.close());
  window.on('closed', () => importView.close());
  handle('files:import-window', start => importView.open(start === 'disc' ? 'disc' : undefined));
  handle('files:save', async (suggestedName, data) => {
    if (typeof suggestedName !== 'string' || !(typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data))) throw new Error('Invalid export.');
    const selection = await dialog.showSaveDialog(window, { defaultPath: path.basename(suggestedName) });
    if (selection.canceled || !selection.filePath) return null;
    await fs.writeFile(selection.filePath, typeof data === 'string' ? data : Buffer.from(data));
    return selection.filePath;
  });
  // Exports go to one remembered folder (VEAcom 1.x), the Desktop at first; what was written can be shown in Explorer.
  const exportFolder = require('./export-folder.cjs').createExportFolder({ app, dialog, getWindow: () => window, t });
  const exported = new Set();
  handle('export:folder', () => exportFolder.folder());
  // Text for a report (the checklist's summary): the system clipboard, which the page itself may not reach.
  handle('clipboard:write', text => { if (typeof text !== 'string' || text.length > 100000) throw new Error('Invalid text.'); clipboard.writeText(text); });
  handle('export:chooseFolder', () => exportFolder.choose());
  handle('export:reveal', async target => {
    if (typeof target !== 'string' || !(exported.has(target) || await exportFolder.holds(target))) throw new Error('Not an export of this session.');
    const stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) await shell.openPath(target); else shell.showItemInFolder(target);
  });
  handle('dicom:export', async (seriesId, options) => {
    const selection = seriesSelection(seriesId);
    if (!options || typeof options.anonymize !== 'boolean' || typeof options.dicomdir !== 'boolean') throw new Error('Invalid DICOM export request.');
    if (options.decompress !== undefined && typeof options.decompress !== 'boolean') throw new Error('Invalid decompression option.');
    if (options.root !== undefined && (typeof options.root !== 'boolean' || (options.root && !options.dicomdir))) throw new Error('Invalid media placement.');
    if (options.here !== undefined && typeof options.here !== 'boolean') throw new Error('Invalid export folder option.');
    if (options.full !== undefined && typeof options.full !== 'boolean') throw new Error('Invalid anonymisation option.');
    if (options.frame !== undefined && !(Number.isInteger(options.frame) && options.frame >= 0 && selection.seriesIds.length === 1)) throw new Error('Invalid slice.');
    // A ZIP per patient holds plain DICOM files: never with a DICOMDIR, a USB root or decompression.
    if (options.zip !== undefined && (typeof options.zip !== 'boolean' || (options.zip && (options.dicomdir || options.root || options.decompress)))) throw new Error('Invalid ZIP option.');
    if (options.smallest !== undefined && typeof options.smallest !== 'boolean') throw new Error('Invalid ZIP option.');
    const requested = engine.connection(options.engineGeneration);
    // Into the remembered folder without asking (a USB stick's root is still chosen each time).
    let directory;
    if (options.here && !options.root) directory = await exportFolder.folder();
    else {
      const selected = await dialog.showOpenDialog(window, { title: t('dialog.exportFolder'), properties: ['openDirectory', 'createDirectory'] });
      if (selected.canceled) return null;
      directory = selected.filePaths[0];
    }
    // A USB stick's media goes to its root, where some neuronavigation systems look for DICOMDIR.
    // Media already there is never overwritten: a new copy may go into a subfolder instead.
    let root = options.root === true;
    const present = name => fs.access(path.join(directory, name)).then(() => true, () => false);
    if (root && (await present('DICOMDIR') || await present('DICOM'))) {
      const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: [t('export.rootSubfolder'), t('export.rootCancel')],
        defaultId: 0, cancelId: 1, noLink: true, title: t('export.rootTitle'), message: t('export.rootExists', { directory }), detail: t('export.rootDetail') });
      if (response !== 0) return null;
      root = false;
    }
    const connection = engine.connection(requested.generation);
    const result = await engineExport(connection, { ...selection, directory, anonymize: options.anonymize, full: options.full === true, frame: options.frame, dicomdir: options.dicomdir, decompress: options.decompress ?? false, root, zip: options.zip === true, smallest: options.zip === true && options.smallest === true }, imaging);
    if (typeof result?.directory === 'string') exported.add(result.directory);
    return result;
  });
  // The status bar's Cancel for a DICOM, USB or folder export.
  handle('dicom:cancel', () => cancelEngineExports());
  // A ZIP export's size and time before it is made, from a few of its files really compressed.
  handle('dicom:estimate', async (seriesId, options) => {
    const selection = seriesSelection(seriesId);
    if (!options || typeof options.anonymize !== 'boolean' || typeof options.full !== 'boolean' || typeof options.smallest !== 'boolean') throw new Error('Invalid estimate request.');
    if (options.frame !== undefined && !(Number.isInteger(options.frame) && options.frame >= 0 && selection.seriesIds.length === 1)) throw new Error('Invalid slice.');
    const connection = engine.connection(options.engineGeneration);
    return engineAnswer(await connection.request('exportEstimate',
      { ...selection, directory: '', anonymize: options.anonymize, full: options.full, zip: true, smallest: options.smallest, frame: options.frame }));
  });
  // In-app feedback (electron/feedback.cjs): sent only after the user confirms the exact text in a native dialog.
  require('./feedback.cjs').registerFeedback({ handle, dialog, getWindow: () => window, t, net, app, locale: () => i18n.getLocale() });
  require('./assessment.cjs').registerAssessmentHandlers(handle, { app, safeStorage: require('electron').safeStorage, dialog,
    getWindow: () => window, enabled: require('../package.json').veacomAssessmentAI === true });
  // Every export this session saved can be shown in its folder, wherever the export folder is now.
  const recordExport = target => { if (typeof target === 'string') exported.add(target); };
  const swept = new Set();
  const sweepFolder = folder => { if (folder && !swept.has(folder)) { swept.add(folder); void require('./media.cjs').sweepExportLeftovers([folder]).catch(() => {}); } };
  resetPictures = require('./image-export.cjs').registerImageExport({ handle, dialog, getWindow: () => window, t, exportFolder, recordExport, sweepFolder }).reset;
  usage = registerUsageHandlers({ handle, ipcMain, validateSender, userData: app.getPath('userData'), version: app.getVersion(), packaged: app.isPackaged, resourceMonitor: require('./resource-monitor.cjs').forViewer(app, engine, () => Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized())) });
  disposeUpdates = require('./updates.cjs').registerUpdateHandlers({ handle, app, getWindow: () => window, dialog, shell });
  const media = require('./media.cjs');
  disposeMedia = media.registerMediaHandlers({
    handle, getWindow: () => window, exportFolder, recordExport, sweepFolder, cancelStaging: cancelEngineExports,
    exportDicomDirectory: (seriesId, directory, anonymize, decompress = false, engineGeneration, full = false) =>
      engineExport(engine.connection(engineGeneration), { ...seriesSelection(seriesId), directory, anonymize, full, dicomdir: true, decompress }, imaging),
  });
  // Temporary export folders a crash, forced quit or shutdown left behind (they can hold patient images): the system's
  // temporary folder now, and a folder exports go to when an export first writes there. Reading the Desktop (the
  // default export folder) at startup would make macOS ask for access before the user did anything.
  void media.sweepExportLeftovers([os.tmpdir()]).catch(() => {});
  await loading;
  crashes?.setStage('running');
  if (process.env.VEACOM_DEVTOOLS === '1') window.webContents.openDevTools({ mode: 'detach' });
}).catch(error => {
  crashes?.startupFailed(error);
  process.stderr.write(`${error.stack || error.message}\n`);
  dialog.showErrorBox(t('startup.failed'), error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
// Services stop only once every window has closed. Electron emits before-quit before it closes any window, so
// stopping them there killed an export before its window could ask "Close anyway / Wait", and "Wait" then left
// a window with no engine. A window holding an export asks first (will-prevent-unload); "Wait" cancels the quit.
app.on('will-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  imaging?.dispose();
  disposeUpdates?.();
  stopPictures?.();
  pictureDecoder?.close();
  Promise.allSettled([engine?.stop(), disposeMedia?.(), usage?.flush(), crashes?.flush()]).then(results => {
    for (const result of results) if (result.status === 'rejected') process.stderr.write(`Shutdown cleanup failed: ${result.reason.message}\n`);
  }).finally(() => app.quit());
});
