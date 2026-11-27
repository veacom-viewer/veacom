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

test('GPU allocations never evict cached CPU volumes and evict only within the GPU domain', () => {
  const manager = new ResidencyManager({ cpuBudgetBytes: 1000, gpuBudgetBytes: 800 });
  const frames = makeFakePool('source-frames', 200, 1);
  const volumes = makeFakePool('cpu-volumes', 700, 3);
  const slices = makeFakePool('gpu-slices', 600, 2);
  manager.registerPool(frames.pool);
  manager.registerPool(volumes.pool);
  manager.registerPool(slices.pool);

  // Pin 250 bytes in gpu-slices and 300 bytes in cpu-volumes.
  manager.pin('gpu-slices', 'active-viewport', 250);
  manager.pin('cpu-volumes', 'active-ct', 300);

  // Requesting 500 GPU bytes needs 300 bytes freed from GPU (600 + 500 - 800 = 300).
  const result = manager.requestSpace('gpu-3d', 500);
  assert.equal(result.granted, true);
  assert.equal(result.freedBytes, 300);
  // gpu-slices drops from 600 -> 300 (staying above 250 pinned floor).
  assert.equal(slices.used, 300);
  // Both CPU pools are completely untouched by GPU uploads.
  assert.equal(frames.used, 200);
  assert.equal(volumes.used, 700);
});

test('CPU domain evicts lower-priority source-frames before cpu-volumes even when source-frames requests space', () => {
  const manager = new ResidencyManager({ cpuBudgetBytes: 1000, gpuBudgetBytes: 800 });
  const frames = makeFakePool('source-frames', 300, 1);
  const volumes = makeFakePool('cpu-volumes', 650, 3);
  manager.registerPool(frames.pool);
  manager.registerPool(volumes.pool);
  manager.pin('source-frames', 'visible-frame', 100);

  // 950 + 250 = 1200 -> needs 200 freed from CPU domain; source-frames (priority 1) yields 200 before cpu-volumes (priority 3).
  const result = manager.requestSpace('source-frames', 250);
  assert.equal(result.granted, true);
  assert.equal(result.freedBytes, 200);
  assert.equal(frames.used, 100);
  assert.equal(volumes.used, 650);
});

test('requestSpace reports granted=false when pinned working set exceeds domain budget', () => {
  const manager = new ResidencyManager({ cpuBudgetBytes: 1000, gpuBudgetBytes: 500 });
  const slices = makeFakePool('gpu-slices', 400, 1);
  manager.registerPool(slices.pool);
  manager.pin('gpu-slices', 'viewport-1', 400);

  const result = manager.requestSpace('gpu-3d', 200);
  assert.equal(result.granted, false);
  assert.equal(result.freedBytes, 0);
  assert.equal(slices.used, 400);
});

test('handleMemoryPressure trims moderate to 50% per domain and critical to pinned floors across both domains', () => {
  const manager = new ResidencyManager({ cpuBudgetBytes: 1000, gpuBudgetBytes: 800 });
  const frames = makeFakePool('source-frames', 300, 1);
  const volumes = makeFakePool('cpu-volumes', 600, 3);
  const slices = makeFakePool('gpu-slices', 600, 2);
  manager.registerPool(frames.pool);
  manager.registerPool(volumes.pool);
  manager.registerPool(slices.pool);
  manager.pin('cpu-volumes', 'active-ct', 200);
  manager.pin('gpu-slices', 'active-vp', 100);

  // Moderate: CPU 900 -> 500 (frees 400: 300 frames + 100 volumes); GPU 600 -> 400 (frees 200 slices).
  const freedModerate = manager.handleMemoryPressure('moderate');
  assert.equal(freedModerate, 600);
  assert.equal(frames.used, 0);
  assert.equal(volumes.used, 500);
  assert.equal(slices.used, 400);
  assert.equal(manager.snapshot().pressureLevel, 'moderate');

  // Critical: CPU 500 -> 200 (frees 300); GPU 400 -> 100 (frees 300).
  const freedCritical = manager.handleMemoryPressure('critical');
  assert.equal(freedCritical, 600);
  assert.equal(volumes.used, 200);
  assert.equal(slices.used, 100);
  assert.equal(manager.snapshot().pressureLevel, 'critical');

  manager.clearPressure();
  assert.equal(manager.snapshot().pressureLevel, 'normal');
});

test('snapshot and unregister cleanup reflect live domain and pool state accurately', () => {
  const manager = new ResidencyManager({ cpuBudgetBytes: 2000, gpuBudgetBytes: 1500 });
  const frames = makeFakePool('source-frames', 120, 1, 256);
  const unregister = manager.registerPool(frames.pool);
  manager.pin('source-frames', 'f0', 40);

  const snap = manager.snapshot();
  assert.equal(snap.cpuBudgetBytes, 2000);
  assert.equal(snap.gpuBudgetBytes, 1500);
  assert.equal(snap.cpuUsedBytes, 120);
  assert.equal(snap.gpuUsedBytes, 0);
  assert.equal(snap.totalUsedBytes, 120);
  assert.equal(snap.totalPinnedBytes, 40);
  assert.equal(snap.pools.length, 1);
  assert.deepEqual(snap.pools[0], { id: 'source-frames', domain: 'cpu', usedBytes: 120, pinnedBytes: 40, budgetBytes: 256 });

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

test('SourceFrameCache resolves frames without caching them when residencyManager denies admission', async () => {
  const { SourceFrameCache } = await import('../src/sourceFrames');
  const { residencyManager } = await import('../src/domain/residencyManager');
  const series: import('../src/model').Series = {
    id: 's-deny', uid: '1.3', studyUid: '1', studyDate: '20260101', seriesNumber: 2,
    patientId: 'P', patientName: 'P', modality: 'CT', description: 'CT',
    dimensions: [4, 4, 4], spacing: [1, 1, 1],
    origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null,
    canReconstruct: true, pixelType: 'int16', components: 1,
    photometricInterpretation: 'MONOCHROME2', warnings: [],
  };
  let loads = 0;
  const cache = new SourceFrameCache(async (item, index) => {
    loads++;
    return {
      series: item,
      data: new Int16Array(16).fill(index + 7),
      sourceFrameIndex: index,
    };
  }, 1024, 16, 2);
  const fullBudget = residencyManager.snapshot().cpuBudgetBytes;
  const pinKey = 'test-pin-full-cpu';
  const unregisterDummy = residencyManager.registerPool({
    id: 'cpu-volumes',
    budgetBytes: fullBudget,
    priority: 3,
    bytes: () => fullBudget,
    evict: () => 0,
  });
  residencyManager.pin('cpu-volumes', pinKey, fullBudget);
  try {
    const first = await cache.get(series, 0);
    assert.equal(first.sourceFrameIndex, 0);
    assert.equal(first.data[0], 7);
    assert.equal(cache.byteLength, 0, 'denied frame must not be retained in cache');
    const second = await cache.get(series, 0);
    assert.equal(second.data[0], 7);
    assert.equal(loads, 2, 'subsequent get reloads because first frame was not cached');
  } finally {
    residencyManager.clearPins('cpu-volumes');
    unregisterDummy();
    cache.dispose();
  }
});
