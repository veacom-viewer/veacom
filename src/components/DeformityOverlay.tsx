// The deformity plan on its film, in the pane that shows it (Viewport.tsx): the landmarks, axes, joint lines, CORA,
// osteotomy cuts and fragments drawn over the image, and the simulated bone fragments as non-destructive layers of the
// same film. Multi-level cuts compose proximally to distally without double-drawing or gaps; direct on-canvas handles
// let the reader swing/rotate fragments, drag-translate along bone axes, move hinges live against the CORA, insert or
// delete polygon vertices, and trace freehand bone cutouts.
import { useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Series, ViewState, Volume } from '../model';
import { screenToWorld, sourceFrameSeries, type ScreenMapping } from '../imaging/geometry';
import { sliceRenderer } from '../imaging/sliceRenderer';
import { usesSourceFrames } from '../imaging/viewState';
import type { Cora } from '../imaging/deformity/analysis';
import { isContour, LANDMARK_MARK, LANDMARKS } from '../imaging/deformity/landmarks';
import {
  MAX_FRAGMENT_POINTS, moved, rotationHandlePoint, simplifyFragment, type CutSimulation, type Osteotomy,
} from '../imaging/deformity/osteotomy';
import {
  add, distance, fitCircle, invertRigid, isIdentityRigid, pointToSegment, rotate, scale, sub, unit,
  type Point, type Rigid,
} from '../imaging/deformity/plane';
import { toImage, toPlane } from '../imaging/deformity/measure';
import { activeCutIndex, deformity, filmKey, useDeformity, type FilmPlans } from '../ui/deformityStore';
import {
  addFragmentVertex, cancelDragRestore, deleteFragmentVertex, dragContinues, fragmentViews, fromUnchecked, moveHandle,
  movedView, pixelToScreen, place, planView, putBackSuggestion, rotatedOsteotomy, selectOsteotomy, settleMoved,
  translatedOsteotomy, updateOsteotomy, worldToPixel, type DragContext, type Handle, type PlanView,
} from '../ui/deformityPlan';
import { useTranslation } from '../i18n/react';
import { usage, type GestureHandle } from '../usage/tracker';

// Colours on the image only (the design guidelines' --measure family): the measure yellow for mechanical axes and
// joint lines, so the angles they make read as measurements; the others tell constructions apart.
const COLOUR = {
  axis: '#ffcc00', anatomic: '#c9a0ff', landmark: '#7fd1ff', cora: '#ff9f43',
  cut: '#ff6b6b', corrected: '#4dff8b', marker: '#e6e8eb', suggested: '#ff8fe0', guide: '#7fd1ff',
};
const layerStyle = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' } as const;
const MAX_GUIDE_TICKS = 400;
interface Props { volume: Volume; view: ViewState; size: [number, number]; mapping: ScreenMapping }

/** The film this pane shows and its plans, when the kit is open and the pane shows one acquired frame. */
function shown(volume: Volume, view: ViewState, films: Readonly<Record<string, FilmPlans | undefined>>): { film: FilmPlans; frame: Series; key: string } | null {
  if (!usesSourceFrames(volume.series, view)) return null;
  const slice = Math.round(view.slice), key = filmKey(volume.series, slice), film = films[key];
  return film ? { film, frame: sourceFrameSeries(volume.series, slice), key } : null;
}

type ActiveDrag =
  | (DragContext & {
      mode: 'handle'; handle: Handle; moved: boolean; start: [number, number];
      from?: Point; beforeFilm?: FilmPlans; lastWrittenFilm?: FilmPlans; inverseParent?: Rigid; gesture: GestureHandle;
    })
  | (DragContext & {
      mode: 'rotate'; cutIndex: number; moved: boolean; start: [number, number];
      beforeFilm: FilmPlans; lastWrittenFilm?: FilmPlans; centerPlane: Point; initialSigned: number;
      fallbackDirection: Osteotomy['direction']; valgusSign: number; lastAngleRad: number; accumulatedRad: number;
      gesture: GestureHandle;
    })
  | (DragContext & {
      mode: 'translate'; cutIndex: number; moved: boolean; start: [number, number];
      beforeFilm: FilmPlans; lastWrittenFilm?: FilmPlans; lastPlane: Point; accumulatedDelta: Point;
      initialLateral: number; initialDistal: number; axisDisplay: Point; lateralDisplay: Point; gesture: GestureHandle;
    });

/** A drag's end: a suggestion that moved becomes the reader's landmark, in the drag's own Undo step, when the reader let
 * it go on the plan it was taken from. A cancelled gesture, or one ended by a switch of plan, puts the suggestion back
 * where the model put it, or restores the pre-drag state of the dragged plan (or marker) if nothing else changed it. */
function finish(held: ActiveDrag, settle: boolean) {
  if (held.mode === 'handle' && held.moved && held.handle.kind === 'suggestion') {
    const handle = held.handle, from = held.from;
    deformity.change(held.key, current => settle && current.active === held.plan ? settleMoved(current, handle.name, handle.index)
      : from ? putBackSuggestion(current, held.plan, handle.name, handle.index, from) : current, false);
  } else if (!settle && held.moved && held.beforeFilm) {
    const before = held.beforeFilm;
    const markerOnly = held.mode === 'handle' && held.handle.kind === 'marker';
    deformity.change(held.key, current => cancelDragRestore(current, held.plan, before, held.lastWrittenFilm, markerOnly), false);
  }
  held.gesture.end({ result: settle && held.moved ? 'ok' : 'cancel' });
}

function tracePolygon(context: CanvasRenderingContext2D, corners: readonly [number, number][]) {
  context.beginPath();
  corners.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
  context.closePath();
}

function disposeCanvas(off: HTMLCanvasElement | null) {
  if (!off) return;
  sliceRenderer().releaseTarget(off);
  off.width = 0;
  off.height = 0;
}

function resizeCanvas(element: HTMLCanvasElement, width: number, height: number) {
  if (element.width !== width) element.width = width;
  if (element.height !== height) element.height = height;
}

function drawPlanLayers(
  target: HTMLCanvasElement,
  off: HTMLCanvasElement | null,
  volume: Volume,
  view: ViewState,
  frame: Series,
  plan: PlanView,
  active: ReturnType<typeof fragmentViews>,
  size: [number, number],
  mapping: ScreenMapping,
  label: string,
) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(size[0] * dpr)), height = Math.max(1, Math.round(size[1] * dpr));
  resizeCanvas(target, width, height);
  // A context with alpha first: the renderer then draws into it, and only each segment's masked pixels are kept.
  const context = target.getContext('2d');
  if (!context) return;
  try {
    if (active.length === 1) {
      const layer = active[0];
      sliceRenderer().render(target, volume, movedView(frame, view, size, layer.hinge, layer.hingeMoved, layer.degrees));
      const corners = layer.cut.osteotomy.fragment.map(p => pixelToScreen(frame, mapping, moved(layer.cut.totalMotion, p, plan.mm)));
      context.save();
      context.globalCompositeOperation = 'destination-in';
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      tracePolygon(context, corners);
      context.fill();
      context.restore();
    } else if (off) {
      resizeCanvas(off, width, height);
      const offContext = off.getContext('2d');
      if (!offContext) return;
      context.clearRect(0, 0, width, height);
      for (let i = 0; i < active.length; i++) {
        const layer = active[i];
        sliceRenderer().render(off, volume, movedView(frame, view, size, layer.hinge, layer.hingeMoved, layer.degrees));
        const corners = layer.cut.osteotomy.fragment.map(p => pixelToScreen(frame, mapping, moved(layer.cut.totalMotion, p, plan.mm)));
        offContext.save();
        offContext.globalCompositeOperation = 'destination-in';
        offContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        tracePolygon(offContext, corners);
        offContext.fill();
        // Subtract more distal moving fragments in this segment's moved frame so proximal segments never double-draw
        // behind distal ones.
        offContext.globalCompositeOperation = 'destination-out';
        for (let j = i + 1; j < active.length; j++) {
          const distalCorners = active[j].cut.osteotomy.fragment.map(p => pixelToScreen(frame, mapping, moved(layer.cut.totalMotion, p, plan.mm)));
          tracePolygon(offContext, distalCorners);
          offContext.fill();
        }
        offContext.restore();
        context.drawImage(off, 0, 0);
      }
    }
    // "Simulated" is drawn on the layer itself, so no copy of the pane (a picture, a video, with or without its
    // drawings) shows the moved fragments without it.
    context.save();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.font = '600 13px Inter, system-ui, sans-serif'; context.textAlign = 'center';
    context.lineWidth = 3; context.strokeStyle = '#000'; context.fillStyle = COLOUR.corrected;
    context.strokeText(label, size[0] / 2, 40); context.fillText(label, size[0] / 2, 40);
    context.restore();
  } catch {
    context.clearRect(0, 0, target.width, target.height); // The pane itself reports a renderer failure.
  }
}

/** Under the drawing: the place moved fragments left, uniformly dimmed, and each moved bone segment composited cleanly. */
export function PlanLayers({ volume, view, size, mapping }: Props) {
  const { t } = useTranslation();
  const state = useDeformity();
  const label = t('deformity.simulated');
  const canvas = useRef<HTMLCanvasElement>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const found = state.open && state.simulate ? shown(volume, view, state.films) : null;
  const plan = found ? planView(found.film, found.frame) : null;
  const layers = plan ? fragmentViews(plan) : [];
  // Only split into separate composited layers at cuts with non-zero local motion: an unmoved second cut shares its
  // parent segment's exact motion without any antialiasing seam along its boundary.
  const active = layers.filter(item => item.localMoving);
  const attachCanvas = (node: HTMLCanvasElement | null) => {
    canvas.current = node;
    return () => {
      disposeCanvas(scratch.current);
      scratch.current = null;
      if (node) sliceRenderer().releaseTarget(node);
    };
  };
  useLayoutEffect(() => {
    const target = canvas.current;
    if (!target || !found || !plan || !active.length) {
      disposeCanvas(scratch.current);
      scratch.current = null;
      return;
    }
    let off: HTMLCanvasElement | null = null;
    if (active.length <= 1) {
      disposeCanvas(scratch.current);
      scratch.current = null;
    } else {
      off = scratch.current ?? document.createElement('canvas');
      scratch.current = off;
    }
    drawPlanLayers(target, off, volume, view, found.frame, plan, active, size, mapping, label);
  }, [volume, view, size[0], size[1], mapping, found, plan, label, active]);
  if (!found || !plan || !active.length) return null;
  const outline = (points: readonly Point[]) => points.map(p => pixelToScreen(found.frame, mapping, p).join(',')).join(' ');
  const firstMoved = active[0].cut.osteotomy.fragment.map(p => moved(active[0].cut.totalMotion, p, plan.mm));
  return <>
    <svg style={layerStyle} viewBox={`0 0 ${size[0]} ${size[1]}`} aria-hidden="true">
      {/* Group opacity dims the union of all vacated regions uniformly without double-darkening overlapping polygons. */}
      <g opacity={0.6}>
        {active.map(layer => <polygon key={`dim-${layer.cut.index}`} points={outline(layer.cut.osteotomy.fragment)} fill="#000" />)}
      </g>
      {active.map(layer => <polygon key={`rim-${layer.cut.index}`} points={outline(layer.cut.osteotomy.fragment)} fill="none" stroke={COLOUR.cut} strokeWidth={1} strokeDasharray="4 4" />)}
    </svg>
    <canvas ref={attachCanvas} style={layerStyle} data-testid="deformity-fragment" data-outline={outline(firstMoved)} data-cut-count={active.length} data-label={label} role="img" aria-label={label} />
  </>;
}

/** The plan drawn over the image, with its handles, interactive osteotomy controls, polygon editor and lasso. */
export function PlanDrawing({ volume, view, size, mapping }: Props) {
  const { t } = useTranslation();
  const state = useDeformity();
  const drawingRef = useRef<SVGGElement>(null);
  const drag = useRef<ActiveDrag | null>(null);
  const [dragKind, setDragKind] = useState<'rotate' | 'translate' | 'hinge' | null>(null);
  const lassoRef = useRef<{ pointer: number; lastScreen: [number, number]; points: Point[]; gesture: GestureHandle } | null>(null);
  const [lassoDraft, setLassoDraft] = useState<Point[] | null>(null);
  const found = state.open ? shown(volume, view, state.films) : null;
  useLayoutEffect(() => () => {
    const held = drag.current;
    drag.current = null;
    if (held) finish(held, false);
    if (lassoRef.current) { lassoRef.current.gesture.end({ result: 'cancel' }); lassoRef.current = null; }
  }, [found?.key, found?.film.active]);
  if (!found) return null;
  const { film, frame, key } = found;
  const plan = planView(film, frame);
  const cuts = plan.plan.osteotomies;
  const selectedCut = activeCutIndex(plan.plan);
  const simulation = state.simulate ? plan.simulation : null;
  const simulating = Boolean(simulation);
  const leg = simulation ? simulation.leg : plan.leg;
  const at = (p: Point) => pixelToScreen(frame, mapping, p);
  const local = (event: ReactPointerEvent<Element> | ReactMouseEvent<Element>): [number, number] => {
    const box = (event.currentTarget).closest('svg')!.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const pixelAt = (point: [number, number]) => worldToPixel(frame, screenToWorld(mapping, point[0], point[1]));
  const placing = state.placing?.film === key ? state.placing : null;
  const simByIndex = new Map<number, CutSimulation>((plan.simulation?.cuts ?? []).map(c => [c.index, c]));
  const simOrder = plan.simulation?.cuts ?? [];

  const captureOnDrawing = (event: ReactPointerEvent<SVGElement>) => {
    (drawingRef.current ?? event.currentTarget).setPointerCapture(event.pointerId);
  };

  const endDrag = (held: ActiveDrag, settle = true) => {
    drag.current = null;
    setDragKind(null);
    finish(held, settle);
  };

  const grab = (handle: Handle) => (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0 || placing || drag.current) return;
    event.stopPropagation(); event.preventDefault();
    captureOnDrawing(event);
    const from = handle.kind === 'suggestion' ? plan.plan.suggested?.points[handle.name]?.[handle.index] : undefined;
    const beforeFilm = handle.kind === 'suggestion' ? undefined : film;
    let inverseParent: Rigid | undefined;
    if ((handle.kind === 'cut' || handle.kind === 'hinge') && handle.cutIndex !== undefined) {
      const cutIndex = handle.cutIndex;
      if (cutIndex !== selectedCut) deformity.change(key, current => selectOsteotomy(current, cutIndex), false);
      const cutSim = simulating ? simByIndex.get(cutIndex) : undefined;
      if (cutSim && !isIdentityRigid(cutSim.parentMotion)) inverseParent = invertRigid(cutSim.parentMotion);
      setDragKind('hinge');
    }
    drag.current = {
      mode: 'handle', handle, key, plan: film.active, pointer: event.pointerId, moved: false,
      start: [event.clientX, event.clientY], from, beforeFilm, inverseParent,
      gesture: usage.begin('deformity-handle', event.pointerType === 'touch' ? 'touch' : 'drag'),
    };
  };

  const grabRotate = (cutSim: CutSimulation) => (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0 || placing || drag.current) return;
    event.stopPropagation(); event.preventDefault();
    captureOnDrawing(event);
    if (cutSim.index !== selectedCut) deformity.change(key, current => selectOsteotomy(current, cutSim.index), false);
    const startPlane = toPlane(pixelAt(local(event)), plan.mm);
    const centerPlane = toPlane(cutSim.hingeAfter, plan.mm);
    const o = cutSim.osteotomy;
    const initialSigned = (o.direction === 'valgus' ? 1 : -1) * o.degrees;
    const lastAngleRad = Math.atan2(startPlane[1] - centerPlane[1], startPlane[0] - centerPlane[0]);
    setDragKind('rotate');
    drag.current = {
      mode: 'rotate', cutIndex: cutSim.index, key, plan: film.active, pointer: event.pointerId, moved: false,
      start: [event.clientX, event.clientY], beforeFilm: film, centerPlane, initialSigned, fallbackDirection: o.direction,
      valgusSign: cutSim.valgusSign, lastAngleRad, accumulatedRad: 0,
      gesture: usage.begin('deformity-rotate', event.pointerType === 'touch' ? 'touch' : 'drag'),
    };
  };

  const grabTranslate = (cutSim: CutSimulation) => (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0 || placing || drag.current) return;
    event.stopPropagation(); event.preventDefault();
    captureOnDrawing(event);
    if (cutSim.index !== selectedCut) deformity.change(key, current => selectOsteotomy(current, cutSim.index), false);
    const startPlane = toPlane(pixelAt(local(event)), plan.mm);
    const o = cutSim.osteotomy;
    setDragKind('translate');
    drag.current = {
      mode: 'translate', cutIndex: cutSim.index, key, plan: film.active, pointer: event.pointerId, moved: false,
      start: [event.clientX, event.clientY], beforeFilm: film, lastPlane: startPlane, accumulatedDelta: [0, 0],
      initialLateral: o.shiftLateral, initialDistal: o.shiftDistal,
      axisDisplay: rotate(cutSim.axis, cutSim.parentMotion.degrees),
      lateralDisplay: rotate(cutSim.lateral, cutSim.parentMotion.degrees),
      gesture: usage.begin('deformity-translate', event.pointerType === 'touch' ? 'touch' : 'drag'),
    };
  };

  const applyDragChange = (held: ActiveDrag, update: (current: FilmPlans) => FilmPlans) => {
    let wrote: FilmPlans | undefined;
    deformity.change(held.key, current => {
      const next = update(current);
      if (next !== current) wrote = next;
      return next;
    }, !held.moved);
    if (wrote) {
      held.lastWrittenFilm = wrote;
      held.moved = true;
    }
  };

  const follow = (event: ReactPointerEvent<SVGElement>) => {
    const held = drag.current;
    if (!held) return;
    // A drag moves what it took, on the film and plan it took it on: paged to another film or plan, it stops. A
    // pointer whose button is up has been released where this handle did not hear it.
    const now = dragContinues(held, { key, plan: film.active, pointer: event.pointerId });
    if (now === 'ignore') return;
    if (now === 'stop' || !(event.buttons & 1)) { endDrag(held, now !== 'stop'); return; }
    // A tap, or a pen's jitter, moves nothing: motion begins once the pointer has gone 3 px.
    if (!held.moved && Math.hypot(event.clientX - held.start[0], event.clientY - held.start[1]) < 3) return;
    const rawPoint = pixelAt(local(event));
    if (held.mode === 'handle') {
      const point = held.inverseParent ? moved(held.inverseParent, rawPoint, plan.mm) : rawPoint;
      applyDragChange(held, current => moveHandle(current, held.handle, point));
      return;
    }
    if (held.mode === 'rotate') {
      const nowPlane = toPlane(rawPoint, plan.mm);
      const dx = nowPlane[0] - held.centerPlane[0], dy = nowPlane[1] - held.centerPlane[1];
      if (Math.hypot(dx, dy) < 1e-6) return;
      const angle = Math.atan2(dy, dx);
      let step = angle - held.lastAngleRad;
      while (step > Math.PI) step -= 2 * Math.PI;
      while (step < -Math.PI) step += 2 * Math.PI;
      held.lastAngleRad = angle;
      held.accumulatedRad += event.altKey ? step * 0.25 : step;
      const deltaDeg = held.accumulatedRad * 180 / Math.PI;
      const snap = event.shiftKey ? 1 : 0;
      const patch = rotatedOsteotomy(held.initialSigned, deltaDeg, held.valgusSign, snap, held.fallbackDirection);
      applyDragChange(held, current => updateOsteotomy(current, held.cutIndex, patch));
      return;
    }
    // Translate moved fragment along its bone's lateral and distal axes.
    const nowPlane = toPlane(rawPoint, plan.mm);
    const step = sub(nowPlane, held.lastPlane);
    held.lastPlane = nowPlane;
    held.accumulatedDelta = add(held.accumulatedDelta, scale(step, event.altKey ? 0.25 : 1));
    const snap = event.shiftKey ? 1 : 0;
    const patch = translatedOsteotomy(held.initialLateral, held.initialDistal, held.accumulatedDelta, held.axisDisplay, held.lateralDisplay, snap);
    applyDragChange(held, current => updateOsteotomy(current, held.cutIndex, patch));
  };

  const release = (event: ReactPointerEvent<SVGElement>) => {
    const held = drag.current;
    if (!held || held.pointer !== event.pointerId) return;
    endDrag(held, event.type !== 'pointercancel');
    const host = drawingRef.current ?? event.currentTarget;
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  };

  const dragEvents = { onPointerMove: follow, onPointerUp: release, onPointerCancel: release, onLostPointerCapture: release };
  const handleProps = (handle: Handle) => ({
    onPointerDown: grab(handle),
    style: { pointerEvents: placing ? 'none' : 'all', cursor: 'move' } as const,
  });

  // Insert a new polygon vertex on an edge (pointerDown in Edit Cutout mode starts dragging immediately; double-click
  // also works whenever polygon handles are visible).
  const splitEdge = (cutIndex: number, edgeIndex: number, a: Point, b: Point, event: ReactPointerEvent<SVGElement> | ReactMouseEvent<SVGElement>) => {
    const clicked = pixelAt(local(event));
    const projected = pointToSegment(clicked, a, b).point;
    deformity.change(key, current => addFragmentVertex(current, cutIndex, edgeIndex, projected));
    return projected;
  };

  const onEdgePointerDown = (cutIndex: number, edgeIndex: number, a: Point, b: Point) => (event: ReactPointerEvent<SVGElement>) => {
    const cut = cuts.at(cutIndex);
    if (event.button !== 0 || placing || drag.current || !state.editCutout || !cut || cut.fragment.length >= MAX_FRAGMENT_POINTS) return;
    event.stopPropagation(); event.preventDefault();
    const beforeFilm = film;
    splitEdge(cutIndex, edgeIndex, a, b, event);
    // Capture on the persistent drawing root so inserting the final allowed vertex (which unmounts the edge lines)
    // cannot drop pointer capture and leave the drag active.
    captureOnDrawing(event);
    // The newly inserted vertex sits at `edgeIndex + 1`; drag it immediately as part of the same gesture.
    drag.current = {
      mode: 'handle', handle: { kind: 'fragment', cutIndex, index: edgeIndex + 1 },
      key, plan: film.active, pointer: event.pointerId, moved: true,
      start: [event.clientX, event.clientY], beforeFilm,
      gesture: usage.begin('deformity-handle', event.pointerType === 'touch' ? 'touch' : 'drag'),
    };
  };

  const onEdgeDoubleClick = (cutIndex: number, edgeIndex: number, a: Point, b: Point) => (event: ReactMouseEvent<SVGElement>) => {
    const cut = cuts.at(cutIndex);
    if (event.button !== 0 || placing || !cut || cut.fragment.length >= MAX_FRAGMENT_POINTS) return;
    event.stopPropagation(); event.preventDefault();
    if (!state.editCutout) splitEdge(cutIndex, edgeIndex, a, b, event);
  };

  const onVertexRemove = (cutIndex: number, vertexIndex: number) => (event: ReactMouseEvent<SVGElement>) => {
    if (placing) return;
    event.stopPropagation(); event.preventDefault();
    deformity.change(key, current => deleteFragmentVertex(current, cutIndex, vertexIndex));
  };

  const placeHere = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || !placing || placing.kind === 'lasso') return;
    event.stopPropagation(); event.preventDefault();
    const current = deformity.get().films[key];
    if (!current) return;
    usage.action('deformity-landmark', event.pointerType === 'touch' ? 'touch' : 'mouse');
    const result = place(current, placing, pixelAt(local(event)), frame);
    deformity.change(key, () => result.film);
    deformity.setPlacing(result.placing);
  };

  // Freehand / lasso scissor tool: drag around the distal bone segment to replace the active cut's fragment polygon.
  const lassoDown = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || placing?.kind !== 'lasso') return;
    event.stopPropagation(); event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const screen = local(event), p = pixelAt(screen);
    lassoRef.current = {
      pointer: event.pointerId, lastScreen: screen, points: [p],
      gesture: usage.begin('deformity-lasso', event.pointerType === 'touch' ? 'touch' : 'drag'),
    };
    setLassoDraft([p]);
  };
  const lassoMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const activeLasso = lassoRef.current;
    if (!activeLasso || activeLasso.pointer !== event.pointerId || !(event.buttons & 1)) return;
    const screen = local(event);
    if (Math.hypot(screen[0] - activeLasso.lastScreen[0], screen[1] - activeLasso.lastScreen[1]) < 4) return;
    activeLasso.lastScreen = screen;
    const p = pixelAt(screen);
    activeLasso.points.push(p);
    setLassoDraft([...activeLasso.points]);
  };
  const lassoEnd = (event: ReactPointerEvent<SVGRectElement>) => {
    const activeLasso = lassoRef.current;
    if (!activeLasso || activeLasso.pointer !== event.pointerId) return;
    lassoRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const cancelled = event.type === 'pointercancel';
    let committed = false;
    if (!cancelled && placing?.kind === 'lasso' && activeLasso.points.length >= 3) {
      const origin = at([0, 0]), stepX = at([1, 0]);
      const screenPxPerImagePx = Math.max(1e-3, Math.hypot(stepX[0] - origin[0], stepX[1] - origin[1]));
      const tolerancePx = Math.max(1, Math.min(12, 3 / screenPxPerImagePx));
      const cutSim = simulating ? simByIndex.get(placing.cutIndex) : undefined;
      // When tracing while simulation is shown, invert the fragment's displayed rigid motion back to native image space.
      const nativePoints = cutSim && !isIdentityRigid(cutSim.totalMotion)
        ? (() => {
            const inverse = invertRigid(cutSim.totalMotion);
            return activeLasso.points.map(p => moved(inverse, p, plan.mm));
          })()
        : activeLasso.points;
      const simplified = simplifyFragment(nativePoints, tolerancePx);
      if (simplified) {
        deformity.change(key, current => updateOsteotomy(current, placing.cutIndex, { fragment: simplified }));
        deformity.setPlacing(null);
        committed = true;
      }
    }
    activeLasso.gesture.end({ result: committed ? 'ok' : 'cancel' });
    setLassoDraft(null);
  };

  const line = (a: Point | null | undefined, b: Point | null | undefined, colour: string, props: { dash?: string; width?: number; extend?: number; test?: string; opacity?: number } = {}) => {
    if (!a || !b) return null;
    let [p, q] = [at(a), at(b)];
    if (props.extend) {
      const d: [number, number] = [q[0] - p[0], q[1] - p[1]];
      p = [p[0] - d[0] * props.extend, p[1] - d[1] * props.extend]; q = [q[0] + d[0] * props.extend, q[1] + d[1] * props.extend];
    }
    return <g data-plan-line={props.test} opacity={props.opacity}><line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#000" strokeWidth={(props.width ?? 1.5) + 2.5} opacity={0.6} />
      <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={colour} strokeWidth={props.width ?? 1.5} strokeDasharray={props.dash} /></g>;
  };
  const chip = (anchor: Point | null, lines: string[], colour: string, side: number, id: string, yOffset = 0) => {
    if (!anchor || !lines.length) return null;
    const [x, rawY] = at(anchor), y = rawY + yOffset;
    const width = Math.ceil(Math.max(...lines.map(text => text.length)) * 6.1 + 12), left = side >= 0 ? x + 14 : x - 14 - width;
    return <g key={id} data-plan-label={id}><rect x={left} y={y - 9} width={width} height={lines.length * 15 + 5} rx={3} fill="rgba(11, 13, 17, 0.84)" />
      <text x={left + 6} y={y + 3} fill={colour} fontSize={12} fontWeight={500} fontFamily="var(--font-ui)">{lines.map((text, index) => <tspan key={index} x={left + 6} dy={index ? 15 : 0}>{text}</tspan>)}</text></g>;
  };
  const v = leg.values, number = (value: number | null, digits = 1) => value === null ? '–' : value.toFixed(digits);
  // A value measured from the model's unchecked point, accepted as it was, says so on the image too (the panel's caution).
  const marked = fromUnchecked(plan.plan), unchecked = (keyName: Parameters<typeof marked.has>[0]) => marked.has(keyName) ? ` · ${t('deformity.uncheckedChip')}` : '';
  // Which way is out, on screen, for the leg's labels.
  const outward = plan.lateral && leg.knee ? Math.sign(at(add(leg.knee, scale(plan.lateral, 20)))[0] - at(leg.knee)[0]) || 1 : 1;
  const shownPoints = simulation ? simulation.points : plan.plan.points;
  // An image direction carried a length in mm, as image pixels: right on non-square pixels too.
  const reach = (direction: Point, mm: number): Point => { const d = unit(toPlane(direction, plan.mm)) ?? direction; return toImage(scale(d, mm), plan.mm); };
  // A CORA under 1.5° is within normal variation of the joint angles: listed in the panel, not drawn.
  const coraLines = (cora: Cora | null) => cora && cora.magnitude >= 1.5 && <g data-plan-cora={cora.bone}>
    {line(cora.proximal.from, cora.point, COLOUR.cora, { dash: '6 4' })}{line(cora.distal.from, cora.point, COLOUR.cora, { dash: '6 4' })}
    {/* The transverse bisector, 40 mm (40 pixels uncalibrated) either side of the CORA, across the bone. */}
    {line(sub(cora.point, reach(cora.bisector, 40)), add(cora.point, reach(cora.bisector, 40)), COLOUR.cora, { dash: '2 3', width: 1, test: 'bisector' })}
    <circle cx={at(cora.point)[0]} cy={at(cora.point)[1]} r={5} fill="none" stroke={COLOUR.cora} strokeWidth={2} />
    {chip(cora.point, [t('deformity.cora.label', { angle: cora.magnitude.toFixed(1) }) + unchecked(cora.bone === 'femur' ? 'coraFemur' : 'coraTibia')], COLOUR.cora, -outward, `cora-${cora.bone}`)}
  </g>;

  // Subtle CORA & transverse bisector reference while simulating so dragging the hinge visibly tracks Paley Rules 1–3.
  const simulatedCoraRef = (cutSim: CutSimulation) => {
    const cora = plan.cora[cutSim.osteotomy.bone];
    if (!cora || cora.magnitude < 1.5) return null;
    const core = moved(cutSim.parentMotion, cora.point, plan.mm);
    const bisectorA = moved(cutSim.parentMotion, sub(cora.point, reach(cora.bisector, 40)), plan.mm);
    const bisectorB = moved(cutSim.parentMotion, add(cora.point, reach(cora.bisector, 40)), plan.mm);
    const opacity = dragKind === 'hinge' ? 0.92 : 0.45;
    const [cx, cy] = at(core);
    return <g key={`sim-cora-${cutSim.osteotomy.bone}`} opacity={opacity} pointerEvents="none">
      {line(bisectorA, bisectorB, COLOUR.cora, { dash: '3 3', width: dragKind === 'hinge' ? 1.5 : 1 })}
      <circle cx={cx} cy={cy} r={4.5} fill="none" stroke={COLOUR.cora} strokeWidth={1.6} />
    </g>;
  };

  // Calibrated planning guides (optional toggle): wedge opening ruler ticks in mm & intramedullary shaft guide lines.
  const planningGuides = () => {
    if (!state.showGuides) return null;
    const mm = plan.mm;
    return <g data-testid="deformity-guides" pointerEvents="none">
      {/* Extended anatomic/intramedullary shaft reference axes to verify canal alignment & Reverse Planning. */}
      {simulating && plan.leg.femoralShaft && line(plan.leg.femoralShaft[0], plan.leg.femoralShaft[1], COLOUR.anatomic, { dash: '2 4', width: 1, extend: 1.2, opacity: 0.45 })}
      {simulating && plan.leg.tibialShaft && line(plan.leg.tibialShaft[0], plan.leg.tibialShaft[1], COLOUR.anatomic, { dash: '2 4', width: 1, extend: 1.2, opacity: 0.45 })}
      {simOrder.map(cutSim => {
        const o = cutSim.osteotomy;
        // 10 mm scale ticks along the cut plane when calibrated.
        const aPlane = toPlane(cutSim.cutMoved[0], mm), bPlane = toPlane(cutSim.cutMoved[1], mm);
        const alongCut = unit(sub(bPlane, aPlane));
        const cutLen = distance(aPlane, bPlane);
        const tickNormal: Point | null = alongCut ? [-alongCut[1], alongCut[0]] : null;
        const cutTicks: Array<[[number, number], [number, number]]> = [];
        if (mm && alongCut && tickNormal && cutLen >= 5) {
          for (let d = 5; d < cutLen && cutTicks.length < MAX_GUIDE_TICKS; d += 5) {
            const p = add(aPlane, scale(alongCut, d));
            const tickSize = d % 10 === 0 ? 3.5 : 2;
            const p1 = at(toImage(sub(p, scale(tickNormal, tickSize)), mm));
            const p2 = at(toImage(add(p, scale(tickNormal, tickSize)), mm));
            cutTicks.push([p1, p2]);
          }
        }
        // Calibrated wedge opening/closing gauge across the wedge mouth.
        const hingeP = toPlane(cutSim.hingeMoved, mm), cortexP = toPlane(cutSim.cortexMoved, mm);
        const kind = cutSim.wedge ?? o.wedge;
        const degSigned = cutSim.localMotion.degrees;
        const tipImg = toImage(add(hingeP, rotate(sub(cortexP, hingeP), kind === 'closing' ? -degSigned : degSigned)), mm);
        const showWedgeGauge = simulating && cutSim.wedgeHeight >= 0.5 && Math.abs(degSigned) >= 0.05;
        const [sx1, sy1] = at(cutSim.cortexMoved), [sx2, sy2] = at(tipImg);
        const wedgeDir = unit([sx2 - sx1, sy2 - sy1]);
        const outDir = unit(sub(at(cutSim.cortexMoved), at(cutSim.hingeMoved))) ?? [outward, 0];
        const offset = 10;
        const g1: [number, number] = [sx1 + outDir[0] * offset, sy1 + outDir[1] * offset];
        const g2: [number, number] = [sx2 + outDir[0] * offset, sy2 + outDir[1] * offset];
        const [hxS, hyS] = at(cutSim.hingeMoved);
        const gaugeTicks: Array<[[number, number], [number, number]]> = [];
        if (showWedgeGauge && mm && wedgeDir) {
          const stepMm = 2;
          const total = cutSim.wedgeHeight;
          for (let h = stepMm; h < total - 0.5 && gaugeTicks.length < MAX_GUIDE_TICKS; h += stepMm) {
            const frac = h / total;
            const px = g1[0] + (g2[0] - g1[0]) * frac, py = g1[1] + (g2[1] - g1[1]) * frac;
            const len = h % 10 === 0 ? 5 : 3;
            gaugeTicks.push([[px - outDir[0] * len, py - outDir[1] * len], [px + outDir[0] * len, py + outDir[1] * len]]);
          }
        }
        return <g key={`guide-${cutSim.index}`}>
          {cutTicks.map(([p1, p2], idx) => <line key={idx} x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]} stroke={COLOUR.guide} strokeWidth={1.2} opacity={0.8} />)}
          {showWedgeGauge && <>
            <line x1={g1[0]} y1={g1[1]} x2={g2[0]} y2={g2[1]} stroke="#000" strokeWidth={3} opacity={0.65} />
            <line x1={g1[0]} y1={g1[1]} x2={g2[0]} y2={g2[1]} stroke={COLOUR.guide} strokeWidth={1.5} />
            <line x1={sx1} y1={sy1} x2={g1[0] + outDir[0] * 3} y2={g1[1] + outDir[1] * 3} stroke={COLOUR.guide} strokeWidth={1} opacity={0.75} />
            <line x1={sx2} y1={sy2} x2={g2[0] + outDir[0] * 3} y2={g2[1] + outDir[1] * 3} stroke={COLOUR.guide} strokeWidth={1} opacity={0.75} />
            {gaugeTicks.map(([t1, t2], idx) => <line key={idx} x1={t1[0]} y1={t1[1]} x2={t2[0]} y2={t2[1]} stroke={COLOUR.guide} strokeWidth={1.1} />)}
            {/* Place bone width beside the hinge (opposite the opening HUD chip) so labels never collide. */}
            <text x={hxS - outDir[0] * 12} y={hyS + 4} textAnchor={outDir[0] >= 0 ? 'end' : 'start'} fill={COLOUR.guide} fontSize={11} fontWeight={600} stroke="#000" strokeWidth={2.5} paintOrder="stroke">
              {t('deformity.guideWidth', { value: `${cutSim.boneWidth.toFixed(0)} ${leg.unit}` })}
            </text>
          </>}
        </g>;
      })}
    </g>;
  };

  // On-canvas HUD chip near each active/moved osteotomy, kept clear of knee & MAD chips.
  const osteotomyHud = (cutSim: CutSimulation) => {
    const o = cutSim.osteotomy;
    const hasAngle = o.degrees >= 0.05;
    const hasShift = Math.abs(o.shiftLateral) >= 0.05 || Math.abs(o.shiftDistal) >= 0.05 || Math.abs(o.lengthen) >= 0.05;
    const isSelected = cutSim.index === selectedCut;
    if (!hasAngle && !hasShift && !(isSelected && dragKind !== null)) return null;
    const prefix = cuts.length > 1 ? `${t(`deformity.bone.${o.bone}` as const)} · ` : '';
    const wedgeKind = cutSim.wedge ?? o.wedge;
    const primary = hasAngle
      ? `${prefix}${o.degrees.toFixed(1)}° ${t(o.direction === 'valgus' ? 'deformity.valgus' : 'deformity.varus')} · ${cutSim.wedgeHeight.toFixed(1)} ${leg.unit} ${t(wedgeKind === 'opening' ? 'deformity.hud.opening' : 'deformity.hud.closing')}`
      : `${prefix}0.0°`;
    const lines = [primary];
    const rule = plan.rules[cutSim.index];
    if (rule) {
      lines.push(rule.rule === 3
        ? t('deformity.hud.rule3', { translation: rule.translation.toFixed(1), unit: leg.unit })
        : t('deformity.hud.rule', { rule: rule.rule }));
    }
    if (hasShift) {
      const parts = [
        Math.abs(o.shiftLateral) >= 0.05 ? `${o.shiftLateral > 0 ? '+' : ''}${o.shiftLateral.toFixed(1)} ${t('deformity.guideLateralShort')}` : '',
        Math.abs(o.shiftDistal) >= 0.05 ? `${o.shiftDistal > 0 ? '+' : ''}${o.shiftDistal.toFixed(1)} ${t('deformity.guideDistalShort')}` : '',
        Math.abs(o.lengthen) >= 0.05 ? `${o.lengthen > 0 ? '+' : ''}${o.lengthen.toFixed(1)} +` : '',
      ].filter(Boolean).join(' · ');
      lines.push(`${parts} ${leg.unit}`);
    }
    // Place on the opening/closing cortex side (away from the hinge) and avoid colliding with knee / MAD chips.
    const [cx, cy] = at(cutSim.cortexMoved), [hx] = at(cutSim.hingeMoved);
    const side = cx >= hx ? 1 : -1;
    let yOffset = 0;
    const kneeY = leg.knee ? at(leg.knee)[1] : null;
    const madY = leg.madFoot ? at(leg.madFoot)[1] : null;
    const sameAsKnee = side === outward && kneeY !== null && Math.abs(cy - kneeY) < 52;
    const sameAsMad = side === -outward && madY !== null && Math.abs(cy - madY) < 34;
    if (sameAsKnee || sameAsMad) yOffset = o.bone === 'femur' ? -40 : 40;
    return chip(cutSim.cortexMoved, lines, isSelected ? COLOUR.corrected : COLOUR.cut, side, `osteotomy-${cutSim.index}`, yOffset);
  };

  const marker = film.marker, circle = marker?.method === 'ball' && marker.points.length >= 3 ? fitCircle(marker.points) : null;
  const toPixels = 1 / (plan.mm?.[0] ?? 1);
  return <g ref={drawingRef} data-testid="deformity-drawing" data-film={key} data-to-screen={JSON.stringify([at([0, 0]), at([1, 0]), at([0, 1])])} {...dragEvents}>
    {placing && placing.kind !== 'lasso' && <rect data-testid="deformity-place" x={0} y={0} width={size[0]} height={size[1]} fill="transparent" style={{ pointerEvents: 'all', cursor: 'crosshair' }} onPointerDown={placeHere} />}
    {placing?.kind === 'lasso' && <rect data-testid="deformity-lasso" x={0} y={0} width={size[0]} height={size[1]} fill="transparent"
      style={{ pointerEvents: 'all', cursor: 'crosshair' }} onPointerDown={lassoDown} onPointerMove={lassoMove} onPointerUp={lassoEnd} onPointerCancel={lassoEnd} onLostPointerCapture={lassoEnd} />}
    {marker && <g data-plan-marker={marker.method}>
      {circle && (() => { const [x, y] = at(circle.centre), edge = at([circle.centre[0] + circle.radius, circle.centre[1]]); return <circle cx={x} cy={y} r={Math.hypot(edge[0] - x, edge[1] - y)} fill="none" stroke={COLOUR.marker} strokeWidth={1.5} />; })()}
      {marker.method === 'ruler' && marker.points.length === 2 && line(marker.points[0], marker.points[1], COLOUR.marker)}
      {marker.points.map((p, index) => <circle key={index} cx={at(p)[0]} cy={at(p)[1]} r={4} fill={COLOUR.marker} stroke="#000" {...handleProps({ kind: 'marker', index })} />)}
    </g>}
    {/* Direct drag-to-translate hit areas on moved bone segments (under all lines and handles so handles keep priority). */}
    {simulating && !state.editCutout && !placing && simOrder.map(cutSim => {
      const movedPoly = cutSim.osteotomy.fragment.map(p => at(moved(cutSim.totalMotion, p, plan.mm)));
      const isSelected = cutSim.index === selectedCut;
      return <polygon key={`body-${cutSim.index}`} data-fragment-body={cutSim.index}
        points={movedPoly.map(p => p.join(',')).join(' ')}
        fill="transparent"
        stroke={isSelected && (cuts.length > 1 || dragKind === 'translate') ? COLOUR.corrected : 'none'}
        strokeWidth={1} strokeOpacity={dragKind === 'translate' && isSelected ? 0.75 : 0.35} strokeDasharray="3 3"
        onPointerDown={grabTranslate(cutSim)}
        style={{ pointerEvents: 'all', cursor: dragKind === 'translate' ? 'grabbing' : 'grab' }} />;
    })}
    {leg.hip && (() => { const [x, y] = at(leg.hip.centre), edge = at([leg.hip.centre[0] + leg.hip.radius * toPixels, leg.hip.centre[1]]); return <circle data-plan-head cx={x} cy={y} r={Math.hypot(edge[0] - x, edge[1] - y)} fill="none" stroke={COLOUR.landmark} strokeWidth={1.2} />; })()}
    {simulating && line(plan.leg.hip?.centre, plan.leg.ankle, COLOUR.axis, { dash: '3 5', width: 1, test: 'limb-before' })}
    {line(leg.hip?.centre, leg.knee, COLOUR.axis, { test: 'femur-mechanical' })}
    {line(leg.knee, leg.ankle, COLOUR.axis, { test: 'tibia-mechanical' })}
    {line(leg.hip?.centre, leg.ankle, simulating ? COLOUR.corrected : COLOUR.axis, { dash: '8 5', width: 1.2, test: 'limb-mechanical' })}
    {line(leg.knee, leg.madFoot, simulating ? COLOUR.corrected : COLOUR.axis, { width: 1 })}
    {line(leg.hip?.centre, leg.trochanter, COLOUR.axis, { width: 1 })}
    {line(leg.femoralShaft?.[0], leg.femoralShaft?.[1], COLOUR.anatomic, { extend: 0.6, width: 1.2, test: 'femur-anatomic' })}
    {line(leg.tibialShaft?.[0], leg.tibialShaft?.[1], COLOUR.anatomic, { extend: 0.4, width: 1.2, test: 'tibia-anatomic' })}
    {line(leg.femoralLine?.[0], leg.femoralLine?.[1], COLOUR.axis, { extend: 0.35, test: 'femoral-joint' })}
    {line(leg.tibialLine?.[0], leg.tibialLine?.[1], COLOUR.axis, { extend: 0.35, test: 'tibial-joint' })}
    {line(leg.plafondLine?.[0], leg.plafondLine?.[1], COLOUR.axis, { extend: 0.5, test: 'plafond' })}
    {!simulating && coraLines(plan.cora.femur)}{!simulating && coraLines(plan.cora.tibia)}
    {simulating && simOrder.filter((cutSim, index) => simOrder.findIndex(item => item.osteotomy.bone === cutSim.osteotomy.bone) === index).map(cutSim => simulatedCoraRef(cutSim))}
    {planningGuides()}
    {cuts.map((osteotomy, cutIndex) => {
      const cutSim = simByIndex.get(cutIndex);
      const isSelected = cutIndex === selectedCut;
      const cutPts: [Point, Point] = simulating && cutSim ? cutSim.cutMoved : osteotomy.cut;
      const hingePt: Point = simulating && cutSim ? cutSim.hingeMoved : osteotomy.hinge;
      const editablePoly = !simulating || (state.editCutout && isSelected);
      const nextCut = cutSim ? simOrder[simOrder.indexOf(cutSim) + 1] : undefined;
      return <g key={osteotomy.id ?? cutIndex} data-plan-osteotomy={cutIndex}>
        {line(cutPts[0], cutPts[1], COLOUR.cut, { width: isSelected ? 2 : 1.5, test: 'cut' })}
        {simulating && cutSim && wedgeGraphic(cutSim, plan.mm, at)}
        {editablePoly && <polygon points={osteotomy.fragment.map(p => at(p).join(',')).join(' ')} fill="none" stroke={isSelected ? COLOUR.cut : 'rgba(255, 107, 107, 0.55)'} strokeWidth={isSelected ? 1.2 : 1} strokeDasharray="4 4" />}
        {/* Clickable / double-clickable edges to insert new bone-hugging polygon vertices. */}
        {editablePoly && isSelected && osteotomy.fragment.length < MAX_FRAGMENT_POINTS && osteotomy.fragment.map((a, edgeIndex) => {
          const b = osteotomy.fragment[(edgeIndex + 1) % osteotomy.fragment.length];
          const [x1, y1] = at(a), [x2, y2] = at(b);
          return <line key={`edge-${edgeIndex}`} data-fragment-edge={edgeIndex} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke="transparent" strokeWidth={10}
            style={{ pointerEvents: placing ? 'none' : 'stroke', cursor: state.editCutout ? 'copy' : 'default' }}
            onPointerDown={onEdgePointerDown(cutIndex, edgeIndex, a, b)}
            onDoubleClick={onEdgeDoubleClick(cutIndex, edgeIndex, a, b)} />;
        })}
        {editablePoly && isSelected && osteotomy.fragment.map((p, index) => {
          const [vx, vy] = at(p);
          const vertexHandlers = handleProps({ kind: 'fragment', cutIndex, index });
          return <rect key={index} data-fragment-vertex={index} x={vx - 4.5} y={vy - 4.5} width={9} height={9}
            fill={COLOUR.cut} stroke="#000" strokeWidth={1.2}
            {...vertexHandlers}
            onPointerDown={event => {
              // Prevent Viewport right-drag zoom from capturing pointer before contextmenu fires on the vertex.
              if (event.button === 2 && !placing) { event.stopPropagation(); event.preventDefault(); return; }
              vertexHandlers.onPointerDown(event);
            }}
            onDoubleClick={onVertexRemove(cutIndex, index)}
            onContextMenu={onVertexRemove(cutIndex, index)} />;
        })}
        {cutPts.map((p, index) => {
          const [cx, cy] = at(p);
          return <circle key={index} cx={cx} cy={cy} r={isSelected ? 4.5 : 3.5} fill={COLOUR.cut} stroke="#000" strokeWidth={1.2}
            {...handleProps({ kind: 'cut', cutIndex, index: index as 0 | 1 })} />;
        })}
        <g data-hinge-handle={cutIndex} {...handleProps({ kind: 'hinge', cutIndex })}>
          <circle cx={at(hingePt)[0]} cy={at(hingePt)[1]} r={isSelected ? 7.5 : 6} fill="rgba(0,0,0,0.45)" stroke={isSelected ? COLOUR.cut : 'rgba(255, 107, 107, 0.8)'} strokeWidth={2} />
          <circle cx={at(hingePt)[0]} cy={at(hingePt)[1]} r={2} fill={COLOUR.cut} />
        </g>
        {/* Direct on-canvas rotation swing handle on the active cut's moved distal fragment. */}
        {simulating && cutSim && isSelected && !state.editCutout && (() => {
          const handlePt = rotationHandlePoint(cutSim, plan.leg, plan.mm, nextCut);
          const [rx, ry] = at(handlePt), [px, py] = at(cutSim.hingeAfter);
          const arm = Math.hypot(rx - px, ry - py);
          const baseAngle = Math.atan2(ry - py, rx - px);
          const arcSpan = Math.min(0.28, 22 / Math.max(24, arm));
          const a1: [number, number] = [px + arm * Math.cos(baseAngle - arcSpan), py + arm * Math.sin(baseAngle - arcSpan)];
          const a2: [number, number] = [px + arm * Math.cos(baseAngle + arcSpan), py + arm * Math.sin(baseAngle + arcSpan)];
          const activeSwing = dragKind === 'rotate';
          const accent = COLOUR.corrected;
          return <g key={`rot-${cutIndex}`} data-export-exclude>
            <line x1={px} y1={py} x2={rx} y2={ry} stroke={accent} strokeWidth={activeSwing ? 1.5 : 1} strokeDasharray="3 3" opacity={activeSwing ? 0.85 : 0.35} pointerEvents="none" />
            <path d={`M${a1[0]} ${a1[1]}A${arm} ${arm} 0 0 1 ${a2[0]} ${a2[1]}`} fill="none" stroke="#000" strokeWidth={3.2} opacity={0.55} pointerEvents="none" />
            <path d={`M${a1[0]} ${a1[1]}A${arm} ${arm} 0 0 1 ${a2[0]} ${a2[1]}`} fill="none" stroke={accent} strokeWidth={1.6} opacity={activeSwing ? 1 : 0.75} pointerEvents="none" />
            <g data-rotate-cut={cutIndex} data-testid="deformity-rotate-handle"
              onPointerDown={grabRotate(cutSim)}
              style={{ pointerEvents: placing ? 'none' : 'all', cursor: activeSwing ? 'grabbing' : 'grab' }}>
              <circle cx={rx} cy={ry} r={15} fill="transparent" />
              <circle cx={rx} cy={ry} r={10} fill="rgba(11, 13, 17, 0.78)" stroke="#000" strokeWidth={3.5} opacity={0.65} />
              <circle cx={rx} cy={ry} r={9.5} fill="rgba(11, 13, 17, 0.82)" stroke={accent} strokeWidth={2} />
              <path d={`M${rx - 4} ${ry - 2}a4.5 4.5 0 1 1 0 4M${rx - 5.5} ${ry - 4}l1.5 2.5 2.5-1`} fill="none" stroke={accent} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
            </g>
          </g>;
        })()}
      </g>;
    })}
    {LANDMARKS.flatMap(name => (shownPoints[name] ?? []).map((p, index) => {
      const [x, y] = at(p), movedHere = simulating && shownPoints[name] !== plan.plan.points[name];
      return <g key={`${name}-${index}`} data-landmark={name}>
        <circle cx={x} cy={y} r={5} fill="rgba(0,0,0,0.35)" stroke={movedHere ? COLOUR.corrected : COLOUR.landmark} strokeWidth={2}
          {...(movedHere ? { style: { pointerEvents: 'none' } as const } : handleProps({ kind: 'landmark', name, index }))} />
        {LANDMARK_MARK[name] && <text x={x + 8 * outward} y={y - 7} textAnchor={outward > 0 ? 'start' : 'end'} fill={COLOUR.landmark} fontSize={11} fontWeight={600} stroke="#000" strokeWidth={2.5} paintOrder="stroke">{LANDMARK_MARK[name]}</text>}
      </g>;
    }))}
    {/* The model's suggestions, until the reader accepts or moves them: a dashed ring with a cross and a question mark, so
        they read apart from landmarks by shape as well as colour, and a dashed diamond where the model's channel has no
        check on real films. Nothing is drawn or measured from them. */}
    {/* Not in pictures, reports or videos: an unaccepted suggestion is not part of the plan. */}
    {!simulating && plan.plan.suggested && <g data-testid="deformity-suggestions" data-export-exclude>
      {(() => {
        // Fitted in millimetres, as the ring was made and as the kit fits the head: round on non-square pixels too.
        const head = plan.plan.suggested.points.femoralHeadContour, circleFit = head && head.length >= 3 ? fitCircle(head.map(p => toPlane(p, plan.mm))) : null;
        if (!circleFit) return null;
        const centre = toImage(circleFit.centre, plan.mm), [x, y] = at(centre), edge = at([centre[0] + circleFit.radius * toPixels, centre[1]]);
        return <circle data-suggestion-head cx={x} cy={y} r={Math.hypot(edge[0] - x, edge[1] - y)} fill="none" stroke={COLOUR.suggested} strokeWidth={1.2} strokeDasharray="4 4" />;
      })()}
      {LANDMARKS.flatMap(name => (plan.plan.suggested!.points[name] ?? []).map((p, index) => {
        // The head's outline points are smaller: eight of them sit close together on the circle.
        const [x, y] = at(p), r = isContour(name) ? 4.5 : 7, isUnchecked = plan.plan.suggested!.unchecked?.includes(name);
        const diamond = `${x},${y - 9} ${x + 9},${y} ${x},${y + 9} ${x - 9},${y}`;
        return <g key={`suggested-${name}-${index}`} data-suggestion={name} data-unchecked={isUnchecked || undefined}>
          {isUnchecked ? <polygon points={diamond} fill="none" stroke="#000" strokeWidth={3.5} opacity={0.6} /> : <circle cx={x} cy={y} r={r} fill="none" stroke="#000" strokeWidth={3.5} opacity={0.6} />}
          {!isContour(name) && <path d={`M${x - 3} ${y}h6M${x} ${y - 3}v6`} stroke={COLOUR.suggested} strokeWidth={1.2} />}
          {isUnchecked ? <polygon points={diamond} fill="rgba(0,0,0,0.2)" stroke={COLOUR.suggested} strokeWidth={1.6} strokeDasharray="2 3" {...handleProps({ kind: 'suggestion', name, index })} />
            : <circle cx={x} cy={y} r={r} fill="rgba(0,0,0,0.2)" stroke={COLOUR.suggested} strokeWidth={1.6} strokeDasharray={isContour(name) ? '2 2' : '3 2.5'} {...handleProps({ kind: 'suggestion', name, index })} />}
          {(LANDMARK_MARK[name] || (isContour(name) && index === 0)) && <text x={x + 10 * outward} y={y - 8} textAnchor={outward > 0 ? 'start' : 'end'} fill={COLOUR.suggested} fontSize={11} fontWeight={600}
            stroke="#000" strokeWidth={2.5} paintOrder="stroke">{`${LANDMARK_MARK[name]}?`}</text>}
        </g>;
      }))}
    </g>}
    {placing?.kind === 'lasso' && lassoDraft && lassoDraft.length >= 2 && <polygon data-export-exclude points={lassoDraft.map(p => at(p).join(',')).join(' ')}
      fill="rgba(255, 107, 107, 0.16)" stroke={COLOUR.cut} strokeWidth={1.8} strokeDasharray="5 3" pointerEvents="none" />}
    {chip(leg.hip?.centre ?? null, v.mLPFA.value === null ? [] : [`mLPFA ${number(v.mLPFA.value)}°${unchecked('mLPFA')}`], simulating ? COLOUR.corrected : COLOUR.axis, -outward, 'hip')}
    {chip(leg.knee, [v.mLDFA.value !== null ? `mLDFA ${number(v.mLDFA.value)}°${unchecked('mLDFA')}` : '', v.MPTA.value !== null ? `MPTA ${number(v.MPTA.value)}°${unchecked('MPTA')}` : '',
      v.JLCA.value !== null ? `JLCA ${number(v.JLCA.value)}°${unchecked('JLCA')}` : '',
      v.HKA.value !== null ? `HKA ${number(Math.abs(v.HKA.value))}°${Math.abs(v.HKA.value) < 0.05 ? '' : ` ${t(v.HKA.value >= 0 ? 'deformity.varus' : 'deformity.valgus')}`}${unchecked('HKA')}` : ''].filter(Boolean), simulating ? COLOUR.corrected : COLOUR.axis, outward, 'knee')}
    {chip(leg.madFoot, v.MAD.value === null ? [] : [`MAD ${number(Math.abs(v.MAD.value))} ${v.MAD.unit}${Math.abs(v.MAD.value) < 0.05 ? '' : ` ${t(v.MAD.value >= 0 ? 'deformity.medial' : 'deformity.lateral')}`}${unchecked('MAD')}`], simulating ? COLOUR.corrected : COLOUR.axis, -outward, 'mad')}
    {chip(leg.ankle, v.LDTA.value === null ? [] : [`LDTA ${number(v.LDTA.value)}°${unchecked('LDTA')}`], simulating ? COLOUR.corrected : COLOUR.axis, outward, 'ankle')}
    {simulating && simOrder.map(cutSim => osteotomyHud(cutSim))}
  </g>;
}

/** The wedge: for an opening wedge the gap the turn opens at the cut, for a closing wedge the bone taken out above it. */
function wedgeGraphic(cutSim: CutSimulation, mm: PlanView['mm'], at: (p: Point) => [number, number]) {
  const degrees = cutSim.localMotion.degrees;
  if (Math.abs(degrees) < 1e-9) return null;
  const hinge = toPlane(cutSim.hingeMoved, mm), start = toPlane(cutSim.cortexMoved, mm);
  const kind = cutSim.wedge ?? cutSim.osteotomy.wedge;
  const tip = toImage(add(hinge, rotate(sub(start, hinge), kind === 'closing' ? -degrees : degrees)), mm);
  const corners = [cutSim.hingeMoved, cutSim.cortexMoved, tip].map(at);
  return <polygon data-plan-wedge={kind} points={corners.map(p => p.join(',')).join(' ')} fill="rgba(255, 107, 107, 0.25)" stroke={COLOUR.cut} strokeWidth={1.2} pointerEvents="none" />;
}
