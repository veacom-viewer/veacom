import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceFrame, reducedTile } from '../src/imaging/frameReduction.ts';

test('fractional source cells contribute their area before windowing', () => {
  const area = reducedTile([0,0,5,1], [5,1], [2,1]);
  const reduced = reduceFrame(new Int16Array([12, 0,-100,0,100,0]),1,[5,1],[2,1],area,false);
  assert.deepEqual([...reduced], [-40,40]);
});

test('missing and padding samples carry zero area; a valid value inside the padding range after averaging stays valid', () => {
  const data = new Float32Array([NaN,5,1,9, Infinity,5,3,7]);
  const reduced = reduceFrame(data,0,[4,2],[2,1],{origin:[0,0],size:[2,1]},false,[5,5]);
  assert.deepEqual([...reduced], [0,0,5,1]);
  const half = reduceFrame(new Int16Array([-1000,80]),0,[2,1],[1,1],{origin:[0,0],size:[1,1]},false,[-1000,-1000]);
  assert.deepEqual([...half], [40,.5]);
});

test('RGB reduction averages each channel of the requested frame', () => {
  const data = new Uint8Array([0,0,0,0,0,0, 10,40,200,30,20,100]);
  assert.deepEqual([...reduceFrame(data,6,[2,1],[1,1],{origin:[0,0],size:[1,1]},true)], [20,30,150]);
});

test('the two-by-two integer reduction uses the frame and the tile offsets', () => {
  const data = Uint16Array.from({length:48}, (_,i)=>i);
  const reduced = reduceFrame(data,24,[6,4],[3,2],{origin:[1,0],size:[2,2]},false);
  assert.deepEqual([...reduced], [29.5,31.5,41.5,43.5]);
});

test('tile halos read the same reduced pixels as the whole odd-sized frame', () => {
  const data = Uint16Array.from({length:91*33}, (_,i) => i%251);
  const all = reduceFrame(data,0,[91,33],[29,12],{origin:[0,0],size:[29,12]},false);
  for (const core of [[0,0,44,33],[44,0,91,33]] as const) {
    const t = reducedTile([...core],[91,33],[29,12]);
    const piece = reduceFrame(data,0,[91,33],[29,12],t,false);
    for (let y=0; y<t.size[1]; y++) {
      const first = (y+t.origin[1])*29+t.origin[0], count=t.size[0];
      assert.deepEqual(piece.slice(y*count,(y+1)*count),all.slice(first,first+count));
    }
  }
});
