// Times how browser DICOM viewers open studies from disk, on equal terms: the same Chromium (this Electron), the same
// window, the same files dropped the same way. For each site, study and round it records:
// - the page's own load (cold in the first round, from the browser's cache after);
// - when an image first shows in the page's largest canvas;
// - when the work is over: the window's processes have stayed under a fifth of one core for two seconds;
// - the CPU time all the window's processes spent until then, and the most memory they held;
// - every request the page made after the drop (a viewer that works on the computer sends nothing with the files).
// The window is shown off-screen (Chromium barely draws a hidden one), never focused, with a red "TEST PENCERESİ"
// banner, and starts from an empty browser profile. One site per run: two sites in one Electron process failed to load
// the second.
//
//   SITE=https://viewer.example/ <electron.exe> web/tools/site-timing.cjs <study> [<study> ...]
// ROUNDS (default 2), SITE_TIMING_OUT (default site-timing.jsonl), SITE_TIMING_SHOTS (a folder for pictures).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const sites = [process.env.SITE].filter(Boolean);
const studies = process.argv.slice(2).filter((arg) => fs.existsSync(arg) && !arg.endsWith('.cjs'));
const ROUNDS = Number(process.env.ROUNDS ?? 2);
const OUT = process.env.SITE_TIMING_OUT ?? 'site-timing.jsonl';
const SHOTS = process.env.SITE_TIMING_SHOTS;
const LIMIT_MS = 120_000;
const QUIET_SHARE = 0.2; // of one core
const QUIET_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BANNER = `(() => { if (document.getElementById('__test_banner')) return; const b = document.createElement('div'); b.id = '__test_banner'; b.textContent = 'TEST PENCERESİ'; b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#c00;color:#fff;font:bold 11px sans-serif;text-align:center;padding:1px;pointer-events:none'; document.documentElement.append(b); })()`;
const LARGEST_CANVAS = `(() => { let best = null; for (const c of document.querySelectorAll('canvas')) { const r = c.getBoundingClientRect(); const a = r.width * r.height; if (a > 40000 && r.right > 0 && r.bottom > 0 && (!best || a > best.a)) best = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth - Math.max(0, r.x)), height: Math.min(r.height, innerHeight - Math.max(0, r.y)), a }; } return best && { x: Math.round(best.x), y: Math.round(best.y), width: Math.round(best.width), height: Math.round(best.height) }; })()`;

/** Whether a picture holds an image: at least 3% of it lit, with real contrast (text over black is neither). */
function showsImage(image) {
  const { width, height } = image.getSize();
  if (!width || !height) return false;
  const pixels = image.toBitmap();
  let count = 0, lit = 0, sum = 0, squares = 0;
  for (let i = 0; i < pixels.length; i += 4 * 7) {
    const y = 0.114 * pixels[i] + 0.587 * pixels[i + 1] + 0.299 * pixels[i + 2];
    count++; sum += y; squares += y * y;
    if (y > 30) lit++;
  }
  const mean = sum / count;
  return lit / count > 0.03 && Math.sqrt(squares / count - mean * mean) > 15;
}

function processes() {
  return app.getAppMetrics().filter((metric) => metric.type !== 'Browser');
}

// Each run closes its window before the next opens; that must not end the app.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  for (const [siteIndex, site] of sites.entries()) {
    // One browser profile for the whole run: the first window loads the page cold, the later ones from the cache.
    const partition = `site-timing-${siteIndex}-${Date.now()}`;
    for (const study of studies) {
      for (let round = 1; round <= ROUNDS; round++) {
        const line = { site, study: path.basename(study), round };
        // A fresh window for every run, so memory held for an earlier study is not counted again.
        const win = new BrowserWindow({ show: false, x: -4000, y: -4000, width: 1400, height: 900, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false, partition } });
        win.showInactive();
        win.setPosition(-4000, -4000);
        // A page that asks before it is left (a study is open) is closed without asking.
        win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
        const requests = [];
        win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
          const url = new URL(details.url);
          const upload = (details.uploadData ?? []).reduce((total, part) => total + (part.bytes?.length ?? 0) + (part.file ? 1 : 0), 0);
          requests.push({ at: Date.now(), method: details.method, host: url.host, path: url.pathname.slice(0, 80), upload });
          callback({});
        });
        const js = (code) => win.webContents.executeJavaScript(code);
        const devtools = win.webContents.debugger;
        try {
          const loadStart = Date.now();
          await win.loadURL(site);
          // The page's own load is over once it has asked for nothing new for a second and a half.
          for (let last = requests.length, still = Date.now(); Date.now() - still < 1500 && Date.now() - loadStart < 30_000; await sleep(100)) {
            if (requests.length !== last) { last = requests.length; still = Date.now(); }
          }
          line.pageMs = Date.now() - loadStart - 1500;
          await js(BANNER);
          devtools.attach('1.3');
          await sleep(500);

          const before = new Map(processes().map((m) => [m.pid, m.cpu.cumulativeCPUUsage]));
          const firstRequest = requests.length;
          let peakMB = 0, firstImage = null, quietSince = null, done = null, lastCpu = before, lastAt = Date.now();
          const started = Date.now();
          for (const type of ['dragEnter', 'dragOver', 'drop']) await devtools.sendCommand('Input.dispatchDragEvent', { type, x: 700, y: 450, data: { items: [], files: [study], dragOperationsMask: 1 } });
          while (Date.now() - started < LIMIT_MS) {
            await sleep(100);
            if (firstImage === null) {
              const rect = await js(LARGEST_CANVAS);
              if (rect && rect.width > 0 && rect.height > 0 && showsImage(await win.webContents.capturePage(rect))) {
                firstImage = Date.now() - started;
                if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${siteIndex}-${line.study}-${round}-first.png`), (await win.webContents.capturePage()).toPNG());
              }
            }
            if (Date.now() - lastAt >= 250) {
              const now = Date.now(), metrics = processes();
              const cores = metrics.reduce((total, m) => total + (m.cpu.cumulativeCPUUsage - (lastCpu.get(m.pid) ?? m.cpu.cumulativeCPUUsage)), 0) / ((now - lastAt) / 1000);
              peakMB = Math.max(peakMB, metrics.reduce((total, m) => total + (m.memory.privateBytes ?? m.memory.workingSetSize), 0) / 1024);
              lastCpu = new Map(metrics.map((m) => [m.pid, m.cpu.cumulativeCPUUsage])); lastAt = now;
              if (cores < QUIET_SHARE) quietSince ??= now; else quietSince = null;
              if (firstImage !== null && quietSince !== null && now - quietSince >= QUIET_MS) { done = quietSince - started; break; }
            }
          }
          const after = processes();
          line.firstImageMs = firstImage;
          line.doneMs = done;
          line.cpuSeconds = +after.reduce((total, m) => total + (m.cpu.cumulativeCPUUsage - (before.get(m.pid) ?? 0)), 0).toFixed(2);
          line.peakMB = Math.round(peakMB);
          line.endMB = Math.round(after.reduce((total, m) => total + (m.memory.privateBytes ?? m.memory.workingSetSize), 0) / 1024);
          const sent = requests.slice(firstRequest);
          line.requests = sent.length;
          line.sent = sent.filter((r) => r.method !== 'GET' || r.upload > 0 || r.host !== new URL(site).host).map((r) => `${r.method} ${r.host}${r.path}${r.upload ? ` (${r.upload} B)` : ''}`);
          if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${siteIndex}-${line.study}-${round}-done.png`), (await win.webContents.capturePage()).toPNG());
        } catch (error) {
          line.error = String(error?.message ?? error);
        }
        fs.appendFileSync(OUT, `${JSON.stringify(line)}\n`);
        if (devtools.isAttached()) devtools.detach();
        win.destroy();
        await sleep(1000);
      }
    }
  }
  app.quit();
});
