const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const os = require('node:os');
const { ClickBudget } = require('./click-budget.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const { isSoftwareRenderer } = require('./software-renderer.cjs');
const { toggleMpr } = require('./lib/mpr.cjs');
// hardware (default): a graphics driver must draw. software: the PC has no usable driver, so drawing must
// run in software and the app must say so.
const expectedRenderer = process.env.VEACOM_SMOKE_RENDERER || 'hardware';

async function main() {
  const study = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3] || 'test-results/desktop');
  await fs.mkdir(output, { recursive: true });
  const errors = [];
  const checks = [];
  const started = performance.now();
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-smoke-'));
  const packaged = process.env.VEACOM_SMOKE_EXECUTABLE;
  const restoreArgs = process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [];
  const desktop = await electron.launch({ ...(packaged ? { executablePath: packaged } : {}), args: [...(packaged ? [] : [path.resolve(__dirname, '..')]), '--study', study, ...restoreArgs], env: { ...process.env, VEACOM_USAGE_CHECK_LOCAL: '1', VEACOM_USER_DATA: userData, VEACOM_TELEMETRY_ENVIRONMENT: 'lab' }, timeout: 90_000 });
  let page;
  const screenshot = async name => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(output, name) });
  };
  const check = (name, detail) => { checks.push({ name, passed: true, detail }); console.log(`PASS ${name}`); };
  try {
    page = await desktop.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await ignoreOutsideInput(desktop);
    // Each step's actions, counted by the app's usage timings, against tools/click-budgets.json.
    const budget = new ClickBudget(page);
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
    await page.locator('canvas[data-renderer]').first().waitFor({ state: 'visible' });
    const state = await page.evaluate(() => window.__VEACOM_TEST__.state());
    check('CLI study import and full decode', { elapsedMs: performance.now() - started, state });
    const renderer = await page.locator('canvas[data-renderer]').first().getAttribute('data-renderer');
    const software = isSoftwareRenderer(renderer) || await page.locator('canvas[data-renderer]').first().getAttribute('data-software-renderer') === 'true';
    if (expectedRenderer === 'software') {
      assert(software, `Expected software drawing: ${renderer}`);
      await page.getByTestId('software-rendering-notice').waitFor();
      check('Software drawing with its notice', renderer);
    } else {
      assert(!software, `Software renderer: ${renderer}`);
      check('Hardware GPU rendering', renderer);
    }
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));

    // A thick slab draws the plane the CT was acquired in as a reconstruction of the same slices. The slice it opens at
    // keeps its image's number, which on the smoke CT (numbered from the feet) is 100 / 100 at the top.
    const sliceLine = async slab => {
      await page.waitForFunction(slab => /MIP \d+ mm/.test(document.querySelector('[data-testid="image-overlay"]')?.textContent ?? '') === slab, slab);
      const text = await page.locator('[data-testid="image-overlay"]').first().textContent();
      return { number: text.match(/\d+ \/ \d+/)?.[0], location: text.match(/Loc: (-?[\d.]+)/)?.[1] };
    };
    // The slab menu's first choices: 0 off, 1 MIP.
    const chooseSlab = async item => { await page.getByTestId('tool-slab').click(); await page.locator('[role="menu"] [role="menuitemradio"]').nth(item).click(); };
    const opened = await sliceLine(false);
    assert.match(opened.number ?? '', /^\d+ \/ \d+$/);
    await chooseSlab(1);
    assert.deepEqual(await sliceLine(true), opened, 'The slab shows the slice under another number.');
    await chooseSlab(0);
    assert.deepEqual(await sliceLine(false), opened);
    check('A slice keeps its number when a thick slab draws it', opened);

    await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: Math.floor(window.__VEACOM_TEST__.state().dimensions[2] / 2) }));
    await page.waitForFunction(() => +document.querySelector('canvas[data-slice]').dataset.slice === window.__VEACOM_TEST__.state().view.slice);
    await screenshot('after-window.png');

    const canvas = page.locator('canvas[data-renderer]').first();
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const beforeScroll = await page.evaluate(() => window.__VEACOM_TEST__.state().view.slice);
    await budget.task('wheel-scroll', () => page.mouse.wheel(0, 120),
      { until: () => page.waitForFunction(before => window.__VEACOM_TEST__.state().view.slice !== before, beforeScroll) });
    check('Physical wheel input changes slice');
    const beforeWindow = await page.evaluate(() => window.__VEACOM_TEST__.state().view.windowWidth);
    // Another tool first, so that pressing W is a real step of the task.
    await page.evaluate(() => window.__VEACOM_TEST__.setTool('pan'));
    await page.waitForFunction(() => window.__VEACOM_TEST__.usage().some(event => event.attributes['veacom.tool'] === 'pan'));
    await budget.task('window-drag', async () => {
      await page.keyboard.press('w');
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 30, { steps: 8 }); await page.mouse.up();
    }, { until: () => page.waitForFunction(before => window.__VEACOM_TEST__.state().view.windowWidth !== before, beforeWindow) });
    check('Window and level drag');

    await budget.task('measure-length', async () => {
      await page.keyboard.press('l');
      await page.mouse.move(bounds.x + bounds.width * .35, bounds.y + bounds.height * .45);
      await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .5, { steps: 8 }); await page.mouse.up();
    }, { until: () => page.locator('[data-annotation-id]:not([data-annotation-id="draft"])').first().waitFor() });
    check('Length annotation renders');
    await budget.task('undo-redo', async () => {
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(() => !document.querySelector('[data-annotation-id]'));
      await page.keyboard.press('ControlOrMeta+Shift+z');
    }, { until: () => page.locator('[data-annotation-id]').first().waitFor() });
    check('Annotation undo and redo');
    await screenshot('after-measurement.png');

    // The MPR menu: the plane the CT was acquired in shows its own slices, and the other planes are reconstructions.
    const planeItems = page.locator('[role="menu"] [data-action^="plane-"]');
    await page.getByTestId('tool-mpr').click();
    assert.equal(await planeItems.count(), 3);
    assert.equal(await page.locator('[role="menu"] [data-action="toolbar-acquired-slices"]').count(), 0, 'The acquired slices have no entry of their own.');
    assert.equal(await planeItems.nth(0).getAttribute('aria-checked'), 'true', 'Axial, the plane the CT was acquired in, is the one shown.');
    await planeItems.nth(1).click();
    await page.waitForFunction(() => { const view = window.__VEACOM_TEST__.state().view; return view.mode === 'mpr' && view.plane === 'coronal'; });
    await page.getByTestId('tool-mpr').click();
    await planeItems.nth(0).click();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.mode === 'source');
    check('In the MPR menu the acquired plane shows the CT\'s own slices; the others are reconstructed');

    // With a thick slab on, the acquired plane is reconstructed too, since the CT's own slices draw no slab. Choosing it
    // again in the MPR menu, or reaching it from the pane's plane name, keeps the slab on and drawn; turning the slab off
    // brings the CT's own slices back.
    const shownView = () => page.evaluate(() => { const view = window.__VEACOM_TEST__.state().view; return { mode: view.mode, plane: view.plane, slab: view.slab?.mode ?? null }; });
    const axialMip = { mode: 'mpr', plane: 'axial', slab: 'mip' };
    const slabItems = page.locator('[role="menu"] [role="menuitemradio"]');
    await page.getByTestId('tool-slab').click();
    await slabItems.nth(1).click();
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().view.slab?.mode === 'mip');
    assert.deepEqual(await shownView(), axialMip);
    await page.getByTestId('tool-mpr').click();
    await planeItems.nth(0).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await shownView(), axialMip, 'Axial chosen again in the MPR menu keeps the slab.');
    const pane = await canvas.boundingBox();
    for (const plane of ['coronal', 'sagittal', 'axial']) {
      await page.mouse.click(pane.x + 10, pane.y + pane.height - 10);
      await page.waitForFunction(plane => window.__VEACOM_TEST__.state().view.plane === plane, plane);
    }
    assert.deepEqual(await shownView(), axialMip, 'The plane name returns to axial with the slab.');
    await page.getByTestId('tool-slab').click();
    await slabItems.nth(0).click();
    await page.waitForFunction(() => { const view = window.__VEACOM_TEST__.state().view; return view.mode === 'source' && !view.slab; });
    check('A thick slab stays on and drawn when the MPR menu or the plane name returns to the acquired plane');

    // A pane draws its overlay in a box of the pane's own size, which is one unit until the pane is measured. Shown then,
    // the handles on the plane lines cover the pane in their colours: note every frame that shows such an overlay.
    await page.evaluate(() => {
      const early = window.__earlyOverlays = [];
      const watch = () => {
        for (const overlay of document.querySelectorAll('[data-testid="annotation-overlay"]')) {
          if (overlay.getAttribute('viewBox') === '0 0 1 1' && getComputedStyle(overlay).visibility !== 'hidden') early.push(overlay.dataset.plane);
        }
        if (window.__earlyOverlays === early) requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });
    await budget.task('mpr', () => toggleMpr(page), { until: () => page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 3) });
    const planes = await page.locator('canvas[data-renderer]').evaluateAll(nodes => nodes.map(node => node.dataset.plane).sort());
    assert.deepEqual(planes, ['axial', 'coronal', 'sagittal']);
    const early = await page.evaluate(() => { const seen = window.__earlyOverlays; delete window.__earlyOverlays; return seen; });
    assert.deepEqual(early, [], 'A pane showed its overlay before the pane was measured.');
    check('Three-plane MPR');
    await screenshot('after-mpr.png');

    // The MPR's lines: a line's body drags its plane, a handle turns both other planes about the pane's own normal (so
    // they stay square even where that pane is tilted), and a pane paged takes the crosshair with it, so each pane's
    // lines cross at the crosshair's gap.
    {
      const cells = page.locator('[data-testid="viewport-cell"]');
      const mprState = () => page.evaluate(() => window.__VEACOM_TEST__.state());
      const lines = async index => {
        const box = await cells.nth(index).boundingBox();
        return cells.nth(index).locator('[data-reference-plane]').evaluateAll((groups, box) => groups.map(group => ({
          id: group.getAttribute('data-reference-plane'),
          points: [...(group.querySelector('path').getAttribute('d') ?? '').matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(m => [Number(m[1]) + box.x, Number(m[2]) + box.y]),
          handles: [...group.querySelectorAll('circle')].map(c => [Number(c.getAttribute('cx')) + box.x, Number(c.getAttribute('cy')) + box.y]),
        })), box);
      };
      const crossing = (a, b) => {
        const [p, q] = [a.points[0], a.points.at(-1)], [r, s] = [b.points[0], b.points.at(-1)];
        const d1 = [q[0] - p[0], q[1] - p[1]], d2 = [s[0] - r[0], s[1] - r[1]], det = d1[0] * d2[1] - d1[1] * d2[0];
        const t = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / det;
        return [p[0] + t * d1[0], p[1] + t * d1[1]];
      };
      const drag = async (from, to) => {
        await page.mouse.move(...from); await page.mouse.down();
        for (let i = 1; i <= 10; i++) await page.mouse.move(from[0] + (to[0] - from[0]) * i / 10, from[1] + (to[1] - from[1]) * i / 10);
        await page.mouse.up(); await page.waitForTimeout(200);
      };
      const turn = async (index, degrees) => {
        const [line, other] = await lines(index), pivot = crossing(line, other), handle = line.handles[0];
        const radius = Math.hypot(handle[0] - pivot[0], handle[1] - pivot[1]), start = Math.atan2(handle[1] - pivot[1], handle[0] - pivot[0]);
        await page.mouse.move(...handle); await page.mouse.down();
        for (let i = 1; i <= 10; i++) { const angle = start + degrees * Math.PI / 180 * i / 10; await page.mouse.move(pivot[0] + radius * Math.cos(angle), pivot[1] + radius * Math.sin(angle)); }
        await page.mouse.up(); await page.waitForTimeout(200);
      };
      const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      // The pane's line, dragged 30 px across a fifth of the way along: the pane showing that plane pages, the others stay.
      const before = await mprState(), [held] = await lines(0), moved = before.panes.findIndex(pane => pane.id === held.id);
      const [p, q] = [held.points[0], held.points.at(-1)], length = Math.hypot(q[0] - p[0], q[1] - p[1]), at = [p[0] + (q[0] - p[0]) * 0.2, p[1] + (q[1] - p[1]) * 0.2];
      await drag(at, [at[0] - (q[1] - p[1]) / length * 30, at[1] + (q[0] - p[0]) / length * 30]);
      const dragged = await mprState();
      assert.deepEqual(dragged.panes.map((pane, index) => pane.slice !== before.panes[index].slice), [0, 1, 2].map(index => index === moved), 'A line dragged pages its own plane alone.');
      await turn(0, 30); await turn(1, 25);
      const turned = await mprState(), normals = turned.panes.map(pane => unit(pane.frame.normal));
      for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) assert.ok(Math.abs(dot(normals[a], normals[b])) < 0.005, `Planes ${a + 1} and ${b + 1} are no longer square.`);
      const box = await cells.nth(0).boundingBox();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(50); }
      await page.waitForTimeout(300);
      const paged = await mprState(), plane = paged.panes[0].frame;
      assert.notEqual(paged.panes[0].slice, turned.panes[0].slice, 'The wheel paged the first pane.');
      assert.ok(Math.abs(dot(unit(plane.normal), paged.crosshair.map((x, i) => x - plane.center[i]))) < 0.05, 'The crosshair stayed behind the paged plane.');
      for (let index = 0; index < 3; index++) {
        const shown = await lines(index), meet = crossing(shown[0], shown[1]);
        for (const line of shown.filter(item => item.points.length >= 4)) {
          const gap = [(line.points[1][0] + line.points[2][0]) / 2, (line.points[1][1] + line.points[2][1]) / 2];
          assert.ok(Math.hypot(gap[0] - meet[0], gap[1] - meet[1]) < 1, `Pane ${index + 1}'s gap is not where its lines cross.`);
        }
      }
      await screenshot('after-mpr-lines.png');
      check('MPR lines drag their planes, turn square from any pane, and follow paging');
    }

    await budget.task('open-3d', () => page.getByTestId('tool-3d').click(), { until: async () => {
      await page.getByTestId('volume-view').waitFor();
      await page.getByTestId('volume-3d-canvas').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid="volume-3d-canvas"]')?.width > 10);
    } });
    await screenshot('after-3d.png');
    check('3D surgical view opens');
    const volumeCanvas = await page.getByTestId('volume-3d-canvas').boundingBox();
    const center = [volumeCanvas.x + volumeCanvas.width / 2, volumeCanvas.y + volumeCanvas.height / 2];
    await budget.task('3d-pick', async () => { await page.getByTestId('volume-mode-pick').click(); await page.mouse.click(...center); },
      { until: () => page.getByTestId('volume-linked-marker').waitFor({ state: 'visible' }) });
    const marker = await page.getByTestId('volume-linked-marker').boundingBox();
    assert(marker.x >= volumeCanvas.x && marker.x < volumeCanvas.x + volumeCanvas.width);
    assert(marker.y >= volumeCanvas.y && marker.y < volumeCanvas.y + volumeCanvas.height);
    check('3D linked point is visible');
    await budget.task('burr', async () => {
      await page.getByTestId('volume-mode-burr').click();
      await page.getByTestId('volume-burr-diameter').selectOption('8');
      await page.mouse.click(...center);
    }, { until: () => page.waitForFunction(() => Number(document.querySelector('[data-testid="volume-removed"]')?.dataset.removedVoxels) > 0) });
    await screenshot('after-burr.png');
    check('Virtual burr removes voxels');
    await budget.task('burr-undo', () => page.locator('[data-testid="volume-undo"][data-undo-count="1"]').click(),
      { until: () => page.waitForFunction(() => document.querySelector('[data-testid="volume-removed"]')?.dataset.removedVoxels === '0') });
    check('Burr undo restores the volume');
    await budget.task('close-3d', () => page.getByTestId('volume-close').click(), { until: () => page.getByTestId('volume-view').waitFor({ state: 'detached' }) });
    // On a CT the assessment button opens the pre-op checklist; the MR assessment is checked by check-click-budget.cjs.
    await budget.task('checklist-open', () => page.getByTestId('tool-assessment').click(), { until: () => page.getByTestId('preop-checklist').waitFor() });
    await screenshot('after-checklist.png');
    check('Pre-op checklist opens on a CT');
    await budget.task('checklist-close', () => page.locator('[data-action="checklist-close"]').click(), { until: () => page.getByTestId('preop-checklist').waitFor({ state: 'detached' }) });

    // A fresh profile starts in Turkish; the switch changes the interface and is saved for the next start.
    const app = page.getByTestId('veacom-app');
    assert.equal(await app.getAttribute('data-locale'), process.env.VEACOM_LOCALE || 'tr');
    assert.equal(await page.evaluate(() => document.documentElement.lang), process.env.VEACOM_LOCALE || 'tr');
    await page.getByTestId('tool-language').click();
    await page.getByTestId('language-en').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.locale === 'en');
    // Toolbar names are the accessible names (aria-label); the visual tooltip repeats them.
    assert.equal(await page.getByTestId('tool-3d').getAttribute('aria-label'), 'Open 3D surgical view');
    const saved = async () => { try { return JSON.parse(await fs.readFile(path.join(userData, 'preferences.json'), 'utf8')).locale; } catch { return null; } };
    for (let attempt = 0; attempt < 50 && await saved() !== 'en'; attempt++) await page.waitForTimeout(100);
    assert.equal(await saved(), 'en');
    await page.getByTestId('tool-language').click();
    await page.getByTestId('language-tr').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.dataset.locale === 'tr');
    assert.equal(await page.getByTestId('tool-3d').getAttribute('aria-label'), '3D cerrahi görünümü aç');
    for (let attempt = 0; attempt < 50 && await saved() !== 'tr'; attempt++) await page.waitForTimeout(100);
    assert.equal(await saved(), 'tr');
    check('Turkish by default; the language switch updates the interface and is saved');

    // Feedback stands with the language and the version at the right end of the status bar, and keeps its place while the
    // state on the left changes length.
    const feedbackBox = () => page.getByTestId('feedback-open').boundingBox();
    const feedback = await feedbackBox(), language = await page.getByTestId('tool-language').boundingBox(), cine = await page.locator('.status-play').boundingBox();
    assert(feedback.x > cine.x + cine.width, 'Feedback is to the right of the cine controls.');
    const gap = language.x - (feedback.x + feedback.width);
    assert(gap >= 0 && gap <= 16, `Feedback stands just before the language: ${gap} px between them.`);
    const stateText = await page.evaluate(() => { const status = document.querySelector('[data-testid="status-text"]'), text = status.textContent; status.textContent = `${text} ${text} ${text}`; return text; });
    const withLongerState = await feedbackBox();
    await page.evaluate(text => { document.querySelector('[data-testid="status-text"]').textContent = text; }, stateText);
    assert.equal(withLongerState.x, feedback.x, 'A longer state text leaves Feedback where it is.');
    check('Feedback stands with the language at the right end of the status bar and keeps its place');

    // Usage timings: a fresh profile is asked once (a strip, not a modal); the answer is saved, and the
    // settings switch turns sharing on and off (off deletes the local copy).
    const preferences = async () => { try { return JSON.parse(await fs.readFile(path.join(userData, 'preferences.json'), 'utf8')); } catch { return {}; } };
    const waitPreference = async value => { for (let attempt = 0; attempt < 50 && (await preferences()).usageConsent !== value; attempt++) await page.waitForTimeout(100); assert.equal((await preferences()).usageConsent, value); };
    if (!process.env.VEACOM_TELEMETRY_CONSENT) {
      await page.getByTestId('usage-consent').waitFor();
      await budget.task('usage-consent-answer', () => page.getByTestId('usage-consent-decline').click(), { until: () => page.getByTestId('usage-consent').waitFor({ state: 'detached' }) });
      await waitPreference('denied');
      if (!await page.getByTestId('inspector-tab-display').isVisible()) await page.getByTestId('tool-inspector').click();
      await page.getByTestId('inspector-tab-display').click();
      const sharing = page.getByTestId('usage-sharing');
      assert.equal(await sharing.isChecked(), false);
      await budget.task('usage-setting', () => sharing.click(), { until: () => waitPreference('granted') });
      await page.waitForTimeout(2500);
      await sharing.click(); await waitPreference('denied');
      await fs.access(path.join(userData, 'usage')).then(() => { throw new Error('The local usage copy was kept after sharing was turned off.'); }, () => {});
      await page.getByTestId('tool-inspector').click();
      check('Usage timings consent: asked once, saved, and switched off in settings');
    }
    budget.assert();
    check('Click budgets', budget.results);
    const gpu = await desktop.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic'), metrics: app.getAppMetrics() }));
    if (expectedRenderer !== 'software') {
      assert.equal(await page.getByTestId('software-rendering-notice').count(), 0, 'Software-drawing notice shown with a graphics driver');
      check('No software-drawing notice', gpu.features.webgl);
    }
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('; ')}`);
    check('No renderer errors');
    await fs.writeFile(path.join(output, 'desktop-smoke.json'), JSON.stringify({ passed: true, expectedRenderer, checks, errors, gpu, study, platform: process.platform }, null, 2));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    await fs.writeFile(path.join(output, 'desktop-smoke.json'), JSON.stringify({ passed: false, expectedRenderer, error: error.stack, checks, errors, study }, null, 2));
    throw error;
  } finally { await closeDesktop(desktop); await fs.rm(userData, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
