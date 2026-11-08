import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const { ClickBudget } = createRequire(import.meta.url)('../tools/click-budget.cjs');
const action = (id: string, changed?: string) => ({ name: 'ux.action', attributes: { 'veacom.action': id, ...(changed ? { 'veacom.changed': changed } : {}) } });

let dir: string, budgets: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'veacom-budget-test-'));
  budgets = path.join(dir, 'budgets.json');
  await writeFile(budgets, JSON.stringify({ tasks: { open: 2, pick: 1, close: 1 } }));
  mock.method(console, 'log', () => {});
});
afterEach(async () => { mock.restoreAll(); await rm(dir, { recursive: true, force: true }); });

describe('click budgets', () => {
  const budget = () => new ClickBudget(null, { file: budgets, record: false });
  it('passes a path within its budget', () => {
    const check = budget();
    assert.equal(check.count('open', [action('tool-open', 'menu'), action('open-folder', 'menu,dialog')]).status, 'pass');
    assert.equal(check.count('pick', []).status, 'under');
    assert.doesNotThrow(() => check.assert());
  });
  it('fails a longer path', () => {
    const check = budget();
    assert.equal(check.count('pick', [action('a', 'menu'), action('b', 'series')]).status, 'over');
    assert.throws(() => check.assert(), { message: /pick 2 > 1/ });
  });
  it('fails a step that changed nothing, even within the budget', () => {
    const check = budget();
    assert.equal(check.count('open', [action('tool-open', 'menu'), action('open-folder')]).status, 'idle');
    assert.throws(() => check.assert(), { message: /open-folder changed nothing/ });
  });
});

describe('budget coverage', () => {
  const coverage = async (smoke: string[], canonical: string[]) => {
    const evidence = path.join(dir, 'evidence');
    await mkdir(path.join(evidence, 'desktop-smoke'), { recursive: true }); await mkdir(path.join(evidence, 'click-budget'), { recursive: true });
    const results = (tasks: string[]) => tasks.map(task => ({ task, status: 'pass' }));
    await writeFile(path.join(evidence, 'desktop-smoke', 'desktop-smoke.json'), JSON.stringify({ checks: [{ name: 'Click budgets', detail: results(smoke) }] }));
    await writeFile(path.join(evidence, 'click-budget', 'ct-small.json'), JSON.stringify({ results: results(canonical) }));
    return spawnSync(process.execPath, [path.join(root, 'tools/check-budget-coverage.cjs'), evidence, budgets], { encoding: 'utf8', timeout: 10000 });
  };
  it('passes when the two checks together measure every budget', async () => {
    assert.equal((await coverage(['open'], ['pick', 'close'])).status, 0);
  });
  it('fails and names a budget nothing measured', async () => {
    const run = await coverage(['open'], ['pick']);
    assert.equal(run.status, 1);
    assert.ok(run.stderr.includes('close'));
  });
  it('is part of local verification', async () => {
    const verify = await readFile(path.join(root, 'tools/verify.sh'), 'utf8');
    assert.ok(verify.includes('tools/check-click-budget.cjs'));
    assert.ok(verify.includes('tools/check-budget-coverage.cjs'));
  });
});
