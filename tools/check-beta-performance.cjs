// Compare two production desktop builds on one host. Run with BASE_APP and HEAD_APP pointing at source checkouts
// containing dist/ and their own release engines, and an output directory as the first argument.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { authorizeImportPaths } = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const { temporaryExportFolder } = require('./lib/export-folder.cjs');
const { prepareCounter, readCounts } = require('./lib/io-count.cjs');
const { compareRounds, median } = require('./lib/open-speed.cjs');
const { decodePng, encodePng } = require('./lib/png.cjs');

const [directory, repetitions = '7'] = process.argv.slice(2);
assert(directory && process.env.BASE_APP && process.env.HEAD_APP, 'Pass output directory and set BASE_APP and HEAD_APP');
const rounds = Number(repetitions);
assert(Number.isInteger(rounds) && rounds >= 5);
const output = path.resolve(directory), studies = path.join(output, 'studies');
const roots = { base: path.resolve(process.env.BASE_APP), head: path.resolve(process.env.HEAD_APP) };
const binary = root => path.join(root, 'native/target/release/veacom-core');
const fixtures = path.join(__dirname, 'fixtures');

function generate() {
  fs.mkdirSync(studies, { recursive: true });
  const generateStudy = (script, folder, ...args) => execFileSync(process.execPath,
    [path.join(fixtures, script), path.join(studies, folder), ...args], { stdio: 'inherit' });
  generateStudy('make-smoke-study.mjs', 'ct-1000', '--pipe-volume');
  generateStudy('make-smoke-study.mjs', 'video', '--video-ct');
  fs.mkdirSync(path.join(studies, 'mr'));
  for (let n = 1; n <= 8; n++) generateStudy('make-smoke-study.mjs', 'mr/' + n, '--modality', 'MR', '--series-index=' + n);
  generateStudy('make-petct-study.mjs', 'pet');
  const width = 512, data = Buffer.alloc(width * width * 4);
  for (let i = 0; i < width * width; i++) {
    const v = (i % width * 5 + Math.floor(i / width) * 3) & 255;
    data.set([v, (v + 30) & 255, (v + 12) & 255, 255], i * 4);
  }
  fs.writeFileSync(path.join(studies, 'single.png'), encodePng({ width, height: width, data }));
}

async function measureWindow(page) {
  await page.getByTestId('tool-mpr').evaluate(button => button.click());
  await page.waitForFunction(() => document.querySelectorAll('canvas[data-mode="mpr"]').length === 3);
  const times = [];
  let value;
  for (let n = 0; n < 3; n++) {
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ windowMode: 'manual', windowWidth: 21, windowCenter: 11 }));
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.windowWidth === 21);
    await page.getByTestId('tool-window-presets').evaluate(button => button.click());
    const time = await page.getByTestId('preset-auto').evaluate(async button => {
      const start = performance.now();
      button.click();
      while (window.__VEACOM_TEST__.state().view.windowWidth === 21) {
        if (performance.now() - start > 45_000) throw new Error('Auto Window did not update');
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const { mode, plane, windowWidth, windowCenter } = window.__VEACOM_TEST__.state().view;
      return { ms: performance.now() - start, mode, plane, windowWidth, windowCenter };
    });
    assert.equal(time.mode, 'mpr'); assert.equal(time.plane, 'axial');
    times.push(time.ms); value = [time.windowCenter, time.windowWidth];
  }
  return { mprMs: median(times), values: value, commands: times };
}

async function exportMovie(page, folder) {
  const click = locator => locator.evaluate(button => button.click());
  await click(page.getByTestId('tool-export'));
  await click(page.locator('[data-action="export-kind"][data-kind="video"]'));
  await click(page.locator('input[data-action="export-annotations"][value="none"]'));
  await click(page.locator('[data-action="export-more"]'));
  await click(page.locator('input[data-action="export-size"][value="fit"]'));
  await page.locator('select[data-action="export-size"]').selectOption('0');
  await page.locator('[data-action="export-fps"]').fill('15');
  assert.equal(await page.locator('[data-action="export-last-slice"]').inputValue(), '100');
  // Keep the uncompressed frames the exporter passed to its colour conversion.
  const indices = [19, 50, 79];
  await page.evaluate(indices => {
    const original = CanvasRenderingContext2D.prototype.getImageData;
    window.__videoReferences = [];
    let index = 0;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const data = original.apply(this, args);
      if (data.width === 1280 && data.height === 720 && indices.includes(index++)) {
        window.__videoReferences.push(this.canvas.toDataURL('image/png'));
      }
      return data;
    };
  }, indices);
  const start = performance.now();
  await click(page.getByTestId('export-submit'));
  await page.waitForFunction(() => document.querySelector('[data-code="export-complete"], [data-code="export-failed"], .export-error'), undefined, { timeout: 90_000 });
  const exportMs = performance.now() - start;
  assert.deepEqual(await page.locator('[data-code="export-failed"], .export-error').allTextContents(), []);
  const movies = fs.readdirSync(folder).filter(n => n.endsWith('.mp4'));
  assert.equal(movies.length, 1);
  const movie = path.join(folder, movies[0]);
  const stream = JSON.parse(execFileSync('ffprobe', ['-v','error','-select_streams','v:0','-count_frames',
    '-show_entries','stream=width,height,nb_read_frames,r_frame_rate','-of','json',movie])).streams[0];
  assert.deepEqual([stream.width, stream.height, stream.nb_read_frames, stream.r_frame_rate], [1280,720,'100','15/1']);
  const images = await page.evaluate(() => window.__videoReferences);
  assert.equal(images.length, indices.length, 'Missing uncompressed video frames');
  const select = 'select=' + indices.map(n => 'eq(n\\,' + n + ')').join('+');
  const frameBytes = 1280 * 720 * 3;
  const pixels = execFileSync('ffmpeg', ['-v','error','-i',movie,'-vf',select,'-fps_mode','passthrough','-frames:v',String(indices.length),'-pix_fmt','rgb24','-f','rawvideo','pipe:1'], { maxBuffer: 12 << 20 });
  assert.equal(pixels.length, frameBytes * indices.length);
  const quality = images.map((image, n) => {
    const ref = decodePng(Buffer.from(image.split(',')[1], 'base64')).data;
    let error = 0, samples = 0;
    for (let i = 0; i < frameBytes / 3; i++) {
      if (ref[i * 4] < 8) continue;
      for (let channel = 0; channel < 3; channel++) {
        error += (ref[i * 4 + channel] - pixels[n * frameBytes + i * 3 + channel]) ** 2;
        samples++;
      }
    }
    assert(samples > 1000);
    return 10 * Math.log10(255 ** 2 / Math.max(0.0001, error / samples));
  });
  return { exportMs, videoBytes: fs.statSync(movie).size, framePsnrDb: quality, psnrDb: Math.min(...quality) };
}

async function run(build, study, counter) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'veacom-perf-'));
  const folder = await temporaryExportFolder(profile);
  const core = binary(roots[build]);
  const countsFile = path.join(profile, 'reads');
  let desktop;
  try {
    const env = { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1', VEACOM_CACHE_MIB: '256', VEACOM_CORE_PATH: core };
    if (counter) {
      // Insert the counter only in the engine, leaving Electron and the timer runs uninstrumented.
      env.VEACOM_CORE_PATH = path.join(profile, 'counted-core');
      env.TEST_ENGINE = core; env.TEST_COUNTER = counter.library; env.IOCOUNT_FILE = countsFile; env.IOCOUNT_ROOTS = fs.realpathSync(path.join(studies, study));
      fs.writeFileSync(env.VEACOM_CORE_PATH, '#!/bin/sh\nexport ' + counter.variable + '="$TEST_COUNTER"\nexec "$TEST_ENGINE" "$@"\n', { mode: 0o700 });
    }
    desktop = await electron.launch({ args: [roots[build], '--force-device-scale-factor=1'], env, timeout: 90_000 });
    const page = await desktop.firstWindow();
    await ignoreOutsideInput(desktop);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.ready === 'true' && window.__VEACOM_TEST__);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const errors = [], requests = { frame: 0, volume: 0 }, pixelPaths = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const type = new URL(response.url()).pathname.match(/^\/_imaging\/(frame|volume)\//)?.[1];
      if (type) {
        requests[type]++;
        pixelPaths.push(new URL(response.url()).pathname);
        if (!response.ok()) errors.push('Pixel response '+response.status());
      }
    });
    await page.evaluate(study => {
      window.__firstDraw = null;
      document.addEventListener('veacom:frame', () => { window.__firstDraw ??= performance.now(); }, { once: true });
      if (study === 'pet') document.addEventListener('veacom:frame', event => {
        if (window.__fusedDraw) return;
        const cell = event.target.closest('[data-testid="viewport-cell"]');
        const s = window.__VEACOM_TEST__.state();
        if (s.series.some(item => item.id === event.detail.seriesId && item.modality === 'CT')
            && cell?.querySelector('[data-testid="image-overlay"]')?.textContent.includes('SUV 0–')) {
          window.__fusedDraw = performance.now();
        }
      });
      window.__openStarted = performance.now();
    }, study);
    if (study === 'picture-picker') {
      await desktop.evaluate(({ app, BrowserWindow, dialog }, file) => {
        dialog.showOpenDialog = async () => {
          // Give both builds the same time in the picker. Measure from its confirmation.
          await new Promise(resolve => setTimeout(resolve, 750));
          const decoders = app.__VEACOM_PRIVILEGED_TEST__.pictureDecoderProcesses().length;
          await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
            'window.__chooserDecoders = '+decoders+'; window.__openStarted = performance.now()');
          return { canceled: false, filePaths: [file] };
        };
      }, path.join(studies, 'single.png'));
      await page.getByTestId('welcome-open-files').evaluate(button => button.click());
    } else {
      const caps = await authorizeImportPaths(desktop, [path.join(studies, study)]);
      await page.evaluate(c => window.__VEACOM_TEST__.importPaths(c), caps);
    }
    await page.waitForFunction(() => window.__firstDraw && window.__VEACOM_TEST__.state().fullVolumeLoaded, undefined, { timeout: 120_000 });
    const firstMs = await page.evaluate(() => window.__firstDraw - window.__openStarted);
    const row = { firstMs, requests };
    if (study === 'picture-picker') row.preparedDecoders = await page.evaluate(() => window.__chooserDecoders);
    if (study === 'ct-1000') {
      await page.waitForTimeout(300);
      let before, pid;
      if (counter) {
        const children = execFileSync('ps', ['-axo','pid=,ppid=,comm='], { encoding: 'utf8' });
        const child = children.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
          .find(m => m && Number(m[2]) === desktop.process().pid && path.basename(m[3]) === 'veacom-core');
        assert(child && fs.existsSync(countsFile), 'Engine counter unavailable');
        pid = Number(child[1]); before = await readCounts(pid, countsFile, 0);
      }
      Object.assign(row, await measureWindow(page));
      if (counter) {
        const after = await readCounts(pid, countsFile, before.sequence);
        row.mprReads = { bytes: after.bytes - before.bytes, files: after.opened - before.opened };
      }
    } else if (study === 'mr') {
      await page.waitForFunction(() => document.querySelectorAll('.series-preview canvas').length === 8);
      await page.waitForLoadState('networkidle');
      row.pixelPaths = pixelPaths;
    } else if (study === 'pet') {
      await page.waitForFunction(() => {
        const s = window.__VEACOM_TEST__.state();
        return window.__fusedDraw && s.fusionId && s.pendingLoads === 0 && [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(c => c.dataset.volumeComplete === 'true');
      });
      row.fusionMs = await page.evaluate(() => window.__fusedDraw - window.__openStarted);
      const state = await page.evaluate(() => {
        const s = window.__VEACOM_TEST__.state();
        const overlay = s.series.find(x => x.id === s.fusionId);
        return { panes: s.panes.length, fused: s.panes.filter(p => !p.unfused && s.series.find(x => x.id === p.seriesId)?.modality === 'CT').length, overlay: overlay?.modality };
      });
      assert.equal(state.fused, 1); assert.equal(state.overlay, 'PT'); Object.assign(row, state);
      await page.waitForTimeout(1500);
      const rendererPid = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
      row.rendererRssMiB = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(rendererPid)], { encoding: 'utf8' }).trim()) / 1024;
      assert(row.rendererRssMiB > 0);
    } else if (study === 'video') Object.assign(row, await exportMovie(page, folder));
    else {
      const dims = await page.evaluate(() => window.__VEACOM_TEST__.state().dimensions);
      assert.deepEqual(dims, [512, 512, 1]);
      await page.waitForLoadState('networkidle');
    }
    assert.deepEqual(errors, []);
    return row;
  } finally {
    await closeDesktop(desktop);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  generate();
  const report = { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0].model,
    rounds, versions: {}, engines: {}, samples: [], comparisons: [], failures: [] };
  for (const [build, root] of Object.entries(roots)) {
    report.versions[build] = execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    report.engines[build] = createHash('sha256').update(fs.readFileSync(binary(root))).digest('hex');
  }
  const save = () => fs.writeFileSync(path.join(output, 'desktop.json'), JSON.stringify(report, null, 2));
  const counter = prepareCounter(output);
  assert(counter.library, counter.reason);
  report.counts = {};
  for (const build of ['base', 'head']) report.counts[build] = await run(build, 'ct-1000', counter);
  save();
  if (report.counts.base.mprReads.files < 1000) report.failures.push('Beta 2 did not exercise the oversized volume');
  if (report.counts.head.mprReads.bytes || report.counts.head.mprReads.files) report.failures.push('MPR reread the study');
  for (const study of ['ct-1000','mr','pet','single.png','picture-picker','video']) {
    for (let round = -1; round < rounds; round++) {
      const pair = {};
      try {
        for (const build of round % 2 === 0 ? ['base','head'] : ['head','base']) pair[build] = await run(build, study);
      } catch (error) {
        report.failures.push(study+' round '+(round+1)+': '+error.message); console.error(error); save(); break;
      }
      if (round < 0) continue;
      report.samples.push({ study, round, ...pair }); save();
      console.log(study, round + 1, JSON.stringify(pair));
      const check = (ok, reason) => { if (!ok) report.failures.push(study+' round '+(round+1)+': '+reason); };
      if (study === 'ct-1000') check(pair.head.values.every((value, i) => Math.abs(value - pair.base.values[i]) < 1e-5), 'MPR result changed');
      if (study === 'mr') check(pair.head.requests.volume === 1 && pair.head.requests.frame <= 8, 'Duplicate MR reads');
      if (study === 'pet') check(pair.base.panes === 4 && pair.head.panes === 1, 'Incorrect PET layout');
      if (study === 'single.png' || study === 'picture-picker') check(pair.head.requests.volume === 1 && pair.head.requests.frame === 0, 'Duplicate picture reads');
      if (study === 'picture-picker') check(pair.base.preparedDecoders === 0 && pair.head.preparedDecoders === 1, 'File chooser did not prepare one decoder');
      if (study === 'video') check(pair.head.psnrDb >= 35, 'CT video quality: '+pair.head.psnrDb+' dB');
    }
    const rows = report.samples.filter(row => row.study === study);
    if (!rows.length) continue;
    const metrics = study === 'ct-1000' ? ['firstMs','mprMs'] : study === 'video' ? ['exportMs','videoBytes']
      : study === 'pet' ? ['firstMs','fusionMs','rendererRssMiB'] : ['firstMs'];
    for (const metric of metrics) {
      const paired = rows.map(row => ({ base: row.base[metric], head: row.head[metric] }));
      const comparison = compareRounds(paired, { threshold: .15, minMs: metric === 'videoBytes' ? 1 : 20, seed: 4109 });
      report.comparisons.push({ study, metric, ...comparison });
      if (comparison.verdict === 'slower') report.failures.push(study+' '+metric+' regressed');
      if (metric === 'videoBytes' && comparison.change > -.25) report.failures.push('MP4 size reduction below 25%');
    }
    save();
  }
  const table = ['| Study | Metric | Beta 2 median | Candidate median | Change (95% interval) |','|---|---|---:|---:|---|'];
  for (const row of report.comparisons) table.push('| '+[row.study,row.metric,row.base.toFixed(1),row.head.toFixed(1),
    [row.change,row.low,row.high].map(n=>(100*n).toFixed(1)+'%').join(' / ')].join(' | ')+' |');
  fs.writeFileSync(path.join(output, 'desktop.md'),table.join('\n')+'\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,table.join('\n')+'\n');
  assert.deepEqual(report.failures, []);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
