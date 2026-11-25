import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { _electron } from 'playwright';
import { closeDesktop } from './lib/close-desktop.cjs';

const [study, output] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const app = await _electron.launch({ args: [process.cwd(), '--study', study], env: {
  ...process.env, VEACOM_USER_DATA: path.join(path.dirname(study), 'before-profile'), VEACOM_TEST_MODE: '1',
  VEACOM_LOCALE: 'en', VEACOM_TELEMETRY_CONSENT: 'denied',
} });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 820));
  await page.waitForFunction(() => window.__VEACOM_TEST__?.state().series.length === 3);
  const id = await page.evaluate(() => {
    const h = window.__VEACOM_TEST__, id = h.state().series.find(s => s.description === 'variable').id;
    h.selectSeries(id);
    return id;
  });
  await page.waitForFunction(id => {
    const s = window.__VEACOM_TEST__.state();
    return s.activeSeriesId === id && s.fullVolumeLoaded && document.querySelector('canvas[data-series-id]')?.dataset.seriesId === id;
  }, id);
  await page.getByTestId('status-play').click();
  const fps = await page.getByTestId('status-fps').inputValue();
  assert.equal(fps, '10');
  assert.equal(await page.locator('[data-action="status-dicom-timing"]').count(), 0);
  await page.screenshot({ path: path.join(output,'before-cine-en.png') });
  await page.getByTestId('tool-language').click();
  await page.getByTestId('language-tr').click();
  await page.locator('[data-testid="veacom-app"][data-locale="tr"]').waitFor();
  await page.screenshot({ path: path.join(output,'before-cine-tr.png') });
  await writeFile(path.join(output, 'baseline.json'), JSON.stringify({ base:'ac84997d4c3883ffb09b5054513f8a87b9235bc5', clip:'variable', displayedFps: Number(fps) }) + '\n');
} finally { await closeDesktop(app); }
