import { studyKey } from '../domain/patient';
import type { Series } from '../model';

// A scanner puts one image facing another way at the head of a reformatted series: the reference image that shows
// where the slices lie. The engine lists it as a series of one image beside the stack. The series list shows it on
// the stack's card instead of on a card of its own.

const MIN_STACK_IMAGES = 5;

/** Each stack's reference image, by the stack's id: the only one-image series that shares the stack's Series
 * Instance UID in its study, where that UID has one stack. */
export function referenceImages(series: readonly Series[]): Map<string, Series> {
  const families = new Map<string, Series[]>();
  for (const item of series) {
    if (!item.uid || item.segmentation) continue;
    const key = `${studyKey(item)}\u0000${item.uid}`, family = families.get(key);
    if (family) family.push(item); else families.set(key, [item]);
  }
  const references = new Map<string, Series>();
  for (const family of families.values()) {
    const single = family.filter(item => item.dimensions[2] === 1), stacks = family.filter(item => item.dimensions[2] >= MIN_STACK_IMAGES);
    if (family.length === 2 && single.length === 1 && stacks.length === 1 && stacks[0].canReconstruct) references.set(stacks[0].id, single[0]);
  }
  return references;
}
