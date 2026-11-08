// Opens a study in the browser build (http://127.0.0.1:5200/, `node web/serve.mjs 5200 dist`, or VEACOM_URL) and
// shows it at screen sizes and pixel densities people have: for each, whether the page overflows, which toolbar or
// status-bar items fall outside the window, whether the image is drawn at the screen's full resolution, and a
// screenshot. Runs in a hidden Electron window: never on screen, never focused.
//
//   <electron.exe> web/tools/viewports.cjs <folder or file> <folder for screenshots>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [target, output] = process.argv.slice(-2);
// name, CSS width × height, device pixel ratio, phone or tablet (touch)
const screens = [
  ['monitor-2560x1440', 2560, 1440, 1, false],
  ['desktop-1920x1080', 1920, 1080, 1, false],
  ['laptop-1920x1080-at-125', 1536, 864, 1.25, false],
  ['laptop-1920x1080-at-150', 1280, 720, 1.5, false],
  ['macbook-1440x900-retina', 1440, 900, 2, false],
  ['old-screen-1366x768', 1366, 768, 1, false],
  ['desktop-minimum-900x640', 900, 640, 1, false],
  ['tablet-1024x768', 1024, 768, 2, true],
  ['tablet-portrait-820x1180', 820, 1180, 2, true],
  ['phone-390x844', 390, 844, 3, true],
];

// A failed or stuck step ends the run instead of leaving the hidden window open.
process.on('unhandledRejection', (error) => { console.error(error); app.exit(1); });
const within = (ms, promise, step) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${step} took longer than ${ms} ms`)), ms))]);

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  fs.rmSync(path.join(output, 'results.jsonl'), { force: true });
  const win = new BrowserWindow({ show: false, x: -4000, y: -4000, width: 1920, height: 1080, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(process.env.VEACOM_URL ?? 'http://127.0.0.1:5200/');
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`new Promise((resolve) => { const wait = () => /Hazır|Ready/.test(document.body.innerText) ? resolve() : setTimeout(wait, 50); wait(); })`);
  const devtools = win.webContents.debugger;
  devtools.attach('1.3');
  const data = { items: [], files: [target], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await devtools.sendCommand('Input.dispatchDragEvent', { type, x: 700, y: 450, data });
  await js(`new Promise((resolve) => { const end = Date.now() + 120000; const wait = () => { const text = document.body.innerText; if ((/[1-9]\\d* (seri|series)/.test(text) && !/yükleniyor|loading|okunuyor/i.test(text)) || Date.now() > end) resolve(); else setTimeout(wait, 100); }; wait(); })`);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  for (const [name, width, height, scale, mobile] of screens) {
    await devtools.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    await devtools.sendCommand('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const report = await within(15000, js(`(() => {
      const inside = (rect) => rect.width > 0 && rect.height > 0;
      const out = [...document.querySelectorAll('button, [role=button], select, input, a')].filter((element) => {
        const rect = element.getBoundingClientRect();
        if (!inside(rect) || getComputedStyle(element).visibility === 'hidden') return false;
        return rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1 || rect.left < -1;
      }).map((element) => (element.getAttribute('aria-label') || element.title || element.innerText || element.dataset.action || element.tagName).trim().slice(0, 30));
      const canvases = [...document.querySelectorAll('canvas')].map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() })).filter(({ rect }) => rect.width > 200).sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
      const main = canvases[0];
      const sharpness = main ? +(main.canvas.width / (main.rect.width * devicePixelRatio)).toFixed(2) : null;
      return {
        size: innerWidth + 'x' + innerHeight + '@' + devicePixelRatio,
        overflowX: document.documentElement.scrollWidth > innerWidth + 1,
        overflowY: document.documentElement.scrollHeight > innerHeight + 1,
        outside: [...new Set(out)].slice(0, 12),
        outsideCount: out.length,
        image: main ? Math.round(main.rect.width) + 'x' + Math.round(main.rect.height) + ' css, sharpness ' + sharpness : 'none',
        footerVisible: (() => { const footer = document.querySelector('footer'); if (!footer) return null; const rect = footer.getBoundingClientRect(); return rect.bottom <= innerHeight + 1 && rect.top >= 0; })(),
      };
    })()`), 'measure');
    // The window's own capture: a hidden window draws no new frame for DevTools' screenshot after a size change.
    const image = await within(15000, win.webContents.capturePage(), 'capture');
    fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
    fs.appendFileSync(path.join(output, 'results.jsonl'), `${JSON.stringify({ name, ...report })}\n`);
  }
  devtools.detach();
  app.quit();
});
