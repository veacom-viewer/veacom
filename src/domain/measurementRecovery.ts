import type { Annotation, FrameMetadata, Series, Vec3 } from '../model';
import { annotationSourceIndex, shownOnView } from '../imaging/annotations';
import { sliceCount } from '../imaging/geometry';
import { sphereOf } from '../imaging/voi';
import { uidDigest } from './petStudies';
import { filmKey, type FilmCalibration } from '../imaging/radiograph';

export const measurementTools = ['length', 'angle', 'cobb', 'rectangle', 'ellipse', 'polygon', 'polyline', 'sphere', 'probe', 'arrow', 'text'] as const;
export interface SavedMeasurement {
  scope: string;
  id: string;
  reference: string;
  drawing: Omit<Annotation, 'sourceSopInstanceUid'>;
}

export interface SavedCalibration {
  scope: string; id: string; reference: string; frame: number | null; calibration: FilmCalibration;
  sources?: string[];
}
export type RecoveryRecord = SavedMeasurement | SavedCalibration;
export type CalibrationEdit = { frame: number | null; value: FilmCalibration | null };

const scopes = new WeakMap<Series, Promise<string>>();
const grids = new WeakMap<Series, Promise<string>>();
const sources = new WeakMap<Series, Map<number, Promise<string>>>();
const duplicates = new WeakMap<Series, Set<FrameMetadata>>();

/** Both copies of a repeated SOP/frame identity are ambiguous, even when one has different geometry. */
function duplicateFrames(series: Series): Set<FrameMetadata> {
  const cached = duplicates.get(series);
  if (cached) return cached;
  const seen = new Map<string, FrameMetadata>(), repeated = new Set<FrameMetadata>();
  for (const frame of series.frameMetadata ?? []) {
    const key = JSON.stringify([frame.sopInstanceUid, frame.sourceFrameNumber]);
    const previous = seen.get(key);
    if (previous) { repeated.add(previous); repeated.add(frame); }
    else seen.set(key, frame);
  }
  duplicates.set(series, repeated);
  return repeated;
}

/** Native patient identity includes the ID issuer or the study-scoped fallback. The database key carries no name or UID. */
export function measurementScope(series: Series): Promise<string> | undefined {
  if (!series.patientKey || !series.studyUid || !series.uid) return;
  let scope = scopes.get(series);
  if (!scope) {
    scope = uidDigest(JSON.stringify([series.patientKey, series.studyUid, series.uid]));
    scopes.set(series, scope);
  }
  return scope;
}

async function sourceReference(series: Series, index: number): Promise<string | undefined> {
  const frame = series.frameMetadata?.[index];
  if (!frame?.sopInstanceUid || duplicateFrames(series).has(frame)) return;
  let cache = sources.get(series);
  if (!cache) { cache = new Map(); sources.set(series, cache); }
  let reference = cache.get(index);
  if (!reference) {
    // PS3.3 10.3: the SOP Instance and its frame number identify an acquired image. The grid must also fit the saved points.
    reference = uidDigest(JSON.stringify([frame.sopInstanceUid, frame.sourceFrameNumber, series.frameOfReferenceUid,
      series.dimensions.slice(0, 2), frame.origin, frame.direction, frame.spacing.slice(0, 2), frame.spacingKnown, frame.orientationKnown,
      frame.positionKnown, frame.projection?.basis, frame.projection?.spacing]));
    cache.set(index, reference);
  }
  return reference;
}

function gridReference(series: Series): Promise<string> | undefined {
  let reference = grids.get(series);
  if (reference) return reference;
  const frames = series.frameMetadata;
  if (frames?.length !== series.dimensions[2] || !frames.every(f => f.sopInstanceUid) || duplicateFrames(series).size) return;
  reference = uidDigest(JSON.stringify([series.id, series.frameOfReferenceUid, series.dimensions, series.origin, series.direction, series.spacing,
    frames.map(f => [f.sopInstanceUid, f.sourceFrameNumber, f.origin, f.direction, f.spacing, f.spacingKnown, f.positionKnown, f.orientationKnown, f.projection?.basis, f.projection?.spacing])]));
  grids.set(series, reference);
  return reference;
}

function isMeasurementTool(type: unknown): type is (typeof measurementTools)[number] {
  return measurementTools.some(tool => tool === type);
}

function managed(series: Series, annotation: Annotation): boolean {
  // The PET record owns lesion metrics, reference roles and the confirmed score as well as the sphere.
  return isMeasurementTool(annotation.type) && !(series.modality === 'PT' && annotation.type === 'sphere');
}

export function measurementEdits(series: Series, before: Annotation[], after: Annotation[]) {
  const old = new Map(before.filter(a => managed(series, a)).map(a => [a.id, a]));
  const put = after.filter(a => managed(series, a) && old.get(a.id) !== a);
  for (const a of after) if (managed(series, a)) old.delete(a.id);
  return { put, remove: [...old.keys()] };
}

const point = (p: unknown): p is Vec3 => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const tilt = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
function validDrawing(value: unknown): value is Annotation {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<Annotation>;
  if (typeof d.id !== 'string' || !/^[\w-]+$/.test(d.id) || d.id === 'draft' || !isMeasurementTool(d.type)
    || (d.plane !== 'axial' && d.plane !== 'coronal' && d.plane !== 'sagittal') || (d.mode !== 'source' && d.mode !== 'mpr')
    || typeof d.slice !== 'number' || !Number.isSafeInteger(d.slice) || d.slice < 0 || !Array.isArray(d.points) || !d.points.length || !d.points.every(point)) return false;
  const count = d.points.length;
  switch (d.type) {
    case 'text': case 'probe': if (count !== 1) return false; break;
    case 'arrow': case 'length': case 'sphere': if (count !== 2) return false; break;
    case 'angle': if (count !== 3) return false; break;
    case 'cobb': case 'rectangle': case 'ellipse': if (count !== 4) return false; break;
    case 'polyline': if (count < 2) return false; break;
    case 'polygon': if (count < 3) return false; break;
  }
  if ((d.createdAt !== undefined && !Number.isFinite(d.createdAt))
    || (d.color !== undefined && (typeof d.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(d.color)))
    || (d.label !== undefined && typeof d.label !== 'string') || (d.labelShift !== undefined && !point(d.labelShift))
    || (d.oblique !== undefined && !tilt(d.oblique))) return false;
  return !d.caliper || (['keros', 'aea', 'sella', 'septum'].includes(d.caliper.kind) && ['right', 'left', 'both'].includes(d.caliper.side)
    && typeof d.caliper.item === 'string' && point(d.caliper.up) && point(d.caliper.normal));
}

function drawingGrid(series: Series, drawing: Annotation): Promise<string> | undefined {
  if (!series.canReconstruct || drawing.slice >= sliceCount(series, drawing)) return;
  // A volume sphere can be moved from another section. Planar drawings must still lie on their own plane.
  if (drawing.type === 'sphere' ? !sphereOf(drawing) : !shownOnView(drawing, series, drawing)) return;
  return gridReference(series);
}

export async function saveMeasurement(series: Series, scope: string, annotation: Annotation): Promise<SavedMeasurement> {
  if (!validDrawing(annotation)) throw new Error('Invalid measurement');
  const index = annotation.mode === 'source' && annotation.sourceSopInstanceUid ? annotationSourceIndex(annotation, series) : null;
  const reference = await (annotation.mode === 'source' ? index !== null && sourceReference(series, index) : drawingGrid(series, annotation));
  if (!reference) throw new Error('Missing measurement reference');
  const drawing = { ...annotation };
  delete drawing.sourceSopInstanceUid;
  return { scope, id: annotation.id, reference, drawing };
}

/** Resolve the image anew on every import. A source image may have moved to another index, or be missing or ambiguous. */
export async function recoverMeasurement(series: Series, scope: string, value: unknown): Promise<Annotation | null> {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SavedMeasurement>;
  if (record.scope !== scope || !validDrawing(record.drawing) || record.id !== record.drawing.id
    || !managed(series, record.drawing) || typeof record.reference !== 'string') return null;
  const a = record.drawing;
  if (a.mode === 'mpr') return await drawingGrid(series, a) === record.reference ? a : null;
  const index = await findSource(series, record.reference, a.sourceFrame ?? a.slice);
  if (index === null) return null;
  const frame = series.frameMetadata![index];
  const placed = { ...a, slice: index, sourceFrame: index, sourceSopInstanceUid: frame.sopInstanceUid, sourceFrameNumber: frame.sourceFrameNumber };
  return annotationSourceIndex(placed, series) === index ? placed : null;
}

async function findSource(series: Series, reference: string, hint: number): Promise<number | null> {
  const frames = series.frameMetadata;
  if (!frames) return null;
  let index = hint;
  if (await sourceReference(series, index) !== reference) {
    const hashes = await Promise.all(frames.map((_, i) => sourceReference(series, i)));
    index = hashes.indexOf(reference);
    if (index < 0 || hashes.lastIndexOf(reference) !== index) return null;
  }
  return index;
}

export function calibrationEditId(series: Series, frame: number | null): string {
  return frame === null ? '@series' : '@film:' + filmKey(series, frame);
}

export async function saveCalibration(series: Series, scope: string, edit: CalibrationEdit): Promise<{ id: string; put?: SavedCalibration }> {
  const reference = await (edit.frame === null ? gridReference(series) : sourceReference(series, edit.frame));
  if (!reference) throw new Error('Missing calibration reference');
  const id = edit.frame === null ? '@scale:' + series.id : '@film:' + reference;
  if (!edit.value) return { id };
  const put: SavedCalibration = { scope, id, frame: edit.frame, reference, calibration: edit.value };
  if (edit.frame === null) {
    // A reader may reopen just a few slices. Those exact images keep their scale even when the reconstruction changed.
    const hashes = await Promise.all(series.frameMetadata!.map((_, i) => sourceReference(series, i)));
    put.sources = hashes.filter((hash): hash is string => hash !== undefined);
  }
  return { id, put };
}

function validCalibration(value: unknown): value is FilmCalibration {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (c.depthConfirmed !== undefined && typeof c.depthConfirmed !== 'boolean') return false;
  if (c.method === 'dicom') return true;
  return typeof c.scale === 'number' && Number.isFinite(c.scale) && c.scale > 0 && (c.method === 'scale'
    || ((c.method === 'ball' || c.method === 'ruler') && typeof c.knownMm === 'number' && Number.isFinite(c.knownMm) && c.knownMm > 0));
}

export async function recoverCalibration(series: Series, scope: string, value: unknown): Promise<CalibrationEdit[]> {
  if (!value || typeof value !== 'object') return [];
  const row = value as Partial<SavedCalibration>;
  if (row.scope !== scope || !validCalibration(row.calibration) || typeof row.reference !== 'string') return [];
  if (row.frame === null) {
    if (row.id !== '@scale:' + series.id || row.calibration.method !== 'scale') return [];
    if (await gridReference(series) === row.reference) return [{ frame: null, value: row.calibration }];
    if (!Array.isArray(row.sources) || !series.frameMetadata) return [];
    const known = new Set(row.sources), calibration = row.calibration;
    const matches = await Promise.all(series.frameMetadata.map((_, i) => sourceReference(series, i)));
    return matches.flatMap((hash, frame) => hash && known.has(hash) ? [{ frame, value: calibration }] : []);
  }
  if (typeof row.frame !== 'number' || !Number.isSafeInteger(row.frame) || row.frame < 0 || row.id !== '@film:' + row.reference) return [];
  const frame = await findSource(series, row.reference, row.frame);
  return frame === null ? [] : [{ frame, value: row.calibration }];
}
