import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { DEAUVILLE_BANDS, isDeauvilleScore, NEAR_BOUND, suggestDeauville, suggestScore, type Band, type Suggestion } from '../src/imaging/deauville';

const references = { bloodPool: 1.5, liver: 2 };
const score = (lesion: number, values: Partial<typeof references> = references) => (suggestDeauville(lesion, values) as Suggestion).score;

describe('Deauville suggestion', () => {
  it('uses the PRoLoG 2× threshold including equality', () => {
    assert.equal(score(0.4), 2);
    assert.equal(score(1.5), 2); // equal to the blood pool: not above it
    assert.equal(score(1.5000001), 3);
    assert.equal(score(2), 3); // equal to the liver
    assert.equal(score(2.0000001), 4);
    assert.deepEqual([1.99, 2.00, 2.01].map(ratio => score(2 * ratio)), [4, 5, 5]);
    assert.equal(score(4.0000001), 5);
    assert.equal(score(30), 5);
  });

  it('gives the same score in SUVbw, SUL or SUVbsa: the bands are ratios', () => {
    for (const lesion of [0.9, 1.5, 1.7, 2, 3.1, 4, 4.4, 9]) {
      for (const factor of [0.8, 0.0123, 7]) {
        assert.equal(score(lesion * factor, { bloodPool: 1.5 * factor, liver: 2 * factor }), score(lesion), `${lesion} × ${factor}`);
      }
    }
  });

  it('shows its basis: the ratios and the band bounds', () => {
    const suggestion = suggestDeauville(3, references) as Suggestion;
    assert.equal(suggestion.score, 4);
    assertClose(suggestion.ratios.liver, 1.5);
    assertClose(suggestion.ratios.bloodPool, 2);
    assert.deepEqual(suggestion.lower, { reference: 'liver', times: 1, value: 2 });
    assert.deepEqual(suggestion.upper, { reference: 'liver', times: 2, value: 4 });
    assert.equal(suggestion.near, null);
    const top = suggestDeauville(9, references) as Suggestion;
    assert.equal(top.upper, null);
    assert.deepEqual(top.lower, { reference: 'liver', times: 2, value: 4 });
    assert.equal((suggestDeauville(1, references) as Suggestion).lower, null);
  });

  it(`says when the lesion lies within ${NEAR_BOUND * 100}% of a bound, and which score is on its other side`, () => {
    assert.deepEqual((suggestDeauville(2.1, references) as Suggestion).near, { reference: 'liver', times: 1, value: 2, otherScore: 3 });
    assert.deepEqual((suggestDeauville(1.9, references) as Suggestion).near, { reference: 'liver', times: 1, value: 2, otherScore: 4 });
    assert.deepEqual((suggestDeauville(4.3, references) as Suggestion).near, { reference: 'liver', times: 2, value: 4, otherScore: 4 });
    assert.deepEqual((suggestDeauville(1.4, references) as Suggestion).near, { reference: 'bloodPool', times: 1, value: 1.5, otherScore: 3 });
    assert.equal((suggestDeauville(3, references) as Suggestion).near, null);
  });

  it('suggests nothing without both references, or with the blood pool above the liver', () => {
    assert.deepEqual(suggestDeauville(3, { liver: 2 }), { problem: 'missing' });
    assert.deepEqual(suggestDeauville(3, { bloodPool: 1.5 }), { problem: 'missing' });
    assert.deepEqual(suggestDeauville(3, { bloodPool: 0, liver: 2 }), { problem: 'missing' });
    assert.deepEqual(suggestDeauville(Number.NaN, references), { problem: 'missing' });
    assert.deepEqual(suggestDeauville(3, { bloodPool: 2.5, liver: 2 }), { problem: 'order' });
    assert.equal(score(3, { bloodPool: 2, liver: 2 }), 4);
    assert.equal((suggestDeauville(2, { bloodPool: 2, liver: 2 }) as Suggestion).near?.otherScore, 4);
  });

  it('never suggests 1 or X, which are judged by eye', () => {
    assert.deepEqual(DEAUVILLE_BANDS.map(band => band.score), [2, 3, 4, 5]);
    assert.equal(isDeauvilleScore(1) && isDeauvilleScore('X') && isDeauvilleScore(5), true);
    assert.equal(isDeauvilleScore(6) || isDeauvilleScore('4') || isDeauvilleScore(null), false);
  });

  it('reads any scale given as bands of reference multiples', () => {
    // A made-up three-band scale against the liver alone: the suggester is the same code.
    const bands: Band[] = [{ score: 0, upTo: { reference: 'liver', times: 1.5 } }, { score: 1, upTo: { reference: 'liver', times: 3 } }, { score: 2, upTo: null }];
    assert.equal((suggestScore(bands, 2.9, { liver: 2 }) as Suggestion).score, 0);
    assert.equal((suggestScore(bands, 6, { liver: 2 }) as Suggestion).score, 1);
    assert.equal((suggestScore(bands, 6.1, { liver: 2 }) as Suggestion).score, 2);
  });
});
