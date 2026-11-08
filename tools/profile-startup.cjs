// Launch-to-image timings for a study opened from the command line (`--study`), as the benchmark and
// file associations open it: first image (preview or full volume in view) and full volume loaded.
// Times are wall clock from just before launch, observed by polling each animation frame. The window opens without
// making the app the active one, so on macOS they leave out the activation a real launch has (about 50 ms; tools/README.md).
// usage: node tools/profile-startup.cjs --study=PATH [--runs=3] [--executable=PACKAGED_APP] [--output=FILE.json]
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');

const repo = path.resolve(__dirname, '..');
const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const equal = argument.indexOf('='); return [argument.slice(2, equal), argument.slice(equal + 1)];
}));
if (!options.study) throw new Error('Pass --study=PATH.');
const study = path.resolve(options.study);
const runs = Number(options.runs || 3);
const executable = options.executable && path.resolve(options.executable);

async function run(index) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-startup-'));
  const launched = performance.now();
  const desktop = await launchDesktop({ ...(executable ? { executablePath: executable } : {}),
    args: [...(executable ? [] : [repo]), '--study', study],
    env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 90_000 });
  try {
    const page = await desktop.firstWindow();
    // Real input from the computer would change what is measured; the window shows without taking it.
    await ignoreOutsideInput(desktop);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().dimensions, undefined, { timeout: 60_000, polling: 'raf' });
    const firstImageMs = performance.now() - launched;
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().seriesReady, undefined, { timeout: 120_000, polling: 'raf' });
    const fullVolumeMs = performance.now() - launched;
    return { run: index, firstImageMs: Math.round(firstImageMs), fullVolumeMs: Math.round(fullVolumeMs), errors };
  } finally { await desktop.close(); await fs.rm(profile, { recursive: true, force: true }); }
}

(async () => {
  const results = [];
  for (let index = 1; index <= runs; index++) {
    results.push(await run(index));
    console.log(JSON.stringify(results.at(-1)));
  }
  const median = key => [...results.map(result => result[key])].sort((a, b) => a - b)[Math.floor(results.length / 2)];
  const report = { study, executable: executable || null, platform: process.platform, runs: results,
    medianFirstImageMs: median('firstImageMs'), medianFullVolumeMs: median('fullVolumeMs') };
  console.log(JSON.stringify({ medianFirstImageMs: report.medianFirstImageMs, medianFullVolumeMs: report.medianFullVolumeMs }));
  if (options.output) await fs.writeFile(path.resolve(options.output), JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
