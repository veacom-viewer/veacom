// The counterpart of a series in another study of the same patient: what the comparison screen puts beside it
// (docs/arrangements.md). A counterpart is of the same kind, never merely the nearest thing in the other study: the
// same modality, plane and part of the body, and for MR the same sequence. Where the other study has nothing of that
// kind there is none, and the reader picks. Among CT series of that kind the best is taken: contrast, name, stored
// window and slice thickness rank them, and none of the four rules a series out.
import type { Series } from '../model';
import { ctContrast } from '../domain/clinical';
import { acquiredPlane } from '../imaging/geometry';
import { sequenceGuess } from '../ui/seriesNames';

/** A description as it is compared: case, runs of spaces and underscores make no difference. */
const words = (text: string) => text.trim().toUpperCase().replace(/[\s_]+/g, ' ');
/** Slice thickness as recorded, else the distance between slices. It only ranks candidates; it is never shown. */
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
/** A part of the body as a series names it: its letters, and its words as they were written apart. */
interface Part { letters: string; words: string[] }
/** The parts of the body a series names: the engine keeps every part its files record, separated by backslashes. */
function partOf(text: string): Part {
  const words = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  return { words, letters: words.join('') };
}
const parts = (item: Series): Part[] => (item.bodyPartExamined ?? '').split('\\').map(partOf).filter(part => part.words.length);
/** Words that say a side, not a part. */
const SIDES = new Set(['L', 'R', 'LT', 'RT', 'LEFT', 'RIGHT', 'BOTH', 'BIL', 'BILATERAL']);
const SPINE_NAMES = new Map([['CERVICAL', 'C'], ['THORACIC', 'T'], ['DORSAL', 'T'], ['LUMBAR', 'L'], ['SACRAL', 'S']]);
/** The levels of the spine a part names (C, T, L, S), all four for the spine as a whole; empty when it is not the
 * spine. */
function spineLevels({ letters, words }: Part): string {
  const named = words.map(word => SPINE_NAMES.get(word) ?? '').join('');
  const short = /^([CTLS]{0,4})SPINE$/.exec(letters);
  if (short) return short[1] || named || 'CTLS';
  return named || (words.includes('SPINE') ? 'CTLS' : '');
}
/** A lone L in L SPINE names the lumbar level. Elsewhere L and R may label a paired body part. */
function side(part: Part, short = true): 'left' | 'right' | 'both' | null {
  const words = part.words;
  if (words.some(word => ['BOTH', 'BIL', 'BILATERAL'].includes(word))) return 'both';
  const left = words.some(word => word === 'LEFT' || word === 'LT' || (short && word === 'L' && !spineLevels(part)));
  const right = words.some(word => word === 'RIGHT' || word === 'RT' || (short && word === 'R'));
  if (left && right) return 'both';
  return left ? 'left' : right ? 'right' : null;
}

/** Two names of one part: the same letters (L-SPINE, LSPINE), a region of the head and trunk in common, a level of the
 * spine in common, or a whole word in common that is not a side (KNEE LEFT, KNEE). A name that merely begins or ends
 * with another is not that part: HIP is not HIPPOCAMPUS, nor ARM FOREARM. */
function alike(x: Part, y: Part): boolean {
  const xSide = side(x), ySide = side(y);
  if ((xSide === 'left' && ySide === 'right') || (xSide === 'right' && ySide === 'left')) return false;
  if (x.letters === y.letters || REGIONS.some(([pattern]) => pattern.test(x.letters) && pattern.test(y.letters))) return true;
  const mine = spineLevels(x), theirs = spineLevels(y);
  if (mine && theirs) return [...mine].some(level => theirs.includes(level));
  return x.words.some(word => !SIDES.has(word) && y.words.includes(word));
}
function seriesSide(item: Series, anatomy: Part[]) {
  if (item.laterality) return item.laterality === 'L' ? 'left' : item.laterality === 'R' ? 'right' : null;
  const named = new Set(anatomy.map(part => side(part)).filter(value => value !== null));
  if (named.size) return named.size === 1 ? [...named][0] : null;
  // A single L in a sequence description can stand for lumbar or a scan parameter.
  return side(partOf(item.description), false);
}

/** Two series of one part of the body, as far as Body Part Examined tells: both record it and name a part in common
 * (CHEST and CHESTABDPELVIS, HEAD and BRAIN, SPINE and LSPINE), or one of them does not record it. */
function samePart(a: Series, b: Series): boolean {
  const mine = parts(a), theirs = parts(b);
  const x = seriesSide(a, mine), y = seriesSide(b, theirs);
  if ((x === 'left' && y === 'right') || (x === 'right' && y === 'left')) return false;
  return !mine.length || !theirs.length || mine.some(x => theirs.some(y => alike(x, y)));
}

/**
 * How well `item` stands for `anchor` in another study, as numbers compared in order (higher is better), or null when
 * it is not its counterpart.
 * - Always: the same modality, both volumes or neither, the same plane where both have one, and never another part
 *   of the body where both record theirs.
 * - MR: the same likely sequence (T1 with contrast is not T1); for diffusion the nearer b-value ranks higher. A series
 *   whose sequence cannot be told matches only one of the same description.
 * - CT: ranked by the same contrast state, the same description, the same stored look (lung or soft tissue), the
 *   nearer slice thickness and the more slices. Whether a series was taken before or after contrast is read from its
 *   record, its name and its place in its study (`ctContrast`); where that is not told for one of the two, contrast
 *   counts neither for nor against the pair.
 * - Anything else: only a series of the same description.
 * `session` is every loaded series: a CT's contrast state depends on the other series of its study.
 */
export function counterpart(anchor: Series, item: Series, session: readonly Series[] = [anchor, item]): number[] | null {
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
    const mine = ctContrast(anchor, session), theirs = ctContrast(item, session);
    const sameContrast = mine && theirs ? Number(mine === theirs) : 0.5;
    return [sameContrast, sameWords, Number(sameLook(anchor, item)), -Math.abs(thickness(anchor) - thickness(item)), item.dimensions[2]];
  }
  return sameWords ? [1] : null;
}

/** The best counterpart of `anchor` among `candidates`, the first listed of equals, or null when it has none.
 * `session`: every loaded series, as `counterpart` takes it. */
export function bestCounterpart(anchor: Series, candidates: readonly Series[], session: readonly Series[] = [anchor, ...candidates]): Series | null {
  let best: Series | null = null, bestScore: number[] = [];
  for (const item of candidates) {
    const score = item.id === anchor.id ? null : counterpart(anchor, item, session);
    if (!score) continue;
    const at = score.findIndex((value, index) => value !== bestScore[index]);
    if (!best || (at >= 0 && score[at] > bestScore[at])) { best = item; bestScore = score; }
  }
  return best;
}
