// Opens hostile files one at a time in the prototype and records what happened to each: opened, refused
// with a message, or crashed the engine (which the page must replace). Runs in a hidden Electron window
// (never on screen, never focused; the page carries a red "TEST PENCERESİ" banner).
//
//   node web/serve.mjs                       (in another terminal)
//   <electron.exe> web/tools/hostile.cjs <folder of hostile files> <a good DICOM file>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [folder, good] = process.argv.slice(-2);
const LIMIT_MS = 20000;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, x: -4000, y: -4000, width: 1200, height: 800, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('http://127.0.0.1:5199/');
  const js = (code) => win.webContents.executeJavaScript(code);
  // Any script smuggled in through a file would call alert; count it.
  await js('window.__alerts = 0; window.alert = () => { window.__alerts++; }; new Promise((r) => setTimeout(r, 300))');
  const devtools = win.webContents.debugger;
  devtools.attach('1.3');
  const open = async (file) => {
    const before = await js('window.__runs.length');
    const { root } = await devtools.sendCommand('DOM.getDocument');
    const { nodeId } = await devtools.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#pick-files' });
    const started = Date.now();
    await devtools.sendCommand('DOM.setFileInputFiles', { nodeId, files: [file] });
    const run = await js(`new Promise((resolve) => { const end = Date.now() + ${LIMIT_MS}; const wait = () => window.__runs.length > ${before} ? resolve(window.__runs.at(-1)) : Date.now() > end ? resolve({ hang: true }) : setTimeout(wait, 50); wait(); })`);
    const outcome = run.hang ? 'hang' : run.crash ? 'crash' : run.error ? 'refused' : 'opened';
    return { file: path.basename(file), outcome, ms: Date.now() - started, memoryMB: run.memory ? Math.round(run.memory / 1048576) : null, message: (run.crash ?? run.error ?? '').split('\n')[0].slice(0, 140), series: run.series };
  };
  const names = fs.readdirSync(folder).sort((a, b) => a.endsWith('.zip') - b.endsWith('.zip') || a.localeCompare(b));
  const results = [];
  let xss = null;
  for (const name of names) {
    const result = await open(path.join(folder, name));
    results.push(result);
    if (name.startsWith('xss')) {
      // The script-bearing names must show as plain text: no element other than the page's own.
      xss = await js(`({ names: [...document.querySelectorAll('#series .name')].map((e) => e.textContent), titles: [...document.querySelectorAll('#series .tile')].map((e) => e.title), foreign: [...document.querySelectorAll('#series *')].map((e) => e.tagName.toLowerCase()).filter((t) => !['li', 'div', 'canvas', 'span'].includes(t)) })`);
    }
    if (result.outcome !== 'opened' || name.startsWith('xss') || name.endsWith('.zip')) console.log(JSON.stringify(result));
  }
  xss = { ...xss, alerts: await js('window.__alerts') };
  const after = await open(good);
  const counts = {};
  for (const { file, outcome } of results) {
    const group = file.replace(/-\d+\.dcm$/, '').replace(/\.(dcm|zip)$/, '');
    counts[group] ??= {};
    counts[group][outcome] = (counts[group][outcome] ?? 0) + 1;
  }
  console.log(JSON.stringify({ counts }));
  console.log(JSON.stringify({ xss, goodFileAfterwards: after.outcome, goodSeries: after.series }));
  devtools.detach();
  app.quit();
});
