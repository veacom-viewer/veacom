// "Suggest landmarks" in the deformity kit (docs/landmark-model.md): whether the film suits the landmark model, the
// model's two graphs fetched once and checked against their SHA-256 (electron/landmark-model.json), and the model run
// in its Worker (src/imaging/deformity/suggest.worker.ts) on a copy of the film's pixels. The film never leaves the
// computer: the only request is for the model's files, the first time.
import manifest from '../../electron/landmark-model.json';
import type { PixelArray, Series, Volume } from '../model';
import { projectionOf } from '../imaging/radiograph';
import { canvasSize, kitSuggestions, modelLeg, SUGGESTED, type Anchors, type ImageLeg, type Suggestion } from '../imaging/deformity/suggest';
import type { LandmarkName } from '../imaging/deformity/landmarks';
import type { SuggestReply, SuggestRequest } from '../imaging/deformity/suggest.worker';
import type { ModelRef } from './deformityStore';
import type { PlanView } from './deformityPlan';
import { isPlaced } from './deformityPlan';

type ModelPart = keyof typeof manifest.files;
const MODEL_PARTS = Object.keys(manifest.files) as ModelPart[];
export const MODEL_BYTES = MODEL_PARTS.reduce((sum, part) => sum + manifest.files[part].bytes, 0);
export const MODEL: ModelRef = { model: manifest.name, sha256: { stageA: manifest.files.stageA.sha256, stageB: manifest.files.stageB.sha256 } };

/** Why the button is off: the side is not known, the film is not upright, it has no millimetres, it is larger than the
 * model's canvas, it is in colour, or every suggested landmark is placed. */
type SuggestBlock = 'side' | 'upright' | 'spacing' | 'size' | 'colour' | 'placed';

/** The film's leg for the active plan, or why the model cannot run on it. The model was trained on upright greyscale
 * films with their pixel spacing, hips at the top: its rows must run across the patient and its columns towards the
 * feet, as Patient Orientation says (or as the reader answered, for the side). */
export function suggestionTarget(view: PlanView, frame: Series): { leg: ImageLeg } | { block: SuggestBlock } {
  if (frame.components === 3) return { block: 'colour' };
  if (!view.mm) return { block: 'spacing' };
  if (!view.lateral) return { block: 'side' };
  const orientation = projectionOf(frame)?.patientOrientation, leg = modelLeg(view.lateral);
  if (!leg || (orientation && !/F/.test(orientation[1]))) return { block: 'upright' };
  if (!canvasSize(frame.dimensions[0], frame.dimensions[1], view.mm).fits) return { block: 'size' };
  if (SUGGESTED.every(name => isPlaced(view.plan, name))) return { block: 'placed' };
  return { leg };
}

/** One frame's stored values, copied: the Volume's own buffer is never handed over. */
export function framePixels(volume: Volume, frameIndex: number): PixelArray {
  const [columns, rows] = volume.series.dimensions, size = columns * rows;
  if (volume.sourceFrameIndex !== undefined && volume.sourceFrameIndex !== frameIndex) throw new Error('The film\'s frame is not loaded yet.');
  const offset = volume.sourceFrameIndex !== undefined ? 0 : frameIndex * size;
  if (offset + size > volume.data.length) throw new Error('The film\'s pixels are incomplete.');
  return volume.data.slice(offset, offset + size);
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** The model's graphs, fetched by the app (desktop: main process, cached in userData; browser: this site, cached in
 * Cache Storage) and checked here against the SHA-256 the app was built with. Kept for the session once checked. */
let models: Promise<Record<ModelPart, ArrayBuffer>> | null = null;
export function loadModel(onProgress: (received: number) => void): Promise<Record<ModelPart, ArrayBuffer>> {
  const fetchPart = window.veacom?.landmarkModel;
  if (!fetchPart) return Promise.reject(new Error('unavailable'));
  if (models) return models;
  const received: Record<ModelPart, number> = { stageA: 0, stageB: 0 };
  const loading = Promise.all(MODEL_PARTS.map(async part => {
    const bytes = await fetchPart(part, count => { received[part] = count; onProgress(received.stageA + received.stageB); });
    if (bytes.byteLength !== manifest.files[part].bytes || hex(await crypto.subtle.digest('SHA-256', bytes)) !== manifest.files[part].sha256) throw new Error('checksum');
    return [part, bytes] as const;
  })).then(parts => Object.fromEntries(parts) as Record<ModelPart, ArrayBuffer>);
  models = loading;
  // A load that failed is not kept: the next press tries again. The caller gets the failure from `loading` itself.
  loading.catch(() => { if (models === loading) models = null; });
  return loading;
}

/** Stops a model download under way (desktop: main process's download; browser: the fetch). */
export function cancelModelDownload() {
  models = null;
  void window.veacom?.cancelLandmarkModel?.();
}

let worker: { worker: Worker; loaded: boolean } | null = null;
let requestId = 0;

/** The model run on one leg of one frame, in its Worker. Aborted or failed, the Worker is stopped, so a failure while
 * the runtime or the graphs load is not kept: the next run starts another. */
export async function runModel(film: SuggestRequest['film'], leg: ImageLeg, graphs: Record<ModelPart, ArrayBuffer>, signal: AbortSignal): Promise<Extract<SuggestReply, { ok: true }> & { total: number }> {
  if (signal.aborted) throw signal.reason;
  const started = performance.now();
  const current = worker ??= { worker: new Worker(new URL('../imaging/deformity/suggest.worker.ts', import.meta.url), { type: 'module' }), loaded: false };
  const id = ++requestId;
  // The graphs go once to each Worker, as copies: the checked buffers stay here for a Worker started later.
  const request: SuggestRequest = { id, film, leg, ...(current.loaded ? {} : { models: { stageA: graphs.stageA.slice(0), stageB: graphs.stageB.slice(0) } }) };
  current.loaded = true;
  return new Promise((resolve, reject) => {
    const end = () => { current.worker.terminate(); if (worker === current) worker = null; };
    const stop = () => { end(); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
    current.worker.onerror = event => { event.preventDefault(); signal.removeEventListener('abort', stop); end(); reject(new Error(event.message || 'The landmark model stopped.')); };
    current.worker.onmessage = ({ data }: MessageEvent<SuggestReply>) => {
      if (data.id !== id) return;
      signal.removeEventListener('abort', stop);
      // The whole run as the reader waits for it: the Worker's start, the graphs' loading and the model.
      if (data.ok) resolve({ ...data, total: performance.now() - started });
      else { end(); reject(new Error(data.error)); }
    };
    const transfer = [film.pixels.buffer as ArrayBuffer, ...(request.models ? [request.models.stageA, request.models.stageB] : [])];
    current.worker.postMessage(request, transfer);
  });
}

/** The kit's suggestions from a run, or null when its hip, knee and ankle are not in that order down the film: the
 * model then did not find this leg (a film of one leg, or not a long-leg film). */
export function suggestionsFrom(anchors: Anchors, channels: Extract<SuggestReply, { ok: true }>['channels'], mm: readonly [number, number]): Partial<Record<LandmarkName, Suggestion>> | null {
  if (!(anchors.hip[1] < anchors.knee[1] && anchors.knee[1] < anchors.ankle[1])) return null;
  return kitSuggestions(channels, mm);
}
