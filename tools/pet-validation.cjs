// VEAcom's PET readings on real studies, for comparison with the scanner vendor's workstation (docs/pet-validation.md).
// Opens each study in the desktop app (as tools/check-pet-voi.cjs does), draws the spheres of a JSON file where it says,
// one at a time, gives each its role (liver reference, blood pool reference or lesion, at 41% of its SUVmax for MTV),
// and writes what VEAcom shows in SUVbw and, where the file allows, SUL, with the SUV factors and what they come from.
// Given the vendor's readings, it writes them side by side and flags SUVmax beyond 1%, SUVpeak beyond 5% and any
// difference in the SUV factor or its parameters.
//
// usage: node tools/pet-validation.cjs STUDIES_DIR SPHERES_JSON OUTPUT_DIR [--vendor VENDOR_JSON] [--screenshots]
//
// Real studies, both JSON files and the output stay outside the repository; the tool refuses paths inside it unless
// the studies are the synthetic ones from tools/fixtures (their manifest says so). OUTPUT_DIR must be new or empty.
const fs = require('node:fs/promises');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const outsideInput = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const privileged = require('./privileged-imaging.cjs');
const validation = require('./lib/pet-validation.cjs');
const { axialPlacement } = require('./lib/pet-validation-geometry.cjs');

const repository = path.resolve(__dirname, '..');
const USAGE = 'usage: node tools/pet-validation.cjs STUDIES_DIR SPHERES_JSON OUTPUT_DIR [--vendor VENDOR_JSON] [--screenshots]';
// The kept PET records (src/domain/petStudies.ts): where VEAcom placed each sphere, and a lesion's values unrounded.
const PET_STUDIES = 'veacom:pet-studies:v1';
// PR #87 adds launchDesktop (a macOS crash-restoration switch); before it, Playwright's own launch.
const launchDesktop = outsideInput.launchDesktop ?? (options => require('playwright')._electron.launch(options));

function parseArguments(argv) {
  const positional = [], options = { screenshots: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vendor' && argv[i + 1]) options.vendor = path.resolve(argv[++i]);
    else if (argv[i] === '--screenshots') options.screenshots = true;
    else if (argv[i].startsWith('--')) throw new Error(USAGE);
    else positional.push(argv[i]);
  }
  if (positional.length !== 3) throw new Error(USAGE);
  const [studies, spheres, output] = positional.map(item => path.resolve(item));
  return { studies, spheres, output, ...options };
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = args => { try { return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
const fileSafe = text => text.replace(/[^\w.-]+/g, '_').slice(0, 60);

/** The build under test: commit, uncommitted changes, version, and the engine and renderer files the app loads. */
function provenance() {
  const binary = process.env.VEACOM_CORE_PATH ? path.resolve(process.env.VEACOM_CORE_PATH)
    : path.join(repository, 'native/target/release', process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core');
  const renderer = path.join(repository, 'dist/index.html');
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  return {
    version: JSON.parse(readFileSync(path.join(repository, 'package.json'), 'utf8')).version,
    commit: git(['rev-parse', 'HEAD']), uncommittedChanges: status === null ? null : status.length > 0,
    engine: existsSync(binary) ? { file: process.env.VEACOM_CORE_PATH ? 'VEACOM_CORE_PATH' : path.relative(repository, binary), sha256: sha256(binary) } : null,
    renderer: existsSync(renderer) ? { file: 'dist/index.html', sha256: sha256(renderer) } : null,
  };
}

const positiveFactor = value => Number.isFinite(value) && value > 0;

function maxActivityBqml(shown, storedMax, factorPerBqml) {
  if (shown.quantity === 'Bq/ml') return shown.max;
  const max = storedMax ?? shown.max;
  if (shown.quantity === 'SUVbw' && positiveFactor(factorPerBqml) && Number.isFinite(max)) return max / factorPerBqml;
}

/** The PET series to measure: the one the spheres file names, else the only calibrated reconstructable PET. */
function choosePet(catalog, selector, study) {
  const pets = catalog.filter(series => series.modality === 'PT');
  let candidates = pets;
  if (selector.number !== undefined) candidates = candidates.filter(series => series.seriesNumber === selector.number);
  if (selector.description) candidates = candidates.filter(series => series.description.toLowerCase().includes(selector.description.toLowerCase()));
  if (selector.number === undefined && !selector.description) {
    const calibrated = pets.filter(series => positiveFactor(series.suvFactor) && series.canReconstruct);
    if (calibrated.length) candidates = calibrated;
  }
  if (candidates.length === 1) return candidates[0];
  const listed = pets.map(series => `${series.seriesNumber} · ${series.description || '(no description)'}`).join('; ') || 'none';
  throw new Error(`${study}: ${candidates.length ? 'several PET series match' : 'no PET series matches'}. Name one in "series" by number or description. PET series: ${listed}.`);
}

/** What the SUV factor of `pet` is made of, from the engine's catalog and the DICOM tags of its first file. */
function factorRecord(study, pet, tags) {
  const tag = (code, nested = false) => {
    const entry = tags.find(item => item.tag === code || (nested && item.tag.endsWith(code)));
    return entry && !/^\[(binary|large value|unprintable)/.test(entry.value) ? entry.value.trim() : '';
  };
  // A private element is found through its creator in any block of its group.
  const privateTag = (group, creator, element) => {
    const block = tags.find(item => new RegExp(`^\\(${group},00[0-9A-F]{2}\\)$`).test(item.tag) && item.value.trim().toUpperCase() === creator);
    return block ? tag(`(${group},${block.tag.slice(8, 10)}${element})`) : '';
  };
  const acquisition = pet.petAcquisition ?? {};
  const philipsActivity = Number(privateTag('7053', 'PHILIPS PET PRIVATE GROUP', '09')) || undefined;
  const unit = pet.valueUnit;
  const byWeight = positiveFactor(pet.suvFactor) && (!/^SU[VL]/i.test(unit) || /^SUVbw$/i.test(unit));
  const suvbwPerBqml = !byWeight ? undefined : unit === 'Bq/ml' ? pet.suvFactor : unit === 'CNTS' && philipsActivity ? pet.suvFactor / philipsActivity : undefined;
  const sul = byWeight && positiveFactor(pet.sulFactor);
  const weightKg = acquisition.weight, heightM = acquisition.height, sex = pet.patientSex || '';
  const ratios = validation.leanBodyMassRatios({ weightKg, heightM, sex });
  const decay = validation.decayMinutes({ factorPerBqml: suvbwPerBqml, weightKg, doseBq: acquisition.injectedActivity, halfLifeSeconds: acquisition.halfLife });
  // The engine uses Start DateTime when present. Compare the scanner clock and retain the full DT in factors.csv.
  const datetime = acquisition.injectionDateTime?.trim();
  const injection = datetime ? datetime.slice(8).replace(/[+-]\d{4}$/, '') : acquisition.injectionTime ?? '';
  const units = tag('(0054,1001)'), suvType = tag('(0054,1006)');
  const storedLbmType = units === 'GML' && ['LBM', 'LBMJAMES128', 'LBMJANMA'].includes(suvType) ? suvType : undefined;
  return {
    study, series_number: pet.seriesNumber, series_description: pet.description, manufacturer: pet.manufacturer ?? '', scanner_model: acquisition.scannerModel ?? '',
    software_versions: tag('(0018,1020)'), reconstruction: acquisition.reconstruction ?? '', units, value_unit: unit,
    corrected_image: tag('(0028,0051)'), decay_correction: acquisition.decayCorrection ?? '', suv_type: suvType,
    suvbw_factor: byWeight ? pet.suvFactor : '', suvbw_per_bqml: suvbwPerBqml ?? '', sul_factor: sul ? pet.sulFactor : '',
    suvbsa_factor: byWeight && positiveFactor(pet.suvBsaFactor) ? pet.suvBsaFactor : '',
    sul_per_suvbw: sul ? pet.sulFactor / pet.suvFactor : '',
    sul_per_suvbw_james: ratios?.james ? ratios.james : '',
    weight_kg: weightKg ?? '', height_m: heightM ?? '', sex, dose_mbq: acquisition.injectedActivity ? acquisition.injectedActivity / 1e6 : '',
    half_life_s: acquisition.halfLife ?? '', injection_time: injection, injection_datetime: acquisition.injectionDateTime ?? '',
    series_date: tag('(0008,0021)'), series_time: tag('(0008,0031)'), acquisition_date: tag('(0008,0022)'), acquisition_time: tag('(0008,0032)'),
    acquisition_datetime: tag('(0008,002A)'), frame_reference_time_ms: tag('(0054,1300)'), frame_duration_ms: tag('(0018,1242)'),
    ge_scan_datetime: privateTag('0009', 'GEMS_PETD_01', '0D'), philips_suv_scale_factor: privateTag('7053', 'PHILIPS PET PRIVATE GROUP', '00'),
    philips_activity_scale_factor: philipsActivity ?? '', scan_start: acquisition.scanStart ?? '',
    uptake_min: acquisition.uptakeSeconds === undefined ? '' : acquisition.uptakeSeconds / 60, decay_min: decay ?? '',
    warnings: (pet.warnings ?? []).join(' | '),
    // For the comparison (not written as such).
    _compare: { suvbwPerBqml, storedLbmType, weightKg, heightM, sex, doseBq: acquisition.injectedActivity, halfLifeSeconds: acquisition.halfLife, injectionTime: injection || undefined },
  };
}

async function measureStudy(entry, context) {
  const folder = entry.folder;
  if (!existsSync(folder)) throw new Error(`${entry.study}: no such folder in ${context.studies}.`);
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-pet-validation-'));
  const errors = [];
  let desktop, page;
  try {
    desktop = await launchDesktop({ args: [repository, '--study', folder], timeout: 90_000,
      env: { ...process.env, VEACOM_USER_DATA: userData, VEACOM_LOCALE: 'en', VEACOM_TELEMETRY_CONSENT: 'denied', VEACOM_USAGE_CHECK_LOCAL: '1', VEACOM_TEST_MODE: '1' } });
    page = await desktop.firstWindow();
    // Keep the person at the machine from typing into the window or clicking it, and keep it drawing while covered.
    await outsideInput.ignoreOutsideInput(desktop);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const state = () => page.evaluate(() => window.__VEACOM_TEST__.state());
    const settled = async () => {
      // PR #87 names the whole series being ready seriesReady; before it, fullVolumeLoaded.
      await page.waitForFunction(() => { const s = window.__VEACOM_TEST__?.state(); return s && (s.seriesReady ?? s.fullVolumeLoaded) && s.pendingLoads === 0; }, undefined, { timeout: 300_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="viewport-cell"]')].every(cell => !cell.dataset.seriesId || cell.dataset.volumeComplete === 'true'), undefined, { timeout: 300_000 });
      await page.waitForTimeout(600);
    };
    await settled();
    const answer = await privileged.readCatalog(desktop);
    const catalog = Array.isArray(answer.catalog) ? answer.catalog : answer.catalog?.series ?? [];
    const pet = choosePet(catalog, entry.series, entry.study);
    const tagsAnswer = await privileged.coreRequest(desktop, 'tags', { id: pet.id, revision: pet.catalogRevision });
    if (!tagsAnswer.ok || !Array.isArray(tagsAnswer.json)) throw new Error(`Could not read the selected PET series' DICOM tags (engine status ${tagsAnswer.status}).`);
    const factor = factorRecord(entry.study, pet, tagsAnswer.json);
    const result = { study: entry.study, series: { number: pet.seriesNumber, description: pet.description }, factor, spheres: [], errors };
    if (!pet.canReconstruct) return { ...result, error: `VEAcom cannot reconstruct series ${pet.seriesNumber} as a volume, so it draws no sphere on it. ${factor.warnings}`.trim() };

    // The pane that shows this PET's acquired or reconstructed axial slices; the active pane takes it if none does.
    const cells = () => page.locator('[data-testid="viewport-cell"]');
    let pane = (await state()).panes.findIndex(item => item.seriesId === pet.id && !item.projection);
    if (pane < 0) {
      await page.evaluate(id => window.__VEACOM_TEST__.selectSeries(id), pet.id);
      await settled();
      pane = (await state()).panes.findIndex(item => item.seriesId === pet.id && !item.projection);
      if (pane < 0) throw new Error(`${entry.study}: no pane shows series ${pet.seriesNumber}.`);
    }
    const canvas = cells().nth(pane).locator('canvas[data-renderer]');
    // Made the active pane with a click in its top left corner, where no tool does anything.
    if (!await cells().nth(pane).evaluate(cell => cell.classList.contains('is-active'))) {
      await canvas.click({ position: { x: 24, y: 70 } });
      await page.waitForFunction(i => document.querySelectorAll('[data-testid="viewport-cell"]')[i]?.classList.contains('is-active'), pane);
    }
    let view = (await state()).view;
    if (view.plane !== 'axial' || view.oblique?.some(Boolean)) await page.evaluate(() => window.__VEACOM_TEST__.setView({ plane: 'axial', oblique: undefined }));
    if (view.rotation || view.flipX || view.flipY) await page.evaluate(() => window.__VEACOM_TEST__.setView({ rotation: 0, flipX: false, flipY: false }));
    view = (await state()).view;
    if (context.screenshots) {
      // Shift+F12 hides the patient's details in the image corners before any picture is taken.
      await page.keyboard.press('Shift+F12');
      await page.waitForTimeout(200);
    }
    const measurementsTab = page.getByTestId('inspector-tab-measurements');
    if (!await measurementsTab.isVisible()) await page.getByTestId('tool-inspector').click();
    await measurementsTab.click();
    await page.evaluate(() => window.__VEACOM_TEST__.setTool('sphere'));
    const location = async () => Number((await cells().nth(pane).locator('[data-testid="image-overlay"] .slice-detail').textContent()).match(/Loc: (-?[\d.]+)/)?.[1]);
    const showPetValues = async value => {
      await page.getByTestId('inspector-tab-display').click();
      const toggle = page.locator('#section-units-toggle');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await page.locator('select[data-action="pet-values"]').selectOption(value);
      await measurementsTab.click();
    };
    const rowIds = () => page.locator('[data-annotation-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-annotation-row')));
    const deleteRow = async row => {
      await row.locator('[data-action="measurement-delete"]').click();
      await row.waitFor({ state: 'detached' });
    };
    /** The row's values once measured, as one line (its parts joined by " · ", as the list shows them). */
    const rowValues = async (id, wanted = () => true, tries = 300) => {
      const row = page.locator(`[data-annotation-row="${id}"] .annotation-values`);
      for (; tries > 0; tries--) {
        const text = await row.evaluate(node => [...node.children].map(part => part.textContent).join(' · ')).catch(() => '');
        if (/ max /.test(text) && wanted(text)) return text;
        if (/Measurement unavailable|No valid ROI samples|No voxels inside|needs a volume/.test(text)) throw new Error(`VEAcom could not measure the sphere: ${text}`);
        await page.waitForTimeout(100);
      }
      throw new Error(`The sphere was not measured in time: ${await row.textContent().catch(() => '')}`);
    };
    const kept = () => page.evaluate(key => { try { return JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { return {}; } }, PET_STUDIES);
    /** Where VEAcom keeps this sphere: its centre and radius, and for a lesion its values in SUVbw, unrounded. */
    const keptSphere = async (role, name) => {
      for (let tries = 0; tries < 100; tries++) {
        for (const record of Object.values(await kept())) for (const series of Object.values(record.series ?? {})) {
          const found = role === 'lesion' ? series.lesions?.find(lesion => lesion.name === name) : series.references?.[role];
          if (found) return found;
        }
        await page.waitForTimeout(100);
      }
      return null;
    };
    const calibrated = positiveFactor(pet.suvFactor);
    const sul = calibrated && positiveFactor(pet.sulFactor);
    const recordFailure = (sphere, message) => {
      result.spheres.push({ name: sphere.name, role: sphere.role, requested: { center: sphere.center, radius: sphere.radius }, values: {}, error: message });
      console.log(`  ${sphere.name}: ${message}`);
    };

    for (const sphere of entry.spheres) {
      try {
        const box = await canvas.boundingBox();
        const current = (await state()).view;
        const placement = axialPlacement(pet, current, sphere.center, sphere.radius, [box.width, box.height]);
        await page.evaluate(patch => window.__VEACOM_TEST__.setView(patch), { slice: placement.slice, zoom: placement.zoom, pan: placement.pan });
        await page.waitForFunction(([i, slice]) => document.querySelectorAll('[data-testid="viewport-cell"]')[i]?.querySelector('canvas[data-renderer]')?.dataset.slice === String(slice),
          [pane, placement.slice]);
        await page.waitForTimeout(250);
        const loc = await location();
        if (Number.isFinite(loc) && Math.abs(loc - placement.planeZ) > 0.06) throw new Error(`The pane shows z = ${loc} mm, not ${placement.planeZ.toFixed(1)} mm.`);
        const before = new Set(await rowIds());
        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x + placement.radiusPx, at.y, { steps: 10 });
        await page.mouse.up();
        await page.waitForFunction(count => document.querySelectorAll('[data-annotation-row]').length > count, before.size, { timeout: 10_000 });
        const id = (await rowIds()).find(item => !before.has(item));
        const row = page.locator(`[data-annotation-row="${id}"]`);
        const reading = { name: sphere.name, role: sphere.role, requested: { center: sphere.center, radius: sphere.radius }, values: {} };
        const role = row.locator('select[data-action="sphere-role"]');
        if (sphere.role !== 'lesion' && await role.count()) await role.selectOption(sphere.role);
        if (sphere.role !== 'lesion' && !await role.count()) reading.roleNote = 'VEAcom gives a sphere a role on a PET in SUV only';
        if (sphere.role === 'liver' && await role.count()) await page.waitForFunction(rowId => /⌀ 30\.0 mm/.test(document.querySelector(`[data-annotation-row="${rowId}"]`)?.textContent ?? ''), id);
        if (sphere.role === 'lesion' && await row.locator('input[data-action="lesion-name"]').count()) {
          const name = row.locator('input[data-action="lesion-name"]');
          await name.fill(sphere.name);
          await name.press('Enter');
          await page.waitForFunction(([rowId, wanted]) => document.querySelector(`[data-annotation-row="${rowId}"] input[data-action="lesion-name"]`)?.value === wanted, [id, sphere.name]);
        }
        const threshold = row.locator('select[data-action="sphere-threshold"]');
        if (sphere.role === 'lesion' && await threshold.count()) {
          await threshold.selectOption('max41');
          // Uptake at 41% that falls apart inside the sphere: VEAcom asks which parts are the lesion. The largest is taken.
          const regionsShown = async () => page.locator(`[data-annotation-row="${id}"] input[data-action="lesion-region"]`).count();
          let text = '';
          for (let tries = 0; tries < 100 && !/MTV 41%/.test(text) && !await regionsShown(); tries++) {
            text = await rowValues(id, () => true, 1).catch(() => '');
            await page.waitForTimeout(100);
          }
          const regions = page.locator(`[data-annotation-row="${id}"] input[data-action="lesion-region"]`);
          if (await regions.count()) {
            const sizes = await regions.evaluateAll(inputs => inputs.map(input => Number(input.closest('label')?.textContent?.match(/\((\d+) voxels?\)/)?.[1] ?? 0)));
            const largest = sizes.indexOf(Math.max(...sizes));
            await regions.nth(largest).check();
            reading.mtvNote = `MTV from the largest of ${sizes.length} regions at 41% inside the sphere (${sizes[largest]} of ${sizes.reduce((a, b) => a + b, 0)} voxels)`;
          }
        }
        let mtv = sphere.role === 'lesion' && calibrated;
        if (mtv && !await rowValues(id, text => /MTV 41%/.test(text), 50).catch(() => null)) { mtv = false; reading.mtvNote ??= 'VEAcom gave no MTV for this sphere'; }
        const withMtv = text => !mtv || /MTV 41%/.test(text);
        const shown = validation.parseSphereValues(await rowValues(id, withMtv));
        if (!calibrated && /^SU[VL]/i.test(shown.quantity)) throw new Error('The viewer reported SUV without a valid engine calibration factor.');
        reading.values[shown.quantity] = shown;
        const record = calibrated ? await keptSphere(sphere.role, sphere.name) : null;
        if (record) {
          reading.placed = { center: record.center, radius: record.radius };
          const off = placement.offset(record.center);
          if (off.inPlane > placement.inPlaneTolerance || off.through > placement.throughTolerance || Math.abs(record.radius - sphere.radius) > placement.inPlaneTolerance) {
            throw new Error(`VEAcom placed the sphere at ${record.center.map(value => value.toFixed(1)).join(', ')} mm, radius ${record.radius.toFixed(1)} mm, not where asked.`);
          }
        }
        reading.maxBqml = maxActivityBqml(shown, record?.values?.max, factor._compare.suvbwPerBqml);
        if (sul && shown.quantity === 'SUVbw') {
          await showPetValues('lbm');
          reading.values.SUL = validation.parseSphereValues(await rowValues(id, text => text.startsWith('SUL max') && withMtv(text)));
          await showPetValues('bw');
          await rowValues(id, text => text.startsWith('SUVbw max'));
        }
        if (context.screenshots) {
          await cells().nth(pane).screenshot({ path: path.join(context.output, 'screenshots', `${fileSafe(entry.study)}-${fileSafe(sphere.name)}.png`) });
        }
        // One sphere at a time: the next is drawn with nothing under the pointer, and each reference is the only one.
        await deleteRow(row);
        result.spheres.push(reading);
        console.log(`  ${sphere.name}: ${Object.entries(reading.values).map(([quantity, value]) => `${quantity} max ${value.max}${value.peak !== undefined ? `, peak ${value.peak}` : ''}${value.mean !== undefined ? `, mean ${value.mean}` : ''}${value.mtv !== undefined ? `, MTV ${value.mtv} mL` : ''}`).join('; ')}`);
      } catch (error) {
        const message = String(error.message ?? error);
        try {
          if (sul) await showPetValues('bw');
          else await measurementsTab.click();
          for (const id of await rowIds()) await deleteRow(page.locator(`[data-annotation-row="${id}"]`));
        } catch (cleanupError) {
          const reason = `Could not reset the viewer after ${sphere.name}: ${cleanupError.message ?? cleanupError}`;
          recordFailure(sphere, `${message}. ${reason}`);
          for (const remaining of entry.spheres.slice(result.spheres.length)) recordFailure(remaining, reason);
          break;
        }
        recordFailure(sphere, message);
      }
    }
    return result;
  } finally {
    await closeDesktop(desktop);
    await fs.rm(userData, { recursive: true, force: true }).catch(() => {});
  }
}

const READING_COLUMNS = ['study', 'series_number', 'series_description', 'sphere', 'role', 'quantity', 'max', 'peak', 'mean', 'sd', 'voxels', 'mtv41_ml', 'tlg',
  'max_bqml', 'center_x', 'center_y', 'center_z', 'radius_mm', 'requested_x', 'requested_y', 'requested_z', 'requested_radius_mm', 'note'];
const FACTOR_COLUMNS = ['study', 'series_number', 'series_description', 'manufacturer', 'scanner_model', 'software_versions', 'reconstruction', 'units', 'value_unit',
  'corrected_image', 'decay_correction', 'suv_type', 'suvbw_factor', 'suvbw_per_bqml', 'sul_factor', 'suvbsa_factor', 'sul_per_suvbw', 'sul_per_suvbw_james',
  'weight_kg', 'height_m', 'sex', 'dose_mbq', 'half_life_s', 'injection_time', 'injection_datetime', 'series_date', 'series_time', 'acquisition_date',
  'acquisition_time', 'acquisition_datetime', 'frame_reference_time_ms', 'frame_duration_ms', 'ge_scan_datetime', 'philips_suv_scale_factor',
  'philips_activity_scale_factor', 'scan_start', 'uptake_min', 'decay_min', 'warnings'];
const COMPARISON_COLUMNS = ['study', 'sphere', 'quantity', 'measure', 'veacom', 'vendor', 'difference_percent', 'tolerance_percent', 'status', 'note'];

function readingRows(studies) {
  const rows = [];
  for (const study of studies) {
    if (study.error) { rows.push({ study: study.study, series_number: study.series?.number, series_description: study.series?.description, note: study.error }); continue; }
    for (const sphere of study.spheres) {
      // Where VEAcom kept the sphere, to a hundredth of a millimetre.
      const mm = value => value === undefined ? undefined : Number(value.toFixed(2));
      const base = { study: study.study, series_number: study.series.number, series_description: study.series.description, sphere: sphere.name, role: sphere.role,
        center_x: mm(sphere.placed?.center[0]), center_y: mm(sphere.placed?.center[1]), center_z: mm(sphere.placed?.center[2]), radius_mm: mm(sphere.placed?.radius),
        requested_x: sphere.requested.center[0], requested_y: sphere.requested.center[1], requested_z: sphere.requested.center[2], requested_radius_mm: sphere.requested.radius };
      if (sphere.error) { rows.push({ ...base, note: sphere.error }); continue; }
      for (const [quantity, values] of Object.entries(sphere.values)) {
        const notes = [...values.notes, ...(values.peakUnavailable ? [`${quantity === 'SUL' ? 'SULpeak' : 'SUVpeak'} unavailable: no complete 1 cm³ sphere inside the VOI`] : []),
          ...(sphere.mtvNote && quantity !== 'SUL' ? [sphere.mtvNote] : []), ...(sphere.roleNote ? [sphere.roleNote] : []), ...(sphere.placed ? [] : ['Placement not confirmed'])];
        rows.push({ ...base, quantity, max: values.max, peak: values.peak, mean: values.mean, sd: values.sd, voxels: values.voxels, mtv41_ml: values.mtv, tlg: values.tlg,
          max_bqml: (quantity === 'SUVbw' || quantity === 'Bq/ml') && sphere.maxBqml !== undefined ? Number(sphere.maxBqml.toPrecision(7)) : undefined, note: notes.join('; ') });
      }
    }
  }
  return rows;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = existsSync(path.join(options.studies, 'manifest.json')) ? JSON.parse(await fs.readFile(path.join(options.studies, 'manifest.json'), 'utf8')) : null;
  const synthetic = manifest?.synthetic === true;
  for (const [key, what] of [['studies', 'STUDIES_DIR'], ['spheres', 'SPHERES_JSON'], ['vendor', '--vendor'], ['output', 'OUTPUT_DIR']]) {
    const file = options[key];
    if (!file) continue;
    const resolved = validation.canonicalPath(file);
    if (!synthetic && validation.inside(file, repository, resolved)) {
      throw new Error(`${what} ${file} is inside the repository. Real studies, their spheres, the vendor's readings and VEAcom's readings stay outside it.`);
    }
    options[key] = resolved;
  }
  const spheres = validation.readSpheres(JSON.parse(await fs.readFile(options.spheres, 'utf8')));
  for (const entry of spheres.studies) {
    entry.folder = validation.canonicalPath(path.join(options.studies, entry.study));
    if (!validation.inside(entry.folder, options.studies)) throw new Error(`${entry.study} resolves outside STUDIES_DIR.`);
    if (!synthetic && validation.inside(entry.folder, repository)) throw new Error(`${entry.study} is inside the repository.`);
  }
  const vendor = options.vendor ? validation.readVendor(JSON.parse(await fs.readFile(options.vendor, 'utf8'))) : null;
  if (existsSync(options.output) && (await fs.readdir(options.output)).length) throw new Error(`OUTPUT_DIR ${options.output} is not empty. Give a new or empty folder.`);
  await fs.mkdir(path.join(options.output, ...(options.screenshots ? ['screenshots'] : [])), { recursive: true });
  const started = new Date().toISOString();
  const context = { ...options };
  const studies = [];
  for (const entry of spheres.studies) {
    console.log(`${entry.study}: ${entry.spheres.length} sphere${entry.spheres.length === 1 ? '' : 's'}`);
    try { studies.push(await measureStudy(entry, context)); }
    catch (error) { studies.push({ study: entry.study, error: String(error.message ?? error), spheres: [] }); console.log(`  ${error.message ?? error}`); }
  }
  const factors = studies.filter(study => study.factor).map(study => study.factor);
  await fs.writeFile(path.join(options.output, 'readings.csv'), validation.toCsv(readingRows(studies), READING_COLUMNS));
  await fs.writeFile(path.join(options.output, 'factors.csv'), validation.toCsv(factors, FACTOR_COLUMNS));
  let comparison = [];
  if (vendor) {
    const measured = studies.map(study => study.error ? study : { study: study.study, factor: study.factor._compare,
      spheres: study.spheres.map(sphere => sphere.error ? { name: sphere.name, error: sphere.error } : { name: sphere.name, values: sphere.values, maxBqml: sphere.maxBqml, mtvNote: sphere.mtvNote }) });
    comparison = validation.compare(measured, vendor);
    await fs.writeFile(path.join(options.output, 'comparison.csv'), validation.toCsv(comparison, COMPARISON_COLUMNS));
  }
  const count = status => comparison.filter(row => row.status === status).length;
  const failedStudies = studies.filter(study => study.error).map(study => study.study);
  const failedSpheres = studies.flatMap(study => study.spheres.filter(sphere => sphere.error).map(sphere => `${study.study}/${sphere.name}`));
  const run = {
    tool: 'tools/pet-validation.cjs', protocol: 'docs/pet-validation.md', started, finished: new Date().toISOString(), synthetic,
    veacom: provenance(), platform: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version,
    inputs: { spheres: { file: path.basename(options.spheres), sha256: sha256(options.spheres) }, ...(options.vendor ? { vendor: { file: path.basename(options.vendor), sha256: sha256(options.vendor) } } : {}) },
    ...(vendor ? { vendorSoftware: [...vendor.studies.values()].map(item => ({ study: item.study, software: item.software })), tolerancesPercent: vendor.tolerances } : {}),
    studies: studies.map(study => ({ study: study.study, series: study.series, error: study.error, spheres: study.spheres.length, failedSpheres: study.spheres.filter(sphere => sphere.error).length,
      pageErrors: study.errors?.length ? study.errors : undefined })),
    comparison: vendor ? { within: count('within'), beyond: count('beyond'), reported: count('reported'), missing: count('missing') } : null,
  };
  await fs.writeFile(path.join(options.output, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  console.log(`Wrote ${['readings.csv', 'factors.csv', ...(vendor ? ['comparison.csv'] : []), 'run.json'].join(', ')} to ${options.output}`);
  if (vendor) {
    console.log(`Against the vendor: ${count('within')} within tolerance, ${count('beyond')} beyond, ${count('missing')} missing, ${count('reported')} reported.`);
    for (const row of comparison.filter(item => item.status === 'beyond' || item.status === 'missing')) {
      console.log(`  ${row.status.toUpperCase()} ${row.study} ${row.sphere} ${row.quantity} ${row.measure}: VEAcom ${row.veacom ?? '—'}, vendor ${row.vendor ?? '—'}${row.difference_percent === '' ? '' : ` (${row.difference_percent}%)`}${row.note ? ` · ${row.note}` : ''}`);
    }
  }
  if (failedStudies.length || failedSpheres.length) console.log(`Not measured: ${[...failedStudies, ...failedSpheres].join(', ')}`);
  if (failedStudies.length || failedSpheres.length || count('beyond') || count('missing')) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message ?? error); process.exitCode = 1; });

module.exports = { choosePet, factorRecord, maxActivityBqml, readingRows };
