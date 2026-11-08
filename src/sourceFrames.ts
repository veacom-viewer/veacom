import { loadSourceFrame } from './api';
import type { Series, Volume } from './model';
import { t } from './i18n';

type Loader = (series: Series, index: number, signal: AbortSignal) => Promise<Volume>;
interface Request {
  key: string;
  series: Series;
  index: number;
  controller: AbortController;
  promise: Promise<Volume>;
  resolve: (volume: Volume) => void;
  reject: (error: unknown) => void;
  consumers: number;
}

/** Keeps source paging independent of full-volume decoding and allocation. */
export class SourceFrameCache {
  private cached = new Map<string, Volume>();
  private requests = new Map<string, Request>();
  private queue: Request[] = [];
  private bytes = 0;
  private active = 0;
  private disposed = false;
  private loader: Loader;
  private byteLimit: number;
  private frameLimit: number;
  private concurrency: number;

  constructor(loader: Loader = loadSourceFrame, byteLimit = 64 * 1024 * 1024, frameLimit = 48, concurrency = 2) {
    if (byteLimit < 0 || frameLimit < 0 || !Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid source frame cache limits.');
    this.loader = loader; this.byteLimit = byteLimit; this.frameLimit = frameLimit; this.concurrency = concurrency;
  }

  get(series: Series, index: number, signal?: AbortSignal): Promise<Volume> {
    if (this.disposed || signal?.aborted) return Promise.reject(new DOMException('Frame request cancelled.', 'AbortError'));
    if (!Number.isInteger(index) || index < 0 || index >= series.dimensions[2]) return Promise.reject(new Error('Source frame index is out of range.'));
    const key = `${series.id}\0${series.catalogRevision ?? 0}\0${index}`;
    const cached = this.cached.get(key);
    if (cached) {
      this.cached.delete(key); this.cached.set(key, cached);
      return Promise.resolve(cached);
    }
    let request = this.requests.get(key);
    if (!request) {
      let resolve!: Request['resolve'], reject!: Request['reject'];
      const promise = new Promise<Volume>((yes, no) => { resolve = yes; reject = no; });
      request = { key, series, index, controller: new AbortController(), promise, resolve, reject, consumers: 0 };
      this.requests.set(key, request); this.queue.push(request);
    }
    const current = request;
    current.consumers++;
    const result = new Promise<Volume>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true; signal?.removeEventListener('abort', abort); current.consumers--;
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        reject(new DOMException('Frame request cancelled.', 'AbortError'));
        if (!current.consumers) this.cancel(current);
      };
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(volume => { if (finish()) resolve(volume); }, error => { if (finish()) reject(error); });
    });
    this.pump();
    return result;
  }

  invalidate(ids: readonly string[]): void {
    const selected = new Set(ids);
    for (const [key, volume] of this.cached) if (selected.has(volume.series.id)) {
      this.bytes -= volume.data.byteLength; this.cached.delete(key);
    }
    for (const request of this.requests.values()) if (selected.has(request.series.id)) this.cancel(request);
  }

  clear(): void {
    this.cached.clear(); this.bytes = 0;
    for (const request of this.requests.values()) this.cancel(request);
  }

  dispose(): void { this.disposed = true; this.clear(); }

  private cancel(request: Request): void {
    if (this.requests.get(request.key) !== request) return;
    this.requests.delete(request.key);
    this.queue = this.queue.filter(item => item !== request);
    request.controller.abort();
    request.reject(new DOMException('Frame request cancelled.', 'AbortError'));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const request = this.queue.shift()!;
      if (this.requests.get(request.key) !== request) continue;
      this.active++;
      Promise.resolve().then(() => this.loader(request.series, request.index, request.controller.signal)).then(volume => {
        if (this.requests.get(request.key) !== request) return;
        if (volume.sourceFrameIndex !== request.index || volume.series.id !== request.series.id) throw new Error(t('engine.differentFrame'));
        this.requests.delete(request.key);
        if (volume.data.byteLength <= this.byteLimit && this.frameLimit > 0) {
          this.cached.set(request.key, volume); this.bytes += volume.data.byteLength;
          while (this.bytes > this.byteLimit || this.cached.size > this.frameLimit) {
            const oldest = this.cached.entries().next().value!;
            this.bytes -= oldest[1].data.byteLength; this.cached.delete(oldest[0]);
          }
        }
        request.resolve(volume);
      }).catch(error => {
        if (this.requests.get(request.key) === request) { this.requests.delete(request.key); request.reject(error); }
      }).finally(() => { this.active--; this.pump(); });
    }
  }
}
