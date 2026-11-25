import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Vec3 } from '../src/model';
import { planePixels, planeTexture } from '../src/imaging/planeTexture';

it('uploads the same integer voxels for every cardinal plane and both trilinear neighbours at the volume borders', () => {
  const dims: Vec3 = [69, 75, 81];
  const data = new Int16Array(dims[0] * dims[1] * dims[2]);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) % 65521 - 32760;
  for (const axis of [0, 1, 2]) for (const at of [-0.5, 7.75, 23.2, dims[axis] - 0.5]) {
    const origin: Vec3 = [30, 30, 30], right: Vec3 = [0, 0, 0], down: Vec3 = [0, 0, 0];
    origin[axis] = at;
    right[(axis + 1) % 3] = 0.8;
    down[(axis + 2) % 3] = -1.2;
    const region = planeTexture(dims, origin, right, down, 1919, 1079);
    assert.ok(region);
    for (const near of [Math.floor(at), Math.floor(at) + 1]) {
      const clamped = Math.max(0, Math.min(dims[axis] - 1, near));
      assert.ok(clamped >= region.start[axis] && clamped < region.start[axis] + region.size[axis]);
    }
    const packed = planePixels(data, dims, region);
    assert.ok(packed instanceof Int16Array);
    assert.equal(packed.length, region.size[0] * region.size[1] * region.size[2]);
    let i = 0;
    for (let z = 0; z < region.size[2]; z++) for (let y = 0; y < region.size[1]; y++) for (let x = 0; x < region.size[0]; x++) {
      const src: number = ((z + region.start[2]) * dims[1] + y + region.start[1]) * dims[0] + x + region.start[0];
      assert.equal(packed[i++], data[src]);
    }
  }
  assert.equal(planeTexture(dims, [3, 4, 5], [1, 0.25, 0], [0, 1, 0.25], 256, 256), undefined);
});
