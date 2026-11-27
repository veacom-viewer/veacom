import { measurementTools } from '../domain/measurementRecovery';
import { add, cross, dot, getPlaneFrame, isProjection, scale, sliceAtWorld, sliceCount, sub } from '../imaging/geometry';
import { nearestTouchpadSpeed, TOUCHPAD_SPEED } from '../imaging/interaction';
import { coveredSlice, facesSame, levelSlice, shareFrame, type Pane } from '../imaging/linking';
import { openingSlice } from '../imaging/paging';
import { petLook } from '../imaging/quantity';
import { withFilmCalibrations, type FilmCalibration, type FilmCalibrations } from '../imaging/radiograph';
import { displayWindowWidth, renderedView, usesSourceFrames } from '../imaging/viewState';
import { KEPT_STORAGE, readKept, type Kept } from '../arrangements';
import { PET_CT, PET_CT_READING, PET_FOLLOW_UP } from '../arrangements/builtin';
import type { Alignment } from '../imaging/registration';
import type { MessageKey, MessageParams } from '../i18n';
import type { Annotation, CaliperKind, Series, SuvNormalization, Tool, Vec3, ViewState, Volume, WheelAction } from '../model';
import type { deformity, FilmSelection } from './deformityStore';
import type { Side } from './preopChecklist';
import { PRESETS } from './presets';

export const SERIES_LIST_DRAG = 'application/x-veacom-series-list';

export type Panel = 'measurements' | 'display' | 'tags' | null;
/** `unfused`: this pane never shows the fusion (the plain CT beside the fused one); a new series or the fusion button in it clears it. */
export type Slot = {
  id: string;
  seriesId: string | null;
  view: ViewState;
  unfused?: boolean;
  /** While the pane shows a stack's reference image it paged to: the stack, and the view the pane had on it, for the
   * way back. */
  stack?: { id: string; view: ViewState };
};
export type MouseButton = 'left' | 'middle' | 'right';
export type Settings = {
  linked: boolean;
  panel: Panel;
  showCrosshair: boolean;
  showReferences: boolean;
  showOverlay: boolean;
  hidePatientData: boolean;
  hideMeasurements: boolean;
  showScale: boolean;
  /** The value under the pointer is written on the image: off unless the reader asks for it. */
  showPointerValue: boolean;
  mouseBindings: Partial<Record<MouseButton, Tool>>;
  wheelAction: WheelAction;
  /** How fast a touchpad pages slices; a mouse wheel always pages one a notch (src/imaging/interaction.ts). */
  touchpadSpeed: number;
  reverseWheel: boolean;
  measurementUnits: 'auto' | 'px';
  /** The SUV PET values are given in: body weight, lean body mass (SUL) or body surface area. */
  suvNormalization: SuvNormalization;
  /** Single-character shortcuts (W, S, L, 0, M, +, -...) can be turned off (WCAG 2.1.4). */
  singleKeys: boolean;
  /** Cine speed, frames a second: a whole number from 1; while a series plays, at most its slice count. */
  cineFps: number;
};

const SUV_NORMALIZATIONS: readonly SuvNormalization[] = ['bw', 'lbm', 'bsa'];
export type MenuId =
  | 'import' | 'measure' | 'layout' | 'preset' | 'mouse' | 'mouse-left' | 'mouse-middle'
  | 'mouse-right' | 'mouse-wheel' | 'slab' | 'series' | 'mpr' | 'overlay' | 'orientation'
  | 'language' | 'fusion' | null;
export type DisplaySection = 'window' | 'color' | 'orientation' | 'oblique' | 'alignment' | 'workspace' | 'units' | 'mouse';
const DISPLAY_SECTIONS: readonly DisplaySection[] = ['window', 'color', 'orientation', 'oblique', 'alignment', 'workspace', 'units', 'mouse'];
export const SECTION_STORAGE = 'veacom:inspector-sections';

export function readOpenSections(): Set<DisplaySection> {
  try {
    const stored = JSON.parse(localStorage.getItem(SECTION_STORAGE) ?? 'null');
    if (Array.isArray(stored)) return new Set(stored.filter((id): id is DisplaySection => DISPLAY_SECTIONS.includes(id)));
  } catch { /* Storage may be disabled by the host. */ }
  return new Set(['window', 'color', 'orientation', 'alignment']);
}

export type Snapshot = {
  slots: Slot[];
  annotations: Record<string, Annotation[]>;
  plans: ReturnType<typeof deformity.snapshot>;
  calibration?: FilmSelection & { value: FilmCalibration | null };
};
// A notice built from a message key is shown in the current language, and the key is its test hook.
export type Notice = {
  message: string;
  kind: 'error' | 'info';
  key?: MessageKey;
  params?: MessageParams;
  code?: string;
  /** Engine warnings, translated again when the language changes. */
  warnings?: { warnings: string[]; warningNotes?: unknown };
  /** Confirmations that need no decision clear themselves after a few seconds. */
  transient?: boolean;
  action?: { label: MessageKey; run: () => void };
};
/** How images are drawn: `software` when WebGL runs on the CPU because no usable graphics driver is available. */
export type Graphics = { renderer: string; software: boolean; webgl?: string };

export const EMPTY_ANNOTATIONS: Annotation[] = [];
export const samePoints = (a: readonly Vec3[], b: readonly Vec3[]) =>
  a.length === b.length && a.every((point, i) => point.every((value, axis) => value === b[i][axis]));
export const EMPTY_REFERENCES: { id: string; series: Series; view: ViewState }[] = [];
export const TOOLS: readonly Tool[] = [
  'scroll', 'window', 'pan', 'zoom', 'rotate', 'none', 'length', 'angle', 'cobb',
  'rectangle', 'ellipse', 'polygon', 'polyline', 'probe', 'arrow', 'text', 'crosshair', 'sphere',
];
export const WHEEL_ACTIONS: readonly WheelAction[] = ['scroll', 'zoom', 'rotate', 'none'];
/** What each mouse button can be given, as in VEAcom Next: the navigation tools, rotation, the crosshair or nothing. */
export const BUTTON_ACTIONS: readonly Tool[] = ['scroll', 'window', 'pan', 'zoom', 'rotate', 'crosshair', 'none'];
export const isTool = (value: unknown): value is Tool => typeof value === 'string' && (TOOLS as readonly string[]).includes(value);
export const MEASURE_TOOLS: readonly Tool[] = measurementTools;
// Keyboard shortcuts handled in the window keydown handler; shown in tooltips and menus.
export const TOOL_KEYS: Partial<Record<Tool, string>> = {
  scroll: 'S', window: 'W', pan: 'P', zoom: 'Z', length: 'L', angle: 'A',
  ellipse: 'E', rectangle: 'R', crosshair: 'C', text: 'T', sphere: 'V',
};
export const ROI_TOOLS: ReadonlySet<Tool> = new Set(['rectangle', 'ellipse', 'polygon']);
/** softTissue -> soft-tissue: action ids and window classes are kebab-case. */
export const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
// The engine reports progress by stage name; unknown stages are shown as reported.
export const STAGES: Partial<Record<string, MessageKey>> = {
  import: 'progressStage.import',
  indexing: 'progressStage.indexing',
  decode: 'progressStage.decode',
  'queued decode': 'progressStage.queuedDecode',
};
/** A duration as m:ss, or h:mm:ss from an hour on. */
export function clockText(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
}

export const DEFAULT_VIEW: ViewState = {
  mode: 'source', windowMode: 'dicom', plane: 'axial', slice: 0,
  windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0],
  rotation: 0, flipX: false, flipY: false, inverted: false,
};
export const makeSlot = (): Slot => ({ id: crypto.randomUUID(), seriesId: null, view: { ...DEFAULT_VIEW, pan: [0, 0] } });

/** The plane a pane shows, as its centre and normal; none for a projection or an empty pane. */
export const shownPlane = (volume: Volume | undefined, view: ViewState) => {
  if (!volume || isProjection(volume.series, view)) return null;
  const { center, normal } = getPlaneFrame(volume.series, view);
  return { center, normal };
};

/** Two views of one plane, tilted alike: they differ at most in the slice shown, and in how it is shown. */
export const sameTilt = (a: ViewState, b: ViewState) =>
  a.plane === b.plane
  && (a.mode ?? 'mpr') === (b.mode ?? 'mpr')
  && a.projection === b.projection
  && (a.oblique?.[0] ?? 0) === (b.oblique?.[0] ?? 0)
  && (a.oblique?.[1] ?? 0) === (b.oblique?.[1] ?? 0);

/** The series a list drag carries: several picked cards in the order picked, else the one dragged. */
export function draggedSeries(data: DataTransfer): string[] {
  try {
    const list: unknown = JSON.parse(data.getData(SERIES_LIST_DRAG) || 'null');
    if (Array.isArray(list) && list.length && list.every(id => typeof id === 'string')) return list;
  } catch { /* a single series */ }
  const id = data.getData('application/x-veacom-series');
  return id ? [id] : [];
}

export function sourceFrameForView(series: Series, view: ViewState): number {
  if (usesSourceFrames(series, view)) return Math.round(view.slice);
  // Metadata and frame export use the acquired slice nearest the displayed plane's centre.
  try { return sliceAtWorld(series, { ...view, mode: 'source', plane: 'axial', oblique: undefined }, getPlaneFrame(series, view).center); }
  catch { return 0; }
}

export function readSettings(): Settings {
  const defaults: Settings = {
    linked: true, panel: null, showCrosshair: true, showReferences: true,
    showOverlay: true, hidePatientData: false, hideMeasurements: false, showScale: false, showPointerValue: false,
    mouseBindings: { middle: 'pan', right: 'zoom' }, wheelAction: 'scroll', touchpadSpeed: TOUCHPAD_SPEED.default,
    reverseWheel: false, measurementUnits: 'auto', suvNormalization: 'bw', singleKeys: true, cineFps: 10,
  };
  try {
    const stored = JSON.parse(localStorage.getItem('veacom:workspace:v2') ?? 'null');
    if (!stored || typeof stored !== 'object') return defaults;
    return {
      linked: typeof stored.linked === 'boolean' ? stored.linked : defaults.linked,
      panel: ['measurements', 'display', 'tags', null].includes(stored.panel) ? stored.panel : defaults.panel,
      showCrosshair: stored.showCrosshair !== false,
      showReferences: stored.showReferences !== false,
      showOverlay: stored.showOverlay !== false,
      hidePatientData: stored.hidePatientData === true,
      hideMeasurements: stored.hideMeasurements === true,
      showScale: stored.showScale === true,
      showPointerValue: stored.showPointerValue === true,
      mouseBindings: Object.fromEntries((['left', 'middle', 'right'] as const).flatMap(button => {
        const binding = stored.mouseBindings?.[button] ?? defaults.mouseBindings[button];
        return isTool(binding) ? [[button, binding]] : [];
      })),
      wheelAction: WHEEL_ACTIONS.includes(stored.wheelAction) ? stored.wheelAction : defaults.wheelAction,
      // A wheelSensitivity saved by earlier versions is not carried over: it scaled the mouse wheel as well, against a slower touchpad.
      touchpadSpeed: nearestTouchpadSpeed(stored.touchpadSpeed),
      reverseWheel: stored.reverseWheel === true,
      measurementUnits: stored.measurementUnits === 'px' ? 'px' : 'auto',
      suvNormalization: SUV_NORMALIZATIONS.includes(stored.suvNormalization) ? stored.suvNormalization : defaults.suvNormalization,
      singleKeys: stored.singleKeys !== false,
      cineFps: Number.isInteger(stored.cineFps) && stored.cineFps >= 1 && stored.cineFps <= 100_000 ? stored.cineFps : defaults.cineFps,
    };
  } catch { return defaults; }
}

/** A series opens as VEAcom 1.x opens it: axial at the top, coronal at the front, sagittal in the middle. A PET opens as
 * PET is read: inverted grey, at SUV 0-5 when it has SUV (imaging/quantity.ts). */
export function defaultView(series: Series): ViewState {
  const slice = openingSlice(series), frame = series.frameMetadata?.[slice];
  const curve = frame?.windowWidth !== undefined ? frame.voiFunction : frame?.voiFunction ?? series.voiFunction;
  return {
    ...DEFAULT_VIEW, pan: [0, 0], slice,
    windowCenter: frame?.windowCenter ?? series.windowCenter,
    windowWidth: displayWindowWidth(frame?.windowWidth ?? series.windowWidth, curve),
    ...petLook(series),
  };
}

/** How a series opens beside a pane of another study in the comparison screen: in the same kind of view (where that
 * pane shows a reconstructed plane, with its tilt and slab, or a turning MIP, so does this one), level with it (by
 * position where the two share a frame of reference, else as far through its own stack), at its zoom and pan, and,
 * for CT beside CT, in its window: Hounsfield units are one scale, an MR's values are not. */
export function besideView(item: Series, base: ViewState, beside: Pane): ViewState {
  const theirs = beside.view, reconstructed = !usesSourceFrames(beside.series, theirs) && !usesSourceFrames(item, { mode: 'mpr' });
  const like: ViewState = reconstructed
    ? { ...base, mode: 'mpr', plane: theirs.plane, oblique: theirs.oblique ? [...theirs.oblique] : undefined, slab: theirs.slab, projection: theirs.projection }
    : base;
  const target: Pane = { series: item, view: like };
  // A MIP's slice is its turn, the same for both; a plane's is its place in the patient.
  const slice = like.projection ? theirs.slice
    : shareFrame(item, beside.series) ? sliceAtWorld(item, like, getPlaneFrame(beside.series, theirs).center)
      : facesSame(target, beside) ? levelSlice(beside, target) : reconstructed ? Math.floor(sliceCount(item, like) / 2) : base.slice;
  const oneScale = item.modality === 'CT' && beside.series.modality === 'CT';
  return {
    ...like, slice, zoom: theirs.zoom, pan: [...theirs.pan],
    ...(oneScale ? { windowCenter: theirs.windowCenter, windowWidth: theirs.windowWidth, windowMode: 'manual' as const } : {}),
  };
}

/** `view` of `item` at the place the pane `from` shows, where the two lie in one frame of reference (two series of
 * one study): a series that takes another's pane stays where the reader was. Otherwise `view` as it is. */
export function atPlaceOf(item: Series, view: ViewState, from: Pane | undefined): ViewState {
  if (!from || view.projection || !shareFrame(item, from.series) || isProjection(from.series, from.view)) return view;
  return { ...view, slice: sliceAtWorld(item, view, getPlaneFrame(from.series, from.view).center) };
}

/** The arrangements VEAcom applies, with the reader's kept ones in place of its own. */
export const PET_LAYOUTS = [
  [PET_CT, 'layout-pet-fused', 'arrangement.petCt.fused'],
  [PET_CT_READING, 'layout-pet-reading', 'arrangement.petCt.reading'],
  [PET_FOLLOW_UP, 'layout-pet-follow-up', 'arrangement.petFollowUp'],
] as const;

export function readKeptArrangements(): Kept {
  try { return readKept(localStorage.getItem(KEPT_STORAGE)); } catch { return {}; } // Storage may be disabled by the host.
}

/**
 * Projects the three-plane MPR crosshair onto the displayed planes of `crosshairSeriesId`.
 * When `snapAll` is false (paging, Undo/Redo, restoring views), projects along the normal of any plane whose
 * slice changed without changing tilt so rotating an oblique plane keeps its pivot.
 * When `snapAll` is true (a crosshair click/drag in MPR), snaps onto every displayed MPR plane covering the point
 * (solving the exact three-plane intersection when all three planes cover it) so the lines always meet at it.
 */
export function projectMprCrosshair(
  before: readonly Slot[],
  after: readonly Slot[],
  crosshair: Vec3,
  crosshairSeriesId: string | null,
  volumes: { get(id: string): Volume | undefined },
  snapAll = false,
): Vec3 {
  if (snapAll) {
    const planes: Array<{ center: Vec3; normal: Vec3 }> = [];
    for (const slot of after) {
      const volume = slot.seriesId ? volumes.get(slot.seriesId) : undefined;
      if (!volume || slot.seriesId !== crosshairSeriesId || isProjection(volume.series, slot.view)) continue;
      const covered = coveredSlice({ series: volume.series, view: slot.view }, crosshair);
      if (covered === null || covered !== Math.round(slot.view.slice)) continue;
      const { center, normal } = getPlaneFrame(volume.series, slot.view);
      planes.push({ center, normal: scale(normal, 1 / Math.max(1e-9, Math.hypot(...normal))) });
    }
    if (planes.length === 3) {
      const [p0, p1, p2] = planes;
      const c12 = cross(p1.normal, p2.normal);
      const det = dot(p0.normal, c12);
      if (Math.abs(det) > 1e-6) {
        const d0 = dot(p0.normal, p0.center);
        const d1 = dot(p1.normal, p1.center);
        const d2 = dot(p2.normal, p2.center);
        const c20 = cross(p2.normal, p0.normal);
        const c01 = cross(p0.normal, p1.normal);
        const solved = scale(add(add(scale(c12, d0), scale(c20, d1)), scale(c01, d2)), 1 / det);
        if (Math.hypot(...sub(solved, crosshair)) > 1e-9) return solved;
        return crosshair;
      }
    }
    let point = crosshair;
    for (const { center, normal } of planes) {
      const delta = dot(sub(point, center), normal);
      if (Math.abs(delta) > 1e-9) point = sub(point, scale(normal, delta));
    }
    return point;
  }

  let point = crosshair;
  for (const slot of after) {
    const was = before.find(item => item.id === slot.id)?.view;
    const volume = slot.seriesId ? volumes.get(slot.seriesId) : undefined;
    if (!was || !volume || slot.seriesId !== crosshairSeriesId || was.slice === slot.view.slice || !sameTilt(was, slot.view)) continue;
    const { center, normal } = getPlaneFrame(volume.series, slot.view);
    const unit = scale(normal, 1 / Math.max(1e-9, Math.hypot(...normal)));
    const delta = dot(sub(point, center), unit);
    if (Math.abs(delta) > 1e-9) point = sub(point, scale(unit, delta));
  }
  return point;
}

export function windowClass(volume: Volume | undefined, view: ViewState, autoWindows: Map<string, string>, slotId: string): string {
  if (!volume) return 'none';
  if (volume.series.components === 3) return 'rgb';
  const shown = renderedView(volume, view);
  if (shown.voiLut !== undefined) return 'voi-lut';
  if (view.windowMode !== 'manual') return 'stored';
  const width = Math.round(shown.windowWidth), center = Math.round(shown.windowCenter);
  const preset = PRESETS.find(item => item.width === width && item.center === center);
  if (preset) return kebab(preset.key);
  return autoWindows.get(slotId) === `${width}/${center}` ? 'auto' : 'manual';
}

/** How a volume is shown: its calibration, units and SUV, and for a PET the blood glucose typed for its study. */
type Decoration = {
  scale: number | undefined;
  films: FilmCalibrations | undefined;
  units: Settings['measurementUnits'];
  suvNormalization: SuvNormalization;
  glucose: number | undefined;
};
export const sameDecoration = (a: Decoration, b: Decoration) =>
  a.scale === b.scale && a.films === b.films && a.units === b.units && a.suvNormalization === b.suvNormalization && a.glucose === b.glucose;

export function decorateVolume(volume: Volume, { scale, films, units: measurementUnits, suvNormalization, glucose }: Decoration): Volume {
  const sourceFramesOnly = volume.series.sourceFramesOnly ?? false;
  // A film's ball or ruler outranks the series' known-length scale on that film (radiograph.ts withFilmCalibrations).
  return {
    ...volume,
    series: withFilmCalibrations(
      { ...volume.series, sourceFramesOnly, measurementScale: scale, measurementUnits, suvNormalization, typedGlucose: glucose },
      films,
    ),
  };
}

/** The colour scales' look, for the quick menu's swatches. */
export const PALETTE_SWATCHES = {
  gray: 'linear-gradient(90deg, #000, #fff)',
  hot: 'linear-gradient(90deg, #000, #c30, #fc3, #fff)',
  ge: 'linear-gradient(90deg, #000, #239, #c3c, #f93, #fff)',
  rainbow: 'linear-gradient(90deg, #00f, #0ff, #0f0, #ff0, #f00)',
} as const;
/** A pane dragged by its grip onto another: the two swap places. */
export const PANE_DRAG = 'application/x-veacom-pane';

/** A CLOSE caliper asked for from the checklist; `setUp`: the pane it turned to its plane or bone window, what that pane
 * says about it with Undo, and every pane's view before (a linked pane can move with it). */
export type CaliperRequest = {
  kind: CaliperKind;
  item: string;
  side: Side;
  study: string;
  setUp?: { slotId: string; text: string; views: Array<{ id: string; seriesId: string | null; view: ViewState }> };
};
/** A note in one pane: the DWI/ADC partner or an arrangement put there (Undo), or an offer to keep an arrangement as
 * rearranged. A sticky one stays until the reader's next action instead of a few seconds. It is about the series the
 * pane shows (`seriesId`, empty for a pane that shows none) and goes when the pane shows another. */
export type PaneToast = {
  slotId: string;
  seriesId: string;
  text: string;
  sticky?: boolean;
  alignment?: Alignment;
  onUndo?: () => void;
  undoAction?: 'pair' | 'arrangement' | 'alignment' | 'checklist-show';
  onKeep?: () => void;
  keepAction?: 'keep' | 'keep-plain';
  /** The comparison's offer to open a series' counterpart in this pane. */
  onOpen?: () => void;
};

/** Where a pane is set up to show a plane (calipers.planeView), and what it needs there; or why it cannot be. */
export type PanePlan = { slotId: string; setUp: { patch: Partial<ViewState>; plane: boolean; window: boolean } | null } | { blocked: MessageKey };
