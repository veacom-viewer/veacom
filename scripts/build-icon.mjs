// On macOS: node scripts/build-icon.mjs
// Uses the original SVG, Chromium's SVG renderer, and Apple's iconutil.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') throw new Error('Build the ICNS icon on macOS; iconutil is supplied by macOS.');
const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const icons = path.join(root, 'public/icons');
const output = path.join(icons, 'veacom.icns');
const svg = await readFile(path.join(icons, 'veacom.svg'), 'utf8');
const temporary = await mkdtemp(path.join(tmpdir(), 'veacom-icon-'));
const iconset = path.join(temporary, 'veacom.iconset');
const chrome = process.env.VEACOM_ICON_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  await mkdir(iconset);
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
  const rendered = new Map();
  for (const logicalSize of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = logicalSize * scale;
      if (!rendered.has(pixels)) {
        await page.setViewportSize({ width: pixels, height: pixels });
        await page.locator('svg').evaluate((element, size) => {
          element.style.width = `${size}px`; element.style.height = `${size}px`;
        }, pixels);
        rendered.set(pixels, await page.locator('svg').screenshot({ omitBackground: true, animations: 'disabled' }));
      }
      await writeFile(path.join(iconset, `icon_${logicalSize}x${logicalSize}${scale === 2 ? '@2x' : ''}.png`), rendered.get(pixels));
    }
  }
  const generated = path.join(temporary, 'veacom.icns');
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', generated]);
  const bytes = await readFile(generated);
  if (bytes.toString('ascii', 0, 4) !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) throw new Error('iconutil produced an invalid ICNS container.');

  const roundtrip = path.join(temporary, 'verified.iconset');
  await run('/usr/bin/iconutil', ['-c', 'iconset', generated, '-o', roundtrip]);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const png = await readFile(path.join(roundtrip, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
      if (png.readUInt32BE(16) !== pixels || png.readUInt32BE(20) !== pixels) throw new Error(`Icon size ${pixels} did not survive ICNS conversion.`);
      const difference = await page.evaluate(async ({ original, decoded, size }) => {
        const pixels = async data => {
          const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, size, size).data;
        };
        const a = await pixels(original), b = await pixels(decoded);
        let alpha = 0, opaqueColor = 0;
        for (let index = 0; index < a.length; index += 4) {
          alpha = Math.max(alpha, Math.abs(a[index + 3] - b[index + 3]));
          if (a[index + 3] === 255 && b[index + 3] === 255) for (let channel = 0; channel < 3; channel++) {
            opaqueColor = Math.max(opaqueColor, Math.abs(a[index + channel] - b[index + channel]));
          }
        }
        return { alpha, opaqueColor };
      }, { original: rendered.get(pixels).toString('base64'), decoded: png.toString('base64'), size: pixels });
      // Legacy ICNS entries store antialiased edge colors premultiplied by alpha.
      if (difference.alpha || difference.opaqueColor) throw new Error(`ICNS conversion changed the original mark at ${pixels} pixels: ${JSON.stringify(difference)}`);
    }
  }
  await copyFile(generated, output);
  process.stdout.write(`Created ${output}; all 10 icon sizes retain the original SVG colors and transparency.\n`);
} finally {
  await browser?.close();
  await rm(temporary, { recursive: true, force: true });
}
