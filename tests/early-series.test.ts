import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Annotation, FrameMetadata } from '../src/model';
import { carryAnnotations, holdingIn } from '../src/ui/earlySeries';

// A series whose images are each a frame of a file: [SOP Instance UID, frame number]. A file that names no instance
// gives no UID.
const series = (id: string, ...shown: [sopInstanceUid?: string, sourceFrameNumber?: number][]): { id: string; frameMetadata: FrameMetadata[] } => ({
  id,
  frameMetadata: shown.map(([sopInstanceUid, sourceFrameNumber]) => ({
    origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [1, 1, 1],
    ...(sopInstanceUid === undefined ? {} : { sopInstanceUid }), ...(sourceFrameNumber === undefined ? {} : { sourceFrameNumber }),
  })),
});
const length = (id: string, at: number, sourceSopInstanceUid?: string): Annotation => ({
  id, type: 'length', points: [[0, 0, at], [10, 0, at]], plane: 'axial', slice: at, mode: 'source', sourceFrame: at,
  ...(sourceSopInstanceUid === undefined ? {} : { sourceSopInstanceUid }),
});

describe('the measurements of a series read from a disc that comes out of the import as more than one', () => {
  // Read early as one series of four images; in the end the two phases of its Series Instance UID, in another order.
  const holding = holdingIn([series('phase-1', ['1.2.3.2'], ['1.2.3.1']), series('phase-2', ['1.2.3.4'], ['1.2.3.3'])]);

  it('go to the phase that holds their image, at that image, and those of other series stay', () => {
    const { annotations, lost } = carryAnnotations({ early: [length('a', 2, '1.2.3.3')], other: [length('b', 0, '1.2.3.9')] }, new Set(['early']), holding);
    assert.equal(lost, 0);
    assert.deepEqual(Object.keys(annotations).sort(), ['other', 'phase-2']);
    assert.deepEqual(annotations['phase-2'].map(item => [item.id, item.sourceFrame, item.slice]), [['a', 1, 1]]);
    assert.deepEqual(annotations.other.map(item => item.id), ['b']);
  });

  it('go the same way in a step Undo brings back, taken before the series came out as two', () => {
    // The step holds the measurement as it was before it was moved: Undo puts it back on the phase, not on the series
    // that is gone.
    const saved = { early: [{ ...length('a', 2, '1.2.3.3'), points: [[0, 0, 2], [5, 0, 2]] as Annotation['points'] }] };
    const { annotations } = carryAnnotations(saved, new Set(['early']), holding);
    assert.deepEqual(Object.keys(annotations), ['phase-2']);
    assert.deepEqual(annotations['phase-2'][0].points, [[0, 0, 2], [5, 0, 2]]);
  });

  it('are counted as not kept when their image names no instance, though the import holds it', () => {
    // A synthetic file with no SOP Instance UID, which is read all the same: nothing tells which phase holds its image.
    const unnamed = holdingIn([series('phase-1', ['1.2.3.1'], []), series('phase-2', ['1.2.3.3'])]);
    assert.equal(unnamed(undefined, undefined), undefined);
    assert.equal(unnamed('', undefined), undefined);
    const { annotations, lost } = carryAnnotations({ early: [length('a', 1), length('b', 0, '1.2.3.3')] }, new Set(['early']), unnamed);
    assert.equal(lost, 1);
    assert.deepEqual(Object.keys(annotations), ['phase-2']);
    assert.deepEqual(annotations['phase-2'].map(item => item.id), ['b']);
  });

  it('are counted as not kept when no series holds their image, or when they were drawn on a reconstruction', () => {
    const reconstructed: Annotation = { ...length('c', 0, '1.2.3.1'), mode: 'mpr' };
    const { annotations, lost } = carryAnnotations({ early: [reconstructed, length('d', 0, '1.2.3.8')] }, new Set(['early']), holding);
    assert.equal(lost, 2);
    assert.deepEqual(annotations, {});
  });

  it('are left as they are when no series that is gone has any', () => {
    const kept = { other: [length('b', 0, '1.2.3.9')] };
    assert.equal(carryAnnotations(kept, new Set(['early']), holding).annotations, kept);
    assert.equal(carryAnnotations(kept, new Set(), holding).annotations, kept);
  });
});
