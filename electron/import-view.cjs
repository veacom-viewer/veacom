'use strict';
// The import window (src/import-window), as in VEAcom Next, in a view of its own laid over the application window:
// its own origin (veacom://import), session and preload (import-preload.cjs), and first-party code only. The
// application page can only ask for it to open, right after the user clicks or presses a key in the application,
// and receives import capabilities for what the user opened there. It cannot list folders, name paths, or write the
// window's pins and last folder: page JavaScript is not trusted (docs/imaging-security.md).
const path = require('node:path');
const { WebContentsView, ipcMain, session } = require('electron');
const fileBrowser = require('./file-browser.cjs');

// The window's clicks, relayed to the application page's usage timings (electron/usage-schema.json).
const ACTIONS = new Set(['import-cancel', 'import-list', 'import-open', 'import-pin', 'import-place', 'import-up']);
const INPUTS = new Set(['mouse', 'key', 'touch']);
// The user's own input in the application window, which page JavaScript cannot make.
const USER_INPUT = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart', 'gestureTap']);
const INPUT_MS = 1500;
const address = value => { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; };

function createImportView({ app, window: applicationWindow, devUrl, locale, authorize, serve, now = Date.now }) {
  const url = devUrl ? new URL('import.html', devUrl).href : 'veacom://import/import.html';
  // A session of its own keeps the window's storage apart from the page's, in development too, where both come from
  // the same development server. It serves only the application's files under veacom://import.
  const importSession = session.fromPartition('persist:veacom-import');
  importSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  importSession.setPermissionCheckHandler(() => false);
  importSession.protocol.handle('veacom', request => {
    const requested = new URL(request.url);
    return requested.host === 'import' ? serve(requested) : new Response('Not found', { status: 404 });
  });
  let current = null, lastInput = -Infinity;
  applicationWindow().webContents.on('input-event', (_event, input) => { if (USER_INPUT.has(input.type)) lastInput = now(); });

  // Only the open view's own page, at its own address, reaches the folder browser.
  function validate(event) {
    const contents = current?.view.webContents;
    if (!contents || event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame || address(event.senderFrame.url) !== address(url)) {
      throw new Error('Untrusted import frame.');
    }
    return current;
  }
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(validate(event), ...args));
  handle('importview:places', () => fileBrowser.places(app));
  handle('importview:browse', (_asking, folder) => fileBrowser.browse(folder, fileBrowser.usualPlaces(app)));
  // What a window opened goes to the request that showed it, even if another has replaced it in the meantime.
  handle('importview:open', async (asking, paths) => { finish(asking, await authorize(fileBrowser.chosenPaths(paths, fileBrowser.usualPlaces(app)))); });
  handle('importview:close', asking => { finish(asking, []); });
  ipcMain.on('importview:action', (event, id, input) => {
    try { validate(event); } catch { return; }
    const window = applicationWindow();
    if (ACTIONS.has(id) && INPUTS.has(input) && window && !window.isDestroyed()) window.webContents.send('import:action', id, input);
  });

  function finish(which, capabilities) {
    if (!current || current !== which) { which?.resolve([]); return; }
    const { view, resolve, unfit } = current;
    current = null;
    unfit();
    const window = applicationWindow();
    if (window && !window.isDestroyed()) { window.contentView.removeChildView(view); window.webContents.focus(); }
    if (!view.webContents.isDestroyed()) view.webContents.close();
    resolve(capabilities);
  }

  /** Shows the window, starting at a disc drive for 'disc'; resolves to the capabilities opened there, or [] when closed. */
  function open(start) {
    const window = applicationWindow();
    if (!window || window.isDestroyed()) throw new Error('The application window is closed.');
    if (now() - lastInput > INPUT_MS) throw new Error('The import window opens only from a click or key press in the application.');
    // One window at a time: what it opens goes to the request that showed it.
    if (current) { current.view.webContents.focus(); return Promise.resolve([]); }
    const view = new WebContentsView({ webPreferences: { session: importSession, preload: path.join(__dirname, 'import-preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webSecurity: true, spellcheck: false, additionalArguments: [`--veacom-locale=${locale()}`, ...(start === 'disc' ? ['--veacom-import-start=disc'] : [])] } });
    view.setBackgroundColor('#00000000');
    const contents = view.webContents;
    const fit = () => { const [width, height] = window.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); };
    let resolve;
    const done = new Promise(settle => { resolve = settle; });
    const entry = { view, resolve, unfit: () => window.removeListener('resize', fit) };
    current = entry;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('render-process-gone', () => finish(entry, []));
    fit();
    window.on('resize', fit);
    window.contentView.addChildView(view);
    contents.loadURL(url).then(() => { if (current === entry) contents.focus(); }, () => finish(entry, []));
    return done;
  }

  return { open, close: () => finish(current, []) };
}

module.exports = { createImportView };
