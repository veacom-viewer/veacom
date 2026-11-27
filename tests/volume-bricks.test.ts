import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDisplayVolume,
  displayStride,
  downsampleLabelSubbox,
  fullToDisplayCoord,
  MAX_SLICE_BRICKS,
  needsBricking,
  planSliceBricks,
  syncDisplayMaskBox,
} from '../src/imaging/volumeBricks';
import type { Series, Vec3, Volume } from '../src/model';

function syntheticSeries(dimensions: Vec3, pixelType: Series['pixelType'] = 'int16'): Series {
  return {
    id: 'brick-ct',
    uid: '1.2.3.4',
    studyUid: '1.2.3',
    studyDate: '20260101',
    seriesNumber: 1,
    patientId: 'SYNTH',
    patientName: 'Synthetic^Brick',
    modality: 'CT',
    description: 'Long stack CT',
    dimensions,
    spacing: [0.5, 0.5, 0.5],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    windowCenter: 40,
    windowWidth: 400,
    valueUnit: 'HU',
    suvFactor: null,
    canReconstruct: true,
    pixelType,
    components: 1,
    photometricInterpretation: 'MONOCHROME2',
    warnings: [],
  };
}

describe('volumeBricks', () => {
  it('plans a single bounded brick for an axial slice of a >2048-slice stack', () => {
    const dims: Vec3 = [512, 512, 2800];
    assert.equal(needsBricking(dims, 2048), true);
    assert.equal(needsBricking([512, 512, 2048], 2048), false);

    // Axial slice at z = 2400 with a 10-slice half-slab thickness.
    const bricks = planSliceBricks(dims, [0, 0, 2400], [1, 0, 0], [0, 1, 0], 512, 512, 2048, [0, 0, 1], 10);
    assert(bricks !== null);
    assert.equal(bricks.length, 1);
    assert.deepEqual(bricks[0].coreMin, [0, 0, 2400]);
    assert.deepEqual(bricks[0].coreMax, [512, 512, 2401]);
    // Halo includes 1 voxel trilinear + 10 voxel slab reach -> z in [2389, 2412).
    assert.equal(bricks[0].region.start[2], 2389);
    assert.equal(bricks[0].region.size[2], 23);
    assert(bricks[0].region.size.every(size => size <= 2048));
  });

  it('partitions a coronal slice across a 2800-slice stack into disjoint haloed bricks <= 2048', () => {
    const dims: Vec3 = [512, 512, 2800];
    // Coronal slice at y = 256 spanning full X [0..512] and full Z [0..2800].
    const bricks = planSliceBricks(dims, [0, 256, 2799], [1, 0, 0], [0, 0, -4], 512, 700, 2048);
    assert(bricks !== null);
    assert.equal(bricks.length, 2);
    for (const brick of bricks) {
      assert(brick.region.size.every(size => size <= 2048), `oversized brick: ${brick.region.size}`);
      assert(brick.region.start.every((s, a) => s >= 0 && s + brick.region.size[a] <= dims[a]));
    }
    // Exact disjoint half-open Z partition covering [0, 2800) with matching interior clip boundary.
    assert.equal(bricks[0].coreMin[2], 0);
    assert.equal(bricks[0].coreMax[2], bricks[1].coreMin[2]);
    assert.equal(bricks[1].coreMax[2], 2800);
    assert.equal(bricks[0].clipMax[2], bricks[1].clipMin[2]);
    // Interior boundary includes halo on both sides for exact trilinear interpolation.
    const boundary = bricks[0].coreMax[2];
    assert(bricks[0].region.start[2] + bricks[0].region.size[2] > boundary);
    assert(bricks[1].region.start[2] < boundary);
  });

  it('handles oblique and multi-axis oversized volumes while bounding brick count at extreme zoom-out', () => {
    const dims: Vec3 = [3000, 3000, 20];
    const bricks = planSliceBricks(dims, [0, 0, 10], [3, 0.5, 0.01], [-0.5, 3, -0.01], 1000, 1000, 2048);
    assert(bricks !== null);
    assert(bricks.length >= 4 && bricks.length <= MAX_SLICE_BRICKS);
    for (const brick of bricks) assert(brick.region.size.every(size => size <= 2048));

    // Extreme zoom-out on 8192 x 8192 x 2 in a 32 px pane must keep halo bounded instead of collapsing maxCore to 2.
    const zoomedOut = planSliceBricks([8192, 8192, 2], [-30000, -30000, 1], [2560, 0, 0], [0, 2560, 0], 32, 32, 2048);
    assert(zoomedOut !== null);
    assert(zoomedOut.length > 0 && zoomedOut.length <= MAX_SLICE_BRICKS);
    for (const brick of zoomedOut) assert(brick.region.size.every(size => size <= 2048));

    // Pathological grid exceeding maxBricks returns null before allocating bricks.
    const tooMany = planSliceBricks([32768, 32768, 2], [0, 0, 1], [1024, 0, 0], [0, 1024, 0], 32, 32, 2048);
    assert.equal(tooMany, null);

    const missed = planSliceBricks(dims, [4000, 4000, 10], [1, 0, 0], [0, 1, 0], 100, 100, 2048);
    assert.deepEqual(missed, []);
  });

  it('builds a bounded 3D display volume while preserving full-resolution source and padding semantics', () => {
    const dims: Vec3 = [4, 4, 10];
    const data = new Int16Array(4 * 4 * 10);
    const mask = new Uint8Array(data.length);
    for (let z = 0; z < 10; z++) {
      for (let i = 0; i < 16; i++) data[z * 16 + i] = z * 100;
    }
    // Mark slice 0-1 voxel (0,0) completely padded.
    mask[0] = 3;
    mask[16] = 3;
    // Mark slice 2-3 voxel (1,0) carved on slice 2, intact on slice 3 -> display stays intact until both are carved.
    mask[2 * 16 + 1] = 1;
    // Mark slice 4-5 voxel (2,0) excluded on both slices -> display voxel is excluded (2).
    mask[4 * 16 + 2] = 2;
    mask[5 * 16 + 2] = 2;
    const volume: Volume = { series: syntheticSeries(dims), data };

    assert.deepEqual(displayStride(dims, 6), [1, 1, 2]);
    assert.equal(fullToDisplayCoord(-0.5, 10, 5), -0.5);
    assert.equal(fullToDisplayCoord(9.5, 10, 5), 4.5);

    const display = buildDisplayVolume(volume, mask, 6);
    assert.equal(display.downsampled, true);
    assert.deepEqual(display.stride, [1, 1, 2]);
    assert.deepEqual(display.dimensions, [4, 4, 5]);
    assert(display.data instanceof Int16Array);
    // Display slice 0 averages full slices 0 (0) and 1 (100) -> 50, except padded voxel (0,0).
    assert.equal(display.mask[0], 3);
    assert.equal(display.data[1], 50);
    // Display slice 1 averages full slices 2 (200) and 3 (300) -> 250; voxel (1,0) still unmasked because slice 3 is intact.
    assert.equal(display.data[16 + 1], 250);
    assert.equal(display.mask[16 + 1], 0);
    assert.equal(display.mask[2 * 16 + 2], 2);

    // Carving slice 3 voxel (1,0) and syncing display box marks display voxel (1,0,1) carved without altering source data.
    mask[3 * 16 + 1] = 1;
    const box = syncDisplayMaskBox(mask, dims, display.mask, display.dimensions, [1, 0, 3], [1, 0, 3]);
    assert.deepEqual(box, { min: [1, 0, 1], max: [1, 0, 1] });
    assert.equal(display.mask[16 + 1], 1);
    assert.equal(volume.data[3 * 16 + 1], 300);

    // Syncing an excluded voxel updates display mask to 2.
    mask[6 * 16 + 3] = 2;
    mask[7 * 16 + 3] = 2;
    syncDisplayMaskBox(mask, dims, display.mask, display.dimensions, [3, 0, 6], [3, 0, 7]);
    assert.equal(display.mask[3 * 16 + 3], 2);
  });

  it('preserves exact physical length and uniform voxel spacing when a dimension is not a multiple of the stride', () => {
    // 5 full slices downsampled to 3 display slices (stride 2): full [-0.5, 4.5] must map exactly to [-0.5, 2.5].
    assert.equal(fullToDisplayCoord(-0.5, 5, 3), -0.5);
    assert.equal(fullToDisplayCoord(4.5, 5, 3), 2.5);
    assert.equal(fullToDisplayCoord(-0.5, 2049, 1025), -0.5);
    assert.equal(fullToDisplayCoord(2048.5, 2049, 1025), 1024.5);

    const dims: Vec3 = [2, 2, 5];
    const data = new Float32Array(2 * 2 * 5);
    for (let z = 0; z < 5; z++) {
      for (let i = 0; i < 4; i++) data[z * 4 + i] = z * 30; // 0, 30, 60, 90, 120
    }
    const mask = new Uint8Array(data.length);
    const display = buildDisplayVolume({ series: syntheticSeries(dims, 'float32'), data }, mask, 4);
    assert.deepEqual(display.stride, [1, 1, 2]);
    assert.deepEqual(display.dimensions, [2, 2, 3]);
    // Display slice 0 covers [0, 5/3): weight 1 on slice 0 (0) + weight 2/3 on slice 1 (30) -> mean 12.
    assert(Math.abs(display.data[0] - 12) < 1e-4);
    // Display slice 1 covers [5/3, 10/3): symmetric around slice 2 (60) -> mean 60.
    assert(Math.abs(display.data[4] - 60) < 1e-4);
    // Display slice 2 covers [10/3, 5): weight 2/3 on slice 3 (90) + weight 1 on slice 4 (120) -> mean 108.
    assert(Math.abs(display.data[8] - 108) < 1e-4);

    // Carving full slice 4 syncs display slice 2.
    mask[3 * 4] = 1;
    mask[4 * 4] = 1;
    const box = syncDisplayMaskBox(mask, dims, display.mask, display.dimensions, [0, 0, 3], [0, 0, 4]);
    assert.deepEqual(box, { min: [0, 0, 1], max: [0, 0, 2] });
    assert.equal(display.mask[8], 1);
  });

  it('passes through volumes within max3DTextureSize and converts Float64/Uint16/Uint8 display buffers cleanly', () => {
    const dims: Vec3 = [2, 2, 4];
    const mask = new Uint8Array(16);
    mask[0] = 3;
    const i16: Volume = { series: syntheticSeries(dims, 'int16'), data: new Int16Array(16).fill(42) };
    const direct = buildDisplayVolume(i16, mask, 8);
    assert.equal(direct.downsampled, false);
    assert.equal(direct.data, i16.data);
    assert.equal(direct.mask, mask);

    const f64Data = new Float64Array(16).fill(12.5);
    const f64: Volume = { series: syntheticSeries(dims, 'float64'), data: f64Data };
    const f64Direct = buildDisplayVolume(f64, mask, 8);
    assert.equal(f64Direct.downsampled, false);
    assert(f64Direct.data instanceof Float32Array);
    assert(Number.isNaN(f64Direct.data[0]));
    assert.equal(f64Direct.data[1], 12.5);

    const u16 = buildDisplayVolume({ series: syntheticSeries(dims, 'uint16'), data: new Uint16Array(16).fill(500) }, new Uint8Array(16), 2);
    assert(u16.data instanceof Uint16Array);
    assert.equal(u16.data[0], 500);

    const u8 = buildDisplayVolume({ series: syntheticSeries(dims, 'uint8'), data: new Uint8Array(16).fill(200) }, new Uint8Array(16), 2);
    assert(u8.data instanceof Uint8Array);
    assert.equal(u8.data[0], 200);

    const f32 = buildDisplayVolume({ series: syntheticSeries(dims, 'float32'), data: new Float32Array(16).fill(3.5) }, new Uint8Array(16), 2);
    assert(f32.data instanceof Float32Array);
    assert.equal(f32.data[0], 3.5);
  });

  it('downsamples segmentation label sub-boxes to display dimensions without dropping occupied labels', () => {
    const labels = new Uint8Array(2 * 2 * 4);
    labels[3 * 4 + 1] = 7; // voxel (1, 0, 3)
    const scaled = downsampleLabelSubbox(labels, [0, 0, 0], [2, 2, 4], [2, 2, 4], [2, 2, 2]);
    assert.deepEqual(scaled.min, [0, 0, 0]);
    assert.deepEqual(scaled.size, [2, 2, 2]);
    assert.equal(scaled.labels[1 * 4 + 1], 7);

    const identity = downsampleLabelSubbox(labels, [0, 0, 0], [2, 2, 4], [2, 2, 4], [2, 2, 4]);
    assert.equal(identity.labels, labels);
  });
});
