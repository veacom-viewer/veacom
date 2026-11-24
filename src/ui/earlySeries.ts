import type { Annotation, Series } from '../model';

/** Where an image is among the series an import gives in the end: the series that holds the same frame of the same
 * file, and the image's place in it. */
export type Holding<T extends Pick<Series, 'id'> = Series> = (sopInstanceUid: string | undefined, sourceFrameNumber: number | undefined) => { item: T; at: number } | undefined;

/**
 * Where an image is among `series`. An image of a file that names no instance (no SOP Instance UID) is nowhere: no
 * other image can be told from it.
 */
export function holdingIn<T extends Pick<Series, 'id' | 'frameMetadata'>>(series: readonly T[]): Holding<T> {
  return (sopInstanceUid, sourceFrameNumber) => {
    if (!sopInstanceUid) return undefined;
    for (const item of series) {
      const at = (item.frameMetadata ?? []).findIndex(frame => frame.sopInstanceUid === sopInstanceUid && frame.sourceFrameNumber === sourceFrameNumber);
      if (at >= 0) return { item, at };
    }
    return undefined;
  };
}

/**
 * The measurements of the series an import gave early and no longer gives (a series read from a disc that came out as
 * more than one): each goes to the series that holds its image, at that image. Those whose image no series holds, and
 * those drawn on no source image, are gone, and counted in `lost`. The map itself when no such series has any.
 */
export function carryAnnotations(annotations: Record<string, Annotation[]>, dropped: ReadonlySet<string>, holding: Holding<Pick<Series, 'id'>>): { annotations: Record<string, Annotation[]>; lost: number } {
  const from = [...dropped].filter(id => Object.hasOwn(annotations, id));
  if (!from.length) return { annotations, lost: 0 };
  const next = { ...annotations };
  let lost = 0;
  for (const id of from) {
    for (const annotation of annotations[id]) {
      const to = annotation.mode === 'source' ? holding(annotation.sourceSopInstanceUid, annotation.sourceFrameNumber) : undefined;
      if (to) next[to.item.id] = [...(next[to.item.id] ?? []), { ...annotation, sourceFrame: to.at, slice: to.at }];
      else lost += 1;
    }
    delete next[id];
  }
  return { annotations: next, lost };
}
