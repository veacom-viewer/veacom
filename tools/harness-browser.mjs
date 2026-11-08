// The browser a tools/ harness check drives: installed Chrome by default (VEACOM_BROWSER_CHANNEL, and
// VEACOM_BROWSER_ARGS for extra switches), or with VEACOM_HARNESS_ELECTRON=1 VEAcom's own Electron, as Linux CI runs
// it on Mesa llvmpipe under Xvfb (check-harness.mjs, .github/workflows/ci.yml), like the renderer suite.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ignoreOutsideInput, launchDesktop } from './lib/outside-input.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A page of `width` × `height` CSS pixels, and how to close it. The check navigates the page itself. */
export async function launchHarness({ width = 640, height = 640 } = {}) {
  if (process.env.VEACOM_HARNESS_ELECTRON === '1') {
    const userData = await mkdtemp(path.join(tmpdir(), 'veacom-harness-'));
    // Under Xvfb the window can count as hidden, and Chromium then stops its animation frames, which every check waits
    // for. Like the desktop checks, the window takes neither the focus nor the real mouse (lib/outside-input.cjs): a
    // check's input comes through Playwright, and a stray move by whoever uses the computer ends a held drag.
    const app = await launchDesktop({ args: [root, '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'], timeout: 90_000,
      env: { ...process.env, VEACOM_DEV_URL: process.env.VEACOM_TEST_URL ?? 'http://127.0.0.1:5188/tools/viewport-check.html', VEACOM_USER_DATA: userData } });
    const page = await app.firstWindow();
    // Shielded before its first page had loaded, the window sometimes never finished the check's own navigation (macOS,
    // with a freshly started Vite server).
    await page.waitForLoadState('load');
    await ignoreOutsideInput(app);
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(1, 1); window.setContentSize(size.width, size.height);
    }, { width, height });
    await page.setViewportSize({ width, height });
    return { page, close: async () => { await app.close().catch(() => {}); await rm(userData, { recursive: true, force: true }).catch(() => {}); } };
  }
  const browser = await chromium.launch({ channel: process.env.VEACOM_BROWSER_CHANNEL ?? 'chrome', headless: true,
    args: ['--enable-gpu', ...(process.env.VEACOM_BROWSER_ARGS ?? '').split(/\s+/).filter(Boolean)] });
  const page = await browser.newPage({ viewport: { width, height } });
  return { page, close: () => browser.close() };
}
