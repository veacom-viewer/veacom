// TEMPORARY probe (not for merge): what the toolbar looks like, frame by frame, around the interface check's
// 1280 × 800 → 900 × 640 resize, and what the check would measure after its two frames.
// usage: node tools/probe-toolbar.cjs STUDY_PATH [ITERATIONS] [-- app switches]
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function main() {
  const split = process.argv.indexOf('--'), own = split < 0 ? process.argv.slice(2) : process.argv.slice(2, split), switches = split < 0 ? [] : process.argv.slice(split + 1);
  const study = path.resolve(own[0]), iterations = Number(own[1] || 30);
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-probe-'));
  const desktop = await electron.launch({ args: [path.resolve(__dirname, '..'), ...switches, '--study', study], env: { ...process.env, VEACOM_USER_DATA: userData }, timeout: 90_000 });
  try {
    const page = await desktop.firstWindow();
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
    const size = (width, height) => desktop.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      const bar = () => document.querySelector('.toolbar[role="toolbar"]:not(.toolbar-second)');
      window.__probe = {
        state(label) {
          const b = bar(), style = getComputedStyle(b), items = [...b.querySelectorAll('[data-toolbar-item]')], right = items.at(-1).getBoundingClientRect();
          const wco = navigator.windowControlsOverlay?.getTitlebarAreaRect?.();
          return { label, t: Math.round(performance.now() * 10) / 10, innerWidth, clientWidth: b.clientWidth, padR: style.paddingRight, padL: style.paddingLeft,
            items: items.length, rightGap: Math.round(b.getBoundingClientRect().right - parseFloat(style.paddingRight) - right.right),
            wco: wco ? [Math.round(wco.x), Math.round(wco.width)] : null };
        },
        trace: [],
        start() {
          this.trace = []; this.on = true;
          const frame = () => { if (!this.on) return; this.trace.push(this.state('frame')); requestAnimationFrame(frame); };
          requestAnimationFrame(frame);
          this.ro = new ResizeObserver(() => this.trace.push(this.state('ro')));
          this.ro.observe(bar());
          this.mo = new MutationObserver(() => this.trace.push(this.state('dom')));
          this.mo.observe(bar(), { childList: true });
          this.resize = () => this.trace.push(this.state('resize'));
          addEventListener('resize', this.resize);
          this.geometry = () => this.trace.push(this.state('geometrychange'));
          navigator.windowControlsOverlay?.addEventListener('geometrychange', this.geometry);
        },
        stop() {
          this.on = false; this.ro.disconnect(); this.mo.disconnect(); removeEventListener('resize', this.resize);
          navigator.windowControlsOverlay?.removeEventListener('geometrychange', this.geometry);
          return this.trace;
        },
      };
    });
    // The interface check's final wait (8f11138), copied: viewport, overlay (caption room remembered) and toolbar fit.
    const layoutNow = () => page.evaluate(() => {
      const overlay = navigator.windowControlsOverlay?.visible ? navigator.windowControlsOverlay.getTitlebarAreaRect() : null;
      const bar = document.querySelector('.toolbar[role="toolbar"]:not(.toolbar-second)'), style = bar && getComputedStyle(bar);
      return { viewport: [innerWidth, innerHeight], ratio: devicePixelRatio,
        overlay: overlay && { x: overlay.x, width: overlay.width, right: innerWidth - overlay.x - overlay.width },
        fitted: bar ? Number(bar.dataset.fittedWidth) : null, content: bar ? bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) : null };
    });
    let captions = null;
    const overlaySettled = ({ overlay, ratio }) => !overlay || (captions === null
      ? (process.platform === 'darwin' ? Math.abs(overlay.right) <= 2 : overlay.right > 2)
      : Math.abs(overlay.right - captions / ratio) <= 1.5);
    const settledLayout = async viewport => {
      for (const started = Date.now(); ;) {
        const now = await layoutNow();
        if ((!viewport || (now.viewport[0] === viewport[0] && now.viewport[1] === viewport[1])) && overlaySettled(now)
          && now.fitted !== null && Math.abs(now.fitted - now.content) < 1) {
          if (captions === null && now.overlay) captions = now.overlay.right * now.ratio;
          return { ...now, waited: Date.now() - started };
        }
        if (Date.now() - started > 10_000) throw new Error(`did not settle: ${JSON.stringify(now)}`);
        await settle();
      }
    };
    const contentSize = (w, h) => desktop.evaluate(({ BrowserWindow }, [w, h]) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(w, h); return window.getContentSize(); }, [w, h]);
    const waited = [], waitedGaps = new Map();
    for (let i = 0; i < iterations; i++) {
      await contentSize(1280, 800); await page.waitForTimeout(400);
      const settledAt = await settledLayout(await contentSize(900, 640));
      const atCheck = await page.evaluate(() => window.__probe.state('check'));
      waited.push(settledAt.waited);
      waitedGaps.set(atCheck.rightGap, (waitedGaps.get(atCheck.rightGap) ?? 0) + 1);
    }
    console.log(`WITH THE WAIT: iterations ${iterations}; rightGap ${JSON.stringify(Object.fromEntries(waitedGaps))}; waited ms min ${Math.min(...waited)} median ${waited.sort((a, b) => a - b)[waited.length >> 1]} max ${Math.max(...waited)}`);
    const bad = [], gaps = new Map();
    for (let i = 0; i < iterations; i++) {
      await size(1280, 800); await page.waitForTimeout(400);
      await page.evaluate(() => window.__probe.start());
      await size(900, 640); await settle();
      const atCheck = await page.evaluate(() => window.__probe.state('check'));
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => window.__probe.state('after'));
      const trace = await page.evaluate(() => window.__probe.stop());
      gaps.set(atCheck.rightGap, (gaps.get(atCheck.rightGap) ?? 0) + 1);
      if (Math.abs(atCheck.rightGap) > 2) bad.push({ i, atCheck, after, trace });
    }
    console.log(`TWO FRAMES (the old wait): iterations ${iterations}; rightGap at the check's time: ${JSON.stringify(Object.fromEntries(gaps))}; out of range ${bad.length}`);
    for (const item of bad.slice(0, 1)) {
      console.log(`--- iteration ${item.i}: at check ${JSON.stringify(item.atCheck)}; after 400 ms ${JSON.stringify(item.after)}`);
      for (const entry of item.trace.slice(0, 40)) console.log(JSON.stringify(entry));
    }
    if (!bad.length) {
      const trace = await (async () => { await size(1280, 800); await page.waitForTimeout(400); await page.evaluate(() => window.__probe.start()); await size(900, 640); await page.waitForTimeout(300); return page.evaluate(() => window.__probe.stop()); })();
      console.log('--- a passing resize, for comparison');
      for (const entry of trace.slice(0, 25)) console.log(JSON.stringify(entry));
    }
  } finally {
    await desktop.close().catch(() => {});
    await fs.rm(userData, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
