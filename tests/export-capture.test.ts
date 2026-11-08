import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { restoreGlobals, stubGlobal } from './support';
import { waitForSlice } from '../src/export-video';

// A pane as the capture loop sees it: its canvas and overlay say which series and slice they last drew.
function pane(shown: { seriesId: string; slice: number }) {
  const layer = () => ({ dataset: { slice: String(shown.slice), seriesId: shown.seriesId } });
  const element = { querySelector: (selector: string) => selector.startsWith('canvas') || selector.startsWith('svg') ? layer() : null };
  return element as unknown as HTMLElement;
}

beforeEach(() => {
  stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(restoreGlobals);

describe('picture and video capture', () => {
  it('captures a slice once the exported series presents it', async () => {
    assert.equal(await waitForSlice(pane({ seriesId: 'ct', slice: 4 }), 4, undefined, 'ct'), undefined);
  });

  it('stops at once when the pane shows another series, even at the same slice number', async () => {
    // The series list, toolbar and keyboard stay usable while a capture runs; a series picked there replaces the
    // exported one in the pane. Its slice 4 must not be written into the first series' pictures or video.
    const started = performance.now();
    await assert.rejects(waitForSlice(pane({ seriesId: 'other-patient', slice: 4 }), 4, undefined, 'ct'), { messageKey: 'video.paneChanged' });
    assert.ok((performance.now() - started) < 1000);
  });

  it('keeps checks that name no series working (the encoder check drives a bare canvas)', async () => {
    assert.equal(await waitForSlice(pane({ seriesId: 'anything', slice: 2 }), 2), undefined);
  });
});

