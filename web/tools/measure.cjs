// Times the prototype with real files from disk, as a user's drop or file choice gives them.
// The page is opened in a hidden Electron window (never on screen, never focused; the page itself
// carries a red "TEST PENCERESİ" banner). Files are set on its file input through the DevTools
// protocol, which gives the page disk-backed File objects. All rounds run in the same window.
//
//   node web/serve.mjs                      (in another terminal)
//   <electron.exe> web/tools/measure.cjs [rounds]
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// The synthetic test studies (see web/README.md).
const testdata = process.env.VEACOM_TESTDATA;
if (!testdata) throw new Error('Set VEACOM_TESTDATA to the folder that holds the test studies.');
const studies = [
  'tcia/FDG-PET-CT-Lesions/PETCT_8fea5f0537',
  'bigct',
  'demo/Calisma.zip',
  'bigct_j2k',
  'bigct_jpegll',
];
// MEASURE_ONLY=Calisma.zip (any part of a path) times just the matching studies.
const only = process.env.MEASURE_ONLY;
const rounds = Number(process.argv.at(-1)) || 3;

function walk(folder, prefix, out) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(path.join(folder, entry.name), relative, out);
    else if (entry.isFile()) out.push([path.join(folder, entry.name), relative]);
  }
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    x: -4000,
    y: -4000,
    width: 1200,
    height: 800,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { backgroundThrottling: false },
  });
  await win.loadURL('http://127.0.0.1:5199/');
  await win.webContents.executeJavaScript('new Promise((r) => setTimeout(r, 500))');
  const devtools = win.webContents.debugger;
  devtools.attach('1.3');
  const results = [];
  for (const study of studies.filter((study) => !only || study.includes(only))) {
    const base = path.join(testdata, study);
    const name = path.basename(base);
    const files = study.endsWith('.zip') ? [[base, name]] : walk(base, name, []);
    // Plain: the engine reads each file through FileReaderSync. Prefetch: the Worker first reads every
    // file's first 64 KiB in parallel. Rounds alternate, so both see the same conditions.
    for (let round = 1; round <= rounds * 2; round++) {
      const prefetch = round % 2 === 0;
      const before = await win.webContents.executeJavaScript(
        `window.__prefetch = ${prefetch}; window.__relpaths = ${JSON.stringify(files.map(([, r]) => r))}; window.__roots = ${JSON.stringify([name])}; window.__runs.length`,
      );
      const { root } = await devtools.sendCommand('DOM.getDocument');
      const { nodeId } = await devtools.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#pick-files' });
      await devtools.sendCommand('DOM.setFileInputFiles', { nodeId, files: files.map(([absolute]) => absolute) });
      const run = await win.webContents.executeJavaScript(
        `new Promise((resolve) => { const wait = () => window.__runs.length > ${before} ? resolve(window.__runs.at(-1)) : setTimeout(wait, 100); wait(); })`,
      );
      const round1 = (value) => (value == null ? null : Math.round(value));
      const line = {
        study: name,
        mode: prefetch ? 'prefetch' : 'plain',
        round: Math.ceil(round / 2),
        error: run.error,
        files: run.files,
        series: run.series?.length,
        first: run.series?.[0],
        listed: round1(run.listed),
        listedPage: round1(run.listedPage),
        prefetched: round1(run.prefetched),
        frame: round1(run.frame),
        framePage: round1(run.framePage),
        thumbsPage: round1(run.thumbsPage),
        volume: round1(run.volume),
        reads: run.listReads,
        readMB: round1(run.listBytes / 1048576),
        readMs: round1(run.listReadMs),
        extractedMB: round1(run.extracted / 1048576),
        memoryMB: round1(run.memory / 1048576),
      };
      results.push(line);
      console.log(JSON.stringify(line));
    }
  }
  devtools.detach();
  app.quit();
});
