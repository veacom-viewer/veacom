// Exports a synthetic stack through the real video path: src/export-video.ts on the browser's H.264 encoder,
// the app's preload, and its MP4 writer. A <video> element then decodes the file and each sampled slice is
// compared with what was drawn. It needs no study. --no-gpu turns hardware acceleration off, as on a
// computer without a graphics driver.
//   node tools/check-video-encoder.cjs <output-directory> [--no-gpu]
const fs = require('node:fs');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow, ipcMain } = require('electron');
const { stripTypeScriptTypes } = require('node:module');
const { registerMediaHandlers } = require('../electron/media.cjs');

const directory = process.argv.find((value, index) => index >= 2 && !value.startsWith('--'));
if (!directory) { console.error('Usage: node tools/check-video-encoder.cjs <output-directory> [--no-gpu]'); process.exit(2); }
const output = path.resolve(directory);
const noGpu = process.argv.includes('--no-gpu');
if (noGpu) app.disableHardwareAcceleration();
app.dock?.hide();

// Key frames fall every two seconds, so this exports several of them.
const WIDTH = 641, HEIGHT = 481, SLICES = 30, FPS = 5;
const GRAYS = [0, 36, 73, 109, 146, 182, 219, 255];
const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];

// Runs in the page. Slice k lights block k of the marker row, so a frame out of order shows up.
async function exportAndDecode({ javascript, width, height, slices, fps, grays, colors }) {
  const url = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }));
  const { exportViewportVideo } = await new Function('url', 'return import(url)')(url);
  URL.revokeObjectURL(url);
  document.body.style.margin = '0';
  document.body.innerHTML = `<div id="viewport" style="position:relative;width:${width}px;height:${height}px;background:black">
    <canvas width="${width}" height="${height}" style="position:absolute;inset:0"></canvas>
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="position:absolute;inset:0"><line x1="600" y1="20" x2="630" y2="20" stroke="yellow" stroke-width="4"/></svg></div>`;
  const viewport = document.getElementById('viewport');
  const canvas = viewport.querySelector('canvas'), overlay = viewport.querySelector('svg');
  const context = canvas.getContext('2d');
  const setSlice = slice => {
    canvas.dataset.slice = String(slice); overlay.dataset.slice = String(slice);
    context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
    grays.forEach((gray, index) => { context.fillStyle = `rgb(${gray},${gray},${gray})`; context.fillRect(10 + index * 70, 40, 70, 80); });
    colors.forEach(([r, g, b], index) => { context.fillStyle = `rgb(${r},${g},${b})`; context.fillRect(10 + index * 100, 140, 100, 80); });
    context.fillStyle = '#fff'; context.fillRect(10 + slice * 20, 260, 20, 60);
    let seed = slice * 2654435761 >>> 0;
    const noise = context.createImageData(width, 130);
    for (let index = 0; index < noise.data.length; index += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const value = 90 + (seed >>> 26);
      noise.data[index] = noise.data[index + 1] = noise.data[index + 2] = value; noise.data[index + 3] = 255;
    }
    context.putImageData(noise, 0, 340);
  };
  const started = performance.now();
  const destination = await exportViewportVideo({ viewport, setSlice, originalSlice: 0, frameCount: slices, fps, suggestedName: 'check' });
  const milliseconds = Math.round(performance.now() - started);
  const bytes = await window.__readFile(destination);
  const video = document.createElement('video');
  video.muted = true; video.preload = 'auto';
  video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error(`The video element rejected the file: ${video.error?.message}`)); });
  const reading = document.createElement('canvas');
  reading.width = video.videoWidth; reading.height = video.videoHeight;
  const reader = reading.getContext('2d', { willReadFrequently: true });
  const pixel = (x, y) => [...reader.getImageData(x, y, 1, 1).data].slice(0, 3);
  const frames = [];
  for (const slice of [0, 7, 15, slices - 1]) {
    video.currentTime = (slice + 0.5) / fps;
    await new Promise(resolve => { video.onseeked = resolve; });
    reader.drawImage(video, 0, 0);
    frames.push({ slice, grays: grays.map((_, index) => pixel(45 + index * 70, 80)), colors: colors.map((_, index) => pixel(60 + index * 100, 180)),
      marker: Array.from({ length: slices }, (_, index) => pixel(20 + index * 20, 290)[0]), overlay: pixel(615, 20), padding: pixel(width, 100) });
  }
  return { destination, milliseconds, size: [video.videoWidth, video.videoHeight], duration: video.duration, frames };
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const destination = path.join(output, noGpu ? 'video-no-gpu.mp4' : 'video.mp4');
  fs.rmSync(destination, { force: true });
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  registerMediaHandlers({ handle: (channel, handler) => ipcMain.handle(channel, (_event, ...args) => handler(...args)), getWindow: () => window,
    exportDicomDirectory: async () => { throw new Error('Not used.'); }, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) } });
  // The app never becomes the active one (no Dock icon, and the window shows inactive), but a click from the computer
  // would give the window the keyboard. As in tools/lib/outside-input.cjs, not on Windows.
  if (process.platform !== 'win32') { window.setFocusable(false); window.setIgnoreMouseEvents(true); }
  fs.writeFileSync(path.join(output, 'blank.html'), '<!doctype html><meta charset="utf-8"><title>Video check</title>');
  await window.loadFile(path.join(output, 'blank.html'));
  window.showInactive();
  const javascript = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '..', 'src', 'export-video.ts'), 'utf8'));
  const argument = { javascript, width: WIDTH, height: HEIGHT, slices: SLICES, fps: FPS, grays: GRAYS, colors: COLORS };
  // A file page can read the file it wrote; the app itself never reads an export back.
  await window.webContents.executeJavaScript(`window.__readFile = path => fetch(${JSON.stringify(require('node:url').pathToFileURL(destination).href)}).then(response => response.arrayBuffer()); 0;`);
  const result = await window.webContents.executeJavaScript(`(${exportAndDecode})(${JSON.stringify(argument)})`, true);

  const failures = [];
  const near = (actual, expected, tolerance, name) => {
    if (actual.some((value, index) => Math.abs(value - expected[index]) > tolerance)) failures.push(`${name}: expected ${expected}, got ${actual}`);
  };
  if (String(result.size) !== '642,482') failures.push(`The frame should be padded to 642x482, got ${result.size}.`);
  if (Math.abs(result.duration - SLICES / FPS) > 0.1) failures.push(`The duration should be ${SLICES / FPS} s, got ${result.duration}.`);
  for (const frame of result.frames) {
    GRAYS.forEach((gray, index) => near(frame.grays[index], [gray, gray, gray], 6, `slice ${frame.slice} gray ${gray}`));
    COLORS.forEach((color, index) => near(frame.colors[index], color, 24, `slice ${frame.slice} colour ${color}`));
    near(frame.overlay, [255, 255, 0], 60, `slice ${frame.slice} overlay`);
    near(frame.padding, [0, 0, 0], 12, `slice ${frame.slice} padding`);
    frame.marker.forEach((value, index) => {
      if (index === frame.slice ? value < 200 : value > 60) failures.push(`slice ${frame.slice} marker ${index} reads ${value}: wrong frame.`);
    });
  }
  const file = fs.readFileSync(destination);
  const config = file.indexOf('avcC');
  // Which samples are key frames (stss): the entry count follows the box name, version and flags.
  const keyFrames = file.readUInt32BE(file.indexOf('stss') + 8);
  if (keyFrames < 3) failures.push(`The video should have a key frame every ${2 * FPS} frames, got ${keyFrames} in ${SLICES}.`);
  const summary = { keyFrames, encoderProfile: file[config + 5], level: file[config + 7], bytes: file.length, milliseconds: result.milliseconds,
    noGpu, size: result.size, duration: result.duration, failures };
  fs.writeFileSync(path.join(output, noGpu ? 'video-no-gpu.json' : 'video.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  if (failures.length) throw new Error(failures.slice(0, 12).join('\n'));
  console.log(`PASS video export${noGpu ? ' without GPU' : ''}`);
}

const deadline = setTimeout(() => { console.error('FAIL: the video check timed out.'); app.exit(2); }, 180000);
app.whenReady().then(main).then(() => { clearTimeout(deadline); app.exit(0); }, error => { console.error(`FAIL ${error.stack ?? error}`); app.exit(1); });
