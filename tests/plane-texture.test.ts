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

it('reuses a block while scrolling and includes the neighbours at both ends of a nearly axis-aligned plane', () => {
  const dims: Vec3 = [69, 75, 81];
  const regionAt = (x: number) => planeTexture(dims, [x, 0, 0], [0.0000002, 1, 0], [-0.0000003, 0, 1], 1000, 1000)!;
  const first = regionAt(20);
  for (const x of [17.501, 18, 19, 20, 21, 21.499]) assert.deepEqual(regionAt(x), first);
  assert.notDeepEqual(regionAt(21.501), first);
  for (let x = -0.5; x < dims[0]; x += 0.125) {
    const region = regionAt(x);
    assert.ok(region.size[0] <= 7);
    for (const sample of [x - 0.0003, x + 0.0002]) {
      for (const i of [Math.floor(sample), Math.floor(sample) + 1]) {
        const voxel = Math.max(0, Math.min(dims[0] - 1, i));
        assert.ok(voxel >= region.start[0] && voxel < region.start[0] + region.size[0]);
      }
    }
  }
});

it('keeps adjacent integer slices in the same groups as the padded eight-plane textures', () => {
  for (const depth of [64, 65, 66, 67, 68, 69, 70, 71, 512, 1000]) {
    let previousGroup = '', previousTexture;
    for (let slice = 0; slice < depth; slice++) {
      const low = Math.floor(Math.max(0, slice - 2) / 8);
      const high = Math.floor(Math.min(depth - 1, slice + 2) / 8);
      const group = [low, high].join(',');
      const texture = planeTexture([64, 64, depth], [0, 0, slice], [1, 0, 0], [0, 1, 0], 64, 64);
      assert.ok(texture);
      if (group === previousGroup) assert.deepEqual(texture, previousTexture);
      else assert.notDeepEqual(texture, previousTexture);
      previousGroup = group;
      previousTexture = texture;
    }
  }
});
