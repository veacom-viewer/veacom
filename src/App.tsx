import { studyKey } from './domain/patient';
import { lazy, Suspense, useEffect, useEffectEvent, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ChevronRight, Circle, CircleHelp, Columns3, Contrast, Crosshair, FileArchive, Files, FlipHorizontal2,
  FlipVertical2, FolderOpen, Globe, Hexagon, Languages, Layers, Link2, List, LoaderCircle, Maximize2, MessageSquare, Minimize2,
  GripVertical, Move, MoveUpRight, PanelRightClose, PanelRightOpen, Pause, Pipette, Play, Plus, Radius, Redo2, RotateCcw, RotateCcwSquare, RotateCwSquare,
  Ruler, ScanText, Stethoscope, SlidersHorizontal, Spline, Square, Tag, Trash2, TriangleRight, Type, Undo2, Upload, X, ZoomIn,
} from './components/icons';
import { ASSESSMENT_AVAILABLE } from './domain/clinical';
import { bridgeCan, importEarly, importPaths, listSeries, loadVolume, getProgress, cancelOperation, registerSeries, removeSeries } from './api';
import { PICK_MEASUREMENT, Viewport } from './components/Viewport';
import { PetAcquisitionPanel } from './components/PetAcquisitionPanel';
import { panelPet } from './imaging/petAcquisition';
import { forgetThumbnail, hasThumbnail, keepThumbnail, SeriesBrowser, SeriesMenuItems, SERIES_LIST_DRAG, thumbnailFrame } from './components/SeriesBrowser';
import { SliceBar } from './components/SliceBar';
import { Inspector } from './components/Inspector';
import { CineSpeed } from './components/CineSpeed';
import { openingSlice, pageStep, pagesBackwards } from './imaging/paging';
import { advanceCine } from './imaging/cine';
import { acquiredPlane, autoWindow, fullRangeWindow, getPlaneFrame, indexToWorld, isProjection, projectionAngle, reconstructedWindow, sliceAtWorld, sliceCount, stepSlice } from './imaging/geometry';
import { labelVolume, maskFrames, segmentationApplies, segmentationCenter } from './imaging/segmentation';
import { clearSliceTextureCache, prepareSourceProgram, sliceRenderer, sourceFrameOnly, type RendererInfo } from './imaging/sliceRenderer';
import { isSoftwareWebglStatus } from './imaging/rendererInfo';
import { patchView, renderedView, resolveView, usesSourceFrames } from './imaging/viewState';
import { SourceFrameCache } from './sourceFrames';
import { useEngineRecovery } from './useEngineRecovery';
import { captureViewportCanvas, captureViewportPng } from './export-video';
import { copyCanvas } from './ui/clipboard';
import type { ExportDialogProps } from './components/ExportDialog';
import { trimInactiveVolumes } from './domain/volumeCache';
import { createVolumeDecorator } from './domain/decoratedVolumes';
import { measureWindow } from './imaging/nativeMeasurements';
import { annotationSourceIndex, distanceMm, quantitativeScale, shownOnView, storedUnit, viewOfAnnotation } from './imaging/annotations';
import { obliqueAngle } from './imaging/oblique';
import { sphereOf } from './imaging/voi';
import { clearEditedScores } from './imaging/deauvilleReading';
import { SphereDetails } from './components/SphereDetails';
import { usePetRecords, usePetStudies } from './imaging/usePetStudies';
import { WarningBox } from './components/WarningBox';
import { compared, comparisonFlags, comparisonKey, comparisonText, keptCompared, type PetPrior } from './imaging/petComparison';
import { nameLesions } from './imaging/lesions';
import { LesionTable } from './components/LesionTable';
import { PetReportCopy } from './components/PetReportCopy';
import { priorLesions } from './imaging/priorLesions';
import { useAnnotationSummary } from './imaging/useAnnotationSummary';
import type { Annotation, FusionSettings, Plane, SegmentationOverlay, Series, SuvNormalization, Tool, Vec3, ViewState, Volume, WheelAction } from './model';
import { chooseLocale, errorMessage, LOCALES, t, type MessageKey, type MessageParams } from './i18n';
import { useTranslation } from './i18n/react';
import { warningTexts } from './i18n/core';
import { Glyph, MouseGlyph, SlabGlyph, TOOL_GLYPHS, WHEEL_GLYPHS } from './components/Glyph';
import { LayoutIcon, LayoutPicker, Menu, MenuChevron, MenuDivider, MenuHeading, MenuItem, Popover, Toolbar, ToolButton } from './components/Toolbar';
import type { ToolbarItem } from './components/Toolbar';
import { usage, type Surface, type UsageSnapshot } from './usage/tracker';
import { installUsageListeners } from './usage/actions';
import { TooltipLayer } from './components/Tooltip';
import { modifierKey, presetFor, PRESETS } from './ui/presets';
import { anchorFor, coveredSlice, facesSame, inStep, linkedSlice, pairKey, placed, samePatient, shareFrame, sharePlaneSpace, type Anchor, type Pane } from './imaging/linking';
import { adjusted, alignedFusion, alignedTransform, alignmentFrom, alignmentOf, automatic, frameOf, mapPoint, movement, nudged, nudgeStep, transformBetween, withAlignment, withoutAlignment, type Alignment, type Nudge } from './imaging/registration';
import { applyPoint, IDENTITY } from './imaging/rigid';
import { AlignmentSection } from './components/AlignmentSection';
import { contrastPair, DEVICE_LOOKS, deviceMaker, fusesAsOverlay, fusesOver, isEmission, mrPartner, SPECT_LOOK } from './imaging/fusion';
import { activeStudyContext, alignmentPair, deriveKept, findRole, KEPT_STORAGE, match, matchOnOpen, paneView, sharesSuvScale, readKept, withKept, type Kept, type KeptVariant, type Plan } from './arrangements';
import { BUILTIN_ARRANGEMENTS, FUSION, NUCLEAR_MEDICINE_SCREENS, PET_CT, PET_CT_READING, PET_FOLLOW_UP } from './arrangements/builtin';
import { petLook, quantityScale, sameRangeWindow, SUV_PRESETS, suvPresetFor, suvWindowText, windowFor } from './imaging/quantity';
import { fusionScaleMaxKey, petHasSuv } from './imaging/fusion';
import { DEFAULT_SLAB_THICKNESS, SLAB_MODES, SLAB_THICKNESSES, type SlabMode } from './imaging/slab';
import { nextIndex } from './ui/navigation';
import { seriesName } from './ui/seriesNames';
import { withFound, withImported } from './ui/seriesOrder';
// Tokens first: component rules in styles.css must win over the shared ones at equal specificity.
import './theme.css';
import './styles.css';

const ExportDialog = lazy(() => import('./components/ExportDialog').then(module => ({ default: module.ExportDialog })));
const UpdateDialog = lazy(() => import('./components/UpdateDialog').then(module => ({ default: module.UpdateDialog })));
const HelpDialog = lazy(() => import('./components/HelpDialog').then(module => ({ default: module.HelpDialog })));
const FeedbackDialog = lazy(() => import('./components/FeedbackDialog').then(module => ({ default: module.FeedbackDialog })));
const VolumeView = lazy(() => import('./components/VolumeView').then(module => ({ default: module.VolumeView })));
const PreopChecklist = lazy(() => import('./components/PreopChecklist').then(module => ({ default: module.PreopChecklist })));
const AssessmentPanel = lazy(() => import('./components/AssessmentPanel').then(module => ({ default: module.AssessmentPanel })));

type Panel = 'measurements' | 'display' | 'tags' | null;
/** `unfused`: this pane never shows the fusion (the plain CT beside the fused one); a new series or the fusion button in it clears it. */
type Slot = { id: string; seriesId: string | null; view: ViewState; unfused?: boolean };
type MouseButton = 'left' | 'middle' | 'right';
type Settings = { linked: boolean; panel: Panel; showCrosshair: boolean; showReferences: boolean;
  showOverlay: boolean; hidePatientData: boolean; hideMeasurements: boolean; showScale: boolean;
  mouseBindings: Partial<Record<MouseButton, Tool>>; wheelAction: WheelAction; wheelSensitivity: number; reverseWheel: boolean; measurementUnits: 'auto' | 'px';
  /** The SUV PET values are given in: body weight, lean body mass (SUL) or body surface area. */ suvNormalization: SuvNormalization;
  /** Single-character shortcuts (W, S, L, 0, M, +, −…) can be turned off (WCAG 2.1.4). */ singleKeys: boolean;
  /** Cine speed, frames a second: a whole number from 1; while a series plays, at most its slice count. */ cineFps: number };
const SUV_NORMALIZATIONS: readonly SuvNormalization[] = ['bw', 'lbm', 'bsa'];
type Menu = 'import' | 'measure' | 'layout' | 'preset' | 'mouse' | 'mouse-left' | 'mouse-middle' | 'mouse-right' | 'mouse-wheel' | 'slab' | 'series' | 'mpr' | 'overlay' | 'orientation' | 'language' | 'fusion' | null;
type DisplaySection = 'window' | 'color' | 'orientation' | 'oblique' | 'alignment' | 'workspace' | 'units' | 'mouse';
const DISPLAY_SECTIONS: readonly DisplaySection[] = ['window', 'color', 'orientation', 'oblique', 'alignment', 'workspace', 'units', 'mouse'];
const SECTION_STORAGE = 'veacom:inspector-sections';
function readOpenSections(): Set<DisplaySection> {
  try {
    const stored = JSON.parse(localStorage.getItem(SECTION_STORAGE) ?? 'null');
    if (Array.isArray(stored)) return new Set(stored.filter((id): id is DisplaySection => DISPLAY_SECTIONS.includes(id)));
  } catch { /* Storage may be disabled by the host. */ }
  return new Set(['window', 'color', 'orientation', 'alignment']);
}
type Snapshot = { slots: Slot[]; annotations: Record<string, Annotation[]> };
// A notice built from a message key is shown in the current language, and the key is its test hook.
type Notice = { message: string; kind: 'error' | 'info'; key?: MessageKey; params?: MessageParams; code?: string;
  /** Engine warnings, translated again when the language changes. */
  warnings?: { warnings: string[]; warningNotes?: unknown };
  /** Confirmations that need no decision clear themselves after a few seconds. */
  transient?: boolean; action?: { label: MessageKey; run: () => void } };
/** How images are drawn: `software` when WebGL runs on the CPU because no usable graphics driver is available. */
type Graphics = { renderer: string; software: boolean; webgl?: string };

const EMPTY_ANNOTATIONS: Annotation[] = [];
const EMPTY_REFERENCES: { id: string; series: Series; view: ViewState }[] = [];
const TOOLS: readonly Tool[] = ['scroll', 'window', 'pan', 'zoom', 'rotate', 'none', 'length', 'angle', 'cobb', 'rectangle', 'ellipse', 'polygon', 'polyline', 'probe', 'arrow', 'text', 'crosshair', 'sphere'];
const WHEEL_ACTIONS: readonly WheelAction[] = ['scroll', 'zoom', 'rotate', 'none'];
/** What each mouse button can be given, as in VEAcom Next: the navigation tools, rotation, the crosshair or nothing. */
const BUTTON_ACTIONS: readonly Tool[] = ['scroll', 'window', 'pan', 'zoom', 'rotate', 'crosshair', 'none'];
const isTool = (value: unknown): value is Tool => typeof value === 'string' && (TOOLS as readonly string[]).includes(value);
const MEASURE_TOOLS: Tool[] = ['length', 'angle', 'cobb', 'rectangle', 'ellipse', 'polygon', 'polyline', 'sphere', 'probe', 'arrow', 'text'];
// Keyboard shortcuts handled in the window keydown handler below; shown in tooltips and menus.
const TOOL_KEYS: Partial<Record<Tool, string>> = { scroll: 'S', window: 'W', pan: 'P', zoom: 'Z', length: 'L', angle: 'A', ellipse: 'E', rectangle: 'R', crosshair: 'C', text: 'T', sphere: 'V' };
const MEASURE_ICONS: Partial<Record<Tool, typeof Ruler>> = { length: Ruler, angle: TriangleRight, cobb: Radius, rectangle: Square, ellipse: Circle, polygon: Hexagon, polyline: Spline, sphere: Globe, probe: Pipette, arrow: MoveUpRight, text: Type };
/** A measurement's icon; on the toolbar a region gets a small "ROI" tag, so it is not taken for the layout button. */
const ROI_TOOLS: ReadonlySet<Tool> = new Set(['rectangle', 'ellipse', 'polygon']);
const measureIcon = (tool: Tool, size = 18, tagged = false) => { const Icon = MEASURE_ICONS[tool] ?? Ruler; return tagged && ROI_TOOLS.has(tool) ? <span className="tool-icon-tagged"><Icon size={size} /><span className="tool-icon-tag">ROI</span></span> : <Icon size={size} />; };
/** softTissue → soft-tissue: action ids and window classes are kebab-case. */
const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
// The engine reports progress by stage name; unknown stages are shown as reported.
const STAGES: Partial<Record<string, MessageKey>> = { import: 'progressStage.import', indexing: 'progressStage.indexing', decode: 'progressStage.decode', 'queued decode': 'progressStage.queuedDecode' };
const DEFAULT_VIEW: ViewState = { mode: 'source', windowMode: 'dicom', plane: 'axial', slice: 0, windowCenter: 40, windowWidth: 400, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false };
const makeSlot = (): Slot => ({ id: crypto.randomUUID(), seriesId: null, view: { ...DEFAULT_VIEW, pan: [0, 0] } });
/** The series a list drag carries: several picked cards in the order picked, else the one dragged. */
function draggedSeries(data: DataTransfer): string[] {
  try {
    const list: unknown = JSON.parse(data.getData(SERIES_LIST_DRAG) || 'null');
    if (Array.isArray(list) && list.length && list.every(id => typeof id === 'string')) return list;
  } catch { /* a single series */ }
  const id = data.getData('application/x-veacom-series');
  return id ? [id] : [];
}
const errorText = errorMessage;

function sourceFrameForView(series: Series, view: ViewState): number {
  if (usesSourceFrames(series, view)) return Math.round(view.slice);
  // Metadata and frame export use the acquired slice nearest the displayed plane's centre.
  try { return sliceAtWorld(series, { ...view, mode: 'source', plane: 'axial', oblique: undefined }, getPlaneFrame(series, view).center); }
  catch { return 0; }
}

async function writeUsageConsent(value: 'granted' | 'denied') {
  const status = await window.veacom?.usageConsent?.(value);
  return status?.consent ?? null;
}

async function saveBytes(name: string, bytes: ArrayBuffer | string) {
  if (window.veacom) return window.veacom.saveFile(name, bytes);
  const blob = new Blob([bytes]), url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return name;
}

async function captureImage(element: HTMLElement, kind: 'png' | 'jpeg') {
  let bytes = await captureViewportPng(element);
  if (kind === 'jpeg') {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error(t('notice.imageNotCreated'));
    context.drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
    if (!blob) throw new Error(t('notice.imageNotCreated')); bytes = await blob.arrayBuffer();
  }
  return bytes;
}

/** After a control removes itself, focus goes to the first of these that exists (never to <body>). */
function focusSoon(...selectors: string[]) {
  requestAnimationFrame(() => {
    for (const selector of selectors) { const element = document.querySelector<HTMLElement>(selector); if (element && !element.closest('[inert]')) { element.focus(); return; } }
  });
}
const focusImage = () => focusSoon('.viewport-cell.is-active [data-testid="dicom-viewport"]', '.viewport-cell.is-active', '[data-testid="tool-open"]');

function readSettings(): Settings {
  const defaults: Settings = { linked: true, panel: null, showCrosshair: true, showReferences: true,
    showOverlay: true, hidePatientData: false, hideMeasurements: false, showScale: false,
    mouseBindings: { middle: 'pan', right: 'zoom' }, wheelAction: 'scroll', wheelSensitivity: 1, reverseWheel: false, measurementUnits: 'auto',
    suvNormalization: 'bw', singleKeys: true, cineFps: 10 };
  try {
    const stored = JSON.parse(localStorage.getItem('veacom:workspace:v2') ?? 'null');
    if (!stored || typeof stored !== 'object') return defaults;
    return {
      linked: typeof stored.linked === 'boolean' ? stored.linked : defaults.linked,
      panel: ['measurements', 'display', 'tags', null].includes(stored.panel) ? stored.panel : defaults.panel,
      showCrosshair: stored.showCrosshair !== false,
      showReferences: stored.showReferences !== false,
      showOverlay: stored.showOverlay !== false, hidePatientData: stored.hidePatientData === true, hideMeasurements: stored.hideMeasurements === true, showScale: stored.showScale === true,
      mouseBindings: Object.fromEntries((['left', 'middle', 'right'] as const).flatMap(button => {
        const binding = stored.mouseBindings?.[button] ?? defaults.mouseBindings[button];
        return isTool(binding) ? [[button, binding]] : [];
      })),
      wheelAction: WHEEL_ACTIONS.includes(stored.wheelAction) ? stored.wheelAction : defaults.wheelAction,
      wheelSensitivity: Number.isFinite(stored.wheelSensitivity) ? Math.max(0.2, Math.min(5, stored.wheelSensitivity)) : 1,
      reverseWheel: stored.reverseWheel === true,
      measurementUnits: stored.measurementUnits === 'px' ? 'px' : 'auto',
      suvNormalization: SUV_NORMALIZATIONS.includes(stored.suvNormalization) ? stored.suvNormalization : defaults.suvNormalization,
      singleKeys: stored.singleKeys !== false,
      cineFps: Number.isInteger(stored.cineFps) && stored.cineFps >= 1 && stored.cineFps <= 100_000 ? stored.cineFps : defaults.cineFps,
    };
  } catch { return defaults; }
}

/** A series opens as VEAcom 1.x opens it: axial at the top, coronal at the front, sagittal in the middle. A PET opens as
 * PET is read: inverted grey, at SUV 0–5 when it has SUV (imaging/quantity.ts). */
function defaultView(series: Series): ViewState {
  const slice = openingSlice(series), frame = series.frameMetadata?.[slice];
  return { ...DEFAULT_VIEW, pan: [0, 0], slice, windowCenter: frame?.windowCenter ?? series.windowCenter,
    windowWidth: Math.max(1, frame?.windowWidth ?? series.windowWidth), ...petLook(series) };
}
/** The arrangements VEAcom applies, with the reader's kept ones in place of its own. */
const PET_LAYOUTS = [
  [PET_CT, 'layout-pet-fused', 'arrangement.petCt.fused'],
  [PET_CT_READING, 'layout-pet-reading', 'arrangement.petCt.reading'],
  [PET_FOLLOW_UP, 'layout-pet-follow-up', 'arrangement.petFollowUp'],
] as const;
function readKeptArrangements(): Kept {
  try { return readKept(localStorage.getItem(KEPT_STORAGE)); } catch { return {}; } // Storage may be disabled by the host.
}

function windowClass(volume: Volume | undefined, view: ViewState, autoWindows: Map<string, string>, slotId: string): string {
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
type Decoration = { scale: number | undefined; units: Settings['measurementUnits']; suvNormalization: SuvNormalization; glucose: number | undefined };
const sameDecoration = (a: Decoration, b: Decoration) => a.scale === b.scale && a.units === b.units && a.suvNormalization === b.suvNormalization && a.glucose === b.glucose;
function decorateVolume(volume: Volume, { scale, units: measurementUnits, suvNormalization, glucose }: Decoration): Volume {
  let sourceFramesOnly = false;
  try { sourceFramesOnly = sourceFrameOnly(volume); } catch { /* The viewport reports an unavailable GPU. */ }
  return { ...volume, series: { ...volume.series, sourceFramesOnly, measurementScale: scale, measurementUnits, suvNormalization, typedGlucose: glucose } };
}

// `testId` gives the scripted desktop checks (tools/*.cjs) a hook that does not depend on the language.

/** One collapsible group in the display panel (accordion pattern: heading + button + region). */
function PanelSection({ id, title, open, onToggle, children }: { id: DisplaySection; title: string; open: boolean; onToggle: (id: DisplaySection) => void; children: ReactNode }) {
  return <section className={`panel-section${open ? ' is-open' : ''}`} data-section={id}>
    <h3 className="panel-section-title"><button type="button" aria-expanded={open} aria-controls={`section-${id}`} id={`section-${id}-toggle`} onClick={() => onToggle(id)}>
      <ChevronRight size={14} className="section-chevron" aria-hidden="true" /><span>{title}</span></button></h3>
    <div className="panel-section-body" id={`section-${id}`} role="region" aria-labelledby={`section-${id}-toggle`} hidden={!open}>{children}</div>
  </section>;
}

/** The colour scales' look, for the quick menu's swatches. */
const PALETTE_SWATCHES = { gray: 'linear-gradient(90deg, #000, #fff)', hot: 'linear-gradient(90deg, #000, #c30, #fc3, #fff)', ge: 'linear-gradient(90deg, #000, #239, #c3c, #f93, #fff)', rainbow: 'linear-gradient(90deg, #00f, #0ff, #0f0, #ff0, #f00)' } as const;
/** A pane dragged by its grip onto another: the two swap places. */
const PANE_DRAG = 'application/x-veacom-pane';

/** A note in one pane: the DWI/ADC partner or an arrangement put there (Undo), or an offer to keep an arrangement as
 * rearranged. A sticky one stays until the reader's next action instead of a few seconds. */
type PaneToast = { slotId: string; seriesId: string; text: string; sticky?: boolean;
  onUndo?: () => void; undoAction?: 'pair' | 'arrangement' | 'alignment'; onKeep?: () => void; keepAction?: 'keep' | 'keep-plain' };

function ViewportCell({ slot, index, paneCount, volume, metadata, active, tool, annotations, crosshair, fusion, segmentations, loading, loadError, linked, interaction, references, alignments, aligned,
  onActivate, onViewChange, onAnnotationsChange, onCrosshairChange, onDropSeries, onClose, onMaximize, onRestore, onCyclePlane, onFusionAdjust, onRotateReference, clickPicksPoint, span, onSwap, toast }: {
  slot: Slot; index: number; paneCount: number; volume: Volume | undefined; metadata: Series | undefined; active: boolean; tool: Tool; segmentations: SegmentationOverlay[];
  annotations: Annotation[]; crosshair: Vec3 | null; fusion: FusionSettings | null; loading: boolean; loadError?: string; linked: boolean;
  interaction: Settings; references: { id: string; series: Series; view: ViewState; color?: string }[];
  /** Frames of reference aligned (imaging/registration.ts): another pane's plane in an aligned frame is drawn here too. */
  alignments: readonly Alignment[];
  /** This pane shows a series, or a fused overlay, placed by an alignment: said in its corner. */
  aligned?: 'automatic' | 'adjusted';
  onActivate: (id: string) => void; onViewChange: (id: string, patch: Partial<ViewState>) => void;
  onAnnotationsChange: (seriesId: string, annotations: Annotation[]) => void;
  onRotateReference?: (id: string, oblique: [number, number]) => void; clickPicksPoint?: boolean;
  /** The last pane widens over the columns the grid has no pane for. */
  span?: number; onSwap: (from: string, to: string) => void;
  /** A short note in this pane (what was just put in it, or the arrangement it belongs to), with an undo or a keep. */
  toast?: PaneToast;
  onFusionAdjust: (next: { upperSuv: number; opacity: number }) => void;
  onCrosshairChange: (point: Vec3) => void; onDropSeries: (slotId: string, seriesIds: string[]) => void;
  onClose: (id: string) => void; onMaximize: (id: string) => void; onCyclePlane: (id: string) => void;
  /** Set while this pane is maximized: back to the layout it came from. */
  onRestore?: () => void;
}) {
  const { t } = useTranslation();
  const activate = () => onActivate(slot.id);
  const update = (patch: Partial<ViewState>) => onViewChange(slot.id, patch);
  const annotate = (next: Annotation[]) => { if (slot.seriesId) onAnnotationsChange(slot.seriesId, next); };
  const cyclePlane = () => onCyclePlane(slot.id);
  const [dragging, setDragging] = useState(false);
  const referencePlanes = volume && interaction.showReferences ? references.flatMap(item => {
    const here = { series: volume.series, view: renderedView(volume, slot.view) };
    if (item.id === slot.id) return [];
    if (sharePlaneSpace(item, here)) return [item];
    // A plane in a frame of reference of its own, aligned to this one: drawn where the alignment puts it.
    const transform = placed(item) && placed(here) ? alignedTransform(alignments, item.series, volume.series) : null;
    return transform ? [{ ...item, transform }] : [];
  }) : [];
  const requestedView = volume ? resolveView(volume, slot.view) : slot.view;
  const displayView = volume ? renderedView(volume, slot.view) : slot.view;
  const count = volume ? sliceCount(volume.series, requestedView) : metadata?.dimensions[2] ?? 1;
  // The bar and the counter go in paging order: an axial stack from the top down (see paging.ts).
  const backwards = volume ? pagesBackwards(volume.series, requestedView) : false;
  const atSlice = Math.min(requestedView.slice, count - 1), position = backwards ? count - 1 - atSlice : atSlice;
  const shownNumber = Math.min(count, backwards ? count - displayView.slice : displayView.slice + 1);
  // A whole-volume MIP pages through its turns: the bar and the counter give its angle.
  const projected = Boolean(volume && isProjection(volume.series, displayView));
  const windowText = volume && displayView.voiLut === undefined ? suvWindowText(volume.series, displayView) : null;
  return <section className={`viewport-cell ${active ? 'is-active' : ''} ${dragging ? 'is-drop-target' : ''}`} style={span && span > 1 ? { gridColumn: `span ${span}` } : undefined}
    data-testid="viewport-cell" data-series-id={slot.seriesId ?? ''} data-volume-complete={Boolean(volume && volume.sourceFrameIndex === undefined && !loading && !loadError)}
    onPointerDown={activate} onFocusCapture={activate} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-veacom-series') || event.dataTransfer.types.includes(PANE_DRAG)) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={() => setDragging(false)} onDrop={event => {
      event.preventDefault(); setDragging(false);
      const pane = event.dataTransfer.getData(PANE_DRAG);
      if (pane) { if (pane !== slot.id) onSwap(pane, slot.id); return; }
      const ids = draggedSeries(event.dataTransfer); if (ids.length) onDropSeries(slot.id, ids);
    }}>
    {/* Pane chrome is interface, not image: the exporter skips it (the overlay SVG carries every image label). */}
    <header className="viewport-header" data-export-exclude>
      <span className="viewport-plane" data-export-label>{projected ? t('planeTag.mip') : volume && usesSourceFrames(volume.series, displayView) ? t('planeTag.source') : displayView.oblique?.some(Boolean) ? t('planeTag.oblique') : t(`planeTag.${displayView.plane}` as const)}</span>
      <span className="viewport-series" data-export-label title={metadata?.description ? seriesName(metadata) : undefined}>{metadata?.description ? seriesName(metadata) : t('viewport.empty')}</span>
      {linked && volume && <Link2 size={12} className="subtle-icon" />}
      <button type="button" aria-label={`${t('viewport.close')} · ${index + 1}`} data-tooltip={t('viewport.close')} data-testid="viewport-close" onClick={() => onClose(slot.id)}><X size={15} /></button>
      {paneCount > 1 && <button type="button" draggable aria-label={`${t('viewport.move')} · ${index + 1}`} data-tooltip={t('viewport.move')} data-testid="viewport-move" className="viewport-grip"
        onDragStart={event => { event.dataTransfer.setData(PANE_DRAG, slot.id); event.dataTransfer.effectAllowed = 'move'; }}><GripVertical size={15} /></button>}
      {onRestore ? <button type="button" aria-label={t('viewport.restore')} data-tooltip={t('viewport.restore')} data-testid="viewport-restore" onClick={onRestore}><Minimize2 size={14} /></button>
        : <button type="button" aria-label={`${t('viewport.maximize')} · ${index + 1}`} data-tooltip={t('viewport.maximize')} data-testid="viewport-maximize" onClick={() => onMaximize(slot.id)}><Maximize2 size={14} /></button>}
    </header>
    <div className="viewport-content">
      {volume ? <Viewport paneNumber={paneCount > 1 ? index + 1 : undefined} volume={volume} view={requestedView} tool={tool} annotations={annotations} active={active}
        crosshair={crosshair} fusion={fusion} onFusionAdjust={fusion ? onFusionAdjust : undefined} onRotateReference={onRotateReference} clickPicksPoint={clickPicksPoint} onActivate={activate} onViewChange={update}
        onAnnotationsChange={annotate} onCrosshairChange={onCrosshairChange} referencePlanes={referencePlanes}
        mouseBindings={interaction.mouseBindings} wheelAction={interaction.wheelAction} wheelSensitivity={interaction.wheelSensitivity} reverseWheel={interaction.reverseWheel}
        showOverlay={interaction.showOverlay} showScale={interaction.showScale} hidePatientData={interaction.hidePatientData} hideMeasurements={interaction.hideMeasurements} segmentations={segmentations} onCyclePlane={cyclePlane} aligned={aligned} />
        : <div className="empty-viewport" data-export-exclude>{loading ? <LoaderCircle className="spin" size={22} /> : <Layers size={24} strokeWidth={1.4} />}
          <span>{loading ? t('viewport.opening') : metadata?.dimensions[2] === 0 ? t('series.noImages') : t('viewport.selectOrDrag')}</span></div>}
      {volume?.sourceFrameIndex !== undefined && <span className="volume-progress" data-export-exclude><LoaderCircle size={12} className="spin" />{volume.sourceFrameIndex !== requestedView.slice ? t('viewport.loadingFrame', { number: requestedView.slice + 1 }) : loading ? t('viewport.loadingVolume') : t('viewport.sourcePreview')}</span>}
      {toast && <div className="pane-toast" role="status" data-export-exclude><span>{toast.text}</span>
        {toast.onUndo && (toast.undoAction === 'arrangement' ? <button type="button" data-action="arrangement-undo" onClick={toast.onUndo}>{t('pair.undo')}</button>
          : toast.undoAction === 'alignment' ? <button type="button" data-action="alignment-undo" onClick={toast.onUndo}>{t('pair.undo')}</button>
          : <button type="button" data-action="pair-undo" onClick={toast.onUndo}>{t('pair.undo')}</button>)}
        {toast.onKeep && (toast.keepAction === 'keep-plain' ? <button type="button" data-action="arrangement-keep-plain" onClick={toast.onKeep}>{t('arrangement.keep')}</button>
          : <button type="button" data-action="arrangement-keep" onClick={toast.onKeep}>{t('arrangement.keep')}</button>)}</div>}
      {loadError && <div className="viewport-error" role="status" data-export-exclude>{volume ? t('viewport.previewOnly') : ''}{loadError}</div>}
    </div>
    {volume && <footer className="viewport-footer" data-export-exclude>
      <span data-export-label>{projected ? `${projectionAngle(displayView.slice)}°` : <>{shownNumber} / {count}{loading ? t('viewport.sourceFramesSuffix', { count: metadata?.dimensions[2] ?? '?' }) : ''}</>}</span>
      <SliceBar count={count} position={position} valueText={projected ? `${projectionAngle(position)}°` : `${position + 1} / ${count}`}
        label={projected ? t('projection.slider') : usesSourceFrames(volume.series, requestedView) ? t('viewport.sourceFrameSlider') : t('viewport.sliceSlider', { plane: t(`planeLower.${requestedView.plane}` as const) })}
        onPosition={next => update({ slice: backwards ? count - 1 - next : next })} />
      <span data-export-label>{displayView.voiLut !== undefined ? t('viewport.voiLut') : windowText ?? `W ${Math.round(displayView.windowWidth)} · L ${Math.round(displayView.windowCenter)}${displayView.voiFunction ? ` · ${t(displayView.voiFunction === 'SIGMOID' ? 'viewport.sigmoid' : 'viewport.linearExact')}` : ''}`}</span>
      <span className="zoom-indicator">{Math.round(displayView.zoom * 100)}%</span>
    </footer>}
  </section>;
}

function AnnotationSummary({ annotation, volume }: { annotation: Annotation; volume?: Volume }) {
  const { t } = useTranslation();
  const summary = useAnnotationSummary(annotation, volume);
  // The main value leads; further statistics wrap as whole items ("σ 295.4" never splits). A note wraps as text.
  const parts = (summary || t(`tool.${annotation.type}` as const)).split(' · ');
  if (parts.length === 1) return <span className="stat-primary">{parts[0]}</span>;
  return <>{parts.map((part, index) => <span key={index} className={index ? 'stat' : 'stat-primary'}>{part}</span>)}</>;
}

// Listen while the image grid is mounted, including after leaving the welcome screen.
function useViewportGrid() {
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridTall, setGridTall] = useState(false);
  const attachGrid = (element: HTMLDivElement | null) => {
    if (!element) return;
    gridRef.current = element;
    const observer = new ResizeObserver(([{ contentRect }]) => setGridTall(contentRect.height > contentRect.width));
    observer.observe(element);
    return () => { observer.disconnect(); gridRef.current = null; };
  };
  return { gridRef, gridTall, attachGrid };
}

export default function App() {
  const { locale, t } = useTranslation();
  const toolLabel = (tool: Tool) => t(`tool.${tool}` as const);
  const presetName = (preset: typeof PRESETS[number]) => t(`preset.${preset.key}` as const);
  const stageLabel = (stage: string) => { const key = STAGES[stage]; return key ? t(key) : stage; };
  const planeLabel = (plane: Plane) => t(`planeLower.${plane}` as const);
  const [series, setSeries] = useState<Series[]>([]);
  const seriesById = new Map(series.map(item => [item.id, item]));
  // Stable event handlers read refs so their closures do not retain old volume maps.
  const seriesRef = useRef(series);
  const [volumes, setVolumes] = useState<Map<string, Volume>>(() => new Map());
  const [slotFrames, setSlotFrames] = useState<Record<string, Volume>>({});
  const [frameCache] = useState(() => new SourceFrameCache());
  const frameRequests = useRef(new Map<string, { key: string; seriesId: string; controller: AbortController }>());
  const volumesRef = useRef(volumes);
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const [slots, setSlots] = useState<Slot[]>(() => [makeSlot()]);
  const slotsRef = useRef(slots);
  const [activeId, setActiveId] = useState<string>(() => slots[0].id);
  const activeIdRef = useRef(activeId);
  const [layout, setLayout] = useState<[number, number]>([1, 1]);
  const layoutRef = useRef(layout);
  const [isMpr, setIsMpr] = useState(false);
  const isMprRef = useRef(isMpr);
  const beforeMpr = useRef<{ slots: Slot[]; layout: [number, number]; activeId: string; crosshair: Vec3 | null; crosshairSeriesId: string | null } | null>(null);
  // Ends the three-plane MPR (set below, where the restoring is defined); picking a series calls it.
  const endMpr = useRef<() => void>(() => {});
  // Panes a smaller layout leaves out keep their series and view and come back when it grows again (VEAcom 1.x).
  const hiddenSlots = useRef<Slot[]>([]);
  const [annotations, setAnnotations] = useState<Record<string, Annotation[]>>({});
  const annotationRef = useRef(annotations);
  const [settings, setSettings] = useState(readSettings);
  const [openSections, setOpenSections] = useState(readOpenSections);
  const [calibrationScales, setCalibrationScales] = useState<Record<string, number>>({});
  const [calibrationLine, setCalibrationLine] = useState('');
  const [calibrationLength, setCalibrationLength] = useState('');
  const settingsRef = useRef(settings);
  // Panes of one plane linked by hand at the slices they showed (the link button), by pair of panes.
  const anchorsRef = useRef(new Map<string, Anchor>());
  const [{ tool, lastMeasure }, updateTool] = useReducer((current: { tool: Tool; lastMeasure: Tool }, next: Tool) =>
    current.tool === next ? current : { tool: next, lastMeasure: MEASURE_TOOLS.includes(next) ? next : current.lastMeasure }, { tool: 'window', lastMeasure: 'length' });
  const toolRef = useRef(tool);
  // The left button's tool before a measuring tool was taken up: putting that down returns to it.
  const navigationTool = useRef<Tool>('window');
  const setTool = (next: Tool) => {
    if (!MEASURE_TOOLS.includes(next)) navigationTool.current = next;
    updateTool(next);
    setSettings(current => {
      if (!current.mouseBindings.left) return current;
      const mouseBindings = { ...current.mouseBindings }; delete mouseBindings.left;
      return { ...current, mouseBindings };
    });
  };
  /** A measuring tool chosen again (its button, its menu item, its key) is put down, as in VEAcom 1.x. */
  const toggleMeasure = (item: Tool) => {
    if (toolRef.current === item) { setTool(navigationTool.current); return; }
    setTool(item);
  };
  const [menu, setMenu] = useState<Menu>(null);
  const [crosshair, setCrosshair] = useState<Vec3 | null>(null);
  const crosshairRef = useRef(crosshair);
  const [crosshairSeriesId, setCrosshairSeriesId] = useState<string | null>(null);
  const crosshairSeriesIdRef = useRef(crosshairSeriesId);
  const [busy, setBusy] = useState<MessageKey | null>('status.connecting');
  const [importing, setImporting] = useState(0);
  const importCount = useRef(0);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ id?: number; stage: string; completed: number; total: number } | null>(null);
  // The engine job Cancel was pressed for: "Cancelling…" shows while that job is the one in progress, not for the next.
  const [cancelledId, setCancelledId] = useState<number | null>(null);
  const cancelling = progress !== null && cancelledId !== null && progress.id === cancelledId;
  // Cancel for the job the progress shows: in the strip above the images, or in the status bar while a series decodes.
  const cancelProgress = () => {
    if (!progress) return;
    setCancelledId(progress.id ?? null);
    void cancelOperation(progress.id).catch(error => { setCancelledId(null); setNotice({ message: errorText(error), kind: 'error' }); });
  };
  const [notice, setNotice] = useState<Notice | null>(null);
  const say = (key: MessageKey, kind: Notice['kind'], params?: MessageParams, transient = false) => setNotice({ message: t(key, params), kind, key, params, transient });
  const [graphics, setGraphics] = useState<Graphics | null>(null);
  // The caught error itself, so a translated (LocalizedError) message follows a language change.
  const [graphicsError, setGraphicsError] = useState<unknown>(null);
  const [graphicsNoticeOpen, setGraphicsNoticeOpen] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showAssessment, setShowAssessment] = useState(false);
  // The inspector can come in front of an open assessment without closing it: closing discards what was typed.
  const [assessmentBehind, setAssessmentBehind] = useState(false);
  const assessmentPreviousTool = useRef<Tool | null>(null);
  const assessmentPreviousLeft = useRef<Tool | undefined>(undefined);
  const assessmentPinnedIds = useRef(new Set<string>());
  const [show3d, setShow3d] = useState(false);
  const [volumeViewportSize, setVolumeViewportSize] = useState<[number, number]>([1, 1]);
  // A point picked in 3D: the 2D panes beside the 3D view go to it; closing 3D takes it away if it is still the
  // crosshair (one picked or moved in 2D since stays).
  const pointFrom3d = useRef<Vec3 | null>(null);
  const [exportMode, setExportMode] = useState<ExportDialogProps['mode'] | null>(null);
  // An export left to run in the background: its window is hidden, the series it was opened for kept.
  const [exportBackground, setExportBackground] = useState(false);
  // Read when the export ends: the window's task kept the handlers it started with.
  const exportBackgroundRef = useRef(exportBackground);
  const [exportBusy, setExportBusy] = useState(false);
  // Pictures or video are being captured from a pane: nothing may change what the pane shows until they are done
  // (the export checks each slice's series too, export-video.ts). Read by the window handlers below.
  const capturing = exportBusy && (exportMode === 'images' || exportMode === 'video');
  const capturingRef = useRef(capturing);
  // The pre-operative checklist (a CT's assessment): open beside the images.
  const [checklistOpen, setChecklistOpen] = useState(false);
  // Opening the checklist moves focus into it, as opening the assessment does; a change of series that only brings
  // it back leaves focus where it is (a click in a pane keeps the image's keys).
  const checklistTakesFocus = useRef(false);
  const toggleChecklist = () => { checklistTakesFocus.current = !checklistOpen; setChecklistOpen(!checklistOpen); };
  const focusChecklistHeading = (heading: HTMLHeadingElement | null) => {
    if (heading && checklistTakesFocus.current) {
      checklistTakesFocus.current = false;
      heading.focus({ preventScroll: true });
    }
  };
  // A note shown for a few seconds in one pane (the DWI/ADC partner put there).
  // The layout a maximized pane came from (id, layout, pane order), for its restore button.
  const [maximized, setMaximized] = useState<{ id: string; layout: [number, number]; order: string[] } | null>(null);
  const maximizedRef = useRef(maximized);
  // Studies whose "not DICOM" notice was closed (this session).
  const [pictureNoticeClosed, setPictureNoticeClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [paneToast, setPaneToast] = useState<PaneToast | null>(null);
  // The note on screen, for work that finishes later and says so in the same note while it is still there.
  const paneToastRef = useRef(paneToast);
  // A pane note clears itself after a few seconds. A sticky one (an arrangement applied or undone, an offer to keep one)
  // stays until the reader's next action anywhere but on the note itself: a whole screen arranged must not vanish unseen.
  useEffect(() => {
    if (!paneToast) return;
    if (!paneToast.sticky) { const timer = setTimeout(() => setPaneToast(null), 5000); return () => clearTimeout(timer); }
    const shown = paneToast;
    const away = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.pane-toast')) return;
      setPaneToast(current => current === shown ? null : current);
    };
    const key = (event: KeyboardEvent) => { if (!['Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) away(event); };
    window.addEventListener('pointerdown', away, true); window.addEventListener('wheel', away, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('wheel', away, true); window.removeEventListener('keydown', key, true); };
  }, [paneToast]);
  // The arrangement on screen, for Keep this (src/arrangements), and the ones this reader kept (per user, on this computer).
  const arranged = useRef<{ plan: Plan; slotIds: string[] } | null>(null);
  const [kept, setKept] = useState<Kept>(readKeptArrangements);
  const keptRef = useRef(kept);
  const saveKept = (next: Kept) => {
    keptRef.current = next; setKept(next);
    try { localStorage.setItem(KEPT_STORAGE, JSON.stringify(next)); } catch { /* Storage may be disabled by the host. */ }
  };
  // Set below, where it is defined: a pane of an arranged screen was rearranged.
  const offerKeep = useRef<(slotId: string) => void>(() => {});
  // The export under way: its progress in the status bar, and how to stop it.
  const [exportProgress, setExportProgress] = useState<[number, number] | null>(null);
  const changeExportBusy = (value: boolean) => {
    setExportBusy(value);
    if (!value) setExportProgress(null);
  };
  const exportCancel = useRef<(() => void) | null>(null);
  const [exportFor, setExportFor] = useState<string | null>(null);
  useEffect(() => {
    if (!exportBusy) return;
    // Closing the window while an export runs asks first (electron/main.cjs, will-prevent-unload).
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [exportBusy]);
  const [exportVideoTarget, setExportVideoTarget] = useState<ExportDialogProps['video']>(undefined);
  const [shownSegmentations, setShownSegmentations] = useState<string[]>([]);
  const shownSegmentationsRef = useRef(shownSegmentations);
  const [segmentationMasks, setSegmentationMasks] = useState<Map<string, SegmentationOverlay>>(() => new Map());
  const maskRequests = useRef(new Map<string, Promise<SegmentationOverlay>>());
  const [fusionId, setFusionId] = useState<string | null>(null);
  const fusionIdRef = useRef(fusionId);
  // Frames of reference aligned (imaging/registration.ts), per pair: two visits, or a PET and a CT or MR acquired apart.
  // Handlers read the ref; changeAlignments sets both, so a handler sees an alignment it has just made.
  const [alignments, setAlignments] = useState<readonly Alignment[]>([]);
  const alignmentsRef = useRef(alignments);
  const changeAlignments = (next: readonly Alignment[]) => { alignmentsRef.current = next; setAlignments(next); };
  // Alignments the engine is finding: the status bar says so and follows the decoding of the volumes they need.
  const [aligning, setAligning] = useState(0);
  // The fusion asked for last: one asked for earlier, or stopped since, does not start when its PET has loaded.
  const fusionRequest = useRef(0);
  // Series whose preview could not be made: the series list shows a dash for them.
  const [failedPreviews, setFailedPreviews] = useState<ReadonlySet<string>>(() => new Set());
  // The thick slab's thickness, kept while no slab is shown (as in VEAcom Next, 10 mm to begin with).
  const [slabThickness, setSlabThickness] = useState<number>(DEFAULT_SLAB_THICKNESS);
  const [fusionOpacity, setFusionOpacity] = useState(0.45);
  const [fusionUpper, setFusionUpper] = useState(8);
  const [fusionPalette, setFusionPalette] = useState<FusionSettings['palette']>('hot');
  const [fusionBlend, setFusionBlend] = useState<FusionSettings['blend']>('uptake');
  // As in VEAcom Next, a fusion starts with the PET scanner's own look until the reader changes a setting.
  const [fusionDeviceMode, setFusionDeviceMode] = useState(true);
  const fusionDeviceModeRef = useRef(fusionDeviceMode);
  const [showFusion, setShowFusion] = useState(false);
  // Read by an arrangement's Undo, which puts the fusion back as it was.
  const fusionState = useRef({ show: showFusion, opacity: fusionOpacity, upper: fusionUpper, palette: fusionPalette, blend: fusionBlend, deviceMode: fusionDeviceMode });
  const showTagError = (error: unknown) => setNotice({ message: errorText(error), kind: 'error' });
  const [historyCount, setHistoryCount] = useState<[number, number]>([0, 0]);
  const history = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const pending = useRef(new Map<string, Promise<Volume>>());
  const fullyLoaded = useRef(new Set<string>());
  // Series an import still under way has published (importStudies): their frames can be shown before it ends.
  const earlySeries = useRef(new Set<string>());
  const volumeGenerations = useRef(new Map<string, number>());
  const volumeAccess = useRef(new Map<string, number>());
  const accessClock = useRef(0);
  const requestedPins = useRef(new Set<string>());
  const { gridRef, gridTall, attachGrid } = useViewportGrid();
  // Space: a quick menu where the pointer is (VEAcom Next): the left button's function, the measuring tools and colours.
  const [quick, setQuick] = useState<{ x: number; y: number } | null>(null);
  const quickRef = useRef<HTMLDivElement>(null);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const mounted = useRef(true);
  // Usage timings (src/usage): whether the user agreed to share them; null until asked, undefined when unknown.
  const [usageConsent, setUsageConsent] = useState<'granted' | 'denied' | null | undefined>(undefined);
  // The W/L each pane got from "Auto", so the window can be reported as automatic rather than manual.
  const autoWindows = useRef(new Map<string, string>());

  // Each decorated volume keeps its identity while its volume and settings do (see decoratedVolumes.ts).
  const petRecords = usePetRecords(series, setAnnotations);
  const [decorated] = useState(() => createVolumeDecorator(decorateVolume, sameDecoration));
  const displayVolumes = new Map([...volumes].map(([id, volume]) => [id, decorated(volume,
    { scale: calibrationScales[volume.series.id], units: settings.measurementUnits, suvNormalization: settings.suvNormalization, glucose: petRecords.typedGlucose(volume.series) })]));
  const resolvedSlots = slots.map(slot => {
    const volume = slot.seriesId ? displayVolumes.get(slot.seriesId) : undefined;
    // Keep the requested reconstruction while a preview stands in for its volume.
    if (!volume || (volume.sourceFrameIndex !== undefined && slot.view.mode === 'mpr')) return slot;
    const view = resolveView(volume, slot.view);
    return view === slot.view ? slot : { ...slot, view };
  });
  if (resolvedSlots.some((slot, index) => slot !== slots[index])) setSlots(resolvedSlots);
  const displaySlotFrames = new Map(Object.entries(slotFrames).map(([id, volume]) => [id, decorated(volume,
    { scale: calibrationScales[volume.series.id], units: settings.measurementUnits, suvNormalization: settings.suvNormalization, glucose: petRecords.typedGlucose(volume.series) })]));
  const volumeForSlot = (slot: Slot) => {
    const volume = slot.seriesId ? displayVolumes.get(slot.seriesId) : undefined;
    const frame = displaySlotFrames.get(slot.id);
    return volume?.sourceFrameIndex !== undefined && frame?.series.id === slot.seriesId ? frame : volume;
  };
  const displayVolumesRef = useRef(displayVolumes);
  // A PET's reference spheres and lesion table are kept with its study, on this computer (src/domain/petStudies.ts).
  const petStudies = usePetStudies(series, annotations, setAnnotations, displayVolumes, petRecords);
  // Cine: the active pane pages through its slices by itself, at the chosen speed, round and round, until paused.
  const [playing, setPlaying] = useState(false);
  const activeSlot = slots.find(slot => slot.id === activeId) ?? slots[0];
  const activeSeries = activeSlot.seriesId ? seriesById.get(activeSlot.seriesId) : undefined;
  // Pictures (JPEG, PNG, BMP) in the active pane are not DICOM: said at the top until closed for that study.
  const pictureNote = activeSeries?.warningNotes?.find(note => note.code === 'series.ordinaryImage');
  const pictureFormat = typeof pictureNote?.params?.format === 'string' ? pictureNote.params.format : '';
  const pictureNotice = pictureNote && activeSeries && !pictureNoticeClosed.has(activeSeries.studyUid) ? activeSeries.studyUid : null;
  const activeVolume = volumeForSlot(activeSlot);
  if (activeVolume?.series.sourceFramesOnly) {
    if (show3d) setShow3d(false);
    if (showFusion) setShowFusion(false);
  }
  // At most one pass through the series a second.
  const cineMax = activeVolume ? Math.max(1, sliceCount(activeVolume.series, activeSlot.view)) : 1;
  const cineFps = Math.max(1, Math.min(settings.cineFps, cineMax));
  const activeDisplayView = activeVolume ? renderedView(activeVolume, activeSlot.view) : activeSlot.view;
  const framePending = activeVolume?.sourceFrameIndex !== undefined && activeVolume.sourceFrameIndex !== activeSlot.view.slice;
  const activeAnnotations = activeSlot.seriesId ? annotations[activeSlot.seriesId] ?? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS;
  // The active PET's prior lesions by name, live or as kept, for its lesion table.
  // The right-hand column shows the inspector or the assessment; a hidden assessment stays mounted with its input.
  const inspectorShown = Boolean(settings.panel) && (!showAssessment || assessmentBehind);
  const assessmentShown = showAssessment && !inspectorShown;
  const needsSourceFrame = (inspectorShown && settings.panel === 'tags') || Boolean(exportMode);
  const displayedDicomFrame = activeVolume && !framePending && usesSourceFrames(activeVolume.series, activeSlot.view)
    && !isProjection(activeVolume.series, activeSlot.view) && !activeSlot.view.slab
    && !activeVolume.series.frameMetadata?.[activeDisplayView.slice]?.sourceFrameNumber ? Math.round(activeDisplayView.slice) : undefined;
  const currentSourceFrame = needsSourceFrame && activeVolume ? sourceFrameForView(activeVolume.series, activeDisplayView) : 0;
  // A CT's assessment button opens the pre-op checklist instead (the assessment is for MR).
  const opensChecklist = activeSeries?.modality === 'CT';
  const checklistShown = checklistOpen && opensChecklist;
  const canReconstruct = Boolean(activeVolume?.series.canReconstruct && activeVolume.sourceFrameIndex === undefined && !activeVolume.series.sourceFramesOnly && activeSeries && !loadingIds.has(activeSeries.id) && !loadErrors[activeSeries.id]);
  const fusionVolume = fusionId ? displayVolumes.get(fusionId) : undefined;
  const fusion = fusionVolume && fusionVolume.sourceFrameIndex === undefined && !fusionVolume.series.sourceFramesOnly ? { volume: fusionVolume, opacity: fusionOpacity, upperSuv: fusionUpper, palette: fusionPalette, blend: fusionBlend } : null;
  const petSeries = series.filter(fusesAsOverlay);
  // The PET chosen for fusion: one without SUV is drawn on its own values, and its scale is not called SUV.
  const fusionPet = fusionId ? seriesById.get(fusionId) : undefined;
  const acquisitionPet = panelPet(activeSeries, fusionPet);
  const priorPet = acquisitionPet ? findRole({ modality: 'PT', study: 'prior', prefer: ['corrected', 'slices'] }, series, acquisitionPet) : null;
  const keptPet = acquisitionPet ? petStudies.keptPrior(acquisitionPet, priorPet) : null;
  const petPrior: PetPrior | null = priorPet
    ? { date: priorPet.studyDate, kept: false, acquisition: compared(priorPet.petAcquisition, petRecords.typedGlucose(priorPet)) }
    : keptPet ? { date: keptPet.date, kept: true, acquisition: keptCompared(keptPet.series, keptPet.glucose) } : null;
  const typedGlucose = acquisitionPet ? petRecords.typedGlucose(acquisitionPet) : undefined;
  const currentPet = compared(acquisitionPet?.petAcquisition, typedGlucose);
  const limitedView = !!acquisitionPet && petRecords.limitedView(acquisitionPet);
  const cautions = petPrior ? comparisonFlags(currentPet, petPrior.acquisition, limitedView).map(flag =>
    ({ flag, text: comparisonText(flag, currentPet, petPrior, limitedView, t) })) : [];
  const cautionKey = acquisitionPet && petPrior ? comparisonKey(acquisitionPet.id, petPrior, currentPet, limitedView) : '';
  const lesionPrior = activeSeries?.modality === 'PT' && activeVolume
    ? priorLesions(priorPet, annotations, displayVolumes, keptPet, quantitativeScale(activeVolume.series).unit) : null;
  // MR over MR: the MR series shown in the other panes that the active MR can be fused with.
  const mrActive = activeSeries?.modality === 'MR';
  const mrBeside = !activeSeries || activeSeries.modality !== 'MR' ? [] : slots.flatMap(slot => {
    const item = slot.id !== activeId && slot.seriesId ? seriesById.get(slot.seriesId) : undefined;
    return item && item.modality === 'MR' && item.id !== activeSeries.id && item.studyUid === activeSeries.studyUid && !item.segmentation && shareFrame(activeSeries, item) ? [item] : [];
  });
  const mrFusable = activeSeries?.modality === 'MR' && series.some(item => item.modality === 'MR' && item.id !== activeSeries.id && item.studyUid === activeSeries.studyUid && !item.segmentation && shareFrame(activeSeries, item));
  // The strip for an MR fusion: no PET series to choose, no blending or scanner look.
  // PETs and SPECTs the active series can be fused with: acquired with it, or the same patient's acquired apart (aligned first).
  const overlayChoices = petSeries.filter(item => !activeSeries || item.id === fusionId || shareFrame(item, activeSeries) || (samePatient(item, activeSeries) && Boolean(frameOf(item) && frameOf(activeSeries))));
  const mrFusion = fusionPet ? fusionPet.modality === 'MR' : mrActive && !overlayChoices.length;
  const plainFusion = mrFusion || fusionPet?.modality === 'NM';
  const segmentationOverlays = shownSegmentations.flatMap(id => segmentationMasks.get(id) ?? []);
  const shownSegmentationIds = new Set(shownSegmentations);
  const totalFrames = series.reduce((sum, item) => sum + item.dimensions[2], 0);
  const assessmentVolumes = [...displayVolumes.values()].filter(volume => volume.sourceFrameIndex === undefined);
  // As in VEAcom Next, only the pane being driven draws its slice on the others; nothing is drawn on it.
  // The three-plane MPR keeps every pane's lines, with the handles that turn them (oblique MPR).
  const activeReferences = !settings.showReferences || slots.length < 2 ? EMPTY_REFERENCES : (isMpr ? slots : [activeSlot]).flatMap(slot => {
    const base = slot.seriesId ? displayVolumes.get(slot.seriesId) : undefined, delivered = displaySlotFrames.get(slot.id);
    const volume = base?.sourceFrameIndex !== undefined && delivered?.series.id === slot.seriesId ? delivered : base;
    if (!volume) return [];
    const view = renderedView(volume, slot.view);
    return isProjection(volume.series, view) ? [] : [{ id: slot.id, series: volume.series, view }];
  });
  const activateSlot = (id: string) => { activeIdRef.current = id; setActiveId(id); };
  // The crosshair in the active series' own coordinates (3D draws it there), through an alignment where it was set in
  // another frame of reference.
  const crosshairOrigin = crosshairSeriesId ? volumes.get(crosshairSeriesId) : undefined;
  const toActive = activeVolume && crosshairOrigin ? transformBetween(alignments, crosshairOrigin.series, activeVolume.series) : null;
  const activeCrosshair = crosshair && toActive ? mapPoint(toActive, crosshair) : crosshair;
  // The alignment that places the active pane's series or its fused overlay: the display panel's alignment section.
  const displayedOverlay = activeVolume && fusion && !activeSlot.unfused && activeVolume.sourceFrameIndex === undefined && !activeVolume.series.sourceFramesOnly && fusesOver(activeVolume.series, fusion.volume.series, alignments) ? fusion.volume.series : undefined;
  const activeAlignment = activeSeries ? alignmentOf(alignments, activeSeries, displayedOverlay) : null;
  const nudgeAlignment = (alignment: Alignment, nudge: Nudge) => {
    // Turned about the middle of what the active pane shows, so what the reader is looking at stays put.
    const slot = slotsRef.current.find(item => item.id === activeIdRef.current), shown = slot?.seriesId ? seriesRef.current.find(item => item.id === slot.seriesId) : undefined;
    const frame = shown ? frameOf(shown) : null, centre = slot && shown ? getPlaneFrame(shown, slot.view).center : null;
    const pivot = centre && frame === alignment.fixed ? centre : centre && frame === alignment.moving ? applyPoint(alignment.matrix, centre) : applyPoint(alignment.matrix, alignment.centre);
    changeAlignments(withAlignment(alignmentsRef.current, nudged(alignment, nudgeStep(nudge, pivot))));
  };
  const removeAlignment = (alignment: Alignment) => {
    changeAlignments(withoutAlignment(alignmentsRef.current, alignment));
    const slot = slotsRef.current.find(item => item.id === activeIdRef.current);
    if (slot?.seriesId) setPaneToast({ slotId: slot.id, seriesId: slot.seriesId, text: t('alignment.removed'), sticky: true, undoAction: 'alignment',
      onUndo: () => { setPaneToast(null); changeAlignments(withAlignment(alignmentsRef.current, alignment)); } });
  };

  useEffect(() => {
    const visible = slots.flatMap(slot => {
      const volume = volumeForSlot(slot);
      if (!volume) return [];
      const fused = fusion && !slot.unfused && volume.sourceFrameIndex === undefined && !volume.series.sourceFramesOnly && fusesOver(volume.series, fusion.volume.series, alignments)
        ? alignedFusion(fusion, transformBetween(alignments, volume.series, fusion.volume.series) ?? IDENTITY) : null;
      return [{ volume, view: renderedView(volume, slot.view), fusion: fused }];
    });
    try {
      if (visible.length) sliceRenderer().setVisibleViews(visible);
      else clearSliceTextureCache();
    } catch { /* Each viewport reports GPU errors. */ }
  }, [slots, volumeForSlot, fusion, alignments]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; frameCache.dispose(); for (const request of frameRequests.current.values()) request.controller.abort(); }; }, [frameCache]);
  // Find out how images will be drawn before a study opens. Without a usable graphics driver Chromium draws
  // WebGL in software (Direct3D WARP or SwiftShader), which is slow; the user is told so instead of guessing.
  useEffect(() => {
    let disposed = false;
    const inspect = async () => {
      let info: RendererInfo;
      try { info = sliceRenderer().info; }
      catch (error) { if (!disposed) { setGraphics(null); setGraphicsError(error); } return; }
      const status = await window.veacom?.getGraphicsStatus?.().catch(() => undefined);
      if (disposed) return;
      setGraphicsError(null);
      setGraphics({ renderer: info.renderer, software: info.software || isSoftwareWebglStatus(status?.webgl), webgl: status?.webgl });
    };
    const timer = window.setTimeout(() => void inspect());
    const restored = () => void inspect();
    window.addEventListener('veacom-gpu-restored', restored);
    return () => { disposed = true; window.clearTimeout(timer); window.removeEventListener('veacom-gpu-restored', restored); };
  }, []);
  useEffect(() => window.veacom?.onUpdateStatus(status => {
    if (status.phase === 'available') setNotice(current => current?.kind === 'error' ? current : {
      message: t('notice.updateAvailable', { version: status.version ?? '' }), kind: 'info', key: 'notice.updateAvailable', params: { version: status.version ?? '' },
    });
  }), []);
  useEngineRecovery({ setConnectionError, setNotice, onInterrupted: () => {
    setBusy(null); setProgress(null); setCancelledId(null);
    for (const id of pending.current.keys()) volumeGenerations.current.set(id, (volumeGenerations.current.get(id) ?? 0) + 1);
    pending.current.clear(); requestedPins.current.clear(); setLoadingIds(new Set());
    frameCache.clear();
    for (const request of frameRequests.current.values()) request.controller.abort();
    frameRequests.current.clear();
  } });
  const hasWork = Boolean(busy || loadingIds.size || importing || aligning);
  useEffect(() => {
    if (!hasWork) { setProgress(null); setCancelledId(null); return; }
    let disposed = false, polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      await getProgress().then(value => { if (!disposed) setProgress(value.running ? value : null); })
        .catch(() => { /* The initiating operation reports connection errors. */ })
        .finally(() => { polling = false; });
    };
    void poll(); const timer = setInterval(() => void poll(), 400);
    return () => { disposed = true; clearInterval(timer); };
  }, [hasWork]);
  useEffect(() => { try { localStorage.setItem('veacom:workspace:v2', JSON.stringify(settings)); } catch { /* Storage may be disabled by the host. */ } }, [settings]);
  useEffect(() => {
    if (!notice?.transient) return;
    // A confirmation clears itself, but not while someone is reading or using it (hover or focus).
    let timer = 0;
    const clear = () => { timer = window.setTimeout(() => {
      if (document.querySelector('.notice:hover, .notice:focus-within')) { clear(); return; }
      setNotice(current => current === notice ? null : current);
    }, 8000); };
    clear();
    return () => clearTimeout(timer);
  }, [notice]);
  // Closing 3D, the assessment or the checklist returns focus to the control that opened it (or More when it moved
  // there). The checklist counts as closed only when it is closed, not when a change of series hides it.
  const overlayWasOpen = useRef({ show3d: false, showAssessment: false, checklistOpen: false });
  useEffect(() => {
    const previous = overlayWasOpen.current; overlayWasOpen.current = { show3d, showAssessment, checklistOpen };
    const closed = previous.show3d && !show3d ? 'tool-3d' : (previous.showAssessment && !showAssessment) || (previous.checklistOpen && !checklistOpen) ? 'tool-assessment' : null;
    if (closed) requestAnimationFrame(() => (document.querySelector<HTMLElement>(`[data-testid="${closed}"]`) ?? document.querySelector<HTMLElement>('[data-testid="tool-more"]'))?.focus());
  }, [show3d, showAssessment, checklistOpen]);

  const remember = () => {
    history.current.past.push({ slots: slotsRef.current, annotations: annotationRef.current });
    if (history.current.past.length > 30) history.current.past.shift();
    history.current.future = []; setHistoryCount([history.current.past.length, 0]);
  };
  const undo = (redo = false) => {
    const from = redo ? history.current.future : history.current.past, to = redo ? history.current.past : history.current.future;
    const snapshot = from.pop(); if (!snapshot) return;
    to.push({ slots: slotsRef.current, annotations: annotationRef.current });
    setSlots(current => current.map(slot => {
      const saved = snapshot.slots.find(item => item.id === slot.id && item.seriesId === slot.seriesId);
      return saved ? { ...slot, view: saved.view } : slot;
    }));
    setAnnotations(snapshot.annotations); setHistoryCount([history.current.past.length, history.current.future.length]);
  };

  const publishVolumes = (candidate: Map<string, Volume>) => {
    const pinned = new Set([...pending.current.keys(), ...requestedPins.current, ...assessmentPinnedIds.current]);
    for (const slot of slotsRef.current) if (slot.seriesId) pinned.add(slot.seriesId);
    if (fusionIdRef.current) pinned.add(fusionIdRef.current);
    for (const [id, values] of Object.entries(annotationRef.current)) if (values.length) pinned.add(id);
    const result = trimInactiveVolumes(candidate, pinned, volumeAccess.current);
    for (const id of result.evicted) { fullyLoaded.current.delete(id); volumeAccess.current.delete(id); }
    if (result.volumes !== volumesRef.current) {
      volumesRef.current = result.volumes;
      setVolumes(result.volumes);
    }
  };

  const invalidateVolumes = (ids: readonly string[]) => {
    if (!ids.length) return;
    frameCache.invalidate(ids);
    const changed = new Set(ids);
    for (const [slotId, request] of frameRequests.current) if (changed.has(request.seriesId)) { request.controller.abort(); frameRequests.current.delete(slotId); }
    setSlotFrames(current => Object.fromEntries(Object.entries(current).filter(([, volume]) => !changed.has(volume.series.id))));
    const next = new Map(volumesRef.current);
    for (const id of ids) {
      forgetThumbnail(id);
      volumeGenerations.current.set(id, (volumeGenerations.current.get(id) ?? 0) + 1);
      next.delete(id); fullyLoaded.current.delete(id); pending.current.delete(id);
      volumeAccess.current.delete(id); requestedPins.current.delete(id);
    }
    publishVolumes(next);
    setFailedPreviews(current => ids.some(id => current.has(id)) ? new Set([...current].filter(id => !changed.has(id))) : current);
    setLoadingIds(current => { const updated = new Set(current); for (const id of ids) updated.delete(id); return updated; });
    setLoadErrors(current => { const updated = { ...current }; for (const id of ids) delete updated[id]; return updated; });
  };

  const acquireVolume = (item: Series): Promise<Volume> => {
    requestedPins.current.add(item.id);
    volumeAccess.current.set(item.id, ++accessClock.current);
    const cached = volumesRef.current.get(item.id);
    if (cached && fullyLoaded.current.has(item.id)) return Promise.resolve(cached);
    const existing = pending.current.get(item.id); if (existing) return existing;
    const generation = volumeGenerations.current.get(item.id) ?? 0;
    const isCurrent = () => generation === (volumeGenerations.current.get(item.id) ?? 0);
    const storeVolume = (volume: Volume) => {
      const next = new Map(volumesRef.current); next.set(item.id, volume);
      publishVolumes(next);
      keepThumbnail(volume);
    };
    setLoadingIds(current => new Set(current).add(item.id));
    setLoadErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
    let complete = false;
    const full = loadVolume(item).then(async volume => {
      complete = true;
      await prepareSourceProgram(volume);
      if (mounted.current && isCurrent()) {
        fullyLoaded.current.add(item.id); storeVolume(volume);
        if (slotsRef.current.find(slot => slot.id === activeIdRef.current)?.seriesId === item.id) usage.milestone('series-loaded');
      }
      return volume;
    }).catch(error => {
      complete = true;
      if (mounted.current && isCurrent()) setLoadErrors(current => ({ ...current, [item.id]: errorText(error) }));
      throw error;
    }).finally(() => {
      if (isCurrent()) {
        pending.current.delete(item.id);
        if (mounted.current) setLoadingIds(current => { const next = new Set(current); next.delete(item.id); return next; });
      }
    });
    pending.current.set(item.id, full);
    // Asked again after the preview's program compiles: the full volume may have arrived or failed meanwhile.
    const previewWanted = () => !complete && mounted.current && isCurrent() && !fullyLoaded.current.has(item.id);
    if (!cached && item.dimensions[2] > 1) void frameCache.get(item, openingSlice(item)).then(async volume => {
      if (!previewWanted()) return;
      await prepareSourceProgram(volume);
      if (previewWanted()) storeVolume(volume);
    }).catch(() => { /* The full decoder supplies the actionable error. */ });
    return full;
  };

  const publishLoadedVolumes = useEffectEvent(publishVolumes);
  const visibleSeriesIds = JSON.stringify(slots.map(slot => slot.seriesId));
  useEffect(() => {
    // Selection updates have committed, so requested series now have their lasting pins.
    requestedPins.current.clear();
    publishLoadedVolumes(volumesRef.current);
  }, [visibleSeriesIds, fusionId, annotations, showAssessment, volumes, loadingIds]);

  useEffect(() => {
    if (importing || loadingIds.size) return;
    let stopped = false, cursor = 0;
    const candidates = series.filter(item => !item.segmentation && item.dimensions[2] > 0 && !hasThumbnail(item.id)).slice(0, 40);
    async function preloadOne(item: Series, current: () => boolean) {
      const volume = fullyLoaded.current.has(item.id) ? volumesRef.current.get(item.id) : undefined;
      const middle = volume ?? await frameCache.get(item, thumbnailFrame(item));
      if (!current()) return;
      keepThumbnail(middle);
      if (!volumesRef.current.has(item.id) && !pending.current.has(item.id)) {
        const next = new Map(volumesRef.current); next.set(item.id, middle); publishLoadedVolumes(next);
      }
    }
    const preload = async () => {
      while (!stopped && cursor < candidates.length) {
        const item = candidates[cursor], generation = volumeGenerations.current.get(item.id) ?? 0;
        cursor += 1;
        const current = () => !stopped && generation === (volumeGenerations.current.get(item.id) ?? 0);
        await preloadOne(item, current).catch(() => {
          if (current()) setFailedPreviews(failed => failed.has(item.id) ? failed : new Set(failed).add(item.id));
        });
      }
    };
    void preload(); void preload();
    return () => { stopped = true; };
  }, [series, importing, loadingIds.size, frameCache]);

  useEffect(() => {
    // While a study is read, frames come only for the series it has already published (see importStudies).
    const reading = importCount.current > 0, early = earlySeries.current;
    if (reading) for (const [id, request] of frameRequests.current) if (!early.has(request.seriesId)) { request.controller.abort(); frameRequests.current.delete(id); }
    if (reading && !early.size) return;
    const activeSlots = new Set(slots.map(slot => slot.id));
    for (const [id, request] of frameRequests.current) if (!activeSlots.has(id)) { request.controller.abort(); frameRequests.current.delete(id); }
    for (const slot of slots) {
      if (reading && !(slot.seriesId && early.has(slot.seriesId))) continue;
      const base = slot.seriesId ? volumes.get(slot.seriesId) : undefined;
      if (!base || base.sourceFrameIndex === undefined) {
        frameRequests.current.get(slot.id)?.controller.abort(); frameRequests.current.delete(slot.id); continue;
      }
      const index = Math.max(0, Math.min(base.series.dimensions[2] - 1, Math.round(slot.view.slice)));
      const shown = slotFrames[slot.id]?.series.id === slot.seriesId ? slotFrames[slot.id] : base;
      if (shown.sourceFrameIndex === index) {
        frameRequests.current.get(slot.id)?.controller.abort(); frameRequests.current.delete(slot.id);
        continue;
      }
      const generation = volumeGenerations.current.get(base.series.id) ?? 0;
      const key = `${base.series.id}:${generation}:${index}`;
      if (frameRequests.current.get(slot.id)?.key === key) continue;
      frameRequests.current.get(slot.id)?.controller.abort();
      const request = { key, seriesId: base.series.id, controller: new AbortController() };
      frameRequests.current.set(slot.id, request);
      void frameCache.get(base.series, index, request.controller.signal).then(frame => {
        const current = slotsRef.current.find(value => value.id === slot.id);
        if (!mounted.current || frameRequests.current.get(slot.id) !== request || fullyLoaded.current.has(base.series.id)
          || current?.seriesId !== base.series.id || current.view.slice !== index || generation !== (volumeGenerations.current.get(base.series.id) ?? 0)) return;
        setSlotFrames(values => ({ ...values, [slot.id]: frame }));
      }).catch(error => {
        if (!request.controller.signal.aborted && frameRequests.current.get(slot.id) === request) setNotice({ message: errorText(error), kind: 'error' });
      }).finally(() => { if (frameRequests.current.get(slot.id) === request) frameRequests.current.delete(slot.id); });
    }
    const stale = Object.entries(slotFrames).filter(([id, volume]) => fullyLoaded.current.has(volume.series.id) || !slots.some(slot => slot.id === id && slot.seriesId === volume.series.id));
    if (stale.length) setSlotFrames(current => {
      const next = { ...current };
      for (const [id, frame] of stale) if (next[id] === frame) delete next[id];
      return next;
    });
  }, [slots, volumes, slotFrames, frameCache, importing]);

  const loadPaneImage = (item?: Series) => {
    if (item && item.dimensions[2] > 0) void acquireVolume(item).catch(error => setNotice({ message: errorText(error), kind: 'error' }));
  };
  const assignSeries = (slotId: string, item: Series) => {
    setSlots(current => current.map(slot => slot.id === slotId ? { id: slot.id, seriesId: item.id, view: defaultView(item) } : slot));
    setActiveId(slotId);
    loadPaneImage(item);
  };

  // `trigger` says how the study was opened (folder, disc, drop...) for usage timings; never where from.
  // Set below, where arrangements are applied: opens a study's first image, or the arrangement it matches.
  const openStudy = useRef<(first: Series, study: Series[], keepShown?: boolean, session?: Series[]) => void>(() => {});
  const importStudies = async (paths: string[], trigger = 'other') => {
    if (!paths.length) return;
    // A study named at launch has been opening since the window was created (the monotonic clock's zero).
    usage.beginStudy(trigger, trigger === 'startup' ? 0 : undefined);
    importCount.current++; setImporting(importCount.current);
    frameCache.clear();
    for (const request of frameRequests.current.values()) request.controller.abort();
    frameRequests.current.clear();
    setBusy('status.reading'); setConnectionError(null); setNotice(null);
    // The engine publishes each series whose folders it has read whole while it reads the rest (its /import/early):
    // the first opens at once and the others join the list. The import's own result is the final word on them.
    const early = new Map<string, Series>();
    let watching = true, opened = false;
    // Asked after each wait: the import's own result ends the watch, and so does the app unmounting.
    const stillWatching = () => watching && mounted.current;
    const listedBefore = new Set(seriesRef.current.map(item => item.id));
    void (async () => {
      let after = 0;
      while (stillWatching()) {
        await new Promise(resolve => setTimeout(resolve, 40));
        if (!stillWatching()) return;
        let found: Series[];
        try { found = await importEarly(paths, after); } catch { return; /* An engine restart: the import's own result reports it. */ }
        if (!stillWatching()) return;
        after += found.length;
        const images = found.filter(item => !item.segmentation && !early.has(item.id));
        if (!images.length) continue;
        const replaced = images.filter(item => seriesRef.current.some(old => old.id === item.id && old.catalogRevision !== item.catalogRevision));
        if (replaced.length) invalidateVolumes(replaced.map(item => item.id));
        for (const item of images) { early.set(item.id, item); earlySeries.current.add(item.id); }
        setSeries(current => withFound(current, images, listedBefore));
        if (!opened) { opened = true; assignSeries(activeIdRef.current, images[0]); }
      }
    })();
    await importPaths(paths).then(result => {
      watching = false;
      // A series published early that came out the same keeps its pane, its view and the volume already loading.
      const same = (item: Series) => early.has(item.id) && JSON.stringify(early.get(item.id)) === JSON.stringify(item);
      const settled = new Set(result.series.filter(same).map(item => item.id));
      const dropped = new Set([...early.keys()].filter(id => !result.series.some(item => item.id === id)));
      const images = result.series.filter(item => !item.segmentation);
      usage.studyOpened({ modalities: result.series.map(item => item.modality), series: images.length, slices: images.reduce((sum, item) => sum + item.dimensions[2], 0),
        source: result.source, result: images.length ? 'ok' : 'empty' }, result.series.map(item => item.id));
      invalidateVolumes([...result.series.map(item => item.id).filter(id => !settled.has(id)), ...dropped]);
      if (dropped.size) setSlots(current => current.map(slot => slot.seriesId && dropped.has(slot.seriesId) ? { ...slot, seriesId: null } : slot));
      const reimported = new Set(result.series.map(item => item.id));
      for (const id of reimported) maskRequests.current.delete(id);
      setSegmentationMasks(current => [...current.keys()].some(id => reimported.has(id)) ? new Map([...current].filter(([id]) => !reimported.has(id))) : current);
      setAnnotations(current => {
        const next = { ...current }; let changed = false;
        for (const item of result.series) {
          if (!Object.hasOwn(current, item.id)) continue;
          const kept = current[item.id];
          const moved = kept.map(annotation => {
            if (annotation.mode !== 'source' || !annotation.sourceSopInstanceUid) return annotation;
            const index = annotationSourceIndex(annotation, item);
            if (index === null || (index === annotation.sourceFrame && index === annotation.slice)) return annotation;
            return { ...annotation, sourceFrame: index, slice: index };
          });
          if (moved.some((annotation, i) => annotation !== kept[i])) { next[item.id] = moved; changed = true; }
        }
        return changed ? next : current;
      });
      const visibleIds = new Set([...slotsRef.current.map(slot => slot.seriesId), fusionIdRef.current, ...assessmentPinnedIds.current]);
      for (const item of result.series) if (visibleIds.has(item.id) && !settled.has(item.id)) loadPaneImage(item);
      // The study just opened leads the list (src/ui/seriesOrder.ts): its new series, those opened early among them,
      // in the import's catalogue order rather than the order they were found in. Series listed before it follow
      // where they were.
      setSeries(current => withImported(current, result.series, listedBefore, early.keys()));
      if (result.warnings.length) setNotice({ message: warningTexts(result).join(' · '), kind: 'info', code: 'import-warnings', warnings: result });
      const firstImage = result.series.find(item => !item.segmentation && item.dimensions[2] > 0) ?? result.series.find(item => !item.segmentation);
      // The series opened early stays, unless the import read it differently; a study with an arrangement of its own (the
      // PET/CT screen) is laid out now that every series is known.
      const shownEarly = slotsRef.current.flatMap(slot => slot.seriesId && early.has(slot.seriesId) ? [slot.seriesId] : []);
      const keep = opened && shownEarly.length > 0 && shownEarly.every(id => settled.has(id));
      const known = new Map(seriesRef.current.map(item => [item.id, item]));
      for (const item of result.series) known.set(item.id, item);
      if (firstImage) openStudy.current(firstImage, [...known.values()].filter(item => studyKey(item) === studyKey(firstImage)), keep, [...known.values()]);
      else if (result.series.length) say('segmentation.onlySegmentations', 'info');
      else say('notice.noDicomFound', 'info');
    }).catch(error => {
      watching = false;
      usage.studyOpened({ modalities: [], series: 0, slices: 0, result: 'error' }, []); setNotice({ message: errorText(error), kind: 'error' });
      // The series published early go with the failed import (the engine has taken them back).
      if (early.size) {
        invalidateVolumes([...early.keys()]);
        setSeries(current => current.filter(item => !early.has(item.id)));
        setSlots(current => current.map(slot => slot.seriesId && early.has(slot.seriesId) ? { ...slot, seriesId: null } : slot));
      }
    }).finally(() => {
      watching = false;
      for (const id of early.keys()) earlySeries.current.delete(id);
      importCount.current = Math.max(0, importCount.current - 1); setImporting(importCount.current); setBusy(null);
    });
  };

  // The import window (as in VEAcom Next), in a view of its own that this page cannot reach (electron/import-view.cjs);
  // the system's own dialogs stay in the menu.
  const openImport = async (start?: 'disc') => {
    setMenu(null);
    if (!window.veacom?.openImportWindow) { void open('folder'); return; }
    // Like the native dialogs, the window is what this action does, and nothing in the app's state shows it.
    usage.touch('dialog');
    const trigger = start === 'disc' ? 'disc' : 'folder';
    try { await importStudies(await window.veacom.openImportWindow(start), trigger); }
    catch (error) { setNotice({ message: errorText(error), kind: 'error' }); }
  };
  useEffect(() => window.veacom?.onImportAction?.((id, input) => usage.action(id, input)), []);
  const open = async (kind: 'files' | 'folder' | 'archive', trigger: string = kind) => {
    setMenu(null);
    if (!window.veacom) { say('notice.desktopToOpen', 'info'); return; }
    // The native dialog is what this action does, and nothing in the app's state shows it.
    usage.touch('dialog');
    try { await importStudies(await window.veacom.openPaths(kind), trigger); }
    catch (error) { setNotice({ message: errorText(error), kind: 'error' }); }
  };

  const restoreCatalog = async () => {
    // A launch-time study may already be importing in the main process; it opens through importStudies,
    // so the catalog must not open its first series as well.
    const startupPaths = await window.veacom?.takeStartupPaths();
    const result = await listSeries(); if (!mounted.current) return;
    setSeries(current => {
      const merged = new Map(current.map(item => [item.id, item]));
      for (const item of result.series) merged.set(item.id, item);
      return [...merged.values()];
    });
    if (!startupPaths?.length && result.series[0] && !slotsRef.current.some(slot => slot.seriesId)) {
      // Series the engine already holds (the window reloaded) open as a study of their own.
      const images = result.series.filter(item => !item.segmentation);
      usage.beginStudy('catalog');
      usage.studyOpened({ modalities: result.series.map(item => item.modality), series: images.length, slices: images.reduce((sum, item) => sum + item.dimensions[2], 0), result: 'ok' }, result.series.map(item => item.id));
      assignSeries(activeIdRef.current, result.series[0]);
    }
    if (startupPaths?.length) await importStudies(startupPaths, 'startup');
  };
  const connect = async () => {
    setBusy('status.connecting'); setConnectionError(null);
    try { await restoreCatalog(); } catch (error) { if (mounted.current) setConnectionError(errorText(error)); }
    if (mounted.current) setBusy(null);
  };
  const connectOnMount = useEffectEvent(connect);
  useEffect(() => { void connectOnMount(); }, []);
  const onImport = useEffectEvent(importStudies);
  useEffect(() => {
    const handler = (event: Event) => { const paths = (event as CustomEvent<unknown>).detail; if (Array.isArray(paths) && paths.every(path => typeof path === 'string')) void onImport(paths); };
    window.addEventListener('veacom:import', handler); return () => window.removeEventListener('veacom:import', handler);
  }, []);
  useEffect(() => {
    const externalFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files')
      && !event.dataTransfer.types.includes('application/x-veacom-series');
    // A link dragged in from elsewhere would make the browser leave the page, and the open studies with it: refused.
    const link = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('text/uri-list')) && !externalFiles(event);
    const dragOver = (event: DragEvent) => {
      if (link(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; return; }
      if (!externalFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    // Up to its first await (the checks and preventDefault) this runs while the drop is dispatched; a failed import is
    // reported in the notice.
    const dropFiles = async (event: DragEvent) => {
      if (link(event)) { event.preventDefault(); return; }
      if (!externalFiles(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      if (capturingRef.current) { say('notice.waitForCapture', 'info'); return; }
      const bridge = window.veacom;
      if (!bridge?.importFiles) {
        say('notice.dropNeedsDesktop', 'info');
        return;
      }
      try {
        const paths = await bridge.importFiles(files);
        if (!paths.length) { say('notice.dropNoPaths', 'info'); return; }
        void onImport(paths, 'drop');
      } catch (error) { setNotice({ message: errorText(error), kind: 'error' }); }
    };
    const drop = (event: DragEvent) => { void dropFiles(event); };
    document.addEventListener('dragover', dragOver); document.addEventListener('drop', drop);
    return () => { document.removeEventListener('dragover', dragOver); document.removeEventListener('drop', drop); };
  }, []);

  const updateView = (slotId: string, patch: Partial<ViewState>) => {
    const before = slotsRef.current.find(slot => slot.id === slotId)?.view;
    if (before && arranged.current?.slotIds.includes(slotId) && (['plane', 'mode', 'projection', 'inverted', 'palette'] as const).some(key => key in patch && patch[key] !== before[key])) {
      offerKeep.current(slotId);
    }
    setSlots(current => {
      const selected = current.find(slot => slot.id === slotId); if (!selected) return current;
      const volume = selected.seriesId ? displayVolumesRef.current.get(selected.seriesId) : undefined;
      const manualWindow = patch.windowMode === undefined && (patch.windowWidth !== undefined || patch.windowCenter !== undefined);
      const proposed = { ...selected.view, ...patch, ...(manualWindow ? { windowMode: 'manual' as const } : {}) };
      // A reconstructed view whose volume is still a preview frame keeps being one (an arranged MIP paged while its PET
      // loads stays a MIP): only the full volume resolves it.
      const waiting = volume?.sourceFrameIndex !== undefined && selected.view.mode === 'mpr';
      let nextView = volume && !waiting ? patchView(volume, selected.view, patch) : proposed;
      if (volume) {
        const slice = Math.max(0, Math.min(sliceCount(volume.series, nextView) - 1, Math.round(nextView.slice)));
        if (slice !== nextView.slice) nextView = { ...nextView, slice };
      }
      // A whole-volume MIP turns as it pages: it moves no other pane.
      const position = volume && !isProjection(volume.series, nextView) && patch.slice !== undefined && settingsRef.current.linked ? getPlaneFrame(volume.series, nextView).center : null;
      const source: Pane | null = volume ? { series: volume.series, view: nextView } : null, moved = nextView.slice - selected.view.slice;
      // The three-plane MPR keeps one window in its panes, as VEAcom Next's oblique MPR does; so do panes showing one PET
      // or gamma camera image (a PET and its MIP, a whole body's two views), with its inversion and palette: one scale.
      const windowed = patch.windowWidth !== undefined || patch.windowCenter !== undefined, pet = Boolean(volume && isEmission(volume.series));
      const sharedWindow = windowed && (isMprRef.current || pet), sharedLook = pet && (patch.inverted !== undefined || patch.palette !== undefined);
      // An arrangement on one SUV scale (the PET follow-up): its other PETs take the same SUV range and look.
      const arrangement = arranged.current;
      const sharedPet = arrangement && (sharedWindow || sharedLook) && arrangement.slotIds.includes(slotId) && sharesSuvScale(arrangement.plan)
        && arrangement.plan.panes.some(pane => pane.series.id === selected.seriesId) ? arrangement : null;
      return current.map(original => {
        if (original.id === slotId) return { ...original, view: nextView };
        if ((sharedWindow || sharedLook) && original.seriesId === selected.seriesId) return { ...original, view: { ...original.view,
          ...(sharedWindow ? { windowWidth: nextView.windowWidth, windowCenter: nextView.windowCenter, windowMode: nextView.windowMode } : {}),
          ...(sharedLook ? { inverted: nextView.inverted, palette: nextView.palette } : {}) } };
        let slot = original;
        const other = slot.seriesId ? displayVolumesRef.current.get(slot.seriesId) : undefined;
        if (sharedPet && volume && other && sharedPet.slotIds.includes(slot.id)
          && sharedPet.plan.panes.some(pane => pane.series.id === slot.seriesId)) {
          const window = sharedWindow ? sameRangeWindow(volume.series, nextView, other.series, 'SUV') : null;
          slot = { ...slot, view: { ...slot.view, ...(window ? { ...window, windowMode: 'manual' as const } : {}),
            ...(sharedLook ? { inverted: nextView.inverted, palette: nextView.palette } : {}) } };
        }
        if (!position || !volume || !other || !source || !selected.seriesId || !slot.seriesId || isProjection(other.series, slot.view)) return slot;
        const target: Pane = { series: other.series, view: slot.view };
        // Aligned frames of reference page by position through the alignment; links by hand are for the others.
        const toTarget = alignedTransform(alignmentsRef.current, volume.series, other.series) ?? undefined;
        const anchor = toTarget ? null : anchorFor(anchorsRef.current, { id: slotId, seriesId: selected.seriesId }, { id: slot.id, seriesId: slot.seriesId });
        const slice = linkedSlice(source, target, position, moved, anchor ? { source: anchor[slotId].slice, target: anchor[slot.id].slice } : undefined, toTarget);
        return slice === null || slice === slot.view.slice ? slot : { ...slot, view: resolveView(other, { ...slot.view, slice }) };
      });
    });
  };
  const advancePlayingSlice = useEffectEvent((last: number, now: number) => {
    const advance = advanceCine(last, now, cineFps);
    if (advance.steps && activeVolume && cineMax > 1) {
      const next = Math.round(activeSlot.view.slice) + advance.steps * pageStep(activeVolume.series, activeSlot.view, 1);
      updateView(activeSlot.id, { slice: ((next % cineMax) + cineMax) % cineMax });
    }
    return advance.last;
  });
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      last = advancePlayingSlice(last, now);
      frame = requestAnimationFrame(tick);
    };
    let frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  /** A click on a pane's plane name: the next plane in place, axial, coronal, sagittal (VEAcom 1.x); the plane the
   * series was acquired in shows its own images. Only for a whole volume that can be reconstructed. */
  const cyclePlane = (slotId: string) => {
    const slot = slotsRef.current.find(item => item.id === slotId), volume = slot?.seriesId ? displayVolumesRef.current.get(slot.seriesId) : undefined;
    if (!slot || !volume || !volume.series.canReconstruct || volume.series.sourceFramesOnly || volume.sourceFrameIndex !== undefined || isProjection(volume.series, slot.view)) return;
    const acquired = acquiredPlane(volume.series), current = usesSourceFrames(volume.series, slot.view) ? acquired : slot.view.plane;
    if (!current) return;
    const next = ({ axial: 'coronal', coronal: 'sagittal', sagittal: 'axial' } as const)[current];
    const center = getPlaneFrame(volume.series, slot.view).center;
    const view: ViewState = next === acquired ? { ...slot.view, mode: 'source', plane: 'axial', oblique: undefined } : { ...slot.view, mode: 'mpr', plane: next, oblique: [0, 0] };
    updateView(slotId, { ...view, slice: sliceAtWorld(volume.series, view, center) });
  };
  /** Shown panes of one kind of plane that do not page together of themselves. */
  const unrelatedPairs = () => {
    const shown = slotsRef.current.flatMap(slot => {
      const volume = slot.seriesId ? displayVolumesRef.current.get(slot.seriesId) : undefined;
      return volume && slot.seriesId ? [{ id: slot.id, seriesId: slot.seriesId, pane: { series: volume.series, view: slot.view } }] : [];
    });
    return shown.flatMap((one, n) => shown.slice(n + 1).filter(other => facesSame(one.pane, other.pane)
      && !(sharePlaneSpace(one.pane, other.pane) || inStep(one.pane, other.pane) || alignedTransform(alignmentsRef.current, one.pane.series, other.pane.series))).map(other => [one, other] as const));
  };
  /** Links unrelated panes at the slices they show (all of them, or those not linked yet); how many pairs. */
  const linkHere = (renew: boolean) => {
    const pairs = unrelatedPairs().filter(([a, b]) => renew || !anchorFor(anchorsRef.current, a, b));
    for (const [a, b] of pairs) anchorsRef.current.set(pairKey(a.id, b.id), { [a.id]: { seriesId: a.seriesId, slice: Math.round(a.pane.view.slice) }, [b.id]: { seriesId: b.seriesId, slice: Math.round(b.pane.view.slice) } });
    return pairs.length;
  };
  /** The link button, as in VEAcom Next: on, it links unrelated panes where they are; pressed again it links panes
   * not linked yet; once every pane on screen is linked it turns linking off. */
  const pressLink = () => {
    let linked: number;
    if (!settingsRef.current.linked) { setSettings(current => ({ ...current, linked: true })); linked = linkHere(true); }
    else if (unrelatedPairs().some(([a, b]) => !anchorFor(anchorsRef.current, a, b))) linked = linkHere(false);
    else { setSettings(current => ({ ...current, linked: false })); return; }
    if (linked) say('notice.seriesLinked', 'info', undefined, true);
  };
  const loadMask = (item: Series): Promise<SegmentationOverlay> => {
    const existing = maskRequests.current.get(item.id); if (existing) return existing;
    const request = loadVolume(item).then(volume => {
      const overlay = { id: item.id, series: item, frames: maskFrames(volume), labels: labelVolume(volume) };
      if (mounted.current && maskRequests.current.get(item.id) === request) setSegmentationMasks(current => new Map(current).set(item.id, overlay));
      return overlay;
    });
    request.catch(() => { if (maskRequests.current.get(item.id) === request) maskRequests.current.delete(item.id); });
    maskRequests.current.set(item.id, request);
    return request;
  };
  const hideSegmentation = (id: string) => setShownSegmentations(current => current.filter(value => value !== id));
  /** Draws a segmentation over the series it belongs to, opening that series at the segmented region; a second call hides it. */
  const toggleSegmentation = (item: Series, slotId: string) => {
    if (shownSegmentationsRef.current.includes(item.id)) { hideSegmentation(item.id); return; }
    setShownSegmentations(current => [...current, item.id]);
    const slot = slotsRef.current.find(value => value.id === slotId);
    const all = seriesRef.current, shown = slot?.seriesId ? all.find(value => value.id === slot.seriesId) : undefined;
    const target = shown && segmentationApplies(item, shown) ? shown
      : all.find(value => segmentationApplies(item, value));
    if (!target) say('segmentation.imagesNotOpen', 'info');
    else if (target !== shown) assignSeries(slotId, target);
    void loadMask(item).then(overlay => {
      if (!mounted.current || !shownSegmentationsRef.current.includes(item.id)) return;
      if (!overlay.frames.length) {
        say('segmentation.empty', 'info', { description: item.description || t('segmentation.thisOne') });
        return;
      }
      const current = slotsRef.current.find(value => value.id === slotId), center = segmentationCenter(overlay);
      if (!target || !center || current?.seriesId !== target.id) return;
      // Open at the middle of the segmented region, marked by the crosshair that linked views, MPR and 3D follow.
      setCrosshair(center); setCrosshairSeriesId(target.id);
      updateView(slotId, { slice: sliceAtWorld(displayVolumesRef.current.get(target.id)?.series ?? target, current.view, center) });
    }).catch(error => { if (mounted.current) { setNotice({ message: errorText(error), kind: 'error' }); hideSegmentation(item.id); } });
  };
  const refreshMasks = useEffectEvent(() => {
    // Masks dropped by a re-import are read again while their segmentation stays shown.
    for (const id of shownSegmentations) {
      const item = series.find(value => value.id === id);
      if (!item?.segmentation) { hideSegmentation(id); continue; }
      if (!segmentationMasks.has(id)) void loadMask(item).catch(error => { if (mounted.current) { setNotice({ message: errorText(error), kind: 'error' }); hideSegmentation(id); } });
    }
  });
  useEffect(() => { refreshMasks(); }, [shownSegmentations, segmentationMasks, series]);
  // A series picked or dropped during the three-plane MPR ends it, as in VEAcom 1.x: the panes from before it
  // come back and the series opens in the active one.
  // With two panes, a DWI put in one brings its study's ADC into the other at once, and an ADC the DWI (the highest
  // b-value); the panes are linked, so they page slice for slice (both come from one acquisition).
  // The DWI/ADC arrangements (src/arrangements/builtin.ts) say which partner and where.
  const offerPair = (slotId: string, item: Series) => {
    const panes = slotsRef.current;
    if (beforeMpr.current) return;
    const plan = match(BUILTIN_ARRANGEMENTS, 'pick', { series: seriesRef.current, picked: [item], panes: panes.length });
    const other = panes.find(slot => slot.id !== slotId), partner = plan?.panes[1]?.series, notice = plan?.arrangement.notice;
    if (!plan || !other || !partner) return;
    const wasLinked = settingsRef.current.linked;
    if (other.seriesId !== partner.id) {
      const previous = other.seriesId ? seriesRef.current.find(value => value.id === other.seriesId) : undefined;
      assignSeries(other.id, partner);
      // Said in that pane for a few seconds; Undo puts back what it showed (and the links as they were).
      setPaneToast({ slotId: other.id, seriesId: partner.id, text: notice ? t(notice.key, notice.params) : '', undoAction: 'pair', onUndo: () => {
        setPaneToast(null);
        if (previous) assignSeries(other.id, previous);
        else setSlots(current => current.map(slot => slot.id === other.id ? { ...slot, seriesId: null, view: { ...DEFAULT_VIEW, pan: [0, 0] } } : slot));
        if (!wasLinked) setSettings(current => ({ ...current, linked: false }));
        activateSlot(slotId);
      } });
    }
    activateSlot(slotId);
    if (!wasLinked) setSettings(current => ({ ...current, linked: true }));
  };
  const selectSeries = (item: Series) => {
    if (item.segmentation) { toggleSegmentation(item, activeIdRef.current); return; }
    if (beforeMpr.current) endMpr.current();
    assignSeries(activeIdRef.current, item);
    offerPair(activeIdRef.current, item);
  };
  const selectFromMenu = (item: Series) => { selectSeries(item); setMenu(null); };
  /** Several series picked together: a layout with a pane for each, the first picked first (VEAcom 1.x). */
  const openSideBySide = (ids: string[]) => {
    const picked = ids.map(id => seriesRef.current.find(value => value.id === id)).filter((item): item is Series => Boolean(item));
    const plan = match(BUILTIN_ARRANGEMENTS, 'pick-several', { series: seriesRef.current, picked });
    if (!plan?.grid) return;
    const items = plan.panes.map(pane => pane.series), [rows, columns] = plan.grid;
    arranged.current = null;
    beforeMpr.current = null; setIsMpr(false); setMenu(null); setLayout([rows, columns]);
    const current = slotsRef.current;
    const panes = Array.from({ length: rows * columns }, (_, index) => {
      const item = items.at(index), slot = current[index] ?? makeSlot();
      return item ? { ...slot, seriesId: item.id, view: defaultView(item) } : { ...slot, seriesId: null, view: { ...DEFAULT_VIEW, pan: [0, 0] as [number, number] } };
    });
    setSlots(panes); activateSlot(panes[0].id);
    for (const item of items) loadPaneImage(item);
  };
  const dropSeries = (slotId: string, seriesIds: string[]) => {
    if (seriesIds.length > 1) { openSideBySide(seriesIds); return; }
    const item = seriesRef.current.find(value => value.id === seriesIds[0]); if (!item) return;
    if (!item.segmentation && beforeMpr.current) { endMpr.current(); assignSeries(activeIdRef.current, item); return; }
    if (item.segmentation) toggleSegmentation(item, slotId); else { assignSeries(slotId, item); offerPair(slotId, item); }
  };
  /** Series taken off the list (VEAcom 1.x's list menu): panes showing them are emptied, their volumes,
   * drawings and overlays go, and the engine frees them. The files themselves are not touched. */
  const removeFromList = (ids: string[]) => {
    const gone = new Set(ids);
    const removed = seriesRef.current.filter(item => gone.has(item.id));
    if (!removed.length) return;
    const empty = (slot: Slot): Slot => slot.seriesId && gone.has(slot.seriesId) ? { ...slot, seriesId: null, view: { ...DEFAULT_VIEW, pan: [0, 0] } } : slot;
    // Panes a smaller layout keeps hidden would bring the removed series back when the layout grows again.
    hiddenSlots.current = hiddenSlots.current.filter(slot => !(slot.seriesId && gone.has(slot.seriesId)));
    if (removed.length === seriesRef.current.length) {
      // With the list emptied, the workspace starts afresh as at launch: one pane, nothing hidden, maximized, in MPR,
      // in 3D, fused or playing, so the next study opens as the first one did.
      const fresh = makeSlot();
      hiddenSlots.current = []; beforeMpr.current = null;
      setSlots([fresh]); setLayout([1, 1]); activateSlot(fresh.id);
      setMaximized(null); setIsMpr(false); setShow3d(false); setShowFusion(false); setFusionId(null);
      setCrosshair(null); setPlaying(false); setChecklistOpen(false); changeAlignments([]);
    } else {
      setSlots(current => current.map(empty));
      if (beforeMpr.current) beforeMpr.current = { ...beforeMpr.current, slots: beforeMpr.current.slots.map(empty) };
    }
    setSeries(current => current.filter(item => !gone.has(item.id)));
    invalidateVolumes([...gone]);
    if (fusionIdRef.current && gone.has(fusionIdRef.current)) setFusionId(null);
    setCrosshairSeriesId(current => current && gone.has(current) ? null : current);
    setShownSegmentations(current => current.some(id => gone.has(id)) ? current.filter(id => !gone.has(id)) : current);
    setSegmentationMasks(current => [...current.keys()].some(id => gone.has(id)) ? new Map([...current].filter(([id]) => !gone.has(id))) : current);
    for (const id of gone) maskRequests.current.delete(id);
    setAnnotations(current => Object.keys(current).some(id => gone.has(id)) ? Object.fromEntries(Object.entries(current).filter(([id]) => !gone.has(id))) : current);
    const byEngine = new Map<number | undefined, string[]>();
    for (const item of removed) byEngine.set(item.engineGeneration, [...(byEngine.get(item.engineGeneration) ?? []), item.id]);
    // An engine that restarted meanwhile has forgotten them already.
    for (const [generation, group] of byEngine) void removeSeries(group, generation).catch(() => {});
  };
  const changeAnnotations = (seriesId: string, next: Annotation[]) => {
    const named = seriesRef.current.find(item => item.id === seriesId)?.modality === 'PT' ? nameLesions(next) : next;
    remember(); setAnnotations(current => ({ ...current, [seriesId]: clearEditedScores(current[seriesId] ?? [], named) }));
  };
  const matchPriorLesion = (seriesId: string, id: string, priorLesionId: string | undefined) => {
    const items = annotationRef.current[seriesId] ?? [];
    if (priorLesionId && items.some(item => item.id !== id && !item.role && item.priorLesionId === priorLesionId)) return;
    changeAnnotations(seriesId, items.map(item => item.id === id ? { ...item, priorLesionId } : item));
  };
  const changeCrosshair = (point: Vec3) => {
    const source = slotsRef.current.find(slot => slot.id === activeIdRef.current);
    const volume = source?.seriesId ? displayVolumesRef.current.get(source.seriesId) : undefined;
    setCrosshair(point); setCrosshairSeriesId(source?.seriesId ?? null);
    if (!source || !volume || !settingsRef.current.linked) return;
    setSlots(current => current.map(slot => {
      const other = slot.seriesId ? displayVolumesRef.current.get(slot.seriesId) : undefined;
      // A whole-volume MIP holds the point at every turn: it keeps its turn.
      if (!other || isProjection(other.series, slot.view)) return slot;
      const target = { series: other.series, view: slot.view }, here = { series: volume.series, view: source.view };
      // In a frame of reference of its own, aligned: the same place in the patient, through the alignment.
      const toTarget = sharePlaneSpace(here, target) ? null : placed(here) && placed(target) ? alignedTransform(alignmentsRef.current, volume.series, other.series) : null;
      if (!toTarget && !sharePlaneSpace(here, target)) return slot;
      const slice = coveredSlice(target, toTarget ? applyPoint(toTarget, point) : point);
      return slice === null || slice === slot.view.slice ? slot : { ...slot, view: resolveView(other, { ...slot.view, slice }) };
    }));
  };
  /** The PET scanner's look: its colour scale, blending, opacity and top of the scale, and the CT window in the pane. */
  const applyDeviceLook = (pet: Series, slotId: string | null) => {
    const look = DEVICE_LOOKS[deviceMaker(pet)];
    setFusionPalette(look.palette); setFusionBlend(look.blend); setFusionOpacity(look.opacity); setFusionUpper(look.upperSuv); setFusionDeviceMode(true);
    if (slotId) updateView(slotId, { windowWidth: look.ctWindow[0], windowCenter: look.ctWindow[1], windowMode: 'manual' });
  };
  /** Fuses `pet` over `ct`, shown in the pane `slotId`. A PET without SUV is fused on its own values. `quiet`: an arrangement's
   * own notice says it (that the PET has no SUV is still said). */
  /** Lays `moving` over `fixed` in the engine (native/src/registration.rs): the alignment of their frames of reference.
   * Written with promise handlers: the React compiler leaves a component with a `finally` block uncompiled. */
  const align = (fixed: Series, moving: Series): Promise<Alignment> => {
    setAligning(count => count + 1);
    const finished = () => { if (mounted.current) setAligning(count => Math.max(0, count - 1)); };
    return registerSeries(fixed, moving).then(result => {
      finished();
      const found = alignmentFrom(result, fixed, moving);
      if (!found) throw new Error(t('notice.fusionNoFrame'));
      return found;
    }, error => { finished(); throw error; });
  };
  /** What a notice calls a series: its modality, as readers name it. */
  const modalityName = (item: Series) => item.modality === 'CT' ? t('alignment.ct') : item.modality === 'PT' ? 'PET' : item.modality === 'NM' ? 'SPECT' : item.modality;
  const moved = (alignment: Alignment) => { const { shift, angle } = movement(alignment); return { shift: shift.toFixed(1), angle: angle.toFixed(1) }; };
  /** A PET or SPECT over a CT or MR acquired apart: aligned first, by the overlay's own CT where it has one, then fused;
   * the pane says so, with Undo. */
  const alignForFusion = (pet: Series, base: Series, slotId: string) => {
    const moving = findRole(FUSION.roles.ct, seriesRef.current, pet) ?? pet;
    const request = ++fusionRequest.current, names = { overlay: modalityName(pet), base: modalityName(base) };
    setFusionId(null);
    const running: PaneToast = { slotId, seriesId: base.id, text: t('alignment.fusionRunning', names), sticky: true };
    setPaneToast(running);
    void align(base, moving).then(found => {
      if (!mounted.current || request !== fusionRequest.current) return;
      changeAlignments(withAlignment(alignmentsRef.current, found));
      fusePet(pet, base, slotId, true);
      setPaneToast({ slotId, seriesId: base.id, text: t('alignment.fusionDone', { ...names, by: modalityName(moving), ...moved(found) }), sticky: true, undoAction: 'alignment',
        onUndo: () => {
          setPaneToast(null); changeAlignments(withoutAlignment(alignmentsRef.current, found));
          if (fusionIdRef.current === pet.id) { fusionRequest.current++; setFusionId(null); }
        } });
    }).catch(error => {
      if (!mounted.current || request !== fusionRequest.current) return;
      setPaneToast(current => current === running ? null : current);
      setNotice({ message: t('alignment.fusionFailed', { ...names, reason: errorText(error) }), kind: 'error' });
    });
  };
  const fusePet = (pet: Series, ct: Series, slotId: string, quiet = false) => {
    if (!shareFrame(ct, pet) && !alignedTransform(alignmentsRef.current, ct, pet)) {
      // Acquired apart: the same patient's are aligned first; another patient's never.
      if (!samePatient(ct, pet)) { say('notice.fusionOtherPatient', 'error'); return; }
      if (!frameOf(ct) || !frameOf(pet)) { say('notice.fusionNoFrame', 'error'); return; }
      alignForFusion(pet, ct, slotId);
      return;
    }
    setFusionId(null);
    const request = ++fusionRequest.current;
    void acquireVolume(pet).then(volume => {
      if (request !== fusionRequest.current || !mounted.current) return;
      if (sourceFrameOnly(volume)) { say('notice.fusionPetTooLarge', 'info'); return; }
      setFusionId(pet.id);
      if (fusionDeviceModeRef.current && pet.modality === 'PT') applyDeviceLook(pet, slotId);
      else if (fusionDeviceModeRef.current && pet.modality === 'NM') {
        setFusionPalette(SPECT_LOOK.palette); setFusionBlend(SPECT_LOOK.blend); setFusionOpacity(SPECT_LOOK.opacity); setFusionUpper(SPECT_LOOK.upper);
      }
      const own = pet.modality !== 'PT' || petHasSuv(pet);
      if (!quiet || !own) say(own ? 'notice.fusionStarted' : 'notice.fusionNoSuv', 'info', { pet: seriesName(pet), ct: seriesName(ct) }, true);
    }).catch(error => setNotice({ message: errorText(error), kind: 'error' }));
  };
  /** Fuses `pet` in the active pane: over the CT shown there, or, when the pane shows a PET, over the CT acquired with it. */
  const fuseInActive = (pet: Series) => {
    const slotId = activeIdRef.current, slot = slotsRef.current.find(item => item.id === slotId);
    const shown = slot?.seriesId ? seriesRef.current.find(item => item.id === slot.seriesId) : undefined;
    if (!shown) return;
    // The fusion arrangement's roles (src/arrangements/builtin.ts): the CT acquired with the PET.
    const base = fusesAsOverlay(shown) ? findRole(FUSION.roles.ct, seriesRef.current, pet) : shown;
    if (!base) { say('notice.fusionNoCt', 'info', undefined, true); return; }
    if (base.id !== shown.id) assignSeries(slotId, base);
    // Asked for in this pane: it shows the fusion even where an arrangement kept it plain.
    else setSlots(current => current.map(item => item.id === slotId && item.unfused ? { ...item, unfused: false } : item));
    fusePet(pet, base, slotId);
  };
  /** The fusion button, as in VEAcom Next: the PET (or the CT) of the active pane's study is found by itself. */
  const startFusion = () => {
    setShowFusion(true);
    const slot = slotsRef.current.find(item => item.id === activeIdRef.current);
    const shown = slot?.seriesId ? seriesRef.current.find(item => item.id === slot.seriesId) : undefined;
    if (!shown) return;
    if (shown.modality === 'MR') {
      // MR over MR, as other viewers draw it: the series before contrast in colour at half opacity over the one after it.
      // The colour shows in the pane after contrast, where enhancing tissue, bright there, shines through.
      const beside = slotsRef.current.flatMap(other => other.id !== slot?.id && other.seriesId ? seriesRef.current.filter(item => item.id === other.seriesId) : []);
      const partner = mrPartner(shown, beside, item => shareFrame(shown, item));
      if (!partner) {
        // No MR beside it: a PET or SPECT of the same patient acquired apart is aligned to it and fused.
        const apart = overlayApart(shown);
        if (apart) fuseInActive(apart); else say('notice.fusionNoMr', 'info', undefined, true);
        return;
      }
      const [after, before] = contrastPair(shown, partner);
      const target = slotsRef.current.find(other => other.seriesId === after.id);
      if (!target) return;
      setFusionPalette('hot'); setFusionOpacity(0.5); setFusionUpper(5); setFusionBlend('classic');
      activateSlot(target.id);
      setSlots(current => current.map(item => item.id === target.id && item.unfused ? { ...item, unfused: false } : item));
      fusePet(before, after, target.id);
      return;
    }
    const pet = fusesAsOverlay(shown) ? shown : findRole(FUSION.roles.overlay, seriesRef.current, shown) ?? overlayApart(shown);
    if (!pet) { say('notice.fusionNoPet', 'info', undefined, true); return; }
    fuseInActive(pet);
  };
  /** For a CT or MR with no PET or SPECT acquired with it: one of the same patient acquired apart, which is aligned to it
   * first. One aligned already, else the study nearest in time; attenuation-corrected and with more slices first. */
  const overlayApart = (base: Series): Series | null => {
    const days = (item: Series) => Math.abs(Date.parse(item.studyDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')) - Date.parse(base.studyDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')));
    const found = seriesRef.current.filter(item => fusesAsOverlay(item) && !shareFrame(item, base) && samePatient(item, base) && frameOf(item) && frameOf(base));
    const rank = (item: Series) => [Number(Boolean(alignedTransform(alignmentsRef.current, base, item))), -(Number.isFinite(days(item)) ? days(item) : Infinity),
      Number(!/\bNAC\b|NO-?AC/i.test(item.description)), item.dimensions[2]];
    return found.reduce<Series | null>((best, item) => {
      if (!best) return item;
      const a = rank(item), b = rank(best);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? item : best;
      return best;
    }, null);
  };
  const stopFusion = () => { fusionRequest.current++; setShowFusion(false); setFusionId(null); };

  // Automatic PET fusion records no click. Requested reading screens record the control the reader pressed.
  const arrangementName = (plan: Plan) => plan.arrangement.name ? t(plan.arrangement.name) : '';
  /** The panes on screen as an arrangement sees them: each one's series, view, and the PET fused over it. */
  const shownPanes = () => slotsRef.current.map(slot => {
    const item = slot.seriesId ? seriesRef.current.find(value => value.id === slot.seriesId) : undefined;
    const pet = fusionIdRef.current ? seriesRef.current.find(value => value.id === fusionIdRef.current) : undefined;
    const fused = Boolean(item && pet && !slot.unfused && fusesOver(item, pet, alignmentsRef.current));
    return { seriesId: slot.seriesId, view: slot.view, fusedWith: fused && pet ? pet.id : null };
  });
  /** The arranged screen is still the one on screen: the same panes, in any order. */
  const stillArranged = () => {
    const current = arranged.current, ids = slotsRef.current.map(slot => slot.id);
    return Boolean(current && ids.length === current.slotIds.length && ids.every(id => current.slotIds.includes(id)));
  };
  /** Keeps the arranged screen as the reader rearranged it: the next time it is laid out, it opens so. */
  const keepArrangement = (slotId: string) => {
    const current = arranged.current;
    const variant = current && stillArranged() ? deriveKept(current.plan, shownPanes(), layoutRef.current) : null;
    if (!current || !variant) return;
    saveKept({ ...keptRef.current, [current.plan.arrangement.id]: variant });
    const slot = slotsRef.current.find(item => item.id === slotId);
    if (slot?.seriesId) setPaneToast({ slotId, seriesId: slot.seriesId, text: t('arrangement.kept', { name: arrangementName(current.plan) }) });
  };
  const offerKeepForSlot = (slotId: string) => {
    const current = arranged.current, slot = slotsRef.current.find(item => item.id === slotId);
    if (!current || !slot?.seriesId || !stillArranged() || !deriveKept(current.plan, shownPanes(), layoutRef.current)) return;
    setPaneToast({ slotId, seriesId: slot.seriesId, text: t('arrangement.keepOffer', { name: arrangementName(current.plan) }), sticky: true,
      keepAction: 'keep', onKeep: () => { setPaneToast(null); keepArrangement(slotId); } });
  };
  /** Lays a study out as `plan` says: its panes, links and fusion, with a note in the first pane naming it and Undo. Undo
   * puts back what was on screen. For a study that opened so, it puts `first` in the active pane (what VEAcom shows
   * without arrangements) and offers to keep that instead; a screen the reader asked for is simply taken back. */
  const applyArrangement = (plan: Plan, first?: Series, session?: readonly Series[]) => {
    const before = { slots: slotsRef.current, layout: layoutRef.current, activeId: activeIdRef.current, hidden: hiddenSlots.current, maximized: maximizedRef.current,
      alignments: alignmentsRef.current, mpr: beforeMpr.current, isMpr, arranged: arranged.current,
      linked: settingsRef.current.linked, fusionId: fusionIdRef.current, fusion: fusionState.current, crosshair: crosshairRef.current, crosshairSeriesId: crosshairSeriesIdRef.current };
    beforeMpr.current = null; setIsMpr(false); setMaximized(null); setMenu(null);
    const [rows, columns] = plan.grid ?? layoutRef.current, current = slotsRef.current;
    const separateScales = plan.arrangement.scale === 'shared' && !sharesSuvScale(plan);
    let panes: Slot[] = Array.from({ length: rows * columns }, (_, index) => {
      const pane = plan.panes.at(index), id = current[index]?.id ?? crypto.randomUUID();
      if (!pane) return { id, seriesId: null, view: { ...DEFAULT_VIEW, pan: [0, 0] } };
      const spec = separateScales && !plan.arrangement.kept ? { ...pane.spec, display: { ...pane.spec.display, window: undefined } } : pane.spec;
      return { id, seriesId: pane.series.id, view: paneView(pane.series, spec, defaultView(pane.series)), unfused: spec.show !== 'fused' };
    });
    // The panes in one frame of reference start where the first one opens, so they page together from there.
    const lead = plan.panes.at(0);
    if (lead) {
      const at = getPlaneFrame(lead.series, panes[0].view).center;
      panes = panes.map((slot, index) => {
        const pane = plan.panes.at(index);
        return index && pane && !pane.spec.view && shareFrame(lead.series, pane.series) && !isProjection(pane.series, slot.view) ? { ...slot, view: { ...slot.view, slice: sliceAtWorld(pane.series, slot.view, at) } } : slot;
      });
    }
    setLayout([rows, columns]); setSlots(panes); activateSlot(panes[0].id);
    for (const item of new Set(plan.panes.map(pane => pane.series))) loadPaneImage(item);
    // Linking as the arrangement says (Undo puts it back): `none` lets each pane page on its own.
    const linked = plan.arrangement.link === 'crosshair' ? true : plan.arrangement.link === 'none' ? false : settingsRef.current.linked;
    if (linked !== settingsRef.current.linked) setSettings(state => ({ ...state, linked }));
    const fusedAt = plan.panes.findIndex(pane => pane.spec.show === 'fused'), over = fusedAt >= 0 ? plan.roles[plan.panes[fusedAt].spec.over ?? ''] : undefined;
    if (over) { setShowFusion(true); fusePet(over, plan.panes[fusedAt].series, panes[fusedAt].id, true); }
    else stopFusion();
    arranged.current = { plan, slotIds: panes.map(slot => slot.id) };
    const name = arrangementName(plan), notice = plan.arrangement.notice;
    const undo = () => {
      arranged.current = first ? null : before.arranged; fusionRequest.current++;
      beforeMpr.current = before.mpr; setIsMpr(before.isMpr);
      hiddenSlots.current = before.hidden; setMaximized(before.maximized);
      setSlots(before.slots); setLayout(before.layout); activateSlot(before.activeId);
      setSettings(state => state.linked === before.linked ? state : { ...state, linked: before.linked });
      setFusionId(before.fusionId); setShowFusion(before.fusion.show); setFusionOpacity(before.fusion.opacity); setFusionUpper(before.fusion.upper);
      setFusionPalette(before.fusion.palette); setFusionBlend(before.fusion.blend); setFusionDeviceMode(before.fusion.deviceMode);
      setCrosshair(before.crosshair); setCrosshairSeriesId(before.crosshairSeriesId); changeAlignments(before.alignments);
      for (const id of new Set(before.slots.map(slot => slot.seriesId))) {
        const item = seriesRef.current.find(value => value.id === id); loadPaneImage(item);
      }
      if (!first) {
        const shown = before.slots.find(slot => slot.id === before.activeId)?.seriesId;
        if (shown) setPaneToast({ slotId: before.activeId, seriesId: shown, text: t('arrangement.undone', { name }) });
        return;
      }
      if (before.slots.find(slot => slot.id === before.activeId)?.seriesId !== first.id) assignSeries(before.activeId, first);
      setPaneToast({ slotId: before.activeId, seriesId: first.id, text: t('arrangement.undone', { name }), sticky: true, keepAction: 'keep-plain', onKeep: () => {
        saveKept({ ...keptRef.current, [plan.arrangement.id]: { off: true } });
        setPaneToast({ slotId: before.activeId, seriesId: first.id, text: t('arrangement.keptPlain', { name }) });
      } });
    };
    const text = separateScales ? t('arrangement.petFollowUp.separate') : plan.arrangement.kept ? t('arrangement.yours', { name }) : notice ? t(notice.key, notice.params) : name;
    // An arrangement that aligns two frames of reference (the PET follow-up: the prior's to this study's, by their CTs)
    // says so in its note: under way, then what was done. Panes in the aligned frame go to where the first pane is.
    // Every series loaded, the study just read among them (the list itself is not yet up to date when a study opens).
    const pair = alignmentPair(plan, session ?? seriesRef.current), done = pair ? alignedTransform(alignmentsRef.current, pair.fixed, pair.moving) : null;
    const toast: PaneToast = { slotId: panes[0].id, seriesId: plan.panes[0].series.id, text: pair && !done ? `${text} ${t('alignment.priorRunning')}` : text,
      sticky: true, undoAction: 'arrangement', onUndo: undo };
    setPaneToast(toast);
    if (pair && done) pageAligned(panes[0].id, alignmentsRef.current);
    else if (pair) alignArranged(plan, pair, toast, text, panes[0].id);
  };
  /** Panes whose series lie in a frame of reference aligned to the pane `leadId`'s go to where it is in the patient, as
   * linked panes do; a whole-volume MIP keeps its turn. */
  const pageAligned = (leadId: string, aligned: readonly Alignment[]) => {
    const lead = slotsRef.current.find(slot => slot.id === leadId), leadSeries = lead?.seriesId ? seriesRef.current.find(item => item.id === lead.seriesId) : undefined;
    if (!lead || !leadSeries || isProjection(leadSeries, lead.view)) return;
    const at = getPlaneFrame(leadSeries, lead.view).center;
    setSlots(current => current.map(slot => {
      const other = slot.seriesId ? seriesRef.current.find(item => item.id === slot.seriesId) : undefined;
      const toOther = other && slot.id !== leadId && !isProjection(other, slot.view) ? alignedTransform(aligned, leadSeries, other) : null;
      if (!other || !toOther) return slot;
      const slice = coveredSlice({ series: other, view: slot.view }, applyPoint(toOther, at));
      return slice === null || slice === slot.view.slice ? slot : { ...slot, view: { ...slot.view, slice } };
    }));
  };
  /** The alignment an arrangement asks for, found by the engine while its screen is shown. Its note says what was done
   * while it is still there; otherwise a note in the aligned pane says it, with Undo. A failure leaves the two to be
   * linked by hand, as before alignment. */
  const alignArranged = (plan: Plan, pair: { fixed: Series; moving: Series }, toast: PaneToast, text: string, leadId: string) => {
    void align(pair.fixed, pair.moving).then(found => {
      if (!mounted.current || arranged.current?.plan !== plan) return;
      const next = withAlignment(alignmentsRef.current, found);
      changeAlignments(next);
      pageAligned(leadId, next);
      const said = t('alignment.priorDone', { by: modalityName(pair.moving), ...moved(found) });
      if (paneToastRef.current === toast) { setPaneToast({ ...toast, text: `${text} ${said}` }); return; }
      const role = plan.arrangement.align?.role, shown = role ? slotsRef.current.find(slot => slot.seriesId === plan.roles[role]?.id) : undefined;
      if (shown?.seriesId) setPaneToast({ slotId: shown.id, seriesId: shown.seriesId, text: said, sticky: true, undoAction: 'alignment',
        onUndo: () => { setPaneToast(null); changeAlignments(withoutAlignment(alignmentsRef.current, found)); } });
    }).catch(error => {
      if (!mounted.current || arranged.current?.plan !== plan) return;
      const said = t('alignment.priorFailed', { reason: errorText(error) });
      if (paneToastRef.current === toast) setPaneToast({ ...toast, text: `${text} ${said}` });
      else setNotice({ message: said, kind: 'info' });
    });
  };
  const openImportedStudy = (first: Series, study: Series[], keepShown = false, session: Series[] = study) => {
    arranged.current = null;
    // The session's other studies are where a prior study's role is found (the PET follow-up screen).
    const plan = matchOnOpen(keptRef.current, { series: study, session });
    // Without an arrangement, a series already shown (opened while the study was still read) stays as it is.
    if (plan) applyArrangement(plan, first, session); else if (!keepShown) assignSeries(activeIdRef.current, first);
  };
  /** Back to VEAcom's own arrangements: what the reader kept is forgotten. */
  const forgetKept = () => { saveKept({}); say('arrangement.forgotten', 'info', undefined, true); };
  const keptNames = Object.entries(kept).flatMap(([id, variant]: [string, KeptVariant]) => {
    const name = BUILTIN_ARRANGEMENTS.find(item => item.id === id)?.name;
    return name ? ['off' in variant ? t('arrangement.keptOff', { name: t(name) }) : t(name)] : [];
  });
  const adjustFusion = (next: { upperSuv: number; opacity: number }) => {
    setFusionUpper(Math.round(next.upperSuv * 10) / 10); setFusionOpacity(Math.round(next.opacity * 100) / 100); setFusionDeviceMode(false);
  };
  /** A handle dragged in the three-plane MPR: the pane `slotId` turns to `oblique`, still through the crosshair. */
  const rotatePlane = (slotId: string, oblique: [number, number]) => {
    const slot = slotsRef.current.find(item => item.id === slotId), volume = slot?.seriesId ? displayVolumesRef.current.get(slot.seriesId) : undefined;
    if (!slot || !volume) return;
    const pivot = crosshairRef.current ?? getPlaneFrame(volume.series, slot.view).center, next = { ...slot.view, mode: 'mpr' as const, oblique };
    updateView(slotId, { mode: 'mpr', oblique, slice: sliceAtWorld(volume.series, next, pivot) });
  };
  const resetView = () => {
    const slot = slotsRef.current.find(item => item.id === activeIdRef.current), volume = slot?.seriesId ? displayVolumesRef.current.get(slot.seriesId) : undefined;
    if (slot && volume) {
      remember();
      // A whole-volume MIP stays one, seen from the front again.
      const next = { ...defaultView(volume.series), mode: slot.view.mode, plane: slot.view.plane, projection: slot.view.projection };
      updateView(slot.id, { ...next, slice: isProjection(volume.series, next) ? 0 : sliceAtWorld(volume.series, next, getPlaneFrame(volume.series, slot.view).center) });
    }
  };
  const chooseLayout = (rows: number, columns: number) => {
    beforeMpr.current = null; setIsMpr(false); setMaximized(null);
    setMenu(null); setLayout([rows, columns]);
    const current = slotsRef.current, known = new Set(seriesRef.current.map(item => item.id));
    const active = current.find(slot => slot.id === activeIdRef.current) ?? current[0];
    const returning = hiddenSlots.current.filter(slot => !current.some(shown => shown.id === slot.id))
      .map(slot => slot.seriesId && !known.has(slot.seriesId) ? { ...slot, seriesId: null } : slot);
    const pool = [active, ...current.filter(slot => slot.id !== active.id), ...returning];
    const shown = pool.slice(0, rows * columns);
    while (shown.length < rows * columns) shown.push(makeSlot());
    hiddenSlots.current = pool.slice(rows * columns).filter(slot => slot.seriesId);
    setSlots(shown);
    for (const slot of shown) {
      const item = slot.seriesId && !current.some(other => other.id === slot.id) ? seriesRef.current.find(value => value.id === slot.seriesId) : undefined;
      loadPaneImage(item);
    }
  };
  const restoreBeforeMpr = () => {
    const saved = beforeMpr.current; if (!saved) return;
    beforeMpr.current = null; setSlots(saved.slots); setLayout(saved.layout); setActiveId(saved.activeId); activeIdRef.current = saved.activeId; setIsMpr(false);
    setCrosshair(saved.crosshair); setCrosshairSeriesId(saved.crosshairSeriesId);
    for (const id of new Set(saved.slots.map(slot => slot.seriesId))) {
      const item = seriesRef.current.find(value => value.id === id); loadPaneImage(item);
    }
  };
  /** The panes and layout from before the maximize, the maximized pane as it is now; empty panes come back empty. */
  const unmaximized = () => {
    const saved = maximizedRef.current; if (!saved) return null;
    const known = new Set(seriesRef.current.map(item => item.id));
    const slots = saved.order.map(id => slotsRef.current.find(slot => slot.id === id) ?? hiddenSlots.current.find(slot => slot.id === id) ?? { ...makeSlot(), id })
      .map(slot => slot.seriesId && !known.has(slot.seriesId) ? { ...slot, seriesId: null } : slot);
    return { saved, slots };
  };
  const closeSlot = (id: string) => {
    if (beforeMpr.current) { restoreBeforeMpr(); return; }
    const back = unmaximized();
    if (back) {
      setMaximized(null);
      hiddenSlots.current = hiddenSlots.current.filter(slot => !back.saved.order.includes(slot.id));
      for (const slot of back.slots) {
        const item = slot.id !== id && slot.seriesId ? seriesRef.current.find(value => value.id === slot.seriesId) : undefined;
        loadPaneImage(item);
      }
    }
    const remaining = (back ? back.slots : slotsRef.current).filter(slot => slot.id !== id);
    if (!remaining.length) { setSlots(current => current.map(slot => ({ ...slot, seriesId: null }))); return; }
    // Every close takes one pane away, empty or not: the grid keeps its columns while it can, and the last pane
    // widens over a gap in the bottom row.
    const columns = Math.min((back ? back.saved.layout : layoutRef.current)[1], remaining.length), rows = Math.ceil(remaining.length / columns);
    setSlots(remaining); setLayout([rows, columns]);
    if (activeIdRef.current === id || !remaining.some(slot => slot.id === activeIdRef.current)) activateSlot((remaining.find(slot => slot.seriesId) ?? remaining[0]).id);
  };
  const closePane = (id: string) => { closeSlot(id); focusImage(); };
  const swapPanes = (from: string, to: string) => {
    setSlots(current => {
      const a = current.findIndex(slot => slot.id === from), b = current.findIndex(slot => slot.id === to);
      if (a < 0 || b < 0) return current;
      const next = [...current]; [next[a], next[b]] = [next[b], next[a]]; return next;
    });
    // Moving a pane of an arranged screen offers to keep it so (where the moved pane lands).
    if (arranged.current?.slotIds.includes(from) && arranged.current.slotIds.includes(to)) offerKeep.current(from);
  };
  const maximizeSlot = (id: string) => {
    const slot = slotsRef.current.find(item => item.id === id); if (!slot) return;
    // The layout it came from, to go back to (not from the three-plane MPR, which has its own way back).
    setMaximized(slotsRef.current.length > 1 && !beforeMpr.current ? { id, layout: layoutRef.current, order: slotsRef.current.map(item => item.id) } : null);
    if (!beforeMpr.current) hiddenSlots.current = [...slotsRef.current.filter(item => item.id !== id && item.seriesId), ...hiddenSlots.current];
    setSlots([slot]); setActiveId(id); setLayout([1, 1]); beforeMpr.current = null; setIsMpr(false);
  };
  const restoreLayout = () => {
    const back = unmaximized(); if (!back) return;
    hiddenSlots.current = hiddenSlots.current.filter(slot => !back.saved.order.includes(slot.id));
    setSlots(back.slots); setLayout(back.saved.layout); setMaximized(null); activateSlot(back.saved.id);
    for (const slot of back.slots) {
      const item = slot.seriesId ? seriesRef.current.find(value => value.id === slot.seriesId) : undefined;
      loadPaneImage(item);
    }
    focusImage();
  };
  const maximizePane = (id: string) => { maximizeSlot(id); focusImage(); };
  const mpr = () => {
    if (beforeMpr.current) { restoreBeforeMpr(); return; }
    if (!activeVolume || !canReconstruct) return;
    beforeMpr.current = { slots: slotsRef.current, layout, activeId: activeIdRef.current, crosshair, crosshairSeriesId }; setIsMpr(true);
    const origin = crosshairSeriesId ? volumesRef.current.get(crosshairSeriesId) : undefined;
    // The crosshair, in this series' own coordinates when it was set in a frame of reference aligned to it.
    const toActive = crosshair && origin ? transformBetween(alignmentsRef.current, origin.series, activeVolume.series) : null;
    const center = crosshair && toActive ? applyPoint(toActive, crosshair) : indexToWorld(activeVolume.series, activeVolume.series.dimensions.map(n => (n - 1) / 2) as Vec3);
    const panes = (['axial', 'coronal', 'sagittal'] as Plane[]).map(plane => ({ id: crypto.randomUUID(), seriesId: activeVolume.series.id,
      view: { ...defaultView(activeVolume.series), windowMode: activeSlot.view.windowMode, windowCenter: activeSlot.view.windowCenter, windowWidth: activeSlot.view.windowWidth, mode: 'mpr' as const, plane, slice: sliceAtWorld(activeVolume.series, plane, center), pan: [0, 0] as [number, number] } }));
    setSlots(panes); setActiveId(panes[0].id); setLayout([1, 3]); setCrosshair(center); setCrosshairSeriesId(activeVolume.series.id); setSettings(current => ({ ...current, linked: true }));
  };

  const exportImage = async (kind: 'png' | 'jpeg', all: boolean) => {
    setMenu(null);
    const element = all ? gridRef.current : gridRef.current?.querySelector<HTMLElement>('.viewport-cell.is-active');
    if (!element) return;
    const filename = `VEAcom-${all ? 'layout' : 'image'}.${kind === 'jpeg' ? 'jpg' : kind}`;
    let path;
    try { path = await saveBytes(filename, await captureImage(element, kind)); }
    catch (error) { usage.milestone('export-image-done', 'error'); setNotice({ message: errorText(error), kind: 'error' }); return; }
    usage.milestone('export-image-done', path ? 'ok' : 'cancel');
    if (path) say('notice.imageExported', 'info', undefined, true);
  };
  /** ⌘C / Ctrl+C: the active pane, or with Shift the whole layout, onto the clipboard as a picture of what is drawn.
   * Its corners read as they do with patient details hidden, so a paste elsewhere carries no name or number. */
  const copyImage = async (all: boolean) => {
    const element = all ? gridRef.current : gridRef.current?.querySelector<HTMLElement>('.viewport-cell.is-active');
    if (!element) return;
    const picture = captureViewportCanvas(element, { hidePatientData: true });
    const [capture, copy] = await Promise.allSettled([picture, copyCanvas(picture)]);
    if (capture.status === 'rejected' || copy.status === 'rejected') {
      usage.milestone('copy-image-done', 'error');
      if (capture.status === 'rejected') setNotice({ message: errorText(capture.reason), kind: 'error' });
      else say('notice.imageNotCopied', 'error');
      return;
    }
    usage.milestone('copy-image-done', 'ok');
    say(all ? 'notice.layoutCopied' : 'notice.imageCopied', 'info', undefined, true);
  };
  const openExport = (mode: ExportDialogProps['mode']) => {
    setMenu(null);
    // An export going on in the background: its window comes back instead of a new one.
    if (exportBackground || exportBusy) { setExportBackground(false); return; }
    if ((mode === 'video' || mode === 'images') && activeVolume?.sourceFrameIndex !== undefined) { say('notice.videoAfterLoad', 'info'); return; }
    if ((mode === 'video' || mode === 'images') && activeVolume) {
      const viewport = gridRef.current?.querySelector<HTMLElement>('.viewport-cell.is-active');
      if (!viewport) return;
      const id = activeSlot.id;
      // 1:1 is the series' own pixel grid: the acquired images, or a plain (not oblique) plane of an axial stack.
      const plain = usesSourceFrames(activeVolume.series, activeSlot.view) || (activeSlot.view.plane === 'axial' && !activeSlot.view.oblique?.some(Boolean));
      // Cine stops: the export pages the pane itself.
      setPlaying(false);
      setExportVideoTarget({ viewport, seriesId: activeVolume.series.id, originalSlice: activeSlot.view.slice, frameCount: sliceCount(activeVolume.series, activeSlot.view),
        nativeSize: plain ? { width: activeVolume.series.dimensions[0], height: activeVolume.series.dimensions[1] } : undefined, backwards: pagesBackwards(activeVolume.series, activeSlot.view),
        setSlice: slice => setSlots(current => current.map(slot => slot.id === id ? { ...slot, view: { ...slot.view, slice } } : slot)) });
    } else setExportVideoTarget(undefined);
    setExportFor(activeSeries?.id ?? null);
    setExportMode(mode);
  };

  const openAssessment = async () => {
    if (!activeSeries || !ASSESSMENT_AVAILABLE) return;
    setShowAssessment(true); setAssessmentBehind(false);
    const candidates = series.filter(item => studyKey(item) === studyKey(activeSeries) && item.modality === 'MR' && item.components !== 3);
    const admitted: Series[] = [];
    let bytes = 0;
    for (const item of candidates) {
      const estimate = item.dimensions.reduce((a, b) => a * b, 1) * (item.pixelType === 'float64' ? 8 : item.pixelType === 'uint8' ? 1 : item.pixelType === 'float32' || !item.pixelType ? 4 : 2);
      if (bytes + estimate <= 512 * 1024 * 1024) { admitted.push(item); bytes += estimate; }
    }
    assessmentPinnedIds.current = new Set(admitted.map(item => item.id));
    if (admitted.length < candidates.length) say('notice.assessmentLimit', 'info');
    for (const item of admitted) {
      if (!assessmentPinnedIds.current.has(item.id)) break;
      try { await acquireVolume(item); }
      catch (error) { say('notice.couldNotLoad', 'error', { description: item.description, error: errorText(error) }); }
    }
  };
  const requestAssessmentRoi = () => {
    if (!assessmentPreviousTool.current) { assessmentPreviousTool.current = toolRef.current; assessmentPreviousLeft.current = settingsRef.current.mouseBindings.left; }
    setTool('polygon');
  };
  const finishAssessmentRoi = () => {
    if (assessmentPreviousTool.current) {
      updateTool(assessmentPreviousTool.current);
      const left = assessmentPreviousLeft.current;
      setSettings(current => {
        const mouseBindings = { ...current.mouseBindings };
        if (left) mouseBindings.left = left; else delete mouseBindings.left;
        return { ...current, mouseBindings };
      });
    }
    assessmentPreviousTool.current = null;
    assessmentPreviousLeft.current = undefined;
  };
  const closeAssessment = () => { setShowAssessment(false); setAssessmentBehind(false); assessmentPinnedIds.current.clear(); finishAssessmentRoi(); };
  const open3d = () => {
    const bounds = gridRef.current?.querySelector('.viewport-cell.is-active .viewport-content')?.getBoundingClientRect();
    if (bounds) setVolumeViewportSize([bounds.width, bounds.height]);
    setShow3d(true);
  };
  const applyCalibration = () => {
    if (!activeSeries) return;
    const line = activeAnnotations.find(annotation => annotation.id === calibrationLine) ?? activeAnnotations.find(annotation => annotation.type === 'length');
    const length = line?.points.length === 2 ? distanceMm(line.points[0], line.points[1]) : null;
    const known = Number(calibrationLength);
    if (!length || !Number.isFinite(known) || known <= 0) { say('notice.calibrationInvalid', 'error'); return; }
    setCalibrationScales(current => ({ ...current, [activeSeries.id]: known / length }));
    setSettings(current => ({ ...current, measurementUnits: 'auto' }));
    say('notice.calibrated', 'info', undefined, true);
  };

  const setPanel = (panel: Panel) => setSettings(current => ({ ...current, panel }));
  /** Shows an inspector tab, in front of the assessment when it is open (the assessment keeps its input). */
  function showPanel(panel: Panel) { if (showAssessment) setAssessmentBehind(true); setPanel(panel); }
  const windowRequest = useRef(0);
  const applyMeasuredWindow = async (automatic: boolean) => {
    if (!activeVolume || framePending || activeVolume.series.components === 3) return;
    const request = ++windowRequest.current, { view, id } = activeSlot;
    const current = () => mounted.current && request === windowRequest.current && slotsRef.current.find(slot => slot.id === id)?.view === view
      && displayVolumesRef.current.get(activeVolume.series.id)?.data === activeVolume.data;
    try {
      const reconstruction = !usesSourceFrames(activeVolume.series, view) && !isProjection(activeVolume.series, view) && !view.slab;
      const range = reconstruction ? await reconstructedWindow(activeVolume, view, automatic, current)
        : activeVolume.series.sourceRevision ? await measureWindow(activeVolume.series, view, automatic)
        : (automatic ? autoWindow : fullRangeWindow)(activeVolume, usesSourceFrames(activeVolume.series, view) ? view.slice : undefined);
      if (!range || !current()) return;
      if (automatic) autoWindows.current.set(id, `${Math.round(range.windowWidth)}/${Math.round(range.windowCenter)}`);
      updateView(id, range);
    } catch (error) { if (current()) setNotice({ message: errorText(error), kind: 'error' }); }
  };
  const applyAutoWindow = () => { void applyMeasuredWindow(true); };
  const applyFullRange = () => { void applyMeasuredWindow(false); };
  const applyDicomWindow = () => { if (activeSeries) updateView(activeSlot.id, { windowMode: 'dicom', ...(!activeVolume || !usesSourceFrames(activeVolume.series, activeSlot.view) ? { windowCenter: activeSeries.windowCenter, windowWidth: activeSeries.windowWidth } : {}) }); };

  const keydown = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const field = target.matches('input, textarea, select, [contenteditable="true"]');
    if ((exportMode && !exportBackground) || capturingRef.current) return;
    const key = (id: string, burst = false) => usage.action(id, 'key', { burst });
    // Esc closes the innermost layer only (menus and dialogs handle their own Esc first). In 3D it closes the view
    // from its sliders and lists too, as its Close button shows; elsewhere a field keeps Esc for itself.
    // The assessment holds typed input, so Esc closes it only from inside the panel; the checklist too, as it sits
    // in the same place (its answers stay). Both can be open, so each answers only Esc from inside itself.
    if (event.key === 'Escape') {
      // 3D closes from its sliders, lists and buttons; in a number or text field Esc stays with the field.
      if (show3d) { if (!target.matches('textarea, [contenteditable="true"], input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"])')) setShow3d(false); }
      else if (field) return;
      else if (target.closest('[data-testid="preop-checklist"]')) setChecklistOpen(false);
      else if (assessmentShown) { if (target.closest('.assessment-overlay')) closeAssessment(); }
      else { setMenu(null); setShowHelp(false); }
      return;
    }
    // Fields keep their keys; the 3D view and open dialogs (Help, updates) take none of the image shortcuts.
    if (field || show3d || target.closest('dialog[open]')) return;
    const plainKey = !event.metaKey && !event.ctrlKey && !event.altKey;
    // An open menu owns plain keys and arrows; modifier shortcuts (⌘Z, ⌘O…) keep working. Single keys can be
    // turned off, and they never fire from the assessment form (its heading takes focus when it opens).
    if (plainKey && (menu || (event.key.length === 1 && (!settingsRef.current.singleKeys || target.closest('.assessment-overlay'))))) return;
    if (event.key === 'F12') {
      event.preventDefault(); const flag = event.ctrlKey || event.metaKey ? 'showReferences' : event.shiftKey ? 'hidePatientData' : event.altKey ? 'hideMeasurements' : 'showOverlay';
      key(`overlay-${kebab(flag)}`); setSettings(current => ({ ...current, [flag]: !current[flag] })); return;
    }
    if ((event.metaKey || event.ctrlKey) && event.altKey && (event.key.toLowerCase() === 't' || event.code === 'KeyT')) {
      event.preventDefault(); showPanel('tags');
      if (showAssessment) focusSoon('[data-testid="inspector-tab-tags"]');
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); key('open-folder'); void openImport(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') { event.preventDefault(); if (activeSeries) { if (event.shiftKey) { key('export-media'); openExport('media'); } else { key('tool-export'); openExport('dicom'); } } return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); key(event.shiftKey ? 'redo' : 'undo'); undo(event.shiftKey); return; }
    // ⌘C / Ctrl+C copies the picture, with Shift the whole layout. Text the reader selected is copied as text, as anywhere.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'c') {
      if (!activeSeries || window.getSelection()?.toString()) return;
      event.preventDefault(); key(event.shiftKey ? 'copy-layout' : 'copy-image'); void copyImage(event.shiftKey); return;
    }
    // Letters, 0, m, ? and + / − only without ⌘, Ctrl or Alt (Alt + letter types characters and opens menus).
    if (event.key === 'F1') { event.preventDefault(); key('show-help'); setShowHelp(true); return; }
    // Space opens the quick menu over the images; on a button, a link or a menu it presses that, as it should.
    if (plainKey && event.key === ' ' && activeVolume && !target.closest('button, a, summary, [role="button"], [role^="menuitem"], [role="tab"], [role="option"]')) {
      event.preventDefault(); key('quick-menu');
      // At the pointer wherever it is (over the series list too, not far from it), and with the pointer over the
      // toolbar just below it, so the toolbar stays in sight; in the middle of the active pane only when the pointer
      // has not been seen, as when working from the keyboard.
      const at = pointerAt.current, grid = gridRef.current?.getBoundingClientRect();
      const cell = gridRef.current?.querySelector('.viewport-cell.is-active')?.getBoundingClientRect() ?? grid;
      setQuick(at ? { x: at.x, y: grid ? Math.max(at.y, grid.top) : at.y } : cell ? { x: cell.left + cell.width / 2, y: cell.top + cell.height / 2 } : { x: 200, y: 200 });
      return;
    }
    if (plainKey) {
      // VEAcom 1.x's window keys: 0 the series' own window, 1 the slice's full range, 2-9 the CT presets,
      // Shift+A the automatic window, I invert.
      if (activeVolume && activeVolume.series.components !== 3) {
        if (event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); key('preset-auto'); applyAutoWindow(); return; }
        if (!event.shiftKey && /^[0-9]$/.test(event.key)) {
          event.preventDefault();
          if (event.key === '0') { key('preset-dicom'); applyDicomWindow(); return; }
          if (event.key === '1') { key('preset-full-range'); applyFullRange(); return; }
          const preset = PRESETS.find(item => item.digit === event.key);
          if (preset) { key(`preset-${kebab(preset.key)}`); updateView(activeSlot.id, { windowCenter: preset.center, windowWidth: preset.width }); }
          return;
        }
        if (!event.shiftKey && event.key.toLowerCase() === 'i') { event.preventDefault(); key('invert'); updateView(activeSlot.id, { inverted: !activeSlot.view.inverted }); return; }
      }
      const tools: Partial<Record<string, Tool>> = { s: 'scroll', w: 'window', p: 'pan', z: 'zoom', l: 'length', a: 'angle', e: 'ellipse', r: 'rectangle', c: 'crosshair', t: 'text', v: 'sphere' };
      const chosen = tools[event.key.toLowerCase()];
      if (chosen) {
        key(`tool-${chosen}`);
        if (MEASURE_TOOLS.includes(chosen)) toggleMeasure(chosen); else setTool(chosen);
        return;
      }
      if (event.key === 'm') { key('tool-mpr'); mpr(); return; }
      if (event.key === '?') { event.preventDefault(); key('show-help'); setShowHelp(true); return; }
      if (activeVolume && ['+', '=', '-', '_'].includes(event.key)) {
        const view = activeSlot.view, zoom = Math.max(0.1, Math.min(30, view.zoom * (event.key === '-' || event.key === '_' ? 1 / 1.25 : 1.25))), scale = zoom / view.zoom;
        key('key-zoom', true); updateView(activeSlot.id, { zoom, pan: [view.pan[0] * scale, view.pan[1] * scale] }); return;
      }
    }
    // Slice keys belong to the image: panels, lists and the toolbar keep their own arrow keys and scrolling.
    if (target.closest('.inspector, .series-browser, .assessment-overlay, [role="toolbar"], [role="tablist"], [role="dialog"], .popover-menu')) return;
    if (activeVolume && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)) {
      key('key-slice', true);
      event.preventDefault(); const direction = (event.key === 'ArrowUp' || event.key === 'PageUp' ? -1 : 1) * (pagesBackwards(activeVolume.series, activeSlot.view) ? -1 : 1);
      const stride = event.key.startsWith('Page') ? 10 : 1;
      updateView(activeSlot.id, { slice: stepSlice(activeVolume.series, activeSlot.view, direction * stride) });
    }
  });
  useEffect(() => {
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);

  const testState = useEffectEvent(() => ({
    activeSeriesId: activeSlot.seriesId, dimensions: activeVolume?.series.dimensions ?? null,
    fullVolumeLoaded: Boolean(activeSeries && activeVolume && activeVolume.sourceFrameIndex === undefined && fullyLoaded.current.has(activeSeries.id)),
    sourceFrameIndex: activeVolume?.sourceFrameIndex ?? null, displayedView: activeVolume ? renderedView(activeVolume, activeSlot.view) : null,
    sourceFramesOnly: activeVolume?.series.sourceFramesOnly === true, pendingLoads: pending.current.size, loadedSeriesIds: [...fullyLoaded.current], cachedBytes: [...volumesRef.current.values()].reduce((sum, volume) => sum + volume.data.byteLength, 0),
    series: series.map(item => ({ id: item.id, description: item.description, dimensions: item.dimensions, modality: item.modality, windowCenter: item.windowCenter, windowWidth: item.windowWidth,
      ...(item.windowFromPixels ? { windowFromPixels: true } : {}), ...(item.segmentation ? { segmentation: item.segmentation } : {}),
      // For the gated SPECT check: each gate's phase and where its slices lie.
      ...(item.phase ? { phase: item.phase } : {}), canReconstruct: item.canReconstruct, origin: item.origin, spacing: item.spacing, direction: item.direction })),
    shownSegmentations, segmentationFrames: Object.fromEntries(segmentationOverlays.map(overlay => [overlay.id, overlay.frames.length])), view: activeSlot.view,
    // For the arrangement checks: the panes on screen and what each one shows.
    // For the registration checks: the frames aligned, and whether the engine is still finding one.
    aligning, alignments: alignments.map(item => ({ fixedSeriesId: item.fixedSeriesId, movingSeriesId: item.movingSeriesId, matrix: [...item.matrix], adjusted: adjusted(item),
      similarity: item.similarity, similarityBefore: item.similarityBefore, overlap: item.overlap })),
    layout, linked: settings.linked, fusionId, panes: slots.map(slot => ({ id: slot.id, seriesId: slot.seriesId, plane: slot.view.plane, mode: slot.view.mode ?? 'mpr',
      projection: slot.view.projection ?? null, slice: slot.view.slice, inverted: slot.view.inverted, unfused: slot.unfused === true,
      windowCenter: slot.view.windowCenter, windowWidth: slot.view.windowWidth })),
    graphics, graphicsError: graphicsError == null ? null : errorText(graphicsError)
  }));
  const setTestView = useEffectEvent((patch: Partial<ViewState>) => updateView(activeSlot.id, patch));
  useEffect(() => {
    const harness = {
      state: testState,
      importPaths: importStudies,
      selectSeries: (id: string) => { const item = seriesRef.current.find(value => value.id === id); if (item) selectSeries(item); },
      setView: setTestView,
      setTool: (next: Tool) => { if (isTool(next)) setTool(next); },
      /** Usage events recorded in this window, after closing the action still settling (desktop click budgets). */
      usage: () => { usage.settle(); return usage.events(); },
    };
    Object.defineProperty(window, '__VEACOM_TEST__', { value: harness, configurable: true });
    return () => { Reflect.deleteProperty(window, '__VEACOM_TEST__'); };
  }, [importStudies, selectSeries, setTool]);

  // Usage timings: the coarse state each action leaves behind (src/usage/tracker.ts). Facet values are only
  // compared in this window to name what an action changed; of the state, only the classes below are sent.
  const usageSnapshot = useEffectEvent((): UsageSnapshot => {
    const surface: Surface = show3d && activeVolume ? '3d' : showAssessment ? 'assessment' : series.length ? 'viewer' : 'welcome';
    const panes = slots.map(slot => {
      const volume = volumeForSlot(slot), shown = volume ? renderedView(volume, slot.view) : slot.view;
      const plane = !volume ? 'none' : usesSourceFrames(volume.series, shown) ? 'source' : shown.oblique?.some(Boolean) ? 'oblique' : shown.plane;
      return { slot, volume, shown, plane, index: slot.seriesId ? series.findIndex(item => item.id === slot.seriesId) + 1 : 0 };
    });
    const active = panes.find(pane => pane.slot.id === activeId) ?? panes[0];
    const count = active.volume ? sliceCount(active.volume.series, active.shown) : 0;
    const join = (values: unknown[]) => values.map(value => String(value ?? '')).join('|');
    return {
      surface, layout: isMpr ? 'mpr' : `${layout[0]}x${layout[1]}`, tool, modality: activeSeries?.modality ?? 'none',
      plane: active.plane, window: windowClass(active.volume, active.slot.view, autoWindows.current, active.slot.id),
      wl: active.volume && active.volume.series.components !== 3 ? `${Math.round(active.shown.windowWidth)}/${Math.round(active.shown.windowCenter)}` : undefined,
      zoom: active.volume ? active.shown.zoom : undefined, seriesIndex: active.index,
      slicePct: !active.volume ? -1 : count > 1 ? Math.round(Math.min(1, Math.max(0, active.shown.slice / (count - 1))) * 100) : 0,
      facets: {
        // A PET fused over the images is a series on screen too.
        series: `${join(panes.map(pane => pane.index))}${fusion ? `+${series.findIndex(item => item.id === fusion.volume.series.id) + 1}` : ''}`, plane: join(panes.map(pane => pane.plane)),
        window: join(panes.map(pane => pane.volume ? `${Math.round(pane.shown.windowWidth)}/${Math.round(pane.shown.windowCenter)}/${pane.shown.voiLut ?? ''}/${pane.slot.view.windowMode ?? ''}` : '')),
        zoom: join(panes.map(pane => pane.shown.zoom.toFixed(2))), layout: `${layout.join('x')}|${isMpr}`, screen: surface,
        slice: join(panes.map(pane => Math.round(pane.shown.slice))), pan: join(panes.map(pane => pane.shown.pan.map(Math.round).join(':'))),
        tool: `${tool}|${JSON.stringify(settings.mouseBindings)}`,
        marks: join(Object.entries(annotations).map(([id, list]) => `${id}:${list.length}:${list.at(-1)?.id ?? ''}`)),
        orient: join(panes.map(pane => `${pane.shown.rotation}/${pane.shown.flipX}/${pane.shown.flipY}`)),
        color: join(panes.map(pane => `${pane.shown.palette ?? 'gray'}/${pane.shown.inverted}`)),
        cross: `${crosshair?.map(value => value.toFixed(1)).join(':') ?? ''}|${settings.showCrosshair}`,
        seg: shownSegmentations.join('|'), fusion: join([showFusion, fusionId, fusionOpacity, fusionUpper, fusionPalette, fusionBlend]),
        link: String(settings.linked), overlay: join([settings.showOverlay, settings.showReferences, settings.hidePatientData, settings.hideMeasurements]),
        // The pre-op checklist is docked beside the images like the inspector.
        panel: join([settings.panel, activeId, checklistShown]), menu: menu ?? '', dialog: join([exportMode, showHelp, showUpdates, notice?.message, graphicsNoticeOpen, cancelling]),
        lang: locale, prefs: JSON.stringify([settings.wheelSensitivity, settings.reverseWheel, settings.measurementUnits, calibrationScales, calibrationLine, calibrationLength, usageConsent]),
      },
    };
  });
  useEffect(() => {
    usage.setStateProvider(() => usageSnapshot());
    const bridge = window.veacom;
    usage.setSink(bridge?.usageRecord ? (events, final) => {
      if (final) bridge.usageFinal?.(events);
      else void bridge.usageRecord?.(events).catch(() => { /* Usage timings never interrupt the viewer. */ });
    } : null);
    void bridge?.usageStatus?.().then(status => { if (mounted.current) { setUsageConsent(status.consent); usage.setSharing(status.consent === 'granted'); } })
      .catch(() => { /* Nothing is shared without an answer. */ });
    const removeListeners = installUsageListeners(document);
    const frame = (event: Event) => usage.frameShown((event as CustomEvent<{ seriesId?: string }>).detail.seriesId);
    const unload = () => { usage.closeStudy('quit'); usage.flush(true); };
    window.addEventListener('veacom:frame', frame);
    window.addEventListener('pagehide', unload);
    return () => { removeListeners(); window.removeEventListener('veacom:frame', frame); window.removeEventListener('pagehide', unload); usage.setSink(null); usage.setStateProvider(() => null); };
  }, []);
  // After every render: a state change nobody asked for (a series finished loading) is reported as such.
  useEffect(() => { usage.observe(); });
  // How images are drawn changes every duration: sent with the timings (software drawing is far slower).
  useEffect(() => { if (graphics && usageConsent === 'granted') void window.veacom?.usageMachine?.({ renderer: graphics.renderer, software: graphics.software }).catch(() => {}); }, [graphics, usageConsent]);
  const chooseUsage = async (value: 'granted' | 'denied') => {
    try {
      const consent = await writeUsageConsent(value);
      setUsageConsent(consent); usage.setSharing(consent === 'granted');
    } catch (error) { setNotice({ message: errorText(error), kind: 'error' }); }
  };

  const seriesActions = useRef({ select: selectSeries, remove: removeFromList });
  // Pending engine work and input handlers read the last committed workspace.
  useLayoutEffect(() => {
    seriesActions.current = { select: selectSeries, remove: removeFromList };
    seriesRef.current = series;
    slotsRef.current = slots;
    activeIdRef.current = activeId;
    layoutRef.current = layout;
    isMprRef.current = isMpr;
    annotationRef.current = annotations;
    settingsRef.current = settings;
    toolRef.current = tool;
    crosshairRef.current = crosshair;
    crosshairSeriesIdRef.current = crosshairSeriesId;
    exportBackgroundRef.current = exportBackground;
    capturingRef.current = capturing;
    maximizedRef.current = maximized;
    keptRef.current = kept;
    shownSegmentationsRef.current = shownSegmentations;
    fusionIdRef.current = fusionId;
    alignmentsRef.current = alignments;
    paneToastRef.current = paneToast;
    fusionDeviceModeRef.current = fusionDeviceMode;
    displayVolumesRef.current = displayVolumes;
    fusionState.current = { show: showFusion, opacity: fusionOpacity, upper: fusionUpper, palette: fusionPalette, blend: fusionBlend, deviceMode: fusionDeviceMode };
    offerKeep.current = offerKeepForSlot;
    openStudy.current = openImportedStudy;
    endMpr.current = restoreBeforeMpr;
  });

  const toggleMenu = (next: Exclude<Menu, null>) => setMenu(current => current === next ? null : next);
  const closeMenu = () => setMenu(null);
  const act = (fn: () => void) => { fn(); setMenu(null); };
  /** MPR > Thick slab, as in VEAcom Next: on acquired slices it goes to the same place in the reconstructed volume;
   * turned off in the plane the series was acquired in, it goes back to its own slices there. */
  const chooseSlab = (mode: SlabMode | null, thickness?: number) => {
    if (!activeVolume || !activeVolume.series.canReconstruct || activeVolume.series.sourceFramesOnly || activeVolume.series.components === 3 || activeProjection) return;
    const series = activeVolume.series, view = activeSlot.view, center = getPlaneFrame(series, view).center;
    if (thickness !== undefined) setSlabThickness(thickness);
    if (mode === null) {
      if (!view.slab) return;
      const back = view.plane === acquiredPlane(series) && !view.oblique?.some(Boolean);
      const next = back ? { ...view, slab: undefined, mode: 'source' as const, plane: 'axial' as const, oblique: undefined } : { ...view, slab: undefined };
      updateView(activeSlot.id, { ...next, slice: back ? sliceAtWorld(series, next, center) : view.slice });
      return;
    }
    const slab = { mode, thickness: thickness ?? slabThickness };
    if (usesSourceFrames(series, view)) {
      const plane = acquiredPlane(series) ?? 'axial', next = { ...view, mode: 'mpr' as const, plane, oblique: [0, 0] as [number, number], slab };
      updateView(activeSlot.id, { ...next, slice: sliceAtWorld(series, next, center) });
    } else updateView(activeSlot.id, { slab });
  };
  // Beside 3D the panes have under half the width: three side by side become two over one. In an image area taller
  // than wide, a layout with more columns than rows is shown the other way round (1 × 2 one pane under the other), so
  // the panes stay near square; the chosen layout stays as it is and comes back when the area widens.
  const gridShape: [number, number] = show3d && layout[0] === 1 && layout[1] === 3 && slots.length === 3 ? [2, 2]
    : gridTall && layout[1] > layout[0] ? [layout[1], layout[0]] : layout;
  const canPlay = Boolean(!capturing && activeVolume && sliceCount(activeVolume.series, activeSlot.view) > 1);
  // A whole-volume MIP in the active pane: its slab is the whole volume already.
  const activeProjection = Boolean(activeVolume && isProjection(activeVolume.series, activeDisplayView));
  const mprWhy = canReconstruct || isMpr || !activeSeries ? undefined : loadingIds.has(activeSeries.id) || activeVolume?.sourceFrameIndex !== undefined ? t('mpr.whyLoading')
    : activeSeries.dimensions[2] < 2 ? t('mpr.whySingle') : (activeVolume ? warningTexts(activeVolume.series, locale)[0] : undefined) ?? t('mpr.whyNoVolume');
  const slabItems = (close: (fn: () => void) => void) => <>
    <MenuDivider /><MenuHeading>{t('slab.title')}</MenuHeading>
    <MenuItem action="menu-option" kind="radio" checked={!activeDisplayView.slab} disabled={!canReconstruct} onClick={() => close(() => chooseSlab(null))}>{t('slab.off')}</MenuItem>
    {SLAB_MODES.map(mode => <MenuItem action="menu-option" key={mode} kind="radio" checked={activeDisplayView.slab?.mode === mode} disabled={!canReconstruct} onClick={() => close(() => chooseSlab(mode))}>{t(`slab.${mode}` as const)}</MenuItem>)}
    {SLAB_THICKNESSES.map(mm => <MenuItem action="menu-option" key={mm} kind="radio" checked={(activeDisplayView.slab?.thickness ?? slabThickness) === mm} disabled={!canReconstruct} onClick={() => close(() => chooseSlab(activeDisplayView.slab?.mode ?? null, mm))}>{t('slab.thickness', { thickness: mm })}</MenuItem>)}
  </>;
  /** The mouse as it came: the left button with the chosen tool, middle pans, right zooms, the wheel pages slices. */
  const resetMouse = () => setSettings(current => ({ ...current, mouseBindings: { middle: 'pan', right: 'zoom' }, wheelAction: 'scroll' }));
  const setSectionOpen = (id: DisplaySection, open: boolean) => {
    if (openSections.has(id) === open) return;
    const next = new Set(openSections);
    if (open) next.add(id); else next.delete(id);
    setOpenSections(next);
    try { localStorage.setItem(SECTION_STORAGE, JSON.stringify([...next])); } catch { /* Storage may be disabled by the host. */ }
  };
  const toggleSection = (id: DisplaySection) => setSectionOpen(id, !openSections.has(id));
  const openPanelSection = (id: DisplaySection) => {
    showPanel('display');
    setSectionOpen(id, true);
    requestAnimationFrame(() => {
      const toggle = document.getElementById(`section-${id}-toggle`);
      toggle?.scrollIntoView({ block: 'start' });
      toggle?.focus({ preventScroll: true });
    });
  };
  const mod = modifierKey(navigator.platform);
  const singleKey = (key?: string) => settings.singleKeys ? key : undefined;
  const combo = (...keys: string[]) => mod === '⌘' ? keys.join('') : keys.map(key => key === '⇧' ? 'Shift' : key).join('+');
  const noStudy = series.length === 0, noImage = !activeVolume, rgb = activeVolume?.series.components === 3;
  // What each mouse button really does; Viewport falls back to pan / zoom for middle / right.
  const effectiveBinding = (button: MouseButton): Tool => settings.mouseBindings[button] ?? (button === 'middle' ? 'pan' : button === 'right' ? 'zoom' : tool);
  const currentPreset = activeVolume && !rgb ? presetFor(activeDisplayView.windowWidth, activeDisplayView.windowCenter) : undefined;
  // The presets follow the series' quantity: a PET with SUV is offered SUV 0–5, 0–7 and 0–10 instead of the CT windows.
  const suvActive = Boolean(activeVolume && !rgb && quantityScale(activeVolume.series, 'SUV'));
  const currentSuvPreset = activeVolume && suvActive ? suvPresetFor(activeVolume.series, activeDisplayView) : undefined;
  const applySuvPreset = (to: number) => {
    const window = activeVolume ? windowFor(activeVolume.series, { unit: 'SUV', from: 0, to }) : null;
    if (window) { updateView(activeSlot.id, { ...window, windowMode: 'manual' }); offerKeep.current(activeSlot.id); }
  };
  const windowPresetName = noImage || rgb ? 'W/L' : suvActive ? (currentSuvPreset ? t(`preset.${currentSuvPreset.key}` as const) : suvWindowText(activeVolume.series, activeDisplayView) || t('toolbar.customWindow'))
    : currentPreset ? presetName(currentPreset) : t('toolbar.customWindow');
  // Exactly the measurements the pane shows: the same rule draws them (shownOnView), whatever tilt they were drawn on.
  const deleteOnSlice = () => activeSeries && changeAnnotations(activeSeries.id, activeAnnotations.filter(annotation => !activeVolume || !shownOnView(annotation, activeVolume.series, activeDisplayView)));
  // A plane or the acquired slices chosen from the MPR menu end a whole-volume MIP.
  const showPlane = (plane: Plane) => { if (activeVolume) { const center = getPlaneFrame(activeVolume.series, activeSlot.view).center; updateView(activeSlot.id, { mode: 'mpr', plane, slice: sliceAtWorld(activeVolume.series, plane, center), oblique: [0, 0], projection: undefined }); } };
  const showAcquired = () => { if (activeVolume) { const center = getPlaneFrame(activeVolume.series, activeSlot.view).center, next = { ...activeSlot.view, mode: 'source' as const, plane: 'axial' as const, oblique: undefined, projection: undefined }; updateView(activeSlot.id, { ...next, slice: sliceAtWorld(activeVolume.series, next, center) }); } };
  // An MR fuses with another MR beside it, or with a PET or SPECT of the same patient acquired apart, aligned first.
  const mrApart = Boolean(mrActive && activeSeries && overlayChoices.some(item => !shareFrame(item, activeSeries)));
  const fusionDisabled = !activeVolume || activeVolume.sourceFrameIndex !== undefined || activeVolume.series.sourceFramesOnly || (mrActive ? !mrBeside.length && !mrApart : !petSeries.length);
  const fusionWhy = mrActive ? (mrBeside.length || mrApart ? undefined : t('fusion.whyMrPane')) : petSeries.length ? undefined : t('fusion.whyNoVolume');
  // The nuclear medicine screen of the active pane's study (PET follow-up, PET/CT, whole body or SPECT/CT, as kept),
  // offered beside the fusion button. Only the prior role can use another study in the session.
  const activeStudy = activeSeries ? activeStudyContext(activeSeries, series) : null;
  const nmScreen = activeStudy ? match(withKept(kept, NUCLEAR_MEDICINE_SCREENS), 'screen', activeStudy) : null;
  const openNmScreen = () => { if (nmScreen) applyArrangement(nmScreen); };
  // Every option reads as "shown": a tick means the item is visible on the image.
  const overlayOptions = [{ key: 'showOverlay', label: t('toolbar.showOverlay'), shortcut: 'F12', shown: settings.showOverlay }, { key: 'showReferences', label: t('toolbar.showReferences'), shortcut: combo(mod, 'F12'), shown: settings.showReferences },
    { key: 'hidePatientData', label: t('toolbar.patientInfo'), shortcut: combo('⇧', 'F12'), shown: !settings.hidePatientData }, { key: 'hideMeasurements', label: t('toolbar.measurementsShown'), shortcut: combo(mod === '⌘' ? '⌥' : 'Alt', 'F12'), shown: !settings.hideMeasurements },
    { key: 'showScale', label: t('toolbar.showScale'), shortcut: undefined, shown: settings.showScale }] as const;
  const overlayItems = <>{overlayOptions.map(option => <MenuItem action="display-choice" key={option.key} kind="checkbox" checked={option.shown} shortcut={option.shortcut} onClick={() => setSettings(current => ({ ...current, [option.key]: !current[option.key] }))}>{option.label}</MenuItem>)}
    <MenuDivider /><MenuItem action="toolbar-show-tags" icon={<Tag size={16} />} shortcut={combo(mod, mod === '⌘' ? '⌥' : 'Alt', 'T')} onClick={() => act(() => showPanel('tags'))}>{t('toolbar.showTags')}</MenuItem></>;
  const orientationItems = () => <>
    <MenuItem action="toolbar-rotate-clockwise" icon={<RotateCwSquare size={16} />} onClick={() => act(() => updateView(activeSlot.id, { rotation: activeSlot.view.rotation + 90 }))}>{t('toolbar.rotateClockwise')}</MenuItem>
    <MenuItem action="toolbar-rotate-counterclockwise" icon={<RotateCcwSquare size={16} />} onClick={() => act(() => updateView(activeSlot.id, { rotation: activeSlot.view.rotation - 90 }))}>{t('toolbar.rotateCounterclockwise')}</MenuItem>
    <MenuDivider />
    <MenuItem action="toolbar-flip-horizontal" kind="checkbox" icon={<FlipHorizontal2 size={16} />} checked={activeSlot.view.flipX} onClick={() => act(() => updateView(activeSlot.id, { flipX: !activeSlot.view.flipX }))}>{t('toolbar.flipHorizontal')}</MenuItem>
    <MenuItem action="toolbar-flip-vertical" kind="checkbox" icon={<FlipVertical2 size={16} />} checked={activeSlot.view.flipY} onClick={() => act(() => updateView(activeSlot.id, { flipY: !activeSlot.view.flipY }))}>{t('toolbar.flipVertical')}</MenuItem>
    <MenuDivider />
    <MenuItem action="toolbar-reset-orientation" icon={<RotateCcw size={16} />} onClick={() => act(() => updateView(activeSlot.id, { rotation: 0, flipX: false, flipY: false }))}>{t('toolbar.resetOrientation')}</MenuItem></>;
  const toolbarStart: ToolbarItem[] = [
    { id: 'open', group: 'file', node: <div className="menu-anchor" data-menu>
      <ToolButton icon={<FolderOpen size={18} />} label={t('toolbar.open')} shortcut={`${mod}+O`} testId="tool-open" popup="menu" indicator expanded={menu === 'import'} onClick={() => toggleMenu('import')} />
      {menu === 'import' && <Menu label={t('toolbar.open')} onClose={closeMenu}>
        {bridgeCan('importWindow') && <>
          <MenuItem action="import-dialog" icon={<FolderOpen size={16} />} shortcut={combo(mod, 'O')} onClick={() => void openImport()}>{t('toolbar.openWindow')}</MenuItem>
          <MenuDivider />
        </>}
        {/* Without the import window (the browser), the shortcut opens a folder. */}
        <MenuItem action="toolbar-open-folder" icon={<FolderOpen size={16} />} shortcut={bridgeCan('importWindow') ? undefined : combo(mod, 'O')} onClick={() => void open('folder')}>{t('toolbar.openFolder')}</MenuItem>
        <MenuItem action="toolbar-open-files" icon={<Files size={16} />} onClick={() => void open('files')}>{t('toolbar.openFiles')}</MenuItem>
        <MenuItem action="toolbar-open-archive" icon={<FileArchive size={16} />} onClick={() => void open('archive')}>{t('toolbar.openArchive')}</MenuItem>
      </Menu>}</div> },
    ...(bridgeCan('discImport') ? [{ id: 'cd', group: 'file', node: <ToolButton icon={<Glyph name="cd" />} label={t('toolbar.openDisc')} testId="tool-open-disc" onClick={() => void openImport('disc')} /> } satisfies ToolbarItem] : []),
    { id: 'export', group: 'file', node: <ToolButton icon={<Upload size={18} />} label={t('toolbar.export')} shortcut={`${mod}+E`} testId="tool-export" disabled={!activeSeries} onClick={() => openExport('dicom')} /> },
    // In VEAcom Next's order: left, right, the wheel's scrolling, then the middle button's press.
    ...(['left', 'right', 'wheel', 'middle'] as const).map((button): ToolbarItem => {
      const name = `mouse-${button}` as const, binding = button === 'wheel' ? null : effectiveBinding(button);
      const glyph = button === 'wheel' ? WHEEL_GLYPHS[settings.wheelAction] : TOOL_GLYPHS[binding!];
      const doing = button === 'wheel' ? t(`wheel.${settings.wheelAction}` as const) : toolLabel(binding!);
      const bind = (value: Tool | 'selected') => setSettings(current => { const bindings = { ...current.mouseBindings }; if (value === 'selected') delete bindings[button as MouseButton]; else bindings[button as MouseButton] = value; return { ...current, mouseBindings: bindings }; });
      const items = () => button === 'wheel' ? <>
        {WHEEL_ACTIONS.map(action => <MenuItem action="menu-option" key={action} kind="radio" checked={settings.wheelAction === action} icon={<Glyph name={WHEEL_GLYPHS[action]} size={16} />} onClick={() => act(() => setSettings(current => ({ ...current, wheelAction: action })))}>{t(`wheel.${action}` as const)}</MenuItem>)}
        <MenuDivider /><MenuItem action="menu-option" kind="checkbox" checked={settings.reverseWheel} onClick={() => act(() => setSettings(current => ({ ...current, reverseWheel: !current.reverseWheel })))}>{t('inspector.reverseScroll')}</MenuItem>
      </> : <>
        {button === 'left' && <MenuItem action="menu-option" kind="radio" checked={!settings.mouseBindings.left} icon={<Glyph name={TOOL_GLYPHS[tool]} size={16} />} onClick={() => act(() => bind('selected'))}>{t('toolbar.selectedToolCurrent', { tool: toolLabel(tool) })}</MenuItem>}
        {BUTTON_ACTIONS.map(action => <MenuItem action="menu-option" key={action} kind="radio" checked={settings.mouseBindings[button] === action || (button !== 'left' && !settings.mouseBindings[button] && effectiveBinding(button) === action)} icon={<Glyph name={TOOL_GLYPHS[action]} size={16} />} onClick={() => act(() => bind(action))}>{toolLabel(action)}</MenuItem>)}
      </>;
      return { id: name, group: 'mouse', priority: 7, node: <div className="menu-anchor" data-menu>
        <ToolButton icon={<MouseGlyph button={button} glyph={glyph} />} label={`${t(`mouse.${button}.heading` as const)}: ${doing}`} testId={`tool-mouse-${button}`} popup="menu" indicator expanded={menu === name} onClick={() => toggleMenu(name)} />
        {menu === name && <Menu label={t(`mouse.${button}.heading` as const)} onClose={closeMenu}>{items()}
          <MenuDivider /><MenuItem action="mouse-reset" onClick={() => act(resetMouse)}>{t('mouse.reset')}</MenuItem>
          <MenuItem action="menu-option" onClick={() => act(() => openPanelSection('mouse'))}>{t('toolbar.mouseSettings')}</MenuItem>
        </Menu>}</div> };
    }),
    { id: 'series', group: 'series', priority: 1, node: <div className="menu-anchor" data-menu>
      <ToolButton icon={<List size={18} />} label={t('toolbar.chooseSeries')} testId="tool-series" popup="menu" indicator expanded={menu === 'series'} disabled={!series.length} onClick={() => toggleMenu('series')} />
      {menu === 'series' && <Menu label={t('toolbar.series')} onClose={closeMenu} className="series-menu"><SeriesMenuItems series={series} activeId={activeSeries?.id} shown={shownSegmentationIds} onSelect={selectFromMenu} /></Menu>}</div> },
    { id: 'layout', group: 'layout', priority: 11, node: <div className="menu-anchor" data-menu>
      <ToolButton icon={<LayoutIcon rows={layout[0]} columns={layout[1]} />} label={`${t('toolbar.layout')}: ${layout[0]} × ${layout[1]}`} testId="tool-layout" popup="dialog" indicator expanded={menu === 'layout'} disabled={noStudy} onClick={() => toggleMenu('layout')} />
      {menu === 'layout' && <Popover label={t('toolbar.layout')} onClose={closeMenu} className="layout-popover">
        <LayoutPicker layout={layout} label={t('toolbar.layoutPreview')} choiceLabel={(rows, columns) => t('toolbar.layoutChoice', { rows, columns })} onChoose={chooseLayout} />
        {activeStudy && PET_LAYOUTS.map(([rule, action, key]) => {
          const plan = match([rule], rule.when, activeStudy);
          if (!plan) return null;
          return <button className="secondary-button compact" type="button" data-action={action} key={action}
            onClick={() => applyArrangement(plan)}>{t(key)}</button>;
        })}
      </Popover>}</div> },
    { id: 'measure', group: 'measure', node: <div className="menu-anchor" data-menu><div className="split">
        <ToolButton icon={measureIcon(lastMeasure, 18, true)} label={t('toolbar.measurement', { tool: toolLabel(lastMeasure) })} shortcut={singleKey(TOOL_KEYS[lastMeasure])} testId="tool-measure" disabled={noStudy} active={MEASURE_TOOLS.includes(tool)} onClick={() => toggleMeasure(MEASURE_TOOLS.includes(tool) ? tool : lastMeasure)} />
        <MenuChevron label={t('toolbar.chooseMeasurement')} expanded={menu === 'measure'} testId="tool-measure-menu" disabled={noStudy} onClick={() => toggleMenu('measure')} />
      </div>{menu === 'measure' && <Menu label={t('toolbar.chooseMeasurement')} onClose={closeMenu}>
        {MEASURE_TOOLS.map(item => <MenuItem action="tool-select" key={item} kind="radio" checked={tool === item} icon={measureIcon(item, 16)} shortcut={singleKey(TOOL_KEYS[item])} onClick={() => act(() => toggleMeasure(item))}>{toolLabel(item)}</MenuItem>)}
        <MenuDivider />
        <MenuItem action="undo" disabled={!historyCount[0]} icon={<Undo2 size={16} />} shortcut={combo(mod, 'Z')} onClick={() => act(() => undo())}>{t('toolbar.undoMeasurement')}</MenuItem>
        <MenuItem action="redo" disabled={!historyCount[1]} icon={<Redo2 size={16} />} shortcut={combo(mod, '⇧', 'Z')} onClick={() => act(() => undo(true))}>{t('toolbar.redoMeasurement')}</MenuItem>
        <MenuItem disabled={!activeAnnotations.length} icon={<Trash2 size={16} />} testId="tool-delete-slice" onClick={() => act(deleteOnSlice)}>{t('toolbar.deleteSlice')}</MenuItem>
        <MenuDivider />
        <MenuItem action="toolbar-units-calibration" onClick={() => act(() => openPanelSection('units'))}>{t('toolbar.unitsCalibration')}</MenuItem>
        <MenuItem action="toolbar-measurement-list" onClick={() => act(() => showPanel('measurements'))}>{t('toolbar.measurementList')}</MenuItem>
      </Menu>}</div> },
    { id: 'delete', group: 'measure', priority: 0, node: <ToolButton icon={<Trash2 size={18} />} label={t('toolbar.deleteSlice')} action="toolbar-delete-slice" disabled={!activeAnnotations.length} onClick={deleteOnSlice} /> },
    { id: 'presets', group: 'window', node: <div className="menu-anchor" data-menu>
      <ToolButton icon={<Glyph name="presets" />} label={`${t('toolbar.windowPresets')}: ${windowPresetName}`} testId="tool-window-presets" popup="menu" indicator expanded={menu === 'preset'} disabled={noImage || rgb} onClick={() => toggleMenu('preset')} />
      {menu === 'preset' && <Menu label={t('toolbar.windowPresets')} onClose={closeMenu}>
        {suvActive && SUV_PRESETS.map(preset => <MenuItem key={preset.key} kind="radio" checked={currentSuvPreset?.key === preset.key} testId={`preset-${preset.key}`} onClick={() => act(() => applySuvPreset(preset.to))}>{t(`preset.${preset.key}` as const)}</MenuItem>)}
        {!suvActive && PRESETS.map(preset => <MenuItem key={preset.key} kind="radio" checked={currentPreset?.key === preset.key} testId={`preset-${preset.key}`} meta={`${preset.width} / ${preset.center}`} shortcut={singleKey(preset.digit)} onClick={() => act(() => { updateView(activeSlot.id, { windowCenter: preset.center, windowWidth: preset.width }); offerKeep.current(activeSlot.id); })}>{presetName(preset)}</MenuItem>)}
        <MenuDivider />
        <MenuItem testId="preset-full-range" disabled={framePending} shortcut={singleKey('1')} onClick={() => act(applyFullRange)}>{t('preset.fullRange')}</MenuItem>
        <MenuItem testId="preset-auto" disabled={framePending} shortcut={singleKey('Shift+A')} onClick={() => act(applyAutoWindow)}>{t('toolbar.autoWindow')}</MenuItem>
        <MenuItem testId="preset-dicom" shortcut={singleKey('0')} onClick={() => act(applyDicomWindow)}>{t('toolbar.dicomWindow')}</MenuItem>
        <MenuDivider />
        <MenuItem action="toolbar-window-palette-orientation" icon={<SlidersHorizontal size={16} />} onClick={() => act(() => openPanelSection('window'))}>{t('toolbar.windowPaletteOrientation')}</MenuItem>
      </Menu>}</div> },
    ...(petSeries.length || mrFusable || nmScreen ? [    { id: 'fusion', group: 'window', priority: 3, node: <div className="menu-anchor" data-menu><div className="split">
      <ToolButton icon={<Glyph name="fusion" />} label={t(mrActive || !petSeries.some(item => item.modality === 'PT') ? 'toolbar.fusionPlain' : 'toolbar.fusion')} testId="tool-fusion" disabled={fusionDisabled} why={fusionWhy} active={showFusion} onClick={() => showFusion ? stopFusion() : startFusion()} />
      {nmScreen && <MenuChevron label={t('toolbar.fusionMenu')} expanded={menu === 'fusion'} testId="tool-fusion-menu" onClick={() => toggleMenu('fusion')} />}
    </div>{menu === 'fusion' && nmScreen && <Menu label={t('toolbar.fusionMenu')} onClose={closeMenu}>
      <MenuItem action="nm-screen" meta={arrangementName(nmScreen)} onClick={() => act(openNmScreen)}>{t('toolbar.nmScreen')}</MenuItem>
    </Menu>}</div> }] : []),
    { id: 'mpr', group: 'view', priority: 12, node: <div className="menu-anchor" data-menu><div className="split">
      <ToolButton icon={<span className="tool-word">MPR</span>} label={`MPR · ${t('help.mpr')}`} hint={isMpr ? t('toolbar.restorePrevious') : undefined} shortcut={singleKey('M')} testId="tool-mpr" active={isMpr} disabled={!canReconstruct && !isMpr} why={mprWhy} onClick={mpr} />
      <MenuChevron label={t('toolbar.mprPlanes')} expanded={menu === 'mpr'} testId="tool-mpr-menu" disabled={noImage} onClick={() => toggleMenu('mpr')} />
    </div>{menu === 'mpr' && <Menu label={t('toolbar.mprPlanes')} onClose={closeMenu}>
      <MenuItem action="toolbar-acquired-slices" kind="radio" checked={activeVolume ? usesSourceFrames(activeVolume.series, activeDisplayView) : false} disabled={!activeVolume} onClick={() => act(showAcquired)}>{t('toolbar.acquiredSlices')}</MenuItem>
      {(['axial', 'coronal', 'sagittal'] as Plane[]).map(plane => <MenuItem action="menu-option" key={plane} kind="radio" checked={Boolean(activeVolume && !usesSourceFrames(activeVolume.series, activeDisplayView) && activeDisplayView.plane === plane && !activeDisplayView.oblique?.some(Boolean))} disabled={!canReconstruct} onClick={() => act(() => showPlane(plane))}>{t(`plane.${plane}` as const)}</MenuItem>)}
      <MenuDivider />
      <MenuItem action="toolbar-restore-previous" icon={<Columns3 size={16} />} shortcut={singleKey('M')} disabled={!canReconstruct && !isMpr} onClick={() => act(mpr)}>{isMpr ? t('toolbar.restorePrevious') : t('toolbar.threePlanes')}</MenuItem>
      <MenuItem testId="tool-oblique" disabled={!canReconstruct} onClick={() => act(() => openPanelSection('oblique'))}>{t('toolbar.obliqueSettings')}</MenuItem>
    </Menu>}</div> },
    { id: '3d', group: 'view', priority: 10, node: <ToolButton icon={<span className="tool-word">3D</span>} label={t('toolbar.open3d')} testId="tool-3d" active={show3d} disabled={!canReconstruct} why={mprWhy} onClick={open3d} /> },
    { id: 'slab', group: 'view', priority: 9, node: <div className="menu-anchor" data-menu>
      <ToolButton icon={<SlabGlyph on={Boolean(activeDisplayView.slab)} />} label={activeDisplayView.slab ? `${t('slab.title')}: ${t('slab.label', { mode: t(`slab.${activeDisplayView.slab.mode}` as const), thickness: activeDisplayView.slab.thickness })}` : t('slab.title')} testId="tool-slab" popup="menu" indicator active={Boolean(activeDisplayView.slab)} expanded={menu === 'slab'} disabled={!canReconstruct || activeProjection} why={activeProjection ? t('projection.slabWhy') : mprWhy} onClick={() => toggleMenu('slab')} />
      {menu === 'slab' && <Menu label={t('slab.title')} onClose={closeMenu}>{slabItems(act)}</Menu>}</div> },
    { id: 'overlay', group: 'image', priority: 5, node: <div className="menu-anchor" data-menu><div className="split">
      <ToolButton icon={<ScanText size={18} />} label={t('toolbar.showOverlay')} shortcut="F12" testId="tool-overlay" disabled={noStudy} active={settings.showOverlay} onClick={() => setSettings(current => ({ ...current, showOverlay: !current.showOverlay }))} />
      <MenuChevron label={t('toolbar.annotationVisibility')} expanded={menu === 'overlay'} testId="tool-overlay-menu" disabled={noStudy} onClick={() => toggleMenu('overlay')} />
    </div>{menu === 'overlay' && <Menu label={t('toolbar.annotationVisibility')} onClose={closeMenu}>{overlayItems}</Menu>}</div> },
    // Linking means something only with more than one pane: alone, the button is left out.
    ...(slots.length > 1 ? [    { id: 'link', group: 'image', priority: 4, node: <ToolButton icon={<Link2 size={18} />} label={t('toolbar.link')} testId="tool-link" disabled={noStudy} active={settings.linked} onClick={pressLink} /> }] : []),
    { id: 'orientation', group: 'image', priority: 6, node: <div className="menu-anchor" data-menu>
      <ToolButton icon={<Glyph name="mirror" />} label={t('toolbar.orientation')} testId="tool-orientation" popup="menu" indicator expanded={menu === 'orientation'} disabled={noImage} onClick={() => toggleMenu('orientation')} />
      {menu === 'orientation' && <Menu label={t('toolbar.orientation')} onClose={closeMenu}>{orientationItems()}</Menu>}</div> },
    { id: 'assessment', group: 'image', priority: 2, node: opensChecklist ? <ToolButton icon={<Stethoscope size={18} />} label={t('checklist.title')} testId="tool-assessment" active={checklistOpen} onClick={toggleChecklist} />
      : <ToolButton icon={<Stethoscope size={18} />} label={showAssessment && !assessmentShown ? t('toolbar.assessmentBehind') : t('toolbar.assessment')} testId="tool-assessment" active={assessmentShown} className={showAssessment && !assessmentShown ? 'is-behind' : ''} disabled={!activeVolume || !ASSESSMENT_AVAILABLE} why={ASSESSMENT_AVAILABLE ? undefined : t('toolbar.assessmentSoon')} onClick={() => {
        // Shows or hides the assessment; only its own Close button (or Esc inside it) ends it and discards its input.
        if (!showAssessment) void openAssessment();
        else if (assessmentShown) { setAssessmentBehind(true); if (!settings.panel) setPanel('display'); }
        else setAssessmentBehind(false);
      }} /> },
  ];
  const toolbarEnd: ToolbarItem[] = [
    { id: 'tools', group: 'tools', node: <div className="tool-segment">
      <ToolButton icon={<Contrast size={18} />} label={t('tool.window')} shortcut={singleKey('W')} testId="tool-quick-window" disabled={noStudy || rgb} active={tool === 'window'} onClick={() => setTool('window')} />
      <ToolButton icon={<Layers size={18} />} label={t('tool.scroll')} shortcut={singleKey('S')} testId="tool-quick-scroll" disabled={noStudy} active={tool === 'scroll'} onClick={() => setTool('scroll')} />
      <ToolButton icon={<Move size={18} />} label={t('tool.pan')} shortcut={singleKey('P')} testId="tool-quick-pan" disabled={noStudy} active={tool === 'pan'} onClick={() => setTool('pan')} />
      <ToolButton icon={<ZoomIn size={18} />} label={t('tool.zoom')} shortcut={singleKey('Z')} testId="tool-quick-zoom" disabled={noStudy} active={tool === 'zoom'} onClick={() => setTool('zoom')} />
      <ToolButton icon={<Crosshair size={18} />} label={t('tool.crosshair')} shortcut={singleKey('C')} testId="tool-crosshair" disabled={noStudy} active={tool === 'crosshair'} onClick={() => setTool('crosshair')} />
    </div> },
    // The reset beside the tools brings the mouse buttons back to their defaults; the view resets with a double click or
    // the side panel's button.
    { id: 'reset', group: 'tools', priority: 8, node: <ToolButton icon={<RotateCcw size={18} />} label={t('mouse.reset')} testId="mouse-reset" onClick={resetMouse} /> },
    { id: 'panel', group: 'app', node: <ToolButton icon={inspectorShown ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />} label={t('toolbar.inspector')} testId="tool-inspector" active={inspectorShown}
      onClick={() => { if (inspectorShown) setPanel(null); else { if (showAssessment) setAssessmentBehind(true); setPanel(settings.panel ?? 'display'); } }} /> },
    { id: 'help', group: 'app', node: <ToolButton icon={<CircleHelp size={18} />} label={t('toolbar.shortcuts')} shortcut={singleKey('?')} testId="tool-help" onClick={() => setShowHelp(true)} /> },
  ];

  const quickAct = (fn: () => void) => { fn(); setQuick(null); };
  const quickMenu = quick && activeVolume && <div ref={quickRef} className="quick-anchor" style={{ '--pointer-x': `${quick.x}px`, '--pointer-y': `${quick.y}px` } as CSSProperties}>
    <Menu label={t('quick.title')} onClose={() => setQuick(null)} testId="quick-menu" focusItem={false}>
      <MenuHeading>{t('quick.left')}</MenuHeading>
      {/* The left button's tools on one row of VEAcom's pictures; the measurements as a list; the colours as swatches. */}
      <div className="quick-tools" role="group" aria-label={t('quick.left')}>
        {(['window', 'scroll', 'pan', 'zoom', 'crosshair'] as Tool[]).map(item => <button key={item} type="button" role="menuitemradio" tabIndex={-1} aria-checked={tool === item} className="quick-tool" data-action="menu-option"
          disabled={item === 'window' && rgb} aria-label={TOOL_KEYS[item] ? `${toolLabel(item)} (${TOOL_KEYS[item]})` : toolLabel(item)} onClick={() => quickAct(() => setTool(item))}>
          <Glyph name={TOOL_GLYPHS[item]} size={22} /><span>{t(`quick.short.${item}` as 'quick.short.window')}</span></button>)}
      </div>
      <MenuDivider /><MenuHeading>{t('quick.measure')}</MenuHeading>
      {MEASURE_TOOLS.map(item => <MenuItem action="menu-option" key={item} kind="radio" checked={tool === item} icon={<Glyph name={TOOL_GLYPHS[item]} size={18} />} shortcut={TOOL_KEYS[item] ? singleKey(TOOL_KEYS[item]) : undefined} onClick={() => quickAct(() => setTool(item))}>{toolLabel(item)}</MenuItem>)}
      <MenuDivider /><MenuHeading>{t('quick.colour')}</MenuHeading>
      <div className="quick-colours" role="group" aria-label={t('quick.colour')}>
        {(['gray', 'hot', 'ge', 'rainbow'] as const).map(palette => <button key={palette} type="button" role="menuitemradio" tabIndex={-1} aria-checked={(activeSlot.view.palette ?? 'gray') === palette} className="quick-swatch" data-action="menu-option"
          disabled={rgb} aria-label={t(`palette.${palette}` as const)} data-tooltip={t(`palette.${palette}` as const)} style={{ background: PALETTE_SWATCHES[palette] }} onClick={() => quickAct(() => updateView(activeSlot.id, { palette }))} />)}
        <button type="button" role="menuitemcheckbox" tabIndex={-1} aria-checked={activeSlot.view.inverted} className="quick-invert" data-action="menu-option" disabled={rgb} aria-label={t('inspector.invert')} onClick={() => quickAct(() => updateView(activeSlot.id, { inverted: !activeSlot.view.inverted }))}>{t('quick.invert')}</button>
      </div>
    </Menu>
  </div>;
  const noticeBar = notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : undefined} data-testid="notice" data-kind={notice.kind} data-code={notice.code ?? notice.key}><span>{notice.key ? t(notice.key, notice.params) : notice.warnings ? warningTexts(notice.warnings, locale).join(' · ') : notice.message}</span>{notice.action && <button type="button" className="notice-action" data-testid="notice-action" onClick={() => { notice.action?.run(); setNotice(null); focusSoon('[data-annotation-row] .annotation-main', '[data-testid="findings-add"]'); }}>{t(notice.action.label)}</button>}<button type="button" className="notice-dismiss" aria-label={t('notice.dismiss')} data-testid="notice-dismiss" onClick={() => { setNotice(null); focusImage(); }}><X size={14} /></button></div>;

  return <div className="app-shell" data-testid="veacom-app" data-ready={!busy && !connectionError} data-locale={locale}
    onPointerMoveCapture={event => { pointerAt.current = { x: event.clientX, y: event.clientY }; }}
    onPointerDownCapture={event => {
      if (quick && !quickRef.current?.contains(event.target as Node)) setQuick(null);
      if (menu && event.target instanceof Element && !event.target.closest('[data-menu]')) setMenu(null);
    }}>
    {quickMenu}
    <div className={`toolbar-region${show3d ? ' beside-3d' : ''}`} inert={show3d || capturing || undefined} onPointerEnter={() => usage.toolbarHover(true)} onPointerLeave={() => usage.toolbarHover(false)}>
      <Toolbar label={t('toolbar.label')} start={toolbarStart} end={toolbarEnd} moreLabel={t('toolbar.more')} />
    </div>
    <TooltipLayer />
    {/* 3D opens beside the images (as in VEAcom Next): the panes stay in view and in use, so a point picked in
        3D shows in them; the series list and the toolbar wait until 3D closes. */}
    <div className={`workspace${show3d ? ' beside-3d' : ''}`}>
      <SeriesBrowser series={series} activeId={activeSeries?.id ?? null} loadingIds={loadingIds} shownSegmentationIds={shownSegmentationIds} failedIds={failedPreviews}
        actionsRef={seriesActions} inert={show3d || capturing} />
      {/* While a pane's slices are captured for pictures or video, the panes are held still. */}
      <main className="imaging-workspace" inert={(exportBusy && (exportMode === 'images' || exportMode === 'video')) || undefined}>
        {usageConsent === null && <div className="notice usage-consent" role="region" aria-label={t('usage.title')} data-testid="usage-consent"><span>{t('usage.question')}</span><span className="usage-consent-actions"><button type="button" className="secondary-button compact" data-testid="usage-consent-share" onClick={() => void chooseUsage('granted')}>{t('usage.share')}</button><button type="button" className="secondary-button compact" data-testid="usage-consent-decline" onClick={() => void chooseUsage('denied')}>{t('usage.decline')}</button></span></div>}
        {/* Not while a series loads: a strip above the image would push the image down and back up for every series
            opened. That progress, and its Cancel, are in the status bar instead. */}
        {progress && progress.stage !== 'decode' && <div className="operation-progress"><LoaderCircle size={12} className="spin" /><span>{stageLabel(progress.stage)}{progress.total > 0 ? ` · ${progress.completed} / ${progress.total}` : ''}</span><progress aria-label={stageLabel(progress.stage)} max={Math.max(1, progress.total)} value={progress.completed} /><button disabled={cancelling} data-testid="operation-cancel" onClick={cancelProgress}>{cancelling ? t('status.cancelling') : t('common.cancel')}</button></div>}
        {/* From main (#7): no usable graphics driver, or WebGL drawn in software. */}
        {graphicsNoticeOpen && graphicsError != null && <div className="notice error" role="alert" data-testid="graphics-unavailable-notice"><span>{errorText(graphicsError)}</span><button type="button" className="notice-dismiss" aria-label={t('notice.dismiss')} data-testid="graphics-notice-dismiss" onClick={() => { setGraphicsNoticeOpen(false); focusImage(); }}><X size={14} /></button></div>}
        {graphicsNoticeOpen && graphics?.software && <div className="notice warning" role="status" data-testid="software-rendering-notice"><span>{t('gpu.softwareNotice')} <span className="sr-only">{t('gpu.softwareHint', { renderer: graphics.renderer })}</span></span><button type="button" className="notice-dismiss" aria-label={t('notice.dismiss')} data-testid="graphics-notice-dismiss" onClick={() => { setGraphicsNoticeOpen(false); focusImage(); }}><X size={14} /></button></div>}
        {/* Info notices go into a live region that is always present, so screen readers announce them reliably. */}
        <div className="notice-region" role="status">{notice && notice.kind !== 'error' && noticeBar}</div>
        {notice?.kind === 'error' && noticeBar}
        {showFusion && <div className="fusion-strip" data-testid="fusion-strip"><span className="strip-label"><Layers size={14} /> {t(plainFusion ? 'fusion.labelPlain' : 'fusion.label')}</span>{!mrFusion && <select aria-label={t('fusion.series')} data-testid="fusion-series" value={fusionId ?? ''} onChange={event => { const item = overlayChoices.find(value => value.id === event.target.value); if (!item) { setFusionId(null); return; } if (activeVolume?.series.sourceFramesOnly) { say('notice.fusionSourceOnly', 'info'); return; } fuseInActive(item); }}><option value="">{t('fusion.choose')}</option>{petSeries.map(item => <option key={item.id} value={item.id}>{seriesName(item)}</option>)}</select>}<label>{t(plainFusion ? 'fusion.opacityPlain' : 'fusion.opacity')}<input data-action="fusion-opacity" type="range" min={0} max={1} step={0.05} value={fusionOpacity} onChange={event => { setFusionOpacity(Number(event.target.value)); setFusionDeviceMode(false); }} /></label><label>{t(fusionScaleMaxKey(fusionPet))}<input data-action="fusion-suv-max" className="small-number" type="number" min={0.1} max={100} step={0.5} value={fusionUpper} onChange={event => { setFusionUpper(Math.max(0.1, Number(event.target.value))); setFusionDeviceMode(false); }} /></label><select data-action="fusion-palette" aria-label={t('fusion.palette')} value={fusionPalette} onChange={event => { setFusionPalette(event.target.value as FusionSettings['palette']); setFusionDeviceMode(false); }}><option value="hot_metal">{t('palette.hotMetal')}</option><option value="ge">{t('palette.ge')}</option><option value="red_yellow">{t('palette.redYellow')}</option><option value="hot">{t('palette.hot')}</option><option value="rainbow">{t('palette.rainbow')}</option></select>{!mrFusion && <select data-action="fusion-blend" aria-label={t('fusion.blend')} value={fusionBlend} onChange={event => { setFusionBlend(event.target.value as FusionSettings['blend']); setFusionDeviceMode(false); }}><option value="classic">{t('fusion.blendClassic')}</option><option value="uptake">{t('fusion.blendUptake')}</option></select>}{!plainFusion && <button type="button" className="secondary-button compact" data-action="fusion-device-look" aria-pressed={fusionDeviceMode} onClick={() => { const pet = fusion?.volume.series; if (pet) applyDeviceLook(pet, activeIdRef.current); else setFusionDeviceMode(true); }}>{t('fusion.deviceLook')}</button>}<button className="icon-button" aria-label={t('fusion.disable')} data-testid="fusion-disable" onClick={stopFusion}><X size={14} /></button></div>}
        {pictureNotice && <div className="picture-notice-anchor"><div className="picture-notice" role="status" data-testid="picture-notice"><span>{pictureFormat ? t('pictures.limited', { format: pictureFormat }) : t('pictures.limitedPlain')}</span><button type="button" className="notice-dismiss" aria-label={t('notice.dismiss')} data-tooltip={t('notice.dismiss')} data-action="picture-notice-close" onClick={() => setPictureNoticeClosed(current => new Set(current).add(pictureNotice))}><X size={14} /></button></div></div>}
        {series.length === 0 ? <div className="welcome-space" data-testid="welcome">
          <div className="welcome-card">
            <span className="welcome-icon" aria-hidden="true"><FolderOpen size={26} strokeWidth={1.6} /></span>
            <h1>{t('welcome.title')}</h1>
            <p>{t('welcome.hint')}</p>
            <div className="welcome-actions">
              <button type="button" className="primary-button" data-testid="welcome-open-folder" disabled={Boolean(busy)} onClick={() => void open('folder')}><FolderOpen size={16} /> {t('toolbar.openFolder')}<kbd className="button-kbd">{combo(mod, 'O')}</kbd></button>
              <button type="button" className="secondary-button" data-testid="welcome-open-files" disabled={Boolean(busy)} onClick={() => void open('files')}><Files size={16} /> {t('toolbar.openFiles')}</button>
              <button type="button" className="secondary-button" data-testid="welcome-open-archive" disabled={Boolean(busy)} onClick={() => void open('archive')}><FileArchive size={16} /> {t('toolbar.openArchive')}</button>
            </div>
            {busy && <div className="connection-status" role="status"><LoaderCircle size={14} className="spin" />{t(busy)}</div>}
            {connectionError && <div className="connection-error" role="alert"><strong>{t('welcome.serviceUnavailable')}</strong><span>{connectionError}</span><button data-action="reconnect" type="button" className="secondary-button compact" onClick={() => void connect()}>{t('welcome.reconnect')}</button></div>}
          </div>
        </div> : <div ref={attachGrid} className="viewport-grid" data-testid="viewport-grid" data-panes={slots.length} style={{ '--grid-rows': gridShape[0], '--grid-columns': gridShape[1] } as CSSProperties}>
          {slots.map((slot, index) => {
            const volume = volumeForSlot(slot), metadata = slot.seriesId ? seriesById.get(slot.seriesId) : undefined;
            const origin = crosshairSeriesId ? volumes.get(crosshairSeriesId) : undefined;
            // The crosshair in this pane's own coordinates: as set in one frame of reference, through the alignment in another.
            const toPane = volume && origin ? transformBetween(alignments, origin.series, volume.series) : null;
            const linkedCrosshair = settings.showCrosshair && crosshair && toPane ? mapPoint(toPane, crosshair) : null;
            const fused = fusion && !slot.unfused && volume && volume.sourceFrameIndex === undefined && !volume.series.sourceFramesOnly && fusesOver(volume.series, fusion.volume.series, alignments)
              ? alignedFusion(fusion, transformBetween(alignments, volume.series, fusion.volume.series) ?? IDENTITY) : null;
            // Placed by an alignment: a series in a frame aligned to another, or an overlay drawn through one.
            const placedBy = volume ? (fused?.transform ? alignmentOf(alignments, fused.volume.series) : alignments.find(item => item.moving === frameOf(volume.series))) : null;
            return <ViewportCell key={slot.id} slot={slot} index={index} paneCount={slots.length} volume={volume} metadata={metadata} active={slot.id === activeId} tool={tool}
              annotations={slot.seriesId ? annotations[slot.seriesId] ?? EMPTY_ANNOTATIONS : EMPTY_ANNOTATIONS} crosshair={linkedCrosshair} fusion={fused} segmentations={segmentationOverlays}
              loading={Boolean(slot.seriesId && loadingIds.has(slot.seriesId))} loadError={slot.seriesId ? loadErrors[slot.seriesId] : undefined} linked={settings.linked} interaction={settings} references={!isMpr && slot.id === activeId ? EMPTY_REFERENCES : activeReferences}
              alignments={alignments} aligned={placedBy ? (adjusted(placedBy) ? 'adjusted' : 'automatic') : undefined}
              onActivate={activateSlot} onViewChange={updateView} onAnnotationsChange={changeAnnotations} onCrosshairChange={changeCrosshair}
              onDropSeries={dropSeries} onClose={closePane} onMaximize={maximizePane}
              onRestore={maximized && slots.length === 1 && slot.id === maximized.id && !isMpr ? restoreLayout : undefined} onCyclePlane={cyclePlane} onFusionAdjust={adjustFusion} onRotateReference={isMpr ? rotatePlane : undefined} clickPicksPoint={show3d}
              toast={paneToast?.slotId === slot.id && paneToast.seriesId === slot.seriesId ? paneToast : undefined} span={index === slots.length - 1 ? gridShape[0] * gridShape[1] - slots.length + 1 : undefined} onSwap={swapPanes} />;
          })}
        </div>}
      </main>

      {/* Docked beside the image (not over it), so the panels it replaces cannot hold hidden keyboard focus. */}
      {checklistShown && <div className="assessment-overlay"><Suspense fallback={null}><PreopChecklist key={studyKey(activeSeries)} series={activeSeries}
        onClose={() => setChecklistOpen(false)}
        headingRef={focusChecklistHeading}
        onNote={() => {
          if (!activeVolume || !activeSlot.seriesId) return null;
          const view = activeSlot.view, count = sliceCount(activeVolume.series, view), slice = Math.round(view.slice);
          const shown = pagesBackwards(activeVolume.series, view) ? count - slice : slice + 1;
          // A tilted plane is named with its tilt, and "go to" tilts the pane back to it.
          const tilted = (view.mode ?? 'source') === 'mpr' && view.oblique?.some(Boolean) ? { oblique: [view.oblique[0], view.oblique[1]] as [number, number], tilt: obliqueAngle(activeVolume.series, view) } : {};
          return { seriesId: activeSlot.seriesId, slice, shown: `${shown}/${count}`, plane: view.plane, mode: view.mode ?? 'source', ...tilted };
        }}
        onGoTo={note => { const item = seriesRef.current.find(value => value.id === note.seriesId); if (!item) return;
          if (activeSlot.seriesId !== note.seriesId) assignSeries(activeSlot.id, item);
          updateView(activeSlot.id, { slice: note.slice, plane: note.plane as Plane, mode: note.mode as ViewState['mode'], oblique: note.mode === 'mpr' ? note.oblique ?? [0, 0] : undefined }); focusImage(); }} /></Suspense></div>}
      {showAssessment && <div className="assessment-overlay" hidden={!assessmentShown}><Suspense fallback={<div className="centered-loading"><LoaderCircle className="spin" /> {t('loading.assessment')}</div>}><AssessmentPanel volumes={assessmentVolumes} annotations={annotations} activeSeriesId={activeSeries?.id} onRequestRoi={requestAssessmentRoi} onFinishRoi={finishAssessmentRoi} onClose={closeAssessment} hidden={!assessmentShown} /></Suspense></div>}
      <Inspector open={inspectorShown} showTags={settings.panel === 'tags'} inert={capturing} series={activeSeries} frame={currentSourceFrame} onError={showTagError}>
        {inspectorShown && <>
        <div className="inspector-tabs"><div className="inspector-tablist" role="tablist" aria-label={t('inspector.label')} onKeyDown={event => {
          const order: Exclude<Panel, null>[] = ['measurements', 'display', 'tags'];
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !(event.target as HTMLElement).matches('[role="tab"]')) return;
          event.preventDefault();
          const index = nextIndex(order.indexOf(settings.panel ?? 'display'), event.key, order.map(() => true), 'horizontal');
          setPanel(order[index]); document.getElementById(`inspector-tab-${order[index]}`)?.focus();
        }}>
          {([['measurements', t('inspector.findings')], ['display', t('inspector.displayShort')], ['tags', t('inspector.tagsShort')]] as const).map(([id, label]) =>
            <button key={id} type="button" role="tab" id={`inspector-tab-${id}`} aria-controls={`inspector-panel-${id}`} aria-selected={settings.panel === id} tabIndex={settings.panel === id ? 0 : -1}
              data-testid={`inspector-tab-${id}`} className={settings.panel === id ? 'is-active' : ''} onClick={() => setPanel(id)}>
              <span>{label}</span>{id === 'measurements' && settings.panel !== 'measurements' && activeAnnotations.length > 0 && <span className="tab-count" aria-label={`(${activeAnnotations.length})`}>{activeAnnotations.length}</span>}
            </button>)}
          </div>
          <button type="button" className="icon-button inspector-close" aria-label={t('inspector.close')} data-tooltip={t('inspector.close')} onClick={() => { setPanel(null); focusSoon('[data-testid="tool-inspector"]', '[data-testid="tool-more"]'); }}><X size={16} /></button>
        </div>
        {settings.panel === 'measurements' && <div className="inspector-panel" role="tabpanel" id="inspector-panel-measurements" aria-labelledby="inspector-tab-measurements" tabIndex={0}>
          <div className="panel-heading"><h2>{t('inspector.measurements')}</h2><span className="count-badge">{activeAnnotations.length}</span>{activeAnnotations.length > 0 && <button data-action="measurements-delete-all" type="button" className="icon-button danger-hover" aria-label={t('inspector.deleteAll')} data-tooltip={t('inspector.deleteAll')} data-testid="findings-delete-all" onClick={() => {
            if (!activeSeries) return;
            // Undo puts back exactly these measurements, even after other edits; the restore is itself undoable.
            const seriesId = activeSeries.id, deleted = activeAnnotations, count = deleted.length;
            changeAnnotations(seriesId, []);
            setNotice({ message: t('notice.measurementsDeleted', { count }), kind: 'info', key: 'notice.measurementsDeleted', params: { count }, transient: true, action: { label: 'notice.undo', run: () => {
              const ids = new Set(deleted.map(item => item.id)), added = (annotationRef.current[seriesId] ?? []).filter(item => !ids.has(item.id));
              changeAnnotations(seriesId, [...deleted, ...added]);
            } } });
            focusSoon('[data-testid="notice-action"]');
          }}><Trash2 size={15} /></button>}</div>
          {activeSeries && petStudies.hasLegacy(activeSeries) && <button type="button" data-action="sphere-restore-references" className="secondary-button" onClick={() => petStudies.restoreLegacy(activeSeries)}>{t('sphere.restoreLegacy')}</button>}
          {activeSeries?.modality === 'PT' && <LesionTable annotations={activeAnnotations} volume={activeVolume}
            prior={lesionPrior} saveFailed={petStudies.saveFailed} onMatch={matchPriorLesion} cautions={cautions.map(item => item.text)} cautionKey={cautionKey} />}
          {/* Waits while the PET loads: in flight, or a preview frame with no error. */}
          {activeSeries?.modality === 'PT' && <PetReportCopy series={activeVolume?.series ?? activeSeries} volume={activeVolume} annotations={activeAnnotations}
            loading={loadingIds.has(activeSeries.id) || (!loadErrors[activeSeries.id] && (!activeVolume || activeVolume.sourceFrameIndex !== undefined))}
            typedGlucose={typedGlucose} lesionPrior={lesionPrior} comparison={petPrior && { current: currentPet, prior: petPrior, limited: limitedView }} />}
          {activeAnnotations.length ? <ol className="annotation-list">{activeAnnotations.map((annotation, index) => {
            const sourceIndex = annotation.mode === 'source' && activeVolume ? annotationSourceIndex(annotation, activeVolume.series) : null;
            const unavailable = annotation.mode === 'source' && sourceIndex === null;
            const Icon = MEASURE_ICONS[annotation.type] ?? Ruler;
            const neighbour = activeAnnotations[index + 1]?.id ?? activeAnnotations[index - 1]?.id;
            const sphere = sphereOf(annotation);
            return <li className={`annotation-row${annotation.type === 'sphere' ? ' has-details' : ''}`} key={annotation.id} data-annotation-row={annotation.id}><button data-action="measurement-go" type="button" className="annotation-main" disabled={unavailable} onClick={event => {
              // A sphere: every linked pane goes to its centre, each in its own plane.
              if (sphere) {
                if (activeVolume && !isProjection(activeVolume.series, activeSlot.view)) updateView(activeSlot.id, { slice: sliceAtWorld(activeVolume.series, activeSlot.view, sphere.center) });
                changeCrosshair(sphere.center);
              } else updateView(activeSlot.id, viewOfAnnotation(annotation, sourceIndex));
              document.querySelector('.viewport-cell.is-active [data-testid="dicom-viewport"]')?.dispatchEvent(new CustomEvent(PICK_MEASUREMENT, { detail: annotation.id }));
              // The row answers every click, even with measurements hidden or the image already on this slice.
              event.currentTarget.animate([{ backgroundColor: 'var(--accent-bg)' }, { backgroundColor: 'transparent' }], { duration: 500 });
              usage.touch('marks');
            }}>
              <span className="annotation-number"><Icon size={14} aria-hidden="true" />{index + 1}</span>
              <span className="annotation-text"><span className="annotation-values">{unavailable ? <span className="stat-primary">{t('inspector.sourceUnavailable')}</span> : <AnnotationSummary annotation={annotation} volume={activeVolume} />}</span><small>{toolLabel(annotation.type)} · {sphere ? t('sphere.diameter', { value: (sphere.radius * 2).toFixed(1) }) : annotation.mode === 'source' ? sourceIndex === null ? t('inspector.notInImport') : t('inspector.sourceFrameNumber', { number: sourceIndex + 1 }) : t('inspector.planeSlice', { plane: annotation.oblique?.some(Boolean) && activeVolume ? t('viewport.obliquePlane', { plane: planeLabel(annotation.plane), angle: obliqueAngle(activeVolume.series, { plane: annotation.plane, mode: 'mpr', oblique: annotation.oblique }) }) : planeLabel(annotation.plane), number: annotation.slice + 1 })}</small></span></button>
              <button data-action="measurement-delete" type="button" className="icon-button danger-hover" aria-label={t('inspector.deleteMeasurement', { number: index + 1 })} data-tooltip={t('inspector.deleteMeasurement', { number: index + 1 })} onClick={() => { if (!activeSeries) return; changeAnnotations(activeSeries.id, activeAnnotations.filter(item => item.id !== annotation.id)); focusSoon(neighbour ? `[data-annotation-row="${neighbour}"] .annotation-main` : '[data-testid="findings-add"]'); }}><X size={15} /></button>
              {sphere && activeSeries && <SphereDetails annotation={annotation} annotations={activeAnnotations} volume={activeVolume} onChange={next => changeAnnotations(activeSeries.id, next)} />}</li>;
          })}</ol>
            : <div className="inspector-empty"><span className="empty-icon" aria-hidden="true"><Ruler size={20} strokeWidth={1.6} /></span><strong>{t('inspector.emptyTitle')}</strong><p>{t('inspector.emptyText')}</p><button data-action="measure-length" type="button" className="secondary-button compact" data-testid="findings-add" disabled={!activeVolume} onClick={() => setTool('length')}><Plus size={14} /> {t('inspector.addMeasurement')}{settings.singleKeys && <kbd className="button-kbd">L</kbd>}</button></div>}
          <section className="panel-block" aria-labelledby="series-details-title"><h3 className="block-title" id="series-details-title">{t('inspector.seriesDetails')}</h3>{activeSeries ? <dl className="series-details"><dt>{t('inspector.modality')}</dt><dd>{activeSeries.modality}</dd><dt>{t('inspector.images')}</dt><dd>{activeSeries.dimensions[2].toLocaleString()}</dd><dt>{t('inspector.matrix')}</dt><dd>{activeSeries.dimensions[0]} × {activeSeries.dimensions[1]}</dd><dt>{t('inspector.pixelSpacing')}</dt><dd>{activeSeries.spacingKnown === true ? `${activeSeries.spacing.slice(0, 2).map(n => n.toFixed(2)).join(' × ')} mm` : t('inspector.notCalibrated')}</dd><dt>{t('inspector.sliceSpacing')}</dt><dd>{activeSeries.canReconstruct ? `${activeSeries.spacing[2].toFixed(2)} mm` : t('inspector.notVerified')}</dd><dt>{t('inspector.values')}</dt><dd>{storedUnit(activeSeries) || t('inspector.storedValues')}</dd></dl> : <p className="muted-copy">{t('inspector.openStudy')}</p>}</section>
          {acquisitionPet && <PetAcquisitionPanel key={acquisitionPet.id} series={acquisitionPet} prior={petPrior} current={currentPet}
            cautions={cautions} cautionKey={cautionKey} limited={limitedView} onLimited={checked => petRecords.setLimitedView(acquisitionPet, checked)}
            typed={{ value: typedGlucose, ready: petRecords.keys.has(acquisitionPet.id), failed: petRecords.saveFailed,
              set: mmol => petRecords.setGlucose(acquisitionPet, mmol) }} />}
          {!!activeSeries?.warnings.length && <WarningBox title={t('inspector.imageInformation')} dismissKey={`image-information:${activeSeries.id}:${activeSeries.warnings.join('|')}`}>{warningTexts(activeSeries, locale).map((warning, i) => <p key={i}>{warning}</p>)}</WarningBox>}
          <p className="inspector-footnote">{t('inspector.patientCoordinates')}</p>
        </div>}
        {settings.panel === 'display' && <div className="inspector-panel display-panel" role="tabpanel" id="inspector-panel-display" aria-labelledby="inspector-tab-display" tabIndex={0}>
          <PanelSection id="window" title={t('inspector.windowSection')} open={openSections.has('window')} onToggle={toggleSection}>
            <div className="field-pair"><label>{t('inspector.windowWidth')}<input data-action="window-width-input" aria-label={t('inspector.windowWidth')} type="number" min={1} value={Math.round(activeDisplayView.windowWidth)} disabled={!activeVolume || rgb} onChange={event => updateView(activeSlot.id, { windowWidth: Math.max(1, Number(event.target.value)) })} /></label><label>{t('inspector.windowLevel')}<input data-action="window-level-input" aria-label={t('inspector.windowLevel')} type="number" value={Math.round(activeDisplayView.windowCenter)} disabled={!activeVolume || rgb} onChange={event => updateView(activeSlot.id, { windowCenter: Number(event.target.value) })} /></label></div>
            <div className="preset-buttons" role="group" aria-label={t('toolbar.windowPresets')}>{PRESETS.map(preset => <button data-action={`preset-${kebab(preset.key)}`} key={preset.key} type="button" aria-pressed={currentPreset?.key === preset.key} className={currentPreset?.key === preset.key ? 'is-active' : ''} disabled={!activeVolume || rgb} onClick={() => updateView(activeSlot.id, { windowWidth: preset.width, windowCenter: preset.center })}><span>{presetName(preset)}</span><small>{preset.width} / {preset.center}</small></button>)}</div>
            <div className="inline-actions"><button data-action="preset-auto" type="button" className="text-button" disabled={!activeVolume || rgb || framePending} onClick={applyAutoWindow}>{t('inspector.autoWindowRange')}</button><button type="button" className="text-button" disabled={!activeVolume || rgb} onClick={applyDicomWindow}>{t('toolbar.dicomWindow')}</button></div>
          </PanelSection>
          <PanelSection id="color" title={t('inspector.colorSection')} open={openSections.has('color')} onToggle={toggleSection}>
            <label className="stacked-field">{t('inspector.colorPalette')}<select data-action="palette" aria-label={t('inspector.imagePalette')} disabled={!activeVolume || rgb} value={activeSlot.view.palette ?? 'gray'} onChange={event => updateView(activeSlot.id, { palette: event.target.value as ViewState['palette'] })}><option value="gray">{t('palette.gray')}</option><option value="hot">{t('palette.hot')}</option><option value="ge">{t('palette.ge')}</option><option value="rainbow">{t('palette.rainbow')}</option></select></label>
            <label className="check-field"><input data-action="invert" type="checkbox" checked={activeSlot.view.inverted} disabled={!activeVolume || rgb} onChange={event => updateView(activeSlot.id, { inverted: event.target.checked })} /> {t('inspector.invert')}</label>
          </PanelSection>
          <PanelSection id="orientation" title={t('inspector.orientation')} open={openSections.has('orientation')} onToggle={toggleSection}>
            <div className="display-buttons">
              <ToolButton action="inspector-rotate-left" icon={<RotateCcwSquare size={17} />} label={t('inspector.rotateLeft')} disabled={!activeVolume} onClick={() => updateView(activeSlot.id, { rotation: activeSlot.view.rotation - 90 })} />
              <ToolButton action="inspector-rotate-right" icon={<RotateCwSquare size={17} />} label={t('inspector.rotateRight')} disabled={!activeVolume} onClick={() => updateView(activeSlot.id, { rotation: activeSlot.view.rotation + 90 })} />
              <ToolButton action="toolbar-flip-horizontal" icon={<FlipHorizontal2 size={17} />} label={t('toolbar.flipHorizontal')} active={activeSlot.view.flipX} disabled={!activeVolume} onClick={() => updateView(activeSlot.id, { flipX: !activeSlot.view.flipX })} />
              <ToolButton action="toolbar-flip-vertical" icon={<FlipVertical2 size={17} />} label={t('toolbar.flipVertical')} active={activeSlot.view.flipY} disabled={!activeVolume} onClick={() => updateView(activeSlot.id, { flipY: !activeSlot.view.flipY })} />
              <button type="button" className="text-button" disabled={!activeVolume || (!activeSlot.view.rotation && !activeSlot.view.flipX && !activeSlot.view.flipY)} onClick={() => updateView(activeSlot.id, { rotation: 0, flipX: false, flipY: false })}>{t('toolbar.resetOrientation')}</button>
            </div>
          </PanelSection>
          <PanelSection id="oblique" title={t('inspector.oblique')} open={openSections.has('oblique')} onToggle={toggleSection}>
            <p className="field-help">{t('inspector.obliqueHelp')}</p>{[0, 1].map(axis => <label className="slider-field" key={axis}><span>{axis === 0 ? t('inspector.pitch') : t('inspector.yaw')}<output>{activeSlot.view.oblique?.[axis] ?? 0}°</output></span><input data-action={axis === 0 ? 'oblique-pitch' : 'oblique-yaw'} type="range" disabled={!canReconstruct} min={-90} max={90} step={1} value={activeSlot.view.oblique?.[axis] ?? 0} onChange={event => { const angles: [number, number] = [...(activeSlot.view.oblique ?? [0, 0])]; angles[axis] = Number(event.target.value); if (activeVolume) { const next = { ...activeSlot.view, mode: 'mpr' as const, oblique: angles }; updateView(activeSlot.id, { mode: 'mpr', oblique: angles, slice: sliceAtWorld(activeVolume.series, next, getPlaneFrame(activeVolume.series, activeSlot.view).center) }); } }} /></label>)}
            <button data-action="oblique-reset" type="button" className="text-button" disabled={!canReconstruct || !activeSlot.view.oblique?.some(Boolean)} onClick={() => { if (activeVolume) { const next = { ...activeSlot.view, oblique: [0, 0] as [number, number] }; updateView(activeSlot.id, { oblique: [0, 0], slice: sliceAtWorld(activeVolume.series, next, getPlaneFrame(activeVolume.series, activeSlot.view).center) }); } }}>{t('inspector.resetPlane')}</button>
          </PanelSection>
          {activeAlignment && <PanelSection id="alignment" title={t('inspector.alignment')} open={openSections.has('alignment')} onToggle={toggleSection}>
            <AlignmentSection alignment={activeAlignment} fixed={seriesById.get(activeAlignment.fixedSeriesId)} moving={seriesById.get(activeAlignment.movingSeriesId)}
              onNudge={nudge => nudgeAlignment(activeAlignment, nudge)} onAutomatic={() => changeAlignments(withAlignment(alignmentsRef.current, automatic(activeAlignment)))}
              onRemove={() => removeAlignment(activeAlignment)} />
          </PanelSection>}
          <PanelSection id="workspace" title={t('inspector.workspace')} open={openSections.has('workspace')} onToggle={toggleSection}>
            <label className="check-field"><input data-action="link-frames" type="checkbox" checked={settings.linked} onChange={event => { if (event.target.checked) pressLink(); else setSettings(current => ({ ...current, linked: false })); }} /> {t('inspector.linkFrames')}</label>
            <label className="check-field"><input data-action="show-crosshair" type="checkbox" checked={settings.showCrosshair} onChange={event => setSettings(current => ({ ...current, showCrosshair: event.target.checked }))} /> {t('inspector.showCrosshair')}</label>
            <label className="check-field"><input data-action="overlay-show-references" type="checkbox" checked={settings.showReferences} onChange={event => setSettings(current => ({ ...current, showReferences: event.target.checked }))} /> {t('inspector.showReferences')}</label>
            {keptNames.length > 0 && <div className="kept-arrangements"><p className="field-help">{t('arrangement.keptList', { names: keptNames.join(', ') })}</p>
              <button type="button" className="secondary-button compact" data-action="arrangement-forget" onClick={forgetKept}>{t('arrangement.forget')}</button></div>}
          </PanelSection>
          <div className="inspector-section"><span className="section-label">{t('usage.section')}</span><label className="check-field"><input type="checkbox" data-testid="usage-sharing" checked={usageConsent === 'granted'} disabled={usageConsent === undefined} onChange={event => void chooseUsage(event.target.checked ? 'granted' : 'denied')} /> {t('usage.setting')}</label><p className="field-help">{t('usage.settingHelp')}</p></div>
          <PanelSection id="units" title={t('inspector.units')} open={openSections.has('units')} onToggle={toggleSection}>
            <label className="stacked-field">{t('inspector.displayUnits')}<select data-action="units" value={settings.measurementUnits} onChange={event => setSettings(current => ({ ...current, measurementUnits: event.target.value as 'auto' | 'px' }))}><option value="auto">{t('inspector.unitsMillimetres')}</option><option value="px">{t('inspector.unitsPixels')}</option></select></label>
            <p className="field-help">{t('inspector.calibrationHelp')}</p>
            <label className="stacked-field">{t('inspector.referenceLine')}<select data-action="calibration-line" aria-label={t('inspector.calibrationLine')} value={activeAnnotations.some(annotation => annotation.id === calibrationLine) ? calibrationLine : activeAnnotations.find(annotation => annotation.type === 'length')?.id ?? ''} onChange={event => setCalibrationLine(event.target.value)}><option value="">{t('inspector.chooseLength')}</option>{activeAnnotations.filter(annotation => annotation.type === 'length').map((annotation, index) => <option key={annotation.id} value={annotation.id}>{t('inspector.lengthNumber', { number: index + 1 })}</option>)}</select></label>
            <label className="stacked-field">{t('inspector.knownLength')}<input data-action="calibration-length" type="number" min={0.001} step="any" value={calibrationLength} onChange={event => setCalibrationLength(event.target.value)} /></label>
            <div className="calibration-actions"><button data-action="calibrate" type="button" className="secondary-button compact" disabled={!activeVolume || !activeAnnotations.some(annotation => annotation.type === 'length')} onClick={applyCalibration}>{t('inspector.calibrate')}</button>{activeSeries && calibrationScales[activeSeries.id] && <button data-action="calibration-remove" type="button" className="text-button" onClick={() => setCalibrationScales(current => { const next = { ...current }; delete next[activeSeries.id]; return next; })}>{t('inspector.removeCalibration')}</button>}</div>
            {activeSeries && calibrationScales[activeSeries.id] && <p className="calibration-status" role="status">{t('inspector.manualScale', { scale: calibrationScales[activeSeries.id].toPrecision(4) })}</p>}
            <label className="stacked-field">{t('inspector.petValues')}<select data-action="pet-values" value={settings.suvNormalization} onChange={event => setSettings(current => ({ ...current, suvNormalization: event.target.value as SuvNormalization }))}><option value="bw">{t('inspector.suvBw')}</option><option value="lbm">{t('inspector.suvLbm')}</option><option value="bsa">{t('inspector.suvBsa')}</option></select></label>
            <p className="field-help">{t('inspector.petValuesHelp')}</p>
          </PanelSection>
          <PanelSection id="mouse" title={t('inspector.mouse')} open={openSections.has('mouse')} onToggle={toggleSection}>
            {(['left', 'middle', 'right'] as MouseButton[]).map(button => <label className="mouse-binding" key={button}><span>{t(`mouse.${button}.drag` as const)}</span><select value={settings.mouseBindings[button] ?? (button === 'left' ? 'selected' : effectiveBinding(button))} onChange={event => setSettings(current => { const bindings = { ...current.mouseBindings }; if (event.target.value === 'selected') delete bindings[button]; else bindings[button] = event.target.value as Tool; return { ...current, mouseBindings: bindings }; })}>{button === 'left' && <option value="selected">{t('toolbar.selectedToolCurrent', { tool: toolLabel(tool) })}</option>}{BUTTON_ACTIONS.map(action => <option key={action} value={action}>{toolLabel(action)}</option>)}</select></label>)}
            <div className="popover-subtitle">{t('help.wheelKey')}</div>
            <label className="mouse-binding"><span>{t('mouse.wheel.heading')}</span><select value={settings.wheelAction} onChange={event => setSettings(current => ({ ...current, wheelAction: event.target.value as WheelAction }))}>{WHEEL_ACTIONS.map(action => <option key={action} value={action}>{t(`wheel.${action}` as const)}</option>)}</select></label>
            <label className="slider-field"><span>{t('inspector.scrollSpeed')}<output>{settings.wheelSensitivity.toFixed(1)}×</output></span><input type="range" min={0.2} max={5} step={0.2} value={settings.wheelSensitivity} onChange={event => setSettings(current => ({ ...current, wheelSensitivity: Number(event.target.value) }))} /></label>
            <label className="check-field"><input type="checkbox" checked={settings.reverseWheel} onChange={event => setSettings(current => ({ ...current, reverseWheel: event.target.checked }))} /> {t('inspector.reverseScroll')}</label>
            <button type="button" className="text-button" onClick={resetMouse}>{t('mouse.reset')}</button>
            <p className="field-help">{t('inspector.touchHelp')}</p>
            <label className="check-field"><input type="checkbox" checked={settings.singleKeys} onChange={event => setSettings(current => ({ ...current, singleKeys: event.target.checked }))} /> {t('inspector.singleKeys')}</label>
            <p className="field-help">{t('inspector.singleKeysHelp')}</p>
          </PanelSection>
          <div className="panel-footer"><button data-action="tool-reset-view" type="button" className="secondary-button reset-display" disabled={!activeVolume} onClick={resetView}><RotateCcw size={15} /> {t('inspector.resetDisplay')}{settings.singleKeys && <kbd className="button-kbd">0</kbd>}</button></div>
        </div>}
        </>}
      </Inspector>
    </div>
    <footer className="app-status">
      <div className="status-state"><span className={`status-dot${busy || loadingIds.size || importing || aligning ? ' working' : connectionError ? ' error' : ''}`} aria-hidden="true" /><span data-testid="status-text" role="status">{busy ? t(busy) : importing ? t('status.reading') : aligning ? t('status.aligning') : loadingIds.size ? t('status.loadingSeries', { count: loadingIds.size }) : connectionError ? t('status.serviceUnavailable') : t('status.ready')}</span>{activeVolume?.series.sourceFramesOnly && <span data-tooltip={t('status.sourcePagingHint')} tabIndex={0}>{t('status.sourcePaging')}<span className="sr-only">{t('status.sourcePagingHint')}</span></span>}{graphics?.software && <span data-testid="software-rendering-status" data-tooltip={t('gpu.softwareHint', { renderer: graphics.renderer })} tabIndex={0}>{t('gpu.softwareStatus')}<span className="sr-only">{t('gpu.softwareHint', { renderer: graphics.renderer })}</span></span>}{progress?.stage === 'decode' && <span className="status-export"><progress className="status-export-bar" aria-label={stageLabel(progress.stage)} max={Math.max(1, progress.total)} value={progress.completed} /><button type="button" className="text-button" data-testid="operation-cancel" disabled={cancelling} onClick={cancelProgress}>{cancelling ? t('status.cancelling') : t('common.cancel')}</button></span>}{exportBackground && exportBusy && <span className="status-export" data-testid="status-export"><LoaderCircle size={12} className="spin" />{exportProgress ? t('status.exportingCount', { done: exportProgress[0], total: exportProgress[1] }) : t('status.exporting')}{exportProgress && <progress className="status-export-bar" max={exportProgress[1]} value={exportProgress[0]} />}<button type="button" className="text-button" data-action="export-cancel" onClick={() => exportCancel.current?.()}>{t('common.cancel')}</button></span>}<span className="status-divider" aria-hidden="true" /><span>{t('status.seriesCount', { count: series.length })}</span><span className="context-dot" aria-hidden="true">·</span><span>{t('status.imageCount', { count: totalFrames.toLocaleString() })}</span></div>
      <div className="status-play" role="group" aria-label={t('status.cine')}>
        <button type="button" className="status-button" data-testid="status-play" aria-label={t('status.play')} data-tooltip={t('status.play')} aria-pressed={playing} disabled={!canPlay} onClick={() => setPlaying(true)}><Play size={14} /></button>
        <button type="button" className="status-button" data-testid="status-pause" aria-label={t('status.pause')} data-tooltip={t('status.pause')} disabled={!playing} onClick={() => setPlaying(false)}><Pause size={14} /></button>
        {playing && <CineSpeed fps={cineFps} max={cineMax} onChange={fps => setSettings(current => ({ ...current, cineFps: fps }))} />}
      </div>
      {/* Feedback to the team: always at hand, never over the images (where the bridge can send it). */}
      {bridgeCan('feedback') && <button type="button" className="status-button status-feedback" data-testid="feedback-open" data-usage-ignore aria-label={t('feedback.open')} data-tooltip={t('feedback.open')} onClick={() => setShowFeedback(true)}><MessageSquare size={13} aria-hidden="true" /><span>{t('feedback.open')}</span></button>}
      {/* Language is set rarely, so it lives in the status bar rather than among the imaging tools. */}
      <div className="menu-anchor status-language" data-menu>
        <button type="button" className="status-button" data-testid="tool-language" aria-label={`${t('language.menu')} · ${locale.toUpperCase()}`} data-tooltip={t('language.menu')} aria-haspopup="menu" aria-expanded={menu === 'language'} onClick={() => toggleMenu('language')}><Languages size={13} aria-hidden="true" /><span className="language-code">{locale.toUpperCase()}</span></button>
        {menu === 'language' && <Menu label={t('language.menu')} align="right" className="menu-up" onClose={closeMenu}>{LOCALES.map(option => <MenuItem key={option} kind="radio" testId={`language-${option}`} checked={locale === option} onClick={() => act(() => chooseLocale(option))}>{t(`language.${option}` as const)}</MenuItem>)}</Menu>}
      </div>
      <span className="app-version">{t('status.version', { version: window.veacom?.getVersion() || '2' })}</span>
    </footer>

    {exportMode && exportFor && <Suspense fallback={<div className="modal-backdrop"><div className="centered-loading"><LoaderCircle className="spin" /> {t('loading.export')}</div></div>}><ExportDialog key={`${exportMode}:${exportFor}`} mode={exportMode} series={series} activeSeriesId={exportFor} onModeChange={openExport} onPicture={(format, layout) => void exportImage(format, layout)}
      unavailable={Boolean(loadingIds.size) || activeVolume?.sourceFrameIndex !== undefined || !activeVolume ? { images: t('export.waitLoading'), video: t('export.waitLoading') } : undefined} background={exportBackground} busy={exportBusy} onBusyChange={changeExportBusy} onBackground={() => { setExportBackground(true); focusImage(); }} video={exportVideoTarget}
      currentFrame={activeSeries?.id === exportFor ? displayedDicomFrame : undefined} onProgress={(done, total) => setExportProgress([done, total])} cancelRef={exportCancel}
      onClose={() => { setExportMode(null); setExportBackground(false); }}
      onFailed={message => setNotice({ message, kind: 'error', code: 'export-failed' })}
      onComplete={(message, warnings, reveal) => setNotice({ message: `${message}${warnings?.length ? ` · ${warnings.join(' · ')}` : ''}`, kind: 'info', code: 'export-complete', transient: !warnings?.length && !reveal,
        action: reveal && window.veacom?.revealExport ? { label: 'export.openFolder', run: () => void window.veacom?.revealExport?.(reveal).catch(() => {}) } : undefined })} /></Suspense>}
    {showUpdates && <Suspense fallback={null}><UpdateDialog onClose={() => setShowUpdates(false)} /></Suspense>}
    {showFeedback && <Suspense fallback={null}><FeedbackDialog onClose={() => setShowFeedback(false)} onSent={() => say('feedback.sent', 'info', undefined, true)} /></Suspense>}
    {showHelp && <Suspense fallback={null}><HelpDialog onClose={() => setShowHelp(false)} onCheckUpdates={bridgeCan('updates') ? () => { setShowHelp(false); setShowUpdates(true); } : undefined} /></Suspense>}
    {show3d && activeVolume && activeVolume.sourceFrameIndex === undefined && !activeVolume.series.sourceFramesOnly && <div className="volume-overlay"><Suspense fallback={<div className="centered-loading"><LoaderCircle className="spin" /> {t('loading.volume3d')}</div>}><VolumeView volume={activeVolume} annotations={activeAnnotations} initialView={activeSlot.view} viewportSize={volumeViewportSize} segmentations={segmentationOverlays} crosshair={activeCrosshair} onCrosshairChange={point => { pointFrom3d.current = point; changeCrosshair(point); }} onClose={() => {
      setShow3d(false);
      if (pointFrom3d.current && crosshairRef.current === pointFrom3d.current) setCrosshair(null);
      pointFrom3d.current = null;
    }} /></Suspense></div>}
  </div>;
}
