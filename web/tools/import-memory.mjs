// Open 1,024 real files in the published viewer. Measure WebAssembly memory before requesting the volume.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveVeacom } from '../../tools/browser-bench/lib/serve.mjs';
import { element } from '../../tools/fixtures/dicom-elements.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(repository, 'web/site/public'));
const scratch = mkdtempSync(path.join(tmpdir(), 'veacom-import-memory-'));
const fixture = path.join(scratch, 'study');
const uid = '2.25.302617644913925066835652647005517224101';

function makeStudy() {
  execFileSync(process.execPath, [path.join(repository, 'tools/fixtures/make-smoke-study.mjs'), fixture, '--many-small']);
  const dir = path.join(fixture, 'S01');
  const files = readdirSync(dir).sort().map(name => path.join(dir, name));
  const pixels = createHash('sha256');
  const studyUid = element(0x0020, 0x000d, 'UI', uid + '.1');
  const padding = Buffer.alloc(64 * 1024);
  const trailing = element(0xfffc, 0xfffc, 'OB', padding);
  const beforeStudy = Buffer.concat([element(0x0019, 0x0010, 'LO', 'VEACOM FIXTURE'), element(0x0019, 0x1001, 'OB', padding)]);
  for (const [i, file] of files.entries()) {
    const source = readFileSync(file);
    pixels.update(source.subarray(-16 * 16 * 2));
    // Every eighth file keeps its study and series identifiers beyond the prefetched bytes.
    if (i % 8 === 0) {
      const offset = source.indexOf(studyUid);
      assert(offset > 132);
      writeFileSync(file, Buffer.concat([source.subarray(0, offset), beforeStudy, source.subarray(offset)]));
    } else {
      writeFileSync(file, Buffer.concat([source, trailing]));
    }
  }
  assert.equal(files.length, 1024);
  return { files, digest: pixels.digest('hex') };
}

async function check(browser, study, isolated) {
  const site = await serveVeacom(dist, { isolation: isolated });
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      window.Worker = class extends Worker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', ({ data }) => {
            const volume = data.value;
            if (volume?.bytes && volume.index === undefined) window.importVolumeDigest = crypto.subtle.digest('SHA-256', volume.bytes);
          });
        }
      };
    });
    await page.goto(site.url);
    await page.waitForFunction(() => document.documentElement.dataset.engineThreads);
    const worker = page.workers().find(item => new URL(item.url()).pathname.includes('/engine.worker-'));
    assert(worker, 'The viewer must have started its engine Worker.');
    const engine = await worker.evaluateHandle(async threaded => {
      const urls = performance.getEntriesByType('resource').map(entry => entry.name);
      for (const url of urls.filter(name => /\/veacom_web_engine-[\w-]+\.js$/.test(name))) {
        const module = await import(url);
        if (module.importPaths && Boolean(module.helperSetup) === threaded) {
          return { memory: (await module.default()).memory, listed: module.listedFiles };
        }
      }
      throw Error('Cannot find the engine module loaded by the viewer.');
    }, isolated);
    const before = await engine.evaluate(state => state.memory.buffer.byteLength);
    // Hold the reader's first pixel requests until the engine's catalog memory has been sampled.
    await page.evaluate(() => {
      const bridge = window.veacom;
      const fetch = bridge.fetchPixels;
      const gate = Promise.withResolvers();
      window.resumeImportPixels = gate.resolve;
      bridge.fetchPixels = async (...args) => {
        window.importPixelsWaiting = true;
        await gate.promise;
        return fetch(...args);
      };
    });
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('welcome-open-files').click();
    await (await chooser).setFiles(study.files);
    await page.waitForFunction(() => window.importPixelsWaiting);
    const after = await engine.evaluate(state => ({ memory: state.memory.buffer.byteLength, listed: state.listed().length }));
    assert.equal(after.listed, study.files.length);
    const series = await page.evaluate(async () => (await window.veacom.listSeries()).series);
    assert.equal(series.length, 1);
    const [ct] = series;
    assert.equal(ct.patientId, 'SYNTHETIC-SMOKE');
    assert.equal(ct.studyUid, uid + '.1');
    assert.equal(ct.uid, uid + '.2');
    assert.deepEqual(ct.dimensions, [16, 16, 1024]);
    assert.deepEqual(ct.frameMetadata.map(frame => frame.sopInstanceUid), study.files.map((_, i) => uid + '.3.' + (i + 1)));
    assert.equal(await page.evaluate(() => Boolean(window.importVolumeDigest)), false);
    await page.evaluate(() => window.resumeImportPixels());
    await page.waitForFunction(() => Boolean(window.importVolumeDigest));
    const digest = await page.evaluate(async () => {
      return Array.from(new Uint8Array(await window.importVolumeDigest), byte => byte.toString(16).padStart(2, '0')).join('');
    });
    assert.equal(digest, study.digest);
    return { isolated, sources: after.listed, before, after: after.memory, growth: after.memory - before, pixelSha256: digest };
  } finally {
    await page.close();
    await site.close();
  }
}

let browser;
try {
  const study = makeStudy();
  browser = await chromium.launch();
  const results = [];
  for (const isolated of [true, false]) results.push(await check(browser, study, isolated));
  const report = JSON.stringify(results, null, 2);
  console.log(report);
  if (process.argv[3]) writeFileSync(process.argv[3], report + '\n');
  // The released engine used 71.75 to 71.88 MiB on Linux, macOS and Windows.
  for (const result of results) assert(result.growth < 80 * 1024 * 1024, 'Cataloging the test study exceeded 80 MiB of additional WebAssembly memory.');
} finally {
  await browser?.close();
  rmSync(scratch, { recursive: true, force: true });
}
