// Run with node --import ./tests/setup.ts against the synthetic PET follow-up fixture.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const [before, after, fixture, output] = process.argv.slice(2).map(value => path.resolve(value));
assert(output, 'Pass the before and after checkout paths, fixture folder and output JSON path.');
const data = JSON.parse(await readFile(path.join(fixture, 'manifest.json'), 'utf8'));
assert(data.synthetic);
const study = data.studies.find(item => item.name === 'current');
const pet = study.series.find(item => item.modality === 'PT');
const directory = path.join(fixture, study.folder, pet.folder);
const { center, radius } = study.lesions[0];
const commits = Object.fromEntries(Object.entries({ before, after }).map(([key, cwd]) => [key, execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()]));
const samples = [];
for (const [label, root] of [['before', before], ['after', after]]) {
  const local = file => import(pathToFileURL(path.join(root, file)).href);
  const { EngineProcess } = await local('electron/engine-process.cjs');
  const { ImagingBroker } = await local('electron/imaging-broker.cjs');
  const engine = new EngineProcess({ binary: path.join(root, 'native', 'target', 'release', process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core') });
  const broker = new ImagingBroker({ engine, warmFirstVolume: false });
  try {
    const connection = await engine.start();
    const { series: [series] } = await broker.importSelected(await broker.authorizeImportPaths([directory]));
    assert.equal(series.modality, 'PT');
    let measure, transferMs = null;
    if (label === 'before') {
      const { quantitativeScale } = await local('src/imaging/annotations.ts');
      const { sphereStatistics, thresholdVolume, THRESHOLDS } = await local('src/imaging/voi.ts');
      const started = performance.now(), response = await connection.request('volume', { id: series.id });
      const types = { uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array, float32: Float32Array, float64: Float64Array };
      assert(response.ok);
      const volume = { series, data: new types[response.headers.get('x-pixel-type')](await response.arrayBuffer()) };
      transferMs = performance.now() - started;
      const quantity = quantitativeScale(series);
      measure = sphere => {
        const stats = sphereStatistics(volume, sphere, quantity);
        return { ...stats, metabolic: thresholdVolume(volume, sphere, quantity, THRESHOLDS[0], stats) };
      };
    } else {
      measure = sphere => broker.measure(series.id, connection.generation, series.sourceRevision, { kind: 'sphere', ...sphere, threshold: 'max41' });
    }
    const runs = [];
    for (let i = 0; i < 31; i++) {
      const sphere = { center: [center[0] + (i % 4) / 4, center[1], center[2]], radius };
      const start = performance.now(), result = await measure(sphere);
      runs.push({ elapsedMs: performance.now() - start, count: result.count, mean: result.mean, peak: result.peak.value, mtvMl: result.metabolic.mtvMl });
    }
    samples.push({ label, transferMs, runs });
  } finally { broker.dispose(); await engine.stop(); }
}
for (let i = 0; i < 31; i++) {
  for (const k of ['count', 'mean', 'peak', 'mtvMl']) {
    assert(Math.abs(samples[0].runs[i][k] - samples[1].runs[i][k]) < 1e-6, 'Measurement mismatch for ' + k);
  }
}
await writeFile(output, JSON.stringify({ commits, fixture: data.generator, measurements: 'SUV sphere statistics, SUVpeak and MTV at 41% of SUVmax', samples }, null, 2) + '\n');
