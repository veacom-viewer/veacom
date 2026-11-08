// The arithmetic of tools/check-open-speed.cjs, kept apart so tests/open-speed.test.ts can check it.

/** A small seeded generator (mulberry32), so a run's order and intervals can be reproduced from its seed. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * q, low = Math.floor(at);
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
}
const median = values => quantile(values, 0.5);

/**
 * Compares paired rounds of one phase: each round timed the base and the head on the same machine, one after the
 * other in random order. The change is the median of the rounds' head/base ratios, with a 95% bootstrap interval.
 * It is "slower" only when the whole interval lies above `threshold` (a fraction) and the medians differ by at least
 * `minMs`; "faster" mirrors that; anything else is "same".
 */
function compareRounds(rounds, { threshold = 0.03, minMs = 15, resamples = 2000, seed = 1 } = {}) {
  const pairs = rounds.filter(round => round.base > 0 && round.head > 0);
  const base = median(pairs.map(round => round.base)), head = median(pairs.map(round => round.head));
  if (pairs.length < 3) return { rounds: pairs.length, base, head, change: NaN, low: NaN, high: NaN, verdict: 'too few rounds' };
  const logs = pairs.map(round => Math.log(round.head / round.base));
  const random = createRandom(seed), estimates = [];
  for (let i = 0; i < resamples; i++) estimates.push(median(logs.map(() => logs[Math.floor(random() * logs.length)])));
  const change = Math.exp(median(logs)) - 1, low = Math.exp(quantile(estimates, 0.025)) - 1, high = Math.exp(quantile(estimates, 0.975)) - 1;
  const large = Math.abs(head - base) >= minMs;
  const verdict = large && low > threshold ? 'slower' : large && high < -threshold ? 'faster' : 'same';
  return { rounds: pairs.length, base, head, change, low, high, verdict };
}

/** Checks counted work against budgets: more than the budget fails, less passes and asks for the budget to come down. */
function checkBudgets(counts, budgets = {}) {
  const rows = [];
  for (const [phase, measured] of Object.entries(counts)) {
    for (const key of ['filesOpened', 'bytesRead']) {
      const budget = budgets[phase]?.[key];
      const value = measured[key];
      const status = budget === undefined ? 'new' : value > budget ? 'over' : value < budget ? 'under' : 'pass';
      rows.push({ phase, key, value, budget: budget ?? null, status });
    }
  }
  return rows;
}

/** Budgets as recorded from counts: the work of every phase, as measured. */
function budgetsFrom(counts) {
  return Object.fromEntries(Object.entries(counts).map(([phase, measured]) => [phase, { filesOpened: measured.filesOpened, bytesRead: measured.bytesRead }]));
}

module.exports = { createRandom, quantile, median, compareRounds, checkBudgets, budgetsFrom };
