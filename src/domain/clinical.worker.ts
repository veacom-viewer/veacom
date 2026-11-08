import type { PixelArray, Series, Volume } from '../model';
import { CLINICAL_CACHE_BYTES, CLINICAL_COPY_CHUNK_BYTES, measureStudy, type Measurement, type RoiMark, type SequenceChoice } from './clinical';
import { isLocale, setLocale, t, type Locale } from '../i18n';

export type ClinicalPixelType = 'float64' | 'float32' | 'int16' | 'uint16' | 'uint8';
export interface ClinicalVolumeDescriptor { series: Series; version: number; pixelType: ClinicalPixelType; byteLength: number; sourceFrameIndex?: number; }
export type ClinicalWorkerRequest =
  | { type: 'begin'; id: number; volumes: ClinicalVolumeDescriptor[]; locale?: Locale }
  | { type: 'start'; id: number; seriesId: string }
  | { type: 'chunk'; id: number; seriesId: string; offset: number; bytes: ArrayBuffer }
  | { type: 'commit'; id: number; seriesId: string }
  // The worker has no window: the panel sends its language so warnings come back in it.
  | { type: 'measure'; id: number; marks: RoiMark[]; sequences: Record<string, SequenceChoice>; locale?: Locale }
  | { type: 'cancel'; id: number };
export type ClinicalWorkerResult =
  | { type: 'ready'; id: number; missing: string[] }
  | { type: 'committed'; id: number; seriesId: string }
  | { type: 'received'; id: number; seriesId: string; offset: number }
  | { type: 'result'; id: number; measurement: Measurement; milliseconds: number }
  | { type: 'error'; id: number; message: string };
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ClinicalWorkerRequest>) => void) | null;
  postMessage: (result: ClinicalWorkerResult) => void;
};
const constructors = { float64: Float64Array, float32: Float32Array, int16: Int16Array, uint16: Uint16Array, uint8: Uint8Array };
const volumes = new Map<string, { version: number; volume: Volume }>();
let current: { id: number; descriptors: Map<string, ClinicalVolumeDescriptor> } | null = null;
let staged: { seriesId: string; bytes: ArrayBuffer; received: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let latestId = 0;

function validateDescriptor(descriptor: ClinicalVolumeDescriptor): number {
  const Constructor = constructors[descriptor.pixelType];
  if (!Constructor || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1) throw new Error('Invalid pixel representation or image version.');
  const { dimensions, components = 1 } = descriptor.series;
  if (dimensions.length !== 3 || dimensions.some(size => !Number.isSafeInteger(size) || size < 1) || ![1, 3].includes(components)) throw new Error('Invalid image dimensions.');
  const frame = descriptor.sourceFrameIndex;
  if (frame !== undefined && (!Number.isSafeInteger(frame) || frame < 0 || frame >= dimensions[2])) throw new Error('Invalid source frame index.');
  const expected = dimensions[0] * dimensions[1] * (frame === undefined ? dimensions[2] : 1) * components * Constructor.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(expected) || expected !== descriptor.byteLength) throw new Error('Image byte count does not match its dimensions and pixel type.');
  return expected;
}

scope.onmessage = ({ data }) => {
  if (data.type !== 'begin' && data.id !== current?.id) return;
  if ((data.type === 'begin' || data.type === 'measure') && isLocale(data.locale)) setLocale(data.locale);
  try {
    if (data.type === 'begin') {
      if (!Number.isSafeInteger(data.id) || data.id < 1) throw new Error('Invalid measurement generation.');
      if (data.id <= latestId) return;
      latestId = data.id;
      clearTimeout(timer); staged = null; current = null;
      const descriptors = new Map<string, ClinicalVolumeDescriptor>();
      let bytes = 0;
      for (const descriptor of data.volumes) {
        if (descriptors.has(descriptor.series.id)) throw new Error('Duplicate image in measurement request.');
        bytes += validateDescriptor(descriptor);
        if (bytes > CLINICAL_CACHE_BYTES) throw new Error(t('assessment.studyTooLarge'));
        descriptors.set(descriptor.series.id, descriptor);
      }
      for (const [id, entry] of volumes) {
        const descriptor = descriptors.get(id);
        if (descriptor?.version !== entry.version) volumes.delete(id);
        else volumes.set(id, { version: entry.version, volume: { series: descriptor.series, data: entry.volume.data, sourceFrameIndex: descriptor.sourceFrameIndex } });
      }
      current = { id: data.id, descriptors };
      scope.postMessage({ type: 'ready', id: data.id, missing: [...descriptors.keys()].filter(id => !volumes.has(id)) });
      return;
    }
    if (data.type === 'cancel') { clearTimeout(timer); staged = null; current = null; return; }
    if (!current) return;
    if (data.type === 'start') {
      const descriptor = current.descriptors.get(data.seriesId);
      if (!descriptor || volumes.has(data.seriesId) || staged) throw new Error('Unexpected image upload.');
      staged = { seriesId: data.seriesId, bytes: new ArrayBuffer(descriptor.byteLength), received: 0 };
      return;
    }
    if (data.type === 'chunk') {
      if (!staged || staged.seriesId !== data.seriesId || data.offset !== staged.received || !(data.bytes instanceof ArrayBuffer)
        || data.bytes.byteLength < 1 || data.bytes.byteLength > CLINICAL_COPY_CHUNK_BYTES || data.offset + data.bytes.byteLength > staged.bytes.byteLength) {
        throw new Error('Invalid or out-of-order image chunk.');
      }
      new Uint8Array(staged.bytes, data.offset, data.bytes.byteLength).set(new Uint8Array(data.bytes));
      staged.received += data.bytes.byteLength;
      scope.postMessage({ type: 'received', id: data.id, seriesId: data.seriesId, offset: staged.received });
      return;
    }
    if (data.type === 'commit') {
      const descriptor = current.descriptors.get(data.seriesId);
      if (!descriptor || !staged || staged.seriesId !== data.seriesId || staged.received !== descriptor.byteLength) throw new Error('Image upload is incomplete.');
      const pixels = new constructors[descriptor.pixelType](staged.bytes) as PixelArray;
      volumes.set(data.seriesId, { version: descriptor.version, volume: { series: descriptor.series, data: pixels, sourceFrameIndex: descriptor.sourceFrameIndex } });
      staged = null;
      scope.postMessage({ type: 'committed', id: data.id, seriesId: data.seriesId });
      return;
    }
    if (data.type === 'measure') {
      if (staged || [...current.descriptors].some(([id, descriptor]) => volumes.get(id)?.version !== descriptor.version)) throw new Error('Image upload must complete before measurement.');
      const wanted = [...current.descriptors.keys()].map(id => volumes.get(id)!.volume);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (data.id !== current?.id) return;
        const start = performance.now();
        try { scope.postMessage({ type: 'result', id: data.id, measurement: measureStudy(wanted, data.marks, data.sequences), milliseconds: performance.now() - start }); }
        catch (error) { scope.postMessage({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) }); }
      }, 0);
    }
  } catch (error) {
    clearTimeout(timer); staged = null; current = null;
    if (data.type === 'begin') volumes.clear();
    scope.postMessage({ type: 'error', id: data.id, message: error instanceof Error ? error.message : String(error) });
  }
};
