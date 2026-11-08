// Drops a folder or file from disk onto the browser build of the interface (served at http://127.0.0.1:5200/ by
// `node web/serve.mjs 5200 dist`, or at VEACOM_URL), as a user would, waits until its series are listed and the first image is
// shown, saves a picture of the page and prints the timings and any console errors (security-policy refusals among
// them). Runs in a hidden Electron window: never on screen, never focused.
//
//   <electron.exe> web/tools/app-check.cjs <folder or file> <picture.png>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const [target, picture] = process.argv.slice(-2);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, x: -4000, y: -4000, width: 1400, height: 900, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
  const messages = [];
  win.webContents.on('console-message', (event, legacyLevel, legacyMessage) => {
    const level = event.level ?? legacyLevel, message = event.message ?? legacyMessage;
    if (!['info', 'debug', 0, 1].includes(level)) messages.push(`${level}: ${message}`.slice(0, 400));
  });
  await win.loadURL(process.env.VEACOM_URL ?? 'http://127.0.0.1:5200/');
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`new Promise((resolve) => { const wait = () => document.body.innerText.includes('Hazır') || document.body.innerText.includes('Ready') ? resolve() : setTimeout(wait, 50); wait(); })`);
  const devtools = win.webContents.debugger;
  devtools.attach('1.3');
  const point = { x: 700, y: 450 };
  const data = { items: [], files: [target], dragOperationsMask: 1 };
  // What the page shows, and the engine's generation, every quarter second.
  await js(`window.__timeline = []; window.__t0 = performance.now(); setInterval(async () => { const state = await window.veacom.getCoreState(); window.__timeline.push([Math.round(performance.now() - window.__t0), state.generation, (document.querySelector('footer')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 90)]); }, 250)`);
  const started = Date.now();
  for (const type of ['dragEnter', 'dragOver', 'drop']) await devtools.sendCommand('Input.dispatchDragEvent', { type, ...point, data });
  const listed = await js(`new Promise((resolve) => { const end = Date.now() + 120000; const wait = () => { const text = document.querySelector('footer')?.innerText ?? document.body.innerText; const match = /(\\d+) (seri|series)/.exec(text); if (match && match[1] !== '0') resolve(text.replace(/\\s+/g, ' ')); else if (Date.now() > end) resolve(null); else setTimeout(wait, 50); }; wait(); })`);
  const listedMs = Date.now() - started;
  const shown = await js(`new Promise((resolve) => { const end = Date.now() + 120000; const wait = () => !document.body.innerText.match(/yükleniyor|loading/i) ? resolve(true) : Date.now() > end ? resolve(false) : setTimeout(wait, 50); wait(); })`);
  const shownMs = Date.now() - started;
  // Long enough for the first series' volume to be decoded and drawn.
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SETTLE_MS ?? 4000)));
  const image = await win.webContents.capturePage();
  const timeline = await js('window.__timeline.filter((row, i, all) => i === 0 || row[1] !== all[i - 1][1] || row[2] !== all[i - 1][2])');
  console.log(JSON.stringify({ timeline }));
  fs.writeFileSync(picture, image.toPNG());
  const notices = await js(`[...document.querySelectorAll('[role=alert], [role=status]')].map((e) => e.innerText).filter(Boolean).join(' | ').slice(0, 400)`);
  // How many threads the engine decodes on (1: the single-thread build).
  const threads = Number(await js('document.documentElement.dataset.engineThreads ?? 0'));
  console.log(JSON.stringify({ target, threads, listedMs, shownMs, listed, shown, notices, messages }));
  devtools.detach();
  app.quit();
});
