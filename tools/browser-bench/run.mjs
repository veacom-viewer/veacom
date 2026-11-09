// The browser benchmark's runner (plain Node; `node tools/browser-bench/bench.mjs run …`). It checks the studies and the pinned
// viewers, serves every viewer from localhost, and runs the trials in a balanced order: for every round, study and
// viewer it waits for the machine to be idle and starts a fresh Electron with tools/browser-bench/trial.mjs. One JSON line per trial
// goes to results.jsonl.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { describe, state, waitIdle } from './lib/machine.mjs';
import { makeStudy, STUDIES, studyFolder } from './make-study.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), repository = path.resolve(here, '..', '..');
const { values: options } = parseArgs({ args: process.argv.slice(3), strict: true, options: {
  viewers: { type: 'string', default: 'veacom' }, studies: { type: 'string', default: 'ct-300' }, rounds: { type: 'string', default: '5' },
  warmup: { type: 'string', default: '1' }, out: { type: 'string' }, veacom: { type: 'string' }, base: { type: 'string' }, aa: { type: 'boolean', default: false },
  rates: { type: 'string', default: '30,60,120' }, width: { type: 'string', default: '1280' }, height: { type: 'string', default: '800' },
  scenarios: { type: 'string', default: 'open,paging,wl' },
} });
const electron = createRequire(import.meta.url)('electron');
const git = (...args) => { try { return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim(); } catch { return null; } };

/** The viewers to run: each has an id, the adapter module that drives it and what to serve. */
async function viewerList() {
  const list = [];
  for (const name of options.viewers.split(',').filter(Boolean)) {
    const adapter = (await import(pathToFileURL(path.join(here, 'viewers', `${name}.mjs`)).href)).default;
    list.push({ id: name, adapter: name, module: adapter, serveWith: name === 'veacom' ? { dist: path.resolve(options.veacom ?? path.join(repository, 'dist-web')) } : {} });
  }
  // The same build twice measures the run's own noise; a base build makes it an A/B of two VEAcom versions.
  const veacom = list.find(v => v.id === 'veacom');
  if (options.aa && veacom) list.push({ ...veacom, id: 'veacom-aa' });
  if (options.base && veacom) list.push({ ...veacom, id: 'veacom-base', serveWith: { dist: path.resolve(options.base) } });
  return list;
}

/** Round r runs the viewers rotated by r and, in every other full rotation, reversed: each viewer goes first equally often. */
export function order(viewers, round) {
  const n = viewers.length, shift = ((round % n) + n) % n;
  const rotated = [...viewers.slice(shift), ...viewers.slice(0, shift)];
  return Math.floor(round / n) % 2 ? rotated.reverse() : rotated;
}

function runTrial(spec) {
  const file = path.join(spec.outDir, 'specs', `${spec.order}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  // Only this trial's own result may be read back.
  fs.rmSync(spec.result, { force: true });
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(here, 'trial.mjs'), file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.on('exit', code => {
      clearTimeout(timer);
      if (fs.existsSync(spec.result)) resolve(JSON.parse(fs.readFileSync(spec.result, 'utf8')));
      else reject(new Error(`The trial's Electron exited (${code}) without a result: ${errors.split('\n').filter(l => !l.includes('Electron Helper')).slice(-5).join(' ')}`));
    });
  });
}

const outDir = path.resolve(options.out ?? path.join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-')));
// A run's folder holds that run alone: an earlier run's trials would be pooled into this one's medians.
if (fs.existsSync(path.join(outDir, 'run.json')) || fs.existsSync(path.join(outDir, 'results.jsonl'))) {
  throw new Error(`${outDir} already holds a run; choose a new --out folder.`);
}
for (const sub of ['shots', 'specs', 'trials']) fs.mkdirSync(path.join(outDir, sub), { recursive: true });
const studies = [];
for (const name of options.studies.split(',')) {
  const folder = studyFolder(name);
  await makeStudy(name, folder);
  studies.push({ name, folder, slices: STUDIES[name].slices });
}
const viewers = await viewerList();
const served = new Map();
const rounds = Number(options.rounds), warmup = Number(options.warmup);
fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify({ started: new Date().toISOString(), machine: describe(), options,
  repository: { commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) },
  viewers: viewers.map(v => v.id), versions: Object.fromEntries(viewers.map(v => [v.id, v.module.version ?? v.serveWith.dist ?? null])),
  studies: studies.map(s => s.name), window: [Number(options.width), Number(options.height)] }, null, 1)}\n`);
console.log(`Results: ${outDir}`);

let count = 0;
// The servers start inside the block whose finally closes them: if one fails to start, those already running stop.
try {
  for (const viewer of viewers) {
    const server = await viewer.module.serve(viewer.serveWith);
    served.set(viewer.id, { url: server.url, build: server.build, pinned: server.pinned, close: server.close });
  }
  for (let round = 1 - warmup; round <= rounds; round++) {
    for (const study of studies) for (const viewer of order(viewers, round)) {
      const idle = await waitIdle();
      const spec = { viewer: { id: viewer.id, adapter: viewer.adapter }, served: served.get(viewer.id), study, round, order: count, outDir,
        result: path.join(outDir, 'trials', `${count}.json`), machine: state(), idle, width: Number(options.width), height: Number(options.height),
        rates: options.rates.split(',').map(Number), scenarios: options.scenarios.split(',') };
      count++;
      let line;
      try { line = await runTrial(spec); } catch (error) { line = { viewer: viewer.id, study: study.name, round, warmup: round <= 0, order: spec.order, error: String(error.message) }; }
      fs.appendFileSync(path.join(outDir, 'results.jsonl'), `${JSON.stringify(line)}\n`);
      console.log(`${line.viewer} ${study.name} r${round}${line.warmup ? ' (warm-up)' : ''}: first image ${line.firstImageMs ?? '–'} ms, done ${line.doneMs ?? '–'} ms`
        + `${line.paging?.rates ? `, paging ${Object.entries(line.paging.rates).map(([r, m]) => `${r}/s→${m.slicesPerS ?? '?'}/s kept ${m.kept ?? '?'} lag ${m.lagMs ?? '?'} ms`).join('; ')}` : ''}`
        + `${line.wl?.updatesPerS !== undefined ? `, W/L ${line.wl.updatesPerS}/s` : ''}${line.error ? ` ERROR ${line.error.split('\n')[0]}` : ''}`);
    }
  }
} finally {
  for (const server of served.values()) await server.close();
}
