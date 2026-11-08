import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const output = process.argv[2];
if (!output) throw new Error('Usage: node tools/check-browser-gpu.mjs <output-directory>');
await mkdir(output, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: false } });
let browser;
try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: process.env.VEACOM_BROWSER_CHANNEL || 'chrome', headless: true, args: ['--enable-gpu'] });
  for (const variant of ['parallel', 'fallback']) {
    const page = await browser.newPage();
    await page.goto(new URL(`tools/renderer-check.html${variant === 'fallback' ? '?no-parallel' : ''}`, base).href);
    await page.waitForFunction(() => window.rendererCheckResult, undefined, { timeout: 120000 });
    const result = await page.evaluate(() => window.rendererCheckResult);
    await writeFile(path.join(output, `${variant}.json`), JSON.stringify(result, null, 2) + '\n');
    assert(result.passed === true && result.checks > 0, JSON.stringify(result.failures || result.error));
    console.log(`PASS ${variant}: ${result.checks} GPU checks`);
    await page.close();
  }
  await browser.close(); browser = undefined;
  const { stdout } = await promisify(execFile)(process.execPath, ['tools/check-harness.mjs'], {
    env: { ...process.env, VEACOM_TEST_URL: new URL('tools/viewport-check.html', base).href, VEACOM_SKIP_GPU_CHECKS: '1' }, timeout: 600000,
  });
  console.log(stdout.trim());
} finally {
  if (browser) await browser.close();
  await server.close();
}
