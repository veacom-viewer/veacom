import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { serveVeacom } from '../../tools/browser-bench/lib/serve.mjs';

/** Keep the same origin and real browser profile across process exits so the reader reopens its own IndexedDB. */
export async function measurementBrowser(siteDirectory) {
  const site = await serveVeacom(siteDirectory);
  return {
    close: () => site.close(),
    async open(profile, directory, locale) {
      const context = await chromium.launchPersistentContext(profile, { locale, viewport: { width: 1360, height: 820 }, reducedMotion: 'reduce' });
      try {
        const page = context.pages()[0] ?? await context.newPage();
        page.setDefaultTimeout(10_000);
        await page.addInitScript(language => {
          if (location.protocol === 'http:') localStorage.setItem('veacom.locale', language);
        }, locale);
        await page.goto(site.url);
        const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => path.join(directory, entry.name)).sort();
        const picker = page.waitForEvent('filechooser');
        await page.getByTestId('welcome-open-files').click();
        await (await picker).setFiles(files);
        await page.waitForFunction(() => window.__VEACOM_TEST__?.state().fullVolumeLoaded, undefined, { timeout: 90_000 });
        const browser = context.browser();
        const control = await browser.newBrowserCDPSession();
        return {
          page,
          async close() { await context.close(); return true; },
          async crash() {
            let timer;
            const disconnected = new Promise((resolve, reject) => {
              browser.once('disconnected', resolve);
              timer = setTimeout(() => reject(new Error('Chromium did not exit after the crash request')), 15_000);
            });
            try {
              await Promise.all([disconnected, control.send('Browser.crash').catch(error => {
                if (!/closed|disconnected/i.test(error.message)) throw error;
              })]);
            } finally { clearTimeout(timer); }
          },
        };
      } catch (error) { await context.close(); throw error; }
    },
  };
}
