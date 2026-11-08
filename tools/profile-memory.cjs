// Memory each process keeps after a study's full volume loads, and how long that load takes.
// node tools/profile-memory.cjs --study=PATH --output=FILE.json [--runs=3] [--app=PATH] [--executable=PATH]
// Each run starts a fresh profile with --study, waits for the full volume, then records every process
// 3 s later, the renderer and engine 20 s later and after paging through 100 slices, and their peaks.
// macOS reports physical footprint (Activity Monitor's Memory column), Windows private bytes (Task
// Manager's Memory column) with peak working sets, Linux resident size with its peak.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');

const options = Object.fromEntries(process.argv.slice(2).map(argument => {
  const equal = argument.indexOf('='); return [argument.slice(2, equal), argument.slice(equal + 1)];
}));
assert(options.study && options.output, 'Pass --study=PATH and --output=FILE.json.');
const appPath = path.resolve(options.app || path.join(__dirname, '..'));
const study = path.resolve(options.study), output = path.resolve(options.output);
const runs = Number(options.runs || 3);
assert(Number.isInteger(runs) && runs > 0);
const mib = bytes => Math.round(bytes / 2 ** 20);
const measure = { darwin: 'physical footprint; peak from vmmap', win32: 'private bytes; peak working set', linux: 'resident size (VmRSS); peak VmHWM' }[process.platform];
assert(measure, `Memory sampling is not implemented for ${process.platform}.`);
const powershell = script => execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();

function enginePid(browserPid) {
  if (process.platform === 'win32') {
    const pid = powershell(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${browserPid} AND Name='veacom-core.exe'").ProcessId`);
    return pid ? Number(pid.split(/\s+/)[0]) : null;
  }
  const row = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n')
    .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).find(match => match && Number(match[2]) === browserPid && /(?:^|\/)veacom-core$/.test(match[3]));
  return row ? Number(row[1]) : null;
}

/** Memory and peak, in bytes, of one process that is not an Electron process (or of any on macOS/Linux). */
function processMemory(pid, withPeak) {
  if (process.platform === 'darwin') {
    const text = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const [, value, unit] = text.match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB)/i);
    const result = { memory: Number(value) * { KB: 2 ** 10, MB: 2 ** 20, GB: 2 ** 30 }[unit.toUpperCase()] };
    if (withPeak) {
      const summary = execFileSync('vmmap', ['--summary', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
      const [, peak, peakUnit] = summary.match(/Physical footprint \(peak\):\s+([\d.]+)([KMG])/);
      result.peak = Number(peak) * { K: 2 ** 10, M: 2 ** 20, G: 2 ** 30 }[peakUnit];
    }
    return result;
  }
  if (process.platform === 'linux') {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'), field = name => Number(status.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'))[1]) * 1024;
    return { memory: field('VmRSS'), peak: field('VmHWM') };
  }
  const [memory, peak] = powershell(`$p = Get-Process -Id ${pid}; '{0} {1}' -f $p.PrivateMemorySize64, $p.PeakWorkingSet64`).split(/\s+/).map(Number);
  return { memory, peak };
}

/** Every Electron process plus the engine, in MiB. Peaks are read only when asked (vmmap is slow). */
async function snapshot(desktop, engine, withPeak = false) {
  const metrics = await desktop.evaluate(({ app }) => app.getAppMetrics());
  const rows = metrics.map(metric => {
    const type = metric.type === 'Tab' ? 'renderer' : metric.type.toLowerCase();
    // Electron reports Windows private bytes and peak working sets itself, in KiB.
    const sampled = process.platform === 'win32' ? { memory: metric.memory.privateBytes * 1024, peak: metric.memory.peakWorkingSetSize * 1024 }
      : processMemory(metric.pid, withPeak && type === 'renderer');
    return { type, pid: metric.pid, memoryMiB: mib(sampled.memory), ...(sampled.peak === undefined ? {} : { peakMiB: mib(sampled.peak) }) };
  });
  if (engine) {
    const sampled = processMemory(engine, withPeak);
    rows.push({ type: 'engine', pid: engine, memoryMiB: mib(sampled.memory), ...(sampled.peak === undefined ? {} : { peakMiB: mib(sampled.peak) }) });
  }
  return rows;
}
const pick = (rows, type) => rows.find(row => row.type === type);

function buildHashes(runtime, entryUrl) {
  const entry = new URL(entryUrl);
  assert(entry.protocol === 'veacom:' && entry.hostname === 'app', 'Profile a built viewer with VEACOM_DEV_URL unset.');
  const root = runtime.packaged ? runtime.resourcesPath : runtime.appPath;
  const binary = process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core';
  const core = runtime.coreOverride ? path.resolve(runtime.cwd, runtime.coreOverride)
    : path.join(root, runtime.packaged ? 'native' : 'native/target/release', binary);
  const renderer = fs.statSync(runtime.appPath).isFile() ? runtime.appPath
    : path.join(runtime.appPath, 'dist', decodeURIComponent(entry.pathname).slice(1));
  return Object.fromEntries([core, renderer].map(file => [
    path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  ]));
}

async function run(index) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'veacom-memory-'));
  const started = performance.now();
  const desktop = await launchDesktop({ args: [appPath, '--study', study], ...(options.executable ? { executablePath: options.executable } : {}),
    env: { ...process.env, VEACOM_USER_DATA: profile, VEACOM_TEST_MODE: '1' }, timeout: 120_000 });
  try {
    const page = await desktop.firstWindow();
    // Real input from the computer would change what is measured; the window shows without taking it.
    await ignoreOutsideInput(desktop);
    await page.waitForFunction(() => document.querySelector('[data-testid="veacom-app"]')?.getAttribute('data-ready') === 'true', undefined, { timeout: 120_000 });
    await page.waitForFunction(() => window.__VEACOM_TEST__?.state().seriesReady, undefined, { timeout: 180_000 });
    const loadedMs = Math.round(performance.now() - started);
    // Electron's main process starts the engine. On Windows that is not the process Playwright launched.
    const runtime = await desktop.evaluate(({ app }) => ({
      pid: process.pid, appPath: app.getAppPath(), resourcesPath: process.resourcesPath,
      packaged: app.isPackaged, cwd: process.cwd(), coreOverride: process.env.VEACOM_CORE_PATH,
    }));
    const engine = enginePid(runtime.pid);
    assert(engine, 'Cannot identify the running imaging engine to measure its memory.');
    await page.waitForTimeout(3000);
    const at3s = await snapshot(desktop, engine);
    await page.waitForTimeout(17_000);
    const at20s = await snapshot(desktop, engine);
    const slices = await page.evaluate(() => window.__VEACOM_TEST__.state().dimensions?.[2] ?? 1);
    for (let slice = 0; slice < Math.min(100, slices); slice++) {
      await page.evaluate(next => window.__VEACOM_TEST__.setView({ slice: next }), slice);
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(2000);
    const afterPaging = await snapshot(desktop, engine, true);
    const summary = { run: index, loadedMs, totalAt3sMiB: at3s.reduce((total, row) => total + row.memoryMiB, 0),
      renderer: { at3sMiB: pick(at3s, 'renderer')?.memoryMiB, at20sMiB: pick(at20s, 'renderer')?.memoryMiB, afterPagingMiB: pick(afterPaging, 'renderer')?.memoryMiB, peakMiB: pick(afterPaging, 'renderer')?.peakMiB },
      engine: { at3sMiB: pick(at3s, 'engine')?.memoryMiB, at20sMiB: pick(at20s, 'engine')?.memoryMiB, peakMiB: pick(afterPaging, 'engine')?.peakMiB } };
    const entryUrl = await page.locator('script[type="module"][src]').first().evaluate(script => script.src);
    return { appPath: runtime.appPath, builds: buildHashes(runtime, entryUrl), summary, at3s, at20s, afterPaging };
  } finally {
    await desktop.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

(async () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = { study, platform: process.platform, arch: process.arch, measure,
    method: 'Fresh Electron process and profile per run; memory sampled 3 s and 20 s after the full volume loaded, and after paging 100 slices. Filesystem caches are not flushed.', runs: [] };
  for (let index = 1; index <= runs; index++) {
    const { appPath: launchedApp, builds, ...measured } = await run(index);
    if (index > 1) assert.deepEqual(builds, result.builds, 'The measured build changed between runs.');
    result.appPath = launchedApp;
    result.builds = builds;
    result.runs.push(measured);
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(measured.summary));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
