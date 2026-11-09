// Summarises one or more results folders (tools/browser-bench/run.mjs) into report.html and report.md and prints the
// table. Several folders, such as the parallel runs of one CI workflow on different runners, are pooled: every trial
// counts, and a table per runner shows how far the runners agree.
//   node tools/browser-bench/bench.mjs report [--out <folder>] [--require-every-viewer] <results folder> […]
// --require-every-viewer exits 1, after writing the report, when any viewer has no successful trial in any study.
// The report goes to --out, or beside the first folder's results. Warm-up rounds and failed trials are left out
// (failures are listed). Every number is the median over trials with a bootstrap 95% interval. When the run has the A/A pair (veacom and veacom-aa, the same build twice), each metric's
// A/A spread is the noise floor: another viewer is called faster or slower only beyond it.
import fs from 'node:fs';
import path from 'node:path';
import { LOCK } from './fetch-viewers.mjs';
import { compare, summarize } from './lib/stats.mjs';

const args = process.argv.slice(process.argv[1].endsWith('bench.mjs') ? 3 : 2);
const outFlag = args.indexOf('--out'), out = outFlag >= 0 ? args.splice(outFlag, 2)[1] : null;
const requireFlag = args.indexOf('--require-every-viewer'), requireEvery = requireFlag >= 0;
if (requireEvery) args.splice(requireFlag, 1);
const folders = (args.length ? args : ['.']).map(folder => path.resolve(folder));
const runs = folders.map(folder => JSON.parse(fs.readFileSync(path.join(folder, 'run.json'), 'utf8')));
const lines = folders.flatMap((folder, index) => fs.readFileSync(path.join(folder, 'results.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map(line => ({ ...JSON.parse(line), runner: index + 1 })));
const run = runs[0], folder = path.resolve(out ?? folders[0]);
fs.mkdirSync(folder, { recursive: true });
// The pictures of the first run, for the report's first-image row.
if (folder !== folders[0] && fs.existsSync(path.join(folders[0], 'shots'))) fs.cpSync(path.join(folders[0], 'shots'), path.join(folder, 'shots'), { recursive: true });
const counted = lines.filter(line => !line.warmup && !line.error), failed = lines.filter(line => line.error);

// Each metric: label, unit, how to read it from a trial, and whether lower is better.
const METRICS = [
  ['pageMs', 'Page load', 'ms', l => l.pageMs, true],
  ['firstImageMs', 'First image after drop', 'ms', l => l.firstImageMs, true],
  ['doneMs', 'Loading done (CPU quiet)', 'ms', l => l.doneMs, true],
  ['cpuSeconds', 'CPU to load', 's', l => l.cpuSeconds, true],
  ['peakMB', 'Peak memory while loading', 'MB', l => l.peakMB, true],
  ['loadedMB', 'Memory once loaded', 'MB', l => l.loadedMB, true],
  ...(run.options.rates ?? '30,60,120').split(',').flatMap(rate => [
    [`slices${rate}`, `Paging ${rate}/s: slices drawn per second`, '/s', l => l.paging?.rates?.[rate]?.slicesPerS, false],
    [`kept${rate}`, `Paging ${rate}/s: notches kept`, '%', l => pct(l.paging?.rates?.[rate]?.kept), false],
    [`stall${rate}`, `Paging ${rate}/s: longest stall`, 'ms', l => l.paging?.rates?.[rate]?.longestStallMs, true],
    [`lag${rate}`, `Paging ${rate}/s: still moving after last notch`, 'ms', l => l.paging?.rates?.[rate]?.lagMs, true],
  ]),
  ['wlRate', 'Window/level: redraws per second of drag', '/s', l => l.wl?.updatesPerS, false],
  ['wlSettle', 'Window/level: settles after release', 'ms', l => l.wl?.settleMs, true],
];
function pct(value) { return Number.isFinite(value) ? value * 100 : undefined; }

const viewers = [...new Set(runs.flatMap(r => r.viewers))], studies = [...new Set(runs.flatMap(r => r.studies))];
const rounds = new Set(counted.filter(l => l.runner === 1).map(l => l.round)).size;
const spanText = runs.length > 1 ? `${rounds} rounds on each of ${runs.length} runners` : `${rounds} rounds`;
const runnerText = runs.length > 1 ? runs.map((r, i) => `runner ${i + 1}: ${r.machine.cpu ?? '?'} (${r.machine.cores} cores)`).join(' · ') : null;
// How far the runners agree: each runner's own median of the first image, per viewer and study.
const perRunner = runs.length > 1 ? studies.map(study => ({ study, rows: runs.map((_, i) => viewers.map(viewer =>
  summarize(counted.filter(l => l.runner === i + 1 && l.viewer === viewer && l.study === study).map(l => l.firstImageMs).filter(Number.isFinite)).median)) })) : [];
const values = (viewer, study, read) => counted.filter(l => l.viewer === viewer && l.study === study).map(read).filter(Number.isFinite);
const reference = viewers.includes('veacom') ? 'veacom' : viewers[0];

const tables = studies.map(study => {
  const rows = METRICS.map(([key, label, unit, read, lower]) => {
    const aa = viewers.includes('veacom-aa') ? compare(values('veacom-aa', study, read), values('veacom', study, read)) : null;
    const noise = aa ? Math.max(Math.abs(aa.low - 1), Math.abs(aa.high - 1)) : 0;
    const cells = viewers.map(viewer => {
      const summary = summarize(values(viewer, study, read));
      const versus = viewer === reference || viewer === 'veacom-aa' ? null : compare(values(viewer, study, read), values(reference, study, read), { noise });
      return { viewer, ...summary, versus };
    });
    // The best only when no other viewer ties it.
    const ranked = cells.filter(c => c.median !== null).sort((a, b) => (lower ? a.median - b.median : b.median - a.median));
    const best = ranked.length > 1 && ranked[0].median !== ranked[1].median ? ranked[0].viewer : null;
    return { key, label, unit, lower, cells, best, noise: aa ? noise : null };
  }).filter(row => row.cells.some(cell => cell.n));
  return { study, rows };
});

const format = (value, unit) => value === null || value === undefined ? '–' : unit === 's' ? value.toFixed(2) : unit === '/s' ? value.toFixed(1) : Math.round(value).toString();
const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

for (const { study, rows } of tables) {
  console.log(`\n${study}  (median over rounds; [95% interval])`);
  console.log(['metric', ...viewers].join('\t'));
  for (const row of rows) console.log([`${row.label} (${row.unit})`, ...row.cells.map(c => c.n ? `${format(c.median, row.unit)} [${format(c.low, row.unit)}–${format(c.high, row.unit)}]` : '–')].join('\t'));
}
if (failed.length) console.log(`\n${failed.length} failed trial(s): ${failed.map(l => `${l.viewer} ${l.study} r${l.round}: ${l.error.split('\n')[0]}`).join('; ')}`);

const machine = run.machine;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser viewer benchmark</title><style>
:root{--bg:#fff;--fg:#1d2329;--muted:#5e6b78;--line:#dde3e9;--best:#e3f4ea;--worse:#fbe9e7;--better:#e3f4ea}
@media (prefers-color-scheme:dark){:root{--bg:#14181c;--fg:#e6eaee;--muted:#98a4b0;--line:#2a3138;--best:#183a28;--worse:#3d2320;--better:#183a28}}
body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:1200px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}p,li{color:var(--muted)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left;white-space:normal}
td .ci{color:var(--muted);font-size:12px;display:block}td.best{background:var(--best)}td.worse{background:var(--worse)}
.shots{display:flex;gap:8px;flex-wrap:wrap}.shots figure{margin:0;width:220px}.shots img{width:100%;border:1px solid var(--line)}.shots figcaption{font-size:12px;color:var(--muted)}
</style></head><body>
<h1>Browser viewer benchmark</h1>
<p>${escape(run.started)} · ${escape(machine.model ?? '')} · ${escape(machine.cpu ?? '')} (${machine.cores} cores, ${machine.memoryGB} GB) · ${escape(machine.platform)} ${escape(machine.release)} · Chromium ${escape(machine.chrome)} (Electron ${escape(machine.electron)}) · window ${run.window.join('×')} · drawn by ${escape([...new Set(counted.map(l => l.renderer).filter(Boolean))].join(', ') || 'unknown')}</p>
${runnerText ? `<p>${escape(runnerText)}</p>` : ''}
<p>Median over ${spanText} (warm-up left out) with its bootstrap 95% interval. Green: best in the row. Red: worse than ${escape(reference)} beyond the interval${viewers.includes('veacom-aa') ? ' and the A/A noise (the same build run twice)' : ''}.</p>
${tables.map(({ study, rows }) => `<h2>${escape(study)}</h2><div class="scroll"><table><thead><tr><th>Metric</th>${viewers.map(v => `<th>${escape(v)}</th>`).join('')}${rows.some(r => r.noise !== null) ? '<th>A/A noise</th>' : ''}</tr></thead><tbody>
${rows.map(row => `<tr><td>${escape(row.label)} <span class="ci">${escape(row.unit)}${row.lower ? ', lower is better' : ', higher is better'}</span></td>${row.cells.map(cell => {
  const worse = cell.versus?.differs && (row.lower ? cell.versus.ratio > 1 : cell.versus.ratio < 1);
  return `<td class="${cell.viewer === row.best ? 'best' : worse ? 'worse' : ''}">${cell.n ? `${format(cell.median, row.unit)}<span class="ci">${format(cell.low, row.unit)}–${format(cell.high, row.unit)} · n=${cell.n}</span>` : '–'}</td>`;
}).join('')}${row.noise !== null ? `<td>±${(row.noise * 100).toFixed(1)}%</td>` : rows.some(r => r.noise !== null) ? '<td></td>' : ''}</tr>`).join('\n')}
</tbody></table></div>`).join('\n')}
${perRunner.map(({ study, rows }) => `<h2>First image on each runner, ${escape(study)} (ms)</h2><div class="scroll"><table><thead><tr><th>Runner</th>${viewers.map(v => `<th>${escape(v)}</th>`).join('')}</tr></thead><tbody>
${rows.map((row, i) => `<tr><td>${i + 1}: ${escape(runs[i].machine.cpu ?? '')}</td>${row.map(value => `<td>${format(value, 'ms')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('')}
<h2>Viewers</h2><div class="scroll"><table><thead><tr><th>Viewer</th><th>Version</th><th>Opened by</th><th>First slice shown</th><th>Licence</th></tr></thead><tbody>
${viewers.map(viewer => { const entry = LOCK.viewers.find(e => e.name === viewer), trial = counted.find(l => l.viewer === viewer) ?? lines.find(l => l.viewer === viewer);
  return `<tr><td>${escape(entry?.title ?? viewer)}${entry?.serve.live ? ' <span class="ci">live site, not pinned</span>' : ''}</td><td>${escape(entry?.version ?? run.versions?.[viewer] ?? '')}</td><td>${escape(trial?.openedBy ?? '')}</td><td>${escape(trial?.firstSlice ?? '–')}</td><td>${escape(entry?.licence ?? 'GPL-3.0-or-later')}</td></tr>`; }).join('')}
</tbody></table></div>
<h2>First image on screen</h2><div class="shots">${viewers.map(viewer => { const shot = lines.find(l => l.viewer === viewer && !l.warmup && !l.error); return shot ? `<figure><img src="shots/${escape(`${viewer}-${shot.study}-r${shot.round}-first.jpg`)}" alt=""><figcaption>${escape(viewer)}, ${escape(shot.study)}</figcaption></figure>` : ''; }).join('')}</div>
<h2>Trials</h2><ul>${failed.map(l => `<li>Failed: ${escape(l.viewer)} ${escape(l.study)} round ${l.round}: ${escape(l.error.split('\n')[0])}</li>`).join('')}
${[...new Set(counted.flatMap(l => l.sentElsewhere ?? []))].map(s => `<li>Sent after the drop: ${escape(s)}</li>`).join('')}
<li>${counted.length} trials counted; machine not idle before ${counted.filter(l => l.idle && !l.idle.idle).length} of them; ${escape(counted.filter(l => l.machine?.power === 'battery').length)} on battery.</li></ul>
</body></html>`;
fs.writeFileSync(path.join(folder, 'report.html'), html);

// The same tables in Markdown, for a CI run's summary page (tools/browser-bench/README.md).
const renderers = [...new Set(counted.map(l => l.renderer).filter(Boolean))];
const cell = (c, unit) => c.n ? `${format(c.median, unit)} (${format(c.low, unit)}–${format(c.high, unit)})` : '–';
const markdown = [
  '## Browser viewer benchmark', '',
  `${run.started} · ${machine.cpu ?? ''} (${machine.cores} cores, ${machine.memoryGB} GB) · ${machine.platform} ${machine.release} · window ${run.window.join('×')}`
    + `${run.repository?.commit ? ` · commit ${run.repository.commit.slice(0, 7)}` : ''}`,
  ...(runnerText ? [runnerText] : []),
  `Drawn by: ${renderers.join(', ') || 'unknown'}. Median over ${spanText}, with the bootstrap 95% interval.`,
  ...tables.flatMap(({ study, rows }) => ['', `### ${study}`, '', `| Metric | ${viewers.join(' | ')} |`, `|---|${viewers.map(() => '---:').join('|')}|`,
    ...rows.map(row => `| ${row.label} (${row.unit}) | ${row.cells.map(c => `${c.viewer === row.best ? '**' : ''}${cell(c, row.unit)}${c.viewer === row.best ? '**' : ''}`).join(' | ')} |`)]),
  ...perRunner.flatMap(({ study, rows }) => ['', `#### First image on each runner, ${study} (ms)`, '', `| Runner | ${viewers.join(' | ')} |`, `|---|${viewers.map(() => '---:').join('|')}|`,
    ...rows.map((row, i) => `| ${i + 1}: ${runs[i].machine.cpu ?? ''} | ${row.map(value => format(value, 'ms')).join(' | ')} |`)]),
  ...(failed.length ? ['', `Failed trials: ${failed.map(l => `${l.viewer} ${l.study} round ${l.round}: ${l.error.split('\n')[0]}`).join('; ')}`] : []),
  '',
].join('\n');
fs.writeFileSync(path.join(folder, 'report.md'), markdown);
console.log(`\n${path.join(folder, 'report.html')}`);
// A viewer that never finished a trial means the run did not measure it: say so, and fail when asked to.
const missing = studies.flatMap(study => viewers.filter(viewer => !counted.some(l => l.viewer === viewer && l.study === study)).map(viewer => `${viewer} (${study})`));
if (missing.length) {
  console.error(`No successful trial for: ${missing.join(', ')}`);
  fs.appendFileSync(path.join(folder, 'report.md'), `\n**No successful trial for:** ${missing.join(', ')}\n`);
  if (requireEvery) process.exitCode = 1;
}
