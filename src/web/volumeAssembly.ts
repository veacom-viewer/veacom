// Assembles a single-file-per-frame DICOM volume in bounded chunks inside the browser Worker.
// Each chunk decodes a small slice window (32 frames ~= 16 MiB for 512x512 int16) in WebAssembly and copies it into
// one JS ArrayBuffer, yielding between chunks so V8 can reclaim temporary FileReaderSync buffers and interactive
// frame/tag requests can preempt a multi-second volume decode.

export type VolumePixelType = 'uint8' | 'int16' | 'uint16' | 'float32' | 'float64';

export interface VolumePlan {
  cached: boolean;
  frames: number;
  frameSamples: number;
  components: number;
  widening: VolumePixelType[];
  chunkable: boolean;
  maxBytes: number;
}

export type VolumeChunkResult =
  | { status: 'ok'; bytes: Uint8Array; pixelType: VolumePixelType; components: number }
  | { status: 'typeDoesNotFit' }
  | { status: 'float64Required' };

interface AssembledVolume {
  bytes: Uint8Array;
  pixelType: VolumePixelType;
  components: number;
}

export const VOLUME_CHUNK_FRAMES = 32;

function bytesPerSample(pixelType: VolumePixelType): number {
  switch (pixelType) {
    case 'uint8': return 1;
    case 'int16':
    case 'uint16': return 2;
    case 'float32': return 4;
    case 'float64': return 8;
  }
}

function cancelledError(): Error {
  return new Error(JSON.stringify({ note: { code: 'job.cancelled', text: 'Operation cancelled' } }));
}

function allocateVolumeBuffer(totalSamples: number, pixelType: VolumePixelType, maxBytes: number): Uint8Array {
  const totalBytes = totalSamples * bytesPerSample(pixelType);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
    throw new Error('Volume exceeds the 1 GiB decoded output limit');
  }
  try {
    return new Uint8Array(totalBytes);
  } catch {
    throw new Error(JSON.stringify({ note: { code: 'decode.noMemory', text: 'Not enough memory for the decoded volume' } }));
  }
}

type NumericView = Uint8Array | Int16Array | Uint16Array | Float32Array | Float64Array;

function typedView(buffer: ArrayBuffer, pixelType: VolumePixelType, length: number): NumericView {
  switch (pixelType) {
    case 'uint8': return new Uint8Array(buffer, 0, length);
    case 'int16': return new Int16Array(buffer, 0, length);
    case 'uint16': return new Uint16Array(buffer, 0, length);
    case 'float32': return new Float32Array(buffer, 0, length);
    case 'float64': return new Float64Array(buffer, 0, length);
  }
}

/**
 * Losslessly widens already-decoded prefix samples from `from` to `to` without re-decoding earlier chunks.
 * Returns null if `int16 -> uint16` encounters a negative sample (caller should advance to float32).
 */
function widenDecodedPrefix(
  current: Uint8Array,
  from: VolumePixelType,
  to: VolumePixelType,
  completedSamples: number,
  totalSamples: number,
  maxBytes: number,
): Uint8Array | null {
  const source = typedView(current.buffer as ArrayBuffer, from, completedSamples);
  if (from === 'int16' && to === 'uint16') {
    for (let i = 0; i < completedSamples; i++) {
      if (source[i] < 0) return null;
    }
  }
  const next = allocateVolumeBuffer(totalSamples, to, maxBytes);
  const target = typedView(next.buffer as ArrayBuffer, to, completedSamples);
  for (let i = 0; i < completedSamples; i++) target[i] = source[i];
  return next;
}

export async function assembleVolumeChunks(
  plan: VolumePlan,
  options: {
    chunkFrames?: number;
    decodeChunk: (start: number, count: number, pixelType: VolumePixelType) => VolumeChunkResult;
    cancelled: () => boolean;
    yieldTurn: () => Promise<void>;
    onRestart?: (totalFrames: number) => void;
  },
): Promise<AssembledVolume> {
  const chunkFrames = Math.max(1, options.chunkFrames ?? VOLUME_CHUNK_FRAMES);
  const totalSamples = plan.frames * plan.frameSamples;
  const widening: VolumePixelType[] = plan.widening.length ? plan.widening : ['float32', 'float64'];
  let typeIndex = 0;
  let pixelType = widening[typeIndex];
  let output = allocateVolumeBuffer(totalSamples, pixelType, plan.maxBytes);
  let start = 0;

  while (start < plan.frames) {
    if (options.cancelled()) throw cancelledError();
    const count = Math.min(chunkFrames, plan.frames - start);
    const result = options.decodeChunk(start, count, pixelType);
    if (result.status === 'ok') {
      const sampleBytes = bytesPerSample(pixelType);
      const expectedBytes = count * plan.frameSamples * sampleBytes;
      if (result.bytes.byteLength !== expectedBytes) {
        throw new Error('Decoded chunk size differs from series dimensions');
      }
      output.set(result.bytes, start * plan.frameSamples * sampleBytes);
      start += count;
      if (start < plan.frames) await options.yieldTurn();
      continue;
    }

    if (result.status === 'typeDoesNotFit') {
      const completedSamples = start * plan.frameSamples;
      let widened: Uint8Array | null = null;
      while (typeIndex + 1 < widening.length) {
        typeIndex += 1;
        const candidate = widening[typeIndex];
        widened = widenDecodedPrefix(output, pixelType, candidate, completedSamples, totalSamples, plan.maxBytes);
        if (widened) {
          pixelType = candidate;
          output = widened;
          break;
        }
      }
      if (!widened) throw new Error('Physical pixel values need floating point storage');
      await options.yieldTurn();
      continue;
    }

    // Float64Required: restart from frame 0 so earlier frames that had 32-bit integer or float64 inputs keep full precision.
    const f64Index = widening.indexOf('float64');
    if (f64Index < 0 || pixelType === 'float64') {
      throw new Error('Physical pixels require float64 precision');
    }
    typeIndex = f64Index;
    pixelType = 'float64';
    output = allocateVolumeBuffer(totalSamples, pixelType, plan.maxBytes);
    start = 0;
    options.onRestart?.(plan.frames);
    await options.yieldTurn();
  }

  if (options.cancelled()) throw cancelledError();
  return { bytes: output, pixelType, components: plan.components };
}
