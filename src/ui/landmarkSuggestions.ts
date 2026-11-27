// "Suggest landmarks" in the deformity kit (docs/landmark-model.md): whether the film suits the landmark model, the
// model's two graphs fetched once and checked against their SHA-256 (electron/landmark-model.json), and the model run
// in its Worker (src/imaging/deformity/suggest.worker.ts) on a copy of the film's pixels. The film never leaves the
// computer: the only request is for the model's files, the first time.
import manifest from '../../electron/landmark-model.json';
import type { PixelArray, Series, Volume } from '../model';
import { projectionOf } from '../imaging/radiograph';
import { canvasSize, kitSuggestions, modelLeg, type Anchors, type ImageLeg, type Suggestion } from '../imaging/deformity/suggest';
import type { Point } from '../imaging/deformity/plane';
import { LANDMARKS, type LandmarkName } from '../imaging/deformity/landmarks';
import type { SuggestReply, SuggestRequest } from '../imaging/deformity/suggest.worker';
import type { ModelRef } from './deformityStore';
import type { PlanView } from './deformityPlan';
import { isPlaced } from './deformityPlan';

type ModelPart = keyof typeof manifest.files;
const MODEL_PARTS = Object.keys(manifest.files) as ModelPart[];
export const MODEL_BYTES = MODEL_PARTS.reduce((sum, part) => sum + manifest.files[part].bytes, 0);
export const MODEL: ModelRef = { model: manifest.name, sha256: { stageA: manifest.files.stageA.sha256, stageB: manifest.files.stageB.sha256 } };

/** Why the button is off: the side is not known, the film is not upright, it has no millimetres, it is larger than the
 * model's canvas, it is not greyscale (colour or a palette), or every landmark is placed. */
type SuggestBlock = 'side' | 'upright' | 'spacing' | 'size' | 'colour' | 'placed';

/** The film's leg for the active plan, or why the model cannot run on it. The model was trained on upright greyscale
 * films with their pixel spacing, hips at the top: its rows must run across the patient and its columns towards the
 * feet, as Patient Orientation says (or as the reader answered, for the side). */
export function suggestionTarget(view: PlanView, frame: Series): { leg: ImageLeg } | { block: SuggestBlock } {
  if (frame.components === 3 || !/^MONOCHROME[12]$/i.test(frame.photometricInterpretation)) return { block: 'colour' };
  if (!view.mm) return { block: 'spacing' };
  if (!view.lateral) return { block: 'side' };
  const orientation = projectionOf(frame)?.patientOrientation, leg = modelLeg(view.lateral);
  if (!leg || (orientation && !/F/.test(orientation[1]))) return { block: 'upright' };
  if (!canvasSize(frame.dimensions[0], frame.dimensions[1], view.mm).fits) return { block: 'size' };
  if (LANDMARKS.every(name => isPlaced(view.plan, name))) return { block: 'placed' };
  return { leg };
}

/** One frame's stored values, copied: the Volume's own buffer is never handed over. */
export function framePixels(volume: Volume, frameIndex: number): PixelArray {
  const [columns, rows] = volume.series.dimensions, size = columns * rows;
  // `frame`: the film's pixels are not all here yet (a frame still loading).
  if (volume.sourceFrameIndex !== undefined && volume.sourceFrameIndex !== frameIndex) throw new Error('frame');
  const offset = volume.sourceFrameIndex !== undefined ? 0 : frameIndex * size;
  if (offset + size > volume.data.length) throw new Error('frame');
  return volume.data.slice(offset, offset + size);
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** The model's graphs, fetched by the app (desktop: main process, cached in userData; browser: this site, cached in
 * Cache Storage) and checked here against the SHA-256 the app was built with. Kept for the session once checked. */
interface Loading { loading: Promise<Record<ModelPart, ArrayBuffer>>; loaded: boolean }
let models: Loading | null = null;
/** Fails with `unavailable` (no way to fetch them), `download` (not received) or `checksum` (not the files expected). */
export function loadModel(onProgress: (received: number) => void): Promise<Record<ModelPart, ArrayBuffer>> {
  const fetchPart = window.veacom?.landmarkModel;
  if (!fetchPart) return Promise.reject(new Error('unavailable'));
  if (models) return models.loading;
  const received: Record<ModelPart, number> = { stageA: 0, stageB: 0 };
  const loading = Promise.all(MODEL_PARTS.map(async part => {
    const bytes = await fetchPart(part, count => { received[part] = count; onProgress(received.stageA + received.stageB); })
      .catch((error: unknown) => { throw new Error((error as Error | null)?.message === 'checksum' ? 'checksum' : 'download', { cause: error }); });
    if (bytes.byteLength !== manifest.files[part].bytes || hex(await crypto.subtle.digest('SHA-256', bytes)) !== manifest.files[part].sha256) throw new Error('checksum');
    return [part, bytes] as const;
  })).then(parts => Object.fromEntries(parts) as Record<ModelPart, ArrayBuffer>);
  const entry: Loading = { loading, loaded: false };
  models = entry;
  // A load that failed is not kept: the next press tries again. The caller gets the failure from `loading` itself.
  loading.then(() => { entry.loaded = true; }, () => { if (models === entry) models = null; });
  return loading;
}

/** Stops a model download under way (desktop: main process's download; browser: the fetch). Graphs already checked
 * are kept. */
export function cancelModelDownload() {
  if (!models || models.loaded) return;
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
    // `run`: the model did not run (its runtime or graphs did not load, or it failed); the detail goes to the console.
    current.worker.onerror = event => { event.preventDefault(); signal.removeEventListener('abort', stop); end(); console.error('The landmark model stopped:', event.message); reject(new Error('run')); };
    current.worker.onmessage = ({ data }: MessageEvent<SuggestReply>) => {
      if (data.id !== id) return;
      signal.removeEventListener('abort', stop);
      // The whole run as the reader waits for it: the Worker's start, the graphs' loading and the model.
      if (data.ok) resolve({ ...data, total: performance.now() - started });
      else { end(); console.error('The landmark model failed:', data.error); reject(new Error('run')); }
    };
    const transfer = [film.pixels.buffer as ArrayBuffer, ...(request.models ? [request.models.stageA, request.models.stageB] : [])];
    current.worker.postMessage(request, transfer);
  });
}

/** Stage A's least peak probability (`Anchors.peak`) below which a v2 graph is not sure of a leg and suggests nothing. */
export const UNSURE_PEAK = 0.02;
/** Stage A v3 numerical-sanity floor on heatmap peak probability alongside calibrated `presence`. */
export const UNSURE_PEAK_V3 = 0.005;
/** Stage A v3 calibrated visibility/OOD threshold on `min(sigmoid(presence_logits))` across the leg's three joints. */
export const UNSURE_PRESENCE = 0.15;

/** The kit's suggestions from a run; 'unsure' when stage A is not sure of the leg (`UNSURE_PRESENCE` and `UNSURE_PEAK_V3`
 * on v3 graphs, `UNSURE_PEAK` on v2); or null when the model did not find two legs: the leg's hip, knee and ankle must
 * come down the film in that order, and the image's left leg must lie left of its right leg (a film of one leg, or not a
 * long-leg film, can fail either). A suggestion with a point off the film is left out. */
export function suggestionsFrom(legs: Record<ImageLeg, Anchors>, leg: ImageLeg, channels: Extract<SuggestReply, { ok: true }>['channels'],
  mm: readonly [number, number], size: readonly [number, number]): Partial<Record<LandmarkName, Suggestion>> | 'unsure' | null {
  const { hip, knee, ankle, peak, presence } = legs[leg];
  if (presence !== undefined) {
    if (!(presence >= UNSURE_PRESENCE) || !(peak >= UNSURE_PEAK_V3)) return 'unsure';
  } else if (!(peak >= UNSURE_PEAK)) {
    return 'unsure';
  }
  // Two femoral heads' centres lie a pelvis apart, far more than 50 mm even in a child: closer, both legs' points are
  // on one leg.
  if (!(hip[1] < knee[1] && knee[1] < ankle[1]) || !((legs.right.hip[0] - legs.left.hip[0]) * mm[0] > 50)) return null;
  const onFilm = (p: Point) => p[0] >= 0 && p[0] <= size[0] && p[1] >= 0 && p[1] <= size[1];
  return Object.fromEntries(Object.entries(kitSuggestions(channels, mm)).filter(([, item]) => item.points.every(onFilm)));
}
