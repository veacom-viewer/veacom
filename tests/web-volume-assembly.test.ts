import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assembleVolumeChunks,
  type VolumeChunkResult,
  type VolumePixelType,
  type VolumePlan,
} from '../src/web/volumeAssembly';

function planFor(frames: number, frameSamples: number, widening: VolumePixelType[], maxBytes = 1024 * 1024 * 1024): VolumePlan {
  return { cached: false, frames, frameSamples, components: 1, widening, chunkable: true, maxBytes };
}

function encodeChunk(values: number[], pixelType: VolumePixelType): Uint8Array {
  if (pixelType === 'uint8') return new Uint8Array(values);
  if (pixelType === 'int16') return new Uint8Array(new Int16Array(values).buffer);
  if (pixelType === 'uint16') return new Uint8Array(new Uint16Array(values).buffer);
  if (pixelType === 'float32') return new Uint8Array(new Float32Array(values).buffer);
  return new Uint8Array(new Float64Array(values).buffer);
}

describe('chunked browser volume assembly', () => {
  it('assembles chunks in order and yields between chunks for preemption', async () => {
    const events: string[] = [];
    const frames = [
      [10, -20],
      [30, -40],
      [50, -60],
      [70, -80],
      [90, -100],
    ];
    const volume = await assembleVolumeChunks(planFor(5, 2, ['int16', 'float32', 'float64']), {
      chunkFrames: 2,
      decodeChunk: (start, count, pixelType) => {
        events.push(`chunk:${start}:${count}:${pixelType}`);
        const slice = frames.slice(start, start + count).flat();
        return { status: 'ok', bytes: encodeChunk(slice, pixelType), pixelType, components: 1 };
      },
      cancelled: () => false,
      yieldTurn: async () => { events.push('yield'); },
    });
    assert.equal(volume.pixelType, 'int16');
    assert.equal(volume.components, 1);
    assert.deepEqual([...new Int16Array(volume.bytes.buffer)], [10, -20, 30, -40, 50, -60, 70, -80, 90, -100]);
    assert.deepEqual(events, [
      'chunk:0:2:int16',
      'yield',
      'chunk:2:2:int16',
      'yield',
      'chunk:4:1:int16',
    ]);
  });

  it('losslessly widens int16 to uint16 when earlier slices are non-negative without re-decoding chunk 0', async () => {
    const calls: string[] = [];
    const frames = [[0, 100], [200, 300], [40000, 50000], [60000, 65535]];
    const volume = await assembleVolumeChunks(planFor(4, 2, ['int16', 'uint16', 'float32', 'float64']), {
      chunkFrames: 2,
      decodeChunk: (start, count, pixelType): VolumeChunkResult => {
        calls.push(`${start}:${pixelType}`);
        const slice = frames.slice(start, start + count).flat();
        if (pixelType === 'int16' && slice.some(v => v > 32767)) return { status: 'typeDoesNotFit' };
        return { status: 'ok', bytes: encodeChunk(slice, pixelType), pixelType, components: 1 };
      },
      cancelled: () => false,
      yieldTurn: async () => {},
    });
    assert.equal(volume.pixelType, 'uint16');
    assert.deepEqual([...new Uint16Array(volume.bytes.buffer)], frames.flat());
    // Chunk 0 was decoded once as int16 and widened in JS; chunk 2 retried as uint16.
    assert.deepEqual(calls, ['0:int16', '2:int16', '2:uint16']);
  });

  it('skips uint16 and widens directly to float32 when earlier int16 slices contain negative values', async () => {
    const calls: string[] = [];
    const frames = [[-1000, 0], [500, 1000], [40000, 41000]];
    const volume = await assembleVolumeChunks(planFor(3, 2, ['int16', 'uint16', 'float32', 'float64']), {
      chunkFrames: 2,
      decodeChunk: (start, count, pixelType): VolumeChunkResult => {
        calls.push(`${start}:${pixelType}`);
        const slice = frames.slice(start, start + count).flat();
        if (pixelType === 'int16' && slice.some(v => v > 32767)) return { status: 'typeDoesNotFit' };
        return { status: 'ok', bytes: encodeChunk(slice, pixelType), pixelType, components: 1 };
      },
      cancelled: () => false,
      yieldTurn: async () => {},
    });
    assert.equal(volume.pixelType, 'float32');
    assert.deepEqual([...new Float32Array(volume.bytes.buffer)], [-1000, 0, 500, 1000, 40000, 41000]);
    assert.deepEqual(calls, ['0:int16', '2:int16', '2:float32']);
  });

  it('restarts from frame 0 when a later chunk requires float64 precision', async () => {
    const calls: string[] = [];
    const restarts: number[] = [];
    const exact = [16_777_217, 16_777_219, 1_000_000_001, 1_000_000_003];
    const volume = await assembleVolumeChunks(planFor(4, 1, ['float32', 'float64']), {
      chunkFrames: 2,
      decodeChunk: (start, count, pixelType): VolumeChunkResult => {
        calls.push(`${start}:${pixelType}`);
        if (pixelType === 'float32' && start >= 2) return { status: 'float64Required' };
        return { status: 'ok', bytes: encodeChunk(exact.slice(start, start + count), pixelType), pixelType, components: 1 };
      },
      cancelled: () => false,
      yieldTurn: async () => {},
      onRestart: total => restarts.push(total),
    });
    assert.equal(volume.pixelType, 'float64');
    assert.deepEqual([...new Float64Array(volume.bytes.buffer)], exact);
    assert.deepEqual(restarts, [4]);
    assert.deepEqual(calls, ['0:float32', '2:float32', '0:float64', '2:float64']);
  });

  it('stops cleanly when cancelled between chunks and enforces the maxBytes limit', async () => {
    let stop = false;
    const decodedRanges: Array<[number, number]> = [];
    await assert.rejects(
      assembleVolumeChunks(planFor(4, 2, ['int16', 'float32']), {
        chunkFrames: 2,
        decodeChunk: (start, count, pixelType) => {
          decodedRanges.push([start, count]);
          return { status: 'ok', bytes: encodeChunk(Array(count * 2).fill(start), pixelType), pixelType, components: 1 };
        },
        cancelled: () => stop,
        yieldTurn: async () => { stop = true; },
      }),
      /job\.cancelled/,
    );
    assert.deepEqual(decodedRanges, [[0, 2]]);

    await assert.rejects(
      assembleVolumeChunks(planFor(10, 10, ['int16', 'float32'], 100), {
        chunkFrames: 5,
        decodeChunk: () => { throw new Error('should not decode past byte limit'); },
        cancelled: () => false,
        yieldTurn: async () => {},
      }),
      /1 GiB decoded output limit/,
    );
  });
});
