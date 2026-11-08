import type { Annotation, PixelArray, Series, Volume } from '../model';
import { roiStatistics, type RoiStatistics } from './annotations';

export const ROI_COPY_CHUNK_BYTES = 4 * 1024 * 1024;
export const ROI_CACHE_BYTES = 64 * 1024 * 1024;
export type RoiPixelType = 'float64' | 'float32' | 'int16' | 'uint16' | 'uint8';
export interface RoiFrameDescriptor {
  key: string;
  version: number;
  series: Series;
  sourceFrameIndex: number;
  pixelType: RoiPixelType;
  byteLength: number;
}
export type RoiWorkerRequest =
  | { type: 'begin'; id: number; descriptor: RoiFrameDescriptor }
  | { type: 'chunk'; id: number; offset: number; bytes: ArrayBuffer }
  | { type: 'commit'; id: number }
  | { type: 'measure'; id: number; annotation: Annotation }
  | { type: 'cancel'; id: number };
export type RoiWorkerResult =
  | { type: 'ready'; id: number; cached: boolean }
  | { type: 'received'; id: number; offset: number }
  | { type: 'committed'; id: number }
  | { type: 'result'; id: number; statistics: RoiStatistics | null }
  | { type: 'error'; id: number; message: string };

const constructors = { float64: Float64Array, float32: Float32Array, int16: Int16Array, uint16: Uint16Array, uint8: Uint8Array };
interface CachedFrame { version: number; pixelType: RoiPixelType; data: PixelArray; }
interface CurrentJob {
  id: number;
  descriptor: RoiFrameDescriptor;
  staged: ArrayBuffer | null;
  received: number;
  pixels: PixelArray | null;
}

function validateDescriptor(descriptor: RoiFrameDescriptor): void {
  if (!Object.hasOwn(constructors, descriptor.pixelType) || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1
    || typeof descriptor.key !== 'string' || !descriptor.key) throw new Error('Invalid ROI source frame version or pixel type.');
  const dimensions = descriptor.series.dimensions;
  if (dimensions.length !== 3 || dimensions.some(n => !Number.isSafeInteger(n) || n < 1) || (descriptor.series.components ?? 1) !== 1) {
    throw new Error('ROI measurement requires valid scalar source frames.');
  }
  if (!Number.isSafeInteger(descriptor.sourceFrameIndex) || descriptor.sourceFrameIndex < 0 || descriptor.sourceFrameIndex >= dimensions[2]) {
    throw new Error('Invalid ROI source frame index.');
  }
  const expected = dimensions[0] * dimensions[1] * constructors[descriptor.pixelType].BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expected) || expected !== descriptor.byteLength) throw new Error('ROI source frame byte count does not match its dimensions.');
}

/** One active calculation and an LRU cache of complete source-frame pixel buffers. */
export function createRoiWorkerHandler(post: (reply: RoiWorkerResult) => void, cacheLimitBytes = ROI_CACHE_BYTES): (message: RoiWorkerRequest) => void {
  if (!Number.isSafeInteger(cacheLimitBytes) || cacheLimitBytes < 0) throw new Error('Invalid ROI cache limit.');
  const frames = new Map<string, CachedFrame>();
  let cacheBytes = 0;
  let current: CurrentJob | null = null;
  let latestId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drop = (key: string) => {
    const frame = frames.get(key);
    if (frame) { cacheBytes -= frame.data.byteLength; frames.delete(key); }
  };
  const clearCurrent = () => { clearTimeout(timer); timer = undefined; current = null; };
  return data => {
    if (data.type !== 'begin' && data.id !== current?.id) return;
    try {
      if (data.type === 'begin') {
        if (!Number.isSafeInteger(data.id) || data.id < 1) throw new Error('Invalid ROI request generation.');
        if (data.id <= latestId) return;
        latestId = data.id;
        clearCurrent();
        validateDescriptor(data.descriptor);
        const descriptor = data.descriptor;
        let cached = frames.get(descriptor.key);
        if (cached && (cached.version !== descriptor.version || cached.pixelType !== descriptor.pixelType || cached.data.byteLength !== descriptor.byteLength)) {
          drop(descriptor.key); cached = undefined;
        }
        if (cached) {
          frames.delete(descriptor.key); frames.set(descriptor.key, cached);
        } else {
          // Oversized frames may be measured once, but do not remain in the cache afterward.
          while (frames.size && cacheBytes + descriptor.byteLength > cacheLimitBytes) drop(frames.keys().next().value!);
        }
        current = { id: data.id, descriptor, staged: cached ? null : new ArrayBuffer(descriptor.byteLength), received: 0, pixels: cached?.data ?? null };
        post({ type: 'ready', id: data.id, cached: !!cached });
        return;
      }
      if (data.type === 'cancel') { clearCurrent(); return; }
      const job = current;
      if (!job) return;
      if (data.type === 'chunk') {
        if (!job.staged || !(data.bytes instanceof ArrayBuffer) || !Number.isSafeInteger(data.offset) || data.offset !== job.received
          || data.bytes.byteLength < 1 || data.bytes.byteLength > ROI_COPY_CHUNK_BYTES || data.offset + data.bytes.byteLength > job.staged.byteLength) {
          throw new Error('Invalid or out-of-order ROI source frame chunk.');
        }
        new Uint8Array(job.staged, data.offset, data.bytes.byteLength).set(new Uint8Array(data.bytes));
        job.received += data.bytes.byteLength;
        post({ type: 'received', id: data.id, offset: job.received });
        return;
      }
      if (data.type === 'commit') {
        if (!job.staged || job.received !== job.descriptor.byteLength) throw new Error('ROI source frame upload is incomplete.');
        job.pixels = new constructors[job.descriptor.pixelType](job.staged);
        job.staged = null;
        if (job.pixels.byteLength <= cacheLimitBytes) {
          frames.set(job.descriptor.key, { version: job.descriptor.version, pixelType: job.descriptor.pixelType, data: job.pixels });
          cacheBytes += job.pixels.byteLength;
        }
        post({ type: 'committed', id: data.id });
        return;
      }
      if (data.type === 'measure') {
        if (!job.pixels || job.staged) throw new Error('ROI source frame upload must finish before measurement.');
        if (data.annotation.mode !== 'source') throw new Error('Background ROI measurement requires an acquired-source annotation.');
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (current !== job) return;
          try {
            const volume: Volume = { series: job.descriptor.series, data: job.pixels!, sourceFrameIndex: job.descriptor.sourceFrameIndex };
            const statistics = roiStatistics(data.annotation, volume);
            clearCurrent();
            post({ type: 'result', id: data.id, statistics });
          } catch (error) {
            clearCurrent();
            post({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) });
          }
        }, 0);
      }
    } catch (error) {
      clearCurrent();
      post({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) });
    }
  };
}

const workerScope = globalThis as unknown as { onmessage: ((event: MessageEvent<RoiWorkerRequest>) => void) | null; postMessage?: (message: RoiWorkerResult) => void };
if (typeof window === 'undefined' && typeof workerScope.postMessage === 'function') {
  const receive = createRoiWorkerHandler(reply => workerScope.postMessage!(reply));
  workerScope.onmessage = event => receive(event.data);
}
