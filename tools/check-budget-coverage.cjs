// Every click budget has to be measured by a verification run: a budget nothing measures guards nothing, and
// a task behind a condition can stop running unnoticed. Reads what desktop-smoke.cjs and check-click-budget.cjs
// recorded in the run's evidence folder.
//
//   node tools/check-budget-coverage.cjs <verification-evidence> [budgets-file]
const fs = require('node:fs');
const path = require('node:path');
const { readBudgets, BUDGET_FILE } = require('./click-budget.cjs');

const [evidence, file = BUDGET_FILE] = process.argv.slice(2);
if (!evidence) throw new Error('Usage: check-budget-coverage.cjs <verification-evidence> [budgets-file]');
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(evidence, ...parts), 'utf8'));
const smoke = read('desktop-smoke', 'desktop-smoke.json').checks.find(check => check.name === 'Click budgets')?.detail ?? [];
const canonical = read('click-budget', 'ct-small.json').results ?? [];
const measured = new Set([...smoke, ...canonical].map(result => result.task));
const missing = Object.keys(readBudgets(file).tasks ?? {}).filter(task => !measured.has(task));
if (missing.length) {
  console.error(`Click budgets nothing measured: ${missing.join(', ')}`);
  process.exitCode = 1;
} else console.log(`PASS every click budget was measured (${measured.size} tasks)`);
