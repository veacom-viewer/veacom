// Runs the landmark model off the interface's thread (suggest.ts, docs/landmark-model.md): onnxruntime-web's
// WebAssembly build, on as many threads as the page's cross-origin isolation allows (one otherwise). The film's pixels
// arrive as a copy and its points go back; nothing leaves the computer.
import * as ort from 'onnxruntime-web/wasm';
import runtimeScript from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import runtimeBinary from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type { PixelArray } from '../../model';
import { ownScript } from '../../web/trusted-types';
import { CROP_KINDS, STAGE_A, STAGE_B, cropCentre, decodeStageA, readStageB, sampleCrop, stageACanvas, windowed, type Anchors, type ChannelPoint, type Channel, type ImageLeg } from './suggest';

export interface SuggestRequest {
  id: number;
  /** The two graphs, sent with the first request to a Worker. */
  models?: { stageA: ArrayBuffer; stageB: ArrayBuffer };
  /** One frame's stored values, row by row, inverted when MONOCHROME1. */
  film: { pixels: PixelArray; columns: number; rows: number; mm: [number, number]; invert: boolean };
  leg: ImageLeg;
}
export type SuggestReply = { id: number; ok: true; anchors: Record<ImageLeg, Anchors>; channels: Partial<Record<Channel, ChannelPoint>>; threads: number;
  timings: { window: number; stageA: number; crops: number; stageB: number } } | { id: number; ok: false; error: string };

// The browser build requires Trusted Types in Workers too: onnxruntime starts its threads from its own script, on this site.
(globalThis as { trustedTypes?: { createPolicy(name: string, rules: object): unknown } }).trustedTypes?.createPolicy('default', { createScriptURL: ownScript });
ort.env.wasm.wasmPaths = { mjs: runtimeScript, wasm: runtimeBinary };

let sessions: Promise<{ a: ort.InferenceSession; b: ort.InferenceSession }> | null = null;

async function suggest(request: SuggestRequest): Promise<SuggestReply> {
  if (request.models && !sessions) {
    const { stageA, stageB } = request.models;
    sessions = Promise.all([ort.InferenceSession.create(new Uint8Array(stageA)), ort.InferenceSession.create(new Uint8Array(stageB))]).then(([a, b]) => ({ a, b }));
  }
  if (!sessions) throw new Error('The landmark model is not loaded.');
  const { a, b } = await sessions;
  const { pixels, columns, rows, mm, invert } = request.film, mirror = request.leg === 'right';
  let start = performance.now();
  const lap = () => { const now = performance.now(), took = now - start; start = now; return took; };
  const film = windowed(pixels, columns, rows, invert);
  const { canvas, scale } = stageACanvas(film, columns, rows, mm);
  const window = lap();
  const coarse = await a.run({ canvas: new ort.Tensor('float32', canvas, [1, 1, STAGE_A.rows, STAGE_A.columns]) });
  const logits = coarse.heatmap_logits;
  const legs = decodeStageA(logits.data as Float32Array, logits.dims[2], logits.dims[3], scale), anchors = legs[request.leg];
  const stageA = lap();
  const centres = CROP_KINDS.map(kind => cropCentre(kind, request.leg, anchors, mm)), area = STAGE_B.size * STAGE_B.size;
  const crops = new Float32Array(centres.length * area);
  centres.forEach((centre, index) => crops.set(sampleCrop(film, columns, rows, centre, mm, mirror), index * area));
  const cropTime = lap();
  const fine = await b.run({ crops: new ort.Tensor('float32', crops, [centres.length, 1, STAGE_B.size, STAGE_B.size]) });
  const channels = readStageB(fine.coords.data as Float32Array, fine.confidence.data as Float32Array, CROP_KINDS, centres, mm, mirror);
  return { id: request.id, ok: true, anchors: legs, channels, threads: ort.env.wasm.numThreads ?? 1, timings: { window, stageA, crops: cropTime, stageB: lap() } };
}

self.onmessage = ({ data }: MessageEvent<SuggestRequest>) => {
  suggest(data).then(reply => self.postMessage(reply),
    (error: unknown) => self.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies SuggestReply));
};
