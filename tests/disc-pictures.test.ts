import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FrameMetadata } from '../src/model';
import { holdsFrame } from '../src/ui/discPictures';

const frames = (...shown: [sopInstanceUid: string, sourceFrameNumber?: number][]): { frameMetadata: FrameMetadata[] } => ({
  frameMetadata: shown.map(([sopInstanceUid, sourceFrameNumber]) => ({
    origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: [1, 1, 1], sopInstanceUid, ...(sourceFrameNumber === undefined ? {} : { sourceFrameNumber }),
  })),
});

describe('a waiting card\'s picture and the series read from the disc', () => {
  it('goes to the series that holds its image, and not to another part of a series split in two', () => {
    // The picture is the middle file of the first part (one image per file).
    const picture = frames(['1.2.3.7']);
    assert.equal(holdsFrame(frames(['1.2.3.6'], ['1.2.3.7'], ['1.2.3.8']), picture, 0), true);
    assert.equal(holdsFrame(frames(['1.2.3.20'], ['1.2.3.21']), picture, 0), false);
  });
  it('goes to the gate that holds its frame of a file of many frames, and not to the file\'s other gates', () => {
    // The picture's middle frame is frame 3 of the file; the second gate holds frames 6 to 10 of the same file.
    const picture = frames(['1.2.3.9', 1], ['1.2.3.9', 2], ['1.2.3.9', 3], ['1.2.3.9', 4], ['1.2.3.9', 5]);
    const first = frames(['1.2.3.9', 1], ['1.2.3.9', 2], ['1.2.3.9', 3], ['1.2.3.9', 4], ['1.2.3.9', 5]);
    const second = frames(['1.2.3.9', 6], ['1.2.3.9', 7], ['1.2.3.9', 8], ['1.2.3.9', 9], ['1.2.3.9', 10]);
    assert.equal(holdsFrame(first, picture, 2), true);
    assert.equal(holdsFrame(second, picture, 2), false);
  });
  it('goes nowhere when the picture names no image', () => {
    assert.equal(holdsFrame(frames(['1.2.3.7']), {}, 0), false);
    assert.equal(holdsFrame(frames(['1.2.3.7']), frames(['1.2.3.7']), 1), false);
    assert.equal(holdsFrame({}, frames(['1.2.3.7']), 0), false);
  });
});
