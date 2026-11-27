import assert from 'node:assert/strict';
import test from 'node:test';
import { ResidencyManager, type ResidencyPoolId } from '../src/domain/residencyManager';

function makeFakePool(id: ResidencyPoolId, initialBytes: number, priority: number, budgetBytes = 500) {
  let used = initialBytes;
  const calls: number[] = [];
  return {
    pool: {
      id,
      budgetBytes,
      priority,
      bytes: () => used,
      evict(targetBytes: number) {
        calls.push(targetBytes);
        const next = Math.min(used, Math.max(0, targetBytes));
        const freed = used - next;
        used = next;
        return freed;
      },
    },
    get used() { return used; },
    set used(v: number) { used = v; },
    calls,
  };
}

test('requestSpace evicts lower-priority pools first and protects pinned bytes', () => {
  const manager = new ResidencyManager(1000);
  const frames = makeFakePool('source-frames', 400, 1);
  const slices = makeFakePool('gpu-slices', 400, 2);
  const volumes = makeFakePool('cpu-volumes', 150, 3);
  manager.registerPool(frames.pool);
  manager.registerPool(slices.pool);
  manager.registerPool(volumes.pool);

  // Pin 100 bytes in source-frames and 250 bytes in gpu-slices.
  manager.pin('source-frames', 'visible-frame', 100);
  manager.pin('gpu-slices', 'active-viewport', 250);

  // Total used is 950; requesting 450 in gpu-3d needs 400 bytes freed.
  const result = manager.requestSpace('gpu-3d', 450);
  assert.equal(result.granted, true);
  assert.equal(result.freedBytes, 400);
  // source-frames drops from 400 -> 100 (pinned floor, freeing 300).
  assert.equal(frames.used, 100);
  // gpu-slices drops from 400 -> 300 (freeing remaining 100, staying above 250 pinned floor).
  assert.equal(slices.used, 300);
  // cpu-volumes is untouched because higher priority and deficit already cleared.
  assert.equal(volumes.used, 150);
});

test('requestSpace reports granted=false when pinned working set exceeds global budget', () => {
  const manager = new ResidencyManager(500);
  const slices = makeFakePool('gpu-slices', 400, 1);
  manager.registerPool(slices.pool);
  manager.pin('gpu-slices', 'viewport-1', 400);

  const result = manager.requestSpace('gpu-3d', 200);
  assert.equal(result.granted, false);
  assert.equal(result.freedBytes, 0);
  assert.equal(slices.used, 400);
});

test('handleMemoryPressure trims moderate to 50% and critical to pinned floors', () => {
  const manager = new ResidencyManager(1000);
  const frames = makeFakePool('source-frames', 300, 1);
  const volumes = makeFakePool('cpu-volumes', 600, 2);
  manager.registerPool(frames.pool);
  manager.registerPool(volumes.pool);
  manager.pin('cpu-volumes', 'active-ct', 200);

  const freedModerate = manager.handleMemoryPressure('moderate');
  assert.equal(freedModerate, 400);
  assert.equal(frames.used, 0);
  assert.equal(volumes.used, 500);
  assert.equal(manager.snapshot().pressureLevel, 'moderate');

  const freedCritical = manager.handleMemoryPressure('critical');
  assert.equal(freedCritical, 300);
  assert.equal(volumes.used, 200);
  assert.equal(manager.snapshot().pressureLevel, 'critical');

  manager.clearPressure();
  assert.equal(manager.snapshot().pressureLevel, 'normal');
});

test('snapshot and unregister cleanup reflect live pool state accurately', () => {
  const manager = new ResidencyManager(2000);
  const frames = makeFakePool('source-frames', 120, 1, 256);
  const unregister = manager.registerPool(frames.pool);
  manager.pin('source-frames', 'f0', 40);

  const snap = manager.snapshot();
  assert.equal(snap.globalBudgetBytes, 2000);
  assert.equal(snap.totalUsedBytes, 120);
  assert.equal(snap.totalPinnedBytes, 40);
  assert.equal(snap.pools.length, 1);
  assert.deepEqual(snap.pools[0], { id: 'source-frames', usedBytes: 120, pinnedBytes: 40, budgetBytes: 256 });

  unregister();
  assert.equal(manager.snapshot().pools.length, 0);
  assert.equal(manager.pinnedBytes('source-frames'), 0);
});

test('SourceFrameCache trims oldest frames under residencyManager pressure', async () => {
  const { SourceFrameCache } = await import('../src/sourceFrames');
  const { residencyManager } = await import('../src/domain/residencyManager');
  const series: import('../src/model').Series = {
    id: 's-trim', uid: '1.2', studyUid: '1', studyDate: '20260101', seriesNumber: 1,
    patientId: 'P', patientName: 'P', modality: 'CT', description: 'CT',
    dimensions: [4, 4, 4], spacing: [1, 1, 1],
    origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null,
    canReconstruct: true, pixelType: 'int16', components: 1,
    photometricInterpretation: 'MONOCHROME2', warnings: [],
  };
  const cache = new SourceFrameCache(async (item, index) => ({
    series: item,
    data: new Int16Array(16).fill(index),
    sourceFrameIndex: index,
  }), 1024, 16, 2);
  try {
    await cache.get(series, 0);
    await cache.get(series, 1);
    await cache.get(series, 2);
    assert.equal(cache.byteLength, 96);
    const freed = cache.trimTo(32);
    assert.equal(freed, 64);
    assert.equal(cache.byteLength, 32);
    const freedAll = residencyManager.handleMemoryPressure('critical');
    assert(freedAll >= 32);
    assert.equal(cache.byteLength, 0);
  } finally {
    residencyManager.clearPressure();
    cache.dispose();
  }
});
