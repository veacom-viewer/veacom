import { studyKey } from '../domain/patient';
import { cross, dot, length } from '../imaging/geometry';
import { pagingPlace } from '../imaging/paging';
import type { Series, Vec3 } from '../model';

// A scanner puts one image facing another way at the head of a reformatted series: the reference image that shows
// where the slices lie. The engine lists it as a series of one image beside the stack, so that the stack can be
// reconstructed. To the reader the two are one series: the image is counted among the stack's images, stands on the
// stack's card, and is reached by paging past the end of the stack it stands at.

const MIN_STACK_IMAGES = 5;
/** Planes more than this many degrees apart are different planes. A reference image lies across its stack; a single
 * image in the stack's own plane is another part of the series and keeps its card. */
const OTHER_PLANE_DEGREES = 10;

/** The unit normal of the plane a series' images lie in, its row direction × its column direction. Null where the
 * series' orientation is not known. */
function planeNormal(item: Series): Vec3 | null {
  const d = item.direction;
  if (item.orientationKnown !== true || d.length !== 9) return null;
  const normal = cross([d[0], d[3], d[6]], [d[1], d[4], d[7]]), size = length(normal);
  return Number.isFinite(size) && size > 1e-6 ? [normal[0] / size, normal[1] / size, normal[2] / size] : null;
}

/** Whether an image lies in another plane than a stack. An unknown orientation is no evidence that it does. */
function facesAnotherWay(image: Series, stack: Series): boolean {
  const own = planeNormal(image), theirs = planeNormal(stack);
  return own !== null && theirs !== null && Math.abs(dot(own, theirs)) < Math.cos(OTHER_PLANE_DEGREES * Math.PI / 180);
}

/** Each stack's reference image, by the stack's id: the only one-image series that shares the stack's Series
 * Instance UID in its study, where that UID has one stack and the image faces another way than the stack. The
 * importer also splits one Series Instance UID by acquisition or by time: a single image in the stack's own plane
 * is such a part, with a card and a phase of its own, not a reference image. */
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
    if (family.length === 2 && single.length === 1 && stacks.length === 1 && stacks[0].canReconstruct && facesAnotherWay(single[0], stacks[0])) references.set(stacks[0].id, single[0]);
  }
  return references;
}

/** A stack and its reference image as the one sequence a pane pages: how many images it has, and where the reference
 * image stands in it, from 0 in paging order. The image stands at the end of the stack the scanner numbered it next
 * to, so that the numbers run on: before the slices where its Instance Number is nearer the first paged slice's,
 * after them where it is nearer the last's. With no numbers to go by it comes first. */
export function joinedWith(stack: Series, reference: Series): { total: number; leadAt: number } {
  const count = stack.dimensions[2], acquired = { plane: 'axial', mode: 'source' } as const;
  const numberOf = (item: Series, slice: number) => item.frameMetadata?.[slice]?.instanceNumber;
  const own = numberOf(reference, 0), first = numberOf(stack, pagingPlace(stack, acquired, 0, count)), last = numberOf(stack, pagingPlace(stack, acquired, count - 1, count));
  const after = own !== undefined && first !== undefined && last !== undefined && Math.abs(own - last) < Math.abs(own - first);
  return { total: count + 1, leadAt: after ? count : 0 };
}
