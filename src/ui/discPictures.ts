import type { Series } from '../model';

/**
 * Whether `item` holds the frame `at` of `picture`: the same frame of the same file. A series read from a disc takes
 * its waiting card's picture only then, so that of a series the engine splits in two (one Series Instance UID), or of
 * the gates of a gated study (one file), only the one holding the image shown does; the others draw their own.
 */
export function holdsFrame(item: Pick<Series, 'frameMetadata'>, picture: Pick<Series, 'frameMetadata'>, at: number): boolean {
  const shown = picture.frameMetadata?.[at];
  if (!shown?.sopInstanceUid) return false;
  return (item.frameMetadata ?? []).some(frame => frame.sopInstanceUid === shown.sopInstanceUid && frame.sourceFrameNumber === shown.sourceFrameNumber);
}
