// The counterpart of a series in another study of the same patient: what the comparison screen puts beside it
// (docs/arrangements.md). A counterpart is of the same kind, never merely the nearest thing in the other study: where
// nothing is of the same kind there is none, and the reader picks.
import type { Series } from '../model';
import { acquiredPlane } from '../imaging/geometry';
import { sequenceGuess } from '../ui/seriesNames';

/** A description as it is compared: case, runs of spaces and underscores make no difference. */
const words = (text: string) => text.trim().toUpperCase().replace(/[\s_]+/g, ' ');
/** Contrast was given, as the series records it. */
const enhanced = (item: Series) => Boolean(item.contrastBolusAgent?.trim());
const thickness = (item: Series) => item.sliceThickness ?? item.spacing[2];
/** Two stored windows of one look: a lung reconstruction is stored with a lung window, a soft-tissue one with its own. */
function sameLook(a: Series, b: Series): boolean {
  if (a.windowFromPixels || b.windowFromPixels) return false;
  const ratio = Math.max(a.windowWidth, 1) / Math.max(b.windowWidth, 1);
  return Math.abs(a.windowCenter - b.windowCenter) <= 150 && ratio >= 0.5 && ratio <= 2;
}

/** The parts of the trunk and head one scan can cover together (HEADNECK, CHESTABDPELVIS), as Body Part Examined
 * names them. */
const REGIONS: readonly [RegExp, string][] = [[/HEAD|BRAIN|SKULL/, 'head'], [/NECK/, 'neck'], [/CHEST|THORAX|LUNG/, 'chest'], [/ABD/, 'abdomen'], [/PELV/, 'pelvis']];
/** Two series of one part of the body, as far as Body Part Examined tells: both record it and name a part in common
 * (CHEST and CHESTABDPELVIS, HEAD and BRAIN, SPINE and LSPINE), or one of them does not record it. */
function samePart(a: Series, b: Series): boolean {
  const [x, y] = [a, b].map(item => (item.bodyPartExamined ?? '').toUpperCase().replace(/[^A-Z]/g, ''));
  if (!x || !y) return true;
  const [long, short] = x.length >= y.length ? [x, y] : [y, x];
  return long.startsWith(short) || long.endsWith(short) || REGIONS.some(([pattern]) => pattern.test(x) && pattern.test(y));
}

/**
 * How well `item` stands for `anchor` in another study, as numbers compared in order (higher is better), or null when
 * it is not its counterpart.
 * - Always: the same modality, both volumes or neither, the same plane where both have one, and never another part
 *   of the body where both record theirs.
 * - MR: the same likely sequence (T1 with contrast is not T1); for diffusion the nearer b-value ranks higher. A series
 *   whose sequence cannot be told matches only one of the same description.
 * - CT: ranked by the same contrast state, the same description, the same stored look (lung or soft tissue), the
 *   nearer slice thickness and the more slices.
 * - Anything else: only a series of the same description.
 */
export function counterpart(anchor: Series, item: Series): number[] | null {
  if (anchor.segmentation || item.segmentation || anchor.modality !== item.modality || anchor.canReconstruct !== item.canReconstruct || !samePart(anchor, item)) return null;
  const sameWords = Number(Boolean(words(anchor.description)) && words(anchor.description) === words(item.description));
  if (anchor.modality === 'MR') {
    const a = sequenceGuess(anchor), b = sequenceGuess(item);
    if (!a || !b) return !a && !b && sameWords && acquiredPlane(anchor) === acquiredPlane(item) ? [1] : null;
    if (a.role !== b.role || a.plane !== b.plane) return null;
    return [sameWords, -Math.abs((anchor.diffusionBValue ?? 0) - (item.diffusionBValue ?? 0)), -Math.abs(thickness(anchor) - thickness(item))];
  }
  if (acquiredPlane(anchor) !== acquiredPlane(item)) return null;
  if (anchor.modality === 'CT') {
    return [Number(enhanced(anchor) === enhanced(item)), sameWords, Number(sameLook(anchor, item)), -Math.abs(thickness(anchor) - thickness(item)), item.dimensions[2]];
  }
  return sameWords ? [1] : null;
}

/** The best counterpart of `anchor` among `candidates`, the first listed of equals, or null when it has none. */
export function bestCounterpart(anchor: Series, candidates: readonly Series[]): Series | null {
  let best: Series | null = null, bestScore: number[] = [];
  for (const item of candidates) {
    const score = item.id === anchor.id ? null : counterpart(anchor, item);
    if (!score) continue;
    const at = score.findIndex((value, index) => value !== bestScore[index]);
    if (!best || (at >= 0 && score[at] > bestScore[at])) { best = item; bestScore = score; }
  }
  return best;
}
