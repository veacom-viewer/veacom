import type { BridgeFeature, CoreState, DesktopBridge, ImportResult, Series, Volume, PixelArray } from './model';
import { t } from './i18n';
import { coreErrorText } from './i18n/core';
import { takePixels } from './imaging/pixelHandoff';

let state: CoreState | undefined;
let stateRequest: Promise<CoreState> | undefined;
let stateRevision = 0;
let epoch = new AbortController();
let listening = false;
const stateListeners = new Set<(state: CoreState) => void>();
const responseSignals = new WeakMap<Response, AbortSignal>();
const restartedMessage = () => t('engine.restartedReopen');

/** Whether the bridge can do `feature`; the desktop can do them all, the browser build not all (src/web/bridge.ts). */
export function bridgeCan(feature: BridgeFeature): boolean {
  return window.veacom?.features?.[feature] ?? true;
}

function desktop(): DesktopBridge {
  if (!window.veacom) throw new Error(t('engine.desktopRequired'));
  return window.veacom;
}
function receiveState(next: CoreState): void {
  stateRevision++;
  if (next.status !== 'ready' || (state && state.generation !== next.generation)) {
    epoch.abort(new Error(next.message || restartedMessage()));
    epoch = new AbortController();
  }
  state = next;
  for (const listener of stateListeners) listener(next);
}
function queryState(): Promise<CoreState> {
  if (!stateRequest) {
    const revision = stateRevision;
    const pending = desktop().getCoreState().then(next => {
      if (revision === stateRevision) receiveState(next);
      return state ?? next;
    }).finally(() => { if (stateRequest === pending) stateRequest = undefined; });
    stateRequest = pending;
  }
  return stateRequest;
}
function listenForEngine(): void {
  if (listening) return;
  const bridge = desktop();
  listening = true;
  bridge.onCoreState(receiveState);
  void queryState().catch(() => {});
}
export function subscribeEngineState(listener: (state: CoreState) => void): () => void {
  listenForEngine();
  stateListeners.add(listener);
  if (state) listener(state);
  return () => { stateListeners.delete(listener); };
}
async function readyState(expectedGeneration?: number): Promise<CoreState> {
  listenForEngine();
  const current = state ?? await queryState();
  if (current.status !== 'ready') throw new Error(current.message || t('engine.unavailable'));
  if (expectedGeneration !== undefined && current.generation !== expectedGeneration) throw new Error(restartedMessage());
  return current;
}
export async function assertSeriesEngine(series: Pick<Series, 'engineGeneration'>): Promise<{ generation: number }> {
  const current = await readyState(series.engineGeneration);
  return { generation: current.generation };
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function brokerRequest<T>(invoke: (bridge: DesktopBridge, generation: number) => Promise<T>, expectedGeneration?: number): Promise<T> {
  const requestEpoch = epoch;
  const current = await readyState(expectedGeneration);
  requestEpoch.signal.throwIfAborted();
  const result = await abortable(invoke(desktop(), current.generation), requestEpoch.signal);
  requestEpoch.signal.throwIfAborted();
  return result;
}
async function catalog(invoke: (bridge: DesktopBridge) => Promise<ImportResult>): Promise<ImportResult> {
  return brokerRequest(async (bridge, generation) => {
    const result = await invoke(bridge);
    if (result.series.some(series => series.engineGeneration !== generation)) throw new Error(restartedMessage());
    return result;
  });
}
export async function importPaths(capabilities: string[]): Promise<ImportResult> {
  return catalog(bridge => bridge.importSelected(capabilities));
}
export async function listSeries(): Promise<ImportResult> { return catalog(bridge => bridge.listSeries()); }
/** Early series for this selection only, including when its import was prefetched at startup. */
export async function importEarly(capabilities: string[], after: number): Promise<Series[]> {
  return brokerRequest(async (bridge, generation) => {
    const { series } = await bridge.importEarly(capabilities, after);
    if (series.some(item => item.engineGeneration !== generation)) throw new Error(restartedMessage());
    return series;
  });
}
/** `id` names the engine job shown, so a cancel reaches that job and no other. */
export interface CoreProgress { id?: number; running: boolean; stage: string; completed: number; total: number; cancelled: boolean; }
export async function getProgress(): Promise<CoreProgress> { return brokerRequest(bridge => bridge.getProgress()); }
export async function cancelOperation(id?: number): Promise<{ requested: boolean }> { return brokerRequest(bridge => bridge.cancelOperation(id)); }
export async function sampleSeries(series: Series, operation: import('./imaging/nativeMeasurements').SamplingOperation): Promise<unknown> {
  const revision = series.sourceRevision;
  if (!revision) throw new Error('Missing source revision.');
  return brokerRequest((bridge, generation) => bridge.measure(series.id, generation, revision, operation), series.engineGeneration);
}
export async function getTags(id: string, engineGeneration?: number, frame?: number, revision?: number): Promise<Record<string, unknown>[]> {
  return brokerRequest((bridge, generation) => revision !== undefined ? bridge.getTags(id, generation, frame, revision) : frame === undefined ? bridge.getTags(id, generation) : bridge.getTags(id, generation, frame), engineGeneration);
}
/** Takes series off the engine's catalog, freeing their memory; the files stay where they are. */
export async function removeSeries(ids: string[], engineGeneration?: number): Promise<{ removed: number; remaining?: number }> {
  return brokerRequest((bridge, generation) => bridge.removeSeries(ids, generation), engineGeneration);
}
async function pixelResponse(series: Series, index?: number, externalSignal?: AbortSignal): Promise<Response> {
  const requestEpoch = epoch;
  const signal = externalSignal ? AbortSignal.any([externalSignal, requestEpoch.signal]) : requestEpoch.signal;
  signal.throwIfAborted();
  const current = await readyState(series.engineGeneration);
  signal.throwIfAborted();
  const bridge = desktop(), revision = series.catalogRevision === undefined ? {} : { revision: series.catalogRevision };
  if (bridge.fetchPixels) {
    const response = await abortable(bridge.fetchPixels({ seriesId: series.id, generation: current.generation, ...revision, ...(index === undefined ? {} : { index }) }, signal), signal);
    signal.throwIfAborted();
    responseSignals.set(response, signal);
    return response;
  }
  const capability = await abortable(bridge.getPixels({ seriesId: series.id, generation: current.generation, ...revision, ...(index === undefined ? {} : { index }) }), signal);
  signal.throwIfAborted();
  if (capability.generation !== current.generation) throw new Error(restartedMessage());
  const url = new URL(capability.url);
  const kind = index === undefined ? 'volume' : 'frame';
  if (url.protocol !== 'veacom:' || url.host !== 'app' || url.username || url.password || url.search || url.hash
    || !new RegExp(`^/_imaging/${kind}/[A-Za-z0-9_-]+$`).test(url.pathname)) throw new Error('Invalid imaging response capability.');
  const response = await fetch(url.href, { signal });
  signal.throwIfAborted();
  if (!response.ok) {
    const text = await response.text();
    signal.throwIfAborted();
    // The engine answers { error, note }; the broker may answer in plain text.
    throw new Error(coreErrorText(text) || t('engine.returnedStatus', { status: response.status }));
  }
  responseSignals.set(response, signal);
  return response;
}
export async function loadVolume(series: Series): Promise<Volume> {
  return decodePixels(await pixelResponse(series), series);
}
export async function loadSourceFrame(series: Series, index: number, signal?: AbortSignal): Promise<Volume> {
  if (!Number.isInteger(index) || index < 0 || index >= series.dimensions[2]) throw new Error('Source frame index is out of range.');
  const response = await pixelResponse(series, index, signal);
  if (response.headers.get('X-Source-Frame-Index') !== String(index)) throw new Error(t('engine.differentFrame'));
  const identity = series.frameMetadata?.[index];
  if (identity?.sopInstanceUid && response.headers.get('X-SOP-Instance-UID') !== identity.sopInstanceUid) throw new Error(t('engine.sourceChanged'));
  if (identity?.sourceFrameNumber !== undefined && response.headers.get('X-Source-Frame-Number') !== String(identity.sourceFrameNumber)) throw new Error(t('engine.differentFrame'));
  const frame = await decodePixels(response,
    { ...series, dimensions: [series.dimensions[0], series.dimensions[1], 1] });
  return { ...frame, series: { ...series, pixelType: frame.series.pixelType, components: frame.series.components }, sourceFrameIndex: index };
}
async function decodePixels(response: Response, series: Series): Promise<Volume> {
  const pixelType = response.headers.get('X-Pixel-Type') ?? 'float32';
  const constructors = { float64: Float64Array, float32: Float32Array, int16: Int16Array, uint16: Uint16Array, uint8: Uint8Array };
  if (!(pixelType in constructors)) throw new Error(t('engine.unsupportedPixels', { type: pixelType }));
  const Constructor = constructors[pixelType as keyof typeof constructors];
  const components = Number(response.headers.get('X-Components') ?? series.components ?? 1);
  if (components !== 1 && components !== 3) throw new Error(t('engine.unsupportedComponents'));
  const expected = series.dimensions.reduce((a, b) => a * b, 1) * components * Constructor.BYTES_PER_ELEMENT;
  const bytes = await readPixels(response, expected);
  const data = new Constructor(bytes) as PixelArray;
  return { series: { ...series, pixelType: pixelType as Series['pixelType'], components }, data };
}

const incompleteImage = (received: number, expected: number) => new Error(t('engine.incompleteImage', { received, expected }));

/** Bytes read per step into a reused scratch buffer before they are copied into the image. */
const READ_STEP = 4 << 20;
// Matches the decoded volume limit in native/src/decode.rs.
const MAX_PIXEL_BYTES = 2 * 1024 ** 3;

/** Reads a pixel body into one buffer of the expected size, so a large volume is held once while it
 * arrives (`arrayBuffer()` collects the chunks and then copies them, holding it twice).
 * Byte streams, which is what Chromium's fetch bodies are, are read through a small scratch buffer
 * that each read hands back: nothing is left for the garbage collector. Reading straight into the
 * image instead moves the whole image buffer on every read, and V8 answered that with thousands of
 * collections (about 2 s for a 500 MiB volume). Other streams are copied chunk by chunk.
 * Cancelling the request (an engine restart, or the caller's signal) cancels the body, which ends a
 * pending read at once; the request's reason is what the caller then receives. */
async function readPixels(response: Response, expected: number): Promise<ArrayBuffer> {
  const signal = responseSignals.get(response);
  const body = response.body;
  const declared = response.headers.get('Content-Length');
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_PIXEL_BYTES
    || (declared !== null && Number(declared) !== expected)) {
    const error = new Error(t('engine.invalidImageSize'));
    void body?.cancel(error).catch(() => {});
    signal?.throwIfAborted();
    throw error;
  }
  const handed = takePixels(response);
  if (handed) {
    signal?.throwIfAborted();
    if (handed.byteLength !== expected) throw incompleteImage(handed.byteLength, expected);
    return handed;
  }
  if (!body) {
    const bytes = await response.arrayBuffer();
    signal?.throwIfAborted();
    if (bytes.byteLength !== expected) throw incompleteImage(bytes.byteLength, expected);
    return bytes;
  }
  let byob: ReadableStreamBYOBReader | undefined;
  try { byob = body.getReader({ mode: 'byob' }); } catch { /* not a byte stream */ }
  const reader = byob ?? body.getReader();
  const stop = () => { reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    signal?.throwIfAborted();
    const target = new Uint8Array(expected);
    let scratch = new ArrayBuffer(byob ? Math.min(READ_STEP, expected) : 0);
    let received = 0;
    for (;;) {
      const { done, value } = byob ? await byob.read(new Uint8Array(scratch)) : await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      signal?.throwIfAborted();
      if (done) break;
      if (received + value.byteLength > expected) throw incompleteImage(received + value.byteLength, expected);
      target.set(value, received);
      received += value.byteLength;
      if (byob) scratch = value.buffer as ArrayBuffer;
    }
    if (received !== expected) throw incompleteImage(received, expected);
    return target.buffer;
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw signal?.aborted ? signal.reason : error;
  } finally {
    // The engine generation's signal outlives this request.
    signal?.removeEventListener('abort', stop);
    reader.releaseLock();
  }
}
