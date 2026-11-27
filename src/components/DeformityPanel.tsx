// The lower-limb deformity plan of a standing long-leg film (docs/deformity-planning.md), opened by the assessment
// button on a DX or CR long-leg film as the pre-op checklist is on a CT. It guides the landmarks of each leg, lists
// every value against its normal range with what its millimetres stand for, runs Paley's malalignment test, finds the
// CORA, and simulates single- or multi-level osteotomies that the pane measures again live as fragments move. Plans
// live in memory (deformityStore.ts); the reader saves one as a file, or a report as a picture.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { ViewState, Volume } from '../model';
import { sourceFrameSeries } from '../imaging/geometry';
import { calibrationState, calibrationTag, calibrationText, isProjectionFilm, manualCalibration, projectionOf, sideText, type FilmCalibration } from '../imaging/radiograph';
import { CONTOUR_MAXIMUM, CONTOUR_MINIMUM, isContour, LANDMARK_TEXT, LANDMARKS, type LandmarkName } from '../imaging/deformity/landmarks';
import type { Missing, Side, Value } from '../imaging/deformity/measure';
import { NORMALS, type ValueKey } from '../imaging/deformity/normals';
import { fitCircle, distance } from '../imaging/deformity/plane';
import { MAX_OSTEOTOMIES, solveAngleMany, type Osteotomy, type Target } from '../imaging/deformity/osteotomy';
import { coraNeeds } from '../imaging/deformity/analysis';
import { UNCHECKED } from '../imaging/deformity/suggest';
import { activeCutIndex, activePlan, deformity, filmKey, newPlan, useDeformity, type FilmPlans, type Marker } from '../ui/deformityStore';
import {
  acceptSuggestions, addCoraCut, clearSuggestions, fromUnchecked, imageSideOnScreen, nextLandmark, planView,
  removeOsteotomy, resetCutFragment, resetCutShifts, selectOsteotomy, uncheckedAsSuggested, updateOsteotomy,
  withSuggestions, type PlanView,
} from '../ui/deformityPlan';
import { cancelModelDownload, framePixels, loadModel, MODEL, MODEL_BYTES, runModel, suggestionsFrom, suggestionTarget } from '../ui/landmarkSuggestions';
import { MAX_PLANS, parsePlanFile, planFile } from '../ui/deformityFile';
import { filmSides, labelQueue, sidesFor } from '../ui/labelQueue';
import { drawReport, pictureSize, pngBytes, reportHeader, type ReportSection } from '../ui/deformityReport';
import { captureViewportCanvas } from '../export-video';
import { Download, FolderOpen, Images, Plus, Redo2, Undo2, X } from './icons';
import { WarningBox } from './WarningBox';
import { useTranslation } from '../i18n/react';
import type { MessageKey, Translator } from '../i18n';
import './DeformityPanel.css';

const VALUE_ORDER: Array<Value['key']> = ['mLPFA', 'mLDFA', 'aLDFA', 'MPTA', 'LDTA', 'JLCA', 'AMA', 'HKA', 'MAD', 'WBL', 'femurLength', 'tibiaLength', 'limbLength'];
const NAMED: Partial<Record<Value['key'], MessageKey>> = { WBL: 'deformity.value.WBL', femurLength: 'deformity.value.femurLength', tibiaLength: 'deformity.value.tibiaLength', limbLength: 'deformity.value.limbLength' };
const BALLS = [25, 25.4, 30];
const CORA_KEY = { femur: 'coraFemur', tibia: 'coraTibia' } as const;
/** The value each step of the malalignment test reads (analysis.ts malalignmentTest). */
const STEP_KEY = { mad: 'MAD', femur: 'mLDFA', tibia: 'MPTA', joint: 'JLCA', subluxation: 'subluxation' } as const;

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
  if ('together' in missing) return t('deformity.together', { names: missing.together.map(name => t(LANDMARK_TEXT[name].name)).join(', ') });
  const labels = { side: 'deformity.needsSide', axis: 'deformity.needsLimbAxis', calibration: 'deformity.needsCalibration', parallel: 'deformity.parallel' } as const;
  return t(labels[missing.reason]);
}

async function save(name: string, data: ArrayBuffer | string): Promise<string | null> {
  if (window.veacom) return window.veacom.saveFile(name, data);
  const url = URL.createObjectURL(new Blob([data])), anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

const frames = (count: number) => new Promise<void>(resolve => { const step = (left: number) => left ? requestAnimationFrame(() => step(left - 1)) : resolve(); step(count); });

export function DeformityPanel({ volume, slice, view: paneView, onClose, headingRef, onCalibrate, onUndo, history, hidePatientData, viewport, labelling }: {
  /** The active pane's film, as decorated with its calibration (App's measurement scale). */
  volume: Volume; slice: number;
  /** The pane's view, as shown: its turn and flips tell which side of the image the pane's left and right are. */
  view: Pick<ViewState, 'rotation' | 'flipX'>;
  onClose: () => void;
  headingRef?: (heading: HTMLHeadingElement | null) => void;
  /** Sets the film's ball or ruler calibration (its scale in mm per coordinate unit), or removes it. */
  onCalibrate: (seriesId: string, key: string, calibration: FilmCalibration | null) => void;
  /** The viewer's Undo and Redo, which take back plan steps as they take back measurements. */
  onUndo: (redo: boolean) => void; history: [number, number];
  hidePatientData: boolean;
  /** The pane that shows the film, for the report's pictures. */
  viewport: () => HTMLElement | null;
  /** A folder being labelled (ui/labelQueue.ts): the legs a new film's plan gets, and whether suggestions may be asked
   * for. Its Save and next is the main action, so Report steps back. */
  labelling?: { sides: Side[]; suggestions: boolean };
}) {
  const { t, locale } = useTranslation();
  const state = useDeformity();
  const series = volume.series, frameIndex = Math.round(slice), frame = sourceFrameSeries(series, frameIndex);
  const key = filmKey(series, frameIndex), film = state.films[key];
  const projection = projectionOf(frame);
  const [bone, setBone] = useState<Osteotomy['bone']>('tibia');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const operationGeneration = useRef(0);
  // A suggestion run: the model's download (bytes received) and then its run (null), with how long the last run took.
  const [suggesting, setSuggesting] = useState<{ received: number | null } | null>(null);
  // The last run's timings and threads, and stage A's least peak for the leg it ran on.
  const [suggestRunInfo, setSuggestRunInfo] = useState<Record<string, number> | null>(null);
  const suggestRun = useRef<AbortController | null>(null);
  useEffect(() => () => suggestRun.current?.abort(), []);
  // The film the pane shows now, for a run that ends after the reader paged or calibrated.
  const shownFilm = useRef({ key: '', frame: null as ReturnType<typeof sourceFrameSeries> | null });
  useLayoutEffect(() => {
    return () => { operationGeneration.current++; };
  }, [frame, film, hidePatientData, locale]);
  useEffect(() => { deformity.setOpen(true); return () => deformity.setOpen(false); }, []);
  useEffect(() => {
    deformity.ensure(series, frameIndex, labelling ? sidesFor(labelling.sides, projection?.laterality) : filmSides(projection?.laterality));
    // Undo past the film's first step removes it from the store: it is made again, empty.
  }, [series.id, series.uid, series.frameMetadata, frameIndex, projection?.laterality, Boolean(film)]);
  // Esc stops placing points or lassoing wherever focus is (the pane included); the next Esc in the panel closes it.
  const placing = state.placing?.film === key ? state.placing : null;
  useEffect(() => {
    if (!placing) return;
    const stop = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); deformity.setPlacing(null); } };
    window.addEventListener('keydown', stop, true);
    return () => window.removeEventListener('keydown', stop, true);
  }, [placing]);
  useLayoutEffect(() => { shownFilm.current = { key, frame }; });
  if (!film) return <section className="deformity-panel" data-testid="deformity-panel" aria-label={t('deformity.title')} />;
  const view = planView(film, frame), plan = view.plan, leg = view.leg, tag = calibrationTag(frame, 'auto');
  const cuts = plan.osteotomies;
  const selectedCut = activeCutIndex(plan);
  const osteotomy = selectedCut >= 0 ? cuts[selectedCut] : null;
  const simOrder = view.simulation?.cuts ?? [];
  const selectedSim = simOrder.find(item => item.index === selectedCut) ?? null;
  const selectedRule = selectedCut >= 0 ? view.rules[selectedCut] ?? null : null;
  const change = (update: (current: FilmPlans) => FilmPlans) => deformity.change(key, update);
  const changeOsteotomy = (patch: Partial<Osteotomy>) => {
    if (selectedCut < 0) return;
    change(current => updateOsteotomy(current, selectedCut, patch));
  };
  const solveFor = (target: Target) => {
    if (selectedCut < 0) return;
    const solved = solveAngleMany(view.input, leg, cuts, selectedCut, target);
    if (solved) changeOsteotomy(solved); else setStatus(t('deformity.solveFailed'));
  };
  const canPlaceCut = (targetBone: Osteotomy['bone']) => cuts.length < MAX_OSTEOTOMIES && Boolean(leg.ankle && (targetBone === 'tibia' ? leg.knee : leg.hip));
  const canPlaceAtCora = (targetBone: Osteotomy['bone']) => {
    const cora = view.cora[targetBone];
    return Boolean(cora && cora.magnitude >= 1.5 && canPlaceCut(targetBone));
  };
  const placeAtCora = (targetBone: Osteotomy['bone']) => {
    deformity.setPlacing(null);
    deformity.setEditCutout(false);
    change(current => addCoraCut(current, targetBone, frame));
  };
  const startPlacing = (name?: LandmarkName) => {
    const next = name ?? nextLandmark(plan);
    deformity.setPlacing(next ? { film: key, kind: 'landmark', name: next } : null);
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || (event.target as HTMLElement).matches('input, select')) return;
    event.stopPropagation();
    if (placing) deformity.setPlacing(null); else onClose();
  };

  // Calibration from the ball or ruler the reader marked: the film's scale, so every measurement on it follows. The
  // series' other films keep theirs: the object stands at this film's magnification only.
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
    if (a[0] === b[0] && a[1] === b[1]) return null;
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
    if (Number.isFinite(scale) && scale > 0) onCalibrate(series.id, key, { method: current.method, knownMm: current.knownMm, scale, depthConfirmed: current.depthConfirmed });
  };
  const removeCalibration = () => onCalibrate(series.id, key, null);
  // The marker calibrates the film while the film's scale is the one it gives.
  const applied = Boolean(known && fit && marker && known.method === marker.method && Math.abs(known.scale - marker.knownMm / fit.world) <= 1e-9 * known.scale);
  const imager = projection?.imagerPixelSpacing;
  const mmPerPixel = fit && marker ? marker.knownMm / fit.pixels : null;

  // Suggestions from the landmark model (ui/landmarkSuggestions.ts), only when the reader asks: never measured until
  // the reader accepts or moves them.
  const target = suggestionTarget(view, frame);
  const suggest = async () => {
    if (!('leg' in target) || !view.mm) return;
    const controller = new AbortController(), planId = plan.id, targetLeg = target.leg, mm = view.mm;
    suggestRun.current = controller;
    // "Downloading" shows only while bytes arrive: a kept model loads without it.
    setStatus(null); setSuggesting({ received: null });
    try {
      const graphs = await loadModel(received => { if (suggestRun.current === controller && received > 0) setSuggesting({ received }); });
      if (controller.signal.aborted) throw controller.signal.reason;
      setSuggesting({ received: null });
      const reply = await runModel({ pixels: framePixels(volume, frameIndex), columns: frame.dimensions[0], rows: frame.dimensions[1], mm: [mm[0], mm[1]],
        invert: frame.photometricInterpretation.toUpperCase() === 'MONOCHROME1' }, targetLeg, graphs, controller.signal);
      const total = reply.total, anchor = reply.anchors[targetLeg];
      setSuggestRunInfo({
        total, ...reply.timings, threads: reply.threads, peak: anchor.peak,
        ...(anchor.presence !== undefined ? { presence: anchor.presence } : {}),
      });
      // The suggestions belong to the film, plan, leg and scale the model ran with: paged, switched or calibrated since,
      // they are not put on.
      const now = shownFilm.current, live = deformity.get().films[key], liveView = live && now.frame ? planView(live, now.frame) : null;
      const again = liveView && now.frame ? suggestionTarget(liveView, now.frame) : null;
      if (now.key !== key || !live || !liveView || activePlan(live).id !== planId || !again || !('leg' in again) || again.leg !== targetLeg
        || liveView.mm?.[0] !== mm[0] || liveView.mm[1] !== mm[1]) { setStatus(t('deformity.suggestChanged')); return; }
      const found = suggestionsFrom(reply.anchors, targetLeg, reply.channels, mm, [frame.dimensions[0], frame.dimensions[1]]);
      if (found === 'unsure') { setStatus(t('deformity.suggestUnsure')); return; }
      if (!found || !Object.keys(found).length) { setStatus(t('deformity.suggestNone')); return; }
      // Suggestions are not drawn while the simulation shows: none is put on (or marked as shown) unseen.
      if (deformity.get().simulate && liveView.simulation) { setStatus(t('deformity.suggestSimulated')); return; }
      // Suggestions turned off for a folder's run while the model ran: none is put on its film.
      const run = labelQueue.get();
      if (run.folder && !run.suggestions && run.seriesIds.includes(series.id)) { setStatus(t('label.suggestionsOff')); return; }
      deformity.change(key, current => withSuggestions(current, Object.fromEntries(Object.entries(found).map(([name, item]) => [name, item.points])), MODEL, UNCHECKED));
      const count = Object.keys(activePlan(deformity.get().films[key]!).suggested?.points ?? {}).length;
      setStatus(t('deformity.suggestDone', { count, seconds: (total / 1000).toFixed(1) }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const knownErrors = { checksum: 'deformity.suggestChecksum', unavailable: 'deformity.suggestUnavailable', download: 'deformity.suggestDownload',
        frame: 'deformity.suggestFrame', run: 'deformity.suggestRun' } as const;
      setStatus(controller.signal.aborted ? t('deformity.suggestCancelled')
        : t('deformity.suggestFailed', { reason: Object.hasOwn(knownErrors, reason) ? t(knownErrors[reason as keyof typeof knownErrors]) : reason }));
    } finally {
      if (suggestRun.current === controller) { suggestRun.current = null; setSuggesting(null); }
    }
  };
  const cancelSuggest = () => { cancelModelDownload(); suggestRun.current?.abort(); };
  // The model's plateau points sit inboard of the rim (its training labels' convention): the plateau's width, and so
  // WBL and the joint offset, are short while they stay where the model put them.
  const plateauInboard = (['tibialPlateauMedial', 'tibialPlateauLateral'] as const).some(name => plan.origin?.[name]?.model && plan.provenance[name]?.includes('accepted'));
  // Values measured from a landmark the model suggested with no real-film check, accepted as it was: marked beside them.
  const unchecked = fromUnchecked(plan);
  // The line on what is checked shows with the suggestions, and while an unchecked one is kept as it was suggested.
  const uncheckedShown = LANDMARKS.some(name => uncheckedAsSuggested(plan, name));
  // While the simulation shows, the film's fragments are drawn moved and suggestions are not drawn: none can be accepted.
  const simulated = state.simulate && Boolean(view.simulation);
  const fromModel = Boolean(plan.suggested) || LANDMARKS.some(name => plan.origin?.[name]?.model);

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
    const generation = operationGeneration.current;
    setBusy(true);
    try {
      const result = await parsePlanFile(await chosen.text(), film, frame);
      if (operationGeneration.current !== generation || deformity.get().films[key] !== film) { setStatus(t('deformity.openChanged')); return; }
      if ('error' in result) { setStatus(result.error === 'film' ? t('deformity.wrongFilm') : t('deformity.badFile', { reason: t(`deformity.reason.${result.error}` as MessageKey) })); return; }
      deformity.setPlacing(null);
      deformity.setEditCutout(false);
      deformity.change(key, current => ({ ...current, plans: result.plans, active: result.plans[result.active].id, marker: result.marker, patientRight: result.patientRight }), 'calibration');
      onCalibrate(series.id, key, result.calibration);
      const count = result.plans.reduce((sum, item) => sum + Object.values(item.points).reduce((n, list) => n + list.length, 0), 0);
      setStatus(t('deformity.opened', { count }));
    } catch (error) { setStatus(t('deformity.openFailed', { reason: error instanceof Error ? error.message : String(error) })); }
    finally { setBusy(false); }
  };
  const report = async () => {
    const element = viewport();
    if (!element) return;
    setBusy(true);
    const wasSimulated = state.simulate;
    const wasEditCutout = state.editCutout;
    const generation = operationGeneration.current;
    const check = (simulation: boolean) => {
      const live = deformity.get();
      if (operationGeneration.current !== generation || live.films[key] !== film || !live.open || live.simulate !== simulation ||
        viewport() !== element || element.querySelector('[data-testid="deformity-drawing"]')?.getAttribute('data-film') !== key) throw REPORT_CHANGED;
    };
    try {
      deformity.setEditCutout(false);
      deformity.setSimulate(false); await frames(3);
      // Captured at the report's own resolution (pictureSize), so the drawing is sharp whatever the screen.
      const header = reportHeader(series, frame, hidePatientData, t), bounds = element.getBoundingClientRect();
      const outputSize = pictureSize(bounds, view.simulation ? 2 : 1, header.length);
      // The pictures must show the film and plan the tables are made from: a pane paged or given another series while
      // they are drawn (captureViewportCanvas checks the slice and series), or a plan changed, stops the report.
      const capture = async (simulation: boolean) => {
        check(simulation);
        const canvas = await captureViewportCanvas(element, { hidePatientData, outputSize }, { slice: frameIndex, seriesId: series.id }).catch((error: unknown) => {
          const code = (error as { messageKey?: string } | null)?.messageKey;
          throw code === 'video.sliceMissing' || code === 'video.paneChanged' ? REPORT_CHANGED : error;
        });
        check(simulation);
        return canvas;
      };
      const pictures = [{ caption: t('deformity.report.now'), canvas: await capture(false) }];
      if (view.simulation) {
        deformity.setSimulate(true); await frames(3);
        pictures.push({ caption: t('deformity.report.planned'), canvas: await capture(true) });
      }
      // The report carries the panel's cautions under the values they affect: the model's plateau points inside the rim,
      // and a value measured from an unchecked point accepted as it was.
      const cautions = (inboard: boolean, isUnchecked: boolean) => [inboard && plateauInboard ? t('deformity.plateauInboardShort') : '',
        isUnchecked ? t('deformity.uncheckedShort') : ''].filter(Boolean).join(' · ') || undefined;
      const sections: ReportSection[] = [{ title: t('deformity.values'), rows: VALUE_ORDER.map(name => leg.values[name].value === null
        ? [NAMED[name] ? t(NAMED[name]) : name, missingText(leg.values[name].missing, t), normalText(name) || undefined]
        : [NAMED[name] ? t(NAMED[name]) : name, valueText(leg.values[name], tag, t), normalText(name) || undefined, cautions(name === 'WBL', unchecked.has(name))]) },
        { title: t('deformity.mat'), rows: view.steps.map(step => [t(`deformity.mat.${step.step}` as MessageKey), t(`deformity.result.${step.result}` as MessageKey), undefined,
          step.result === 'unassessable' ? undefined : cautions(step.step === 'subluxation', unchecked.has(STEP_KEY[step.step]))]) },
        { title: t('deformity.cora'), rows: (['femur', 'tibia'] as const).map(boneName => [t(`deformity.bone.${boneName}` as MessageKey), coraText(view, boneName, t), undefined,
          cautions(false, Boolean(view.cora[boneName]) && unchecked.has(CORA_KEY[boneName]))]) }];
      if (view.simulation && cuts.length) {
        const after = view.simulation.leg.values;
        const multi = view.simulation.cuts.length > 1;
        const cutRows: ReportSection['rows'] = [];
        view.simulation.cuts.forEach((cutSim, orderIdx) => {
          const o = cutSim.osteotomy, cutRule = view.rules[cutSim.index];
          const cutLabel = multi ? t('deformity.report.cutNumber', { number: orderIdx + 1 }) : t('deformity.report.cut');
          const wedgeLabel = multi ? t('deformity.report.wedgeNumber', { number: orderIdx + 1 }) : t('deformity.report.wedge');
          const rulePart = cutRule ? ` · ${t('deformity.rule', { rule: cutRule.rule })}` : '';
          cutRows.push([
            cutLabel,
            `${t(`deformity.bone.${o.bone}` as MessageKey)} · ${t((cutSim.wedge ?? o.wedge) === 'opening' ? 'deformity.wedge.opening' : 'deformity.wedge.closing')} · ${o.degrees.toFixed(1)}° ${t(o.direction === 'valgus' ? 'deformity.valgus' : 'deformity.varus')}${rulePart}`,
            undefined,
            cutRule && unchecked.has(CORA_KEY[o.bone]) ? t('deformity.uncheckedShort') : undefined,
          ]);
          cutRows.push([wedgeLabel, `${cutSim.wedgeHeight.toFixed(1)} ${leg.unit}${leg.unit === 'mm' && tag ? ` · ${tag}` : ''}`]);
        });
        if (multi && view.simulation.lengthChange !== null) {
          const delta = view.simulation.lengthChange;
          cutRows.push([t('deformity.report.lengthChange'), `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ${leg.unit}${leg.unit === 'mm' && tag ? ` · ${tag}` : ''}`]);
        }
        sections.push({ title: t('deformity.osteotomy'), rows: [
          ...cutRows,
          ...(['mLDFA', 'MPTA', 'LDTA', 'JLCA', 'HKA', 'MAD', 'WBL', 'limbLength'] as const).map(name => {
            const given = leg.values[name].value !== null || after[name].value !== null;
            return [NAMED[name] ? t(NAMED[name]) : name, `${valueText(leg.values[name], '', t)} → ${valueText(after[name], '', t)}`, undefined, given ? cautions(name === 'WBL', unchecked.has(name)) : undefined] as ReportSection['rows'][number];
          }),
        ] });
      }
      const canvas = drawReport({ title: `${t('deformity.title')} · ${planName(film, plan.id, t)}`,
        lines: header,
        pictures, sections,
        footer: [view.simulation ? t('deformity.report.simulated') : '', t('deformity.report.footer', { version: window.veacom?.getVersion() ?? '', date: new Date().toLocaleString(locale) })].filter(Boolean) });
      const where = await save('veacom-deformity-report.png', await pngBytes(canvas));
      setStatus(where ? t('deformity.reportSaved', { file: where.split(/[\\/]/).pop() ?? where }) : null);
    } catch (error) { setStatus(error === REPORT_CHANGED ? t('deformity.reportChanged') : t('deformity.failed', { reason: error instanceof Error ? error.message : String(error) })); }
    finally { deformity.setSimulate(wasSimulated); deformity.setEditCutout(wasEditCutout); setBusy(false); }
  };

  const after = view.simulation?.leg.values;
  const placedCount = (name: LandmarkName) => plan.points[name]?.length ?? 0;
  const done = (name: LandmarkName) => placedCount(name) >= (isContour(name) ? CONTOUR_MINIMUM : 1);
  const laterality = projection?.laterality;
  const otherSide = laterality === 'R' || laterality === 'L' ? laterality !== plan.side : false;
  const hasShifts = Boolean(osteotomy && (osteotomy.shiftLateral !== 0 || osteotomy.shiftDistal !== 0 || osteotomy.lengthen !== 0));
  const orderedIndices = simOrder.length === cuts.length ? simOrder.map(item => item.index) : cuts.map((_, i) => i);
  const displayCutNumber = selectedCut >= 0 ? orderedIndices.indexOf(selectedCut) + 1 : 0;

  return <section className="deformity-panel" aria-label={t('deformity.title')} data-testid="deformity-panel" onKeyDown={keyDown}>
    <header><h2 ref={headingRef} tabIndex={-1}>{t('deformity.title')}</h2>
      <button type="button" className="icon-button" aria-label={t('deformity.close')} data-tooltip={t('deformity.close')} data-action="deformity-close" onClick={onClose}><X size={16} /></button></header>
    <div className="deformity-body">
      <p className="deformity-film" data-testid="deformity-calibration" data-state={calibrationState(frame, 'auto') === 'manual' ? 'manual' : projection?.basis ?? 'none'}>{sideText(frame)} · {calibrationText(frame, 'auto')}</p>
      {!isProjectionFilm(frame) && <p className="deformity-caution">{t('deformity.notProjection')}</p>}
      {projection && !/LEG|LIMB|EXTREMITY|LOWEXM/i.test(projection.bodyPart ?? '') && <p className="deformity-caution">{t('deformity.qualify')}</p>}
      {view.askRight && <div className="deformity-ask" role="group" aria-label={t('deformity.askRight')}>
        <span>{t('deformity.askRight')}</span>
        {/* The answer is on screen; the plan keeps the image's side, through the pane's turn and flip. */}
        <div className="deformity-segments">{(['left', 'right'] as const).map(side => {
          const image = imageSideOnScreen(side, paneView);
          return <button key={side} type="button" data-action="deformity-patient-right" data-side={side} data-image={image ?? undefined} aria-pressed={image !== null && film.patientRight === image}
            className="secondary-button compact" disabled={!image} data-tooltip={image ? undefined : t('deformity.askUpright')}
            onClick={() => { if (image) change(current => ({ ...current, patientRight: image })); }}>{t(side === 'left' ? 'deformity.imageLeft' : 'deformity.imageRight')}</button>;
        })}</div>
      </div>}

      <div className="deformity-plans" role="tablist" aria-label={t('deformity.plans')}>
        {film.plans.map(item => <button key={item.id} type="button" role="tab" data-action="deformity-plan-tab" aria-selected={item.id === film.active}
          onClick={() => { deformity.setPlacing(null); deformity.setEditCutout(false); change(current => ({ ...current, active: item.id })); }}>{planName(film, item.id, t)}</button>)}
        {/* Another plan of the same leg, to compare corrections. */}
        <button type="button" className="icon-button" data-action="deformity-plan-add" disabled={film.plans.length >= MAX_PLANS} aria-label={t('deformity.addPlan')} data-tooltip={t('deformity.addPlan')}
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
              if (known && applied) onCalibrate(series.id, key, { ...known, depthConfirmed: confirmed }); }} />{t('deformity.depth')}</label>}
          <div className="deformity-actions">
            <button type="button" className="secondary-button compact" data-action="deformity-calibrate" disabled={!fit || applied} onClick={() => applyMarker(marker)}>{t('deformity.apply')}</button>
            {known && <button type="button" className="text-button" data-action="deformity-calibration-remove" onClick={removeCalibration}>{t('deformity.removeCalibration')}</button>}
          </div>
        </div>}
      </div>

      <h3>{t('deformity.landmarks')}</h3>
      <div className="deformity-suggest" data-testid="deformity-suggest" data-suggest-run={suggestRunInfo ? JSON.stringify(suggestRunInfo) : undefined}>
        <div className="deformity-actions">
          {suggesting ? <>
            <span className="deformity-hint" role="status" data-testid="deformity-suggest-progress">{suggesting.received === null ? t('deformity.suggestRunning')
              : t('deformity.suggestDownloading', { received: (suggesting.received / 1e6).toFixed(1), total: (MODEL_BYTES / 1e6).toFixed(1) })}</span>
            <button type="button" className="secondary-button compact" data-action="deformity-suggest-cancel" onClick={cancelSuggest}>{t('deformity.suggestCancel')}</button>
          </> : <button type="button" className="secondary-button compact" data-action="deformity-suggest" disabled={'block' in target || simulated || labelling?.suggestions === false}
            data-tooltip={labelling?.suggestions === false ? t('label.suggestionsOff') : 'block' in target ? t(`deformity.suggestBlock.${target.block}` as MessageKey) : simulated ? t('deformity.suggestSimulated') : undefined}
            onClick={() => void suggest()}>{t('deformity.suggest')}</button>}
          {plan.suggested && !suggesting && <>
            <button type="button" className="secondary-button compact" data-action="deformity-suggest-accept-all" disabled={simulated}
              data-tooltip={simulated ? t('deformity.suggestSimulated') : undefined} onClick={() => change(current => acceptSuggestions(current))}>{t('deformity.acceptAll')}</button>
            <button type="button" className="text-button" data-action="deformity-suggest-clear" onClick={() => change(clearSuggestions)}>{t('deformity.clearSuggestions')}</button>
          </>}
        </div>
        {/* A caution while the model's points are on the plan; until then, what the button would do. */}
        <p className={fromModel ? 'deformity-caution' : 'deformity-note'} role="note">{t('deformity.suggestTrained')}</p>
        {(plan.suggested || uncheckedShown) && <p className="deformity-note" role="note" data-unchecked-note>{t('deformity.suggestUnchecked')}</p>}
      </div>
      {placing?.kind === 'landmark' && <p className="deformity-hint" role="status" data-testid="deformity-next" data-landmark={placing.name}>
        {t('deformity.next', { name: t(LANDMARK_TEXT[placing.name].name) })} {t(LANDMARK_TEXT[placing.name].hint)}
        {isContour(placing.name) && ` (${t('deformity.pointsCount', { count: placedCount(placing.name) })})`}</p>}
      <ol className="deformity-landmarks">
        {LANDMARKS.map(name => {
          const suggested = Boolean(plan.suggested?.points[name]);
          // Unchecked while it waits as the model's suggestion, and once accepted until the reader moves or places it.
          const uncheckedRow = suggested ? Boolean(plan.suggested?.unchecked?.includes(name)) : uncheckedAsSuggested(plan, name);
          return <li key={name} className={placing?.kind === 'landmark' && placing.name === name ? 'is-current' : ''} data-landmark={name} data-placed={done(name) || undefined}
            data-suggested={suggested || undefined} data-origin={plan.origin?.[name]?.model ? 'model' : undefined} data-unchecked={uncheckedRow || undefined}>
            <span className="deformity-mark" aria-hidden="true">{done(name) ? '●' : suggested ? '◌' : '○'}</span>
            <span className="deformity-name">{t(LANDMARK_TEXT[name].name)}{isContour(name) && placedCount(name) ? ` · ${t('deformity.pointsCount', { count: placedCount(name) })}` : ''}
              {suggested && <span className="deformity-missing"> · {t('deformity.suggested')}</span>}
              {uncheckedRow && <span className="deformity-caution"> · {t('deformity.unchecked')}</span>}</span>
            <span className="deformity-row-actions">
              {suggested && <button type="button" className="text-button" data-action="deformity-suggest-accept" disabled={simulated}
                aria-label={t('deformity.acceptNamed', { name: t(LANDMARK_TEXT[name].name) })} data-tooltip={simulated ? t('deformity.suggestSimulated') : undefined}
                onClick={() => change(current => acceptSuggestions(current, [name]))}>{t('deformity.accept')}</button>}
              <button type="button" className="text-button" data-action="deformity-place" disabled={isContour(name) && placedCount(name) >= CONTOUR_MAXIMUM}
                onClick={() => startPlacing(name)}>{done(name) ? t(isContour(name) ? 'deformity.addPoint' : 'deformity.again') : t('deformity.place')}</button>
            </span>
          </li>;
        })}
      </ol>
      <div className="deformity-actions">
        {placing ? <button type="button" className="secondary-button compact" data-action="deformity-place-stop" onClick={() => deformity.setPlacing(null)}>{t('deformity.stop')}</button>
          : nextLandmark(plan) && <button type="button" className="secondary-button compact" data-action="deformity-place-start" onClick={() => startPlacing()}>{t('deformity.start')}</button>}
      </div>
      {leg.swapped.length > 0 && <WarningBox title={t('deformity.swappedTitle')} dismissKey={`deformity-swapped:${plan.id}:${leg.swapped.join(',')}`} testId="deformity-swapped">
        <p>{t('deformity.swapped', { names: leg.swapped.map(name => t(LANDMARK_TEXT[name].name)).join(', ') })}</p></WarningBox>}
      {leg.headFitPoor && <p className="deformity-caution">{t('deformity.headFit')}</p>}
      {plateauInboard && <p className="deformity-caution" role="note" data-testid="deformity-plateau-inboard">{t('deformity.plateauInboard')}</p>}

      <h3>{t('deformity.values')}</h3>
      <table className="deformity-values">
        <thead><tr><th scope="col">{t('deformity.value')}</th><th scope="col" /><th scope="col">{t('deformity.normal')}</th></tr></thead>
        <tbody>{VALUE_ORDER.map(name => {
          const value = leg.values[name], normal = name in NORMALS ? NORMALS[name as ValueKey] : null;
          const out = value.verdict && value.verdict !== 'normal';
          return <tr key={name} data-value-key={name} data-value={value.value ?? undefined} className={out ? 'is-out' : ''}>
            <th scope="row" title={normal ? [normal.source, ...normal.others].join('\n') : undefined}>{NAMED[name] ? t(NAMED[name]) : name}</th>
            <td>{value.value === null ? <span className="deformity-missing">{missingText(value.missing, t)}</span> : valueText(value, tag, t)}
              {out && <span className="deformity-verdict"> · {t(value.verdict === 'high' ? 'deformity.high' : 'deformity.low')}</span>}
              {plateauInboard && name === 'WBL' && value.value !== null && <span className="deformity-caution" data-testid="deformity-wbl-inboard"> · {t('deformity.plateauInboardShort')}</span>}
              {unchecked.has(name) && value.value !== null && <span className="deformity-caution" data-unchecked-value> · {t('deformity.uncheckedShort')}</span>}</td>
            <td>{normalText(name)}</td></tr>;
        })}</tbody>
      </table>
      {!view.mm && <p className="deformity-caution">{t('deformity.squarePixels')}</p>}

      <h3>{t('deformity.mat')}</h3>
      <ol className="deformity-steps">{view.steps.map(step => <li key={step.step} data-step={step.step} data-result={step.result}>
        <span>{t(`deformity.mat.${step.step}` as MessageKey)}</span>
        <strong className={step.result === 'normal' || step.result === 'unassessable' ? '' : 'is-out'}>{t(`deformity.result.${step.result}` as MessageKey)}</strong>
        {step.missing && <small>{missingText(step.missing, t)}</small>}
        {plateauInboard && step.step === 'subluxation' && step.result !== 'unassessable' && <small className="deformity-caution">{t('deformity.plateauInboardShort')}</small>}
        {unchecked.has(STEP_KEY[step.step]) && step.result !== 'unassessable' && <small className="deformity-caution" data-unchecked-value>{t('deformity.uncheckedShort')}</small>}</li>)}</ol>

      <h3>{t('deformity.cora')}</h3>
      <dl className="deformity-cora">{(['femur', 'tibia'] as const).map(name => <div key={name} data-cora={name} data-magnitude={view.cora[name]?.magnitude}>
        <dt>{t(`deformity.bone.${name}` as MessageKey)}</dt><dd>{coraText(view, name, t)}
          {view.cora[name] && unchecked.has(CORA_KEY[name]) && <span className="deformity-caution" data-unchecked-value> · {t('deformity.uncheckedShort')}</span>}
          {canPlaceAtCora(name) && <span className="deformity-cora-action"> · <button type="button" className="text-button" data-action="deformity-cut-cora" data-bone={name}
            onClick={() => placeAtCora(name)}>{t('deformity.placeAtCora')}</button></span>}</dd></div>)}</dl>

      <h3>{t('deformity.osteotomy')}</h3>
      {!osteotomy ? <div className="deformity-osteotomy">
        <div className="deformity-segments" role="radiogroup" aria-label={t('deformity.bone')}>{(['femur', 'tibia'] as const).map(name => <button key={name} type="button" role="radio" data-action="deformity-bone"
          aria-checked={bone === name} className="secondary-button compact" onClick={() => setBone(name)}>{t(`deformity.bone.${name}` as MessageKey)}</button>)}</div>
        <div className="deformity-actions">
          <button type="button" className="secondary-button compact" data-action="deformity-cut" disabled={!canPlaceCut(bone)}
            onClick={() => deformity.setPlacing({ film: key, kind: 'cut', bone })}>{t('deformity.placeCut')}</button>
          {canPlaceAtCora(bone) && <button type="button" className="secondary-button compact" data-action="deformity-cut-cora" data-bone={bone}
            onClick={() => placeAtCora(bone)}>{t('deformity.placeAtCora')}</button>}
        </div>
        {placing?.kind === 'cut' && <p className="deformity-hint" role="status">{t('deformity.cutHint')}</p>}
        {(!leg.ankle || !leg.knee) && <p className="deformity-missing">{t('deformity.needsLandmarks')}</p>}
      </div> : <div className="deformity-osteotomy" data-testid="deformity-osteotomy">
        {cuts.length > 1 && <div className="deformity-cuts" role="tablist" aria-label={t('deformity.cutSummary')}>
          {orderedIndices.map((idx, orderPos) => {
            const cut = cuts[idx];
            return <button key={cut.id ?? idx} type="button" role="tab" data-action="deformity-cut-select" data-cut-index={idx}
              aria-selected={idx === selectedCut} onClick={() => { deformity.setPlacing(null); change(current => selectOsteotomy(current, idx)); }}>
              {t('deformity.cutTab', { number: orderPos + 1, bone: t(`deformity.bone.${cut.bone}` as MessageKey), angle: cut.degrees.toFixed(1) })}
            </button>;
          })}
        </div>}
        <p>{cuts.length > 1 ? `${t('deformity.cutNumber', { number: displayCutNumber })} · ` : ''}{t('deformity.cutOn', { bone: t(`deformity.bone.${osteotomy.bone}` as MessageKey).toLocaleLowerCase(locale) })}</p>
        <div className="deformity-segments" role="radiogroup" aria-label={t('deformity.wedge')}>{(['opening', 'closing'] as const).map(wedge => <button key={wedge} type="button" role="radio" data-action="deformity-wedge"
          aria-checked={osteotomy.wedge === wedge} className="secondary-button compact" onClick={() => changeOsteotomy({ wedge })}>{t(wedge === 'opening' ? 'deformity.wedge.opening' : 'deformity.wedge.closing')}</button>)}</div>
        <div className="deformity-fields">
          <label>{t('deformity.angle')}<input type="number" min={0} max={45} step={0.1} data-action="deformity-angle" value={Number(osteotomy.degrees.toFixed(2))}
            onChange={event => { const value = Number(event.target.value); if (value >= 0 && value <= 45) changeOsteotomy({ degrees: value }); }} /></label>
          <div className="deformity-segments" role="radiogroup" aria-label={t('deformity.direction')}>{(['valgus', 'varus'] as const).map(direction => <button key={direction} type="button" role="radio" data-action="deformity-direction"
            aria-checked={osteotomy.direction === direction} className="secondary-button compact" onClick={() => changeOsteotomy({ direction })}>{t(direction === 'valgus' ? 'deformity.valgus' : 'deformity.varus')}</button>)}</div>
        </div>
        <div className="deformity-actions"><span>{t('deformity.solve')}</span>
          <button type="button" className="secondary-button compact" data-action="deformity-solve-mad" onClick={() => solveFor({ kind: 'mad', mm: 0 })}>{t('deformity.solveMad')}</button>
          <button type="button" className="secondary-button compact" data-action="deformity-solve-wbl" onClick={() => solveFor({ kind: 'wbl', percent: 62.5 })}>{t('deformity.solveWbl')}</button>
          {osteotomy.bone === 'femur' && <button type="button" className="secondary-button compact" data-action="deformity-solve-mldfa" disabled={leg.values.mLDFA.value === null}
            onClick={() => solveFor({ kind: 'mLDFA', degrees: 87 })}>{t('deformity.solveMldfa')}</button>}
          {osteotomy.bone === 'tibia' && <button type="button" className="secondary-button compact" data-action="deformity-solve-mpta" disabled={leg.values.MPTA.value === null}
            onClick={() => solveFor({ kind: 'MPTA', degrees: 87 })}>{t('deformity.solveMpta')}</button>}
          {osteotomy.bone === 'tibia' && leg.values.LDTA.value !== null && <button type="button" className="secondary-button compact" data-action="deformity-solve-ldta"
            onClick={() => solveFor({ kind: 'LDTA', degrees: 89 })}>{t('deformity.solveLdta')}</button>}
        </div>
        <div className="deformity-fields">
          <label>{t('deformity.shiftLateral')} ({leg.unit})<input type="number" min={-200} max={200} step={0.5} data-action="deformity-shift-lateral" value={osteotomy.shiftLateral}
            onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && Math.abs(value) <= 200) changeOsteotomy({ shiftLateral: value }); }} /></label>
          <label>{t('deformity.shiftDistal')} ({leg.unit})<input type="number" min={-200} max={200} step={0.5} data-action="deformity-shift-distal" value={osteotomy.shiftDistal}
            onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && Math.abs(value) <= 200) changeOsteotomy({ shiftDistal: value }); }} /></label>
          <label>{t('deformity.lengthen')} ({leg.unit})<input type="number" min={-200} max={200} step={0.5} data-action="deformity-lengthen" value={osteotomy.lengthen}
            onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value) && Math.abs(value) <= 200) changeOsteotomy({ lengthen: value }); }} /></label>
          {hasShifts && <button type="button" className="text-button" data-action="deformity-reset-shifts"
            onClick={() => change(current => resetCutShifts(current, selectedCut))}>{t('deformity.resetShifts')}</button>}
        </div>
        <div className="deformity-actions">
          <button type="button" className="secondary-button compact" data-action="deformity-cutout-edit" aria-pressed={state.editCutout}
            onClick={() => { if (placing?.kind === 'lasso') deformity.setPlacing(null); deformity.setEditCutout(!state.editCutout); }}>{t('deformity.editCutout')}</button>
          <button type="button" className="secondary-button compact" data-action="deformity-cutout-lasso" aria-pressed={placing?.kind === 'lasso'}
            onClick={() => {
              if (placing?.kind === 'lasso') { deformity.setPlacing(null); return; }
              deformity.setEditCutout(false);
              deformity.setPlacing({ film: key, kind: 'lasso', cutIndex: selectedCut });
            }}>{t('deformity.traceCutout')}</button>
          <button type="button" className="text-button" data-action="deformity-cutout-reset"
            onClick={() => change(current => resetCutFragment(current, selectedCut, frame))}>{t('deformity.resetCutout')}</button>
        </div>
        {placing?.kind === 'lasso' && <p className="deformity-hint" role="status">{t('deformity.lassoHint')}</p>}
        {state.editCutout && placing?.kind !== 'lasso' && <p className="deformity-note">{t('deformity.cutoutHint')}</p>}
        <div className="deformity-toggles">
          <label className="deformity-check"><input type="checkbox" data-action="deformity-simulate" checked={state.simulate} onChange={event => deformity.setSimulate(event.target.checked)} />{t('deformity.show')}</label>
          <label className="deformity-check"><input type="checkbox" data-action="deformity-guides" checked={state.showGuides} onChange={event => deformity.setShowGuides(event.target.checked)} />{t('deformity.guides')}</label>
        </div>
        {simulated && !state.editCutout && !placing && <p className="deformity-note">{t('deformity.canvasHint')}</p>}
        {selectedSim?.wedge && selectedSim.wedge !== osteotomy.wedge && <p className="deformity-caution" role="note" data-testid="deformity-wedge-mismatch">
          {t(selectedSim.wedge === 'opening' ? 'deformity.wedgeIsOpening' : 'deformity.wedgeIsClosing')}</p>}
        {selectedSim && view.simulation && <p className="deformity-fit" data-testid="deformity-wedge" data-wedge={selectedSim.wedgeHeight}>
          {t('deformity.wedgeHeight', { height: selectedSim.wedgeHeight.toFixed(1), unit: leg.unit })}
          {view.simulation.lengthChange !== null ? ` · ${t('deformity.lengthChange', { change: `${view.simulation.lengthChange >= 0 ? '+' : ''}${view.simulation.lengthChange.toFixed(1)}`, unit: leg.unit })}` : ''}
          {leg.unit === 'mm' && tag ? ` · ${tag}` : ''}</p>}
        {selectedRule && <p className="deformity-fit" data-testid="deformity-rule" data-rule={selectedRule.rule} data-translation={selectedRule.translation}>{t('deformity.rule', { rule: selectedRule.rule })}{selectedRule.rule === 3 ? ` · ${t('deformity.ruleTranslation', { offset: selectedRule.offset.toFixed(1), translation: selectedRule.translation.toFixed(1), unit: leg.unit })}` : ''}
          {unchecked.has(CORA_KEY[osteotomy.bone]) && <span className="deformity-caution" data-unchecked-value> · {t('deformity.uncheckedShort')}</span>}</p>}
        {cuts.length > 1 && view.simulation && <table className="deformity-values deformity-cut-summary" data-testid="deformity-cut-summary">
          <thead><tr><th scope="col">{t('deformity.cutSummary')}</th><th scope="col">{t('deformity.angle')}</th><th scope="col">{t('deformity.wedge')}</th></tr></thead>
          <tbody>{view.simulation.cuts.map((cutSim, orderPos) => {
            const o = cutSim.osteotomy, cutRule = view.rules[cutSim.index];
            return <tr key={o.id ?? cutSim.index} data-cut-index={cutSim.index} className={cutSim.index === selectedCut ? 'is-selected' : ''}>
              <th scope="row">{`${orderPos + 1}. ${t(`deformity.bone.${o.bone}` as MessageKey)}`}</th>
              <td>{`${o.degrees.toFixed(1)}° ${t(o.direction === 'valgus' ? 'deformity.valgus' : 'deformity.varus')}`}</td>
              <td>{`${cutSim.wedgeHeight.toFixed(1)} ${leg.unit}${cutRule ? ` · R${cutRule.rule}` : ''}`}</td>
            </tr>;
          })}</tbody>
        </table>}
        {view.simulation && after && <table className="deformity-values deformity-compare" data-testid="deformity-planned">
          <thead><tr><th scope="col" /><th scope="col">{t('deformity.before')}</th><th scope="col">{t('deformity.after')}</th></tr></thead>
          <tbody>{(['mLDFA', 'MPTA', 'LDTA', 'JLCA', 'HKA', 'MAD', 'WBL', 'limbLength'] as const).map(name => <tr key={name} data-value-key={name} data-value={after[name].value ?? undefined}
            className={after[name].verdict && after[name].verdict !== 'normal' ? 'is-out' : ''}>
            <th scope="row">{NAMED[name] ? t(NAMED[name]) : name}</th>
            {[leg.values[name], after[name]].map((value, index) => <td key={index}>{valueText(value, '', t)}
              {plateauInboard && name === 'WBL' && value.value !== null && <span className="deformity-caution"> · {t('deformity.plateauInboardShort')}</span>}
              {unchecked.has(name) && value.value !== null && <span className="deformity-caution" data-unchecked-value> · {t('deformity.uncheckedShort')}</span>}</td>)}</tr>)}</tbody>
        </table>}
        {cuts.length < MAX_OSTEOTOMIES && <div className="deformity-add-cut">
          <div className="deformity-segments" role="radiogroup" aria-label={t('deformity.bone')}>{(['femur', 'tibia'] as const).map(name => <button key={name} type="button" role="radio" data-action="deformity-cut-bone"
            aria-checked={bone === name} className="secondary-button compact" onClick={() => setBone(name)}>{t(`deformity.bone.${name}` as MessageKey)}</button>)}</div>
          <button type="button" className="secondary-button compact" data-action="deformity-cut-add" disabled={!canPlaceCut(bone)}
            onClick={() => { deformity.setEditCutout(false); deformity.setPlacing({ film: key, kind: 'cut', bone }); }}>{t('deformity.addCut')}</button>
          {canPlaceAtCora(bone) && <button type="button" className="secondary-button compact" data-action="deformity-cut-cora" data-bone={bone}
            onClick={() => placeAtCora(bone)}>{t('deformity.placeAtCora')}</button>}
        </div>}
        {placing?.kind === 'cut' && <p className="deformity-hint" role="status">{t('deformity.cutHint')}</p>}
        <div className="deformity-actions"><button type="button" className="text-button" data-action="deformity-cut-remove" onClick={() => {
          if (placing?.kind === 'lasso') deformity.setPlacing(null);
          if (cuts.length <= 1) deformity.setEditCutout(false);
          change(current => removeOsteotomy(current, selectedCut));
        }}>{t('deformity.removeCut')}</button></div>
      </div>}
    </div>
    <p className="deformity-status" role="status" data-testid="deformity-status">{status ?? t(film.sopInstanceUid ? 'deformity.saveHelp' : 'deformity.noFilmIdentity')}</p>
    <footer>
      <button type="button" className="icon-button" data-action="deformity-undo" aria-label={t('deformity.undo')} data-tooltip={t('deformity.undo')} disabled={!history[0]} onClick={() => onUndo(false)}><Undo2 size={16} /></button>
      <button type="button" className="icon-button" data-action="deformity-redo" aria-label={t('deformity.redo')} data-tooltip={t('deformity.redo')} disabled={!history[1]} onClick={() => onUndo(true)}><Redo2 size={16} /></button>
      <span className="deformity-spacer" />
      <button type="button" className="secondary-button compact" data-action="deformity-open" disabled={busy || !film.sopInstanceUid} onClick={() => fileInput.current?.click()}><FolderOpen size={14} />{t('deformity.open')}</button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden data-action="deformity-open-file" onChange={event => void openFile(event)} />
      <button type="button" className="secondary-button compact" data-action="deformity-save" disabled={busy || !film.sopInstanceUid} onClick={() => void saveFile()}><Download size={14} />{t('deformity.save')}</button>
      <button type="button" className={labelling ? 'secondary-button compact' : 'primary-button compact'} data-action="deformity-report" disabled={busy} onClick={() => void report()}><Images size={14} />{t('deformity.report')}</button>
    </footer>
  </section>;
}

/** Thrown when the pane or the plan changed while the report's pictures were drawn. */
const REPORT_CHANGED = new Error('The film or the plan changed while the report was drawn.');

function coraText(view: PlanView, bone: 'femur' | 'tibia', t: Translator): string {
  const cora = view.cora[bone], leg = view.leg;
  // No CORA: say what the plan lacks, and that the axes are parallel only when nothing is missing.
  if (!cora) return missingText(coraNeeds(leg, view.lateral, bone), t) || t('deformity.cora.none');
  // Under 1.5° the axes' angle is within the joints' normal variation (normals.ts).
  if (cora.magnitude < 1.5) return t('deformity.cora.small', { angle: cora.magnitude.toFixed(1) });
  const length = bone === 'femur' ? leg.values.femurLength.value : leg.values.tibiaLength.value;
  if (length === null) return t('deformity.needsLandmarks');
  if (!(cora.level >= 0 && cora.level <= 1)) return t('deformity.cora.outside', { angle: cora.magnitude.toFixed(1) });
  return t(bone === 'femur' ? 'deformity.cora.belowHip' : 'deformity.cora.belowKnee', { angle: cora.magnitude.toFixed(1), distance: (cora.level * length).toFixed(0), unit: leg.unit });
}

export default DeformityPanel;
