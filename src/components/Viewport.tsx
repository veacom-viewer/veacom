import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Annotation, CaliperTag, NmFrame, Tool, Vec3, ViewportProps, ViewState, Volume } from '../model';
import { fusedPetSummary, measurementSpace, quantitativeScale, shownOnView, storedUnit } from '../imaging/annotations';
import { acquiredPlane as seriesPlane, add, clamp, dot, getPlaneFrame, isProjection, length, orientationLabel, referenceSegment, projectionAngle, scale, screenMapping, screenToWorld, simplifyPolyline, sourceFrameSeries, stepSlice, sub, worldToIndex, worldToScreen } from '../imaging/geometry';
import { MIN_SPHERE_RADIUS_MM, PEAK_RADIUS_MM, sphereOf, sphereSection, sphereStatisticsFor, thresholdVolumeFor } from '../imaging/voi';
import { currentDeauville } from '../imaging/deauvilleReading';
import { hottestAlongRay } from '../imaging/projection';
import { suvWindowText } from '../imaging/quantity';
import { fitWidth, overlayFont, subscribeFont, textWidth } from '../ui/overlayFont';
import { pointerReadout } from '../imaging/readout';
import type { ScreenMapping } from '../imaging/geometry';
import { caliperOrder } from '../imaging/calipers';
import { sliceRenderer } from '../imaging/sliceRenderer';
import { wheelSliceSteps } from '../imaging/interaction';
import { pagesBackwards } from '../imaging/paging';
import { patchView, renderedView, resolveView, usesSourceFrames } from '../imaging/viewState';
import { useAnnotationSummaries } from '../imaging/useAnnotationSummary';
import { wrapLabel } from '../ui/navigation';
import { twoPointWorld } from '../ui/measureGesture';
import { general, scannerLines, sliceDetail, topLeftLines, topRightLines, type CornerLine } from '../ui/overlayCorners';
import { fusionLine } from '../ui/seriesNames';
import { presetFor } from '../ui/presets';
import { hitAnnotation, leaderLine, movedHandle, screenPaths, type AnnotationPart, type HitTarget } from '../ui/annotationEdit';
import { draggedFusion, petHasSuv } from '../imaging/fusion';
import { lineAngle, obliqueAngle, rotationComponent, turnedOblique } from '../imaging/oblique';
import type { PlaneFrame } from '../imaging/geometry';
import { overlayKeepOut, placeLabelBeside, shapeBox, shapeKeepOut, type Box } from '../ui/labelPlacement';
import { maskTransform, overlayShapes, planeOutlines, segmentationApplies } from '../imaging/segmentation';
import type { Translator } from '../i18n';
import { useTranslation } from '../i18n/react';
import { usage, type GestureHandle, type InputKind } from '../usage/tracker';
import { ValueReadout, type ReadoutSetter } from './ValueReadout';

type Point2 = [number, number];
interface Drag { mode: Tool; start: Point2; startWorld: Vec3; view: ViewState; pointer: number; pointerType: string; moved: boolean; activating: boolean; edge?: boolean; }
/** A left drag that starts in this right-hand part of the image pages the slices whatever the tool (VEAcom 1.x). */
/** VEAcom Next's MPR line colours (sagittal red, coronal green, axial blue) and the gap left where the lines cross, px. */
const MPR_LINE_COLORS = { sagittal: 'rgb(255,92,92)', coronal: 'rgb(92,219,107)', axial: 'rgb(84,168,255)' } as const;
const MPR_LINE_GAP = 14;
const EDGE_ZONE = 0.88;
/** Pixels of a paging drag down the edge per slice (VEAcom 1.x). */
const EDGE_PX_PER_SLICE = 6;
interface Pinch { center: Point2; distance: number; view: ViewState; }
/** The plane's name, bottom left: a click there goes to the next plane (VEAcom 1.x), within this corner. */
const PLANE_LABEL_ZONE: Point2 = [150, 70];
interface InteractionContext { series: string; plane: string; requestedSlice: number; displayedSlice: number; geometry: string; }
function interactionContext(volume: ViewportProps['volume'], view: ViewState): InteractionContext {
  const displayed = renderedView(volume, view), source = usesSourceFrames(volume.series, displayed);
  const series = source ? sourceFrameSeries(volume.series, displayed.slice) : volume.series;
  return { series: `${volume.series.id}\0${volume.series.uid}`, plane: `${source ? 'source' : displayed.projection ? 'mip' : 'mpr'}:${displayed.plane}:${displayed.oblique?.join(',') ?? '0,0'}`,
    requestedSlice: view.slice, displayedSlice: displayed.slice, geometry: [...series.origin, ...series.direction, ...series.spacing, ...series.dimensions, volume.series.frameMetadata?.[displayed.slice]?.sopInstanceUid ?? '', volume.series.frameMetadata?.[displayed.slice]?.sourceFrameNumber ?? ''].join(',') };
}
const sameContext = (a: InteractionContext, b: InteractionContext) => a.series === b.series && a.plane === b.plane
  && a.requestedSlice === b.requestedSlice && a.displayedSlice === b.displayedSlice && a.geometry === b.geometry;
const annotationTools = new Set<Tool>(['length', 'angle', 'cobb', 'rectangle', 'ellipse', 'polygon', 'polyline', 'probe', 'arrow', 'text', 'sphere']);
const clickTools = new Set<Tool>(['angle', 'cobb', 'polygon', 'polyline']);
// Two-point tools also accept click, move, click: the single-pointer alternative to dragging (WCAG 2.5.7).
const twoPointTools = new Set<Tool>(['length', 'rectangle', 'ellipse', 'arrow', 'sphere']);

/** Where a sphere VOI shows in a pane, as two patient-space points on the pane's plane: the centre of the circle the
 * plane cuts from it, and a point on that circle to the right on screen. On a whole-volume MIP it shows whole, where its
 * centre projects. Null when the plane misses it. `depth`: how far the sphere's centre lies off the plane. */
function sphereOnPlane(annotation: Annotation, frame: PlaneFrame, mapping: ScreenMapping, projected: boolean): { points: Vec3[]; depth: number } | null {
  const sphere = sphereOf(annotation);
  if (!sphere) return null;
  const through = projected ? sphereSection({ ...sphere, radius: Infinity }, frame) : null;
  const section = projected ? through && { ...through, radius: sphere.radius } : sphereSection(sphere, frame);
  if (!section) return null;
  return { points: [section.center, add(section.center, scale(mapping.right, section.radius))], depth: section.depth };
}
const rootStyle: CSSProperties = { position: 'relative', width: '100%', height: '100%', minHeight: 80, overflow: 'hidden', background: '#000', touchAction: 'none' };
const canvasStyle: CSSProperties = { display: 'block', width: '100%', height: '100%' };
const overlayStyle: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'hidden' };
/** A pane's size until it is first measured, a frame or two after it opens. The overlay is drawn in a box of the pane's
 * size, so drawn then it is one unit stretched over the pane, and a 3.5-unit handle on an MPR line covers the pane in
 * the line's colour. The overlay stays hidden until the pane is measured. */
const UNMEASURED: [number, number] = [1, 1];
const unmeasuredOverlayStyle: CSSProperties = { ...overlayStyle, visibility: 'hidden' };
const pointString = (points: Point2[]) => points.map(p => p.join(',')).join(' ');
const LABEL_CHARACTERS = 30, LABEL_LINE = 15, LABEL_PADDING = 5;
const NO_BOXES: readonly Box[] = [];
const NO_ANNOTATIONS: Annotation[] = [];
// The fused PET's values under each drawing, kept per drawing, PET and chosen SUV (a drawing that changes is a new object).
const petCache = new WeakMap<Annotation, { volume: Volume; locale: string; text: string }>();
function petLine(annotation: Annotation, pet: Volume, locale: string): string {
  const cached = petCache.get(annotation);
  if (cached && cached.volume === pet && cached.locale === locale) return cached.text;
  const text = fusedPetSummary(annotation, pet);
  petCache.set(annotation, { volume: pet, locale, text });
  return text;
}
/** Turkish writes the percent sign first (%100). */
const percent = (value: number, locale: string) => locale === 'tr' ? `%${value}` : `${value}%`;
function fitCorners(lines: CornerLine[], width: number, family: string) {
  return lines.map(line => ({ ...line, fitted: fitWidth(line.short && textWidth(line.text, family, 400) > width ? line.short : line.text, width, family) }));
}

function usePatientCorners(series: Volume['series'], visible: boolean, hidePatient: boolean, width: number, t: Translator, nm?: NmFrame) {
  const fontFamily = useSyncExternalStore(subscribeFont, overlayFont);
  return {
    fontFamily,
    topLeft: visible ? fitCorners(topLeftLines(series, hidePatient, t), width, fontFamily) : [],
    topRight: visible ? fitCorners(topRightLines(series, hidePatient, nm, t), width, fontFamily) : [],
    // The same corners as they read with patient details hidden, for a copied picture; none when they are hidden.
    plainLeft: visible && !hidePatient ? fitCorners(topLeftLines(series, true, t), width, fontFamily) : [],
    plainRight: visible && !hidePatient ? fitCorners(topRightLines(series, true, nm, t), width, fontFamily) : [],
  };
}

function OverlayText({ text, y, width, fontFamily, className }: { text: string; y: number; width: number; fontFamily: string; className?: string }) {
  return <text x={12} y={y} fontSize={12} className={className}><title>{text}</title>{fitWidth(text, width, fontFamily)}</text>;
}
const sameView = (a: ViewState, b: ViewState) => a.plane === b.plane && a.slice === b.slice && a.windowCenter === b.windowCenter && a.windowWidth === b.windowWidth && a.voiLut === b.voiLut && a.voiFunction === b.voiFunction
  && a.zoom === b.zoom && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY && a.inverted === b.inverted
  && a.pan[0] === b.pan[0] && a.pan[1] === b.pan[1] && (a.oblique?.[0] ?? 0) === (b.oblique?.[0] ?? 0) && (a.oblique?.[1] ?? 0) === (b.oblique?.[1] ?? 0)
  && (a.palette ?? 'gray') === (b.palette ?? 'gray') && a.mode === b.mode && a.windowMode === b.windowMode
  && a.slab?.mode === b.slab?.mode && a.slab?.thickness === b.slab?.thickness && a.projection === b.projection;
/** Two views put the same plane at the same place on screen (window and colour aside). */
const samePlacement = (a: ViewState, b: ViewState) => a.plane === b.plane && a.slice === b.slice && (a.mode ?? 'mpr') === (b.mode ?? 'mpr') && a.projection === b.projection
  && (a.oblique?.[0] ?? 0) === (b.oblique?.[0] ?? 0) && (a.oblique?.[1] ?? 0) === (b.oblique?.[1] ?? 0)
  && a.zoom === b.zoom && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY && a.pan[0] === b.pan[0] && a.pan[1] === b.pan[1];

interface LabelLayout extends Box { lines: string[] }
/** Where a measurement's label chip goes: clear of the overlay text and of the chips placed before it. */
const CLOSED_SHAPES = new Set<Tool>(['rectangle', 'ellipse', 'polygon', 'sphere']);
/** `points`: where the measurement shows in this pane (a sphere's circle on the plane; the drawn points otherwise). */
function labelLayout(annotation: Annotation, points: readonly Vec3[], mapping: ScreenMapping, label: string, hard: readonly Box[], soft: readonly Box[], family: string): LabelLayout | null {
  if (!label || !points.length) return null;
  const screen = points.map(point => worldToScreen(mapping, point));
  const outline = annotation.type === 'sphere' && screen.length >= 2 ? screenPaths(annotation, screen)[0][0] : screen;
  const shape = shapeBox(outline, screen.length === 1 ? 10 : 6);
  // Labels sit on a dark chip (≥ 6.6:1 over white pixels) instead of a stroke halo, and long ROI
  // summaries wrap at their separators so they stay inside small panes. Text content is unchanged.
  const lines = wrapLabel(label, LABEL_CHARACTERS);
  const width = Math.ceil(Math.max(0, ...lines.map(line => textWidth(line, family, 500)))) + LABEL_PADDING * 2, height = lines.length * LABEL_LINE + 6;
  if (annotation.labelShift) {
    const [x, y] = worldToScreen(mapping, add(points[points.length - 1], annotation.labelShift));
    return { lines, width, height, x, y };
  }
  return { lines, width, height, ...placeLabelBeside(shape, { width, height }, mapping, hard, soft, screen[screen.length - 1]) };
}

/** A caliper's reference lines on screen (imaging/calipers.ts), dashed: for Keros, the level of the olfactory fossa's
 * floor carried out under the ethmoid roof and up to it, so the depth is the upright leg; or the sella lines through the
 * tuberculum and the dorsum, square to the line joining them, reaching past the sinus wall. `points` are on screen, in
 * the order the caliper reads them; `world` the same in patient mm. */
function caliperGuides(tag: CaliperTag, points: readonly Point2[], world: readonly Vec3[], mapping: ScreenMapping): string {
  if (tag.kind === 'keros' && world.length === 2) {
    const [floor, roof] = world, across = sub(roof, add(floor, scale(tag.up, dot(sub(roof, floor), tag.up))));
    const [a, b] = points, corner = worldToScreen(mapping, add(floor, across));
    return `M${a[0]},${a[1]}L${corner[0]},${corner[1]}L${b[0]},${b[1]}`;
  }
  if (points.length < 3 || tag.kind !== 'sella') return '';
  const [a, b, c] = points, dx = b[0] - a[0], dy = b[1] - a[1], run = Math.hypot(dx, dy);
  if (run < 1e-6) return '';
  const depth = ((c[0] - a[0]) * -dy + (c[1] - a[1]) * dx) / run, sign = depth < 0 ? -1 : 1, reach = Math.abs(depth) + 24;
  const nx = -dy / run * sign * reach, ny = dx / run * sign * reach;
  return `M${a[0]},${a[1]}l${nx},${ny}M${b[0]},${b[1]}l${nx},${ny}`;
}

/** Sent to a viewport's element with an annotation id, when that measurement is chosen in the inspector's list. */
export const PICK_MEASUREMENT = 'veacom:pick-measurement';
const GLOW = [{ filter: 'drop-shadow(0 0 0 #fff)' }, { filter: 'drop-shadow(0 0 5px #fff)' }, { filter: 'drop-shadow(0 0 0 #fff)' }];

function AnnotationDrawing({ annotation, shown, mapping, layout, selected, dashed = false, handles = true }: {
  annotation: Annotation; mapping: ScreenMapping; layout: LabelLayout | null; selected: boolean;
  /** Where it shows in this pane, if not at its own points: a sphere's circle on the plane. */
  shown?: readonly Vec3[];
  /** Drawn dashed: a sphere seen off its centre, or on a MIP. */
  dashed?: boolean;
  /** Its handles are drawn (not on a MIP, where it cannot be taken hold of). */
  handles?: boolean;
}) {
  const points = (shown ?? annotation.points).map(p => worldToScreen(mapping, p));
  if (!points.length) return null;
  // A caliper's points in the order it reads them, whatever order they were clicked or dragged into.
  const tag = annotation.caliper, world = tag ? caliperOrder(tag.kind, annotation.points, tag.up) : [];
  const ordered = tag ? world.map(p => worldToScreen(mapping, p)) : points;
  // VEAcom's yellow for measurements (Next's #ffcc00); white while selected.
  const color = selected ? '#ffffff' : annotation.color ?? '#ffcc00';
  const common = { fill: 'none', stroke: color, strokeWidth: selected ? 2 : 1.5, vectorEffect: 'non-scaling-stroke' as const };
  // A dark casing under every stroke keeps measurements ≥ 3:1 over bright tissue as well as over black.
  const casing = { ...common, stroke: '#000', strokeWidth: common.strokeWidth + 2.5, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  type StrokeProps = { fill: string; stroke: string; strokeWidth: number; vectorEffect: 'non-scaling-stroke'; strokeLinejoin?: 'round'; strokeLinecap?: 'round' };
  const draw = (common: StrokeProps) => {
  let shape;
  if (annotation.type === 'ellipse' && points.length >= 4) {
    const center: Point2 = [(points[0][0] + points[2][0]) / 2, (points[0][1] + points[2][1]) / 2];
    const rx = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]) / 2;
    const ry = Math.hypot(points[3][0] - points[0][0], points[3][1] - points[0][1]) / 2;
    const angle = Math.atan2(points[1][1] - points[0][1], points[1][0] - points[0][0]) * 180 / Math.PI;
    shape = <ellipse {...common} cx={center[0]} cy={center[1]} rx={rx} ry={ry} transform={`rotate(${angle} ${center[0]} ${center[1]})`} />;
  } else if (annotation.type === 'sphere' && points.length >= 2) {
    shape = <circle {...common} cx={points[0][0]} cy={points[0][1]} r={Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])} strokeDasharray={dashed ? '6 4' : undefined} />;
  } else if (annotation.type === 'rectangle' || annotation.type === 'polygon') {
    shape = <polygon {...common} points={pointString(points)} />;
  } else if (annotation.type === 'cobb') {
    shape = <><polyline {...common} points={pointString(points.slice(0, 2))} />{points.length > 2 && <polyline {...common} points={pointString(points.slice(2))} />}</>;
  } else if (annotation.type === 'probe' || annotation.type === 'text') {
    shape = <><circle {...common} cx={points[0][0]} cy={points[0][1]} r={4} /><path {...common} d={`M${points[0][0] - 8},${points[0][1]}h16 M${points[0][0]},${points[0][1] - 8}v16`} /></>;
  } else if (tag?.kind === 'sella' && ordered.length >= 3) {
    // The tuberculum–dorsum line, and a cross on the sinus wall.
    const [x, y] = ordered[2];
    shape = <><polyline {...common} points={pointString(ordered.slice(0, 2))} /><path {...common} d={`M${x - 6},${y}h12M${x},${y - 6}v12`} /></>;
  } else {
    shape = <polyline {...common} points={pointString(ordered)} />;
  }
  let arrow;
  if (annotation.type === 'arrow' && points.length >= 2) {
    const [a, b] = points, angle = Math.atan2(a[1] - b[1], a[0] - b[0]);
    arrow = <polyline {...common} points={`${a[0] - 12 * Math.cos(angle - 0.45)},${a[1] - 12 * Math.sin(angle - 0.45)} ${a} ${a[0] - 12 * Math.cos(angle + 0.45)},${a[1] - 12 * Math.sin(angle + 0.45)}`} />;
  }
  const guides = tag ? caliperGuides(tag, ordered, world, mapping) : '';
  return <>{shape}{arrow}{guides && <path {...common} d={guides} strokeDasharray="5 4" />}</>;
  };
  const lines = layout?.lines ?? [], chipWidth = layout?.width ?? 0, chipHeight = layout?.height ?? 0;
  const labelX = (layout?.x ?? 0) + LABEL_PADDING, labelY = (layout?.y ?? 0) + 13;
  // A label moved away from its measurement is joined to it by a thin line.
  const leader = annotation.labelShift && layout && annotation.type !== 'text' ? leaderLine(screenPaths(annotation, points), layout) : null;
  return <g data-annotation-id={annotation.id} data-selected={selected || undefined} style={{ pointerEvents: 'none' }}>
    {leader && <g className="annotation-leader"><line x1={leader[0][0]} y1={leader[0][1]} x2={leader[1][0]} y2={leader[1][1]} stroke="#000" strokeWidth={3} opacity={0.5} />
      <line x1={leader[0][0]} y1={leader[0][1]} x2={leader[1][0]} y2={leader[1][1]} stroke={color} strokeWidth={1} opacity={0.8} /></g>}
    <g className="annotation-casing" opacity={0.75}>{draw(casing)}</g>{draw(common)}
    {handles && points.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={selected ? 3.5 : 2.5} fill={color} stroke="#000" strokeWidth={1} />)}
    {lines.length > 0 && <g className="annotation-label">
      <rect x={labelX - LABEL_PADDING} y={labelY - 13} width={chipWidth} height={chipHeight} rx={3} fill="rgba(11, 13, 17, 0.8)" stroke={selected ? color : 'none'} strokeWidth={1} />
      <text x={labelX} y={labelY} fill={color} fontSize={12} fontWeight={500} fontFamily="var(--font-ui)">
        {lines.map((line, i) => <tspan key={i} x={labelX} dy={i ? LABEL_LINE : 0}>{line}</tspan>)}
      </text>
    </g>}
  </g>;
}


let firstDrawMarked = false;
function paintSlice(canvas: HTMLCanvasElement, current: ViewportProps, displayed: ViewState, requestedSlice: number) {
  const renderer = sliceRenderer();
  const milliseconds = renderer.render(canvas, current.volume, displayed, current.fusion);
  canvas.dataset.renderer = renderer.info.renderer;
  canvas.dataset.softwareRenderer = String(renderer.info.software);
  canvas.dataset.slice = String(displayed.slice);
  canvas.dataset.mode = displayed.mode ?? 'mpr';
  canvas.dataset.requestedSlice = String(requestedSlice);
  canvas.dataset.plane = displayed.plane;
  canvas.dataset.seriesId = current.volume.series.id;
  current.onFrame?.(milliseconds);
  // The page's first frame handed to the renderer, on its timeline for tools/browser-bench. It is drawn on screen later:
  // the benchmark's "first image" is the trace screenshot that first shows it.
  if (!firstDrawMarked) { firstDrawMarked = true; performance.mark('veacom:first-draw'); }
  canvas.dispatchEvent(new CustomEvent('veacom:frame', { bubbles: true, detail: {
    seriesId: current.volume.series.id, slice: displayed.slice, plane: displayed.plane, mode: displayed.mode ?? 'mpr',
    renderSubmitMs: milliseconds, finishedAt: performance.now(), measurementKind: 'cpu-render-submit-and-composite',
  } }));
}

export function Viewport(props: ViewportProps) {
  const { locale, t } = useTranslation();
  const container = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  const liveView = useRef(resolveView(props.volume, props.view));
  const size = useRef<[number, number]>(UNMEASURED);
  const sized = useRef(false);
  const drag = useRef<Drag | null>(null);
  const touches = useRef(new Map<number, Point2>()), pinch = useRef<Pinch | null>(null);
  const construction = useRef<Vec3[]>([]);
  const constructionTool = useRef<Tool | null>(null);
  const freehand = useRef<{ pointer: number; last: Point2; points: Vec3[] } | null>(null);
  // Pending first click of a click-click measurement, kept in patient space so view changes cannot distort it.
  const twoClick = useRef<{ mode: Tool; startWorld: Vec3 } | null>(null);
  const draftLive = useRef<Annotation | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [draftHint, setDraftHint] = useState<'viewport.clickEnd' | 'viewport.traceRegion' | 'viewport.clickPoints' | null>(null);
  // How many points of a caliper are placed: its hint asks for the next one.
  const [caliperStep, setCaliperStep] = useState(0);
  const [overlayView, setOverlayView] = useState(() => renderedView(props.volume, props.view));
  // Down the page is towards the feet on an axial stack (see paging.ts): wheel, drags and keys step this way.
  const backwards = pagesBackwards(props.volume.series, { plane: props.view.plane, mode: props.view.mode, oblique: props.view.oblique });
  const pageDirection = backwards ? -1 : 1;
  const [dimensions, setDimensions] = useState<[number, number]>(UNMEASURED);
  const [selected, setSelected] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  // Hiding a measurement also clears the selection used by Delete.
  if (props.hideMeasurements) {
    if (selected !== null) setSelected(null);
    if (picked !== null) setPicked(null);
  }
  // A measurement taken hold of: what of it, where the press began, and the measurement as it was.
  const editing = useRef<{ pointer: number; start: Point2; startWorld: Vec3; original: Annotation; part: AnnotationPart; labelBase: Vec3; moved: boolean; context: InteractionContext } | null>(null);
  const editLive = useRef<Annotation | null>(null);
  const [edited, setEdited] = useState<Annotation | null>(null);
  const baseCursor = annotationTools.has(props.tool) || props.tool === 'crosshair' ? 'crosshair' : props.tool === 'pan' ? 'grab' : 'default';
  // Ctrl + drag on a fused image: the pointer, where it was pressed and the PET's scale then.
  const petDrag = useRef<{ pointer: number; start: Point2; settings: { upperSuv: number; opacity: number } } | null>(null);
  const turning = useRef<{ pointer: number; id: string; pivot: Point2; last: number; turned: number; frame: PlaneFrame; mapping: ScreenMapping;
    planes: Array<{ reference: NonNullable<ViewportProps['referencePlanes']>[number]; component: 0 | 1 }> } | null>(null);
  // The MPR line under the pointer (or held) is drawn bold, as in VEAcom Next.
  const [heldLine, setHeldLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorLive = useRef<string | null>(null);
  const raf = useRef<number | null>(null), pendingPatch = useRef<Partial<ViewState> | null>(null);
  const pendingCrosshair = useRef<Vec3 | null>(null);
  const [textPrompt, setTextPrompt] = useState<{ point: Vec3; value: string } | null>(null);
  const wheelAccumulator = useRef(0);
  const renderNeeded = useRef(true);
  const context = useRef(interactionContext(props.volume, resolveView(props.volume, props.view)));
  const annotationContext = useRef<InteractionContext | null>(null);
  const promptId = useId();

  const gesture = useRef<GestureHandle | null>(null);
  const cancelGesture = (keepScroll = false) => {
    if (!keepScroll) {
      gesture.current?.end({ result: 'cancel' }); gesture.current = null;
      const pointers = new Set([...touches.current.keys(), ...(drag.current ? [drag.current.pointer] : []), ...(freehand.current ? [freehand.current.pointer] : []), ...(editing.current ? [editing.current.pointer] : []), ...(petDrag.current ? [petDrag.current.pointer] : []), ...(turning.current ? [turning.current.pointer] : [])]);
      for (const pointer of pointers) if (container.current?.hasPointerCapture(pointer)) container.current.releasePointerCapture(pointer);
      drag.current = null; touches.current.clear(); pinch.current = null; petDrag.current = null; turning.current = null; setHeldLine(null);
    }
    editing.current = null; editLive.current = null; setEdited(null);
    construction.current = []; constructionTool.current = null; freehand.current = null; annotationContext.current = null; twoClick.current = null;
    draftLive.current = null; pendingCrosshair.current = null;
    // The hints follow at once: the paint that sets them may not come before the next caliper asks for its first point.
    setDraft(null); setDraftHint(null); setCaliperStep(0); setTextPrompt(null); setSelected(null);
  };
  const syncInteractionContext = (volume: ViewportProps['volume'], view: ViewState) => {
    const next = interactionContext(volume, view), previous = context.current;
    if (sameContext(previous, next)) return;
    const keepScroll = drag.current?.mode === 'scroll' && previous.series === next.series && previous.plane === next.plane
      && (previous.requestedSlice !== next.requestedSlice || previous.displayedSlice !== next.displayedSlice);
    cancelGesture(keepScroll); context.current = next;
  };

  // The value under a hovering mouse or pen, in the corner (imaging/readout.ts): read again as the pointer moves and
  // whenever the image under it changes (paging, panning, a linked pane), without drawing the image again.
  const hover = useRef<Point2 | null>(null), readout = useRef<ReadoutSetter | null>(null);
  const updateReadout = () => {
    const set = readout.current, at = hover.current, current = latest.current, [width, height] = size.current;
    if (!set) return;
    if (!at || at[0] < 0 || at[1] < 0 || at[0] > width || at[1] > height) { set([]); return; }
    try {
      const view = renderedView(current.volume, liveView.current);
      set(pointerReadout(current.volume, view, screenToWorld(screenMapping(current.volume.series, view, width, height), ...at), current.fusion));
    } catch { set([]); }
  };
  const queue = (render = true) => {
    if (render) renderNeeded.current = true;
    if (raf.current !== null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const current = latest.current;
      syncInteractionContext(current.volume, liveView.current);
      const displayed = renderedView(current.volume, liveView.current);
      if (renderNeeded.current && canvas.current && sized.current) {
        renderNeeded.current = false;
        try {
          // Changing the bitmap size clears it. Resize and paint in the same frame.
          const dpr = window.devicePixelRatio || 1;
          const width = Math.max(1, Math.round(size.current[0] * dpr)), height = Math.max(1, Math.round(size.current[1] * dpr));
          if (canvas.current.width !== width) canvas.current.width = width;
          if (canvas.current.height !== height) canvas.current.height = height;
          paintSlice(canvas.current, current, displayed, liveView.current.slice);
          if (errorLive.current) { errorLive.current = null; setError(null); }
        } catch (e) {
          const message = e instanceof Error ? e.message : t('viewport.renderFailed');
          if (message !== errorLive.current) { errorLive.current = message; setError(message); }
        }
      }
      setOverlayView(displayed);
      updateReadout();
      setDraft(draftLive.current);
      setDraftHint(twoClick.current ? 'viewport.clickEnd' : construction.current.length ? (constructionTool.current === 'polygon' ? 'viewport.traceRegion' : 'viewport.clickPoints') : null);
      setCaliperStep(twoClick.current || (drag.current && annotationTools.has(drag.current.mode)) ? 1 : construction.current.length);
      setEdited(editLive.current);
      if (pendingPatch.current) { const patch = pendingPatch.current; pendingPatch.current = null; current.onViewChange(patch); }
      if (pendingCrosshair.current) { const point = pendingCrosshair.current; pendingCrosshair.current = null; current.onCrosshairChange(point); }
    });
  };

  const changeView = (patch: Partial<ViewState>) => {
    const next = patchView(latest.current.volume, liveView.current, patch);
    syncInteractionContext(latest.current.volume, next);
    liveView.current = next;
    const windowMode = patch.windowMode ?? ((patch.windowWidth !== undefined || patch.windowCenter !== undefined) ? 'manual' : undefined);
    pendingPatch.current = { ...pendingPatch.current, ...patch, ...(windowMode ? { windowMode } : {}) };
    queue();
  };
  // Takes the pane's size (and the canvas's to match) from the layout. The resize observer's frame comes a frame after
  // the layout changes, so pointer events take it too: closing 3D or the inspector widens the pane, and a click before
  // that frame must be judged (the right edge scrolls) and placed on the image by the pane it lands in.
  const measurePane = (bounds: DOMRect) => {
    const width = Math.max(1, bounds.width), height = Math.max(1, bounds.height);
    const dpr = window.devicePixelRatio || 1, pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    const geometryChanged = size.current[0] !== width || size.current[1] !== height;
    const bitmapChanged = canvas.current && (canvas.current.width !== pixelWidth || canvas.current.height !== pixelHeight);
    if (!geometryChanged && !bitmapChanged && sized.current) return;
    sized.current = true;
    if (geometryChanged) { size.current = [width, height]; setDimensions(size.current); }
    queue();
  };
  const mappingNow = () => screenMapping(latest.current.volume.series, renderedView(latest.current.volume, liveView.current), ...size.current);
  const pointAt = (x: number, y: number) => screenToWorld(mappingNow(), x, y);
  /** The pane shows a whole-volume MIP: clicks go to what made a pixel bright, and measuring tools only pick points. */
  const projectedNow = () => isProjection(latest.current.volume.series, renderedView(latest.current.volume, liveView.current));
  /** Where a pick at (x, y) puts the crosshair: the point there, or on a MIP the hottest voxel along that ray. */
  const pickAt = (x: number, y: number) => projectedNow() ? hottestAlongRay(latest.current.volume, renderedView(latest.current.volume, liveView.current), pointAt(x, y)) : pointAt(x, y);
  const local = (event: { clientX: number; clientY: number }): Point2 => {
    const bounds = container.current!.getBoundingClientRect(); measurePane(bounds); return [event.clientX - bounds.left, event.clientY - bounds.top];
  };
  // A PET is read inverted (imaging/quantity.ts petLook): reset brings that back, not plain grey.
  const reset = () => changeView({ zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: latest.current.volume.series.modality === 'PT', oblique: [0, 0] });
  const discardDraft = () => { construction.current = []; constructionTool.current = null; freehand.current = null; annotationContext.current = null; twoClick.current = null; draftLive.current = null; setDraft(null); setDraftHint(null); setCaliperStep(0); };
  /** Points of a two-point measurement from its start to `end` (rectangles and ellipses use the box corners). */
  const twoPointShape = (mode: Tool, startWorld: Vec3, end: Point2): Vec3[] => twoPointWorld(mappingNow(), mode, startWorld, end);
  /** Zoom about the pane centre, keeping the centred point where it is. */
  const zoomBy = (factor: number) => {
    const view = liveView.current, zoom = clamp(view.zoom * factor, 0.1, 30), scale = zoom / view.zoom;
    changeView({ zoom, pan: [view.pan[0] * scale, view.pan[1] * scale] });
  };
  const commit = (type: Tool, points: Vec3[], label?: string) => {
    const current = latest.current;
    if (!annotationContext.current || !sameContext(annotationContext.current, interactionContext(current.volume, liveView.current))) { cancelGesture(); return; }
    // A sphere is drawn too small to be one: a click, not a VOI.
    if (type === 'sphere' && !sphereOf({ type, points })) { discardDraft(); usage.markResult('cancel'); return; }
    // A sphere lies in the volume, not on the acquired slice it was drawn on.
    const view = renderedView(current.volume, liveView.current), source = type !== 'sphere' && usesSourceFrames(current.volume.series, view);
    const annotation: Annotation = { id: crypto.randomUUID(), type, points, mode: source ? 'source' : 'mpr', sourceFrame: source ? view.slice : undefined, sourceSopInstanceUid: source ? current.volume.series.frameMetadata?.[view.slice]?.sopInstanceUid : undefined, sourceFrameNumber: source ? current.volume.series.frameMetadata?.[view.slice]?.sourceFrameNumber : undefined, plane: view.plane, slice: view.slice, label,
      ...(!source && view.oblique?.some(Boolean) ? { oblique: [view.oblique[0], view.oblique[1]] as [number, number] } : {}) };
    current.onAnnotationsChange([...current.annotations, annotation]); setSelected(annotation.id); discardDraft();
    usage.markResult('ok');
  };
  const finishConstruction = () => {
    const type = constructionTool.current, points = construction.current.filter((p, i, all) => !i || length(sub(p, all[i - 1])) > 1e-5);
    // A traced outline is thinned as a freehand stroke is (its points a pixel or so apart otherwise).
    const shape = type === 'polygon' && points.length > 8 ? simplifyPolyline([...points, points[0]], 1 / mappingNow().pixelsPerMm).slice(0, -1) : points;
    if ((type === 'polygon' && shape.length >= 3) || (type === 'polyline' && shape.length >= 2)) commit(type, shape);
  };
  /** The measurement taken hold of, with the part held moved to `world`. */
  const editedAnnotation = (edit: NonNullable<typeof editing.current>, world: Vec3): Annotation => {
    const by = sub(world, edit.startWorld), original = edit.original;
    if (edit.part === 'label') return { ...original, labelShift: add(edit.labelBase, by) };
    // A sphere: its edge handle sets the radius (the point taken lies on its surface), its centre or its circle moves it
    // in the plane, keeping its depth.
    if (original.type === 'sphere') {
      if (edit.part === 1 && original.role === 'liver') return original;
      if (edit.part !== 1) return { ...original, points: original.points.map(point => add(point, by)) };
      return length(sub(world, original.points[0])) >= MIN_SPHERE_RADIUS_MM ? { ...original, points: [original.points[0], world] } : original;
    }
    if (edit.part === 'body') return { ...original, points: original.points.map(point => add(point, by)) };
    return { ...original, points: movedHandle(original, edit.part, world) };
  };
  const draftAnnotation = (type: Tool, points: Vec3[]): Annotation => {
    const view = renderedView(latest.current.volume, liveView.current), source = type !== 'sphere' && usesSourceFrames(latest.current.volume.series, view);
    return { id: 'draft', type, points, mode: source ? 'source' : 'mpr', sourceFrame: source ? view.slice : undefined, sourceSopInstanceUid: source ? latest.current.volume.series.frameMetadata?.[view.slice]?.sopInstanceUid : undefined, sourceFrameNumber: source ? latest.current.volume.series.frameMetadata?.[view.slice]?.sourceFrameNumber : undefined, plane: view.plane, slice: view.slice };
  };

  useLayoutEffect(() => {
    // The canvas and pending pointer gestures must see the committed view before the next frame or input.
    const previous = latest.current;
    latest.current = props;
    if (previous.view !== props.view || previous.volume !== props.volume) {
      const incoming = interactionContext(props.volume, props.view);
      if (incoming.series !== context.current.series || incoming.plane !== context.current.plane) pendingPatch.current = null;
      const next = pendingPatch.current ? patchView(props.volume, props.view, pendingPatch.current) : resolveView(props.volume, props.view);
      syncInteractionContext(props.volume, next);
      if (!sameView(liveView.current, next)) { liveView.current = next; queue(); }
    }
    if (previous.volume !== props.volume || previous.fusion !== props.fusion) queue();
    // An undo, deletion or tool change invalidates a drag before its release can overwrite the change; so does another
    // caliper, whose points mean something else.
    const edit = editing.current;
    if (previous.tool !== props.tool || previous.caliper?.key !== props.caliper?.key || (edit && previous.annotations !== props.annotations && !props.annotations.includes(edit.original))) cancelGesture();
    if ((!props.active || props.hideMeasurements) && twoClick.current) { twoClick.current = null; draftLive.current = null; setDraft(null); }
  }, [props, queue, syncInteractionContext, cancelGesture]);
  const refreshReadout = useEffectEvent(updateReadout);
  useEffect(() => { refreshReadout(); }, [props.showOverlay, locale]);
  const resizePane = useEffectEvent((element: HTMLElement) => measurePane(element.getBoundingClientRect()));
  const restore = useEffectEvent(() => queue());
  const wheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault(); if (drag.current) return;
    const view = liveView.current;
    const action = event.ctrlKey || event.metaKey ? 'zoom' : props.wheelAction ?? 'scroll';
    props.onActivate();
    if (action === 'none') return;
    usage.action(action === 'zoom' ? 'wheel-zoom' : action === 'rotate' ? 'wheel-rotate' : 'wheel-scroll', 'wheel', { burst: true });
    if (action === 'zoom') {
      const [x, y] = local(event), [w, h] = size.current;
      const zoom = clamp(view.zoom * Math.exp(-event.deltaY / 300), 0.1, 30), factor = zoom / view.zoom;
      changeView({ zoom, pan: [x - w / 2 - (x - w / 2 - view.pan[0]) * factor, y - h / 2 - (y - h / 2 - view.pan[1]) * factor] });
      return;
    }
    const amount = wheelSliceSteps(event, window.veacom?.zoomFactor?.() ?? 1) * (props.reverseWheel ? -1 : 1);
    wheelAccumulator.current += action === 'rotate' ? amount : amount * clamp(props.wheelSensitivity ?? 1, 0.1, 10);
    const steps = Math.trunc(wheelAccumulator.current); wheelAccumulator.current -= steps;
    if (!steps) return;
    if (action === 'rotate') changeView({ rotation: ((view.rotation + steps * 5) % 360 + 360) % 360 });
    else changeView({ slice: stepSlice(props.volume.series, view, steps * pageDirection) });
  });
  useEffect(() => {
    const element = container.current!;
    const resizeState = { frame: null as number | null };
    const resize = () => {
      if (resizeState.frame !== null) return;
      resizeState.frame = requestAnimationFrame(() => { resizeState.frame = null; resizePane(element); });
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const pick = (event: Event) => { if (!latest.current.hideMeasurements) setPicked((event as CustomEvent<string>).detail); };
    element.addEventListener(PICK_MEASUREMENT, pick);
    element.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('resize', resize);
    window.addEventListener('veacom-gpu-restored', restore);
    return () => {
      observer.disconnect();
      element.removeEventListener(PICK_MEASUREMENT, pick);
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('resize', resize);
      window.removeEventListener('veacom-gpu-restored', restore);
      if (resizeState.frame !== null) cancelAnimationFrame(resizeState.frame);
      if (raf.current !== null) { cancelAnimationFrame(raf.current); raf.current = null; }
    };
  }, []);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('input,button,textarea')) return;
    // A measurement picked in the list but not shown yet is no longer waited for once the reader acts here.
    setPicked(null);
    syncInteractionContext(latest.current.volume, liveView.current);
    const activating = !latest.current.active;
    latest.current.onActivate(); container.current?.focus({ preventScroll: true });
    const start = local(event), world = pointAt(...start);
    const input: InputKind = event.pointerType === 'touch' ? 'touch' : 'mouse';
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, start);
      event.currentTarget.setPointerCapture(event.pointerId);
      if (touches.current.size >= 2) {
        // The first finger's drag becomes a pinch: one action until the fingers lift.
        if (!gesture.current) gesture.current = usage.begin('pinch-zoom', 'touch');
        const [a, b] = [...touches.current.values()];
        pinch.current = { center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], distance: Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])), view: liveView.current };
        drag.current = null; editing.current = null; editLive.current = null; discardDraft(); return;
      }
    }
    const button = event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left';
    // A handle on another pane's line turns the crosshair about this pane's normal: both other planes turn together, so
    // their lines stay square and never lie on each other (as in VEAcom Next). Checked first: a handle is small and
    // exact, and Ctrl held while turning means 10° steps.
    const handle = button === 'left' && props.onRotateReference && props.crosshair && !construction.current.length && !twoClick.current
      ? handleTargets.find(item => Math.hypot(item.x - start[0], item.y - start[1]) <= 9) : undefined;
    if (handle && props.crosshair) {
      const pivot = worldToScreen(mapping, props.crosshair);
      const seenPlane = renderedView(latest.current.volume, liveView.current).plane;
      const turnable = new Set(handleTargets.map(item => item.id));
      const planes = (props.referencePlanes ?? []).filter(item => turnable.has(item.id) && lineAngle(frame, mapping, item.series, item.view, item.view.oblique ?? [0, 0]) !== null)
        .map(reference => ({ reference, component: rotationComponent(reference.view.plane, seenPlane) }));
      if (planes.some(item => item.reference.id === handle.id)) {
        event.currentTarget.setPointerCapture(event.pointerId);
        turning.current = { pointer: event.pointerId, id: handle.id, pivot, last: Math.atan2(start[1] - pivot[1], start[0] - pivot[0]), turned: 0, frame, mapping, planes };
        setHeldLine(handle.id);
        gesture.current = usage.begin('oblique-handle', input === 'touch' ? 'touch' : 'drag');
        return;
      }
    }
    // A drag that starts in the right edge pages the slices whatever the tool: with the mouse, one finger or a pen.
    if (button === 'left' && !construction.current.length && !twoClick.current && start[0] >= size.current[0] * EDGE_ZONE) {
      event.currentTarget.setPointerCapture(event.pointerId);
      if (event.detail <= 1) gesture.current = usage.begin('drag-scroll', input === 'touch' ? 'touch' : 'drag');
      drag.current = { mode: 'scroll', edge: true, start, startWorld: world, view: { ...liveView.current, pan: [...liveView.current.pan] }, pointer: event.pointerId, pointerType: event.pointerType, moved: false, activating };
      return;
    }
    if (button === 'left' && latest.current.onCyclePlane && !construction.current.length && !twoClick.current) {
      const [width, height] = size.current;
      if (start[0] <= Math.min(PLANE_LABEL_ZONE[0], width * 0.4) && start[1] >= height - Math.min(PLANE_LABEL_ZONE[1], height * 0.25)) {
        usage.action('plane-cycle', input); latest.current.onCyclePlane(); return;
      }
    }
    const bound: Tool = latest.current.mouseBindings?.[button] ?? (button === 'middle' ? 'pan' : button === 'right' ? 'zoom' : latest.current.tool);
    // On a MIP a measuring tool picks the point instead: a drawing there would not be in any one plane.
    const mode: Tool = annotationTools.has(bound) && projectedNow() ? 'crosshair' : bound;
    // Ctrl + drag on a fused image sets the PET's scale, as a plain drag sets the CT's window: across for the top
    // of the scale, up and down for its opacity (as in VEAcom Next).
    if (button === 'left' && (event.ctrlKey || event.metaKey) && latest.current.fusion && latest.current.onFusionAdjust) {
      event.currentTarget.setPointerCapture(event.pointerId);
      petDrag.current = { pointer: event.pointerId, start, settings: { upperSuv: latest.current.fusion.upperSuv, opacity: latest.current.fusion.opacity } };
      gesture.current = usage.begin('fusion-drag', input === 'touch' ? 'touch' : 'drag');
      return;
    }
    if ((annotationTools.has(mode) || mode === 'crosshair') && latest.current.volume.sourceFrameIndex !== undefined && latest.current.volume.sourceFrameIndex !== liveView.current.slice) return;
    // A press on a measurement (a handle, its label or its line) takes hold of it whatever the tool, as in VEAcom
    // Next; not while one is drawn point by point or waits for its second click, nor while a caliper asks for its
    // points (another side's label may sit on them).
    const screenCurrent = samePlacement(overlayView, renderedView(props.volume, liveView.current));
    if (button === 'left' && screenCurrent && !construction.current.length && !twoClick.current && !latest.current.hideMeasurements && !latest.current.caliper
      && (latest.current.volume.sourceFrameIndex === undefined || latest.current.volume.sourceFrameIndex === liveView.current.slice)) {
      const hit = hitAnnotation(hitTargets, selected, start);
      if (hit) {
        const original = hit.annotation, index = shownAnnotations.indexOf(original), label = labelLayouts[index];
        // A label sits beside where the measurement shows here (a sphere's circle on this plane).
        const shownHere = shown[index].points, last = shownHere[shownHere.length - 1];
        const labelBase = original.labelShift ?? (label ? sub(screenToWorld(mapping, label.x, label.y), last) : [0, 0, 0] as Vec3);
        event.currentTarget.setPointerCapture(event.pointerId);
        setSelected(original.id);
        editing.current = { pointer: event.pointerId, start, startWorld: world, original, part: hit.part, labelBase, moved: false, context: interactionContext(latest.current.volume, liveView.current) };
        const kind = input === 'touch' ? 'touch' : 'drag';
        gesture.current = hit.part === 'label' ? usage.begin('annotation-label', kind) : hit.part === 'body' ? usage.begin('annotation-move', kind) : usage.begin('annotation-handle', kind);
        return;
      }
      // A press beside a selected measurement on this slice only lets it go; drawing starts with the next press (or at
      // once on another slice, where the selected one is not shown).
      if (selected) {
        const onScreen = hitTargets.some(target => target.annotation.id === selected);
        setSelected(null);
        if (onScreen && annotationTools.has(mode)) return;
      }
    }
    if (mode === 'none') return;
    if (event.detail > 1 && clickTools.has(mode)) return;
    // Another measurement tool replaces a pending click-click measurement; panning or zooming in between keeps it.
    if (twoClick.current && twoClick.current.mode !== mode && annotationTools.has(mode)) discardDraft();
    if (annotationTools.has(mode) && !annotationContext.current) annotationContext.current = interactionContext(latest.current.volume, liveView.current);
    if (clickTools.has(mode)) {
      if (constructionTool.current && constructionTool.current !== mode) { discardDraft(); annotationContext.current = interactionContext(latest.current.volume, liveView.current); }
      constructionTool.current = mode;
      // An outline traced by moving the pointer (no button held) closes with the next click, wherever it is.
      if (mode === 'polygon' && construction.current.length >= 3) { usage.action('point-polygon', input); finishConstruction(); return; }
      if (mode === 'polygon' && !construction.current.length) {
        freehand.current = { pointer: event.pointerId, last: start, points: [world] };
        event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = usage.begin('draw-polygon', input === 'touch' ? 'touch' : 'drag');
      } else usage.action(`point-${mode}`, input);
      construction.current = [...construction.current, world];
      usage.touch('marks'); // The point shows before the measurement exists.
      if ((mode === 'angle' && construction.current.length === 3) || (mode === 'cobb' && construction.current.length === 4)) { commit(mode, construction.current); return; }
      draftLive.current = draftAnnotation(mode, construction.current); queue(false); return;
    }
    if (mode === 'probe') { usage.action('point-probe', input); commit(mode, [world]); return; }
    if (mode === 'text') { usage.action('point-text', input); usage.touch('marks'); event.preventDefault(); setTextPrompt({ point: world, value: '' }); return; }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.detail <= 1) gesture.current = usage.begin(annotationTools.has(mode) ? `draw-${mode}` : `drag-${mode}`, input === 'touch' ? 'touch' : 'drag');
    drag.current = { mode, start, startWorld: world, view: { ...liveView.current, pan: [...liveView.current.pan] }, pointer: event.pointerId, pointerType: event.pointerType, moved: false, activating };
    if (mode === 'crosshair') { pendingCrosshair.current = pickAt(...start); queue(false); }
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    syncInteractionContext(latest.current.volume, liveView.current);
    const point = local(event), active = drag.current;
    if (event.pointerType !== 'touch') { hover.current = point; updateReadout(); }
    if (touches.current.has(event.pointerId)) touches.current.set(event.pointerId, point);
    if (pinch.current && touches.current.size >= 2) {
      const [a, b] = [...touches.current.values()], initial = pinch.current;
      const center: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const zoom = clamp(initial.view.zoom * distance / initial.distance, 0.1, 30), factor = zoom / initial.view.zoom, [w, h] = size.current;
      changeView({ zoom, pan: [center[0] - w / 2 - (initial.center[0] - w / 2 - initial.view.pan[0]) * factor,
        center[1] - h / 2 - (initial.center[1] - h / 2 - initial.view.pan[1]) * factor] }); return;
    }
    const edit = editing.current;
    if (edit && edit.pointer === event.pointerId) {
      edit.moved = edit.moved || Math.hypot(point[0] - edit.start[0], point[1] - edit.start[1]) > (event.pointerType === 'mouse' ? 2 : 8);
      if (edit.moved) { editLive.current = editedAnnotation(edit, pointAt(...point)); queue(false); }
      return;
    }
    const turn = turning.current;
    if (turn && turn.pointer === event.pointerId) {
      const angle = Math.atan2(point[1] - turn.pivot[1], point[0] - turn.pivot[0]);
      turn.turned += ((angle - turn.last + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      turn.last = angle;
      const step = event.shiftKey ? 5 : event.ctrlKey || event.metaKey ? 10 : 0;
      for (const { reference, component } of turn.planes) {
        latest.current.onRotateReference?.(reference.id, turnedOblique(turn.frame, turn.mapping, reference.series, reference.view, component, turn.turned, step));
      }
      return;
    }
    // The pointer shows what a press would take hold of: an MPR handle, a measurement's handle, or a label or line to move.
    if (!active && event.pointerType === 'mouse' && event.buttons === 0 && container.current && (hitTargets.length || handleTargets.length)) {
      const nearLine = handleTargets.find(item => Math.hypot(item.x - point[0], item.y - point[1]) <= 9)?.id ?? null, near = nearLine !== null;
      if (nearLine !== heldLine) setHeldLine(nearLine);
      const hit = near || construction.current.length || twoClick.current ? null : hitAnnotation(hitTargets, selected, point);
      container.current.style.cursor = near ? 'grab' : hit ? (typeof hit.part === 'number' ? 'pointer' : 'move') : baseCursor;
    }
    if (petDrag.current?.pointer === event.pointerId) {
      const held = petDrag.current;
      latest.current.onFusionAdjust?.(draggedFusion(held.settings, point[0] - held.start[0], point[1] - held.start[1]));
      return;
    }
    if (freehand.current?.pointer === event.pointerId) {
      const outline = freehand.current;
      if (Math.hypot(point[0] - outline.last[0], point[1] - outline.last[1]) >= 2) {
        outline.last = point; outline.points.push(pointAt(...point));
        draftLive.current = draftAnnotation('polygon', [...outline.points]); queue(false);
      }
      return;
    }
    if (!active) {
      if (twoClick.current) { const first = twoClick.current; draftLive.current = draftAnnotation(first.mode, twoPointShape(first.mode, first.startWorld, point)); queue(false); return; }
      // A region begun with a click follows the pointer: moving traces its outline, no clicking point by point.
      if (constructionTool.current === 'polygon' && construction.current.length && event.buttons === 0) {
        const last = worldToScreen(mappingNow(), construction.current[construction.current.length - 1]);
        if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= 4) construction.current = [...construction.current, pointAt(...point)];
      }
      if (construction.current.length && constructionTool.current) { draftLive.current = draftAnnotation(constructionTool.current, [...construction.current, pointAt(...point)]); queue(false); }
      return;
    }
    const dx = point[0] - active.start[0], dy = point[1] - active.start[1], initial = active.view;
    // A measuring press becomes a drag only past the usual click wobble: 4 px for a mouse, 12 px for touch and
    // pen, and 8 px for a mouse while a click-click measurement waits for its second click.
    const slop = !twoPointTools.has(active.mode) ? 2 : active.pointerType !== 'mouse' ? 12 : twoClick.current ? 8 : 4;
    active.moved = active.moved || Math.hypot(dx, dy) > slop;
    if (active.mode === 'window' && latest.current.volume.series.components !== 3) {
      const gain = Math.max(1, initial.windowWidth) / 300;
      changeView({ windowWidth: Math.max(1, initial.windowWidth + dx * gain), windowCenter: initial.windowCenter - dy * gain });
    } else if (active.mode === 'pan') {
      changeView({ pan: [initial.pan[0] + dx, initial.pan[1] + dy] });
    } else if (active.mode === 'zoom') {
      const zoom = clamp(initial.zoom * Math.exp(-dy / 160), 0.1, 30), factor = zoom / initial.zoom, [w, h] = size.current;
      changeView({ zoom, pan: [active.start[0] - w / 2 - (active.start[0] - w / 2 - initial.pan[0]) * factor, active.start[1] - h / 2 - (active.start[1] - h / 2 - initial.pan[1]) * factor] });
    } else if (active.mode === 'scroll') {
      const steps = active.edge ? Math.trunc(dy / EDGE_PX_PER_SLICE) : Math.round(dy / 5);
      changeView({ slice: stepSlice(props.volume.series, initial, steps * pageDirection) });
    } else if (active.mode === 'rotate') {
      // Free rotation, as in VEAcom Next: the image turns as far as the pointer goes round the pane's centre.
      const [w, h] = size.current, angle = (p: Point2) => Math.atan2(p[1] - h / 2, p[0] - w / 2) * 180 / Math.PI;
      const turned = angle(point) - angle(active.start);
      changeView({ rotation: ((initial.rotation + turned) % 360 + 360) % 360 });
    } else if (active.mode === 'crosshair') {
      pendingCrosshair.current = pickAt(...point); queue(false);
    } else if (annotationTools.has(active.mode)) {
      // Dragging on the second press makes an ordinary measurement and drops the pending first click.
      const first = twoClick.current;
      if (first && active.moved) twoClick.current = null;
      draftLive.current = draftAnnotation(active.mode, first && !active.moved ? twoPointShape(active.mode, first.startWorld, point) : twoPointShape(active.mode, active.startWorld, point)); queue(false);
    }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    syncInteractionContext(latest.current.volume, liveView.current);
    touches.current.delete(event.pointerId);
    if (pinch.current) {
      if (touches.current.size < 2) { pinch.current = null; gesture.current?.end({ id: 'pinch-zoom', input: 'touch' }); gesture.current = null; }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      drag.current = null; return;
    }
    const edit = editing.current;
    if (edit && edit.pointer === event.pointerId) {
      editing.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      const next = editLive.current; editLive.current = null; setEdited(null);
      const kept = edit.moved && next !== null && sameContext(edit.context, interactionContext(latest.current.volume, liveView.current));
      gesture.current?.end(kept ? {} : { id: 'annotation-select', input: event.pointerType === 'touch' ? 'touch' : 'mouse' }); gesture.current = null;
      if (kept) latest.current.onAnnotationsChange(latest.current.annotations.map(annotation => annotation.id === next.id ? next : annotation));
      return;
    }
    if (petDrag.current?.pointer === event.pointerId || turning.current?.pointer === event.pointerId) {
      if (turning.current) setHeldLine(null);
      petDrag.current = null; turning.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      gesture.current?.end(); gesture.current = null;
      return;
    }
    if (freehand.current?.pointer === event.pointerId) {
      const outline = freehand.current; freehand.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (outline.points.length >= 3) {
        const simplified = simplifyPolyline([...outline.points, outline.points[0]], 1 / mappingNow().pixelsPerMm).slice(0, -1);
        if (simplified.length >= 3) commit('polygon', simplified);
      }
      // A press without a stroke starts a polygon point by point instead.
      gesture.current?.end(outline.points.length >= 3 ? {} : { id: 'point-polygon', input: 'mouse' }); gesture.current = null;
      return;
    }
    const active = drag.current; if (!active || active.pointer !== event.pointerId) return;
    gesture.current?.end(active.moved ? {} : { id: `click-${active.mode}`, input: event.pointerType === 'touch' ? 'touch' : 'mouse' }); gesture.current = null;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // A still left click on a MIP goes there whatever the tool: the linked panes go to the hottest voxel along that ray.
    if (!active.moved && !active.edge && event.button === 0 && active.mode !== 'crosshair' && projectedNow()) { latest.current.onCrosshairChange(pickAt(...active.start)); return; }
    // With 3D open, a still left click marks the point there too (the toolbar waits while 3D is open).
    if (!active.moved && !active.edge && event.button === 0 && latest.current.clickPicksPoint && !annotationTools.has(active.mode) && active.mode !== 'crosshair') {
      latest.current.onCrosshairChange(active.startWorld); return;
    }
    if (annotationTools.has(active.mode) && active.moved && draftLive.current) commit(active.mode, draftLive.current.points);
    else if (!active.moved && twoPointTools.has(active.mode)) {
      const first = twoClick.current;
      if (first && first.mode === active.mode) {
        // Second still click: finish the click-click measurement (a click on the start point cancels it).
        twoClick.current = null;
        const end = local(event), [x, y] = worldToScreen(mappingNow(), first.startWorld);
        if (Math.hypot(end[0] - x, end[1] - y) > 2) commit(active.mode, twoPointShape(active.mode, first.startWorld, end)); else { usage.touch('marks'); discardDraft(); }
        return;
      }
      // First still click: start a click-click measurement; the start point shows until the second click.
      // A click that only makes this pane the active one does not start one.
      if (active.activating) { discardDraft(); return; }
      twoClick.current = { mode: active.mode, startWorld: active.startWorld };
      usage.touch('marks');
      draftLive.current = draftAnnotation(active.mode, [active.startWorld]); queue(false); return;
    }
    // A still click with the scroll tool marks the point; the right edge's paging strip only pages (a click there marks nothing).
    else if (!active.moved && active.mode === 'scroll' && !active.edge) { pendingCrosshair.current = pointAt(...local(event)); queue(false); }
    if (draftLive.current && !construction.current.length && !twoClick.current) discardDraft();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in the note form belong to it (Enter on its buttons, arrows); Esc is handled there too.
    if ((event.target as HTMLElement).closest('input, textarea, .annotation-prompt')) return;
    setPicked(null);
    if (event.key === 'Escape') {
      // Esc first cancels what is in progress here; only an idle viewport lets it close panels further out.
      const busy = Boolean(drag.current || construction.current.length || freehand.current || twoClick.current || draftLive.current || selected || textPrompt);
      cancelGesture();
      if (busy) event.stopPropagation();
    }
    else if (event.key === 'Enter') { event.preventDefault(); usage.action('key-finish', 'key'); finishConstruction(); }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && selected && !latest.current.hideMeasurements) {
      event.preventDefault(); usage.action('annotation-delete', 'key'); latest.current.onAnnotationsChange(latest.current.annotations.filter(a => a.id !== selected)); setSelected(null);
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey && ['+', '=', '-', '_'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); zoomBy(event.key === '-' || event.key === '_' ? 1 / 1.25 : 1.25);
    } else if (event.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      // Shift + arrows move the image: the keyboard alternative to a pan drag.
      event.preventDefault(); event.stopPropagation();
      const step = 40, [dx, dy] = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[event.key as 'ArrowUp'];
      changeView({ pan: [liveView.current.pan[0] + dx, liveView.current.pan[1] + dy] });
    } else {
      const delta = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 }[event.key];
      if (delta !== undefined) { event.preventDefault(); event.stopPropagation(); usage.action('key-slice', 'key', { burst: true }); changeView({ slice: stepSlice(props.volume.series, liveView.current, delta * pageDirection) }); }
    }
  };

  const mapping = screenMapping(props.volume.series, overlayView, ...dimensions);
  const frame = getPlaneFrame(props.volume.series, overlayView);
  // The slice number counts in paging order: 1 at the top of an axial stack.
  const shownBackwards = pagesBackwards(props.volume.series, { plane: overlayView.plane, mode: overlayView.mode, oblique: overlayView.oblique });
  // A whole-volume MIP: no drawing lies in it, and the crosshair shows wherever it is in depth.
  const projected = isProjection(props.volume.series, overlayView);
  const visibleAnnotations = props.hideMeasurements ? NO_ANNOTATIONS
    : props.annotations.filter(annotation => projected ? annotation.type === 'sphere' : shownOnView(annotation, props.volume.series, overlayView, frame));
  // A measurement being moved shows where it goes; it is kept when the press ends.
  const shownAnnotations = props.hideMeasurements ? NO_ANNOTATIONS : edited ? visibleAnnotations.map(annotation => annotation.id === edited.id ? edited : annotation) : visibleAnnotations;
  // A measurement chosen in the list is selected once it is on screen, after any jump to its slice. The glow
  // answers every click, including one on a measurement already selected on this slice.
  const pickedOnScreen = picked !== null && shownAnnotations.some(annotation => annotation.id === picked);
  useEffect(() => {
    if (!picked) return;
    if (!pickedOnScreen) {
      const timer = setTimeout(() => setPicked(null), 3000);
      return () => clearTimeout(timer);
    }
    setPicked(null); setSelected(picked);
    container.current?.querySelector(`[data-annotation-id="${CSS.escape(picked)}"]`)?.animate(GLOW, { duration: 600, iterations: 2 });
  }, [picked, pickedOnScreen]);
  const movingSphere = edited?.type === 'sphere' && visibleAnnotations.some(item => item.id === edited.id && item.points !== edited.points) ? edited : null;
  const summaries = useAnnotationSummaries(movingSphere ? visibleAnnotations : shownAnnotations, props.volume);
  // A sphere marked as a reference says which; one with a confirmed Deauville score gives it.
  const named = summaries.map((label, index) => {
    const annotation = shownAnnotations[index];
    if (movingSphere?.id === annotation.id) return t('sphere.diameter', { value: ((sphereOf(annotation)?.radius ?? 0) * 2).toFixed(1) });
    if (annotation.type !== 'sphere' || !label) return label;
    const role = annotation.role ? `${t(annotation.role === 'liver' ? 'sphere.liverLabel' : 'sphere.bloodPoolLabel')} · ` : annotation.label ? `${annotation.label} · ` : '';
    const score = movingSphere?.role ? undefined : currentDeauville(annotation, props.annotations, props.volume);
    return `${role}${label}${score !== undefined ? ` · ${t('deauville.label', { score })}` : ''}`;
  });
  // With a PET fused over the image, a region or a probe also gives the PET's value there.
  const labels = props.fusion ? named.map((label, index) => {
    if (movingSphere?.id === shownAnnotations[index].id) return label;
    const pet = petLine(shownAnnotations[index], props.fusion!.volume, locale);
    return pet && label ? `${label}\n${pet}` : label;
  }) : named;
  // Where each measurement shows here: a sphere as the circle this plane cuts from it (dashed off its centre and on a
  // MIP), the others at their own points.
  const shown = shownAnnotations.map(annotation => {
    if (annotation.type !== 'sphere') return { points: annotation.points, dashed: false };
    const onPlane = sphereOnPlane(annotation, frame, mapping, projected);
    return { points: onPlane?.points ?? annotation.points, dashed: projected || Math.abs(onPlane?.depth ?? 0) > Math.max(frame.step, 0.1) / 2 };
  });
  const peakSections = projected || movingSphere || props.volume.series.modality !== 'PT' ? [] : shownAnnotations.flatMap(item => {
    if (item.type !== 'sphere' || item.role || (selected && selected !== item.id)) return [];
    const peak = sphereStatisticsFor(item, props.volume, quantitativeScale(props.volume.series))?.peak;
    const section = peak && sphereSection({ center: peak.at, radius: PEAK_RADIUS_MM }, frame);
    if (!section) return [];
    const [x, y] = worldToScreen(mapping, section.center);
    return [{ id: item.id, x, y, radius: section.radius * mapping.pixelsPerMm }];
  });
  // A sphere with a metabolic volume shows the voxels it counts, cut by this plane (not on a MIP, which has no plane).
  const metabolicFrames = projected || movingSphere ? [] : shownAnnotations.flatMap(annotation => {
    if (annotation.type !== 'sphere' || !annotation.threshold) return [];
    const mask = thresholdVolumeFor(annotation, props.volume, quantitativeScale(props.volume.series))?.mask;
    return mask ? planeOutlines(mask, frame).map(item => ({ id: annotation.id, frame: item })) : [];
  });
  const segmentationFrames = (props.segmentations ?? []).flatMap(overlay =>
    segmentationApplies(overlay.series, props.volume.series) ? overlayShapes(overlay, frame).map(item => ({ id: overlay.id, frame: item })) : []);
  // The picked point is marked only on the slice that holds it (within half a slice): paged away, it is gone.
  const crosshair = props.crosshair && (projected || Math.abs(dot(sub(props.crosshair, frame.center), frame.normal)) / Math.max(length(frame.normal), 1e-9) <= Math.max(frame.step, 0.1) / 2 + 1e-3)
    ? worldToScreen(mapping, props.crosshair) : null;
  const metadataWidth = Math.max(20, dimensions[0] / 2 - 18);
  // Lines that reach the height of the bottom orientation letter stop short of it.
  const lowerWidth = Math.max(20, Math.min(metadataWidth, dimensions[0] / 2 - 30));
  const source = usesSourceFrames(props.volume.series, overlayView);
  const displayedSeries = source ? sourceFrameSeries(props.volume.series, overlayView.slice) : props.volume.series;
  const nm = source ? props.volume.series.frameMetadata?.[overlayView.slice]?.nm : undefined;
  const { fontFamily, topLeft, topRight, plainLeft, plainRight } = usePatientCorners(props.volume.series, props.showOverlay !== false, props.hidePatientData === true, metadataWidth, t, nm);
  // The thickness only where the acquired slices are shown: a reformatted plane is not that thick.
  const direction = props.volume.series.direction;
  const acquiredPlane = source || Math.abs(dot(frame.normal, [direction[2], direction[5], direction[8]])) > 0.999 * length([direction[2], direction[5], direction[8]]);
  const normalAxis = frame.normal.reduce((best, value, axis) => Math.abs(value) > Math.abs(frame.normal[best]) ? axis : best, 0);
  const location = displayedSeries.orientationKnown === true && displayedSeries.positionKnown !== false ? frame.center[normalAxis] : null;
  const detailLine = projected ? '' : sliceDetail(acquiredPlane ? props.volume.series.sliceThickness : undefined, location, t);
  const scanner = scannerLines(props.volume.series);
  const bottomRight = props.showOverlay === false ? [] : [...scanner, ...(props.fusion ? [
    fusionLine(props.fusion.volume.series, props.hidePatientData === true, t),
    props.fusion.volume.series.modality !== 'PT' ? t('viewport.fusionOwnValues', { opacity: percent(Math.round(props.fusion.opacity * 100), locale) })
      : petHasSuv(props.fusion.volume.series) ? t('viewport.fusionScale', { upper: general(props.fusion.upperSuv), opacity: percent(Math.round(props.fusion.opacity * 100), locale) })
      : t('viewport.fusionScaleOwn', { opacity: percent(Math.round(props.fusion.opacity * 100), locale) }),
  ] : [])].map(text => ({ text, fitted: fitWidth(text, lowerWidth, fontFamily) }));
  // The fused series' name reads differently with patient details hidden (fusionLine): it is drawn with the patient corners,
  // and its plain form with the plain corners, so a copied picture takes the plain one.
  const fusionNameAt = props.fusion && props.showOverlay !== false ? scanner.length : -1;
  const plainFusionName = props.fusion && fusionNameAt >= 0 && !props.hidePatientData ? fitWidth(fusionLine(props.fusion.volume.series, true, t), lowerWidth, fontFamily) : null;
  // The pointer's value takes the lowest lines of the bottom-right corner (the pane's own, then a fused PET's), kept for
  // it while the overlay shows, so labels and corner lines stay put as it comes and goes.
  const readoutLines = props.showOverlay === false || props.volume.series.components === 3 ? 0 : props.fusion && !projected ? 2 : 1;
  const bottomRightY = (index: number) => dimensions[1] - 40 - (bottomRight.length - 1 - index + readoutLines) * 16;
  const keepOut = props.showOverlay === false || (!shownAnnotations.length && !draft) ? NO_BOXES : overlayKeepOut(dimensions[0], dimensions[1], metadataWidth,
    { topLeft: topLeft.length, topRight: topRight.length, bottomLeft: detailLine ? 3 : 2, bottomRight: bottomRight.length + readoutLines });
  // Labels avoid the overlay text and the chips placed before them (hard), and every shape on the slice (soft).
  const placed: Box[] = [...keepOut];
  const shapes: Box[] = shownAnnotations.flatMap((annotation, index) => {
    if (!shown[index].points.length) return [];
    const screen = shown[index].points.map(point => worldToScreen(mapping, point));
    return shapeKeepOut(annotation.type === 'sphere' && screen.length >= 2 ? screenPaths(annotation, screen)[0][0] : screen, CLOSED_SHAPES.has(annotation.type), 6, mapping);
  });
  // A MIP shows spheres without labels, which would cover it: the list and the planes give their values.
  const labelLayouts = shownAnnotations.map((annotation, index) => {
    if (projected) return null;
    const layout = labelLayout(annotation, shown[index].points, mapping, labels[index] ?? '', placed, shapes, fontFamily);
    if (layout) placed.push(layout);
    return layout;
  });
  // A sphere being drawn gives its diameter as it grows.
  const draftSphere = draft?.type === 'sphere' ? sphereOf(draft) : null;
  const draftShown = draft && draftSphere ? sphereOnPlane(draft, frame, mapping, projected)?.points ?? draft.points : draft?.points ?? [];
  const draftLabel = !draft ? '' : clickTools.has(draft.type) ? t('viewport.clickToAdd') : draftSphere ? t('sphere.diameter', { value: (draftSphere.radius * 2).toFixed(1) }) : '';
  const draftLayout = draft ? labelLayout(draft, draftShown, mapping, draftLabel, placed, shapes, fontFamily) : null;
  const measure = measurementSpace(displayedSeries);
  const unitsPerWorld = measure.unit === 'mm' ? measure.scale
    : length(sub(worldToIndex(displayedSeries, add(mapping.center, mapping.right)), worldToIndex(displayedSeries, mapping.center)));
  const pixelsPerUnit = mapping.pixelsPerMm / Math.max(1e-8, unitsPerWorld);
  const scaleUnits = [1, 2, 5, 10, 20, 50, 100].filter(n => n * pixelsPerUnit <= dimensions[0] * 0.2).at(-1) ?? 1;
  // Bottom-left lines give way to the scale bar instead of running into it (full text in <title>).
  // A frame shown through its VOI LUT names the LUT; a non-linear VOI function is named after W / L (from main).
  // The preset's name after its window (the presets are CT windows, so only for values in HU).
  const windowPreset = props.volume.series.valueUnit === 'HU' && overlayView.voiLut === undefined ? presetFor(overlayView.windowWidth, overlayView.windowCenter) : undefined;
  const windowText = props.volume.series.components === 3 ? 'RGB'
    : overlayView.voiLut !== undefined ? `${t('viewport.voiLut')}${props.volume.series.voiLuts?.[overlayView.voiLut]?.explanation ? ` · ${props.volume.series.voiLuts[overlayView.voiLut].explanation}` : ''}`
    // A PET with SUV reads its window in SUV (imaging/quantity.ts); every other series in its stored values.
    : suvWindowText(props.volume.series, overlayView) ?? `W ${Math.round(overlayView.windowWidth)} / L ${Math.round(overlayView.windowCenter)} ${storedUnit(props.volume.series)}${overlayView.voiFunction ? ` · ${t(overlayView.voiFunction === 'SIGMOID' ? 'viewport.sigmoid' : 'viewport.linearExact')}` : ''}${windowPreset ? ` [${t(`preset.${windowPreset.key}` as const)}]` : ''}`;
  const windowLine = windowText;
  const tilt = source ? 0 : obliqueAngle(props.volume.series, overlayView);
  // The acquired images are named by their plane too ("aksiyel"), as VEAcom 1.x did; a click on it changes the plane.
  // Like the orientation letters, only where the orientation is known: a planar gamma camera view or a picture lies in
  // no plane of the patient.
  const sourcePlane = source && displayedSeries.orientationKnown === true ? seriesPlane(props.volume.series) : null;
  // Written as a name, capitalised ("Koronal"), as VEAcom 1.x wrote it.
  const planeName = source ? (sourcePlane ? t(`plane.${sourcePlane}` as const) : '') : tilt ? t('viewport.obliquePlane', { plane: t(`plane.${overlayView.plane}` as const), angle: tilt }) : t(`plane.${overlayView.plane}` as const);
  const sliceLine = projected ? t('projection.label', { angle: projectionAngle(overlayView.slice) }) : `${planeName ? `${planeName} · ` : ''}${!source && overlayView.slab ? `${t('slab.label', { mode: t(`slab.${overlayView.slab.mode}` as const), thickness: overlayView.slab.thickness })} · ` : ''}${shownBackwards ? frame.slices - Math.round(overlayView.slice) : Math.round(overlayView.slice) + 1} / ${frame.slices}${source && props.volume.series.frameMetadata?.[overlayView.slice]?.instanceNumber !== undefined ? t('viewport.instance', { number: props.volume.series.frameMetadata[overlayView.slice].instanceNumber! }) : ''}`;
  const bottomWidth = Math.max(40, dimensions[0] - 12 - (props.showScale ? scaleUnits * pixelsPerUnit + 14 : 0) - 16);
  const axisLabels = displayedSeries.orientationKnown === true
    ? { left: orientationLabel(scale(mapping.right, -1)), right: orientationLabel(mapping.right), top: orientationLabel(scale(mapping.down, -1)), bottom: orientationLabel(mapping.down) }
    : { left: '', right: '', top: '', bottom: '' };
  const referenceLines = (props.referencePlanes ?? []).flatMap(reference => {
    const theirs = getPlaneFrame(reference.series, reference.view);
    const segment = referenceSegment(frame, theirs);
    if (!segment) return [];
    const [point, end] = segment.map(p => worldToScreen(mapping, p));
    const magnitude = Math.hypot(end[0] - point[0], end[1] - point[1]);
    if (magnitude < 1e-8) return [];
    const dx = (end[0] - point[0]) / magnitude, dy = (end[1] - point[1]) / magnitude;
    // Three-plane MPR: a handle either side of the crosshair, on the line, to turn that plane.
    const pivot = props.onRotateReference && props.crosshair ? worldToScreen(mapping, props.crosshair) : null;
    const along = pivot ? (pivot[0] - point[0]) * dx + (pivot[1] - point[1]) * dy : 0, reach = Math.min(...dimensions) * 0.36;
    const handles: Point2[] = pivot ? [-reach, reach].map(offset => along + offset).filter(t => t >= 0 && t <= magnitude).map(t => [point[0] + t * dx, point[1] + t * dy]) : [];
    // As in VEAcom Next: in the MPR a solid line in its plane's colour with a gap where the lines cross; elsewhere the
    // other pane's slice as a solid orange line.
    const path = (a: number, b: number) => a < b ? `M${point[0] + dx * a},${point[1] + dy * a}L${point[0] + dx * b},${point[1] + dy * b}` : '';
    return [{ id: reference.id, color: pivot ? MPR_LINE_COLORS[reference.view.plane] : '#ffa600', handles,
      path: pivot ? path(0, Math.min(magnitude, along - MPR_LINE_GAP)) + path(Math.max(0, along + MPR_LINE_GAP), magnitude) : path(0, magnitude) }];
  });
  // On a MIP a press picks the hottest voxel, including when a sphere is under the pointer.
  const hitTargets: HitTarget[] = projected ? [] : shownAnnotations.map((annotation, index) => ({ annotation,
    points: shown[index].points.map(point => worldToScreen(mapping, point)), label: labelLayouts[index] }));
  const handleTargets = referenceLines.flatMap(line => line.handles.map(([x, y]) => ({ id: line.id, x, y })));
  return <div ref={container} className={`dicom-viewport${props.active ? ' is-active' : ''}`} data-testid="dicom-viewport" role="region" tabIndex={0}
    aria-label={`${projected ? t('projection.viewport') : usesSourceFrames(props.volume.series, props.view) ? t('viewport.sourceFrameViewport') : t('viewport.imageViewport', { plane: t(`planeLower.${props.view.plane}` as const) })}${props.paneNumber ? ` · ${props.paneNumber}` : ''}`} aria-describedby={`${promptId}-keys`} style={{ ...rootStyle, cursor: baseCursor }}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
    onPointerCancel={() => cancelGesture()} onPointerLeave={event => {
      // Leaving the pane drops a pending click-click measurement; moving onto something drawn over it (a tooltip,
      // a notice) does not.
      if (event.pointerType === 'mouse' && !turning.current) setHeldLine(null);
      if (event.pointerType !== 'touch') { hover.current = null; updateReadout(); }
      if (event.pointerType !== 'mouse' || !twoClick.current || drag.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX <= bounds.left || event.clientX >= bounds.right || event.clientY <= bounds.top || event.clientY >= bounds.bottom) discardDraft();
    }} onContextMenu={event => event.preventDefault()} onKeyDown={keyDown}
    onDoubleClick={event => { if (event.button !== 0) return; event.preventDefault(); if (constructionTool.current) { usage.action('dblclick-finish', 'mouse', { absorb: 'click-' }); finishConstruction(); } else if (!annotationTools.has(props.mouseBindings?.left ?? props.tool)) { usage.action('dblclick-reset', 'mouse', { absorb: 'click-' }); reset(); } }}>
    <span id={`${promptId}-keys`} className="sr-only">{t('viewport.keys')}</span>
    <canvas ref={canvas} data-testid="dicom-canvas" role="img" aria-label={t('viewport.pixelImage')} style={canvasStyle} />
    <svg data-testid="annotation-overlay" data-mode={overlayView.mode ?? 'mpr'} data-slice={overlayView.slice} data-plane={overlayView.plane} data-series-id={props.volume.series.id} className="annotation-overlay" viewBox={`0 0 ${dimensions[0]} ${dimensions[1]}`} style={dimensions === UNMEASURED ? unmeasuredOverlayStyle : overlayStyle}>
      {/* Segmentation masks (from main, #3) sit on the image, under every line, measurement and overlay text. */}
      {segmentationFrames.length > 0 && <g data-testid="segmentation-overlay" pointerEvents="none">
        {segmentationFrames.map(({ id, frame: mask }, index) => <g key={`${id}:${index}`} data-segmentation={id} data-segment={mask.segment} transform={maskTransform(mapping, mask)}>
          <title>{mask.label}</title>
          <path d={mask.fill} fill={mask.color} fillOpacity={0.28} stroke="none" shapeRendering="crispEdges" />
          <path d={mask.outline} fill="none" stroke={mask.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </g>)}
      </g>}
      {metabolicFrames.length > 0 && <g data-metabolic-volume pointerEvents="none">
        {metabolicFrames.map(({ id, frame: mask }, index) => <g key={`${id}:${index}`} data-metabolic={id} transform={maskTransform(mapping, mask)}>
          <path d={mask.fill} fill={mask.color} fillOpacity={0.3} stroke="none" shapeRendering="crispEdges" />
          <path d={mask.outline} fill="none" stroke={mask.color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        </g>)}
      </g>}
      {/* Reference and crosshair lines go under the overlay text, so orientation letters and corner text stay legible on top of them. */}
      {referenceLines.map(line => <g key={line.id} data-reference-plane={line.id} fill="none">
        <path d={line.path} stroke={line.color} strokeWidth={heldLine === line.id ? 3 : 1.5} />
        {line.handles.map(([x, y], index) => <circle key={index} data-reference-handle={line.id} cx={x} cy={y} r={heldLine === line.id ? 6 : 3.5} fill={line.color} />)}
      </g>)}
      {/* In the three-plane MPR the lines' gap marks the point; elsewhere the crosshair is drawn. */}
      {crosshair && !(props.onRotateReference && referenceLines.length) && (() => {
        // Only the marker itself: a small "+" with an open middle, green on a dark rim (3D's marker green; measurements are yellow).
        const [x, y] = crosshair, arms = `M${x - 11} ${y}H${x - 3}M${x + 3} ${y}H${x + 11}M${x} ${y - 11}V${y - 3}M${x} ${y + 3}V${y + 11}`;
        return <g fill="none" data-crosshair-marker strokeLinecap="round"><path d={arms} stroke="#000" strokeWidth={4} opacity={0.7} /><path d={arms} stroke="#4dff8b" strokeWidth={1.8} /></g>;
      })()}
      {peakSections.map(peak => <circle key={peak.id} data-peak-sphere={peak.id} cx={peak.x} cy={peak.y}
        r={peak.radius} fill="none" stroke="#fff" strokeDasharray="2 3"><title>{t('sphere.peakRegion')}</title></circle>)}
      {shownAnnotations.map((annotation, index) => <AnnotationDrawing key={annotation.id} annotation={annotation} shown={shown[index].points} dashed={shown[index].dashed}
        handles={!projected} mapping={mapping} layout={labelLayouts[index]} selected={selected === annotation.id} />)}
      {!props.hideMeasurements && draft && <AnnotationDrawing annotation={draft} shown={draftShown} mapping={mapping} layout={draftLayout} selected={false} />}
      {/* Overlay text last: laterality and patient identification stay on top of everything else. */}
      {props.showOverlay !== false && <g data-testid="patient-overlay" data-patient-corners fill="#e6e8eb" fontFamily="var(--font-ui)" fontSize={12} stroke="#000" strokeWidth={2.5} paintOrder="stroke" strokeLinejoin="round">
        {topLeft.map((line, index) => <text key={`l${index}`} x={10} y={18 + index * 16} data-identity={line.identity || undefined}><title>{line.text}</title>{line.fitted}</text>)}
        {topRight.map((line, index) => <text key={`r${index}`} x={dimensions[0] - 10} y={18 + index * 16} textAnchor="end" data-identity={line.identity || undefined}><title>{line.text}</title>{line.fitted}</text>)}
        {fusionNameAt >= 0 && <text x={dimensions[0] - 14} y={bottomRightY(fusionNameAt)} fontSize={12} textAnchor="end"><title>{bottomRight[fusionNameAt].text}</title>{bottomRight[fusionNameAt].fitted}</text>}
      </g>}
      {/* The corners without patient details, never drawn here: a copied picture shows them in place of the ones above
          (svgImage in export-video.ts), so a paste carries no name or number. */}
      {props.showOverlay !== false && !props.hidePatientData && <g data-plain-corners display="none" aria-hidden="true" fill="#e6e8eb" fontFamily="var(--font-ui)" fontSize={12} stroke="#000" strokeWidth={2.5} paintOrder="stroke" strokeLinejoin="round">
        {plainLeft.map((line, index) => <text key={`l${index}`} x={10} y={18 + index * 16}>{line.fitted}</text>)}
        {plainRight.map((line, index) => <text key={`r${index}`} x={dimensions[0] - 10} y={18 + index * 16} textAnchor="end">{line.fitted}</text>)}
        {plainFusionName !== null && <text x={dimensions[0] - 14} y={bottomRightY(fusionNameAt)} fontSize={12} textAnchor="end">{plainFusionName}</text>}
      </g>}
      {props.showOverlay !== false && <g data-testid="image-overlay" fill="#e6e8eb" fontFamily="var(--font-ui)" fontSize={12} stroke="#000" strokeWidth={2.5} paintOrder="stroke" strokeLinejoin="round">
        <g className="orientation-labels" fontSize={13} fontWeight={600} strokeWidth={4}>
          <text x={10} y={dimensions[1] / 2} dominantBaseline="central">{axisLabels.left}</text>
          <text x={dimensions[0] - 10} y={dimensions[1] / 2} dominantBaseline="central" textAnchor="end">{axisLabels.right}</text>
          <text x={dimensions[0] / 2} y={17} textAnchor="middle">{axisLabels.top}</text>
          <text x={dimensions[0] / 2} y={dimensions[1] - 52} textAnchor="middle">{axisLabels.bottom}</text>
        </g>
        {detailLine && <OverlayText text={detailLine} y={dimensions[1] - 45} width={Math.min(bottomWidth, lowerWidth)} fontFamily={fontFamily} className="slice-detail" />}
        <OverlayText text={windowLine} y={dimensions[1] - 29} width={bottomWidth} fontFamily={fontFamily} />
        <OverlayText text={sliceLine} y={dimensions[1] - 13} width={bottomWidth} fontFamily={fontFamily} />
        {bottomRight.map((line, index) => index !== fusionNameAt && <text key={`s${index}`} x={dimensions[0] - 14} y={bottomRightY(index)} fontSize={12} textAnchor="end"><title>{line.text}</title>{line.fitted}</text>)}
        {props.showScale && <>
        <text x={dimensions[0] - 14} y={dimensions[1] - 24} fontSize={12} textAnchor="end">{scaleUnits} {measure.unit}</text>
        <path d={`M${dimensions[0] - 14 - scaleUnits * pixelsPerUnit},${dimensions[1] - 15}v-4 M${dimensions[0] - 14 - scaleUnits * pixelsPerUnit},${dimensions[1] - 17}h${scaleUnits * pixelsPerUnit} M${dimensions[0] - 14},${dimensions[1] - 15}v-4`} stroke="#000" strokeWidth={3} strokeLinecap="round" opacity={0.75} fill="none" /><path d={`M${dimensions[0] - 14 - scaleUnits * pixelsPerUnit},${dimensions[1] - 15}v-4 M${dimensions[0] - 14 - scaleUnits * pixelsPerUnit},${dimensions[1] - 17}h${scaleUnits * pixelsPerUnit} M${dimensions[0] - 14},${dimensions[1] - 15}v-4`} stroke="#c9d3df" strokeWidth={1} fill="none" />
        </>}
      </g>}
    </svg>
    {readoutLines > 0 && <ValueReadout ref={readout} right={dimensions[0] - 14} bottom={dimensions[1] - 40} width={lowerWidth} fontFamily={fontFamily} />}
    {/* Under the top corner lines (18 px down, 16 px apart), so patient identity and the orientation letter stay readable. */}
    {props.caliper ? <div className="viewport-caliper" data-export-exclude style={{ top: Math.max(topLeft.length, topRight.length) ? 18 + Math.max(topLeft.length, topRight.length) * 16 + 4 : 12 }}>
      <div className="viewport-hint" data-testid="caliper-hint">{props.caliper.prompts[Math.min(caliperStep, props.caliper.prompts.length - 1)]}</div>
      {/* What setting the pane up for the caliper changed, with Undo, until the first point is placed. */}
      {props.caliper.setUp && caliperStep === 0 && <div className="caliper-setup" role="status" data-testid="caliper-setup"><span>{props.caliper.setUp.text}</span>
        <button type="button" data-action="caliper-view-undo" onClick={props.caliper.setUp.onUndo}>{t('pair.undo')}</button></div>}
    </div>
      : !props.hideMeasurements && draft && draftHint && <div className="viewport-hint" data-export-exclude>{t(draftHint)}</div>}
    {error && <div role="alert" className="viewport-render-error">{error}</div>}
    {textPrompt && (() => {
      // The note form opens next to the clicked point, kept inside the pane.
      const [x, y] = worldToScreen(mapping, textPrompt.point);
      const width = Math.max(120, Math.min(300, dimensions[0] - 16));
      const style: CSSProperties = { left: clamp(x + 12, 8, Math.max(8, dimensions[0] - width - 8)), top: clamp(y + 12, 8, Math.max(8, dimensions[1] - 112)), width };
      return <form className="annotation-prompt" data-export-exclude style={style} onPointerDown={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setTextPrompt(null); container.current?.focus({ preventScroll: true }); } }}
        onSubmit={event => { event.preventDefault(); usage.touch('marks'); if (textPrompt.value.trim()) commit('text', [textPrompt.point], textPrompt.value.trim()); setTextPrompt(null); container.current?.focus({ preventScroll: true }); }}>
        <label className="annotation-prompt-label" htmlFor={`${promptId}-text`}>{t('viewport.annotationText')}</label>
        <input id={`${promptId}-text`} data-testid="annotation-text-input" autoFocus value={textPrompt.value} placeholder={t('viewport.annotationPlaceholder')} onChange={event => { usage.touch('marks'); setTextPrompt({ ...textPrompt, value: event.target.value }); }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setTextPrompt(null); container.current?.focus({ preventScroll: true }); } }} />
        <div className="annotation-prompt-actions"><span className="annotation-prompt-hint">{t('viewport.annotationHint')}</span>
          <button type="button" className="secondary-button compact" data-testid="annotation-text-cancel" onClick={() => { usage.touch('marks'); setTextPrompt(null); container.current?.focus({ preventScroll: true }); }}>{t('common.cancel')}</button>
          <button type="submit" className="primary-button compact" data-testid="annotation-text-add">{t('viewport.add')}</button></div>
      </form>;
    })()}
  </div>;
}

export default Viewport;
