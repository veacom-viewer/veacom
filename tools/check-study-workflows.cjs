const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const privileged = require('./privileged-imaging.cjs');
const { temporaryExportFolder } = require('./lib/export-folder.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');

const exec = promisify(execFile);
const repo = path.resolve(__dirname, '..');
const work = path.resolve(repo, '..', 'work');
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const equal = argument.indexOf('=');
  return [argument.slice(2, equal), argument.slice(equal + 1)];
}));
const output = path.resolve(options.output || path.join(work, 'study-workflow-proof'));
const study = path.resolve(options.study || path.join(work, 'native-fixture', 'synthetic-study'));
const mr = path.resolve(options.mr || path.join(work, 'bench-studies', 'studies', 'mr-8x40'));
const large = path.resolve(options.large || path.join(work, 'bench-studies', 'studies', 'ct-1000'));
const python = options.python || process.env.VEACOM_PYTHON || path.join(work, 'export-check', '.venv', 'bin', 'python');
const checks = [], errors = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function prepareFixtures() {
  const fixtures = path.join(output, 'fixtures');
  await fs.mkdir(fixtures, { recursive: true });
  const names = (await fs.readdir(study)).filter(name => /^IM.*\.dcm$/i.test(name)).sort();
  assert(names.length >= 20, 'The CT/PET fixture must contain at least 20 IM*.dcm CT files.');
  const subset = path.join(fixtures, 'ct-subset');
  await fs.mkdir(subset, { recursive: true });
  for (const name of names.slice(0, 10)) await fs.copyFile(path.join(study, name), path.join(subset, name));
  const missingSuv = path.join(fixtures, 'pet-without-suv');
  await fs.mkdir(missingSuv, { recursive: true });
  await exec(python, ['-c', `
import sys
from pathlib import Path
import pydicom
from pydicom.uid import generate_uid
source, target = map(Path, sys.argv[1:])
uid = generate_uid()
for p in sorted(source.glob('PT*.dcm')):
    ds = pydicom.dcmread(p)
    ds.SeriesInstanceUID = uid
    ds.SOPInstanceUID = generate_uid()
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.SeriesDescription = 'PET without SUV calibration (synthetic test)'
    ds.SeriesNumber = 999
    for tag in [(0x0010, 0x1030), (0x7053, 0x1000)]:
        if tag in ds: del ds[tag]
    ds.save_as(target / p.name, enforce_file_format=True)
`, study, missingSuv]);
  assert((await fs.readdir(missingSuv)).length > 1, 'No PT*.dcm fixture files found.');
  return { subset, missingSuv };
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const fixtures = await prepareFixtures();
  const profile = await fs.mkdtemp(path.join(output, 'electron-profile-'));
  // Its export goes through the native dialog; a wrong turn to the remembered folder stays off the real Desktop.
  await temporaryExportFolder(profile);
  let desktop;
  try { desktop = await electron.launch({ args: [repo, '--study', study], env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90_000 }); }
  catch (error) { await fs.rm(profile, { recursive: true, force: true }); throw error; }
  const page = await desktop.firstWindow();
  // Input from the computer would land in the drawn regions, the series choices and the assessment's fields.
  await ignoreOutsideInput(desktop);
  const processLogs = [];
  desktop.process().stderr?.on('data', value => processLogs.push(value.toString()));
  desktop.process().stdout?.on('data', value => processLogs.push(value.toString()));
  desktop.process().on('exit', (code, signal) => processLogs.push(`Process exited: ${code}, ${signal}`));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  // Requests to the engine, made by the main process (privileged-imaging.cjs): { ok, status, json, sha256, ... }.
  const api = async (op, body) => {
    const answer = await privileged.coreRequest(desktop, op, body);
    if (!answer.ok) throw new Error(`${answer.status}: ${JSON.stringify(answer.json)}`);
    return answer;
  };
  const series = async () => (await api('series')).json.series;
  const imported = async directory => {
    await privileged.importPaths(desktop, page, [directory]);
  };
  const selected = async (id, expectedFrames) => {
    await page.evaluate(id => window.__VEACOM_TEST__.selectSeries(id), id);
    await page.waitForFunction(({ id, expectedFrames }) => {
      const state = window.__VEACOM_TEST__.state();
      return state.activeSeriesId === id && state.fullVolumeLoaded && (!expectedFrames || state.dimensions[2] === expectedFrames);
    }, { id, expectedFrames }, { timeout: 60_000 });
    await page.waitForFunction(id => document.querySelector(`canvas[data-series-id="${id}"]`)?.dataset.renderer, id);
  };
  // A check that cannot run in this build throws a Skip, saying why: it is recorded as skipped, not as passed.
  class Skip extends Error {}
  const record = async (name, fn) => {
    if (options.only === 'assessment-extra' && !name.startsWith('Assessment ')) return;
    const started = performance.now();
    try {
      const details = await fn();
      checks.push({ name, passed: true, milliseconds: performance.now() - started, details });
      console.log(`PASS ${name}`);
    } catch (error) {
      if (error instanceof Skip) {
        checks.push({ name, skipped: true, reason: error.message });
        console.log(`SKIP ${name}: ${error.message}`);
        return;
      }
      checks.push({ name, passed: false, milliseconds: performance.now() - started, error: error.stack });
      console.error(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: path.join(output, `${checks.length}-failure.png`) }).catch(() => {});
    }
  };
  // The lesion pre-diagnosis is switched off while its knowledge base is out of the repository (src/domain/clinical.ts):
  // with an MR shown, its button is disabled and says why (check-interface.cjs checks that it opens nothing), so the
  // checks that work in the assessment are skipped. The clinical worker's own check still runs.
  const assessmentShown = async () => {
    const button = page.getByTestId('tool-assessment');
    if (await button.getAttribute('aria-disabled') !== 'true') return;
    assert(await button.getAttribute('data-tooltip-hint'), 'The switched-off pre-diagnosis button does not say why.');
    throw new Skip('the MR pre-diagnosis is switched off');
  };
  try {
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
    const originals = await series();
    const ct = originals.find(item => item.modality === 'CT');
    const pet = originals.find(item => item.modality === 'PT');
    assert(ct && pet, 'The source fixture must include CT and PET.');
    await record('CT and PET import, decode and calibrated fusion', async () => {
      assert(ct.canReconstruct && pet.canReconstruct);
      assert(ct.frameOfReferenceUid && ct.frameOfReferenceUid === pet.frameOfReferenceUid);
      assert(pet.suvFactor > 0);
      await selected(pet.id, pet.dimensions[2]);
      await selected(ct.id, ct.dimensions[2]);
      // A PET/CT opens arranged, its fusion already on (docs/arrangements.md): the button would turn it off.
      if (!await page.getByTestId('fusion-series').isVisible()) await page.getByTestId('tool-fusion').click();
      await page.getByTestId('fusion-series').selectOption(pet.id);
      await page.waitForFunction(() => window.__VEACOM_TEST__.state().pendingLoads === 0);
      assert.equal(await page.locator('[role="alert"]').count(), 0);
      await page.screenshot({ path: path.join(output, 'ct-pet-fusion.png') });
      return { ct: ct.dimensions, pet: pet.dimensions, suvFactor: pet.suvFactor };
    });
    await record('Missing SUV calibration is rejected in the UI', async () => {
      await imported(fixtures.missingSuv);
      const missing = (await series()).find(item => item.description.startsWith('PET without SUV'));
      assert(missing && missing.suvFactor == null);
      await selected(ct.id, ct.dimensions[2]);
      if (!await page.getByTestId('fusion-series').isVisible()) await page.getByTestId('tool-fusion').click();
      const previous = await page.getByTestId('fusion-series').inputValue();
      await page.getByTestId('fusion-series').selectOption(missing.id);
      await page.locator('[data-testid="notice"][data-code="notice.fusionNoSuv"]').waitFor();
      assert.equal(await page.getByTestId('fusion-series').inputValue(), previous);
      await page.screenshot({ path: path.join(output, 'missing-suv-rejected.png') });
      await page.getByTestId('fusion-disable').click();
      return { valueUnit: missing.valueUnit, suvFactor: missing.suvFactor };
    });
    await record('Changed-series reimport replaces loaded pixels and dimensions', async () => {
      await imported(fixtures.subset);
      await selected(ct.id, 10);
      const subsetState = await page.evaluate(() => window.__VEACOM_TEST__.state());
      await imported(study);
      await selected(ct.id, ct.dimensions[2]);
      const fullState = await page.evaluate(() => window.__VEACOM_TEST__.state());
      return { subsetDimensions: subsetState.dimensions, restoredDimensions: fullState.dimensions };
    });
    await record('Multi-series DICOMDIR export through IPC and pixel-identical reopen', async () => {
      const destination = path.join(output, 'dicom-export');
      await fs.mkdir(destination, { recursive: true });
      await desktop.evaluate(({ dialog }, destination) => {
        global.__reviewOriginalOpenDialog = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
      }, destination);
      let exported;
      try {
        exported = await page.evaluate(ids => window.veacom.exportDicom(ids, { anonymize: true, dicomdir: true }), [ct.id, pet.id]);
      } finally {
        await desktop.evaluate(({ dialog }) => { dialog.showOpenDialog = global.__reviewOriginalOpenDialog; delete global.__reviewOriginalOpenDialog; });
      }
      assert(exported && exported.files === ct.dimensions[2] + pet.dimensions[2]);
      assert(exported.warnings.some(warning => /partial|burned|review/i.test(warning)));
      await fs.access(path.join(exported.directory, 'DICOMDIR'));
      const reopened = (await api('import', { paths: [path.join(exported.directory, 'DICOMDIR')] })).json;
      assert.equal(reopened.series.length, 2);
      const hashes = [];
      for (const original of [ct, pet]) {
        const copy = reopened.series.find(item => item.modality === original.modality);
        assert(copy && copy.patientName === 'ANON' && copy.uid !== original.uid);
        assert.deepEqual(copy.dimensions, original.dimensions);
        const first = await api('volume', { id: original.id });
        const second = await api('volume', { id: copy.id });
        assert(first.byteLength === second.byteLength && first.sha256 === second.sha256, `${original.modality} pixel data changed after export`);
        hashes.push({ modality: original.modality, bytes: first.byteLength, sha256: second.sha256 });
      }
      return { files: exported.files, warnings: exported.warnings, hashes };
    });
    await record('Eight-series MR assessment loads all series and measures drawn ROIs', async () => {
      await imported(mr);
      const mrSeries = (await series()).filter(item => item.modality === 'MR');
      assert.equal(mrSeries.length, 8);
      const first = mrSeries.slice().sort((a, b) => a.seriesNumber - b.seriesNumber)[0];
      await selected(first.id, 40);
      await assessmentShown();
      await page.evaluate(() => { window.__VEACOM_TEST__.setView({ slice: 20 }); window.__VEACOM_TEST__.setTool('rectangle'); });
      await page.waitForFunction(() => document.querySelector('canvas[data-slice]')?.dataset.slice === '20');
      const viewport = page.locator('.viewport-cell.is-active canvas[data-renderer]').first();
      const bounds = await viewport.boundingBox();
      for (const [left, top, right, bottom] of [[0.38, 0.38, 0.47, 0.47], [0.53, 0.53, 0.62, 0.62]]) {
        await page.mouse.move(bounds.x + bounds.width * left, bounds.y + bounds.height * top);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width * right, bounds.y + bounds.height * bottom, { steps: 8 });
        await page.mouse.up();
      }
      await page.waitForFunction(() => document.querySelectorAll('[data-annotation-id]').length >= 2);
      await page.getByTestId('tool-assessment').click();
      const sequenceSettings = page.locator('[data-testid="assessment-sequence-settings"][data-loaded-count="8"]');
      await sequenceSettings.waitFor({ timeout: 90_000 });
      await sequenceSettings.click();
      await page.locator(`[data-testid="assessment-sequence-role"][data-series-number="${first.seriesNumber}"]`).selectOption('t1');
      const assignments = page.locator('.assessment-roi select');
      assert.equal(await assignments.count(), 2);
      await assignments.nth(0).selectOption('lesion');
      await assignments.nth(1).selectOption('reference');
      await page.getByTestId('assessment-measured-signal').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.assessment-table-scroll tbody td')].some(node => node.textContent.startsWith('×')));
      const readings = await page.locator('.assessment-table-scroll tbody').innerText();
      await page.getByTestId('assessment-preview-summary').click();
      const summary = await page.getByTestId('assessment-summary').inputValue();
      assert(/n=\d+/.test(summary), 'The summary has no measured reading.');
      for (const value of [first.patientName, first.patientId, first.studyDate, first.description]) if (value && value.length > 4) assert(!summary.includes(value), 'Summary contains a patient or series identifier');
      await page.screenshot({ path: path.join(output, 'mr-eight-series-assessment.png') });
      await page.getByTestId('assessment-close').click();
      return { seriesCount: 8, dimensions: mrSeries.map(item => item.dimensions), readings, summary };
    });
    await record('Assessment marking, freehand replacement, tool restoration and region alias', async () => {
      await imported(mr);
      const first = (await series()).filter(item => item.modality === 'MR').sort((a, b) => a.seriesNumber - b.seriesNumber)[0];
      await selected(first.id, 40);
      await assessmentShown();
      await page.evaluate(() => { window.__VEACOM_TEST__.setView({ slice: 18, pan: [0, 0] }); window.__VEACOM_TEST__.setTool('pan'); });
      await page.getByTestId('tool-assessment').click();
      await page.locator('[data-testid="assessment-sequence-settings"][data-loaded-count="8"]').waitFor({ timeout: 90_000 });
      const mark = async (kind, cx) => {
        const previous = await page.locator('.assessment-roi select').count();
        await page.getByTestId(`assessment-mark-${kind}`).click();
        const bounds = await page.locator('.viewport-cell.is-active canvas[data-renderer]').boundingBox();
        for (let i = 0; i <= 24; i++) {
          const angle = i / 24 * Math.PI * 2;
          await page.mouse.move(bounds.x + bounds.width * (cx + 0.045 * Math.cos(angle)), bounds.y + bounds.height * (0.5 + 0.06 * Math.sin(angle)));
          if (!i) await page.mouse.down();
        }
        await page.mouse.up();
        await page.waitForFunction(({ previous, kind }) => {
          const selections = [...document.querySelectorAll('.assessment-roi select')];
          return selections.length === previous + 1 && selections.at(-1).value === kind;
        }, { previous, kind });
        return previous;
      };
      const firstIndex = await mark('lesion', 0.43);
      const annotationsBeforePan = await page.locator('[data-annotation-id]').count();
      const beforePan = await page.evaluate(() => window.__VEACOM_TEST__.state().view.pan);
      const bounds = await page.locator('.viewport-cell.is-active canvas[data-renderer]').boundingBox();
      await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * 0.3 + 20, bounds.y + bounds.height * 0.7 + 12, { steps: 4 });
      await page.mouse.up();
      await page.waitForFunction(before => window.__VEACOM_TEST__.state().view.pan.some((value, index) => value !== before[index]), beforePan);
      assert.equal(await page.locator('[data-annotation-id]').count(), annotationsBeforePan, 'Marking did not restore the pan tool.');
      const replacementIndex = await mark('lesion', 0.45);
      assert.equal(await page.locator('.assessment-roi select').nth(firstIndex).inputValue(), '', 'Prior same-slice lesion was not replaced.');
      assert.equal(await page.locator('.assessment-roi select').nth(replacementIndex).inputValue(), 'lesion');
      await mark('reference', 0.56);
      const assignments = await page.locator('.assessment-roi select').evaluateAll(nodes => nodes.map(node => node.value));
      assert.equal(assignments.filter(value => value === 'lesion').length, 1);
      assert.equal(assignments.filter(value => value === 'reference').length, 1);
      const region = page.getByTestId('assessment-region');
      await region.fill('CPA');
      await region.press('ArrowDown');
      await region.press('Enter');
      const chosenRegion = await region.inputValue();
      assert(/serebellopontin|cerebellopontine|serebello.?pontin/i.test(chosenRegion), `Wrong CPA region: ${chosenRegion}`);
      await page.screenshot({ path: path.join(output, 'assessment-marking.png') });
      await page.getByTestId('assessment-close').click();
      return { assignments, chosenRegion, panRestored: true };
    });
    await record('Assessment worker responsiveness with first-copy and cached volumes', async () => {
      const workerFile = (await fs.readdir(path.join(repo, 'dist', 'assets'))).find(name => /^clinical\.worker-.*\.js$/.test(name));
      assert(workerFile, 'Build the clinical worker before running its responsiveness check.');
      const proof = await page.evaluate(async workerFile => {
        const worker = new Worker(new URL(`assets/${workerFile}`, location.href), { type: 'module' });
        const roles = ['t1', 't1c', 't2', 'stir', 'flair', 'ssfp', 'dwi', 'adc'];
        const volumes = roles.map((role, index) => ({
          series: { id: `worker-proof-${index}`, uid: `worker-proof-${index}`, studyUid: 'worker-proof-study', patientId: 'SYNTHETIC', patientName: 'SYNTHETIC',
            studyDate: '', description: role, modality: 'MR', seriesNumber: index + 1, dimensions: [256, 256, 40], spacing: [1, 1, 1], origin: [-128, -128, -20],
            direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 1000, windowWidth: 2000, valueUnit: 'a.u.', suvFactor: null,
            canReconstruct: true, spacingKnown: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
            frameOfReferenceUid: 'worker-proof-frame', components: 1, pixelType: 'uint16' },
          data: (() => { const data = new Uint16Array(256 * 256 * 40).fill(2000 + index * 100);
            for (let row = 0; row < 256 * 40; row++) data.fill(1000 + index * 50, row * 256, row * 256 + 128);
            return data; })(),
        }));
        const activeIds = volumes.map(volume => volume.series.id);
        const sequences = Object.fromEntries(activeIds.map((id, index) => [id, { role: roles[index], bValue: roles[index] === 'dwi' ? 1000 : null, basis: 'Synthetic test' }]));
        const rectangle = (id, kind, x, y, size, z) => ({ seriesId: activeIds[0], kind, order: id,
          annotation: { id: `roi-${id}`, type: 'rectangle', plane: 'axial', slice: z + 20,
            points: [[x, y, z], [x + size, y, z], [x + size, y + size, z], [x, y + size, z]] } });
        const largeMarks = [rectangle(1, 'lesion', -110, -50, 100, 0), rectangle(2, 'reference', 10, -50, 100, 0)];
        const multisliceMarks = Array.from({ length: 10 }, (_, index) => [rectangle(index * 2 + 1, 'lesion', -45, -15, 30, -10 + index * 2), rectangle(index * 2 + 2, 'reference', 15, -15, 30, -10 + index * 2)]).flat();
        const hash = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');
        const sourceHashes = await Promise.all(volumes.map(volume => hash(volume.data)));
        const descriptors = volumes.map(volume => ({ series: volume.series, version: 1, pixelType: 'uint16', byteLength: volume.data.byteLength }));
        let requestId = 0;
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const run = async (name, marks, updates) => {
          const id = ++requestId, gaps = [], tasks = [], chunks = [], waiters = new Map();
          let running = true, last, frameId, started = Infinity;
          const observe = time => { if (last !== undefined) gaps.push(time - last); last = time; if (running) frameId = requestAnimationFrame(observe); };
          frameId = requestAnimationFrame(observe);
          const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.startTime + entry.duration > started) tasks.push(entry.duration); });
          observer.observe({ type: 'longtask', buffered: false });
          await frame(); await frame();
          const replyKey = data => `${data.type}:${data.seriesId ?? ''}:${data.type === 'received' ? data.offset : ''}`;
          const waitFor = (type, seriesId = '', offset = '') => new Promise((resolve, reject) => {
            const key = `${type}:${seriesId}:${offset}`;
            const timer = setTimeout(() => { waiters.delete(key); reject(new Error(`Clinical worker did not reply: ${key}`)); }, 30000);
            waiters.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
          });
          const fail = error => { for (const pending of waiters.values()) pending.reject(error); waiters.clear(); };
          worker.onmessage = ({ data }) => {
            if (data.id !== id) return;
            if (data.type === 'error') { fail(new Error(data.message)); return; }
            const key = replyKey(data), waiting = waiters.get(key);
            if (waiting) { waiters.delete(key); waiting.resolve(data); }
          };
          worker.onerror = event => fail(new Error(event.message));
          started = performance.now();
          const readyReply = waitFor('ready');
          worker.postMessage({ type: 'begin', id, volumes: descriptors });
          const beginPostMs = performance.now() - started;
          const ready = await readyReply;
          if (ready.missing.length !== updates.length) throw new Error(`Expected ${updates.length} missing volumes; worker requested ${ready.missing.length}.`);
          for (const seriesId of ready.missing) {
            const volume = volumes.find(volume => volume.series.id === seriesId);
            worker.postMessage({ type: 'start', id, seriesId });
            for (let offset = 0; offset < volume.data.byteLength; offset += 4 * 1024 * 1024) {
              const count = Math.min(4 * 1024 * 1024, volume.data.byteLength - offset);
              const received = waitFor('received', seriesId, offset + count);
              const copyStarted = performance.now();
              const copy = new Uint8Array(count);
              copy.set(new Uint8Array(volume.data.buffer, volume.data.byteOffset + offset, count));
              worker.postMessage({ type: 'chunk', id, seriesId, offset, bytes: copy.buffer }, [copy.buffer]);
              const durationMs = performance.now() - copyStarted;
              chunks.push({ bytes: count, durationMs });
              if (copy.buffer.byteLength !== 0 || volume.data.byteLength !== 256 * 256 * 40 * 2) throw new Error('Transferred buffer ownership was incorrect.');
              await received;
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            const committed = waitFor('committed', seriesId);
            worker.postMessage({ type: 'commit', id, seriesId });
            await committed;
          }
          const cacheReadyMs = performance.now() - started;
          const answer = waitFor('result');
          const measureStarted = performance.now();
          worker.postMessage({ type: 'measure', id, marks, sequences });
          const measurePostMs = performance.now() - measureStarted;
          const response = await answer;
          const roundTripMs = performance.now() - started;
          await frame(); await frame();
          running = false; cancelAnimationFrame(frameId); observer.disconnect();
          const sorted = [...gaps].sort((a, b) => a - b);
          return { name, beginPostMs, measurePostMs, cacheReadyMs, roundTripMs, workerComputeMs: response.milliseconds,
            maxCopyAndPostMs: Math.max(0, ...chunks.map(chunk => chunk.durationMs)), copyAndPostTotalMs: chunks.reduce((sum, chunk) => sum + chunk.durationMs, 0),
            copiedBytes: chunks.reduce((bytes, chunk) => bytes + chunk.bytes, 0), chunks,
            marks: marks.length, readings: response.measurement.readings.length, ratios: response.measurement.readings.map(reading => reading.ratio), blockers: response.measurement.blockers,
            rafSamples: gaps.length, rafMedianMs: sorted[Math.floor(sorted.length / 2)] ?? null, rafMaxMs: Math.max(0, ...gaps), longTaskMs: tasks };
        };
        try {
          const scenarios = [await run('100mm ROI pair, first pixel copy', largeMarks, volumes), await run('100mm ROI pair, cached pixels', largeMarks, []),
            await run('20 × 30mm ROIs on 10 slices, cached pixels', multisliceMarks, []), await run('20 × 30mm ROIs repeated, cached pixels', multisliceMarks, [])];
          const sourceHashesAfter = await Promise.all(volumes.map(volume => hash(volume.data)));
          return { note: 'rAF callback gaps and browser long tasks measure main-thread responsiveness, not input-to-photon latency. Copy time includes allocating a bounded copy, copying source bytes, and posting that copy with transfer; receipt and yield are excluded from the blocking measurement.',
            protocol: '4MiB-copy-transfer-receipt-yield', workerFile, bytes: volumes.reduce((sum, volume) => sum + volume.data.byteLength, 0), scenarios,
            sourceHashes, sourceHashesAfter, sourcePixelsUnchanged: sourceHashes.every((value, index) => value === sourceHashesAfter[index]) };
        } finally { worker.terminate(); }
      }, workerFile);
      await fs.writeFile(path.join(output, 'assessment-responsiveness.json'), JSON.stringify(proof, null, 2));
      for (const scenario of proof.scenarios) {
        assert.equal(scenario.readings, 8);
        assert.deepEqual(scenario.blockers, []);
        assert(scenario.ratios.every(ratio => ratio === 0.5), 'Uploaded pixels changed a known ROI ratio.');
        assert(scenario.rafSamples >= 2);
        assert(scenario.maxCopyAndPostMs < 16, `One bounded copy blocked for ${scenario.maxCopyAndPostMs.toFixed(1)} ms, exceeding the 16 ms target.`);
      }
      assert(proof.sourcePixelsUnchanged, 'The upload changed or detached source pixels.');
      return proof;
    });
    await record('Core import progress, cancellation and recovery', async () => {
      let finished = false;
      const pending = api('import', { paths: [large] }).then(answer => ({ ok: true, body: answer.json }), error => ({ ok: false, message: error.message })).finally(() => { finished = true; });
      let observed, cancellation;
      for (let attempt = 0; attempt < 300 && !finished; attempt++) {
        const progress = (await api('progress')).json;
        if (progress.running) { observed = progress; cancellation = (await api('cancel')).json; break; }
        await sleep(10);
      }
      const result = await pending;
      assert(observed, 'Import completed before progress could be observed; use a larger fixture.');
      assert(cancellation.requested, 'Cancellation was not accepted.');
      assert(!result.ok && /cancelled/i.test(result.message), 'Cancelled import did not report cancellation.');
      const recovery = (await api('import', { paths: [fixtures.subset] })).json;
      assert(recovery.series.length >= 1);
      const finalProgress = (await api('progress')).json;
      assert.equal(finalProgress.running, false);
      assert.equal(finalProgress.cancelled, false);
      return { observed, cancellation, cancelledResult: result, recoveryFrames: recovery.series[0].dimensions[2] };
    });
  } finally {
    // Every check either ran and passed or was skipped with its reason (assessmentShown).
    const passed = checks.length === (options.only === 'assessment-extra' ? 2 : 8) && checks.every(check => check.passed || check.skipped) && errors.length === 0;
    await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ passed, checks, errors, platform: process.platform, study, mr, large }, null, 2));
    await fs.writeFile(path.join(output, 'process.log'), processLogs.join(''));
    await desktop.close();
    await fs.rm(profile, { recursive: true, force: true });
    if (!passed) process.exitCode = 1;
  }
}
main().catch(async error => {
  console.error(error);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'fatal.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
  process.exitCode = 1;
});
