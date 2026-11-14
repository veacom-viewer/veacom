// The deformity plan on its film, in the pane that shows it (Viewport.tsx): the landmarks, axes, joint lines, CORA,
// cut and fragment drawn over the image, and the simulated fragment as a layer of its own. The layer is the same film
// drawn by the pane's renderer with the fragment's turn and shift as its view, and cut to the fragment's outline:
// source pixels are never changed or copied into a new image, and the fragment may leave the film's edge.
import { useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Series, ViewState, Volume } from '../model';
import { screenToWorld, sourceFrameSeries, type ScreenMapping } from '../imaging/geometry';
import { sliceRenderer } from '../imaging/sliceRenderer';
import { usesSourceFrames } from '../imaging/viewState';
import type { Cora } from '../imaging/deformity/analysis';
import { LANDMARK_MARK, LANDMARKS } from '../imaging/deformity/landmarks';
import { moved } from '../imaging/deformity/osteotomy';
import { add, fitCircle, rotate, scale, sub, type Point } from '../imaging/deformity/plane';
import { toImage, toPlane } from '../imaging/deformity/measure';
import { deformity, filmKey, useDeformity, type FilmPlans } from '../ui/deformityStore';
import { fragmentView, moveHandle, movedView, pixelToScreen, place, planView, worldToPixel, type Handle, type PlanView } from '../ui/deformityPlan';
import { useTranslation } from '../i18n/react';
import { usage, type GestureHandle } from '../usage/tracker';

// Colours on the image only (the design guidelines' --measure family): the measure yellow for mechanical axes and
// joint lines, so the angles they make read as measurements; the others tell constructions apart.
const COLOUR = { axis: '#ffcc00', anatomic: '#c9a0ff', landmark: '#7fd1ff', cora: '#ff9f43', cut: '#ff6b6b', corrected: '#4dff8b', marker: '#e6e8eb' };
const layerStyle = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' } as const;
interface Props { volume: Volume; view: ViewState; size: [number, number]; mapping: ScreenMapping }

/** The film this pane shows and its plans, when the kit is open and the pane shows one acquired frame. */
function shown(volume: Volume, view: ViewState, films: Readonly<Record<string, FilmPlans | undefined>>): { film: FilmPlans; frame: Series; key: string } | null {
  if (!usesSourceFrames(volume.series, view)) return null;
  const slice = Math.round(view.slice), key = filmKey(volume.series.id, slice), film = films[key];
  return film ? { film, frame: sourceFrameSeries(volume.series, slice), key } : null;
}

/** Under the drawing: the place a moved fragment left, dimmed, and the fragment drawn moved. */
export function PlanLayers({ volume, view, size, mapping }: Props) {
  const { t } = useTranslation();
  const state = useDeformity();
  const label = t('deformity.simulated');
  const canvas = useRef<HTMLCanvasElement>(null);
  const found = state.open && state.simulate ? shown(volume, view, state.films) : null;
  const plan = found ? planView(found.film, found.frame) : null;
  const motion = plan ? fragmentView(plan) : null;
  const osteotomy = plan?.plan.osteotomy;
  const still = !motion || (Math.abs(motion.degrees) < 1e-9 && motion.hinge[0] === motion.hingeMoved[0] && motion.hinge[1] === motion.hingeMoved[1]);
  const outline = (points: readonly Point[]) => points.map(p => pixelToScreen(found!.frame, mapping, p).join(',')).join(' ');
  useLayoutEffect(() => {
    const target = canvas.current;
    if (!target || !found || !motion || !osteotomy || still) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(size[0] * dpr)), height = Math.max(1, Math.round(size[1] * dpr));
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    // A context with alpha first: the renderer then draws into it, and only the fragment's outline is kept.
    const context = target.getContext('2d');
    if (!context) return;
    try {
      sliceRenderer().render(target, volume, movedView(found.frame, view, size, motion.hinge, motion.hingeMoved, motion.degrees));
      const corners = osteotomy.fragment.map(p => pixelToScreen(found.frame, mapping, moved(plan.simulation!.motion, p, plan.mm)));
      context.save();
      context.globalCompositeOperation = 'destination-in';
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.beginPath();
      corners.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
      context.closePath(); context.fill();
      context.restore();
      // "Simulated" is drawn on the layer itself, so no copy of the pane (a picture, a video, with or without its
      // drawings) shows the moved fragment without it.
      context.save();
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.font = '600 13px Inter, system-ui, sans-serif'; context.textAlign = 'center';
      context.lineWidth = 3; context.strokeStyle = '#000'; context.fillStyle = COLOUR.corrected;
      context.strokeText(label, size[0] / 2, 40); context.fillText(label, size[0] / 2, 40);
      context.restore();
    } catch {
      context.clearRect(0, 0, target.width, target.height); // The pane itself reports a renderer failure.
    }
  });
  if (!found || !plan || !osteotomy || still) return null;
  const movedOutline = osteotomy.fragment.map(p => moved(plan.simulation!.motion, p, plan.mm));
  return <>
    <svg style={layerStyle} viewBox={`0 0 ${size[0]} ${size[1]}`} aria-hidden="true">
      <polygon points={outline(osteotomy.fragment)} fill="rgba(0, 0, 0, 0.6)" stroke={COLOUR.cut} strokeWidth={1} strokeDasharray="4 4" />
    </svg>
    <canvas ref={canvas} style={layerStyle} data-testid="deformity-fragment" data-outline={outline(movedOutline)} data-label={label} role="img" aria-label={label} />
  </>;
}

/** The plan drawn over the image, with its handles, and the click that places the next point. */
export function PlanDrawing({ volume, view, size, mapping }: Props) {
  const { t } = useTranslation();
  const state = useDeformity();
  const drag = useRef<{ handle: Handle; key: string; frame: Series; moved: boolean; gesture: GestureHandle } | null>(null);
  const found = state.open ? shown(volume, view, state.films) : null;
  if (!found) return null;
  const { film, frame, key } = found;
  const plan = planView(film, frame);
  const simulating = state.simulate && Boolean(plan.simulation);
  const leg = simulating ? plan.simulation!.leg : plan.leg;
  const at = (p: Point) => pixelToScreen(frame, mapping, p);
  const local = (event: ReactPointerEvent<Element>): [number, number] => {
    const box = (event.currentTarget).closest('svg')!.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const pixelAt = (point: [number, number]) => worldToPixel(frame, screenToWorld(mapping, point[0], point[1]));
  const placing = state.placing?.film === key ? state.placing : null;
  const grab = (handle: Handle) => (event: ReactPointerEvent<SVGElement>) => {
    if (event.button !== 0 || placing) return;
    event.stopPropagation(); event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { handle, key, frame, moved: false, gesture: usage.begin('deformity-handle', event.pointerType === 'touch' ? 'touch' : 'drag') };
  };
  const follow = (event: ReactPointerEvent<SVGElement>) => {
    const held = drag.current;
    if (!held) return;
    const point = pixelAt(local(event));
    // One Undo step for the whole drag: the state before it is remembered on the first move.
    deformity.change(held.key, current => moveHandle(current, held.handle, point), !held.moved);
    held.moved = true;
  };
  const release = (event: ReactPointerEvent<SVGElement>) => {
    const held = drag.current;
    if (!held) return;
    drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId);
    held.gesture.end({ result: held.moved ? 'ok' : 'cancel' });
  };
  const handleProps = (handle: Handle) => ({ onPointerDown: grab(handle), onPointerMove: follow, onPointerUp: release, onPointerCancel: release, style: { pointerEvents: placing ? 'none' : 'all', cursor: 'move' } as const });
  const placeHere = (event: ReactPointerEvent<SVGRectElement>) => {
    if (event.button !== 0 || !placing) return;
    event.stopPropagation(); event.preventDefault();
    const current = deformity.get().films[key];
    if (!current) return;
    usage.action('deformity-landmark', event.pointerType === 'touch' ? 'touch' : 'mouse');
    const result = place(current, placing, pixelAt(local(event)), frame);
    deformity.change(key, () => result.film);
    deformity.setPlacing(result.placing);
  };
  const line = (a: Point | null | undefined, b: Point | null | undefined, colour: string, props: { dash?: string; width?: number; extend?: number; test?: string } = {}) => {
    if (!a || !b) return null;
    let [p, q] = [at(a), at(b)];
    if (props.extend) {
      const d: [number, number] = [q[0] - p[0], q[1] - p[1]];
      p = [p[0] - d[0] * props.extend, p[1] - d[1] * props.extend]; q = [q[0] + d[0] * props.extend, q[1] + d[1] * props.extend];
    }
    return <g data-plan-line={props.test}><line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke="#000" strokeWidth={(props.width ?? 1.5) + 2.5} opacity={0.6} />
      <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={colour} strokeWidth={props.width ?? 1.5} strokeDasharray={props.dash} /></g>;
  };
  const chip = (anchor: Point | null, lines: string[], colour: string, side: number, id: string) => {
    if (!anchor || !lines.length) return null;
    const [x, y] = at(anchor), width = Math.max(...lines.map(text => text.length)) * 6.6 + 10, left = side >= 0 ? x + 14 : x - 14 - width;
    return <g key={id} data-plan-label={id}><rect x={left} y={y - 9} width={width} height={lines.length * 15 + 5} rx={3} fill="rgba(11, 13, 17, 0.82)" />
      <text x={left + 5} y={y + 3} fill={colour} fontSize={12} fontWeight={500} fontFamily="var(--font-ui)">{lines.map((text, index) => <tspan key={index} x={left + 5} dy={index ? 15 : 0}>{text}</tspan>)}</text></g>;
  };
  const v = leg.values, number = (value: number | null, digits = 1) => value === null ? '–' : value.toFixed(digits);
  // Which way is out, on screen, for the leg's labels.
  const outward = plan.lateral && leg.knee ? Math.sign(at(add(leg.knee, scale(plan.lateral, 20)))[0] - at(leg.knee)[0]) || 1 : 1;
  const points = simulating ? (plan.simulation ? plan.simulation.leg : leg) : leg;
  const shownPoints = simulating && plan.simulation ? plan.simulation.points : plan.plan.points;
  // A CORA under 1.5° is within normal variation of the joint angles: listed in the panel, not drawn.
  const coraLines = (cora: Cora | null) => cora && cora.magnitude >= 1.5 && <g data-plan-cora={cora.bone}>
    {line(cora.proximal.from, cora.point, COLOUR.cora, { dash: '6 4' })}{line(cora.distal.from, cora.point, COLOUR.cora, { dash: '6 4' })}
    {/* The transverse bisector, 40 mm either side of the CORA, across the bone. */}
    {line(sub(cora.point, scale(cora.bisector, 40 / Math.max(1e-6, plan.mm?.[0] ?? 1))), add(cora.point, scale(cora.bisector, 40 / Math.max(1e-6, plan.mm?.[0] ?? 1))), COLOUR.cora, { dash: '2 3', width: 1, test: 'bisector' })}
    <circle cx={at(cora.point)[0]} cy={at(cora.point)[1]} r={5} fill="none" stroke={COLOUR.cora} strokeWidth={2} />
    {chip(cora.point, [t('deformity.cora.label', { angle: cora.magnitude.toFixed(1) })], COLOUR.cora, -outward, `cora-${cora.bone}`)}
  </g>;
  const osteotomy = plan.plan.osteotomy;
  const marker = film.marker, circle = marker?.method === 'ball' && marker.points.length >= 3 ? fitCircle(marker.points) : null;
  const toPixels = 1 / (plan.mm?.[0] ?? 1);
  return <g data-testid="deformity-drawing" data-film={key} data-to-screen={JSON.stringify([at([0, 0]), at([1, 0]), at([0, 1])])}>
    {placing && <rect data-testid="deformity-place" x={0} y={0} width={size[0]} height={size[1]} fill="transparent" style={{ pointerEvents: 'all', cursor: 'crosshair' }} onPointerDown={placeHere} />}
    {marker && <g data-plan-marker={marker.method}>
      {circle && (() => { const [x, y] = at(circle.centre), edge = at([circle.centre[0] + circle.radius, circle.centre[1]]); return <circle cx={x} cy={y} r={Math.hypot(edge[0] - x, edge[1] - y)} fill="none" stroke={COLOUR.marker} strokeWidth={1.5} />; })()}
      {marker.method === 'ruler' && marker.points.length === 2 && line(marker.points[0], marker.points[1], COLOUR.marker)}
      {marker.points.map((p, index) => <circle key={index} cx={at(p)[0]} cy={at(p)[1]} r={4} fill={COLOUR.marker} stroke="#000" {...handleProps({ kind: 'marker', index })} />)}
    </g>}
    {leg.hip && (() => { const [x, y] = at(leg.hip.centre), edge = at([leg.hip.centre[0] + leg.hip.radius * toPixels, leg.hip.centre[1]]); return <circle data-plan-head cx={x} cy={y} r={Math.hypot(edge[0] - x, edge[1] - y)} fill="none" stroke={COLOUR.landmark} strokeWidth={1.2} />; })()}
    {simulating && line(plan.leg.hip?.centre, plan.leg.ankle, COLOUR.axis, { dash: '3 5', width: 1, test: 'limb-before' })}
    {line(points.hip?.centre, points.knee, COLOUR.axis, { test: 'femur-mechanical' })}
    {line(points.knee, points.ankle, COLOUR.axis, { test: 'tibia-mechanical' })}
    {line(points.hip?.centre, points.ankle, simulating ? COLOUR.corrected : COLOUR.axis, { dash: '8 5', width: 1.2, test: 'limb-mechanical' })}
    {line(points.knee, points.madFoot, simulating ? COLOUR.corrected : COLOUR.axis, { width: 1 })}
    {line(points.hip?.centre, points.trochanter, COLOUR.axis, { width: 1 })}
    {line(points.femoralShaft?.[0], points.femoralShaft?.[1], COLOUR.anatomic, { extend: 0.6, width: 1.2, test: 'femur-anatomic' })}
    {line(points.tibialShaft?.[0], points.tibialShaft?.[1], COLOUR.anatomic, { extend: 0.4, width: 1.2, test: 'tibia-anatomic' })}
    {line(points.femoralLine?.[0], points.femoralLine?.[1], COLOUR.axis, { extend: 0.35, test: 'femoral-joint' })}
    {line(points.tibialLine?.[0], points.tibialLine?.[1], COLOUR.axis, { extend: 0.35, test: 'tibial-joint' })}
    {line(points.plafondLine?.[0], points.plafondLine?.[1], COLOUR.axis, { extend: 0.5, test: 'plafond' })}
    {!simulating && coraLines(plan.cora.femur)}{!simulating && coraLines(plan.cora.tibia)}
    {osteotomy && <g data-plan-osteotomy>
      {line(osteotomy.cut[0], osteotomy.cut[1], COLOUR.cut, { width: 2, test: 'cut' })}
      {!simulating && <polygon points={osteotomy.fragment.map(p => at(p).join(',')).join(' ')} fill="none" stroke={COLOUR.cut} strokeWidth={1} strokeDasharray="4 4" />}
      {simulating && plan.simulation && wedge(plan, at)}
      {!simulating && osteotomy.fragment.map((p, index) => <rect key={index} x={at(p)[0] - 4} y={at(p)[1] - 4} width={8} height={8} fill={COLOUR.cut} stroke="#000" {...handleProps({ kind: 'fragment', index })} />)}
      {osteotomy.cut.map((p, index) => <circle key={index} cx={at(p)[0]} cy={at(p)[1]} r={4} fill={COLOUR.cut} stroke="#000" {...handleProps({ kind: 'cut', index: index as 0 | 1 })} />)}
      <g {...handleProps({ kind: 'hinge' })}><circle cx={at(osteotomy.hinge)[0]} cy={at(osteotomy.hinge)[1]} r={7} fill="rgba(0,0,0,0.4)" stroke={COLOUR.cut} strokeWidth={2} />
        <circle cx={at(osteotomy.hinge)[0]} cy={at(osteotomy.hinge)[1]} r={2} fill={COLOUR.cut} /></g>
    </g>}
    {LANDMARKS.flatMap(name => (shownPoints[name] ?? []).map((p, index) => {
      const [x, y] = at(p), movedHere = simulating && shownPoints[name] !== plan.plan.points[name];
      return <g key={`${name}-${index}`} data-landmark={name}>
        <circle cx={x} cy={y} r={5} fill="rgba(0,0,0,0.35)" stroke={movedHere ? COLOUR.corrected : COLOUR.landmark} strokeWidth={2}
          {...(movedHere ? { style: { pointerEvents: 'none' } as const } : handleProps({ kind: 'landmark', name, index }))} />
        {LANDMARK_MARK[name] && <text x={x + 8 * outward} y={y - 7} textAnchor={outward > 0 ? 'start' : 'end'} fill={COLOUR.landmark} fontSize={11} fontWeight={600} stroke="#000" strokeWidth={2.5} paintOrder="stroke">{LANDMARK_MARK[name]}</text>}
      </g>;
    }))}
    {chip(points.hip?.centre ?? null, v.mLPFA.value === null ? [] : [`mLPFA ${number(v.mLPFA.value)}°`], simulating ? COLOUR.corrected : COLOUR.axis, -outward, 'hip')}
    {chip(points.knee, [v.mLDFA.value !== null ? `mLDFA ${number(v.mLDFA.value)}°` : '', v.MPTA.value !== null ? `MPTA ${number(v.MPTA.value)}°` : '',
      v.JLCA.value !== null ? `JLCA ${number(v.JLCA.value)}°` : '', v.HKA.value !== null ? `HKA ${number(Math.abs(v.HKA.value))}°${Math.abs(v.HKA.value) < 0.05 ? '' : ` ${t(v.HKA.value >= 0 ? 'deformity.varus' : 'deformity.valgus')}`}` : ''].filter(Boolean), simulating ? COLOUR.corrected : COLOUR.axis, outward, 'knee')}
    {chip(points.madFoot, v.MAD.value === null ? [] : [`MAD ${number(Math.abs(v.MAD.value))} ${v.MAD.unit}${Math.abs(v.MAD.value) < 0.05 ? '' : ` ${t(v.MAD.value >= 0 ? 'deformity.medial' : 'deformity.lateral')}`}`], simulating ? COLOUR.corrected : COLOUR.axis, -outward, 'mad')}
    {chip(points.ankle, v.LDTA.value === null ? [] : [`LDTA ${number(v.LDTA.value)}°`], simulating ? COLOUR.corrected : COLOUR.axis, outward, 'ankle')}
  </g>;
}

/** The wedge: for an opening wedge the gap the turn opens at the cut, for a closing wedge the bone taken out above it. */
function wedge(plan: PlanView, at: (p: Point) => [number, number]) {
  const osteotomy = plan.plan.osteotomy!, degrees = plan.simulation!.motion.degrees, mm = plan.mm;
  const hinge = toPlane(osteotomy.hinge, mm), start = toPlane(plan.simulation!.cortex, mm);
  const kind = plan.simulation!.wedge ?? osteotomy.wedge;
  const tip = toImage(add(hinge, rotate(sub(start, hinge), kind === 'closing' ? -degrees : degrees)), mm);
  const corners = [osteotomy.hinge, plan.simulation!.cortex, tip].map(at);
  return <polygon data-plan-wedge={kind} points={corners.map(p => p.join(',')).join(' ')} fill="rgba(255, 107, 107, 0.25)" stroke={COLOUR.cut} strokeWidth={1.2} />;
}
