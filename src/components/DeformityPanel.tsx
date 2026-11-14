// The lower-limb deformity plan of a standing long-leg film (docs/deformity-planning.md), opened by the assessment
// button on a DX or CR long-leg film as the pre-op checklist is on a CT. It guides the landmarks of each leg, lists
// every value against its normal range with what its millimetres stand for, runs Paley's malalignment test, finds the
// CORA, and simulates an osteotomy that the pane measures again as it moves. Plans live in memory (deformityStore.ts);
// the reader saves one as a file, or a report as a picture.
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { ViewState, Volume } from '../model';
import { sourceFrameSeries } from '../imaging/geometry';
import { calibrationTag, calibrationText, isProjectionFilm, manualCalibration, projectionOf, recordManualCalibration, sideText } from '../imaging/radiograph';
import { CONTOUR_MAXIMUM, CONTOUR_MINIMUM, isContour, LANDMARK_TEXT, LANDMARKS, type LandmarkName } from '../imaging/deformity/landmarks';
import type { Missing, Side, Value } from '../imaging/deformity/measure';
import { NORMALS, type ValueKey } from '../imaging/deformity/normals';
import { fitCircle, distance } from '../imaging/deformity/plane';
import { solveAngle, type Osteotomy } from '../imaging/deformity/osteotomy';
import { activePlan, deformity, filmKey, newPlan, useDeformity, withPlan, type FilmPlans, type Marker } from '../ui/deformityStore';
import { imageSideOnScreen, nextLandmark, planView, type PlanView } from '../ui/deformityPlan';
import { parsePlanFile, planFile } from '../ui/deformityFile';
import { drawReport, pngBytes, reportHeader, type ReportSection } from '../ui/deformityReport';
import { captureViewportCanvas } from '../export-video';
import { Download, FolderOpen, Images, Plus, Redo2, Undo2, X } from './icons';
import { WarningBox } from './WarningBox';
import { useTranslation } from '../i18n/react';
import type { MessageKey, Translator } from '../i18n';
import './DeformityPanel.css';

const VALUE_ORDER: Array<Value['key']> = ['mLPFA', 'mLDFA', 'aLDFA', 'MPTA', 'LDTA', 'JLCA', 'AMA', 'HKA', 'MAD', 'WBL', 'femurLength', 'tibiaLength', 'limbLength'];
const NAMED: Partial<Record<Value['key'], MessageKey>> = { WBL: 'deformity.value.WBL', femurLength: 'deformity.value.femurLength', tibiaLength: 'deformity.value.tibiaLength', limbLength: 'deformity.value.limbLength' };
const BALLS = [25, 25.4, 30];

/** The sides a film is planned for when it opens: the one its laterality names, else both. */
const sidesOf = (laterality: string | undefined): Side[] => laterality === 'R' ? ['R'] : laterality === 'L' ? ['L'] : ['R', 'L'];

/** A plan's name: the reader's, else its leg, numbered when the film has more than one plan of that leg. */
export function planName(film: FilmPlans, id: string, t: Translator): string {
  const plan = film.plans.find(item => item.id === id)!;
  if (plan.name) return plan.name;
  const same = film.plans.filter(item => item.side === plan.side);
  const leg = t(plan.side === 'R' ? 'deformity.rightLeg' : 'deformity.leftLeg');
  return same.length > 1 ? `${leg} ${same.indexOf(plan) + 1}` : leg;
}

/** A value as the panel and the report write it: its number, unit and direction, and what its millimetres stand for. */
export function valueText(value: Value, tag: string, t: Translator): string {
  if (value.value === null) return '–';
  const n = value.value;
  // A direction is named only where the value shows one: 0.0 is neither varus nor valgus.
  const straight = Math.abs(n) < 0.05;
  if (straight && (value.key === 'HKA' || value.key === 'JLCA')) return '0.0°';
  if (straight && value.key === 'MAD') return `0.0 ${value.unit}${value.unit === 'mm' && tag ? ` · ${tag}` : ''}`;
  if (value.key === 'HKA') return `${Math.abs(n).toFixed(1)}° ${t(n >= 0 ? 'deformity.varus' : 'deformity.valgus')}`;
  if (value.key === 'JLCA') return `${Math.abs(n).toFixed(1)}° ${t(n >= 0 ? 'deformity.medial' : 'deformity.lateral')}`;
  if (value.key === 'MAD') return `${Math.abs(n).toFixed(1)} ${value.unit} ${t(n >= 0 ? 'deformity.medial' : 'deformity.lateral')}${value.unit === 'mm' && tag ? ` · ${tag}` : ''}`;
  if (value.key === 'WBL') return t('deformity.wblShare', { value: n.toFixed(1) });
  if (value.unit === '°') return `${n.toFixed(1)}°`;
  return `${n.toFixed(1)} ${value.unit}${value.unit === 'mm' && tag ? ` · ${tag}` : ''}`;
}

export function normalText(key: Value['key']): string {
  if (!(key in NORMALS)) return '';
  const normal = NORMALS[key as ValueKey], unit = key === 'MAD' ? ' mm' : '°';
  if (key === 'HKA') return `±${normal.high}°`;
  if (key === 'JLCA') return `±${normal.high}°`;
  return `${normal.low}–${normal.high}${unit}`;
}

export function missingText(missing: Missing | undefined, t: Translator): string {
  if (!missing) return '';
  if ('landmarks' in missing) return t('deformity.needs', { names: missing.landmarks.map(name => t(LANDMARK_TEXT[name].name)).join(', ') });
  return t(missing.reason === 'side' ? 'deformity.needsSide' : missing.reason === 'calibration' ? 'deformity.needsCalibration' : 'deformity.parallel');
}

async function save(name: string, data: ArrayBuffer | string): Promise<string | null> {
  if (window.veacom) return window.veacom.saveFile(name, data);
  const url = URL.createObjectURL(new Blob([data])), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

const frames = (count: number) => new Promise<void>(resolve => { const step = (left: number) => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(count); });

export function DeformityPanel({ volume, slice, view: paneView, onClose, headingRef, onCalibrate, onUndo, history, hidePatientData, viewport }: {
  /** The active pane's film, as decorated with its calibration (App's measurement scale). */
  volume: Volume; slice: number;
  /** The pane's view, as shown: its turn and flips tell which side of the image the pane's left and right are. */
  view: Pick<ViewState, 'rotation' | 'flipX'>;
  onClose: () => void;
  headingRef?: (heading: HTMLHeadingElement | null) => void;
  /** Sets the series' measurement scale (mm per coordinate unit), or removes it. */
  onCalibrate: (seriesId: string, scale: number | null) => void;
  /** The viewer's Undo and Redo, which take back plan steps as they take back measurements. */
  onUndo: (redo: boolean) => void; history: [number, number];
  hidePatientData: boolean;
  /** The pane that shows the film, for the report's pictures. */
  viewport: () => HTMLElement | null;
}) {
  const { t, locale } = useTranslation();
  const state = useDeformity();
  const series = volume.series, frameIndex = Math.round(slice), frame = sourceFrameSeries(series, frameIndex);
  const key = filmKey(series.id, frameIndex), film = state.films[key];
  const projection = projectionOf(frame);
  const [bone, setBone] = useState<Osteotomy['bone']>('tibia');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { deformity.setOpen(true); return () => deformity.setOpen(false); }, []);
  useEffect(() => {
    const metadata = series.frameMetadata?.[frameIndex];
    deformity.ensure(series.id, frameIndex, sidesOf(projection?.laterality), { sopInstanceUid: metadata?.sopInstanceUid ?? series.uid, frameNumber: metadata?.sourceFrameNumber ?? 1 });
    // Undo past the film's first step removes it from the store: it is made again, empty.
  }, [series.id, series.uid, series.frameMetadata, frameIndex, projection?.laterality, Boolean(film)]);
  // Esc stops placing points wherever focus is (the pane included); the next Esc in the panel closes it.
  const placing = state.placing?.film === key ? state.placing : null;
  useEffect(() => {
    if (!placing) return;
    const stop = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); deformity.setPlacing(null); } };
    window.addEventListener('keydown', stop, true);
    return () => window.removeEventListener('keydown', stop, true);
  }, [placing]);
  if (!film) return <section className="deformity-panel" data-testid="deformity-panel" aria-label={t('deformity.title')} />;
  const view = planView(film, frame), plan = view.plan, leg = view.leg, tag = calibrationTag(frame);
  const change = (update: (current: FilmPlans) => FilmPlans) => deformity.change(key, update);
  const changePlan = (update: (current: PlanView['plan']) => PlanView['plan']) => change(current => withPlan(current, update(activePlan(current))));
  const changeOsteotomy = (patch: Partial<Osteotomy>) => changePlan(current => current.osteotomy ? { ...current, osteotomy: { ...current.osteotomy, ...patch } } : current);
  const startPlacing = (name?: LandmarkName) => {
    const next = name ?? nextLandmark(plan);
    deformity.setPlacing(next ? { film: key, kind: 'landmark', name: next } : null);
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || (event.target as HTMLElement).matches('input, select')) return;
    event.stopPropagation();
    if (placing) deformity.setPlacing(null); else onClose();
  };

  // Calibration from the ball or ruler the reader marked: the series' scale, so every measurement on it follows.
  const marker = film.marker;
  const markerFit = (current: Marker | null) => {
    if (!current) return null;
    const [sx, sy] = [frame.spacing[0], frame.spacing[1]];
    if (current.method === 'ball') {
      if (current.points.length < 3) return null;
      const circle = fitCircle(current.points.map(p => [p[0] * sx, p[1] * sy] as const)), pixels = fitCircle(current.points);
      return circle && pixels ? { world: circle.radius * 2, pixels: pixels.radius * 2, residual: pixels.residual } : null;
    }
    if (current.points.length < 2) return null;
    const [a, b] = current.points;
    return { world: Math.hypot((b[0] - a[0]) * sx, (b[1] - a[1]) * sy), pixels: distance(a, b), residual: 0 };
  };
  const fit = markerFit(marker);
  /** Ball or Ruler: new points for a new marker of that kind; pressed again while placing, it stops. */
  const startMarker = (method: Marker['method']) => {
    if (placing?.kind === method) { deformity.setPlacing(null); return; }
    change(current => ({ ...current, marker: { method, points: [], knownMm: current.marker?.method === method ? current.marker.knownMm : method === 'ball' ? 25 : 100, depthConfirmed: false } }));
    deformity.setPlacing({ film: key, kind: method });
  };
  const known = manualCalibration(frame);
  const applyMarker = (current: Marker) => {
    const measured = markerFit(current);
    if (!measured || !(measured.world > 0)) return;
    const scale = current.knownMm / measured.world;
    recordManualCalibration(series.id, { method: current.method, knownMm: current.knownMm, scale, depthConfirmed: current.depthConfirmed });
    onCalibrate(series.id, scale);
  };
  const removeCalibration = () => { recordManualCalibration(series.id, null); onCalibrate(series.id, null); };
  // The marker calibrates the series while the series' scale is the one it gives.
  const applied = Boolean(known && fit && marker && known.method === marker.method && Math.abs(known.scale - marker.knownMm / fit.world) <= 1e-9 * known.scale);
  const imager = projection?.imagerPixelSpacing;
  const mmPerPixel = fit && marker ? marker.knownMm / fit.pixels : null;

  // Saving, opening and the report: only when the reader asks.
  const saveFile = async () => {
    setBusy(true);
    try {
      const file = await planFile(film, frame);
      const where = await save('veacom-deformity-plan.json', JSON.stringify(file, null, 2));
      setStatus(where ? t('deformity.saved', { file: where.split(/[\\/]/).pop() ?? where }) : null);
    } catch (error) { setStatus(t('deformity.failed', { reason: error instanceof Error ? error.message : String(error) })); }
    finally { setBusy(false); }
  };
  const openFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    if (chosen.size > 2_000_000) { setStatus(t('deformity.badFile', { reason: t('deformity.reason.size') })); return; }
    const result = await parsePlanFile(await chosen.text(), film, frame);
    if ('error' in result) { setStatus(result.error === 'film' ? t('deformity.wrongFilm') : t('deformity.badFile', { reason: t(`deformity.reason.${result.error}` as MessageKey) })); return; }
    change(current => ({ ...current, plans: result.plans, active: result.plans[result.active].id, marker: result.marker, ...(result.patientRight ? { patientRight: result.patientRight } : {}) }));
    if (result.calibrated && result.marker) applyMarker(result.marker);
    const count = result.plans.reduce((sum, item) => sum + Object.values(item.points).reduce((n, list) => n + list.length, 0), 0);
    setStatus(t('deformity.opened', { count }));
  };
  const report = async () => {
    const element = viewport();
    if (!element) return;
    setBusy(true);
    const simulated = state.simulate;
    try {
      deformity.setSimulate(false); await frames(3);
      const pictures = [{ caption: t('deformity.report.now'), canvas: await captureViewportCanvas(element, { hidePatientData }) }];
      if (view.simulation) {
        deformity.setSimulate(true); await frames(3);
        pictures.push({ caption: t('deformity.report.planned'), canvas: await captureViewportCanvas(element, { hidePatientData }) });
      }
      const sections: ReportSection[] = [{ title: t('deformity.values'), rows: VALUE_ORDER.map(name => [NAMED[name] ? t(NAMED[name]) : name, leg.values[name].value === null ? missingText(leg.values[name].missing, t) : valueText(leg.values[name], tag, t), normalText(name) || undefined]) },
        { title: t('deformity.mat'), rows: view.steps.map(step => [t(`deformity.mat.${step.step}` as MessageKey), t(`deformity.result.${step.result}` as MessageKey)]) },
        { title: t('deformity.cora'), rows: (['femur', 'tibia'] as const).map(boneName => [t(`deformity.bone.${boneName}` as MessageKey), coraText(view, boneName, t)]) }];
      if (view.simulation && plan.osteotomy) {
        const after = view.simulation.leg.values, o = plan.osteotomy;
        sections.push({ title: t('deformity.osteotomy'), rows: [
          [t('deformity.report.cut'), `${t(`deformity.bone.${o.bone}` as MessageKey)} · ${t((view.simulation.wedge ?? o.wedge) === 'opening' ? 'deformity.wedge.opening' : 'deformity.wedge.closing')} · ${o.degrees.toFixed(1)}° ${t(o.direction === 'valgus' ? 'deformity.valgus' : 'deformity.varus')}`],
          [t('deformity.report.wedge'), `${view.simulation.wedgeHeight.toFixed(1)} ${leg.unit}${leg.unit === 'mm' && tag ? ` · ${tag}` : ''}`],
          ...(['mLDFA', 'MPTA', 'LDTA', 'JLCA', 'HKA', 'MAD', 'WBL', 'limbLength'] as const).map(name => [NAMED[name] ? t(NAMED[name]) : name, `${valueText(leg.values[name], '', t)} → ${valueText(after[name], '', t)}`] as [string, string]),
        ] });
      }
      const canvas = drawReport({ title: `${t('deformity.title')} · ${planName(film, plan.id, t)}`,
        lines: reportHeader(series, frame, hidePatientData, t),
        pictures, sections,
        footer: [view.simulation ? t('deformity.report.simulated') : '', t('deformity.report.footer', { version: window.veacom?.getVersion() ?? '', date: new Date().toLocaleString(locale) })].filter(Boolean) });
      const where = await save('veacom-deformity-report.png', await pngBytes(canvas));
      setStatus(where ? t('deformity.reportSaved', { file: where.split(/[\\/]/).pop() ?? where }) : null);
    } catch (error) { setStatus(t('deformity.failed', { reason: error instanceof Error ? error.message : String(error) })); }
    finally { deformity.setSimulate(simulated); setBusy(false); }
  };

  const osteotomy = plan.osteotomy, after = view.simulation?.leg.values;
  const placedCount = (name: LandmarkName) => plan.points[name]?.length ?? 0;
  const done = (name: LandmarkName) => placedCount(name) >= (isContour(name) ? CONTOUR_MINIMUM : 1);
  const laterality = projection?.laterality;
  const otherSide = laterality === 'R' || laterality === 'L' ? laterality !== plan.side : false;
  return <section className="deformity-panel" aria-label={t('deformity.title')} data-testid="deformity-panel" onKeyDown={keyDown}>
    <header><h2 ref={headingRef} tabIndex={-1}>{t('deformity.title')}</h2>
      <button type="button" className="icon-button" aria-label={t('deformity.close')} data-tooltip={t('deformity.close')} data-action="deformity-close" onClick={onClose}><X size={16} /></button></header>
    <div className="deformity-body">
      <p className="deformity-film" data-testid="deformity-calibration" data-state={known ? 'manual' : projection?.basis ?? 'none'}>{sideText(frame)} · {calibrationText(frame)}</p>
      {!isProjectionFilm(frame) && <p className="deformity-caution">{t('deformity.notProjection')}</p>}
      {projection && !/LEG|LIMB|EXTREMITY|LOWEXM/i.test(projection.bodyPart ?? '') && <p className="deformity-caution">{t('deformity.qualify')}</p>}
      {view.askRight && <div className="deformity-ask" role="group" aria-label={t('deformity.askRight')}>
        <span>{t('deformity.askRight')}</span>
        {/* The answer is on screen; the plan keeps the image's side, through the pane's turn and flip. */}
        <div className="deformity-segments">{(['left', 'right'] as const).map(side => {
          const image = imageSideOnScreen(side, paneView);
          return <button key={side} type="button" data-action="deformity-patient-right" data-side={side} aria-pressed={image !== null && film.patientRight === image}
            className="secondary-button compact" disabled={!image} data-tooltip={image ? undefined : t('deformity.askUpright')}
            onClick={() => { if (image) change(current => ({ ...current, patientRight: image })); }}>{t(side === 'left' ? 'deformity.imageLeft' : 'deformity.imageRight')}</button>;
        })}</div>
      </div>}

      <div className="deformity-plans" role="tablist" aria-label={t('deformity.plans')}>
        {film.plans.map(item => <button key={item.id} type="button" role="tab" data-action="deformity-plan-tab" aria-selected={item.id === film.active}
          onClick={() => { deformity.setPlacing(null); change(current => ({ ...current, active: item.id })); }}>{planName(film, item.id, t)}</button>)}
        {/* Another plan of the same leg, to compare corrections. */}
        <button type="button" className="icon-button" data-action="deformity-plan-add" aria-label={t('deformity.addPlan')} data-tooltip={t('deformity.addPlan')}
          onClick={() => { const next = newPlan(plan.side); change(current => ({ ...current, plans: [...current.plans, next], active: next.id })); }}><Plus size={15} /></button>
      </div>
      {film.plans.length > 1 && <div className="deformity-actions"><button type="button" className="text-button" data-action="deformity-plan-delete" onClick={() => change(current => {
        const plans = current.plans.filter(item => item.id !== plan.id);
        return { ...current, plans, active: plans[0].id };
      })}>{t('deformity.deletePlan')}</button></div>}
      {otherSide && <p className="deformity-caution" role="note">{t('deformity.sideMismatch', { side: sideText(frame) })}</p>}

      <h3>{t('deformity.calibration')}</h3>
      <div className="deformity-calibrate">
        <div className="deformity-segments">
          <button type="button" className="secondary-button compact" data-action="deformity-ball" aria-pressed={placing?.kind === 'ball'} onClick={() => startMarker('ball')}>{t('deformity.ball')}</button>
          <button type="button" className="secondary-button compact" data-action="deformity-ruler" aria-pressed={placing?.kind === 'ruler'} onClick={() => startMarker('ruler')}>{t('deformity.ruler')}</button>
        </div>
        {(placing?.kind === 'ball' || placing?.kind === 'ruler') && <p className="deformity-hint" role="status">{t(placing.kind === 'ball' ? 'deformity.ballHint' : 'deformity.rulerHint')}</p>}
        {marker && <div className="deformity-marker">
          <label>{t(marker.method === 'ball' ? 'deformity.diameter' : 'deformity.distance')}
            {marker.method === 'ball' ? <select data-action="deformity-known-size" value={BALLS.includes(marker.knownMm) ? String(marker.knownMm) : 'other'}
              onChange={event => { const value = event.target.value === 'other' ? marker.knownMm : Number(event.target.value); change(current => ({ ...current, marker: current.marker && { ...current.marker, knownMm: value } })); }}>
              {BALLS.map(size => <option key={size} value={String(size)}>{size.toFixed(1)} mm</option>)}<option value="other">{t('deformity.otherSize')}</option></select> : null}
            <input type="number" min={1} max={2000} step={0.1} data-action="deformity-known-mm" value={marker.knownMm} aria-label={t(marker.method === 'ball' ? 'deformity.diameter' : 'deformity.distance')}
              onChange={event => { const value = Number(event.target.value); if (value > 0 && value <= 2000) change(current => ({ ...current, marker: current.marker && { ...current.marker, knownMm: value } })); }} /></label>
          {fit && <p className="deformity-fit" data-testid="deformity-marker-fit" data-mm-per-pixel={mmPerPixel ?? undefined}>{t(marker.method === 'ball' ? 'deformity.ballFit' : 'deformity.rulerFit', { pixels: fit.pixels.toFixed(1), mm: (mmPerPixel ?? 0).toFixed(4) })}
            {imager && mmPerPixel ? ` · ${t('deformity.againstDetector', { factor: (imager[1] / mmPerPixel).toFixed(3) })}` : ''}
            {marker.method === 'ball' && fit.residual > 0.5 ? ` · ${t('deformity.fitResidual', { residual: fit.residual.toFixed(1) })}` : ''}</p>}
          {marker.method === 'ball' && <label className="deformity-check"><input type="checkbox" data-action="deformity-ball-depth" checked={marker.depthConfirmed}
            onChange={event => { const confirmed = event.target.checked; change(current => ({ ...current, marker: current.marker && { ...current.marker, depthConfirmed: confirmed } }));
              const recorded = manualCalibration(frame); if (recorded) recordManualCalibration(series.id, { ...recorded, depthConfirmed: confirmed }); }} />{t('deformity.depth')}</label>}
          <div className="deformity-actions">
            <button type="button" className="secondary-button compact" data-action="deformity-calibrate" disabled={!fit || applied} onClick={() => applyMarker(marker)}>{t('deformity.apply')}</button>
            {known && <button type="button" className="text-button" data-action="deformity-calibration-remove" onClick={removeCalibration}>{t('deformity.removeCalibration')}</button>}
          </div>
        </div>}
      </div>

      <h3>{t('deformity.landmarks')}</h3>
      {placing?.kind === 'landmark' && <p className="deformity-hint" role="status" data-testid="deformity-next" data-landmark={placing.name}>
        {t('deformity.next', { name: t(LANDMARK_TEXT[placing.name].name) })} {t(LANDMARK_TEXT[placing.name].hint)}
        {isContour(placing.name) && ` (${t('deformity.pointsCount', { count: placedCount(placing.name) })})`}</p>}
      <ol className="deformity-landmarks">
        {LANDMARKS.map(name => <li key={name} className={placing?.kind === 'landmark' && placing.name === name ? 'is-current' : ''} data-landmark={name} data-placed={done(name) || undefined}>
          <span className="deformity-mark" aria-hidden="true">{done(name) ? '●' : '○'}</span>
          <span className="deformity-name">{t(LANDMARK_TEXT[name].name)}{isContour(name) && placedCount(name) ? ` · ${t('deformity.pointsCount', { count: placedCount(name) })}` : ''}</span>
          <button type="button" className="text-button" data-action="deformity-place" disabled={isContour(name) && placedCount(name) >= CONTOUR_MAXIMUM}
            onClick={() => startPlacing(name)}>{done(name) ? t(isContour(name) ? 'deformity.addPoint' : 'deformity.again') : t('deformity.place')}</button>
        </li>)}
      </ol>
      <div className="deformity-actions">
        {placing ? <button type="button" className="secondary-button compact" data-action="deformity-place-stop" onClick={() => deformity.setPlacing(null)}>{t('deformity.stop')}</button>
          : nextLandmark(plan) && <button type="button" className="secondary-button compact" data-action="deformity-place-start" onClick={() => startPlacing()}>{t('deformity.start')}</button>}
      </div>
      {leg.swapped.length > 0 && <WarningBox title={t('deformity.swappedTitle')} dismissKey={`deformity-swapped:${plan.id}:${leg.swapped.join(',')}`} testId="deformity-swapped">
        <p>{t('deformity.swapped', { names: leg.swapped.map(name => t(LANDMARK_TEXT[name].name)).join(', ') })}</p></WarningBox>}
      {leg.headFitPoor && <p className="deformity-caution">{t('deformity.headFit')}</p>}

      <h3>{t('deformity.values')}</h3>
      <table className="deformity-values">
        <thead><tr><th scope="col">{t('deformity.value')}</th><th scope="col" /><th scope="col">{t('deformity.normal')}</th></tr></thead>
        <tbody>{VALUE_ORDER.map(name => {
          const value = leg.values[name], normal = name in NORMALS ? NORMALS[name as ValueKey] : null;
          const out = value.verdict && value.verdict !== 'normal';
          return <tr key={name} data-value-key={name} data-value={value.value ?? undefined} className={out ? 'is-out' : ''}>
            <th scope="row" title={normal ? [normal.source, ...normal.others].join('\n') : undefined}>{NAMED[name] ? t(NAMED[name]) : name}</th>
            <td>{value.value === null ? <span className="deformity-missing">{missingText(value.missing, t)}</span> : valueText(value, tag, t)}
              {out && <span className="deformity-verdict"> · {t(value.verdict === 'high' ? 'deformity.high' : 'deformity.low')}</span>}</td>
            <td>{normalText(name)}</td></tr>;
        })}</tbody>
      </table>
      {!view.mm && <p className="deformity-caution">{t('deformity.squarePixels')}</p>}

      <h3>{t('deformity.mat')}</h3>
      <ol className="deformity-steps">{view.steps.map(step => <li key={step.step} data-step={step.step} data-result={step.result}>
        <span>{t(`deformity.mat.${step.step}` as MessageKey)}</span>
        <strong className={step.result === 'normal' || step.result === 'unassessable' ? '' : 'is-out'}>{t(`deformity.result.${step.result}` as MessageKey)}</strong>
        {step.missing && <small>{missingText(step.missing, t)}</small>}</li>)}</ol>

      <h3>{t('deformity.cora')}</h3>
      <dl className="deformity-cora">{(['femur', 'tibia'] as const).map(name => <div key={name} data-cora={name} data-magnitude={view.cora[name]?.magnitude}>
        <dt>{t(`deformity.bone.${name}` as MessageKey)}</dt><dd>{coraText(view, name, t)}</dd></div>)}</dl>

      <h3>{t('deformity.osteotomy')}</h3>
      {!osteotomy ? <div className="deformity-osteotomy">
        <div className="deformity-segments" role="radiogroup" aria-label={t('deformity.bone')}>{(['femur', 'tibia'] as const).map(name => <button key={name} type="button" role="radio" data-action="deformity-bone"
          aria-checked={bone === name} className="secondary-button compact" onClick={() => setBone(name)}>{t(`deformity.bone.${name}` as MessageKey)}</button>)}</div>
        <button type="button" className="secondary-button compact" data-action="deformity-cut" disabled={!leg.ankle || !(bone === 'tibia' ? leg.knee : leg.hip)}
          onClick={() => deformity.setPlacing({ film: key, kind: 'cut', bone })}>{t('deformity.placeCut')}</button>
        {placing?.kind === 'cut' && <p className="deformity-hint" role="status">{t('deformity.cutHint')}</p>}
        {(!leg.ankle || !leg.knee) && <p className="deformity-missing">{t('deformity.needsLandmarks')}</p>}
      </div> : <div className="deformity-osteotomy" data-testid="deformity-osteotomy">
        <p>{t('deformity.cutOn', { bone: t(`deformity.bone.${osteotomy.bone}` as MessageKey).toLocaleLowerCase(locale) })}</p>
        <div className="deformity-segments" role="radiogroup" aria-label={t('deformity.wedge')}>{(['opening', 'closing'] as const).map(wedge => <button key={wedge} type="button" role="radio" data-action="deformity-wedge"
          aria-checked={osteotomy.wedge === wedge} className="secondary-button compact" onClick={() => changeOsteotomy({ wedge })}>{t(wedge === 'opening' ? 'deformity.wedge.opening' : 'deformity.wedge.closing')}</button>)}</div>
        <div className="deformity-fields">
          <label>{t('deformity.angle')}<input type="number" min={0} max={45} step={0.1} data-action="deformity-angle" value={Number(osteotomy.degrees.toFixed(2))}
            onChange={event => { const value = Number(event.target.value); if (value >= 0 && value <= 45) changeOsteotomy({ degrees: value }); }} /></label>
          <div className="deformity-segments" role="radiogroup" aria-label={t('deformity.direction')}>{(['valgus', 'varus'] as const).map(direction => <button key={direction} type="button" role="radio" data-action="deformity-direction"
            aria-checked={osteotomy.direction === direction} className="secondary-button compact" onClick={() => changeOsteotomy({ direction })}>{t(direction === 'valgus' ? 'deformity.valgus' : 'deformity.varus')}</button>)}</div>
        </div>
        <div className="deformity-actions"><span>{t('deformity.solve')}</span>
          <button type="button" className="secondary-button compact" data-action="deformity-solve-mad" onClick={() => {
            const solved = solveAngle(view.input, leg, osteotomy, { kind: 'mad', mm: 0 });
            if (solved) changeOsteotomy(solved); else setStatus(t('deformity.solveFailed'));
          }}>{t('deformity.solveMad')}</button>
          <button type="button" className="secondary-button compact" data-action="deformity-solve-wbl" onClick={() => {
            const solved = solveAngle(view.input, leg, osteotomy, { kind: 'wbl', percent: 62.5 });
            if (solved) changeOsteotomy(solved); else setStatus(t('deformity.solveFailed'));
          }}>{t('deformity.solveWbl')}</button></div>
        <div className="deformity-fields">
          <label>{t('deformity.shiftLateral')} ({leg.unit})<input type="number" min={-200} max={200} step={0.5} data-action="deformity-shift-lateral" value={osteotomy.shiftLateral}
            onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && Math.abs(value) <= 200) changeOsteotomy({ shiftLateral: value }); }} /></label>
          <label>{t('deformity.shiftDistal')} ({leg.unit})<input type="number" min={-200} max={200} step={0.5} data-action="deformity-shift-distal" value={osteotomy.shiftDistal}
            onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && Math.abs(value) <= 200) changeOsteotomy({ shiftDistal: value }); }} /></label>
          <label>{t('deformity.lengthen')} ({leg.unit})<input type="number" min={-200} max={200} step={0.5} data-action="deformity-lengthen" value={osteotomy.lengthen}
            onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && Math.abs(value) <= 200) changeOsteotomy({ lengthen: value }); }} /></label>
        </div>
        <label className="deformity-check"><input type="checkbox" data-action="deformity-simulate" checked={state.simulate} onChange={event => deformity.setSimulate(event.target.checked)} />{t('deformity.show')}</label>
        {view.simulation && after && <table className="deformity-values deformity-compare" data-testid="deformity-planned">
          <thead><tr><th scope="col" /><th scope="col">{t('deformity.before')}</th><th scope="col">{t('deformity.after')}</th></tr></thead>
          <tbody>{(['mLDFA', 'MPTA', 'LDTA', 'JLCA', 'HKA', 'MAD', 'WBL', 'limbLength'] as const).map(name => <tr key={name} data-value-key={name} data-value={after[name].value ?? undefined}
            className={after[name].verdict && after[name].verdict !== 'normal' ? 'is-out' : ''}>
            <th scope="row">{NAMED[name] ? t(NAMED[name]) : name}</th><td>{valueText(leg.values[name], '', t)}</td><td>{valueText(after[name], '', t)}</td></tr>)}</tbody>
        </table>}
        {view.simulation?.wedge && view.simulation.wedge !== osteotomy.wedge && <p className="deformity-caution" role="note" data-testid="deformity-wedge-mismatch">
          {t(view.simulation.wedge === 'opening' ? 'deformity.wedgeIsOpening' : 'deformity.wedgeIsClosing')}</p>}
        {view.simulation && <p className="deformity-fit" data-testid="deformity-wedge" data-wedge={view.simulation.wedgeHeight}>
          {t('deformity.wedgeHeight', { height: view.simulation.wedgeHeight.toFixed(1), unit: leg.unit })}
          {view.simulation.lengthChange !== null ? ` · ${t('deformity.lengthChange', { change: `${view.simulation.lengthChange >= 0 ? '+' : ''}${view.simulation.lengthChange.toFixed(1)}`, unit: leg.unit })}` : ''}
          {leg.unit === 'mm' && tag ? ` · ${tag}` : ''}</p>}
        {view.rule && <p className="deformity-fit" data-testid="deformity-rule" data-rule={view.rule.rule} data-translation={view.rule.translation}>{t('deformity.rule', { rule: view.rule.rule })}{view.rule.rule === 3 ? ` · ${t('deformity.ruleTranslation', { offset: view.rule.offset.toFixed(1), translation: view.rule.translation.toFixed(1), unit: leg.unit })}` : ''}</p>}
        <div className="deformity-actions"><button type="button" className="text-button" data-action="deformity-cut-remove" onClick={() => changePlan(current => ({ ...current, osteotomy: null }))}>{t('deformity.removeCut')}</button></div>
      </div>}
    </div>
    <p className="deformity-status" role="status" data-testid="deformity-status">{status ?? t('deformity.saveHelp')}</p>
    <footer>
      <button type="button" className="icon-button" data-action="deformity-undo" aria-label={t('deformity.undo')} data-tooltip={t('deformity.undo')} disabled={!history[0]} onClick={() => onUndo(false)}><Undo2 size={16} /></button>
      <button type="button" className="icon-button" data-action="deformity-redo" aria-label={t('deformity.redo')} data-tooltip={t('deformity.redo')} disabled={!history[1]} onClick={() => onUndo(true)}><Redo2 size={16} /></button>
      <span className="deformity-spacer" />
      <button type="button" className="secondary-button compact" data-action="deformity-open" disabled={busy} onClick={() => fileInput.current?.click()}><FolderOpen size={14} />{t('deformity.open')}</button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden data-action="deformity-open-file" onChange={event => void openFile(event)} />
      <button type="button" className="secondary-button compact" data-action="deformity-save" disabled={busy} onClick={() => void saveFile()}><Download size={14} />{t('deformity.save')}</button>
      <button type="button" className="primary-button compact" data-action="deformity-report" disabled={busy} onClick={() => void report()}><Images size={14} />{t('deformity.report')}</button>
    </footer>
  </section>;
}

function coraText(view: PlanView, bone: 'femur' | 'tibia', t: Translator): string {
  const cora = view.cora[bone], leg = view.leg;
  if (!cora) return t('deformity.cora.none');
  // Under 1.5° the axes' angle is within the joints' normal variation (normals.ts).
  if (cora.magnitude < 1.5) return t('deformity.cora.small', { angle: cora.magnitude.toFixed(1) });
  const length = (bone === 'femur' ? leg.values.femurLength.value : leg.values.tibiaLength.value) ?? 0;
  if (!(cora.level >= 0 && cora.level <= 1)) return t('deformity.cora.outside', { angle: cora.magnitude.toFixed(1) });
  return t(bone === 'femur' ? 'deformity.cora.belowHip' : 'deformity.cora.belowKnee', { angle: cora.magnitude.toFixed(1), distance: (cora.level * length).toFixed(0), unit: leg.unit });
}

export default DeformityPanel;
