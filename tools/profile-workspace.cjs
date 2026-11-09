// node tools/profile-workspace.cjs --ct=PATH --mr=PATH --output=FILE.json [--app=PATH] [--change-units=true] [--change-tool=true] [--check-release=true] [--heap=FILE]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const privileged = require('./privileged-imaging.cjs');
const { ignoreOutsideInput } = require('./lib/outside-input.cjs');
const { closeDesktop } = require('./lib/close-desktop.cjs');
const exec = promisify(execFile);
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const equal = argument.indexOf('='); return [argument.slice(2, equal), argument.slice(equal + 1)];
}));
assert(options.ct && options.mr && options.output, 'Pass --ct, --mr and --output.');
const repo = path.resolve(options.app || path.join(__dirname, '..'));

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-workspace-'));
  const snapshots = [], errors = [];
  let desktop;
  try {
    desktop = await electron.launch({ args: [repo], env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90_000 });
    const page = await desktop.firstWindow();
    // Real input from the computer would change what is measured; the window shows without taking it.
    await ignoreOutsideInput(desktop);
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.getAttribute('data-ready') === 'true');
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1280, 800);
      // Only on Windows, where ignoreOutsideInput does nothing: elsewhere the window is already shown and must not take
      // the keyboard, and on macOS focus() would make the app the active one, which the helper answers by hiding it.
      if (process.platform === 'win32') { window.show(); window.focus(); }
    });
    const cdp = await page.context().newCDPSession(page);
    await page.evaluate(() => {
      const textures = new WeakMap(), sizes = new Map(), bindings = new WeakMap();
      let next = 1, uploads = 0, deletes = 0;
      const prototype = WebGL2RenderingContext.prototype;
      const bind = prototype.bindTexture, remove = prototype.deleteTexture;
      prototype.bindTexture = function (target, texture) {
        let current = bindings.get(this); if (!current) { current = new Map(); bindings.set(this, current); }
        current.set(target, texture);
        return bind.call(this, target, texture);
      };
      prototype.deleteTexture = function (texture) {
        const id = textures.get(texture);
        if (sizes.delete(id)) deletes++;
        const current = bindings.get(this);
        if (current) for (const [target, bound] of current) if (bound === texture) current.delete(target);
        return remove.call(this, texture);
      };
      for (const [method, depthIndex] of [['texImage2D', null], ['texImage3D', 5]]) {
        const original = prototype[method];
        prototype[method] = function (...args) {
          const result = original.apply(this, args);
          if (args.length < (depthIndex === null ? 9 : 10)) return result;
          const texture = bindings.get(this)?.get(args[0]);
          if (!texture) return result;
          let id = textures.get(texture); if (!id) { id = next++; textures.set(texture, id); }
          const formats = new Map([[this.R8UI, 1], [this.R16I, 2], [this.R16UI, 2], [this.R32F, 4], [this.RGBA32F, 16], [this.RGB8, 4], [this.RGBA8, 4]]);
          const bytesPerPixel = formats.get(args[2]);
          if (bytesPerPixel === undefined) throw new Error(`Unmeasured texture format: ${args[2]}`);
          sizes.set(id, args[3] * args[4] * (depthIndex === null ? 1 : args[depthIndex]) * bytesPerPixel);
          uploads++;
          return result;
        };
      }
      window.__textureProfile = () => ({ estimatedTextureMiB: [...sizes.values()].reduce((a, b) => a + b, 0) / 1024 ** 2,
        textureCount: sizes.size, uploads, deletes });
    });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Milliseconds from the empty workspace to each snapshot: how long the loads and switches took.
    let started;
    const snapshot = async label => {
      await settle();
      started ??= performance.now();
      const state = await page.evaluate(() => ({ ...window.__VEACOM_TEST__.state(), gpu: window.__textureProfile() }));
      const heap = await cdp.send('Runtime.getHeapUsage');
      let summedRssMiB = null;
      if (process.platform !== 'win32') {
        const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
        const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
        const owned = new Set([desktop.process().pid]);
        for (let size = 0; size !== owned.size;) {
          size = owned.size; for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid);
        }
        summedRssMiB = rows.filter(([pid]) => owned.has(pid)).reduce((sum, row) => sum + row[2], 0) / 1024;
      }
      const result = { label, atMs: Math.round(performance.now() - started), cachedMiB: state.cachedBytes / 1024 ** 2, activeSeriesId: state.activeSeriesId,
        loadedSeriesCount: state.loadedSeriesIds.length, gpu: state.gpu, summedRssMiB, rendererHeap: heap };
      snapshots.push(result); console.log(JSON.stringify(result));
    };
    const select = async id => {
      await page.evaluate(id => window.__VEACOM_TEST__.selectSeries(id), id);
      await page.waitForFunction(id => {
        const state = window.__VEACOM_TEST__.state();
        return state.activeSeriesId === id && state.fullVolumeLoaded && document.querySelector('canvas[data-series-id]')?.getAttribute('data-series-id') === id;
      }, id, { timeout: 90_000 });
      await settle();
    };
    const importStudy = async folder => {
      await privileged.importPaths(desktop, page, [path.resolve(folder)]);
      await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
      await settle();
    };
    const fingerprint = async () => crypto.createHash('sha256').update(await page.locator('canvas[data-renderer]').first().evaluate(canvas => canvas.toDataURL())).digest('hex');
    const closeImage = async () => {
      // The current UI exposes Close only in multi-pane layouts.
      await page.getByTestId('tool-layout').click();
      await page.locator('[data-layout="1x2"]').click();
      await page.locator('.viewport-cell:not([data-series-id=""])').getByTestId('viewport-close').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__VEACOM_TEST__.state().activeSeriesId === null);
    };
    await snapshot('empty');
    await importStudy(options.ct);
    const ctId = await page.evaluate(() => window.__VEACOM_TEST__.state().activeSeriesId);
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: 50 }));
    await page.waitForFunction(() => document.querySelector('canvas[data-slice]')?.dataset.slice === '50');
    const beforePixels = await fingerprint();
    await snapshot('ct-source');
    if (options['change-units'] === 'true') {
      await page.getByTestId('tool-inspector').click();
      await page.getByTestId('inspector-tab-display').click();
      const section = page.locator('#section-units-toggle');
      if (await section.getAttribute('aria-expanded') !== 'true') await section.click();
      await page.locator('[data-section="units"] select').first().selectOption('px');
      await page.getByTestId('tool-inspector').click();
      await settle();
    }
    if (options['change-tool'] === 'true') {
      const scrollTool = page.getByTestId('tool-quick-scroll');
      await scrollTool.click();
      assert.equal(await scrollTool.getAttribute('aria-pressed'), 'true');
      await settle();
    }
    await page.getByTestId('tool-mpr').click();
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 3);
    await snapshot('ct-mpr');
    await page.getByTestId('tool-mpr').click();
    await page.waitForFunction(() => document.querySelectorAll('canvas[data-renderer]').length === 1);
    await closeImage();
    await snapshot('ct-closed');
    await select(ctId);
    await page.evaluate(() => window.__VEACOM_TEST__.setView({ slice: 50 }));
    await page.waitForFunction(() => document.querySelector('canvas[data-slice]')?.dataset.slice === '50');
    assert.equal(await fingerprint(), beforePixels, 'Reopening must preserve the same slice pixels.');
    await snapshot('ct-reopened');
    await importStudy(options.mr);
    const mrIds = await page.evaluate(ctId => window.__VEACOM_TEST__.state().series.map(series => series.id).filter(id => id !== ctId), ctId);
    assert.equal(mrIds.length, 8, 'Use the eight-series MR benchmark fixture.');
    for (let cycle = 1; cycle <= 3; cycle++) {
      for (const id of mrIds) await select(id);
      await snapshot(`mr-cycle-${cycle}`);
    }
    assert(await page.evaluate(id => !window.__VEACOM_TEST__.state().loadedSeriesIds.includes(id), ctId), 'The MR workflow must evict the large CT from the application cache.');
    await cdp.send('HeapProfiler.collectGarbage');
    await snapshot('mr-after-diagnostic-gc');
    await closeImage();
    await snapshot('all-closed');
    await cdp.send('HeapProfiler.collectGarbage');
    await snapshot('all-closed-after-diagnostic-gc');
    const releaseChecks = {
      closedTexturesReleased: snapshots.filter(snapshot => snapshot.activeSeriesId === null).every(snapshot => snapshot.gpu.estimatedTextureMiB <= 16 / 1024 ** 2),
      evictedBuffersCollectible: snapshots.filter(snapshot => snapshot.label.endsWith('after-diagnostic-gc')).every(snapshot => snapshot.rendererHeap.backingStorageSize < (snapshot.cachedMiB + 64) * 1024 ** 2),
    };
    if (options.heap) {
      const chunks = [];
      const collect = ({ chunk }) => chunks.push(chunk);
      cdp.on('HeapProfiler.addHeapSnapshotChunk', collect);
      await cdp.send('HeapProfiler.takeHeapSnapshot');
      cdp.off('HeapProfiler.addHeapSnapshotChunk', collect);
      await fs.writeFile(path.resolve(options.heap), chunks.join(''));
    }
    assert.deepEqual(errors, []);
    const output = path.resolve(options.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify({ repo, platform: process.platform,
      scenario: { changeUnits: options['change-units'] === 'true', changeTool: options['change-tool'] === 'true' },
      snapshots, errors, releaseChecks,
      notes: ['Estimated texture storage counts explicit texImage2D/3D allocation and deleteTexture calls, not driver-reported VRAM.',
        'RGB8 is conservatively counted as RGBA8. GPU instrumentation does not retain source pixel arrays.',
        'Summed process RSS can count shared pages repeatedly and is not unique physical RAM.',
        'Explicit GC checks whether evicted buffers are collectible with a pane open and after closing; it is not part of normal application behaviour.'], reopenedPixelsMatch: true }, null, 2));
    if (options['check-release'] === 'true') {
      assert(releaseChecks.closedTexturesReleased, 'An empty workspace retains image textures.');
      assert(releaseChecks.evictedBuffersCollectible, 'Evicted pixel buffers remain strongly reachable after collection.');
    }
  } finally {
    await closeDesktop(desktop);
    await fs.rm(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
