import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { createRandom, compareRounds, checkBudgets, budgetsFrom } = createRequire(import.meta.url)('../tools/lib/open-speed.cjs');

// Paired rounds around a base of `ms`, with the head `factor` times slower and a little alternating jitter.
const rounds = (count: number, ms: number, factor: number, jitter = 0.005) => Array.from({ length: count }, (_, i) => {
  const wobble = 1 + (i % 2 ? jitter : -jitter);
  return { base: ms * wobble, head: ms * factor * (1 + (i % 3 - 1) * jitter) };
});

describe('opening speed comparison', () => {
  it('calls identical engines the same', () => {
    const result = compareRounds(rounds(20, 1000, 1), { seed: 3 });
    assert.equal(result.verdict, 'same');
    assert.ok(Math.abs(result.change) < 0.01);
    assert.ok(result.low <= 0 && result.high >= 0);
  });
  it('flags a steady slowdown beyond the threshold, and a speed-up', () => {
    assert.equal(compareRounds(rounds(20, 1000, 1.1)).verdict, 'slower');
    assert.equal(compareRounds(rounds(20, 1000, 0.9)).verdict, 'faster');
  });
  it('does not flag a change inside the threshold', () => {
    assert.equal(compareRounds(rounds(20, 1000, 1.02), { threshold: 0.03 }).verdict, 'same');
  });
  it('does not flag a large ratio of a tiny time', () => {
    const result = compareRounds(rounds(20, 4, 1.5), { minMs: 15 });
    assert.ok(result.low > 0.3);
    assert.equal(result.verdict, 'same');
  });
  it('does not flag noise that goes both ways', () => {
    const noisy = Array.from({ length: 20 }, (_, i) => ({ base: 1000, head: 1000 * (i % 2 ? 1.2 : 0.83) }));
    assert.equal(compareRounds(noisy).verdict, 'same');
  });
  it('needs at least three paired rounds', () => {
    assert.equal(compareRounds([{ base: 1, head: 2 }, { base: 1, head: NaN }]).verdict, 'too few rounds');
  });
  it('gives the same interval for the same seed', () => {
    const data = rounds(15, 500, 1.04, 0.03);
    assert.deepEqual(compareRounds(data, { seed: 9 }), compareRounds(data, { seed: 9 }));
    const random = createRandom(5), again = createRandom(5);
    assert.deepEqual([random(), random()], [again(), again()]);
  });
});

describe('opening work budgets', () => {
  const counts = { listing: { filesOpened: 3001, readCalls: 5001, bytesRead: 1000 }, volume: { filesOpened: 1000, readCalls: 3000, bytesRead: 500 } };
  it('fails more work, passes less and equal, and reports a missing budget', () => {
    const rows = checkBudgets(counts, { listing: { filesOpened: 1001, bytesRead: 2000 }, volume: { filesOpened: 1000 } });
    const status = (phase: string, key: string) => rows.find((row: { phase: string, key: string }) => row.phase === phase && row.key === key).status;
    assert.equal(status('listing', 'filesOpened'), 'over');
    assert.equal(status('listing', 'bytesRead'), 'under');
    assert.equal(status('volume', 'filesOpened'), 'pass');
    assert.equal(status('volume', 'bytesRead'), 'new');
  });
  it('records files opened and bytes read, not read calls', () => {
    assert.deepEqual(budgetsFrom(counts), { listing: { filesOpened: 3001, bytesRead: 1000 }, volume: { filesOpened: 1000, bytesRead: 500 } });
  });
  it('keeps a budget for every step of the synthetic CT', () => {
    const file = JSON.parse(readFileSync(new URL('../tools/open-budgets.json', import.meta.url), 'utf8'));
    for (const step of ['listing', 'firstFrame', 'volume']) {
      assert.ok(Number.isInteger(file.studies['ct-1000'][step].filesOpened));
      assert.ok(Number.isInteger(file.studies['ct-1000'][step].bytesRead));
    }
  });
});
