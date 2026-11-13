// CLOSE calipers for the sinus CT checklist (src/ui/preopChecklist.ts). Each one measures one item from points the reader
// places on a coronal or sagittal plane, in any order, moved onto the nearest bone, and gives that item's answer together
// with the measurement it came from. Only geometry of a millimetre or more is answered; whether a thin wall is intact is
// left to the reader. Definitions and sources: docs/close-calipers.md.
import type { CaliperKind, CaliperTag, Plane, Series, Vec3, ViewState, Volume } from '../model';
import { add, cross, dot, isProjection, length, planeAxes, sampleVolume, scale, sliceAtWorld, sub } from './geometry';
import { translate, type Locale, type MessageKey } from '../i18n';
import { BONE_WINDOW } from '../ui/presets';

interface CaliperSpec {
  /** The measuring tool its points are placed with: two points with Length, three with Angle. */
  tool: 'length' | 'angle';
  /** The plane it is read on. */
  plane: 'coronal' | 'sagittal';
  /** For each point, in the order the result reads them (caliperOrder): whether it moves onto the nearest bone. */
  snap: readonly boolean[];
  /** What to click, point by point; the points may come in any order. */
  prompts: readonly MessageKey[];
}

export const CALIPERS: Record<CaliperKind, CaliperSpec> = {
  // The olfactory fossa's floor (the cribriform plate) and the ethmoid roof at the top of the lateral lamella (fovea
  // ethmoidalis): the height between them is the fossa's depth (Keros 1962).
  keros: { tool: 'length', plane: 'coronal', snap: [true, true], prompts: ['caliper.keros.1', 'caliper.keros.2'] },
  // The middle of the artery's canal (soft tissue, so it stays where it is clicked) and the ethmoid roof above it.
  aea: { tool: 'length', plane: 'coronal', snap: [false, true], prompts: ['caliper.aea.1', 'caliper.aea.2'] },
  // Tuberculum sellae, top of the dorsum sellae, the sphenoid sinus wall furthest back, on the midsagittal plane.
  sella: { tool: 'angle', plane: 'sagittal', snap: [true, true, true], prompts: ['caliper.sella.1', 'caliper.sella.2', 'caliper.sella.3'] },
  // Maxillary crest, crista galli (the angle's vertex), the septum's most deviated point (not moved: it may be cartilage).
  septum: { tool: 'angle', plane: 'coronal', snap: [true, true, false], prompts: ['caliper.septum.1', 'caliper.septum.2', 'caliper.septum.3'] },
};

/** The checklist items a caliper answers, by item id. */
export const ITEM_CALIPERS: Readonly<Partial<Record<string, CaliperKind>>> = { keros: 'keros', 'ethmoid-artery': 'aea', pneumatisation: 'sella', septum: 'septum' };

const SUPERIOR: Vec3 = [0, 0, 1], LEFT: Vec3 = [1, 0, 0], POSTERIOR: Vec3 = [0, 1, 0];
/** The patient axis each plane faces (LPS). */
const FACING: Record<Plane, Vec3> = { axial: SUPERIOR, coronal: POSTERIOR, sagittal: LEFT };
/** Why a series cannot be shown on a plane: it cannot be reconstructed. */
const NO_PLANE: Record<Plane, MessageKey> = { axial: 'caliper.noAxial', coronal: 'caliper.noCoronal', sagittal: 'caliper.noSagittal' };

/** A scout (CT Image Type value 3 LOCALIZER, DICOM PS3.3 C.8.2.1.1.1) is a projection: a caliper never measures on it. */
export const isLocalizer = (series: Pick<Series, 'imageType'>): boolean => /(?:^|[\\ ,])LOCALIZER(?:$|[\\ ,])/i.test(series.imageType ?? '');

/** Why a series cannot take a caliper, or null. The CLOSE measurements are defined on a CT's cross-sections: another
 * modality of the study (an MR) and a CT scout are refused, both when a caliper starts and when a drawing would become
 * one. */
export function caliperRefusal(series: Pick<Series, 'modality' | 'imageType'>): MessageKey | null {
  if (series.modality !== 'CT') return 'caliper.needsImage';
  return isLocalizer(series) ? 'caliper.localizer' : null;
}

/** A plane within 45° of `plane` (a tilted one still counts), with the patient's head up on a coronal or sagittal one.
 * `up` and `normal` are the plane's own axes (geometry.planeAxes), whatever the image's turn on screen. */
export function onPlane(plane: Plane, up: Vec3, normal: Vec3): boolean {
  return Math.abs(dot(normal, FACING[plane])) >= Math.SQRT1_2 && (plane === 'axial' || dot(up, SUPERIOR) >= Math.SQRT1_2);
}

/** A plane within 45° of the caliper's own (a tilted one still counts) whose up is the patient's head. */
export const onCaliperPlane = (kind: CaliperKind, up: Vec3, normal: Vec3): boolean => onPlane(CALIPERS[kind].plane, up, normal);

/** Whether `view` (as drawn) of `series` is a section on `plane` (onPlane), not a whole-volume projection. */
export function showsPlane(plane: Plane, series: Series, view: Pick<ViewState, 'plane' | 'mode' | 'oblique' | 'projection'>): boolean {
  if (isProjection(series, view)) return false;
  const axes = planeAxes(series, view);
  return onPlane(plane, scale(axes.v, -1), axes.normal);
}

/** Keros 1962 measured whole millimetres: type 1 is 1–3 mm, 2 is 4–7 mm, 3 is 8–16 mm. A depth is typed as Keros read
 * it, rounded to the millimetre. */
export function kerosType(depth: number): 1 | 2 | 3 {
  const rounded = Math.round(depth);
  return rounded <= 3 ? 1 : rounded <= 7 ? 2 : 3;
}
/** Within 0.5 mm of the 3–4 or 7–8 mm gaps between Keros's types: a type a measurement error (about 0.5 mm, Reuter 2026)
 * or the other usual cut (below 4, 4–8, above 8 mm) could change. */
export function nearKerosLimit(depth: number): boolean {
  return [[3, 4], [7, 8]].some(([low, high]) => depth >= low - 0.5 && depth <= high + 0.5);
}
/** El-Anwar 2021 (coronal CT, the artery's middle to the ethmoid roof): type 1 is 0–2 mm, 2 is 2–4, 3 is 4–6, 4 above 6. */
export const aeaType = (distance: number): 1 | 2 | 3 | 4 => distance < 2 ? 1 : distance < 4 ? 2 : distance < 6 ? 3 : 4;
/** At or below the skull base until 2 mm, hanging in a mesentery from there (El-Anwar's types 2 to 4). */
const AEA_BELOW_MM = 2;
/** A common grading of the septal angle, not a standard one: mild below 9°, moderate 9–15°, severe above 15°. */
export const septumGrade = (angle: number): 'mild' | 'moderate' | 'severe' => angle < 9 ? 'mild' : angle <= 15 ? 'moderate' : 'severe';
/** Below this angle the septum is read as on the midline: its side would be noise. */
const MIDLINE_DEGREES = 1;
/** Within this distance of a type limit or a sella line, the answer is marked as near it. */
const LIMIT_MM = 0.5;

type CaliperReading =
  | { kind: 'keros'; depth: number; type: 1 | 2 | 3; nearLimit: boolean }
  | { kind: 'aea'; distance: number; type: 1 | 2 | 3 | 4; nearLimit: boolean }
  /** `behind`: mm from the tuberculum line backwards (negative in front of it); `span`: tuberculum line to dorsum line. */
  | { kind: 'sella'; position: 'anterior' | 'sellar' | 'postsellar'; behind: number; span: number; nearLimit: boolean }
  | { kind: 'septum'; angle: number; side: 'right' | 'left' | null; grade: 'mild' | 'moderate' | 'severe' };
type CaliperSide = CaliperTag['side'];
/** What a caliper gives: its reading, the side it is for and the checklist answer it implies (none where it cannot tell:
 * a sinus in front of the tuberculum line may be presellar or conchal, an artery at the skull base may still be
 * dehiscent), or why it gives nothing. */
export type CaliperResult = { reading: CaliperReading; side: CaliperSide; answer?: string } | { unavailable: MessageKey; side: CaliperSide };

/** Millimetres per patient millimetre for a caliper: a calibration's factor, 1 where the pixel spacing is known, else
 * null (never a guess: the caliper is then unavailable). */
export function caliperMmScale(series: Pick<Series, 'measurementScale' | 'spacingKnown'>): number | null {
  const factor = series.measurementScale;
  if (factor !== undefined && Number.isFinite(factor) && factor > 0) return factor;
  return series.spacingKnown === true ? 1 : null;
}

const degrees = (a: Vec3, b: Vec3) => {
  const lengths = length(a) * length(b);
  return lengths > 1e-12 ? Math.acos(Math.min(1, Math.max(-1, dot(a, b) / lengths))) * 180 / Math.PI : NaN;
};

/** A caliper's points in the order its result reads them, whatever order they were clicked in: each landmark is known by
 * its height on the plane (`up`). Keros and the artery: the lower point (the fossa's floor, the artery) first. The sella
 * lines: the sinus wall, below the sella, last. The septum: the maxillary crest (the lowest), the crista galli (the
 * highest), then the deviated point between them. */
export function caliperOrder(kind: CaliperKind, points: readonly Vec3[], up: Vec3): Vec3[] {
  const byHeight = [...points].sort((a, b) => dot(a, up) - dot(b, up));
  if (kind === 'keros' || kind === 'aea') return byHeight;
  if (points.length !== 3) return [...points];
  if (kind === 'septum') return [byHeight[0], byHeight[2], byHeight[1]];
  // The tuberculum and the dorsum keep their order: the result tells them apart from front to back.
  return [...points.filter(point => point !== byHeight[0]), byHeight[0]];
}

/** What the caliper's points (patient mm, in any order) give. `mmScale`: millimetres per patient millimetre (1, or a
 * calibration's factor), null when the image's pixel spacing is unknown. */
export function caliperResult(tag: CaliperTag, clicked: readonly Vec3[], mmScale: number | null): CaliperResult {
  const side = tag.side, spec = CALIPERS[tag.kind];
  const unavailable = (key: MessageKey): CaliperResult => ({ unavailable: key, side });
  if (mmScale === null || !Number.isFinite(mmScale) || mmScale <= 0) return unavailable('caliper.noSpacing');
  if (!onCaliperPlane(tag.kind, tag.up, tag.normal)) return unavailable(spec.plane === 'coronal' ? 'caliper.notCoronal' : 'caliper.notSagittal');
  if (clicked.length !== spec.snap.length || !clicked.every(point => point.every(Number.isFinite))) return unavailable('caliper.incomplete');
  const mm = (value: number) => value * mmScale, points = caliperOrder(tag.kind, clicked, tag.up);
  if (tag.kind === 'keros') {
    const [floor, roof] = points;
    const depth = mm(dot(sub(roof, floor), tag.up));
    if (!(depth > 0)) return unavailable('caliper.sameHeight');
    const type = kerosType(depth);
    return { reading: { kind: 'keros', depth, type, nearLimit: nearKerosLimit(depth) }, side, answer: String(type) };
  }
  if (tag.kind === 'aea') {
    const [artery, roof] = points;
    const distance = mm(dot(sub(roof, artery), tag.up));
    const reading = { kind: 'aea' as const, distance, type: aeaType(distance), nearLimit: Math.abs(distance - AEA_BELOW_MM) <= LIMIT_MM };
    return { reading, side, ...(distance >= AEA_BELOW_MM ? { answer: 'yes' } : {}) };
  }
  if (tag.kind === 'sella') {
    // The lines run through the tuberculum and the dorsum, square to the line joining them (Güldner 2012), whichever
    // of the two was clicked first.
    const [first, second, wall] = points;
    const [tuberculum, dorsum] = dot(first, POSTERIOR) <= dot(second, POSTERIOR) ? [first, second] : [second, first];
    const axis = sub(dorsum, tuberculum), span = length(axis);
    if (mm(span) < 2) return unavailable('caliper.sellaShort');
    const behind = mm(dot(sub(wall, tuberculum), axis) / span), spanMm = mm(span);
    const position = behind < 0 ? 'anterior' as const : behind <= spanMm ? 'sellar' as const : 'postsellar' as const;
    const reading = { kind: 'sella' as const, position, behind, span: spanMm, nearLimit: Math.min(Math.abs(behind), Math.abs(behind - spanMm)) <= LIMIT_MM };
    return { reading, side: 'both', ...(position === 'anterior' ? {} : { answer: position }) };
  }
  const [crest, crista, deviated] = points;
  // The crista galli is the angle's vertex, above the crest.
  if (!(dot(sub(crista, crest), tag.up) > 0)) return unavailable('caliper.sameHeight');
  const midline = sub(crest, crista), toward = sub(deviated, crista);
  const angle = degrees(midline, toward);
  if (!Number.isFinite(angle)) return unavailable('caliper.incomplete');
  // The side the septum bows to: the deviated point's offset from the crista galli–crest line, in the patient's left.
  const along = scale(midline, dot(toward, midline) / Math.max(1e-12, dot(midline, midline)));
  const leftward = dot(sub(toward, along), LEFT);
  const bowed = angle < MIDLINE_DEGREES ? null : leftward > 0 ? 'left' as const : 'right' as const;
  return { reading: { kind: 'septum', angle, side: bowed, grade: septumGrade(angle) }, side: bowed ?? side, ...(bowed ? { answer: 'yes' } : {}) };
}

/** Bone, in HU: thin skull-base plates read lower than cortical bone through partial volume, so the bound is low. */
const BONE_HU = 200;
/** How far a point may move onto bone, mm. */
const SNAP_RADIUS_MM = 2;
const SNAP_STEP_MM = 0.1;
/** Offsets in the plane within the radius, nearest first: the first one on bone is the nearest bone. */
const SNAP_OFFSETS: Array<[number, number]> = (() => {
  const steps = Math.round(SNAP_RADIUS_MM / SNAP_STEP_MM), offsets: Array<[number, number, number]> = [];
  for (let i = -steps; i <= steps; i++) for (let j = -steps; j <= steps; j++) {
    const distance = Math.hypot(i, j) * SNAP_STEP_MM;
    if (distance <= SNAP_RADIUS_MM + 1e-9) offsets.push([i * SNAP_STEP_MM, j * SNAP_STEP_MM, distance]);
  }
  return offsets.sort((a, b) => a[2] - b[2]).map(([a, b]) => [a, b]);
})();

/** `point` moved within its plane (spanned by `u` and `v`) onto the nearest bone within SNAP_RADIUS_MM: the nearest place
 * whose interpolated value is BONE_HU or more, to 0.1 mm. Unchanged when no bone is that near, or when the image is not
 * in HU. Only the point moves; the pixels are read, never changed. */
export function snapToBone(volume: Volume, point: Vec3, u: Vec3, v: Vec3): Vec3 {
  if (volume.series.valueUnit !== 'HU' || volume.series.components === 3) return point;
  for (const [a, b] of SNAP_OFFSETS) {
    const candidate = add(point, add(scale(u, a), scale(v, b)));
    const value = sampleVolume(volume, candidate, true);
    if (value !== null && Number.isFinite(value) && value >= BONE_HU) return candidate;
  }
  return point;
}

/** What a pane showing `view` (as drawn) of `series` needs to show `plane` in the bone window, as a view patch: the plane,
 * plain and through `at` (the picked point, or the pane's middle), unless the pane is on that plane already, when its
 * slice and tilt stay; and the bone window, unless its window already reaches as wide and as high (a CT in HU only). Null
 * when nothing needs to change; `blocked` when the series cannot be shown on that plane. */
export function planeView(plane: Plane, series: Series, view: ViewState, at: Vec3, canReconstruct: boolean):
  { patch: Partial<ViewState>; plane: boolean; window: boolean } | { blocked: MessageKey } | null {
  const turn = !showsPlane(plane, series, view);
  if (turn && !canReconstruct) return { blocked: NO_PLANE[plane] };
  const target = { plane, mode: 'mpr' as const, oblique: [0, 0] as [number, number], projection: undefined };
  const window = series.valueUnit === 'HU' && !(view.windowWidth >= BONE_WINDOW.width && view.windowCenter >= BONE_WINDOW.center);
  if (!turn && !window) return null;
  return { plane: turn, window, patch: {
    ...(turn ? { ...target, slice: sliceAtWorld(series, target, at) } : {}),
    ...(window ? { windowWidth: BONE_WINDOW.width, windowCenter: BONE_WINDOW.center, windowMode: 'manual' as const } : {}),
  } };
}

/** What a pane needs before a caliper can measure in it: its plane in the bone window (planeView). */
export const caliperView = (kind: CaliperKind, series: Series, view: ViewState, at: Vec3, canReconstruct: boolean) =>
  planeView(CALIPERS[kind].plane, series, view, at, canReconstruct);

/** The caliper's points in the order its result reads them (caliperOrder), moved onto bone where its definition says so,
 * within the plane (`up`, `normal`) they lie in. */
export function snapCaliper(kind: CaliperKind, volume: Volume, points: readonly Vec3[], up: Vec3, normal: Vec3): Vec3[] {
  const across = cross(up, normal);
  return caliperOrder(kind, points, up).map((point, index) => CALIPERS[kind].snap[index] ? snapToBone(volume, point, up, across) : point);
}

const one = (value: number) => value.toFixed(1);
const sideWord = (side: CaliperSide, locale: Locale) => side === 'both' ? '' : translate(locale, side === 'right' ? 'caliper.right' : 'caliper.left');

/** The caliper's name, as the checklist and the measurement list give it. */
export const caliperName = (kind: CaliperKind, locale: Locale) => translate(locale, `caliper.name.${kind}`);

/** The measurement in full: what the label beside the drawing and the measurement list show. */
export function caliperLabel(tag: CaliperTag, result: CaliperResult, locale: Locale): string {
  if ('unavailable' in result) return `${caliperName(tag.kind, locale)} · ${translate(locale, result.unavailable)}`;
  const reading = result.reading, words = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params);
  if (reading.kind === 'keros') return [words('caliper.kerosDepth', { side: sideWord(result.side, locale), value: one(reading.depth) }),
    `${words('caliper.type', { type: reading.type })}${reading.nearLimit ? `, ${words('caliper.nearLimit')}` : ''}`].join(' · ');
  if (reading.kind === 'aea') return [words('caliper.aeaDistance', { side: sideWord(result.side, locale), value: one(reading.distance) }),
    `${words('caliper.type', { type: reading.type })}${reading.nearLimit ? `, ${words('caliper.nearLimit')}` : ''}`].join(' · ');
  if (reading.kind === 'sella') return [caliperName('sella', locale), words(`caliper.sella.${reading.position}`), `${sellaOffset(reading, locale)}${reading.nearLimit ? `, ${words('caliper.nearLimit')}` : ''}`].join(' · ');
  return `${septumSide(reading, locale)} · ${words(`caliper.grade.${reading.grade}`)}`;
}

/** The measurement as the report gives it after the item's answer, which it does not repeat: "3.5 mm, type 2, near
 * limit". */
export function caliperReport(result: CaliperResult, locale: Locale): string {
  if ('unavailable' in result) return translate(locale, result.unavailable);
  const reading = result.reading, words = (key: MessageKey, params?: Record<string, string | number>) => translate(locale, key, params);
  const near = (nearLimit: boolean) => nearLimit ? `, ${words('caliper.nearLimit')}` : '';
  if (reading.kind === 'keros') return `${one(reading.depth)} mm, ${words('caliper.type', { type: reading.type })}${near(reading.nearLimit)}`;
  if (reading.kind === 'aea') return `${words('caliper.aeaBelow', { value: one(reading.distance) })}, ${words('caliper.type', { type: reading.type })}${near(reading.nearLimit)}`;
  // In front of the tuberculum line the caliper gives no answer, so the report says what it may be.
  if (reading.kind === 'sella') return `${reading.position === 'anterior' ? `${words('caliper.sella.anterior')}, ` : ''}${sellaOffset(reading, locale)}${near(reading.nearLimit)}`;
  return reading.side ? `${one(reading.angle)}°, ${words(`caliper.grade.${reading.grade}`)}` : septumSide(reading, locale);
}

/** The measurement in a few words, for the checklist's side cell. */
export function caliperShort(result: CaliperResult, locale: Locale): string {
  if ('unavailable' in result) return translate(locale, 'caliper.unavailable');
  const reading = result.reading;
  if (reading.kind === 'keros') return `${one(reading.depth)} mm`;
  if (reading.kind === 'aea') return `${one(reading.distance)} mm`;
  if (reading.kind === 'sella') return sellaOffset(reading, locale);
  return `${one(reading.angle)}° · ${translate(locale, `caliper.grade.${reading.grade}`)}`;
}

function sellaOffset(reading: Extract<CaliperReading, { kind: 'sella' }>, locale: Locale): string {
  if (reading.position === 'anterior') return translate(locale, 'caliper.sellaInFront', { value: one(-reading.behind) });
  if (reading.position === 'sellar') return translate(locale, 'caliper.sellaBehindTuberculum', { value: one(reading.behind) });
  return translate(locale, 'caliper.sellaBehindDorsum', { value: one(reading.behind - reading.span) });
}

function septumSide(reading: Extract<CaliperReading, { kind: 'septum' }>, locale: Locale): string {
  const key = reading.side === 'right' ? 'caliper.septumRight' : reading.side === 'left' ? 'caliper.septumLeft' : 'caliper.septumMidline';
  return translate(locale, key, { value: one(reading.angle) });
}
