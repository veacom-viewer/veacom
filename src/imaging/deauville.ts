// Scores from reference regions, as data: a scale is a list of bands, each up to a multiple of one reference's value.
// The Deauville five-point scale (Lugano 2014; Barrington et al., J Clin Oncol 2014) compares a lesion's uptake with the
// mediastinal blood pool and the liver. Here the lesion's SUVmax is compared with each reference sphere's SUVmax, as the
// ratio-based Deauville readings do. The helper only suggests: the reader confirms the score, or chooses another.
//
// The bands compare ratios, so the score is the same in SUVbw, SUL or SUVbsa as long as the lesion and the references
// are read in one quantity on one PET.

import type { DeauvilleScore, ReferenceRole } from '../model';

export type { DeauvilleScore, ReferenceRole };
export const DEAUVILLE_SCORES: readonly DeauvilleScore[] = [1, 2, 3, 4, 5, 'X'];

export interface Band {
  score: number;
  /** The band holds values up to `times` × the reference's value, inclusive unless exclusive is set; null for the last band. */
  upTo: { reference: ReferenceRole; times: number } | null;
  exclusive?: boolean;
}

/** Deauville 2–5 from SUVmax. Score 1 (no uptake above background) and X (new uptake unlikely to be lymphoma) are judged
 * by eye and never suggested. Score 5 is uptake "markedly higher than liver", read as 2–3 times the liver's SUVmax:
 * the lower bound is taken, and the basis says when a lesion lies between 2 and 3 times. */
export const DEAUVILLE_BANDS: readonly Band[] = [
  { score: 2, upTo: { reference: 'bloodPool', times: 1 } },
  { score: 3, upTo: { reference: 'liver', times: 1 } },
  { score: 4, upTo: { reference: 'liver', times: 2 }, exclusive: true },
  { score: 5, upTo: null },
];

/** Within this share of a band's bound, a value is said to be near it, so the reader looks again. */
export const NEAR_BOUND = 0.1;

export type References = Readonly<Record<ReferenceRole, number>>;
export interface Suggestion {
  score: number;
  /** The lesion's value as a multiple of each reference's value. */
  ratios: Record<ReferenceRole, number>;
  /** The band's bounds below and above the value (null at the ends of the scale). */
  lower: { reference: ReferenceRole; times: number; value: number } | null;
  upper: { reference: ReferenceRole; times: number; value: number } | null;
  /** A bound the value lies within NEAR_BOUND of, and the score on its other side. */
  near: { reference: ReferenceRole; times: number; value: number; otherScore: number } | null;
}
export type SuggestionProblem = 'missing' | 'order';

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/** The band `value` falls in, given the references' values; a problem when a reference is missing or when the bounds
 * do not rise along the scale (a blood pool reading higher than the liver means one reference sphere is misplaced). */
export function suggestScore(bands: readonly Band[], value: number, references: Partial<References>): Suggestion | { problem: SuggestionProblem } {
  const needed = [...new Set(bands.flatMap(band => band.upTo ? [band.upTo.reference] : []))];
  if (!Number.isFinite(value) || value < 0 || !needed.every(role => positive(references[role]))) return { problem: 'missing' };
  const bounds = bands.map(band => band.upTo ? { ...band.upTo, value: band.upTo.times * references[band.upTo.reference]! } : null);
  for (let i = 1; i < bounds.length; i++) if (bounds[i] && bounds[i - 1] && bounds[i]!.value < bounds[i - 1]!.value) return { problem: 'order' };
  let index = bounds.findIndex((bound, i) => bound !== null && (bands[i].exclusive ? value < bound.value : value <= bound.value));
  if (index < 0) index = bands.length - 1;
  const lower = index > 0 ? bounds[index - 1] : null, upper = bounds[index];
  // Equal references leave score 3 with no interval. The next attainable score across that boundary is 4.
  const below = lower ? bounds.findIndex(bound => bound && bound.value === lower.value) : -1;
  let above = index + 1;
  while (upper && bounds[above]?.value === upper.value) above++;
  const nearest = [lower && { bound: lower, otherScore: bands[below].score }, upper && { bound: upper, otherScore: bands[above]?.score }]
    .filter((item): item is { bound: NonNullable<typeof lower>; otherScore: number } => !!item && item.otherScore !== undefined)
    .map(item => ({ ...item, distance: Math.abs(value / item.bound.value - 1) }))
    .filter(item => item.distance <= NEAR_BOUND)
    .sort((a, b) => a.distance - b.distance)[0];
  const ratios = Object.fromEntries(needed.map(role => [role, value / references[role]!])) as Record<ReferenceRole, number>;
  return { score: bands[index].score, ratios, lower, upper, near: nearest ? { ...nearest.bound, otherScore: nearest.otherScore } : null };
}

/** The Deauville score suggested for a lesion's SUVmax against the liver's and the blood pool's SUVmax. */
export const suggestDeauville = (lesionMax: number, references: Partial<References>) => suggestScore(DEAUVILLE_BANDS, lesionMax, references);

/** Whether a value read back from storage is a Deauville score. */
export const isDeauvilleScore = (value: unknown): value is DeauvilleScore => DEAUVILLE_SCORES.includes(value as DeauvilleScore);
