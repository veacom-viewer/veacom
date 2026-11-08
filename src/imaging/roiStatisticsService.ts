import type { Annotation, PixelArray, Volume } from '../model';
import { annotationSourceIndex, type RoiStatistics } from './annotations';
import { ROI_COPY_CHUNK_BYTES, type RoiFrameDescriptor, type RoiPixelType, type RoiWorkerRequest, type RoiWorkerResult } from './roiStatistics.worker';

export interface RoiWorkerLike {
  onmessage: ((event: MessageEvent<RoiWorkerResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: RoiWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}
export interface SourceRoiRequest { promise: Promise<RoiStatistics | null>; cancel(): void; }
interface Consumer { resolve(value: RoiStatistics | null): void; reject(error: Error): void; }
interface Job {
  id: number;
  key: string;
  annotation: Annotation;
  descriptor: RoiFrameDescriptor;
  source: Uint8Array;
  consumers: Set<Consumer>;
}
interface Waiting {
  id: number;
  type: RoiWorkerResult['type'];
  offset?: number;
  resolve(reply: RoiWorkerResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export const ROI_WORKER_TIMEOUT_MS = 60_000;
const cancelled = () => new DOMException('ROI calculation cancelled.', 'AbortError');
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));
const defaultWorker = (): RoiWorkerLike => new Worker(new URL('./roiStatistics.worker.ts', import.meta.url), { type: 'module' });

function pixelType(data: PixelArray): RoiPixelType {
  if (data instanceof Float64Array) return 'float64';
  if (data instanceof Float32Array) return 'float32';
  if (data instanceof Int16Array) return 'int16';
  if (data instanceof Uint16Array) return 'uint16';
  if (data instanceof Uint8Array) return 'uint8';
  throw new Error('Unsupported ROI source pixel type.');
}

/** Serial transport bounds copies and lets cancellation stop a synchronous worker calculation. */
export class RoiStatisticsService {
  private worker: RoiWorkerLike | null = null;
  private generation = 0;
  private objects = new WeakMap<object, number>();
  private nextObject = 1;
  private nextJob = 1;
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private active: Job | null = null;
  private waiting: Waiting | null = null;
  private pumping = false;
  private disposed = false;
  private workerFactory: () => RoiWorkerLike;

  constructor(workerFactory: () => RoiWorkerLike = defaultWorker) { this.workerFactory = workerFactory; }

  private identity(object: object): number {
    let id = this.objects.get(object);
    if (id === undefined) { id = this.nextObject++; this.objects.set(object, id); }
    return id;
  }

  request(annotation: Annotation, volume: Volume): SourceRoiRequest {
    try {
      if (this.disposed) throw cancelled();
      if (annotation.mode !== 'source') throw new Error('Background ROI measurement requires an acquired-source annotation.');
      const frame = annotationSourceIndex(annotation, volume.series);
      if (frame === null || (volume.sourceFrameIndex !== undefined && volume.sourceFrameIndex !== frame) || volume.series.components === 3) {
        return { promise: Promise.resolve(null), cancel() {} };
      }
      const [width, height] = volume.series.dimensions;
      const elements = width * height;
      const first = volume.sourceFrameIndex === undefined ? frame * elements : 0;
      if (![width, height, elements, first].every(Number.isSafeInteger) || width < 1 || height < 1 || first < 0 || first + elements > volume.data.length) {
        throw new Error('ROI source frame pixels are incomplete.');
      }
      const version = this.identity(volume.data);
      const key = `${this.identity(annotation)}:${this.identity(volume.series)}:${version}:${frame}`;
      let job = this.jobs.get(key);
      if (!job) {
        const type = pixelType(volume.data), bytes = elements * volume.data.BYTES_PER_ELEMENT;
        const descriptor: RoiFrameDescriptor = {
          key: JSON.stringify([volume.series.id, volume.series.engineGeneration ?? null, version, frame]), version,
          series: volume.series, sourceFrameIndex: frame, pixelType: type, byteLength: bytes,
        };
        job = { id: this.nextJob++, key, annotation, descriptor,
          source: new Uint8Array(volume.data.buffer, volume.data.byteOffset + first * volume.data.BYTES_PER_ELEMENT, bytes), consumers: new Set() };
        this.jobs.set(key, job); this.queue.push(job);
      }
      let owner: Job | null = job;
      let resolve!: (result: RoiStatistics | null) => void, reject!: (error: Error) => void;
      const promise = new Promise<RoiStatistics | null>((yes, no) => { resolve = yes; reject = no; });
      const finish = () => {
        const current = owner;
        if (!current) return null;
        owner = null; current.consumers.delete(consumer);
        return current;
      };
      const consumer: Consumer = {
        resolve: result => { if (finish()) resolve(result); },
        reject: error => { if (finish()) reject(error); },
      };
      job.consumers.add(consumer);
      this.pump();
      return { promise, cancel: () => {
        const current = finish();
        if (!current) return;
        reject(cancelled());
        if (!current.consumers.size) this.cancelJob(current);
      } };
    } catch (error) {
      return { promise: Promise.reject(asError(error)), cancel() {} };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failWorker(cancelled());
  }

  private cancelJob(job: Job): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    this.queue = this.queue.filter(queued => queued !== job);
    if (this.active === job) this.destroyWorker(cancelled());
  }

  private finishJob(job: Job, result: RoiStatistics | null, error?: Error): void {
    if (this.jobs.get(job.key) !== job) return;
    this.jobs.delete(job.key);
    for (const consumer of [...job.consumers]) {
      if (error) consumer.reject(error); else consumer.resolve(result);
    }
  }

  private destroyWorker(error: Error): void {
    const worker = this.worker;
    this.worker = null; this.generation++;
    if (worker) {
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
      worker.terminate();
    }
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(error); }
  }

  private failWorker(error: Error): void {
    this.destroyWorker(error);
    for (const job of [...this.jobs.values()]) this.finishJob(job, null, error);
    this.queue = [];
  }

  private getWorker(): RoiWorkerLike {
    if (this.worker) return this.worker;
    let worker: RoiWorkerLike;
    try { worker = this.workerFactory(); }
    catch (error) { this.failWorker(asError(error)); throw error; }
    this.worker = worker;
    const generation = ++this.generation;
    const current = () => this.worker === worker && this.generation === generation;
    worker.onerror = event => {
      event.preventDefault?.();
      if (current()) this.failWorker(new Error(event.message || 'Background ROI calculation failed.'));
    };
    worker.onmessageerror = () => { if (current()) this.failWorker(new Error('The ROI worker returned an unreadable response.')); };
    worker.onmessage = ({ data }) => {
      if (!current()) return;
      const waiting = this.waiting;
      if (!waiting || !data || data.id !== waiting.id) return;
      if (data.type === 'error') {
        this.waiting = null; clearTimeout(waiting.timer);
        waiting.reject(new Error(data.message || 'Background ROI calculation failed.'));
        return;
      }
      if (data.type !== waiting.type || (data.type === 'received' && data.offset !== waiting.offset)
        || (data.type === 'ready' && typeof data.cached !== 'boolean') || (data.type === 'result' && !('statistics' in data))) {
        this.failWorker(new Error('The ROI worker returned an unexpected response.')); return;
      }
      this.waiting = null; clearTimeout(waiting.timer); waiting.resolve(data);
    };
    return worker;
  }

  private assertCurrent(job: Job): void {
    if (this.disposed || this.jobs.get(job.key) !== job || !job.consumers.size) throw cancelled();
  }

  private exchange(job: Job, worker: RoiWorkerLike, request: RoiWorkerRequest, type: Waiting['type'], offset?: number, transfer: Transferable[] = []): Promise<RoiWorkerResult> {
    this.assertCurrent(job);
    if (this.worker !== worker) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting?.id === job.id) this.failWorker(new Error('Background ROI calculation timed out.'));
      }, ROI_WORKER_TIMEOUT_MS);
      this.waiting = { id: job.id, type, offset, resolve, reject, timer };
      try { worker.postMessage(request, transfer); }
      catch (error) { this.failWorker(asError(error)); }
    });
  }

  private async run(job: Job): Promise<RoiStatistics | null> {
    this.assertCurrent(job);
    const worker = this.getWorker();
    const ready = await this.exchange(job, worker, { type: 'begin', id: job.id, descriptor: job.descriptor }, 'ready');
    if (ready.type !== 'ready') throw new Error('Invalid ROI worker readiness response.');
    if (!ready.cached) {
      for (let offset = 0; offset < job.source.byteLength; offset += ROI_COPY_CHUNK_BYTES) {
        this.assertCurrent(job);
        const end = Math.min(offset + ROI_COPY_CHUNK_BYTES, job.source.byteLength);
        const bytes = job.source.slice(offset, end).buffer;
        await this.exchange(job, worker, { type: 'chunk', id: job.id, offset, bytes }, 'received', end, [bytes]);
        if (end < job.source.byteLength) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      await this.exchange(job, worker, { type: 'commit', id: job.id }, 'committed');
    }
    const result = await this.exchange(job, worker, { type: 'measure', id: job.id, annotation: job.annotation }, 'result');
    if (result.type !== 'result') throw new Error('Invalid ROI worker result.');
    return result.statistics;
  }

  private pump(): void {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    void Promise.resolve().then(async () => {
      while (this.queue.length && !this.disposed) {
        const job = this.queue.shift()!;
        if (this.jobs.get(job.key) !== job || !job.consumers.size) continue;
        this.active = job;
        try { this.finishJob(job, await this.run(job)); }
        catch (error) { this.finishJob(job, null, asError(error)); }
        finally { if (this.active === job) this.active = null; }
      }
    }).finally(() => { this.pumping = false; if (this.queue.length) this.pump(); });
  }
}

let shared: RoiStatisticsService | undefined;
export function requestSourceRoi(annotation: Annotation, volume: Volume): SourceRoiRequest {
  shared ??= new RoiStatisticsService();
  return shared.request(annotation, volume);
}
