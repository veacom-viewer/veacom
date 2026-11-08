// Opening speed: how long the engine takes to open a study, and how much work it does for it.
//
//   node tools/check-open-speed.cjs --output=<dir> [--head=<engine>] [--base=<engine>] [--study=<folder> --fixture=<name>]
//     [--rounds=20] [--cold-rounds=10] [--threshold=3] [--min-ms=15] [--seed=<n>] [--summary=<markdown file>]
//     [--head-label=<text>] [--base-label=<text>] [--vhdx=<file>] [--keep-study]
//
// Each open starts a fresh engine (VEACOM_CORE_PATH or native/target/release by default) and times three steps:
// listing (the import), the first frame and the full volume. Without --study it writes the synthetic 1,000-slice CT
// (tools/fixtures/make-smoke-study.mjs --pipe-volume, about 501 MiB) into the output folder and deletes it afterwards.
//
// Work: on Linux and macOS, tools/lib/io-count.c counts the regular files the engine opens and the bytes it reads
// under the study folder, per step. These counts are exact on any machine, so they are checked against
// tools/open-budgets.json like click budgets: more fails, less asks for the budget to come down, and
// VEACOM_RECORD_BUDGETS=1 records them.
//
// Time: with --base, the two engines open the study in alternating random order on this machine, first with the file
// cache kept (warm), then flushed before each open (cold: Linux and macOS through sudo -n, Windows by detaching the
// virtual disk given with --vhdx that holds the study). A step is slower only when the 95% interval of the change
// lies above --threshold percent and the medians differ by at least --min-ms; slower listing, volume or whole open
// fails the check. Without --base, --rounds times the head alone. Absolute times depend on the machine; compare
// engines only within one run.
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareCounter, readCounts } = require('./lib/io-count.cjs');
const { EngineProcess } = require('../electron/engine-process.cjs');
const { createRandom, median, quantile, compareRounds, checkBudgets, budgetsFrom } = require('./lib/open-speed.cjs');

const BUDGET_FILE = path.join(__dirname, 'open-budgets.json');
const PHASES = ['listing', 'firstFrame', 'volume'];
const REPORTED = [...PHASES, 'open'];
const GATED = new Set(['listing', 'volume', 'open', 'deferredVolume']);
const NAMES = { listing: 'listing', firstFrame: 'first frame', volume: 'full volume', open: 'whole open', deferredVolume: 'volume with cache flushed after listing' };

const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const match = /^--([^=]+)(?:=(.*))?$/s.exec(argument);
  if (!match) throw new Error(`Unexpected argument: ${argument}`);
  return [match[1], match[2] ?? true];
}));
if (!args.output) {
  console.error('Usage: node tools/check-open-speed.cjs --output=<dir> [--head=<engine>] [--base=<engine>] [--study=<folder> --fixture=<name>] [--rounds=N] [--cold-rounds=N]');
  process.exit(2);
}
const executable = process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core';
const output = path.resolve(args.output);
const builds = { head: path.resolve(args.head || process.env.VEACOM_CORE_PATH || path.join(__dirname, '../native/target/release', executable)) };
if (args.base) builds.base = path.resolve(args.base);
const labels = { head: args['head-label'] || 'head', base: args['base-label'] || 'base' };
const rounds = Number(args.rounds ?? (builds.base ? 20 : 0));
const coldRounds = Number(args['cold-rounds'] ?? (builds.base ? 10 : 0));
const threshold = Number(args.threshold ?? 3) / 100, minMs = Number(args['min-ms'] ?? 15);
const seed = Number(args.seed ?? (Date.now() % 2 ** 31));
const random = createRandom(seed);
const recording = process.env.VEACOM_RECORD_BUDGETS === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function folderBytes(folder) {
  let total = 0;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}

// The engine's temporary folder (archives are extracted there) sits beside the study, so its reads count too.
const engineTemp = path.join(output, 'engine-temp');
const engineEnv = process.platform === 'win32' ? { TEMP: engineTemp, TMP: engineTemp } : { TMPDIR: engineTemp };

let opens = 0;
async function openOnce(build, study, counter, flushBeforeVolume) {
  const env = { ...process.env, ...engineEnv };
  const countFile = counter && path.join(output, `io-count-${process.pid}-${++opens}.bin`);
  if (counter) Object.assign(env, { [counter.variable]: counter.library, IOCOUNT_ROOTS: counter.roots.join(':'), IOCOUNT_FILE: countFile });
  const engine = new EngineProcess({ binary: builds[build], restartDelaysMs: [],
    spawnImpl: (file, list, options) => spawn(file, list, { ...options, env }) });
  const started = performance.now();
  try {
    const connection = await engine.start();
    const startMs = performance.now() - started;
    const pid = engine.current.child.pid;
    const call = async (op, body) => {
      const response = await connection.request(op, body);
      if (!response.ok) throw new Error(`${op}: ${(await response.text()) || response.status}`);
      return response;
    };
    const phases = {}, work = {};
    let last = counter && await readCounts(pid, countFile, 0);
    let at = performance.now();
    const done = async name => {
      phases[name] = performance.now() - at;
      if (counter) {
        const now = await readCounts(pid, countFile, last.sequence);
        work[name] = { filesOpened: now.opened - last.opened, readCalls: now.calls - last.calls, bytesRead: now.bytes - last.bytes };
        last = now;
      }
      at = performance.now();
    };
    const imported = await (await call('import', { paths: [study] })).json();
    await done('listing');
    const series = imported.series?.[0];
    if (!series) throw new Error('The study listed no image series');
    await (await call('frame', { id: series.id, index: 0 })).arrayBuffer();
    await done('firstFrame');
    if (flushBeforeVolume) {
      await flush(flushBeforeVolume, study);
      at = performance.now();
    }
    const volume = await (await call('volume', { id: series.id })).arrayBuffer();
    await done('volume');
    phases.open = phases.listing + phases.firstFrame + phases.volume;
    return { startMs, phases, ...(counter ? { work } : {}), series: imported.series.length, dimensions: series.dimensions, volumeBytes: volume.byteLength };
  } finally {
    await engine.stop().catch(() => {});
    if (countFile) fs.rmSync(countFile, { force: true });
  }
}

// Flushing the file cache, where this machine allows it without a password prompt.
function coldMethod() {
  if (process.platform === 'win32') return args.vhdx ? 'vhdx' : null;
  try { execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' }); } catch { return null; }
  return process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'macos' : null;
}
function diskpart(lines) {
  const script = path.join(output, 'diskpart.txt');
  fs.writeFileSync(script, `${lines.join('\r\n')}\r\n`, 'ascii');
  execFileSync('diskpart', ['/s', script], { stdio: 'ignore' });
}
async function flush(method, study) {
  if (method === 'linux') execFileSync('sudo', ['-n', 'sh', '-c', 'sync; echo 3 > /proc/sys/vm/drop_caches']);
  else if (method === 'macos') { execFileSync('sync'); execFileSync('sudo', ['-n', 'purge']); }
  else if (method === 'vhdx') {
    // Detaching the virtual disk drops the cached data of every file on it.
    for (let attempt = 1; ; attempt++) {
      try { diskpart([`select vdisk file="${args.vhdx}"`, 'detach vdisk']); break; }
      catch (error) { if (attempt === 5) throw error; await sleep(1000); } // a scanner may still hold a file
    }
    diskpart([`select vdisk file="${args.vhdx}"`, 'attach vdisk']);
    for (let waited = 0; !fs.existsSync(study); waited += 250) {
      if (waited > 30_000) throw new Error(`The virtual disk came back without ${study}`);
      await sleep(250);
    }
  }
}

const ms = value => Number.isFinite(value) ? `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ms` : '–';
const percent = value => Number.isFinite(value) ? `${value >= 0 ? '+' : '−'}${Math.abs(100 * value).toFixed(1)}%` : '–';
const mib = bytes => (bytes / 2 ** 20).toLocaleString('en-GB', { maximumFractionDigits: 1 });
const count = value => value.toLocaleString('en-GB');

function markdown(report) {
  const lines = [];
  const study = report.study;
  lines.push(`### Opening speed: engine only, ${study.fixture || path.basename(study.path)} (${count(study.files)} files, ${mib(study.bytes)} MiB)`, '');
  const m = report.machine;
  lines.push(`${m.cpu} · ${m.cores} cores · ${m.platform} ${m.release}${m.image ? ` · ${m.image}` : ''} · seed ${report.seed}`, '');
  if (report.comparisons) {
    lines.push(`${labels.base} against ${labels.head}: ${report.rounds.warm} warm and ${report.rounds.cold} cold rounds, the two engines in random order in each.${report.coldNote ? ` ${report.coldNote}` : ''}`, '');
    lines.push('| cache | step | base | head | change (95% interval) | verdict |', '|---|---|---|---|---|---|');
    for (const row of report.comparisons) {
      const verdict = row.verdict === 'slower' && row.gated ? '**slower**' : row.verdict === 'slower' ? 'slower (not gated)' : row.verdict;
      lines.push(`| ${row.cache} | ${NAMES[row.phase]} | ${ms(row.base)} | ${ms(row.head)} | ${percent(row.change)} (${percent(row.low)} to ${percent(row.high)}) | ${verdict} |`);
    }
    lines.push('', `Slower or faster means the whole interval lies beyond ±${(100 * threshold).toFixed(0)}% and the medians differ by at least ${minMs} ms. Listing and whole open are gated. On Linux and macOS, the separate cold-volume trial flushes both file caches after listing so costs moved between phases are visible.`, '');
  } else if (report.timings) {
    lines.push(`${labels.head}: ${report.rounds.warm} warm and ${report.rounds.cold} cold opens.${report.coldNote ? ` ${report.coldNote}` : ''}`, '');
    lines.push('| cache | step | median | 10th–90th percentile |', '|---|---|---|---|');
    for (const row of report.timings) lines.push(`| ${row.cache} | ${NAMES[row.phase]} | ${ms(row.median)} | ${ms(row.p10)} – ${ms(row.p90)} |`);
    lines.push('');
  }
  if (report.work) {
    const both = report.work.base;
    lines.push('#### Work: regular files under the study folder', '');
    lines.push(`| step | files opened${both ? ' (base → head)' : ''} | MiB read${both ? ' (base → head)' : ''} | × study size | budget |`, '|---|---|---|---|---|');
    for (const phase of PHASES) {
      const head = report.work.head[phase], base = both?.[phase];
      const status = report.budgets?.filter(row => row.phase === phase).map(row => row.status === 'pass' ? null : `${row.key} ${row.status}${row.budget === null ? '' : ` (budget ${row.key === 'bytesRead' ? `${mib(row.budget)} MiB` : count(row.budget)})`}`).filter(Boolean).join(', ');
      lines.push(`| ${NAMES[phase]} | ${base ? `${count(base.filesOpened)} → ` : ''}${count(head.filesOpened)} | ${base ? `${mib(base.bytesRead)} → ` : ''}${mib(head.bytesRead)} | ${(head.bytesRead / study.bytes).toFixed(2)} | ${report.budgets ? status || 'pass' : 'not checked'} |`);
    }
    lines.push('');
  } else if (report.workNote) lines.push(`Work not counted: ${report.workNote}.`, '');
  if (report.failures.length) lines.push(`**Failed:** ${report.failures.join('; ')}`, '');
  return lines.join('\n');
}

(async () => {
  for (const [build, file] of Object.entries(builds)) if (!fs.existsSync(file)) throw new Error(`No ${build} engine at ${file}`);
  fs.mkdirSync(engineTemp, { recursive: true });
  let study = args.study && path.resolve(args.study), fixture = args.fixture || null, generated = false;
  if (!study) {
    study = path.join(output, 'ct-1000');
    fixture ??= 'ct-1000';
    if (!fs.existsSync(path.join(study, 'manifest.json'))) {
      fs.rmSync(study, { recursive: true, force: true });
      execFileSync(process.execPath, [path.join(__dirname, 'fixtures/make-smoke-study.mjs'), study, '--pipe-volume'], { stdio: 'inherit' });
      generated = true;
      // Time a settled study. Files still in their writer's clock tick take the block-verification path.
      await sleep(3100);
    }
  }
  try {
    await measure(study, fixture);
  } finally {
    // The generated CT is about 501 MiB: it goes, also after a failure, unless --keep-study.
    if (generated && !args['keep-study']) fs.rmSync(study, { recursive: true, force: true });
    fs.rmSync(engineTemp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function measure(study, fixture) {
  const manifest = path.join(study, 'manifest.json');
  const report = {
    machine: { platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model?.trim(), cores: os.cpus().length,
      memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1), image: `${process.env.ImageOS || ''} ${process.env.ImageVersion || ''}`.trim(), node: process.version },
    builds: Object.fromEntries(Object.entries(builds).map(([build, file]) => [build, { label: labels[build], path: file, sha256: sha256(file) }])),
    study: { path: study, fixture, files: fs.readdirSync(study, { withFileTypes: true, recursive: true }).filter(entry => entry.isFile()).length,
      bytes: folderBytes(study), manifestSha256: fs.existsSync(manifest) ? sha256(manifest) : null },
    seed, rounds: { warm: rounds, cold: 0 }, failures: [], runs: [],
  };

  // Work, counted once per engine.
  const counter = prepareCounter(output);
  if (counter.library) {
    counter.roots = [fs.realpathSync(study), fs.realpathSync(engineTemp)];
    report.work = {};
    for (const build of Object.keys(builds).reverse()) {
      const run = await openOnce(build, study, counter);
      report.work[build] = run.work;
      console.log(`Work, ${labels[build]}: ${PHASES.map(phase => `${NAMES[phase]} ${count(run.work[phase].filesOpened)} files, ${mib(run.work[phase].bytesRead)} MiB`).join('; ')}`);
      // Listing reads every file at least to its header: nothing counted means the counter missed the engine's reads.
      if (!run.work.listing.filesOpened || !run.work.listing.bytesRead) {
        throw new Error(`The read counter saw none of the ${labels[build]} engine's reads: it did not load or did not catch its calls`);
      }
    }
    if (fixture) {
      const file = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
      if (recording) {
        file.studies = { ...file.studies, [fixture]: budgetsFrom(report.work.head) };
        fs.writeFileSync(BUDGET_FILE, `${JSON.stringify(file, null, 2)}\n`);
        console.log(`Recorded the work of ${fixture} in ${path.relative(process.cwd(), BUDGET_FILE)}`);
      }
      report.budgets = checkBudgets(report.work.head, file.studies?.[fixture]);
      for (const row of report.budgets) {
        if (row.status === 'over' || (row.status === 'new' && !recording)) report.failures.push(`${NAMES[row.phase]} ${row.key} ${count(row.value)} ${row.status === 'over' ? `> budget ${count(row.budget)}` : 'has no budget'}`);
        else if (row.status === 'under') console.log(`${NAMES[row.phase]} ${row.key} ${count(row.value)} < budget ${count(row.budget)}: lower the budget (VEACOM_RECORD_BUDGETS=1)`);
      }
    }
  } else {
    report.workNote = counter.reason;
    // Where counting is possible, a budget that could not be checked fails rather than passing unseen.
    if (fixture && counter.required) report.failures.push(`work not counted: ${counter.reason}`);
  }

  // Time.
  if (rounds || coldRounds) {
    const method = coldRounds ? coldMethod() : null;
    const isolateColdVolume = method === 'linux' || method === 'macos';
    const reportedPhases = cache => cache === 'cold' && isolateColdVolume ? [...REPORTED, 'deferredVolume'] : REPORTED;
    report.rounds.cold = method ? coldRounds : 0;
    if (coldRounds && !method) report.coldNote = 'No cold rounds: the file cache cannot be flushed here without a password (or, on Windows, without --vhdx).';
    const order = () => { // a fresh random order of the engines for every round
      const list = Object.keys(builds);
      for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
      return list;
    };
    for (const build of order()) await openOnce(build, study); // warm-up, not counted
    const blocks = [['warm', rounds, false], ['cold', report.rounds.cold, true]];
    for (const [cache, total, cold] of blocks) {
      for (let round = 0; round < total; round++) {
        for (const build of order()) {
          if (cold) await flush(method, study);
          const run = await openOnce(build, study);
          if (cold && isolateColdVolume) {
            const isolated = await openOnce(build, study, undefined, method);
            run.phases.deferredVolume = isolated.phases.volume;
          }
          report.runs.push({ cache, round, build, startMs: run.startMs, phases: run.phases });
        }
        console.log(`${cache} round ${round + 1}/${total}`);
      }
    }
    if (builds.base) {
      report.comparisons = [];
      for (const [cache, total] of blocks) {
        if (!total) continue;
        for (const phase of reportedPhases(cache)) {
          const paired = [];
          for (let round = 0; round < total; round++) {
            const of = build => report.runs.find(run => run.cache === cache && run.round === round && run.build === build)?.phases[phase];
            paired.push({ base: of('base'), head: of('head') });
          }
          const result = compareRounds(paired, { threshold, minMs, seed: seed + REPORTED.indexOf(phase) });
          const gated = GATED.has(phase) && !(cache === 'cold' && isolateColdVolume && phase === 'volume');
          report.comparisons.push({ cache, phase, gated, ...result });
          if (gated && result.verdict === 'slower') report.failures.push(`${cache} ${NAMES[phase]} ${percent(result.change)} slower (${percent(result.low)} to ${percent(result.high)})`);
        }
      }
    } else {
      report.timings = [];
      for (const [cache, total] of blocks) {
        if (!total) continue;
        for (const phase of reportedPhases(cache)) {
          const values = report.runs.filter(run => run.cache === cache).map(run => run.phases[phase]);
          report.timings.push({ cache, phase, median: median(values), p10: quantile(values, 0.1), p90: quantile(values, 0.9) });
        }
      }
    }
  }

  const text = markdown(report);
  fs.writeFileSync(path.join(output, 'open-speed.json'), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(output, 'open-speed.md'), `${text}\n`);
  if (args.summary) fs.appendFileSync(args.summary, `${text}\n`);
  console.log(`\n${text}`);
  if (report.failures.length) process.exitCode = 1;
}

