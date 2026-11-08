// Imports study folders straight into the native core (no Electron) and decodes every
// series it lists: the first source frame, and the whole volume where the series can be
// reconstructed. Segmentations are decoded as masks and their set voxels counted.
//
// Usage: node tools/check-engine-import.cjs <study-folder>... [--output=report.json]
// The core is VEACOM_CORE_PATH, or native/target/release/veacom-core.
// Exits non-zero when a folder fails to import or an image series fails to decode.
const fs = require('node:fs/promises');
const path = require('node:path');
const { EngineProcess } = require('../electron/engine-process.cjs');

const args = process.argv.slice(2);
const output = args.find(value => value.startsWith('--output='))?.slice('--output='.length);
const folders = args.filter(value => !value.startsWith('--')).map(value => path.resolve(value));
if (!folders.length) {
  console.error('Usage: node tools/check-engine-import.cjs <study-folder>... [--output=report.json]');
  process.exit(2);
}
const executable = process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core';
const binary = process.env.VEACOM_CORE_PATH || path.resolve(__dirname, '../native/target/release', executable);

async function start() {
  const engine = new EngineProcess({ binary, restartDelaysMs: [] });
  const connection = await engine.start();
  const call = async (op, body) => {
    const response = await connection.request(op, body);
    if (!response.ok) throw new Error((await response.text()) || `Engine status ${response.status}`);
    return response;
  };
  return { engine, call };
}

async function decode(call, op, body, countSet = false) {
  const started = performance.now();
  try {
    const response = await call(op, body);
    const buffer = await response.arrayBuffer();
    const pixelType = response.headers.get('x-pixel-type');
    const result = { ok: true, pixelType, bytes: buffer.byteLength, ms: Math.round(performance.now() - started) };
    if (countSet) {
      const Values = { uint8: Uint8Array, uint16: Uint16Array, int16: Int16Array, float32: Float32Array, float64: Float64Array }[pixelType];
      result.setVoxels = new Values(buffer).reduce((sum, value) => sum + (value ? 1 : 0), 0);
    }
    return result;
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

async function main() {
  const { engine, call } = await start();
  const report = [];
  let failed = false;
  try {
    for (const folder of folders) {
      const entry = { folder, series: [] };
      report.push(entry);
      const started = performance.now();
      try {
        const imported = await (await call('import', { paths: [folder] })).json();
        entry.importMs = Math.round(performance.now() - started);
        entry.warnings = imported.warnings;
        for (const series of imported.series) {
          const row = {
            modality: series.modality, description: series.description, dimensions: series.dimensions,
            canReconstruct: series.canReconstruct, window: [series.windowCenter, series.windowWidth],
            ...(series.windowFromPixels ? { windowFromPixels: true } : {}),
            ...(series.segmentation ? { segmentation: { segments: series.segmentation.segments.length, referencedSeriesUid: series.segmentation.referencedSeriesUid } } : {}),
          };
          if (series.segmentation) row.volume = await decode(call, 'volume', { id: series.id }, true);
          else {
            row.frame = await decode(call, 'frame', { id: series.id, index: 0 });
            if (series.canReconstruct) row.volume = await decode(call, 'volume', { id: series.id });
          }
          if ((row.frame && !row.frame.ok) || (row.volume && !row.volume.ok)) failed = true;
          entry.series.push(row);
        }
      } catch (error) {
        entry.error = String(error.message || error);
        failed = true;
      }
      console.log(`\n== ${path.basename(folder)}: ${entry.error ? `IMPORT FAILED ${entry.error}` : `${entry.series.length} series in ${entry.importMs} ms`}`);
      for (const row of entry.series) {
        const kind = row.segmentation ? `segmentation (${row.segmentation.segments} segment${row.segmentation.segments === 1 ? '' : 's'})` : `W ${Math.round(row.window[1])} / L ${Math.round(row.window[0])}${row.windowFromPixels ? ' (from pixels)' : ''}`;
        const result = [row.frame, row.volume].filter(Boolean).map(item => !item.ok ? `FAILED ${item.error}`
          : `${item.pixelType} ${item.ms} ms${item.setVoxels === undefined ? '' : `, ${item.setVoxels} mask voxels`}`).join(' | ');
        console.log(`  ${row.modality.padEnd(3)} ${row.dimensions.join('x').padEnd(13)} reconstruct=${String(row.canReconstruct).padEnd(5)} ${kind.padEnd(26)} ${result}  ${row.description}`);
      }
      for (const warning of entry.warnings ?? []) console.log(`  warning: ${warning}`);
    }
  } finally {
    await engine.stop();
  }
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(failed ? '\nFAILED' : '\nAll folders imported and every series decoded.');
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
