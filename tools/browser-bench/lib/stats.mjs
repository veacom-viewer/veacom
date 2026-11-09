// Summaries that say how sure a number is: the median with a bootstrap 95% interval, and whether two viewers differ
// by more than the noise the run measured on itself (the same VEAcom build run twice, "A/A").

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A seeded generator, so a report recomputed from the same results gives the same intervals. */
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32; };
}

/** Median and a percentile-bootstrap 95% interval of the median. */
export function summarize(values, { resamples = 2000, seed = 0x5eed } = {}) {
  const data = values.filter(Number.isFinite);
  if (!data.length) return { n: 0, median: null, low: null, high: null };
  const next = random(seed), medians = [];
  for (let r = 0; r < resamples; r++) {
    const sample = Array.from({ length: data.length }, () => data[Math.floor(next() * data.length)]);
    medians.push(median(sample));
  }
  medians.sort((a, b) => a - b);
  return { n: data.length, median: median(data), low: medians[Math.floor(resamples * 0.025)], high: medians[Math.ceil(resamples * 0.975) - 1] };
}

/**
 * Compares two viewers' values for one metric: the ratio of medians and its bootstrap interval. A difference is only
 * called when the interval excludes 1 and the ratio is outside the A/A noise (`noise`, e.g. 0.03 for ±3%).
 */
export function compare(a, b, { noise = 0, resamples = 2000, seed = 0xc0de } = {}) {
  const x = a.filter(Number.isFinite), y = b.filter(Number.isFinite);
  if (!x.length || !y.length) return null;
  const next = random(seed), ratios = [];
  for (let r = 0; r < resamples; r++) {
    const mx = median(Array.from({ length: x.length }, () => x[Math.floor(next() * x.length)]));
    const my = median(Array.from({ length: y.length }, () => y[Math.floor(next() * y.length)]));
    if (my) ratios.push(mx / my);
  }
  ratios.sort((p, q) => p - q);
  // No ratio against a reference whose median is zero (a lag of 0 ms, say): the comparison is unavailable.
  if (!median(y) || !ratios.length) return null;
  const ratio = median(x) / median(y), low = ratios[Math.floor(ratios.length * 0.025)], high = ratios[Math.ceil(ratios.length * 0.975) - 1];
  const differs = ratio !== null && (low > 1 || high < 1) && Math.abs(ratio - 1) > noise;
  return { ratio, low, high, differs };
}
