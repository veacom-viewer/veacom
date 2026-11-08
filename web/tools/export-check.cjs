// Exports from the browser build as a user would, and checks what arrives in the downloads. Drops a study from disk on
// http://127.0.0.1:5200/ (`node web/serve.mjs 5200 dist`, or VEACOM_URL), then runs two exports through the export dialog: plain
// DICOM, and media (DICOMDIR) with partial anonymization. For each it records which of the dialog's desktop-only
// controls are showing, catches the download and lists the ZIP's contents, and checks that the anonymized files no
// longer hold the patient's name. Runs in a hidden Electron window: never on screen, never focused.
//
//   <electron.exe> web/tools/export-check.cjs <study folder or file> <patient name to look for> <download folder>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [target, patientName, output] = process.argv.slice(-3);
process.on('unhandledRejection', (error) => { console.error(error); app.exit(1); });
// Pictures and video capture the pane as it is drawn, and Chromium barely draws a hidden or off-screen window: the
// window is shown (off-screen, never focused) with that throttling off.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

/** The entries of a ZIP stored without compression: name and bytes. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22, entries = [];
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true), size = view.getUint32(local + 18, true);
    entries.push({ name, bytes: bytes.subarray(start, start + size) });
    at += 46 + nameLength;
  }
  return entries;
}

app.whenReady().then(async () => {
  fs.mkdirSync(output, { recursive: true });
  const win = new BrowserWindow({ show: false, x: -4000, y: -4000, width: 1500, height: 950, focusable: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } });
  const downloads = [];
  win.webContents.session.on('will-download', (event, item) => {
    const file = path.join(output, item.getFilename());
    item.setSavePath(file);
    downloads.push(new Promise((resolve) => item.once('done', (_, state) => resolve({ file, state }))));
  });
  await win.loadURL(process.env.VEACOM_URL ?? 'http://127.0.0.1:5200/');
  win.showInactive();
  win.setPosition(-4000, -4000);
  const js = (code) => win.webContents.executeJavaScript(code);
  // Should the window ever come into view, it says what it is.
  await js(`(() => { const banner = document.createElement('div'); banner.textContent = 'TEST PENCERESİ'; banner.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#c0141c;color:#fff;font:700 13px system-ui;text-align:center;padding:2px;pointer-events:none'; document.body.append(banner); })()`);
  const until = (condition, ms = 120000) => js(`new Promise((resolve) => { const end = Date.now() + ${ms}; const wait = () => { let ok = false; try { ok = Boolean(${condition}); } catch {} if (ok || Date.now() > end) resolve(ok); else setTimeout(wait, 100); }; wait(); })`);
  await until(`/Hazır|Ready/.test(document.body.innerText)`);
  const devtools = win.webContents.debugger;
  devtools.attach('1.3');
  const data = { items: [], files: [target], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await devtools.sendCommand('Input.dispatchDragEvent', { type, x: 700, y: 450, data });
  await until(`/[1-9]\\d* (seri|series)/.test(document.querySelector('footer')?.innerText ?? '') && !/yükleniyor|okunuyor|loading/i.test(document.body.innerText)`);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const runs = [
    { name: 'dicom', kind: 'dicom', anonymity: 'none' },
    { name: 'media-anonymized', kind: 'media', anonymity: 'partial' },
    // Pictures and video capture the pane as drawn, slice by slice.
    { name: 'pictures', kind: 'images', anonymity: 'none' },
    { name: 'video', kind: 'video', anonymity: 'none' },
  ];
  const results = [];
  for (const run of runs) {
    const before = downloads.length;
    await js(`document.querySelector('[data-testid=tool-export]').click()`);
    await until(`document.querySelector('[data-testid=export-submit]')`, 10000);
    await js(`document.querySelector('[data-action=export-kind][data-kind=${run.kind}]').click()`);
    await until(`document.querySelector('[data-action=export-kind][data-kind=${run.kind}]')?.getAttribute('aria-checked') === 'true'`, 5000);
    await js(`(document.querySelector('[data-action=export-anonymity][value=${run.anonymity}]') || {}).click?.()`);
    const shown = await js(`({
      folder: Boolean(document.querySelector('[data-action=export-folder-change]')),
      openAfter: Boolean(document.querySelector('[data-action=export-open-after]')),
      zip: Boolean(document.querySelector('[data-action=export-zip]')),
      targets: [...document.querySelectorAll('[data-action=export-target]')].map((input) => input.value),
    })`);
    await js(`document.querySelector('[data-testid=export-submit]').click()`);
    const started = Date.now();
    while (downloads.length === before && Date.now() - started < 300000) await new Promise((resolve) => setTimeout(resolve, 100));
    const download = downloads.length > before ? await downloads.at(-1) : null;
    const notice = await js(`[...document.querySelectorAll('[role=alert], [role=status]')].map((e) => e.innerText).filter(Boolean).join(' | ').slice(0, 300)`);
    let zip = null;
    if (download?.state === 'completed' && download.file.endsWith('.mp4')) {
      const bytes = fs.readFileSync(download.file);
      zip = { file: path.basename(download.file), bytes: bytes.length, mp4: bytes.subarray(4, 8).toString('latin1') === 'ftyp' && bytes.includes(Buffer.from('avcC')) };
    } else if (download?.state === 'completed') {
      const entries = readZip(fs.readFileSync(download.file));
      const needle = Buffer.from(patientName, 'latin1');
      zip = {
        file: path.basename(download.file),
        entries: entries.length,
        dicomdir: entries.some((entry) => entry.name.endsWith('/DICOMDIR')),
        first: entries.slice(0, 2).map((entry) => `${entry.name} (${entry.bytes.length})`),
        filesWithPatientName: entries.filter((entry) => Buffer.from(entry.bytes).includes(needle)).length,
      };
    }
    results.push({ run: run.name, seconds: (Date.now() - started) / 1000, shown, download: download?.state ?? 'none', zip, notice });
    console.log(JSON.stringify(results.at(-1)));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  devtools.detach();
  app.quit();
});
