// The plan file (docs/deformity-labels.md): one film's plans as versioned JSON, which the reader saves and opens again,
// and the labelled landmarks a landmark model can later learn from. It names no patient: the film is known by a
// SHA-256 of its SOP Instance UID and its frame. Opened files are untrusted: every field is checked before use.
import type { Series } from '../model';
import { calibrationState, millimetresPerPixel, projectionOf, type CalibrationState } from '../imaging/radiograph';
import { CONTOUR_MAXIMUM, isContour, LANDMARKS, type LandmarkName } from '../imaging/deformity/landmarks';
import type { Osteotomy } from '../imaging/deformity/osteotomy';
import type { Point } from '../imaging/deformity/plane';
import { activePlan, newPlan, type FilmPlans, type LegPlan, type Marker } from './deformityStore';
import { planView } from './deformityPlan';

export const PLAN_SCHEMA = 'veacom.deformity-plan';
export const PLAN_VERSION = 1;
/** The kernel's version: a change to what a value means (src/imaging/deformity) raises it. */
export const KERNEL_VERSION = 1;
const MAX_BYTES = 2_000_000;
const MAX_PLANS = 16;

/** One landmark as a training label: where it is, what it is, and how far it can be trusted. */
export interface LandmarkLabel {
  name: LandmarkName | 'hipCentre';
  /** Image pixels, DICOM image-relative: (0, 0) is the top left corner of the top left pixel. */
  points: Array<[number, number]>;
  /** Placed by hand for now; a model's suggestion will carry its own confidence. */
  confidence: 'manual';
  provenance: Array<'placed' | 'moved' | 'derived'>;
  /** What the film's millimetres stood for when the label was made (imaging/radiograph.ts). */
  spacing: CalibrationState;
  side: 'R' | 'L';
  software: string;
  /** Whether a suggestion was on screen when the point was placed (never yet: there are no suggestions). */
  suggestionShown: false;
  /** For a derived point: how it was made. */
  derivedFrom?: 'femoralHeadContour';
}

export interface PlanFile {
  schema: typeof PLAN_SCHEMA; version: typeof PLAN_VERSION;
  software: { name: 'VEAcom'; version: string; kernel: number };
  savedAt: string;
  coordinates: 'dicom-image-relative';
  film: { sopInstanceSha256: string; frame: number; columns: number; rows: number; modality: string; patientOrientation?: [string, string]; laterality?: string;
    /** The reader's answer when the film records no Patient Orientation. */
    patientRight?: 'left' | 'right' };
  calibration: { state: CalibrationState; mmPerPixel: [number, number] | null; pixelSpacing?: [number, number]; imagerPixelSpacing?: [number, number];
    magnification?: number; calibrationType?: string; marker: Marker | null };
  active: number;
  plans: Array<{ name: string; side: 'R' | 'L'; landmarks: LandmarkLabel[]; osteotomy: Osteotomy | null;
    /** The values as measured when saved, for reading the file without VEAcom; ignored when it is opened. */
    values: Record<string, { value: number | null; unit: string }> }>;
}

export async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const software = () => (typeof window !== 'undefined' && window.veacom?.getVersion()) || 'unknown';

/** The plan file of a film. `frame` is the film's frame series (sourceFrameSeries). */
export async function planFile(film: FilmPlans, frame: Series, now = new Date()): Promise<PlanFile> {
  const projection = projectionOf(frame), state = calibrationState(frame), version = software();
  return {
    schema: PLAN_SCHEMA, version: PLAN_VERSION, software: { name: 'VEAcom', version, kernel: KERNEL_VERSION }, savedAt: now.toISOString(),
    coordinates: 'dicom-image-relative',
    film: { sopInstanceSha256: await sha256(film.sopInstanceUid), frame: film.frameNumber, columns: frame.dimensions[0], rows: frame.dimensions[1], modality: frame.modality,
      ...(projection?.patientOrientation ? { patientOrientation: projection.patientOrientation } : {}), ...(projection?.laterality ? { laterality: projection.laterality } : {}),
      ...(film.patientRight ? { patientRight: film.patientRight } : {}) },
    calibration: { state, mmPerPixel: millimetresPerPixel(frame), ...(projection?.pixelSpacing ? { pixelSpacing: projection.pixelSpacing } : {}),
      ...(projection?.imagerPixelSpacing ? { imagerPixelSpacing: projection.imagerPixelSpacing } : {}), ...(projection?.magnification ? { magnification: projection.magnification } : {}),
      ...(projection?.calibrationType ? { calibrationType: projection.calibrationType } : {}), marker: film.marker },
    active: Math.max(0, film.plans.findIndex(plan => plan.id === film.active)),
    plans: film.plans.map(plan => {
      const view = planView(film, frame, plan);
      const label = (name: LandmarkLabel['name'], points: readonly Point[], provenance: LandmarkLabel['provenance']): LandmarkLabel => ({
        name, points: points.map(p => [p[0], p[1]]), confidence: 'manual', provenance, spacing: state, side: plan.side, software: version, suggestionShown: false });
      const landmarks = LANDMARKS.filter(name => plan.points[name]?.length).map(name => label(name, plan.points[name]!, plan.provenance[name] ?? plan.points[name]!.map(() => 'placed' as const)));
      if (view.leg.hip) landmarks.push({ ...label('hipCentre', [view.leg.hip.centre], ['derived']), derivedFrom: 'femoralHeadContour' });
      return { name: plan.name, side: plan.side, landmarks, osteotomy: plan.osteotomy,
        values: Object.fromEntries(Object.values(view.leg.values).map(value => [value.key, { value: value.value, unit: value.unit }])) };
    }),
  };
}

export type ParseError = 'size' | 'json' | 'schema' | 'version' | 'film' | 'content';
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads a plan file for this film: its plans and marker, or why it cannot be used. Points must lie within the film
 * or half its size around it; text is bounded; unknown fields are ignored. */
export async function parsePlanFile(text: string, film: FilmPlans, frame: Series): Promise<{ plans: LegPlan[]; active: number; marker: Marker | null; patientRight?: 'left' | 'right' } | { error: ParseError }> {
  if (text.length > MAX_BYTES) return { error: 'size' };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { error: 'json' }; }
  if (!isObject(value) || value.schema !== PLAN_SCHEMA) return { error: 'schema' };
  if (value.version !== PLAN_VERSION) return { error: 'version' };
  const recorded = value.film;
  if (!isObject(recorded) || recorded.sopInstanceSha256 !== await sha256(film.sopInstanceUid) || recorded.frame !== film.frameNumber
    || recorded.columns !== frame.dimensions[0] || recorded.rows !== frame.dimensions[1]) return { error: 'film' };
  const [columns, rows] = frame.dimensions;
  const point = (p: unknown): Point | null => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1])
    && p[0] >= -columns / 2 && p[0] <= columns * 1.5 && p[1] >= -rows / 2 && p[1] <= rows * 1.5 ? [p[0], p[1]] : null;
  const points = (list: unknown, max: number): Point[] | null => {
    if (!Array.isArray(list) || list.length > max) return null;
    const parsed = list.map(point);
    return parsed.every(Boolean) ? parsed as Point[] : null;
  };
  const text64 = (s: unknown) => typeof s === 'string' ? s.slice(0, 64) : '';
  if (!Array.isArray(value.plans) || !value.plans.length || value.plans.length > MAX_PLANS) return { error: 'content' };
  const plans: LegPlan[] = [];
  for (const entry of value.plans) {
    if (!isObject(entry) || (entry.side !== 'R' && entry.side !== 'L') || !Array.isArray(entry.landmarks)) return { error: 'content' };
    const plan = newPlan(entry.side, text64(entry.name));
    for (const label of entry.landmarks) {
      if (!isObject(label) || label.name === 'hipCentre') continue;
      const name = label.name as LandmarkName;
      if (!LANDMARKS.includes(name)) continue;
      const list = points(label.points, isContour(name) ? CONTOUR_MAXIMUM : 1);
      if (!list || !list.length) return { error: 'content' };
      const provenance = Array.isArray(label.provenance) ? list.map((_, i) => label.provenance && (label.provenance as unknown[])[i] === 'moved' ? 'moved' as const : 'placed' as const) : list.map(() => 'placed' as const);
      plan.points = { ...plan.points, [name]: list }; plan.provenance = { ...plan.provenance, [name]: provenance };
    }
    const o = entry.osteotomy;
    if (isObject(o)) {
      const cut = points(o.cut, 2), hinge = point(o.hinge), fragment = points(o.fragment, 32);
      const numbers = [o.degrees, o.shiftLateral, o.shiftDistal, o.lengthen];
      if (!cut || cut.length !== 2 || !hinge || !fragment || fragment.length < 3 || !numbers.every(finite) || (o.bone !== 'femur' && o.bone !== 'tibia')
        || (o.wedge !== 'opening' && o.wedge !== 'closing') || (o.direction !== 'valgus' && o.direction !== 'varus') || Math.abs(o.degrees as number) > 45
        || numbers.slice(1).some(n => Math.abs(n) > 200)) return { error: 'content' };
      plan.osteotomy = { bone: o.bone, cut: [cut[0], cut[1]], hinge, wedge: o.wedge, degrees: Math.abs(o.degrees as number), direction: o.direction,
        shiftLateral: o.shiftLateral as number, shiftDistal: o.shiftDistal as number, lengthen: o.lengthen as number, fragment };
    }
    plans.push(plan);
  }
  let marker: Marker | null = null;
  const m = isObject(value.calibration) ? value.calibration.marker : null;
  if (isObject(m)) {
    const list = points(m.points, 8);
    if (!list || (m.method !== 'ball' && m.method !== 'ruler') || !finite(m.knownMm) || m.knownMm <= 0 || m.knownMm > 2000) return { error: 'content' };
    marker = { method: m.method, points: list, knownMm: m.knownMm, depthConfirmed: m.depthConfirmed === true, applied: false };
  }
  const active = finite(value.active) && value.active >= 0 && value.active < plans.length ? value.active : 0;
  const right = isObject(recorded) && (recorded.patientRight === 'left' || recorded.patientRight === 'right') ? recorded.patientRight : undefined;
  return { plans, active, marker, ...(right ? { patientRight: right } : {}) };
}

export { activePlan };
