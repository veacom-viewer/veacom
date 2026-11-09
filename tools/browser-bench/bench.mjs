// The browser benchmark's command line.
//   node tools/browser-bench/bench.mjs run [--viewers veacom,ohif,…] [--studies ct-300,ct-1000] [--rounds 5] [--aa] [--base <dist-web>]
//   node tools/browser-bench/bench.mjs report <results folder>
//   node tools/browser-bench/bench.mjs study <name>
//   node tools/browser-bench/bench.mjs fetch [name …]
// `run` starts the repository's Electron (pnpm run setup:runtime) once per trial; see tools/browser-bench/README.md.
const [command, ...rest] = process.argv.slice(2);
if (command === 'run') {
  await import('./run.mjs');
} else if (command === 'fetch') {
  const { fetchAll } = await import('./fetch-viewers.mjs');
  await fetchAll(rest);
} else if (command === 'report') {
  await import('./report.mjs');
} else if (command === 'study') {
  const { makeStudy } = await import('./make-study.mjs');
  await makeStudy(rest[0]);
} else {
  console.error('Usage: node tools/browser-bench/bench.mjs run|report|study|fetch …  (see tools/browser-bench/README.md)');
  process.exit(2);
}
