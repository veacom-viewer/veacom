// Desktop checks for the workspace interface: keyboard access, menus, tooltips, panels, layout picker,
// export layers and narrow/zoomed layouts. Finds controls by data-testid and ARIA, so either language works.
// usage: node tools/check-interface.cjs STUDY_PATH [OUTPUT_DIR]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { temporaryExportFolder } = require('./lib/export-folder.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');

async function main() {
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/interface');
  await fs.mkdir(output, { recursive: true });
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-interface-'));
  await temporaryExportFolder(userData);
  const desktop = await electron.launch({ args: [path.resolve(__dirname, '..'), '--study', study], env: { ...process.env, VEACOM_USER_DATA: userData }, timeout: 90_000 });
  const errors = [], checks = [];
  let page;
  const check = (name, detail) => { checks.push({ name, detail }); console.log(`PASS ${name}`); };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const active = () => page.evaluate(() => { const e = document.activeElement; return e?.dataset.testid || e?.getAttribute('aria-label') || e?.getAttribute('role') || e?.tagName; });
  const slice = () => page.evaluate(() => window.__VEACOM_TEST__.state().view.slice);
  const size = (width, height) => desktop.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
  const unreachable = () => page.evaluate(() => [...document.querySelectorAll('button, input, select, [role="tab"]')].filter(element => {
    const r = element.getBoundingClientRect(), s = getComputedStyle(element);
    if (!r.width || !r.height || s.visibility === 'hidden') return false;
    if (!(r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1)) return false;
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) return false;
    }
    return true;
  }).map(element => element.getAttribute('aria-label') || element.textContent.trim().slice(0, 40)));
  try {
    page = await desktop.firstWindow();
    // Keep the person at the machine from typing into the window or clicking it, and keep it drawing while covered.
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
    await size(1280, 800);
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: 50 }));
    await page.waitForFunction(() => Number(document.querySelector('canvas[data-slice]')?.dataset.slice) === 50);
    await settle();
    const pagingWork = await page.evaluate(async () => {
      const labels = new Set([...document.querySelectorAll('[data-testid="patient-overlay"] title')].map(title => title.textContent));
      const sort = Array.prototype.sort, measure = CanvasRenderingContext2D.prototype.measureText;
      let seriesSorts = 0, patientMeasurements = 0;
      Array.prototype.sort = function (...args) {
        if (this[0]?.dimensions && this[0]?.modality) seriesSorts++;
        return sort.apply(this, args);
      };
      CanvasRenderingContext2D.prototype.measureText = function (text) {
        if (labels.has(text)) patientMeasurements++;
        return measure.call(this, text);
      };
      try {
        for (const slice of [51, 52, 50]) {
          window.__VEACOM_TEST__.setView({ slice });
          await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))));
          if (Number(document.querySelector('canvas[data-slice]').dataset.slice) !== slice) throw new Error(`Slice ${slice} did not render`);
        }
      } finally {
        Array.prototype.sort = sort;
        CanvasRenderingContext2D.prototype.measureText = measure;
      }
      return { seriesSorts, patientMeasurements, labels: labels.size };
    });
    assert.ok(pagingWork.labels > 0);
    assert.equal(pagingWork.seriesSorts, 0);
    assert.equal(pagingWork.patientMeasurements, 0);
    check('Paging reuses the series order and patient label widths', pagingWork);

    // Toolbar: one Tab stop, arrows move between controls, a tooltip names the focused control.
    const stops = await page.evaluate(() => [...document.querySelectorAll('[role="toolbar"] button')].filter(button => button.tabIndex === 0).length);
    assert.equal(stops, 1, 'The toolbar has exactly one Tab stop.');
    await page.getByTestId('tool-open').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await active(), 'tool-open-disc');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await active(), 'tool-open');
    await page.keyboard.press('End');
    assert.equal(await active(), 'tool-help');
    const tooltip = page.getByTestId('tooltip');
    await tooltip.waitFor();
    assert.match(await tooltip.textContent(), /\?/);
    await page.keyboard.press('Escape');
    await tooltip.waitFor({ state: 'detached' });
    assert.equal(await active(), 'tool-help', 'Esc hides the tooltip without moving focus.');
    check('Toolbar roving focus and keyboard tooltip', { stops });

    // Menus: Enter opens with focus inside, arrows stay in the menu, Esc closes and returns focus.
    const before = await slice();
    await page.getByTestId('tool-window-presets').focus();
    await page.keyboard.press('Enter');
    await page.locator('[role="menu"]').waitFor();
    assert.equal(await page.getByTestId('tool-window-presets').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.closest('[role="menu"]') !== null), true);
    assert.equal(await page.getByTestId('preset-thorax').getAttribute('aria-checked'), 'true', 'The current preset (400 / 40) is checked.');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    assert.equal(await slice(), before, 'Arrows inside a menu do not scroll the image.');
    await page.keyboard.press('Escape');
    await page.locator('[role="menu"]').waitFor({ state: 'detached' });
    assert.equal(await active(), 'tool-window-presets');
    await page.keyboard.press('ArrowDown');
    await page.locator('[role="menu"]').waitFor();
    await page.getByTestId('preset-lung').click();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.windowWidth === 1500);
    assert.equal(await active(), 'tool-window-presets', 'Choosing an item returns focus to its button.');
    check('Menu keyboard pattern and preset state');

    const imageArea = page.getByTestId('dicom-viewport').first();
    await page.getByTestId('tool-window-presets').click();
    await page.locator('[role="menu"]').waitFor();
    await page.locator('.app-status').click({ position: { x: 4, y: 4 } });
    await page.locator('[role="menu"]').waitFor({ state: 'detached' });
    await imageArea.focus();
    const imageBox = await imageArea.boundingBox();
    const pointerX = Math.round(imageBox.x + 30);
    await page.mouse.move(pointerX, imageBox.y + 30);
    await page.keyboard.press('Space');
    await page.getByTestId('quick-menu').waitFor();
    assert.equal(await page.locator('.quick-anchor').evaluate(node => node.offsetLeft), pointerX);
    assert.equal(Math.round((await page.getByTestId('quick-menu').boundingBox()).y), Math.round(imageBox.y + 30));
    await page.locator('.app-status').click({ position: { x: 4, y: 4 } });
    await page.getByTestId('quick-menu').waitFor({ state: 'detached' });
    await imageArea.focus();
    await page.mouse.move(imageBox.x + imageBox.width - 20, imageBox.y + imageBox.height - 5);
    await page.keyboard.press('Space');
    const menuBounds = await page.getByTestId('quick-menu').boundingBox();
    const windowBounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.equal(Math.round(menuBounds.y + menuBounds.height), windowBounds.height - 8);
    assert.ok(menuBounds.x + menuBounds.width <= windowBounds.width - 8);
    await page.keyboard.press('Escape');
    await page.getByTestId('quick-menu').waitFor({ state: 'detached' });
    check('Space opens the quick menu at the pointer and clicking outside closes either menu');

    const fps = page.getByTestId('status-fps');
    await page.getByTestId('status-play').click();
    const originalFps = await fps.inputValue();
    await page.waitForFunction(slice => window.__VEACOM_TEST__.state().view.slice !== slice, before);
    await fps.fill('20'); await fps.press('Enter');
    assert.equal(await fps.inputValue(), '20');
    assert.equal(await page.getByTestId('status-play').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(slice => window.__VEACOM_TEST__.state().view.slice !== slice, await slice());
    await fps.fill('2'); await fps.press('Enter');
    const faster = await page.getByTestId('status-fps-up').boundingBox();
    await page.mouse.move(faster.x + faster.width / 2, faster.y + faster.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="status-fps"]').value) >= 5);
    await page.mouse.up();
    const releasedFps = await fps.inputValue();
    await page.waitForTimeout(250);
    assert.equal(await fps.inputValue(), releasedFps, 'Releasing the cine speed button stops its repeat.');
    await fps.fill(originalFps); await fps.press('Enter');
    await page.getByTestId('status-pause').click(); await settle();
    const pausedAt = await slice();
    await page.waitForTimeout(150);
    assert.equal(await slice(), pausedAt);
    await page.evaluate(slice => window.__VEACOM_TEST__.setView({ slice }), before);
    check('Cine keeps playing when its speed changes and stops advancing on pause');

    const seriesCard = page.locator('.series-card.is-active');
    await seriesCard.locator('canvas').waitFor();
    const preview = await seriesCard.locator('canvas').evaluate(canvas => canvas.toDataURL());
    await page.getByTestId('series-find').click();
    const search = page.locator('[data-action="series-search"]');
    await search.fill('no-matching-study');
    await seriesCard.waitFor({ state: 'detached' });
    await search.fill('bt  tomografi');
    await seriesCard.locator('canvas').waitFor();
    assert.equal(await seriesCard.locator('canvas').evaluate(canvas => canvas.toDataURL()), preview);
    await search.press('Escape');
    check('Multi-word series search restores the cached CT thumbnail');

    // Layout picker: arrows preview rows × columns, Enter applies.
    await page.getByTestId('tool-layout').click();
    await page.locator('[data-layout="1x1"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.layout), '1x1', 'Focus starts on the current layout.');
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="viewport-cell"]').length === 4);
    // Reopening starts on the current layout, so Enter keeps it (it used to fall back to 1 × 1).
    await page.getByTestId('tool-layout').click();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.layout), '2x2', 'The picker opens on the current layout.');
    await page.keyboard.press('Escape');
    // Keyboard focus in a pane makes it the active pane.
    await page.locator('[data-testid="viewport-cell"]').nth(3).locator('[data-testid="viewport-close"]').focus();
    assert.equal(await page.locator('[data-testid="viewport-cell"]').nth(3).evaluate(cell => cell.classList.contains('is-active')), true, 'Focus activates its pane.');
    await page.locator('[data-testid="viewport-cell"]').first().locator('[data-testid="dicom-viewport"]').focus();
    await page.getByTestId('tool-layout').click();
    await page.locator('[data-layout="1x1"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="viewport-cell"]').length === 1);
    check('Layout picker works from the keyboard and keeps the current layout; focus activates panes');

    // Mouse buttons: each has its own toolbar menu, and its button names what it does now. Choosing an action
    // returns focus to the button; Reset brings the defaults back.
    const middle = page.getByTestId('tool-mouse-middle'), mouseMenu = page.locator('[role="menu"]');
    const middleBefore = await middle.getAttribute('aria-label');
    await middle.click(); await mouseMenu.waitFor();
    const choice = mouseMenu.locator('[role="menuitemradio"][aria-checked="false"]').first();
    const choiceName = (await choice.locator('.menu-label').textContent()).trim();
    await choice.click(); await mouseMenu.waitFor({ state: 'detached' });
    const middleAfter = await middle.getAttribute('aria-label');
    assert(middleAfter !== middleBefore && middleAfter.includes(choiceName), `The middle button names its new action: ${middleAfter}`);
    assert.equal(await active(), 'tool-mouse-middle', 'Choosing an action returns focus to its button.');
    await middle.click(); await mouseMenu.waitFor();
    await mouseMenu.locator('[data-action="mouse-reset"]').click(); await mouseMenu.waitFor({ state: 'detached' });
    assert.equal(await middle.getAttribute('aria-label'), middleBefore, 'Reset brings the middle button back.');
    // The toolbar's reset button, beside the tools, does the same.
    await middle.click(); await mouseMenu.waitFor();
    await mouseMenu.locator('[role="menuitemradio"][aria-checked="false"]').first().click(); await mouseMenu.waitFor({ state: 'detached' });
    assert.notEqual(await middle.getAttribute('aria-label'), middleBefore);
    await page.getByTestId('mouse-reset').click();
    await page.waitForFunction(before => document.querySelector('[data-testid="tool-mouse-middle"]').getAttribute('aria-label') === before, middleBefore);
    check('Mouse button menus name the new action on their button', { before: middleBefore, after: middleAfter });

    // A tooltip does not swallow Esc meant for an open menu.
    await page.getByTestId('tool-open').click();
    await page.locator('[role="menu"]').waitFor();
    await page.getByTestId('tool-quick-pan').hover(); await page.waitForTimeout(700);
    await page.keyboard.press('Escape');
    await page.locator('[role="menu"]').waitFor({ state: 'detached' });
    await page.mouse.move(640, 790);
    check('Esc closes a menu even while a tooltip is showing');

    // ⌘E / Ctrl+E opens the export window on DICOM, as the toolbar's Export button does.
    await page.keyboard.press('ControlOrMeta+e');
    await page.locator('.export-dialog').waitFor();
    assert.equal(await page.locator('.export-dialog [data-action="export-kind"][data-kind="dicom"]').getAttribute('aria-checked'), 'true');
    await page.locator('[data-action="export-zip"]').check();
    const estimate = page.getByTestId('export-estimate');
    await estimate.filter({ hasText: '→' }).waitFor();
    const seriesEstimate = await estimate.textContent();
    await page.locator('input[data-action="export-scope"][value="slice"]').check();
    await estimate.filter({ hasText: /^(1 file|1 dosya):/ }).waitFor();
    await page.locator('input[data-action="export-scope"][value="series"]').check();
    assert.equal(await estimate.textContent(), seriesEstimate);
    check('ZIP estimates follow the export scope and reuse the completed series estimate');

    // Selected series: the list's first row and each study's heading are boxes over several series. A click picks all
    // of them, or none when all were picked; with only some of them picked the box shows a dash.
    await page.locator('[data-action="export-zip"]').uncheck();
    await page.locator('input[data-action="export-scope"][value="picked"]').check();
    const pickAll = page.locator('.export-dialog [data-action="export-select-all"]');
    const firstStudy = page.locator('.export-dialog .export-study').first();
    const picks = () => page.locator('.export-series-list').evaluate(list => {
      const state = input => input.indeterminate ? 'some' : input.checked ? 'all' : 'none';
      return { list: state(list.querySelector('[data-action="export-select-all"]')),
        studies: [...list.querySelectorAll('.export-study')].map(study => ({ box: state(study.querySelector('[data-action="export-select-study"]')),
          series: [...study.querySelectorAll('[data-action="export-series"]')].map(input => input.checked) })) };
    });
    const studySizes = (await picks()).studies.map(study => study.series.length);
    const everySeries = { list: 'all', studies: studySizes.map(count => ({ box: 'all', series: Array(count).fill(true) })) };
    if ((await picks()).list !== 'all') await pickAll.click();
    assert.deepEqual(await picks(), everySeries, 'The box over the list picks every series.');
    await pickAll.click();
    assert.deepEqual(await picks(), { list: 'none', studies: studySizes.map(count => ({ box: 'none', series: Array(count).fill(false) })) }, 'Pressed with all picked, it picks none.');
    assert.equal(await page.getByTestId('export-submit').isDisabled(), true, 'With no series picked there is nothing to export.');
    await firstStudy.locator('[data-action="export-select-study"]').click();
    assert.deepEqual(await picks(), { list: studySizes.length > 1 ? 'some' : 'all', studies: studySizes.map((count, index) => ({ box: index ? 'none' : 'all', series: Array(count).fill(!index) })) },
      'A study\'s box picks that study\'s series only.');
    assert.equal(await page.getByTestId('export-submit').isDisabled(), false);
    if (studySizes[0] > 1) {
      await firstStudy.locator('[data-action="export-series"]').first().click();
      assert.deepEqual(await picks(), { list: 'some', studies: studySizes.map((count, index) => index ? { box: 'none', series: Array(count).fill(false) }
        : { box: 'some', series: [false, ...Array(count - 1).fill(true)] }) }, 'With some of its series picked, a box shows a dash.');
    }
    if ((await picks()).list === 'some') {
      await pickAll.click();
      assert.deepEqual(await picks(), everySeries, 'Pressed with some picked, the box over the list picks all.');
    }
    check('Selected series: the boxes over the list and over a study pick all of their series, or none', { studies: studySizes });
    await page.locator('input[data-action="export-scope"][value="series"]').check();
    await page.getByTestId('export-close').click();
    await page.locator('.export-dialog').waitFor({ state: 'detached' });
    check('⌘E / Ctrl+E opens the export window');

    await page.getByTestId('tool-export').click();
    await page.locator('[data-action="export-kind"][data-kind="images"]').click();
    await page.locator('input[data-action="export-scope"][value="slice"]').check();
    // Hold the PNG write so another workspace action can finish while the export is still running.
    await page.evaluate(() => {
      const encode = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (...args) {
        HTMLCanvasElement.prototype.toBlob = encode;
        window.finishTestImage = () => { delete window.finishTestImage; encode.apply(this, args); };
      };
    });
    await page.getByTestId('export-submit').click();
    await page.waitForFunction(() => typeof window.finishTestImage === 'function');
    try {
      assert(await page.getByTestId('tool-open').evaluate(button => Boolean(button.closest('[inert]'))), 'Image controls stay locked during capture.');
      await page.getByTestId('tool-language').click(); await page.keyboard.press('Escape');
      await settle();
      const progress = page.locator('[data-testid="status-export"] progress');
      assert.equal(await progress.count(), 1, 'A workspace update must keep the running export’s progress visible.');
      assert.equal(await progress.getAttribute('max'), '1');
    } finally { await page.evaluate(() => window.finishTestImage()); }
    await page.locator('.export-dialog').waitFor({ state: 'detached' });
    check('Background image export keeps its progress across workspace updates');

    // Keyboard alternatives to dragging: + / − zoom, Shift + arrows pan, click-click measuring.
    const viewport = page.locator('[data-testid="dicom-viewport"]').first();
    // Between these steps the view goes back to its default through the test hook: 0 gives the series' own window, and
    // the toolbar's reset button resets the mouse buttons.
    const resetView = async () => {
      await page.evaluate(() => window.__VEACOM_TEST__.setView({ zoom: 1, pan: [0, 0] }));
      await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.zoom === 1);
      await viewport.focus();
    };
    await viewport.focus();
    const zoomBefore = (await page.evaluate(() => window.__VEACOM_TEST__.state().view)).zoom;
    await page.keyboard.press('+');
    await page.waitForFunction(before => window.__VEACOM_TEST__.state().view.zoom > before, zoomBefore);
    const panBefore = (await page.evaluate(() => window.__VEACOM_TEST__.state().view)).pan[0];
    await page.keyboard.press('Shift+ArrowRight');
    await page.waitForFunction(before => window.__VEACOM_TEST__.state().view.pan[0] > before, panBefore);
    await resetView();
    const box = await page.getByTestId('dicom-canvas').first().boundingBox();
    const annotationsBefore = await page.locator('[data-annotation-id]:not([data-annotation-id="draft"])').count();
    await page.keyboard.press('l');
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6);
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 4 });
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before + 1, annotationsBefore);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before, annotationsBefore);
    await page.keyboard.press('w');
    check('Zoom, pan and click-click measuring without dragging');

    // Review cases: zooming between the two clicks still gives a rectangle square to the screen, and a drag after
    // a stray click is an ordinary measurement from where the drag began.
    const pane = await viewport.boundingBox();
    const shapePoints = selector => page.evaluate(selector => {
      const groups = document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])'), shape = groups[groups.length - 1]?.querySelector(`:scope > ${selector}`);
      return shape ? shape.getAttribute('points').trim().split(/\s+/).map(pair => pair.split(',').map(Number)) : null;
    }, selector);
    await page.keyboard.press('r');
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.4);
    await page.keyboard.press('+');
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.62, { steps: 4 });
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.62);
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before + 1, annotationsBefore);
    const corners = await shapePoints('polygon');
    if (!corners || corners.length !== 4) throw new Error(`rectangle corners: ${JSON.stringify(corners)}`);
    const square = Math.abs(corners[0][1] - corners[1][1]) < 0.5 && Math.abs(corners[1][0] - corners[2][0]) < 0.5 && Math.abs(corners[2][1] - corners[3][1]) < 0.5 && Math.abs(corners[3][0] - corners[0][0]) < 0.5;
    if (!square) throw new Error(`rectangle drawn after a zoom between clicks is not square to the screen: ${JSON.stringify(corners)}`);
    const end = [box.x + box.width * 0.55 - pane.x, box.y + box.height * 0.62 - pane.y];
    if (Math.hypot(corners[2][0] - end[0], corners[2][1] - end[1]) > 1.5) throw new Error(`rectangle does not end at the second click: ${JSON.stringify({ corners, end })}`);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before, annotationsBefore);
    await resetView();
    await page.keyboard.press('l');
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const dragFrom = [box.x + box.width * 0.5, box.y + box.height * 0.5], dragTo = [box.x + box.width * 0.65, box.y + box.height * 0.7];
    await page.mouse.move(...dragFrom, { steps: 3 }); await page.mouse.down();
    await page.mouse.move(...dragTo, { steps: 6 }); await page.mouse.up();
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before + 1, annotationsBefore);
    const line = await shapePoints('polyline');
    const near = (point, target) => Math.hypot(point[0] - (target[0] - pane.x), point[1] - (target[1] - pane.y)) < 1.5;
    if (!line || line.length !== 2 || !near(line[0], dragFrom) || !near(line[1], dragTo)) throw new Error(`drag after a stray click: ${JSON.stringify({ line, dragFrom, dragTo, pane })}`);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before, annotationsBefore);
    // A second click that wobbles a few pixels still finishes the click-click measurement (review: it used to
    // become a tiny drag at the second point and lose the first one).
    const firstClick = [box.x + box.width * 0.3, box.y + box.height * 0.45], secondClick = [box.x + box.width * 0.6, box.y + box.height * 0.5];
    await page.mouse.click(...firstClick);
    await page.mouse.move(...secondClick, { steps: 4 });
    await page.locator('[data-annotation-id="draft"]').waitFor({ timeout: 3000 }).catch(() => { throw new Error('The first click of a click-click measurement is not pending.'); });
    await page.mouse.down();
    await page.mouse.move(secondClick[0] + 5, secondClick[1] + 3, { steps: 3 }); await page.mouse.up();
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before + 1, annotationsBefore);
    const wobbled = await shapePoints('polyline');
    if (!wobbled || !near(wobbled[0], firstClick) || !near(wobbled[1], [secondClick[0] + 5, secondClick[1] + 3])) throw new Error(`wobbly second click: ${JSON.stringify({ wobbled, firstClick, secondClick })}`);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before, annotationsBefore);
    await page.keyboard.press('w');
    check('Click-click survives a zoom between clicks and a wobbly second click; a drag after a stray click measures the drag');

    // Delete all, then another edit, then the notice's Undo: exactly the deleted measurements come back.
    if (!await page.locator('.inspector').isVisible()) await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-measurements').click();
    await settle();
    const canvasBox = await page.getByTestId('dicom-canvas').first().boundingBox();
    // A measurement is selected when it is drawn, and a press beside it only lets it go (as in VEAcom Next): Esc in the
    // image lets go first, so each drag draws a new one.
    const drawLine = async (from, to) => {
      if (await page.locator('[data-annotation-id][data-selected]').count()) { await viewport.focus(); await page.keyboard.press('Escape'); }
      await page.mouse.move(canvasBox.x + canvasBox.width * from[0], canvasBox.y + canvasBox.height * from[1]); await page.mouse.down();
      await page.mouse.move(canvasBox.x + canvasBox.width * to[0], canvasBox.y + canvasBox.height * to[1], { steps: 5 }); await page.mouse.up();
    };
    await viewport.focus(); await page.keyboard.press('l');
    await drawLine([0.3, 0.3], [0.45, 0.35]); await drawLine([0.3, 0.5], [0.5, 0.55]);
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before + 2, annotationsBefore);
    const ids = () => page.evaluate(() => [...document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])')].map(group => group.getAttribute('data-annotation-id')).sort());
    const drawn = await ids();
    await page.getByTestId('findings-delete-all').click();
    await page.waitForFunction(() => !document.querySelector('[data-annotation-id]:not([data-annotation-id="draft"])'));
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'notice-action', undefined, { timeout: 3000 }); // focus moves on the next frame
    await drawLine([0.55, 0.3], [0.7, 0.4]);
    await page.waitForFunction(() => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === 1);
    const later = await ids();
    await page.getByTestId('notice-action').click();
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before + 3, annotationsBefore);
    assert.deepEqual(await ids(), [...drawn, ...later].sort());
    await page.getByTestId('findings-delete-all').click();
    await page.waitForFunction(() => !document.querySelector('[data-annotation-id]:not([data-annotation-id="draft"])'));
    await page.getByTestId('notice-dismiss').click();
    await page.keyboard.press('w');
    check('Undo after Delete all restores exactly the deleted measurements, even after another edit');

    // A measurement chosen in the list: the view goes to its slice, it is selected there, and every click answers.
    await viewport.focus(); await page.keyboard.press('l');
    await drawLine([0.3, 0.3], [0.45, 0.35]);
    const measuredSlice = await slice();
    // Two slices down the page: towards lower indices on a stack stored from the feet up (src/imaging/paging.ts).
    await viewport.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await page.waitForFunction(before => Math.abs(window.__VEACOM_TEST__.state().view.slice - before) === 2, measuredSlice);
    await drawLine([0.3, 0.5], [0.5, 0.55]);
    const firstRow = page.locator('[data-annotation-row]').first(), firstButton = firstRow.locator('[data-action="measurement-go"]');
    const pickedId = await firstRow.getAttribute('data-annotation-row');
    const pickedDrawing = page.locator(`[data-annotation-id="${pickedId}"]`);
    await firstButton.click();
    await page.waitForFunction(id => document.querySelector(`[data-annotation-id="${id}"][data-selected]`), pickedId);
    assert.equal(await slice(), measuredSlice, 'The list goes to the measurement\'s slice.');
    assert.equal(await page.locator('[data-annotation-id][data-selected]').count(), 1, 'Only the chosen measurement is selected.');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'measurement-go', 'Focus stays on the row.');
    await page.screenshot({ path: path.join(output, 'measurement-picked.png') });
    await pickedDrawing.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await firstButton.click();
    assert.ok(await pickedDrawing.evaluate(element => element.getAnimations().length) > 0, 'Clicking the selected measurement on its own slice still answers on the image.');
    assert.ok(await firstButton.evaluate(element => element.getAnimations().length) > 0, 'The row answers the click too.');
    await viewport.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
    await page.waitForFunction(before => window.__VEACOM_TEST__.state().view.slice === before, measuredSlice);
    await pickedDrawing.waitFor();
    assert.equal(await page.locator('[data-annotation-id][data-selected]').count(), 0, 'Leaving the slice ends the selection, so Delete cannot remove a measurement off screen.');
    await page.getByTestId('findings-delete-all').click();
    await page.waitForFunction(() => !document.querySelector('[data-annotation-id]:not([data-annotation-id="draft"])'));
    await page.getByTestId('notice-dismiss').click();
    await page.keyboard.press('w');
    check('The measurement list goes to the slice, selects the measurement there and answers every click');

    // Keyboard routing: Alt + letter is not a tool shortcut, and neither Help nor the pre-op checklist (what a CT's
    // assessment button opens) passes letters to the image. The checklist keeps its answers when it closes. As the
    // assessment does, it takes focus when it opens, closes on Esc from inside it (only there) and hands focus back to
    // its button when it closes. The MR assessment's own checks come last, on a generated MR.
    const measurePressed = () => page.getByTestId('tool-measure').getAttribute('aria-pressed');
    const panes = () => page.locator('[data-testid="dicom-viewport"]').count();
    // Focus moves on the next frame (and the checklist loads on first use), so these wait a little.
    const focusReaches = (test, arg, why) => page.waitForFunction(test, arg, { timeout: 3000 }).catch(async () => { throw new Error(`${why} Focus is on ${await active()}.`); });
    const inChecklist = why => focusReaches(() => document.activeElement?.closest('[data-testid="preop-checklist"]'), undefined, why);
    const focusOn = (testId, why) => focusReaches(id => document.activeElement?.dataset.testid === id, testId, why);
    await viewport.focus(); await page.keyboard.press('w');
    await page.keyboard.press('Alt+l');
    assert.equal(await measurePressed(), 'false', 'Alt + L must not pick the length tool.');
    await page.keyboard.press('F1'); await page.locator('dialog.shortcuts-dialog').waitFor();
    await page.keyboard.press('l');
    await page.keyboard.press('Escape'); await page.locator('dialog.shortcuts-dialog').waitFor({ state: 'detached' });
    assert.equal(await measurePressed(), 'false', 'Letters typed in Help must not reach the image.');
    const panesBefore = await panes();
    const checklist = page.getByTestId('preop-checklist'), firstAnswer = checklist.locator('[data-action="checklist-answer"]').first();
    const checklistLabel = await page.getByTestId('tool-assessment').getAttribute('aria-label');
    await page.getByTestId('tool-assessment').click(); await checklist.waitFor();
    assert.equal(checklistLabel, await checklist.getAttribute('aria-label'), 'A CT\'s assessment button is named after the checklist.');
    await inChecklist('Opening the checklist moves focus into it.');
    await firstAnswer.click();
    assert.equal(await firstAnswer.getAttribute('aria-checked'), 'true');
    await page.keyboard.press('m'); await page.keyboard.press('l'); await settle();
    assert.equal(await panes(), panesBefore, 'M in the checklist must not switch to MPR.');
    assert.equal(await measurePressed(), 'false', 'L in the checklist must not pick a tool.');
    await page.keyboard.press('ControlOrMeta+Alt+t');
    await page.getByTestId('inspector-tab-tags').waitFor();
    assert.equal(await page.getByTestId('inspector-tab-tags').getAttribute('aria-selected'), 'true');
    await checklist.locator('[data-action="checklist-close"]').click(); await checklist.waitFor({ state: 'detached' });
    await focusOn('tool-assessment', 'Closing the checklist hands focus back to its button.');
    await page.getByTestId('tool-assessment').click(); await checklist.waitFor();
    await inChecklist('Reopening the checklist moves focus into it.');
    assert.equal(await firstAnswer.getAttribute('aria-checked'), 'true', 'The checklist keeps its answers when it closes.');
    await checklist.locator('[data-action="checklist-clear"]').click();
    await viewport.focus(); await page.keyboard.press('Escape'); await settle();
    assert.equal(await checklist.isVisible(), true, 'Esc in the image must not close the checklist.');
    await checklist.locator('[data-action="checklist-clear"]').focus(); await page.keyboard.press('Escape');
    await checklist.waitFor({ state: 'detached', timeout: 3000 });
    await focusOn('tool-assessment', 'Esc in the checklist hands focus back to its button.');
    await page.getByTestId('inspector-tab-measurements').click();
    let escapedFrom3d = 'skipped (3D unavailable)', numberFieldKeptEsc = 'no visible number field';
    if (await page.getByTestId('tool-3d').isEnabled()) {
      await page.getByTestId('tool-3d').click(); await page.getByTestId('volume-view').waitFor();
      // Esc in a number field stays with the field (review: it closed 3D and discarded crop and slice edits).
      const cropToggle = page.locator('[data-testid="volume-view"] button[aria-expanded="false"]').first();
      if (await cropToggle.count()) await cropToggle.click(); // crop bounds are number fields
      const numberField = page.locator('[data-testid="volume-view"] input[type="number"]:visible').first();
      if (await numberField.count() && await numberField.isVisible()) {
        await numberField.focus(); await page.keyboard.press('Escape'); await settle();
        assert.equal(await page.getByTestId('volume-view').isVisible(), true, 'Esc in a 3D number field must not close 3D.');
        numberFieldKeptEsc = await numberField.getAttribute('aria-label');
      }
      const field = page.locator('[data-testid="volume-view"] :is(select, input[type="range"])').first();
      await field.focus(); escapedFrom3d = await field.evaluate(element => element.getAttribute('aria-label') || element.tagName);
      await page.keyboard.press('Escape');
      await page.getByTestId('volume-view').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.dataset.testid === 'tool-3d');
    }
    check('Keyboard routing: Alt + letter, Help and the CT checklist keep letters; the checklist keeps its answers, takes focus, closes on Esc from inside and returns focus; Esc leaves 3D from a field', { escapedFrom3d, numberFieldKeptEsc });

    // A real click with the text tool leaves focus in the note field: typed letters are text, not shortcuts. It comes
    // right after 3D closed, which with slow (software) drawing is before the widened pane's resize frame: the pane
    // must judge it by its new size, not the narrow one beside 3D (where the middle of the image was its edge strip).
    await viewport.focus();
    await page.keyboard.press('t');
    const noteBox = await page.getByTestId('dicom-canvas').first().boundingBox();
    await page.mouse.click(noteBox.x + noteBox.width * 0.5, noteBox.y + noteBox.height * 0.62);
    await page.getByTestId('annotation-text-input').waitFor();
    await page.keyboard.type('Lezyon');
    assert.equal(await page.getByTestId('annotation-text-input').inputValue(), 'Lezyon', 'Typed text reaches the note field.');
    await page.keyboard.press('Enter');
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before + 1, annotationsBefore);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForFunction(before => document.querySelectorAll('[data-annotation-id]:not([data-annotation-id="draft"])').length === before, annotationsBefore);
    await viewport.focus(); await page.keyboard.press('w');
    check('Typing a text note after a click goes into the note, not the shortcuts');

    // Single-key shortcuts can be turned off (WCAG 2.1.4).
    if (!await page.locator('.inspector').isVisible()) await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-display').click();
    const singleKeys = page.locator('#section-mouse input[type="checkbox"]').last();
    if (!await singleKeys.isVisible()) await page.locator('#section-mouse-toggle').click();
    await singleKeys.uncheck();
    await viewport.focus();
    await page.keyboard.press('l');
    assert.equal(await page.getByTestId('tool-measure').getAttribute('aria-pressed'), 'false', 'Letters do nothing with single-key shortcuts off.');
    await singleKeys.check();
    await page.locator('#section-mouse-toggle').click();
    check('Single-key shortcuts can be turned off');

    // Inspector tabs follow the ARIA tab pattern.
    if (!await page.locator('.inspector').isVisible()) await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-display').click();
    await page.getByTestId('tool-measure-menu').click();
    await page.locator('[data-action="toolbar-units-calibration"]').click();
    await page.waitForFunction(() => document.activeElement?.id === 'section-units-toggle');
    const units = page.locator('#section-units-toggle');
    assert.equal(await units.getAttribute('aria-expanded'), 'true');
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('veacom:inspector-sections')).includes('units')));
    await units.click();
    assert.ok(!await page.evaluate(() => JSON.parse(localStorage.getItem('veacom:inspector-sections')).includes('units')));
    check('The calibration command opens and focuses its section, and toggling it saves the preference');
    await page.getByTestId('inspector-tab-display').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByTestId('inspector-tab-tags').getAttribute('aria-selected'), 'true');
    assert.equal(await active(), 'inspector-tab-tags');
    const tagPanel = page.locator('#inspector-panel-tags');
    const tagSearch = tagPanel.locator('input');
    await tagPanel.locator('.tag-row').first().waitFor();
    const tagCount = await tagPanel.locator('.tag-row').count();
    const indexCounter = await page.evaluateHandle(() => {
      const stringify = JSON.stringify;
      let count = 0;
      JSON.stringify = function (value, ...args) {
        if (value && typeof value === 'object' && 'tag' in value && 'vr' in value && 'value' in value) count++;
        return stringify.call(this, value, ...args);
      };
      return () => { JSON.stringify = stringify; return count; };
    });
    let indexed;
    try {
      for (const term of ['iNs', 'iNsTaNcE', 'iNsTaNcEnUmBeR']) {
        await tagSearch.fill(term);
        await page.waitForFunction(() => document.getElementById('inspector-panel-tags').getAttribute('aria-busy') === 'false');
      }
    } finally {
      indexed = await indexCounter.evaluate(stop => stop());
      await indexCounter.dispose();
    }
    assert.ok(indexed <= tagCount, `${indexed} rows serialized across three queries for ${tagCount} tags`);
    const instance = tagPanel.locator('.tag-row').filter({ has: page.getByText('InstanceNumber', { exact: true }) });
    await instance.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.tag-row').length === 1);
    const oldInstance = await instance.locator('strong').textContent();
    const tagSlice = await slice();
    const originalLanguage = await page.locator('html').getAttribute('lang');
    const otherLanguage = originalLanguage === 'en' ? 'tr' : 'en';
    for (const lang of [otherLanguage, originalLanguage]) {
      await page.getByTestId('tool-language').click();
      await page.getByTestId(`language-${lang}`).click();
      const label = lang === 'en' ? 'Search DICOM tags' : 'DICOM etiketlerinde ara';
      await tagPanel.getByRole('textbox', { name: label, exact: true }).waitFor();
      assert.equal(await instance.locator('.tag-vr').getAttribute('title'), lang === 'en' ? 'Value representation (VR)' : 'Değer türü (VR)');
      assert.equal(await instance.locator('strong').textContent(), oldInstance);
      assert.equal(await tagSearch.inputValue(), 'iNsTaNcEnUmBeR');
      assert.equal(await slice(), tagSlice);
    }
    check('Switching language updates the tag search and its rows while preserving the query and slice');
    const staleTagWasHidden = await page.evaluate(slice => new Promise(resolve => {
      const panel = document.getElementById('inspector-panel-tags');
      const label = panel.querySelector('.tags-frame').textContent;
      const observer = new MutationObserver(() => {
        if (panel.querySelector('.tags-frame').textContent === label) return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(!panel.querySelector('.tag-row') && panel.getAttribute('aria-busy') === 'true');
      });
      const timeout = setTimeout(() => { observer.disconnect(); resolve(false); }, 3000);
      observer.observe(panel, { subtree: true, childList: true, characterData: true });
      window.__VEACOM_TEST__.setView({ slice });
    }), tagSlice === 0 ? 1 : tagSlice - 1);
    assert.ok(staleTagWasHidden, 'A new slice label never appears over the previous slice’s tags.');
    await page.waitForFunction(previous => {
      const tag = document.querySelector('.tag-row strong');
      return tag && tag.textContent !== previous;
    }, oldInstance);
    assert.equal(await tagSearch.inputValue(), 'iNsTaNcEnUmBeR');
    await tagSearch.fill('no-such-dicom-tag');
    await tagPanel.locator('.tag-row').first().waitFor({ state: 'detached' });
    await page.getByTestId('inspector-tab-display').click();
    await page.getByTestId('inspector-tab-tags').click();
    assert.equal(await tagSearch.inputValue(), 'no-such-dicom-tag');
    await tagSearch.fill('');
    await tagPanel.locator('.tag-row').first().waitFor();
    await page.evaluate(slice => window.__VEACOM_TEST__.setView({ slice }), tagSlice);
    await page.getByTestId('inspector-tab-tags').focus();
    check('DICOM tag search is case-insensitive, follows the displayed frame and survives tab changes');
    await page.keyboard.press('Home');
    assert.equal(await page.getByTestId('inspector-tab-measurements').getAttribute('aria-selected'), 'true');
    await page.getByTestId('inspector-tab-display').click();
    // Closing the panel hands focus to its toolbar button instead of dropping it to the page.
    await page.locator('.inspector-close').focus();
    await page.keyboard.press('Enter');
    await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'tool-inspector');
    await page.keyboard.press('Enter');
    await page.locator('.inspector').waitFor();
    check('Inspector tabs; closing the panel keeps focus');

    // Slice scroller states the 1-based position; exports contain only image layers.
    const slider = page.locator('.viewport-cell.is-active [role="slider"][data-action="slice-slider"]');
    assert.match(await slider.getAttribute('aria-valuetext'), /^\d+ \/ \d+$/);
    const originalSlice = await slice();
    const track = slider.locator('.slice-track'), handle = slider.locator('.slice-handle');
    const max = Number(await slider.getAttribute('aria-valuemax'));
    const waitPosition = value => page.waitForFunction(value =>
      document.querySelector('.viewport-cell.is-active .slice-bar')?.getAttribute('aria-valuenow') === String(value), value);
    await slider.press('Home'); await waitPosition(1);
    const rail = await track.boundingBox(), thumb = await handle.boundingBox();
    assert(Math.abs(thumb.y - rail.y) < 1, 'First slice aligns the handle to the top.');
    const x = rail.x + rail.width / 2;
    await page.mouse.click(x, rail.y + rail.height - 1); await waitPosition(Math.min(11, max));
    await slider.press('Home'); await waitPosition(1);
    await page.mouse.move(x, thumb.y + thumb.height / 2); await page.mouse.down();
    await page.mouse.move(x, rail.y + rail.height - 1); await page.mouse.up(); await waitPosition(max);
    await size(1280, 700); await settle();
    const shorterRail = await track.boundingBox(), last = await handle.boundingBox();
    assert(Math.abs(last.y + last.height - shorterRail.y - shorterRail.height) < 1, 'Last slice stays at the bottom after a resize.');
    await size(1280, 800); await settle();
    await page.evaluate(value => window.__VEACOM_TEST__.setView({ slice: value }), originalSlice);
    await page.waitForFunction(value => window.__VEACOM_TEST__.state().view.slice === value, originalSlice);
    check('Slice bar pages, drags to the last slice, and follows pane resizing');
    const layers = await page.evaluate(() => [...document.querySelector('.viewport-cell.is-active').querySelectorAll('canvas,svg,[data-export-label]')]
      .filter(layer => !layer.closest('[data-export-exclude]')).filter(layer => { const r = layer.getBoundingClientRect(); return r.width && r.height && getComputedStyle(layer).display !== 'none'; })
      .map(layer => layer.dataset.testid || layer.getAttribute('data-testid')));
    assert.deepEqual(layers, ['dicom-canvas', 'annotation-overlay'], 'Exports draw only the image and its overlay.');
    check('Slider value text and export layers', layers);

    // Narrow and zoomed windows keep every control reachable, and dialogs stay out of the window's drag strip:
    // Electron decides dragging by rectangle, so a dialog control inside the strip would move the window.
    const dialogPlacement = async (open, selector, close) => {
      await open(); await page.locator(selector).first().waitFor(); await settle();
      const placement = await page.locator(selector).first().evaluate(dialog => {
        const r = dialog.getBoundingClientRect(), bar = document.querySelector('.toolbar').getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), strip: Math.round(bar.bottom), height: innerHeight, region: getComputedStyle(dialog).getPropertyValue('-webkit-app-region') };
      });
      await close(); await page.locator(selector).first().waitFor({ state: 'detached' });
      if (placement.top < placement.strip || placement.bottom > placement.height || placement.region !== 'no-drag') throw new Error(`${selector} reaches into the drag strip or past the window: ${JSON.stringify(placement)}`);
      return placement;
    };
    const dialogsClear = async () => [
      await dialogPlacement(() => page.keyboard.press('F1'), 'dialog.shortcuts-dialog', () => page.keyboard.press('Escape')),
      await dialogPlacement(() => page.keyboard.press('ControlOrMeta+Shift+E'), '.export-dialog', () => page.getByTestId('export-close').click()),
    ];
    await size(900, 640); await settle();
    assert.deepEqual(await unreachable(), [], 'Controls cut off at 900 × 640.');
    const dialogsAt900 = await dialogsClear();
    // At this width the assessment button sits in the More row. On a CT it is the checklist's button there too: it
    // opens and closes the checklist (never the MR assessment), and closing hands focus back to it, or to More once the
    // row is shut.
    const more = page.getByTestId('tool-more'), moreAssessment = page.locator('.toolbar-second [data-testid="tool-assessment"]');
    await more.click(); await moreAssessment.waitFor();
    assert.equal(await moreAssessment.getAttribute('aria-label'), checklistLabel, 'The More row names the checklist on a CT.');
    await moreAssessment.click(); await checklist.waitFor();
    assert.equal(await page.getByTestId('assessment-panel').count(), 0, 'The More row must not open the MR assessment on a CT.');
    await inChecklist('Opening the checklist from the More row moves focus into it.');
    await page.keyboard.press('Escape'); await checklist.waitFor({ state: 'detached', timeout: 3000 });
    await focusOn('tool-assessment', 'Esc in the checklist hands focus back to its button in the More row.');
    await moreAssessment.click(); await checklist.waitFor();
    await moreAssessment.click(); await checklist.waitFor({ state: 'detached' });
    await moreAssessment.click(); await checklist.waitFor();
    await more.click(); await moreAssessment.waitFor({ state: 'detached' });
    await checklist.locator('[data-action="checklist-close"]').click(); await checklist.waitFor({ state: 'detached' });
    await focusOn('tool-more', 'With the More row shut, closing the checklist hands focus to More.');
    check('More row on a CT: the assessment button opens and closes the checklist; focus returns to it, or to More');
    await size(1280, 800);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
    await page.waitForFunction(() => innerWidth <= 854);
    await settle();
    assert.deepEqual(await unreachable(), [], 'Controls cut off at 150 % zoom.');
    const dialogsAt150 = await dialogsClear();
    // 200 % is best effort (not a product target): reported, not asserted.
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    await page.waitForFunction(() => innerWidth <= 641);
    await settle();
    const at200 = await unreachable();
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    check('900 × 640 and 150 % zoom keep controls reachable; dialogs stay below the drag strip', { cutOffAt200: at200, dialogsAt900, dialogsAt150 });

    // The assessment is for MR: a generated MR comes in through the real menu (the native dialog answers with its
    // folder). Letters typed in the assessment stay out of the image, the inspector can come in front of it without
    // losing what was typed, and closing it hands focus back to its button.
    const mrStudy = path.join(userData, 'mr-study');
    execFileSync(process.execPath, [path.join(__dirname, 'fixtures', 'make-smoke-study.mjs'), mrStudy, '--modality', 'MR']);
    await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, path.join(mrStudy, 'S01'));
    await page.getByTestId('tool-open').click(); await page.locator('[data-action="toolbar-open-folder"]').click();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().series.some(item => item.modality === 'MR'), undefined, { timeout: 90_000 });
    const mr = (await page.evaluate(() => window.__VEACOM_TEST__.state())).series.find(item => item.modality === 'MR');
    if (await page.evaluate(() => window.__VEACOM_TEST__.state().activeSeriesId) !== mr.id) await page.locator(`[data-testid="series-${mr.id}"]`).click();
    await page.waitForFunction(id => window.__VEACOM_TEST__.state().activeSeriesId === id && window.__VEACOM_TEST__.state().fullVolumeLoaded, mr.id, { timeout: 90_000 });
    await page.locator('.viewport-cell.is-active [data-testid="dicom-viewport"]').focus(); await page.keyboard.press('w');
    const mrPanes = await panes();
    // The lesion pre-diagnosis is switched off while its knowledge base is out of the repository: on an MR its button
    // is disabled, says why and opens nothing. The assessment's own checks below run again once it is back.
    const switchedOff = await page.getByTestId('tool-assessment').getAttribute('aria-disabled') === 'true';
    if (switchedOff) {
      assert.ok(await page.getByTestId('tool-assessment').getAttribute('data-tooltip-hint'), 'The disabled pre-diagnosis button says why.');
      await page.getByTestId('tool-assessment').click({ force: true }); await settle();
      assert.equal(await page.getByTestId('assessment-panel').count(), 0, 'A disabled pre-diagnosis button opens nothing.');
      assert.equal(await panes(), mrPanes);
      check('MR pre-diagnosis switched off: its button is disabled, says why and opens nothing');
    } else {
    await page.getByTestId('tool-assessment').click(); await page.getByTestId('assessment-panel').waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('.assessment-overlay'));
    await page.keyboard.press('m'); await page.keyboard.press('l'); await settle();
    assert.equal(await panes(), mrPanes, 'M in the assessment must not switch to MPR.');
    assert.equal(await measurePressed(), 'false', 'L in the assessment must not pick a tool.');
    await page.getByTestId('assessment-note').fill('kept while hidden');
    await page.getByTestId('tool-inspector').click();
    await page.locator('.inspector').waitFor();
    assert.equal(await page.getByTestId('assessment-panel').isVisible(), false);
    await page.getByTestId('tool-assessment').click();
    await page.getByTestId('assessment-panel').waitFor();
    assert.equal(await page.getByTestId('assessment-note').inputValue(), 'kept while hidden');
    await page.getByTestId('assessment-close').focus();
    await page.keyboard.press('ControlOrMeta+Alt+t');
    await page.getByTestId('inspector-tab-tags').waitFor();
    assert.equal(await page.getByTestId('inspector-tab-tags').getAttribute('aria-selected'), 'true');
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'inspector-tab-tags');
    await page.getByTestId('tool-assessment').click();
    assert.equal(await page.getByTestId('assessment-note').inputValue(), 'kept while hidden');
    await page.getByTestId('assessment-close').click();
    await page.getByTestId('assessment-panel').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'tool-assessment');
    check('MR assessment: keeps letters from the image; the inspector in front keeps its input; Close returns focus');

    // With an MR and a CT open, the assessment and the checklist can be open side by side: Esc closes only the one it
    // is pressed in (both sit in an .assessment-overlay).
    const ct = (await page.evaluate(() => window.__VEACOM_TEST__.state())).series.find(item => item.modality === 'CT');
    await page.getByTestId('tool-assessment').click(); await page.getByTestId('assessment-panel').waitFor();
    await page.locator(`[data-testid="series-${ct.id}"]`).click();
    await page.waitForFunction(id => window.__VEACOM_TEST__.state().activeSeriesId === id && window.__VEACOM_TEST__.state().fullVolumeLoaded, ct.id, { timeout: 90_000 });
    await page.getByTestId('tool-assessment').click(); await checklist.waitFor();
    await inChecklist('Opening the checklist beside the assessment moves focus into it.');
    await page.keyboard.press('Escape'); await checklist.waitFor({ state: 'detached', timeout: 3000 });
    assert.equal(await page.getByTestId('assessment-panel').isVisible(), true, 'Esc in the checklist must not close the assessment.');
    await page.getByTestId('tool-assessment').click(); await checklist.waitFor();
    await page.getByTestId('assessment-close').focus(); await page.keyboard.press('Escape');
    await page.getByTestId('assessment-panel').waitFor({ state: 'detached', timeout: 3000 });
    assert.equal(await checklist.isVisible(), true, 'Esc in the assessment must not close the checklist.');
    // Focus is back on the toolbar button, whose keyboard tooltip covers the checklist's Close: the button closes it.
    await page.getByTestId('tool-assessment').click(); await checklist.waitFor({ state: 'detached' });
    check('Assessment and checklist open together: Esc closes only the one it is pressed in');
    }

    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'interface-checks.json'), JSON.stringify({ checks, errors }, null, 2));
    console.log(`All ${checks.length} interface checks passed.`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'interface-failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'interface-checks.json'), JSON.stringify({ checks, errors, failure: String(error.stack || error) }, null, 2));
    throw error;
  } finally {
    await closeDesktop(desktop);
    await fs.rm(userData, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
