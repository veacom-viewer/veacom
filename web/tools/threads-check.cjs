// Compares the single-thread and threads builds on the measurement page (http://127.0.0.1:5199/, `node web/serve.mjs`):
// for each thread count and study, files from disk are opened twice, and the time to list, to the first image and to
// the whole first series is recorded with the CPU time the page's process spent (all its threads together) and its
// memory. Runs in a hidden Electron window: never on screen, never focused.
//
//   <electron.exe> web/tools/threads-check.cjs [thread counts, e.g. 1,4]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

process.on('unhandledRejection', (error) => { console.error(error); app.exit(1); });
// The synthetic test studies (see web/README.md).
const testdata = process.env.VEACOM_TESTDATA;
if (!testdata) throw new Error('Set VEACOM_TESTDATA to the folder that holds the test studies.');
const studies = ['bigct_j2k', 'bigct_jpegll', 'bigct', 'tcia/FDG-PET-CT-Lesions/PETCT_8fea5f0537'];
const counts = (process.argv.at(-1).match(/^[\d,]+$/) ? process.argv.at(-1) : '1,4').split(',').map(Number);
const ROUNDS = 2;

function walk(folder, prefix, out) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(path.join(folder, entry.name), relative, out);
    else if (entry.isFile()) out.push([path.join(folder, entry.name), relative]);
  }
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, x: -4000, y: -4000, width: 1200, height: 800, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code);
  const metrics = () => {
    const pid = win.webContents.getOSProcessId();
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    return { cpu: metric?.cpu.cumulativeCPUUsage ?? NaN, memoryMB: Math.round((metric?.memory.workingSetSize ?? 0) / 1024), peakMB: Math.round((metric?.memory.peakWorkingSetSize ?? 0) / 1024) };
  };
  for (const count of counts) {
    await win.loadURL(`http://127.0.0.1:5199/?threads=${count}`);
    await js('new Promise((r) => setTimeout(r, 500))');
    const devtools = win.webContents.debugger;
    devtools.attach('1.3');
    for (const study of studies) {
      const base = path.join(testdata, study);
      const name = path.basename(base);
      const files = walk(base, name, []);
      for (let round = 1; round <= ROUNDS; round++) {
        const before = await js(`window.__prefetch = true; window.__relpaths = ${JSON.stringify(files.map(([, r]) => r))}; window.__roots = ${JSON.stringify([name])}; window.__runs.length`);
        const { root } = await devtools.sendCommand('DOM.getDocument');
        const { nodeId } = await devtools.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#pick-files' });
        const start = metrics();
        await devtools.sendCommand('DOM.setFileInputFiles', { nodeId, files: files.map(([absolute]) => absolute) });
        const run = await js(`new Promise((resolve) => { const end = Date.now() + 120000; const wait = () => window.__runs.length > ${before} ? resolve(window.__runs.at(-1)) : Date.now() > end ? resolve({ error: 'timeout' }) : setTimeout(wait, 50); wait(); })`);
        const end = metrics();
        const line = {
          threads: run.threads, asked: count, study: name, round, error: run.error ?? null,
          listed: Math.round(run.listedPage), frame: Math.round(run.framePage), volume: Math.round(run.volume),
          cpuSeconds: +(end.cpu - start.cpu).toFixed(2), memoryMB: end.memoryMB, peakMB: end.peakMB, wasmMB: Math.round((run.memory ?? 0) / 1048576),
        };
        fs.appendFileSync(process.env.THREADS_OUT ?? 'threads-check.jsonl', `${JSON.stringify(line)}\n`);
      }
    }
    devtools.detach();
  }
  app.quit();
});
