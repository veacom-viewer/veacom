// PNG, JPEG and BMP pictures open through the app's own picture decoder: a sandboxed renderer of its own, not the
// engine (electron/picture-decoder.cjs, native/src/pictures.rs). Writes synthetic pictures, opens them in the desktop
// app and checks the series, their samples, the decoder's sandbox, the size limits, and that a DICOM study with pictures
// beside it never starts the decoder.
//
//   node tools/check-pictures.cjs <a DICOM series folder, such as ct-small/S01> <output folder>
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { encodePng } = require('./lib/png.cjs');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const { EngineProcess } = require('../electron/engine-process.cjs');

const png = (width, height, rgb) => {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let pixel = 0; pixel < width * height; pixel++) rgb.copy(data, pixel * 4, pixel * 3, pixel * 3 + 3);
  return encodePng({ width, height, data });
};
// 24-bit BMP: rows bottom up, blue green red, each padded to four bytes.
const bmp = (width, height, rgb) => {
  const row = Math.ceil(width * 3 / 4) * 4, bytes = Buffer.alloc(54 + row * height);
  bytes.write('BM', 0, 'latin1'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (y * width + x) * 3, to = 54 + (height - 1 - y) * row + x * 3;
    bytes[to] = rgb[from + 2]; bytes[to + 1] = rgb[from + 1]; bytes[to + 2] = rgb[from];
  }
  return bytes;
};
// EXIF with 144 dpi print density, matching display dimensions and an orientation.
function withExif(jpeg, orientation, width, height, little = false) {
  const u16 = value => { const bytes = Buffer.alloc(2); bytes[little ? 'writeUInt16LE' : 'writeUInt16BE'](value); return bytes; };
  const u32 = value => { const bytes = Buffer.alloc(4); bytes[little ? 'writeUInt32LE' : 'writeUInt32BE'](value); return bytes; };
  const entry = (tag, type, value) => Buffer.concat([u16(tag), u16(type), u32(1),
    type === 3 ? Buffer.concat([u16(value), u16(0)]) : u32(value)]);
  const rational = 8 + 2 + 5 * 12 + 4;
  const exif = Buffer.concat([Buffer.from(little ? 'Exif\0\0II' : 'Exif\0\0MM', 'latin1'), u16(42), u32(8), u16(5),
    entry(0x0112, 3, orientation), entry(0x011a, 5, rational), entry(0x011b, 5, rational),
    entry(0x0128, 3, 2), entry(0x8769, 4, rational + 8), u32(0), u32(144), u32(1),
    u16(2), entry(0xa002, 4, width / 2), entry(0xa003, 4, height / 2), u32(0)]);
  const marker = Buffer.from([0xff, 0xe1, 0, 0]);
  marker.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
}
const solid = (width, height, colour) => Buffer.alloc(width * height * 3, Buffer.from(colour));
const halves = (width, height, left, right) => Buffer.from(Array.from({ length: width * height }, (_, pixel) => pixel % width < width / 2 ? left : right).flat());
const distance = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));

async function checkCancelledImport(temporary, dicom) {
  const binary = process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core';
  const engine = new EngineProcess({ binary: process.env.VEACOM_CORE_PATH || path.resolve(__dirname, '../native/target/release', binary) });
  try {
    const connection = await engine.start();
    const call = (op, body) => connection.request(op, body, { signal: AbortSignal.timeout(10_000) });
    const picture = path.join(temporary, 'cancel.png');
    await fs.writeFile(picture, png(1, 1, Buffer.from([1, 2, 3])));
    await fs.truncate(picture, 1024 * 1024);
    const pending = call('import', { paths: [picture] });
    const task = await call('pictureNext');
    assert.equal(task.status, 200);
    assert.equal(task.headers.get('X-Picture-Want'), 'probe');
    assert.equal((await task.arrayBuffer()).byteLength, 64 * 1024);
    const progress = await (await call('progress')).json();
    assert.deepEqual([progress.running, progress.completed, progress.total], [true, 0, 1]);
    const cancelled = await call('cancel', { id: progress.id });
    assert.equal((await cancelled.json()).requested, true);
    const next = call('import', { paths: [dicom] });
    assert.equal((await (await pending).json()).note.code, 'job.cancelled');
    assert.ok((await (await next).json()).series.length);
    const late = await call('pictureAnswer', { id: task.headers.get('X-Picture-Id'), width: 1, height: 1 });
    assert.equal(late.status, 404);
  } finally { await engine.stop(); }
}

async function main() {
  const dicom = path.resolve(process.argv[2]), output = path.resolve(process.argv[3] || 'test-results/pictures');
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-pictures-'));
  const checks = [], errors = [], timings = {};
  const check = (name, detail) => { checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); };
  const desktop = await electron.launch({ args: [path.resolve(__dirname, '..')], chromiumSandbox: true,
    env: { ...process.env, VEACOM_USER_DATA: path.join(temporary, 'profile'), VEACOM_TEST_MODE: '1' }, timeout: 90_000 });
  let page;
  try {
    page = await desktop.firstWindow();
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.__VEACOM_TEST__ && document.querySelector('[data-testid="veacom-app"]')?.getAttribute('data-ready') === 'true', undefined, { timeout: 60_000 });
    const decoderProcesses = () => desktop.evaluate(({ app }) => app.__VEACOM_PRIVILEGED_TEST__.pictureDecoderProcesses());
    const catalog = async () => (await privileged.readCatalog(desktop)).catalog.series;
    const samples = async (id, index = 0) => {
      const result = await page.evaluate(async ({ id, index }) => {
        const { generation } = await window.veacom.getCoreState();
        const { url } = await window.veacom.getPixels({ seriesId: id, generation, index });
        const response = await fetch(url);
        return { status: response.status, type: response.headers.get('X-Pixel-Type'), bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, { id, index });
      return { ...result, bytes: Buffer.from(result.bytes) };
    };

    // A study on a disc often has a viewer's own icons beside it: they are not series, and they are never decoded.
    const disc = path.join(temporary, 'Disc');
    await fs.cp(dicom, path.join(disc, 'DICOM'), { recursive: true });
    await fs.mkdir(path.join(disc, 'viewer'));
    await fs.writeFile(path.join(disc, 'viewer', 'icon.png'), png(16, 16, solid(16, 16, [10, 20, 30])));
    await privileged.importPaths(desktop, page, [disc]);
    const discSeries = await catalog();
    assert.ok(discSeries.length >= 1 && discSeries.every(series => series.modality !== 'OT'), JSON.stringify(discSeries.map(series => series.modality)));
    assert.deepEqual(await decoderProcesses(), [], 'A DICOM import must not start the picture decoder.');
    check('Pictures beside DICOM are not series, and the picture decoder never starts for them', discSeries.map(series => series.description));

    // Pictures alone: a stack of PNG slices in natural order, a BMP, a JPEG, and a JPEG turned by its EXIF orientation.
    const folder = path.join(temporary, 'Ayse Demir');
    const slice = index => Buffer.from(Array.from({ length: 4 * 2 * 3 }, (_, sample) => (sample * 17 + index * 50) % 256));
    const rgb = Buffer.from([255, 0, 20, 0, 200, 255, 10, 20, 30, 128, 128, 128, 1, 2, 3, 250, 251, 252, 90, 0, 0, 0, 90, 0]);
    await fs.mkdir(path.join(folder, 'PNG'), { recursive: true });
    for (const index of [1, 2, 10]) await fs.writeFile(path.join(folder, 'PNG', `kesit${index}.png`), png(4, 2, slice(index)));
    await fs.mkdir(path.join(folder, 'BMP'));
    await fs.writeFile(path.join(folder, 'BMP', 'scan.bmp'), bmp(4, 2, rgb));
    const jpeg = async (width, height, pixels, quality = 100) => Buffer.from(await desktop.evaluate(({ nativeImage }, [encoded, quality]) =>
      [...nativeImage.createFromBuffer(Buffer.from(encoded, 'base64')).toJPEG(quality)], [png(width, height, pixels).toString('base64'), quality]));
    await fs.mkdir(path.join(folder, 'JPEG'));
    await fs.writeFile(path.join(folder, 'JPEG', 'photo.jpg'), withExif(await jpeg(16, 16, solid(16, 16, [200, 100, 50])), 1, 16, 16));
    await fs.mkdir(path.join(folder, 'EXIF'));
    const photoBytes = withExif(await jpeg(32, 16, halves(32, 16, [220, 20, 20], [20, 20, 220])), 6, 32, 16, true);
    // Two APP2 segments put both EXIF and the frame header beyond the first 64 KiB.
    const app2 = Buffer.alloc(40_004);
    app2.writeUInt16BE(0xffe2); app2.writeUInt16BE(app2.length - 2, 2);
    await fs.writeFile(path.join(folder, 'EXIF', 'turned.jpg'), Buffer.concat([photoBytes.subarray(0, 2), app2, app2, photoBytes.subarray(2)]));
    await fs.mkdir(path.join(folder, 'PNG16'));
    // One opaque RGB pixel with 16-bit samples 0x00ff, 0x80f0, 0x7f00.
    await fs.writeFile(path.join(folder, 'PNG16', 'pixel.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABEAIAAADA54+dAAAAD0lEQVR4nGNg+N/woZ4BAArQAu9ac1smAAAAAElFTkSuQmCC', 'base64'));
    let started = performance.now();
    await privileged.importPaths(desktop, page, [folder]);
    timings.importMs = performance.now() - started;
    const pictures = (await catalog()).filter(series => series.modality === 'OT');
    const named = Object.fromEntries(pictures.map(series => [series.description, series]));
    assert.deepEqual(Object.keys(named).sort(), ['BMP', 'EXIF', 'JPEG', 'PNG', 'PNG16']);
    assert.ok(pictures.every(series => series.patientName === 'Ayse Demir'), 'The opened folder names the patient.');
    assert.deepEqual(named.PNG.dimensions, [4, 2, 3]);
    assert.deepEqual(named.JPEG.dimensions, [16, 16, 1], 'Print density does not resize the raster.');
    assert.deepEqual(named.EXIF.dimensions, [16, 32, 1], 'The EXIF orientation turns the photo a quarter turn.');
    check('Pictures open as the folder\'s patient, a series per folder', pictures.map(series => `${series.description} ${series.dimensions.join('×')}`));

    for (const [index, number] of [1, 2, 10].entries()) {
      const frame = await samples(named.PNG.id, index);
      assert.equal(frame.type, 'uint8');
      assert.deepEqual([...frame.bytes], [...slice(number)], `PNG slice ${number} as the file holds it`);
    }
    assert.deepEqual([...(await samples(named.BMP.id)).bytes], [...rgb]);
    assert.deepEqual([...(await samples(named.PNG16.id)).bytes], [0, 128, 127]);
    const photo = (await samples(named.JPEG.id)).bytes;
    assert.ok(distance([...photo.subarray(0, 3)], [200, 100, 50]) <= 3, `JPEG colour ${[...photo.subarray(0, 3)]}`);
    const turned = (await samples(named.EXIF.id)).bytes, at = (x, y) => [...turned.subarray((y * 16 + x) * 3, (y * 16 + x) * 3 + 3)];
    assert.ok(distance(at(8, 4), [220, 20, 20]) <= 12 && distance(at(8, 28), [20, 20, 220]) <= 12, `turned JPEG ${at(8, 4)} / ${at(8, 28)}`);
    check('8-bit PNG and BMP samples, 16-bit PNG rounding, JPEG colour and EXIF orientation');

    started = performance.now();
    await page.evaluate(id => window.__VEACOM_TEST__.selectSeries(id), named.PNG.id);
    await page.waitForFunction(id => { const state = window.__VEACOM_TEST__.state(); return state.activeSeriesId === id && state.fullVolumeLoaded; }, named.PNG.id, { timeout: 30_000 });
    timings.openMs = performance.now() - started;
    await page.screenshot({ path: path.join(output, 'pictures.png') });
    check('The viewer opens a picture series', await page.evaluate(() => window.__VEACOM_TEST__.state().dimensions));

    const pids = await decoderProcesses();
    const metrics = await desktop.evaluate(({ app, BrowserWindow }, pids) => ({ processes: app.getAppMetrics().filter(metric => pids.includes(metric.pid)),
      page: app.getAppMetrics().find(metric => metric.pid === BrowserWindow.getAllWindows()[0].webContents.getOSProcessId())?.pid, windows: BrowserWindow.getAllWindows().length }), pids);
    assert.ok(pids.length >= 1 && metrics.processes.length === pids.length, 'The picture decoder runs in processes of its own.');
    assert.ok(!pids.includes(metrics.page), 'The picture decoder does not share the application page\'s process.');
    // app.getAppMetrics() reports `sandboxed` on macOS and Windows only; on Linux a sandboxed renderer runs under a
    // seccomp-bpf filter, which /proc shows as mode 2.
    const sandboxed = async metric => process.platform === 'linux'
      ? /^Seccomp:\s+2$/m.test(await fs.readFile(`/proc/${metric.pid}/status`, 'utf8'))
      : metric.sandboxed === true;
    for (const metric of metrics.processes) {
      assert.equal(metric.type, 'Tab');
      assert.ok(await sandboxed(metric), `The picture decoder's renderer ${metric.pid} is sandboxed.`);
    }
    assert.equal(metrics.windows, 1, 'The picture decoder has no window.');
    check('Pictures are decoded in sandboxed renderers of their own, without a window', metrics.processes.map(({ pid, type }) => ({ pid, type })));

    // The limits: wider than 32768 pixels is refused while the import reads it; more than the frame's 64 million
    // samples is listed, but its samples are never decoded for the engine; anything but PNG, JPEG or BMP is refused unread.
    const limits = path.join(temporary, 'Limits');
    await fs.mkdir(limits);
    await fs.writeFile(path.join(limits, 'wide.png'), png(32769, 1, solid(32769, 1, [1, 1, 1])));
    await fs.writeFile(path.join(limits, 'large.png'), png(5000, 5000, solid(5000, 5000, [9, 9, 9])));
    const largeJpeg = Buffer.from(await desktop.evaluate(({ nativeImage }) =>
      nativeImage.createFromBitmap(Buffer.alloc(5000 * 5000 * 4, 255), { width: 5000, height: 5000 }).toJPEG(75).toString('base64')), 'base64');
    await fs.writeFile(path.join(limits, 'dense.jpg'), withExif(largeJpeg, 1, 5000, 5000));
    await fs.writeFile(path.join(limits, 'notes.png'), 'Not a picture at all');
    await fs.writeFile(path.join(limits, 'animation.png'), Buffer.from('GIF89a\x01\0\x01\0\0\0\0;', 'latin1'));
    const capabilities = await privileged.authorizeImportPaths(desktop, [limits]);
    const imported = await page.evaluate(paths => window.veacom.importSelected(paths), capabilities);
    const warnings = imported.warnings.join('\n');
    assert.match(warnings, /wide\.png: Invalid or excessive image dimensions/);
    assert.match(warnings, /notes\.png: Only PNG, JPEG and BMP images can be opened/);
    assert.match(warnings, /animation\.png: Only PNG, JPEG and BMP images can be opened/);
    assert.deepEqual(imported.series.map(series => series.dimensions), [[5000, 5000, 2]]);
    const refused = await samples(imported.series[0].id);
    assert.equal(refused.status, 422);
    assert.match(refused.bytes.toString(), /64 million sample limit/);
    check('The picture size limits hold: 32768 pixels a side, 64 million samples a frame, and only PNG, JPEG and BMP', imported.warnings);

    // The RGBA answer alone exceeds one 16 MiB pipe request.
    const width = 2049, height = 2048, largePath = path.join(temporary, 'multipart.png');
    const colour = [13, 78, 211];
    await fs.writeFile(largePath, encodePng({ width, height, data: Buffer.alloc(width * height * 4, Buffer.from([...colour, 255])) }));
    const largeImport = await privileged.coreRequest(desktop, 'import', { paths: [largePath] });
    assert.equal(largeImport.status, 200);
    const frame = await privileged.coreRequest(desktop, 'frame', { id: largeImport.json.series[0].id, index: 0 });
    assert.equal(frame.status, 200);
    assert.equal(frame.byteLength, width * height * 3);
    assert.equal(frame.sha256, createHash('sha256').update(solid(width, height, colour)).digest('hex'));
    check('A picture larger than one pipe request returns every RGB sample');

    await checkCancelledImport(temporary, dicom);
    check('A pending header stays incomplete and cancellation releases the import queue before the decoder answers');

    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'pictures.json'), JSON.stringify({ passed: true, checks, timings }, null, 2));
    console.log(JSON.stringify(timings));
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'pictures.json'), JSON.stringify({ passed: false, error: error.stack, checks, errors }, null, 2));
    throw error;
  } finally {
    await closeDesktop(desktop);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
