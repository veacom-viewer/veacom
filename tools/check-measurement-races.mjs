// Measurements against what the screen shows a moment late: a press before a paged frame is drawn, measurements
// hidden while one is selected, and a list pick the reader moved on from (issue #37). Runs on
// tools/viewport-check.html (real Viewport, React and WebGL) like check-gestures.mjs.
import assert from 'node:assert/strict';
import { launchHarness } from './harness-browser.mjs';

const { page, close } = await launchHarness(), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const state = () => page.evaluate(() => window.viewportTest.state());
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const selected = () => page.locator('[data-annotation-id][data-selected]').count();
async function measured() {
  await page.evaluate(() => { const h = window.viewportTest; h.restoreVolume(); h.clear(); h.setOptions({}); h.setTool('length'); h.reset(); h.setView({ mode: 'source', slice: 16, plane: 'axial', oblique: undefined }); });
  await settle();
  await page.mouse.move(200, 250); await page.mouse.down(); await page.mouse.move(300, 250, { steps: 8 }); await page.mouse.up(); await settle();
  return (await state()).annotations[0];
}
try {
  await page.goto(process.env.VEACOM_TEST_URL ?? 'http://127.0.0.1:5188/tools/viewport-check.html');
  await page.waitForFunction(() => document.querySelector('canvas')?.dataset.slice === '16');

  // One wheel notch, then a press on the measurement's handle before the next frame shows the paged slice.
  const drawn = await measured();
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="dicom-viewport"]');
    const pointer = (type, x, y, buttons) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y }));
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, wheelDeltaY: -120, clientX: 320, clientY: 320 }));
    pointer('pointerdown', 300, 250, 1); pointer('pointermove', 320, 262, 1); pointer('pointerup', 320, 262, 0);
  });
  await settle();
  const paged = await state();
  check('The press pages first', paged.view.slice !== 16);
  check('A press before the paged frame is drawn leaves the old slice\'s measurement where it was',
    JSON.stringify(paged.annotations.find(item => item.id === drawn.id)?.points) === JSON.stringify(drawn.points));
  check('No measurement lies across two slices', paged.annotations.every(item => new Set(item.points.map(point => point[2].toFixed(3))).size === 1));

  // A new measurement is selected; hiding measurements must not leave it deletable from the keyboard.
  await measured();
  check('A new measurement is selected', await selected() === 1);
  await page.evaluate(() => window.viewportTest.setOptions({ hideMeasurements: true })); await settle();
  await page.locator('[data-testid="dicom-viewport"]').focus(); await page.keyboard.press('Backspace'); await settle();
  check('Hidden measurements cannot be deleted from the keyboard', (await state()).annotations.length === 1);
  await page.evaluate(() => window.viewportTest.setOptions({})); await settle();
  check('Hiding measurements lets go of the selected one', await selected() === 0);

  // Picked in the list while the pane shows another slice; the reader pages on and later comes back.
  const picked = await measured();
  await page.evaluate(() => { window.viewportTest.setTool('scroll'); window.viewportTest.setView({ slice: 3 }); }); await settle();
  await page.evaluate(id => document.querySelector('[data-testid="dicom-viewport"]').dispatchEvent(new CustomEvent('veacom:pick-measurement', { detail: id })), picked.id);
  await settle();
  await page.locator('[data-testid="dicom-viewport"]').focus(); await page.keyboard.press('ArrowDown'); await settle();
  await page.evaluate(() => window.viewportTest.setView({ slice: 16 })); await settle();
  check('A list pick the reader moved on from does not select the measurement later', await selected() === 0);

  // Undo (or another change) lands while a measurement's handle is held; the release must not write it back over.
  const current = await measured();
  const older = { ...current, points: current.points.map(point => [point[0], point[1] + 5, point[2]]) };
  await page.mouse.move(300, 250); await page.mouse.down(); await page.mouse.move(310, 258, { steps: 3 }); await settle();
  await page.evaluate(annotation => window.viewportTest.setAnnotations([annotation]), older); await settle();
  await page.mouse.move(320, 266, { steps: 3 }); await page.mouse.up(); await settle();
  check('A change made while a measurement is held is not overwritten by the release', JSON.stringify((await state()).annotations) === JSON.stringify([older]));

  check('No runtime rendering errors', errors.length === 0 && await page.locator('[role="alert"]').count() === 0);
  console.log(JSON.stringify({ passed: true, count: checks.length, checks }, null, 2));
} finally { await close(); }
