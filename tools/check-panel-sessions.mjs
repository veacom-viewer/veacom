// Panel state that must end with its control or survive unrelated changes (issue #39):
// a slice-bar arrow held while the bar goes away, ⌘/Ctrl+Z in the middle of a 3D burr stroke, and assessment input
// while a re-import reloads the study's volumes. Mounts the real components on tools/viewport-check.html's Vite origin.
import assert from 'node:assert/strict';
import { launchHarness } from './harness-browser.mjs';

const { page: browserPage, close } = await launchHarness({ width: 1300, height: 820 }), errors = [], checks = [];
browserPage.on('pageerror', error => errors.push(error.message));
let page;
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
try {
  await browserPage.goto(process.env.VEACOM_TEST_URL ?? 'http://127.0.0.1:5188/tools/viewport-check.html');
  await browserPage.waitForFunction(() => document.querySelector('canvas')?.dataset.slice === '16');
  // A child frame has no Electron preload. The only second-opinion service here is the local stub.
  await browserPage.evaluate(async () => {
    const frame = document.createElement('iframe');
    const loaded = new Promise(done => { frame.onload = done; });
    frame.name = 'panels'; frame.srcdoc = '<!doctype html><body style="margin:0">';
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0';
    document.body.append(frame);
    await loaded;
  });
  page = browserPage.frame({ name: 'panels' });
  await page.waitForURL('about:srcdoc');
  await page.addStyleTag({ url: '/src/theme.css' });
  await page.addStyleTag({ url: '/src/styles.css' });
  await page.addStyleTag({ content: `#root{width:500px!important;height:500px!important}
    #bar{position:absolute;left:20px;top:20px;width:14px;height:300px;display:flex}
    #panel{position:absolute;left:60px;top:0;width:420px;height:800px;overflow:auto;background:#fff;color:#000}
    #v3d{position:absolute;left:500px;top:0;width:780px;height:800px;display:flex;flex-direction:column;background:#111}` });
  await page.evaluate(async () => {
    // The page's own copies of React (Vite's prebundled dependencies), so the components share one React.
    const main = await (await fetch('/src/main.tsx')).text();
    const dependency = name => main.match(new RegExp(`from "([^"]*/deps/${name}\\.js\\?v=[^"]*)"`))[1];
    const React = (await import(dependency('react'))).default;
    const client = await import(dependency('react-dom_client'));
    const createRoot = client.createRoot ?? client.default.createRoot;
    const { SliceBar } = await import('/src/components/SliceBar.tsx');
    const { AssessmentPanel } = await import('/src/components/AssessmentPanel.tsx');
    const { VolumeView } = await import('/src/components/VolumeView.tsx');
    const host = id => { const element = document.createElement('div'); element.id = id; document.body.append(element); return createRoot(element); };

    const bar = host('bar');
    let position = 50, removed = false;
    window.barCalls = [];
    const showBar = () => bar.render(React.createElement(SliceBar, { count: 200, position, label: 'Slices', valueText: '',
      onPosition: next => { window.barCalls.push({ at: performance.now(), next }); position = next; if (!removed) showBar(); } }));
    // Unmounting is synchronous, so the time returned is when the bar went away, however busy the page is.
    window.sliceBar = { show: showBar, remove: () => { removed = true; bar.unmount(); return performance.now(); } };
    showBar();

    const n = 8, mr = { id: 'mr1', uid: 'mr1-uid', studyUid: 'study-1', patientId: 'SYNTHETIC', patientName: 'Synthetic', studyDate: '20260101', description: 'T2 AX',
      modality: 'MR', seriesNumber: 3, dimensions: [n, n, n], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 100, windowWidth: 200,
      valueUnit: '', suvFactor: null, canReconstruct: true, spacingKnown: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
      components: 1, pixelType: 'int16', patientAge: 40, patientSex: 'F' };
    const mrVolume = { series: mr, data: new Int16Array(n * n * n).fill(100) };
    const panel = host('panel');
    window.opinions = [];
    Object.defineProperty(window, 'veacom', { value: {
      getAiConfig: async () => ({ enabled: true, configured: true, model: 'synthetic' }),
      askSecondOpinion: () => new Promise((resolve, reject) => window.opinions.push({ resolve, reject })),
    } });
    window.assessment = { show: volumes => panel.render(React.createElement(AssessmentPanel, { volumes, annotations: {}, activeSeriesId: 'mr1',
      onClose: () => {}, onRequestRoi: () => {}, onFinishRoi: () => {} })), hide: () => panel.render(null), volume: mrVolume };
    window.assessment.show([mrVolume]);

    const size = 64, sphere = new Int16Array(size ** 3);
    for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      sphere[(z * size + y) * size + x] = Math.hypot(x - 31.5, y - 31.5, z - 31.5) < 22 ? 1000 : -1000;
    const ct = { ...mr, id: 'sphere', uid: 'sphere-uid', studyUid: 'study-2', description: 'Sphere', modality: 'CT', dimensions: [size, size, size], windowCenter: 40, windowWidth: 400, valueUnit: 'HU' };
    host('v3d').render(React.createElement(VolumeView, { volume: { series: ct, data: sphere }, crosshair: null, onCrosshairChange: () => {}, onClose: () => {}, annotations: [],
      initialView: { plane: 'axial', slice: 32, mode: 'mpr', windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false }, viewportSize: [500, 500] }));
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="volume-3d-canvas"]')?.dataset.renderer, null, { timeout: 30000 });
  await settle();

  // SESS-3: ⌘/Ctrl+Z in the middle of a burr stroke; the burr then carves on, and that carving can be undone too.
  const counters = () => page.evaluate(() => ({ removed: Number(document.querySelector('[data-testid="volume-removed"]')?.dataset.removedVoxels),
    undo: Number(document.querySelector('[data-testid="volume-undo"]')?.dataset.undoCount) }));
  await page.click('[data-testid="volume-mode-burr"]'); await settle();
  const canvas = await page.getByTestId('volume-3d-canvas').boundingBox(), x = canvas.x + canvas.width / 2, y = canvas.y + canvas.height / 2;
  await browserPage.mouse.move(x, y); await browserPage.mouse.down(); await settle();
  check('The burr carves', (await counters()).removed > 0);
  await browserPage.keyboard.press('Control+KeyZ'); await settle();
  check('Undo in a stroke takes back the stroke so far', (await counters()).removed === 0);
  await browserPage.mouse.move(x + 25, y + 18, { steps: 12 }); await browserPage.mouse.up(); await settle();
  const carvedOn = await counters();
  check('Carving after it is one undoable stroke', carvedOn.removed > 0 && carvedOn.undo === 1);
  await page.click('[data-testid="volume-undo"]'); await settle();
  check('Undo takes it back', (await counters()).removed === 0);

  // SESS-2: an arrow held while its bar goes away (the pane got another series) stops paging with it. The repeat
  // starts 400 ms after the press, and on llvmpipe the 3D view's software drawing can hold the page well past that.
  const bar = await page.locator('.slice-bar').boundingBox();
  await browserPage.mouse.move(bar.x + 7, bar.y + bar.height - 5); await browserPage.mouse.down();
  const repeated = await page.waitForFunction(() => window.barCalls.length > 1, undefined, { timeout: 10_000, polling: 50 }).then(() => true, () => false);
  if (!repeated) console.error('Slice-bar calls 10 s after the press:', await page.evaluate(() => JSON.stringify(window.barCalls)));
  check('A held slice-bar arrow repeats', repeated);
  const removedAt = await page.evaluate(() => window.sliceBar.remove());
  await browserPage.mouse.up(); await page.waitForTimeout(800);
  check('A held slice-bar arrow stops paging when its bar goes away', await page.evaluate(at => window.barCalls.filter(call => call.at > at).length, removedAt) === 0);

  // SESS-4: assessment input stays while a re-import reloads the same study's volumes.
  await page.fill('[data-action="assessment-age"]', '63');
  await page.fill('[data-testid="assessment-note"]', 'synthetic note');
  await page.evaluate(() => window.assessment.show([])); await settle();
  await page.evaluate(() => window.assessment.show([{ ...window.assessment.volume, data: window.assessment.volume.data.slice() }])); await settle();
  check('Assessment input survives a re-import of its study', await page.inputValue('[data-action="assessment-age"]') === '63'
    && await page.inputValue('[data-testid="assessment-note"]') === 'synthetic note');

  const request = async note => {
    await page.locator('[data-action="assessment-feature"]').first().selectOption('hipo');
    await page.getByTestId('assessment-note').fill(note);
    await page.getByTestId('assessment-preview-summary').click();
    await page.click('[data-action="assessment-ai-send"]');
  };
  const switchStudy = async uid => {
    await page.evaluate(studyUid => {
      const { series, data } = window.assessment.volume;
      window.assessment.show([{ series: { ...series, studyUid }, data }]);
    }, uid);
    await settle();
    check(`Switching to ${uid} clears the previous note`, await page.getByTestId('assessment-note').inputValue() === '');
  };
  await request('first A');
  await switchStudy('study-2'); await request('study B');
  await switchStudy('study-1'); await request('second A');
  await page.evaluate(() => { window.opinions[0].resolve('stale reply'); window.opinions[1].reject(new Error('stale error')); });
  await settle();
  check('Earlier replies and errors leave the current request pending', await page.locator('[data-action="assessment-ai-send"]').isDisabled()
    && await page.locator('.assessment-ai-reply, .assessment-summary [role="alert"]').count() === 0);
  await page.evaluate(() => window.opinions[2].resolve('current reply'));
  await page.locator('.assessment-ai-reply').getByText('current reply', { exact: true }).waitFor();
  check('The current reply shows the submitted note', (await page.locator('.assessment-ai-reply details pre').textContent()).includes('second A'));

  check('No runtime errors', errors.length === 0);
  console.log(JSON.stringify({ passed: true, count: checks.length, checks }, null, 2));
} finally { await close(); }
