import { studyKey } from '../domain/patient';
import { useEffect, useRef, useState } from 'react';
import { ClipboardCopy, Info, X } from './icons';
import type { Annotation, Volume } from '../model';
import { annotationSourceIndex } from '../imaging/annotations';
import {
  CLINICAL_CACHE_BYTES, CLINICAL_COPY_CHUNK_BYTES, FEATURES, ROLE_NAMES, assessmentSummary, candidateName, candidates, featureName, inferStudySequences, measureStudy,
  radiopaedia, rank, referenceTissue, regions, sameRoiSlice, searchRegions, sampleMethod, source, word, words,
  type Feature, type Findings, type Measurement, type Patient, type RoiMark, type SequenceChoice, type SequenceRole,
} from '../domain/clinical';
import type { ClinicalVolumeDescriptor, ClinicalWorkerRequest, ClinicalWorkerResult } from '../domain/clinical.worker';
import { errorMessage } from '../i18n';
import { useTranslation } from '../i18n/react';
import { focusOnMount } from '../ui/navigation';
import { usage } from '../usage/tracker';

export interface AssessmentPanelProps {
  volumes: Volume[];
  annotations: Record<string, Annotation[]>;
  onClose: () => void;
  activeSeriesId?: string;
  onRequestRoi?: () => void;
  onFinishRoi?: () => void;
  /** Behind the inspector: the panel stays mounted with its input, but takes no ROIs and keeps its study. */
  hidden?: boolean;
}
const choices: Record<Feature, string[]> = {
  t1: ['hipo', 'izo', 'hiper'], t2: ['hipo', 'izo', 'hiper'], kontrast: ['yok', 'var', 'belirgin'],
  dwi: ['kisitli', 'kisitsiz'], yayilim: ['ekspansil', 'infiltratif'],
};
const roles = Object.keys(ROLE_NAMES) as SequenceRole[];
const roiKey = (seriesId: string, id: string) => `${seriesId}:${id}`;
type Opinion = { id: symbol; summary: string; pending: boolean; reply?: string; error?: string };

export function AssessmentPanel({ volumes, annotations, onClose, activeSeriesId, onRequestRoi, onFinishRoi, hidden = false }: AssessmentPanelProps) {
  const { locale, t } = useTranslation();
  const mrVolumes = volumes.filter(v => v.series.modality.toUpperCase() === 'MR' && v.series.components !== 3);
  const studies = [...new Map(mrVolumes.map(v => [studyKey(v.series), v.series])).values()];
  const [study, setStudy] = useState('');
  const initialStudy = mrVolumes.find(v => v.series.id === activeSeriesId)?.series ?? studies[0];
  const activeStudy = studies.some(s => studyKey(s) === study) ? study : initialStudy && studyKey(initialStudy);
  // Keep the study selected when the inspector covers this panel.
  if (hidden && !study && activeStudy) setStudy(activeStudy);
  const activeVolumes = mrVolumes.filter(v => studyKey(v.series) === activeStudy);
  const [region, setRegion] = useState('');
  const [regionSearch, setRegionSearch] = useState('');
  const [regionSearching, setRegionSearching] = useState(false);
  const [regionOptionIndex, setRegionOptionIndex] = useState(0);
  const [waitingForRoi, setWaitingForRoi] = useState<{ kind: RoiMark['kind']; before: Set<string>; seriesId?: string } | null>(null);
  const [age, setAge] = useState<string | null>(null);
  const [sex, setSex] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<Record<string, { kind: RoiMark['kind']; order: number }>>({});
  const [sequenceOverrides, setSequenceOverrides] = useState<Record<string, SequenceChoice>>({});
  const [overrides, setOverrides] = useState<Partial<Record<Feature, string>>>({});
  const [note, setNote] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const [externalError, setExternalError] = useState('');
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiModel, setAiModel] = useState('claude-opus-5-5');
  const [apiKey, setApiKey] = useState('');
  const [configBusy, setConfigBusy] = useState(false);
  const [configError, setConfigError] = useState('');
  const [opinion, setOpinion] = useState<Opinion | null>(null);
  const aiBusy = Boolean(opinion?.pending), aiReply = opinion?.reply, aiError = configError || opinion?.error;
  const [contextStudy, setContextStudy] = useState(activeStudy);
  // What was typed belongs to a study: it goes when another study is assessed, not while this one's volumes are
  // briefly gone (a re-import reloads them).
  if (activeStudy !== undefined && contextStudy !== activeStudy) {
    setContextStudy(activeStudy); setAge(null); setSex(null); setOverrides({}); setAssignments({});
    setNote(''); setShowSummary(false); setCopyStatus(''); setOpinion(null); setConfigError('');
  }
  useEffect(() => {
    let live = true;
    if (window.veacom?.getAiConfig) window.veacom.getAiConfig().then(config => {
      if (live) { setAiEnabled(config.enabled); setAiConfigured(config.configured); setAiModel(config.model); }
    }).catch(error => { if (live) setConfigError(errorMessage(error)); });
    return () => { live = false; };
  }, []);
  const background = useRef<Worker | null>(null);
  const volumeVersions = useRef(new WeakMap<Volume['data'], number>());
  const nextVolumeVersion = useRef(1);
  const failedMeasurement = useRef<number | null>(null);
  const workerUnavailable = useRef(false);
  const workerReplies = useRef(new Map<string, { resolve: (reply: ClinicalWorkerResult) => void; reject: (error: Error) => void }>());
  const latestMeasurement = useRef<{ id: number; query: object } | null>(null);
  // The panel's own state changed: actions here are not reported as changing nothing (src/usage).
  useEffect(() => { usage.touch('panel'); }, [study, region, regionSearch, regionSearching, regionOptionIndex, waitingForRoi, age, sex, assignments, sequenceOverrides, overrides, note, showSummary, copyStatus, aiModel, apiKey, aiReply]);
  const [completedMeasurement, setCompletedMeasurement] = useState<{ query: object; value: Measurement } | null>(null);
  useEffect(() => {
    const worker = new Worker(new URL('../domain/clinical.worker.ts', import.meta.url), { type: 'module' });
    background.current = worker; workerUnavailable.current = false;
    worker.onmessage = ({ data }: MessageEvent<ClinicalWorkerResult>) => {
      const latest = latestMeasurement.current;
      if (data.type === 'error') {
        if (latest?.id === data.id) failedMeasurement.current = data.id;
        for (const [key, waiting] of workerReplies.current) if (key.startsWith(`${data.id}:`)) { waiting.reject(new Error(data.message)); workerReplies.current.delete(key); }
        if (latest?.id === data.id) setCompletedMeasurement({ query: latest.query, value: { readings: [], findings: {}, blockers: [], diffusionReason: '', warnings: [t('assessment.measurementUnavailable', { error: data.message })] } });
      } else if (data.type === 'result') {
        if (latest?.id === data.id) setCompletedMeasurement({ query: latest.query, value: data.measurement });
      } else {
        const key = `${data.id}:${data.type}:${data.type === 'received' ? `${data.seriesId}:${data.offset}` : data.type === 'committed' ? data.seriesId : ''}`;
        workerReplies.current.get(key)?.resolve(data); workerReplies.current.delete(key);
      }
    };
    worker.onerror = () => {
      workerUnavailable.current = true;
      failedMeasurement.current = latestMeasurement.current?.id ?? null;
      for (const waiting of workerReplies.current.values()) waiting.reject(new Error(t('assessment.backgroundFailed')));
      workerReplies.current.clear();
      const latest = latestMeasurement.current;
      if (latest) setCompletedMeasurement({ query: latest.query, value: { readings: [], findings: {}, blockers: [], diffusionReason: '', warnings: [t('assessment.backgroundFailed')] } });
    };
    return () => {
      worker.terminate(); background.current = null;
      for (const waiting of workerReplies.current.values()) waiting.reject(new Error(t('assessment.cancelled')));
      workerReplies.current.clear();
    };
  }, []);
  const first = activeVolumes[0]?.series;
  const shownAge = age ?? (first?.patientAge === undefined ? '' : String(first.patientAge));
  const shownSex = sex ?? (first?.patientSex === 'M' ? 'E' : first?.patientSex === 'F' ? 'K' : '');
  const patient: Patient = { age: shownAge.trim() && Number.isFinite(Number(shownAge)) && Number(shownAge) >= 0 ? Number(shownAge) : null,
    sex: shownSex === 'E' || shownSex === 'K' ? shownSex : null };
  const roiOptions = activeVolumes.flatMap(v => (annotations[v.series.id] ?? [])
    .filter(a => ['ellipse', 'rectangle', 'polygon'].includes(a.type) && a.points.length >= 3)
    .map((annotation, index) => ({ annotation, series: v.series, key: roiKey(v.series.id, annotation.id),
      title: annotation.label || t('assessment.roiTitle', { type: t(`assessment.roiType.${annotation.type as 'ellipse' | 'rectangle' | 'polygon'}` as const), number: index + 1 }),
      sourceIndex: annotationSourceIndex(annotation, v.series) })));
  const inferred = inferStudySequences(activeVolumes.map(volume => volume.series), t);
  const sequences = Object.fromEntries(activeVolumes.map(v => [v.series.id, sequenceOverrides[v.series.id] ?? inferred[v.series.id]]));
  const assignedRois = roiOptions.filter(roi => assignments[roi.key]);
  const marks = roiOptions.flatMap(roi => assignments[roi.key]
    ? [{ annotation: roi.annotation, seriesId: roi.series.id, ...assignments[roi.key] }] : []);
  const measurementQuery = { activeVolumes, marks, sequences, locale };
  const emptyMeasurement = measureStudy(activeVolumes, [], sequences, t);
  const measurement = completedMeasurement?.query === measurementQuery ? completedMeasurement.value : emptyMeasurement;
  const measurementPending = marks.length > 0 && completedMeasurement?.query !== measurementQuery;
  useEffect(() => {
    const worker = background.current;
    if (!worker || workerUnavailable.current) {
      setCompletedMeasurement({ query: measurementQuery, value: { ...emptyMeasurement, warnings: [t('assessment.backgroundFailed')] } });
      return;
    }
    const id = (latestMeasurement.current?.id ?? 0) + 1;
    latestMeasurement.current = { id, query: measurementQuery };
    failedMeasurement.current = null;
    let cancelled = false;
    const waitFor = (type: 'ready' | 'committed' | 'received', seriesId = '') => new Promise<ClinicalWorkerResult>((resolve, reject) => {
      workerReplies.current.set(`${id}:${type}:${seriesId}`, { resolve, reject });
    });
    const post = (request: ClinicalWorkerRequest, transfer: Transferable[] = []) => worker.postMessage(request, transfer);
    const descriptors: ClinicalVolumeDescriptor[] = activeVolumes.map(volume => {
      let version = volumeVersions.current.get(volume.data);
      if (!version) { version = nextVolumeVersion.current++; volumeVersions.current.set(volume.data, version); }
      const data = volume.data;
      const pixelType = data instanceof Float64Array ? 'float64' : data instanceof Float32Array ? 'float32' : data instanceof Int16Array ? 'int16' : data instanceof Uint16Array ? 'uint16' : 'uint8';
      return { series: volume.series, version, pixelType, byteLength: data.byteLength, sourceFrameIndex: volume.sourceFrameIndex };
    });
    const bytes = descriptors.reduce((sum, descriptor) => sum + descriptor.byteLength, 0);
    if (!marks.length || bytes > CLINICAL_CACHE_BYTES) {
      post({ type: 'begin', id, volumes: [] });
      setCompletedMeasurement({ query: measurementQuery, value: bytes > CLINICAL_CACHE_BYTES
        ? { ...emptyMeasurement, warnings: [t('assessment.studyTooLarge')] } : emptyMeasurement });
      return;
    }
    async function uploadAndMeasure() {
      const ready = waitFor('ready');
      post({ type: 'begin', id, volumes: descriptors, locale });
      const reply = await ready;
      if (cancelled || failedMeasurement.current === id || reply.type !== 'ready') return;
      for (const seriesId of reply.missing) {
        if (cancelled || failedMeasurement.current === id) return;
        const volume = activeVolumes.find(v => v.series.id === seriesId)!;
        post({ type: 'start', id, seriesId });
        for (let offset = 0; offset < volume.data.byteLength; offset += CLINICAL_COPY_CHUNK_BYTES) {
          if (cancelled || failedMeasurement.current === id) return;
          const count = Math.min(CLINICAL_COPY_CHUNK_BYTES, volume.data.byteLength - offset);
          // Copy bounded pieces, transfer only those copies, then yield so input and painting can run.
          const copy = new Uint8Array(count);
          copy.set(new Uint8Array(volume.data.buffer, volume.data.byteOffset + offset, count));
          const received = waitFor('received', `${seriesId}:${offset + count}`);
          post({ type: 'chunk', id, seriesId, offset, bytes: copy.buffer }, [copy.buffer]);
          await received;
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        if (cancelled || failedMeasurement.current === id) return;
        const committed = waitFor('committed', seriesId);
        post({ type: 'commit', id, seriesId });
        await committed;
      }
      if (!cancelled && failedMeasurement.current !== id) post({ type: 'measure', id, marks, sequences, locale });
    }
    void uploadAndMeasure().catch(error => {
      if (!cancelled) setCompletedMeasurement({ query: measurementQuery, value: { ...emptyMeasurement, warnings: [t('assessment.measurementUnavailable', { error: errorMessage(error) })] } });
    });
    return () => {
      cancelled = true;
      post({ type: 'cancel', id });
      for (const [key, waiting] of workerReplies.current) if (key.startsWith(`${id}:`)) { waiting.reject(new Error(t('assessment.cancelled'))); workerReplies.current.delete(key); }
    };
  }, [measurementQuery, activeVolumes, marks, sequences, emptyMeasurement, locale]);
  const found: Findings = {};
  for (const feature of FEATURES) found[feature] = overrides[feature] === 'unknown' ? null : overrides[feature] || measurement.findings[feature] || null;
  const available = candidates(region);
  const matchingRegions = [...(!regionSearch ? [{ id: '', name: t('assessment.allRegions') }] : []), ...searchRegions(regionSearch)];
  const ranking = rank(found, available, patient);
  const results = measurement.blockers.length ? [] : ranking.ranked;
  const hasFindings = FEATURES.some(f => found[f]);
  const latestLesion = [...marks].filter(mark => mark.kind === 'lesion').sort((a, b) => b.order - a.order)[0];
  const lesionSlices = new Set(marks.filter(mark => mark.kind === 'lesion' && mark.seriesId === latestLesion?.seriesId).map(mark => `${mark.annotation.plane}:${mark.annotation.slice}:${mark.annotation.oblique?.join(',') ?? '0,0'}`)).size;
  const summary = assessmentSummary({ region, patient, findings: found, measurement, ranked: results, note, manualFeatures: FEATURES.filter(f => Boolean(overrides[f])), lesionSlices });
  const assign = (key: string, value: string) => setAssignments(current => {
    const next = { ...current };
    if (!value) delete next[key];
    else {
      const target = roiOptions.find(roi => roi.key === key);
      for (const roi of roiOptions) if (target && roi.series.id === target.series.id && sameRoiSlice(roi.annotation, target.annotation, target.series) && next[roi.key]?.kind === value) delete next[roi.key];
      next[key] = { kind: value as RoiMark['kind'], order: Math.max(0, ...Object.values(current).map(m => m.order)) + 1 };
    }
    return next;
  });
  useEffect(() => {
    if (!waitingForRoi) return;
    if (!hidden) {
      const added = roiOptions.find(roi => !waitingForRoi.before.has(roi.key) && (!waitingForRoi.seriesId || roi.series.id === waitingForRoi.seriesId));
      if (!added) return;
      assign(added.key, waitingForRoi.kind);
    }
    setWaitingForRoi(null); onFinishRoi?.();
  }, [roiOptions, waitingForRoi, onFinishRoi, hidden, assign]);
  const beginRoi = (kind: RoiMark['kind']) => {
    if (waitingForRoi?.kind === kind) { setWaitingForRoi(null); onFinishRoi?.(); return; }
    const active = mrVolumes.find(volume => volume.series.id === activeSeriesId);
    if (active) setStudy(studyKey(active.series));
    setWaitingForRoi({ kind, before: new Set(Object.entries(annotations).flatMap(([seriesId, items]) => items.map(item => roiKey(seriesId, item.id)))), seriesId: activeSeriesId });
    onRequestRoi?.();
  };
  const selectStudy = (value: string) => {
    setWaitingForRoi(null); onFinishRoi?.();
    setStudy(value);
  };
  const setSequence = (id: string, change: Partial<SequenceChoice>) => setSequenceOverrides(current => ({ ...current,
    [id]: { ...sequences[id], ...change, basis: t('assessment.clinicianSelected') } }));
  async function copySummary(openClaude = false) {
    try { await navigator.clipboard.writeText(summary); setCopyStatus(t('assessment.copied')); }
    catch { setCopyStatus(t('assessment.clipboardUnavailable')); return; }
    if (openClaude && window.veacom?.openExternal) {
      try { await window.veacom.openExternal('https://claude.ai/new'); setCopyStatus(t('assessment.copiedPaste')); }
      catch (error) { setCopyStatus(t('assessment.copiedNoClaude', { error: errorMessage(error) })); }
    }
  }
  function openSource(event: { preventDefault(): void }, url: string) {
    if (!window.veacom?.openExternal) return;
    event.preventDefault(); setExternalError(''); usage.touch('panel');
    window.veacom.openExternal(url).catch(error => setExternalError(errorMessage(error)));
  }

  async function configureAi(forget = false) {
    if (!window.veacom?.configureAi) return;
    setConfigBusy(true); setConfigError('');
    setOpinion(current => current?.error ? null : current);
    const options = { model: aiModel.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), forget };
    try {
      await window.veacom.configureAi(options);
      setApiKey('');
      const config = await window.veacom.getAiConfig();
      setAiConfigured(config.configured); setAiModel(config.model);
    } catch (error) { setConfigError(errorMessage(error)); }
    setConfigBusy(false);
  }
  async function askAi() {
    if (!window.veacom?.askSecondOpinion || !aiConfigured) return;
    const id = Symbol();
    setConfigError(''); setOpinion({ id, summary, pending: true });
    const finish = (result: { reply: string } | { error: string }) =>
      setOpinion(current => current?.id === id ? { ...current, ...result, pending: false } : current);
    try {
      const reply = await window.veacom.askSecondOpinion({ summary });
      finish({ reply });
    } catch (error) {
      finish({ error: errorMessage(error) });
    }
  }

  return <aside className="assessment-panel" aria-label={t('assessment.label')} data-testid="assessment-panel">
    <style>{styles}</style>
    <header className="assessment-heading"><div><span className="assessment-kicker">{t('assessment.kicker')}</span><h2 ref={focusOnMount} tabIndex={-1}>{t('assessment.title')}</h2></div>
      <button type="button" className="assessment-icon" data-testid="assessment-close" onClick={onClose} aria-label={t('assessment.close')}><X size={18} /></button></header>
    <p className="assessment-intro">{t('assessment.intro')}</p>
    {!activeVolumes.length ? <p className="assessment-empty">{t('assessment.noMr')}</p> : null}
    {studies.length > 1 && <label className="assessment-field">{t('assessment.study')}<select data-action="assessment-study" value={activeStudy} onChange={e => selectStudy(e.target.value)}>
      {studies.map(s => <option key={studyKey(s)} value={studyKey(s)}>{s.patientName || s.patientId || t('assessment.unnamedPatient')} · {s.studyDate || t('assessment.undatedStudy')}</option>)}
    </select></label>}
    <section className="assessment-section">
      <div className="assessment-region-picker"><label className="assessment-field">{t('assessment.region')}<input role="combobox" data-testid="assessment-region" aria-expanded={regionSearching} aria-controls="assessment-region-options" aria-activedescendant={regionSearching && matchingRegions.length ? `assessment-region-${Math.min(regionOptionIndex, matchingRegions.length - 1)}` : undefined} value={regionSearching ? regionSearch : regions.find(r => r.id === region)?.name ?? t('assessment.allRegions')} onFocus={() => { setRegionSearch(''); setRegionOptionIndex(0); setRegionSearching(true); }} onChange={e => { setRegionSearch(e.target.value); setRegionOptionIndex(0); }} onBlur={() => setRegionSearching(false)} onKeyDown={e => {
        if (e.key === 'Escape') { setRegionSearching(false); e.stopPropagation(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setRegionSearching(true); setRegionOptionIndex(i => Math.max(0, Math.min(matchingRegions.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))); }
        if (e.key === 'Enter' && regionSearching && matchingRegions.length) { e.preventDefault(); setRegion(matchingRegions[Math.min(regionOptionIndex, matchingRegions.length - 1)].id); setRegionSearching(false); }
      }} placeholder={t('assessment.regionPlaceholder')} /></label>
      {regionSearching && <div id="assessment-region-options" className="assessment-region-options" role="listbox">
        {matchingRegions.map((r, index) => <button id={`assessment-region-${index}`} data-action="assessment-region-option" type="button" role="option" aria-selected={regionOptionIndex === index} key={r.id} tabIndex={-1} onMouseDown={e => e.preventDefault()} onClick={() => { setRegion(r.id); setRegionSearching(false); }}>{r.name}</button>)}
        {matchingRegions.length === 0 && <p className="assessment-help">{t('assessment.noRegion')}</p>}
      </div>}</div>
      <div className="assessment-columns"><label className="assessment-field">{t('assessment.age')}<input type="number" data-action="assessment-age" min="0" max="130" step="any" value={shownAge} placeholder={t('assessment.unknown')} onChange={e => setAge(e.target.value)} /></label>
        <label className="assessment-field">{t('assessment.sex')}<select data-action="assessment-sex" value={shownSex} onChange={e => setSex(e.target.value)}><option value="">{t('assessment.unknown')}</option><option value="E">{t('assessment.male')}</option><option value="K">{t('assessment.female')}</option></select></label></div>
      <p className="assessment-help">{t('assessment.referenceHelp', { tissue: referenceTissue(region) })}</p>
    </section>
    <section className="assessment-section">
      <h3>{t('assessment.roisHeading')}</h3>
      {onRequestRoi && <div className="assessment-ai-actions"><button type="button" className="assessment-button" data-testid="assessment-mark-lesion" aria-pressed={waitingForRoi?.kind === 'lesion'} disabled={!activeVolumes.length} onClick={() => beginRoi('lesion')}>{t('assessment.markLesion')}</button><button type="button" className="assessment-button" data-testid="assessment-mark-reference" aria-pressed={waitingForRoi?.kind === 'reference'} disabled={!activeVolumes.length} onClick={() => beginRoi('reference')}>{t('assessment.markReference')}</button></div>}
      {waitingForRoi && <p className="assessment-notice">{waitingForRoi.kind === 'lesion' ? t('assessment.drawLesion') : t('assessment.drawReference', { tissue: referenceTissue(region) })}</p>}
      {measurementPending && <p className="assessment-help" role="status">{t('assessment.reading')}</p>}
      <p className="assessment-help">{t('assessment.roiHelp')}</p>
      {/* Only the regions used as lesion or reference: other measurements would crowd the list. */}
      {assignedRois.length ? <div className="assessment-rois">{assignedRois.map(roi => <div className="assessment-roi" key={roi.key}>
        <div><strong>{roi.title}</strong><small>{roi.series.description || t('assessment.seriesNumber', { number: roi.series.seriesNumber })} · {roi.annotation.mode === 'source' ? roi.sourceIndex === null ? t('assessment.sourceUnavailable') : `${t('assessment.imageNumber', { number: roi.series.frameMetadata?.[roi.sourceIndex]?.instanceNumber ?? roi.sourceIndex + 1 })}${roi.series.frameMetadata?.[roi.sourceIndex]?.sourceFrameNumber ? t('assessment.frameNumber', { number: roi.series.frameMetadata[roi.sourceIndex].sourceFrameNumber! }) : ''}` : `${t(`planeLower.${roi.annotation.plane}` as const)} ${roi.annotation.slice + 1}`}</small></div>
        <select data-action="assessment-roi-use" aria-label={t('assessment.useAs', { title: roi.title })} value={assignments[roi.key]?.kind ?? ''} onChange={e => assign(roi.key, e.target.value)}>
          <option value="">{t('assessment.unused')}</option><option value="lesion">{t('assessment.lesion')}</option><option value="reference">{t('assessment.reference')}</option></select>
      </div>)}</div> : <p className="assessment-empty">{t('assessment.noRois')}</p>}
      <details className="assessment-details"><summary data-testid="assessment-sequence-settings" data-loaded-count={activeVolumes.length}>{t('assessment.sequenceSettings', { count: activeVolumes.length })}</summary>
        <p className="assessment-help">{t('assessment.sequenceHelp')}</p>
        {activeVolumes.map(v => <div className="assessment-sequence" key={v.series.id}>
          <div className="assessment-sequence-title">{v.series.description || t('assessment.seriesNumber', { number: v.series.seriesNumber })}<small>{sequences[v.series.id].basis}</small></div>
          <select aria-label={t('assessment.sequenceRole', { number: v.series.seriesNumber })} data-testid="assessment-sequence-role" data-series-number={v.series.seriesNumber} value={sequences[v.series.id].role ?? ''} onChange={e => setSequence(v.series.id, { role: (e.target.value || null) as SequenceRole | null })}>
            <option value="">{t('assessment.excluded')}</option>{roles.map(role => <option value={role} key={role}>{ROLE_NAMES[role]}</option>)}
          </select>
          {sequences[v.series.id].role === 'dwi' && <label className="assessment-field">{t('assessment.bValue')}<input type="number" data-action="assessment-b-value" min="0" value={sequences[v.series.id].bValue ?? ''} placeholder={t('assessment.unknown')} onChange={e => setSequence(v.series.id, { bValue: e.target.value === '' ? null : Number(e.target.value) })} /></label>}
        </div>)}
      </details>
      {measurement.readings.length > 0 && <details className="assessment-details"><summary data-testid="assessment-measured-signal">{t('assessment.measuredSignal')}</summary>
        <div className="assessment-table-scroll"><table><thead><tr><th>{t('assessment.sequence')}</th><th>{t('assessment.lesion')}</th><th>{t('assessment.reference')}</th><th>{t('assessment.ratio')}</th></tr></thead><tbody>
          {measurement.readings.map(r => <tr key={r.seriesId} title={[r.issue, r.lesion && t('assessment.sampleTitle', { label: t('assessment.lesion'), method: sampleMethod(r.lesion), count: r.lesion.voxels, sd: r.lesion.std.toFixed(3), min: r.lesion.min, max: r.lesion.max }), r.reference && t('assessment.sampleTitle', { label: t('assessment.reference'), method: sampleMethod(r.reference), count: r.reference.voxels, sd: r.reference.std.toFixed(3), min: r.reference.min, max: r.reference.max })].filter(Boolean).join(" · ")}>
            <th>{ROLE_NAMES[r.role]}<small>#{activeVolumes.find(v => v.series.id === r.seriesId)?.series.seriesNumber}{r.bValue === null ? '' : ` · b${r.bValue}`}</small></th>
            <td>{r.lesion?.mean.toFixed(1) ?? '—'}{r.lesion && <small>{r.lesion.sampling === 'source-voxels' ? t('assessment.source') : t('assessment.resampled')} · n {r.lesion.voxels}</small>}</td><td>{r.reference?.mean.toFixed(1) ?? '—'}{r.reference && <small>{r.reference.sampling === 'source-voxels' ? t('assessment.source') : t('assessment.resampled')} · n {r.reference.voxels}</small>}</td><td>{r.ratio === null ? '—' : `×${r.ratio.toFixed(2)}`}</td></tr>)}
        </tbody></table></div>
        <p className="assessment-help">{t('assessment.samplingHelp')}</p>
      </details>}
    </section>
    <section className="assessment-section">
      <h3>{t('assessment.findings')}</h3>
      {FEATURES.map(feature => <label className="assessment-finding" key={feature}><span>{featureName(feature)}</span>
        <select data-action="assessment-feature" value={overrides[feature] ?? ''} onChange={e => setOverrides(current => ({ ...current, [feature]: e.target.value }))}>
          <option value="">{feature === 'yayilim' ? t('assessment.notAssessed') : t('assessment.auto', { value: measurement.findings[feature] ? words(measurement.findings[feature]) : t('assessment.unknownValue') })}</option>
          <option value="unknown">{t('assessment.leaveUnknown')}</option>{choices[feature].map(choice => <option key={choice} value={choice}>{t('assessment.manual', { value: word(choice) })}</option>)}
        </select></label>)}
      <p className="assessment-help">{t('assessment.growthHelp')}</p>
      {measurement.diffusionReason && <p className="assessment-help">{measurement.diffusionReason}</p>}
      {found.t1 === 'hiper' && overrides.kontrast && overrides.kontrast !== 'unknown' && <p className="assessment-notice">{t('assessment.t1Caution')}</p>}
      {measurement.warnings.map(message => <p className="assessment-notice" key={message}>{message}</p>)}
      {measurement.blockers.map(message => <p className="assessment-warning" role="alert" key={message}>{message}</p>)}
    </section>
    <section className="assessment-section">
      <div className="assessment-results-heading"><h3>{t('assessment.ranked')}</h3><span>{t('assessment.matchHeading')}</span></div>
      <p className="assessment-help">{t('assessment.rankHelp')}</p>
      {!hasFindings ? <p className="assessment-empty">{t('assessment.noFindings')}</p> : measurement.blockers.length ? <p className="assessment-empty">{t('assessment.paused')}</p> : results.slice(0, 12).map((result, index) => <details className="assessment-result" key={result.candidate.id}>
        <summary><span className="assessment-rank">{index + 1}</span><span className="assessment-result-name">{candidateName(result.candidate)}<small>{t('assessment.compared', { count: result.compared })}{result.candidate.frequency === 'sik' ? t('assessment.common') : ''}</small></span><strong>{(result.match * 100).toFixed(0)}</strong></summary>
        <div className="assessment-result-body"><table><thead><tr><th>{t('assessment.feature')}</th><th>{t('assessment.expected')}</th><th>{t('assessment.found')}</th></tr></thead><tbody>{result.reasons.map((reason, i) => <tr key={i} className={reason.fits ? '' : 'assessment-contradiction'}><th>{reason.feature}</th><td>{reason.expected}</td><td>{reason.fits ? '✓ ' : '≠ '}{reason.found}</td></tr>)}</tbody></table>
          {locale !== 'tr' && result.candidate.englishName && <p className="assessment-help">{result.candidate.name}</p>}
          {result.candidate.finding && <p>{result.candidate.finding}</p>}{result.candidate.ct && <p><b>{t('assessment.ct')}</b>{result.candidate.ct}</p>}
          {result.candidate.differential.length > 0 && <p><b>{t('assessment.consider')}</b>{result.candidate.differential.join('; ')}</p>}
          {result.candidate.cautions.map((text, i) => <p className="assessment-notice" key={i}>{text}</p>)}
          <small>{t('assessment.sourceLabel')}{result.candidate.source ? <a href={result.candidate.source} data-action="assessment-source-link" target="_blank" rel="noreferrer" onClick={event => openSource(event, event.currentTarget.href)}>Radiopaedia</a> : source.kitap}{result.candidate.page === null ? '' : t('assessment.page', { page: result.candidate.page })}</small>
        </div>
      </details>)}
      {hasFindings && ranking.unknown.length > 0 && <details className="assessment-details"><summary>{t('assessment.unknownEntries', { count: ranking.unknown.length })}</summary><p className="assessment-help">{t('assessment.unknownHelp')}</p>{ranking.unknown.map(c => <p key={c.id}>{candidateName(c)}</p>)}</details>}
    </section>
    <section className="assessment-section">
      <h3>{t('assessment.secondOpinion')}</h3><p className="assessment-help">{t('assessment.secondOpinionHelp')}</p>
      <label className="assessment-field">{t('assessment.note')}<textarea data-action="assessment-note" rows={2} data-testid="assessment-note" value={note} onChange={e => setNote(e.target.value)} placeholder={t('assessment.notePlaceholder')} /></label>
      <button type="button" className="assessment-button" data-testid="assessment-preview-summary" onClick={() => { setShowSummary(!showSummary); setCopyStatus(''); }}><Info size={15} />{showSummary ? t('assessment.hideSummary') : t('assessment.previewSummary')}</button>
      {showSummary && <div className="assessment-summary"><textarea aria-label={t('assessment.summaryLabel')} data-testid="assessment-summary" readOnly rows={14} value={summary} /><button type="button" className="assessment-button" data-action="assessment-copy" onClick={() => copySummary()}><ClipboardCopy size={15} />{t('assessment.copy')}</button>{window.veacom?.openExternal && <button type="button" className="assessment-button" data-action="assessment-copy-open" onClick={() => copySummary(true)}>{t('assessment.copyOpen')}</button>}<small role="status">{copyStatus}</small>
        {aiEnabled && window.veacom?.askSecondOpinion && <>
          <details className="assessment-details"><summary>{t('assessment.api', { state: aiConfigured ? t('assessment.keyConfigured') : t('assessment.setupRequired') })}</summary>
            <p className="assessment-help">{t('assessment.keyHelp')}</p>
            <label className="assessment-field">{t('assessment.model')}<input data-action="assessment-ai-model" value={aiModel} onChange={e => setAiModel(e.target.value)} autoComplete="off" /></label>
            <label className="assessment-field">{t('assessment.apiKey')}<input type="password" data-action="assessment-ai-key" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={aiConfigured ? t('assessment.keepKey') : t('assessment.enterKey')} autoComplete="off" /></label>
            <div className="assessment-ai-actions"><button type="button" className="assessment-button" data-action="assessment-ai-save" disabled={configBusy || aiBusy || !aiModel.trim() || (!aiConfigured && !apiKey.trim())} onClick={() => configureAi()}>{configBusy ? t('assessment.saving') : t('assessment.saveSettings')}</button>
              {aiConfigured && <button type="button" className="assessment-button" data-action="assessment-ai-remove" disabled={configBusy || aiBusy} onClick={() => configureAi(true)}>{t('assessment.removeKey')}</button>}</div>
          </details>
          <p className="assessment-help">{t('assessment.sendHelp')}</p>
          <button type="button" className="assessment-button" data-action="assessment-ai-send" disabled={!aiConfigured || aiBusy || configBusy || measurementPending || measurement.blockers.length > 0 || !hasFindings} onClick={askAi}>{aiBusy ? t('assessment.waiting') : t('assessment.send')}</button>
        </>}
        {aiError && <p className="assessment-warning" role="alert">{aiError}</p>}
        {aiReply && <div className="assessment-ai-reply"><h3>{t('assessment.aiReply')}</h3>{opinion.summary !== summary && <p className="assessment-warning">{t('assessment.changed')}</p>}<p className="assessment-help">{t('assessment.reviewReply')}</p><pre>{aiReply}</pre><details className="assessment-details"><summary>{t('assessment.sentText')}</summary><pre>{opinion.summary}</pre></details></div>}
      </div>}
    </section>
    <details className="assessment-details assessment-sources"><summary>{t('assessment.sources')}</summary><p>{source.kitap} · {source.yayinevi}. {source.yazar}. ISBN {source.isbn}.</p><p>{t('assessment.translationNote')}</p>
      {radiopaedia && <p>{radiopaedia.ad} · {radiopaedia.lisans}<br /><a href={radiopaedia.url} data-action="assessment-radiopaedia-link" target="_blank" rel="noreferrer" onClick={event => openSource(event, event.currentTarget.href)}>{t('assessment.sourceDifferential')}</a></p>}
    </details>
    {externalError && <p className="assessment-warning" role="alert">{externalError}</p>}
  </aside>;
}

export default AssessmentPanel;

const styles = `
.assessment-panel{width:420px;max-width:100%;height:100%;overflow-y:auto;background:var(--bg-panel);color:var(--text);border-left:1px solid var(--line);padding:20px;box-sizing:border-box;font:13px/1.5 var(--font-ui)}
.assessment-panel *{box-sizing:border-box}
.assessment-heading,.assessment-results-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}
.assessment-kicker{color:var(--accent);font-size:12px;font-weight:600}
.assessment-panel h2{font-size:18px;line-height:1.3;margin:2px 0 0;font-weight:600;color:var(--text-strong)}
.assessment-panel h3{font-size:14px;margin:0 0 10px;font-weight:600;color:var(--text-strong)}
.assessment-intro{color:var(--text-secondary);margin:12px 0 16px}
.assessment-icon{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--text-secondary)}
.assessment-icon:hover{background:var(--bg-hover);color:var(--text-strong)}
.assessment-section{padding:16px 0;border-top:1px solid var(--line-subtle)}
.assessment-field{display:flex;flex-direction:column;gap:6px;margin:0 0 10px;font-size:12px;color:var(--text-secondary);font-weight:500}
.assessment-panel select,.assessment-panel input,.assessment-panel textarea{width:100%;min-width:0;color:var(--text-strong);border:1px solid var(--line-control);background:var(--bg-input);border-radius:6px;font:inherit;font-size:13px;padding:0 8px;min-height:32px}
.assessment-panel input[type=checkbox]{width:16px;min-height:16px;padding:0}
.assessment-panel textarea{padding:8px;resize:vertical;line-height:1.55}
.assessment-columns{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.assessment-help{font-size:12px;color:var(--text-tertiary);line-height:1.6;margin:8px 0}
.assessment-empty{background:var(--bg-raised);border:1px solid var(--line-subtle);padding:11px 12px;border-radius:6px;color:var(--text-secondary)}
.assessment-rois{display:flex;flex-direction:column;gap:6px}
.assessment-roi{display:grid;grid-template-columns:minmax(0,1fr) 105px;gap:8px;align-items:center;padding:8px;border:1px solid var(--line-subtle);border-radius:6px;background:var(--bg-raised)}
.assessment-roi strong{font-size:12px;color:var(--text-strong)}
.assessment-roi small,.assessment-sequence small,.assessment-result-name small,.assessment-panel th small,.assessment-panel td small{display:block;color:var(--text-tertiary);font-size:12px;font-weight:400}
.assessment-roi small{overflow-wrap:anywhere}
.assessment-details{margin:10px 0}
.assessment-panel summary{cursor:pointer}
.assessment-details>summary{color:var(--text-secondary);font-size:12px;min-height:24px;display:flex;align-items:center;gap:4px}
.assessment-sequence{border-top:1px solid var(--line-subtle);padding:10px 0}
.assessment-sequence-title{margin:0 0 5px;overflow-wrap:anywhere}
.assessment-sequence .assessment-field{margin-top:7px}
.assessment-panel table{width:100%;border-collapse:collapse;font-size:12px}
.assessment-panel td,.assessment-panel th{padding:6px 4px;border-bottom:1px solid var(--line-subtle);text-align:left;font-weight:400}
.assessment-panel thead th{color:var(--text-secondary)}
.assessment-table-scroll{overflow-x:auto}
.assessment-finding{display:grid;grid-template-columns:126px minmax(0,1fr);align-items:center;gap:8px;margin:7px 0;font-size:12px}
.assessment-notice,.assessment-warning{background:var(--warning-bg);border:1px solid var(--warning-line);color:#f3dca8;padding:9px 10px;border-radius:6px;font-size:12px}
.assessment-warning{background:var(--danger-bg);border-color:var(--danger-line);color:#ffd7d4}
.assessment-results-heading span{font-size:12px;color:var(--text-tertiary)}
.assessment-result{border:1px solid var(--line-subtle);border-radius:6px;margin:6px 0;overflow:hidden;background:var(--bg-raised)}
.assessment-result>summary{display:flex;align-items:center;gap:9px;padding:10px;list-style:none}
.assessment-result>summary::-webkit-details-marker{display:none}
.assessment-result>summary:hover{background:var(--bg-hover)}
.assessment-rank{color:var(--text-tertiary);width:14px;font-size:12px}
.assessment-result-name{flex:1;font-size:13px;font-weight:500;color:var(--text-strong)}
.assessment-result>summary>strong{color:var(--accent);font-size:16px;font-variant-numeric:tabular-nums}
.assessment-result-body{padding:0 10px 10px;border-top:1px solid var(--line-subtle);font-size:12px}
.assessment-contradiction{color:var(--warning)}
.assessment-result-body>small{color:var(--text-tertiary)}
.assessment-button{display:inline-flex;gap:7px;align-items:center;min-height:32px;padding:0 12px;border:1px solid var(--line-strong);border-radius:4px;background:var(--bg-raised);color:var(--text);cursor:pointer;font:inherit;font-weight:500}
.assessment-button:hover:enabled{background:var(--bg-hover);border-color:var(--line-control-hover);color:var(--text-strong)}
.assessment-button[aria-pressed=true]{background:var(--accent-solid);border-color:var(--accent-solid);color:var(--on-accent)}
.assessment-button:disabled{color:var(--text-disabled);border-color:var(--line);cursor:default}
.assessment-summary{margin-top:10px}
.assessment-summary>textarea{font-size:12px;margin-bottom:8px}
.assessment-summary>small{display:block;color:var(--success);margin-top:6px}
.assessment-sources{color:var(--text-tertiary);font-size:12px;border-top:1px solid var(--line-subtle);padding-top:13px}
.assessment-region-picker{position:relative}
.assessment-region-options{position:absolute;z-index:2;top:calc(100% + 4px);left:0;right:0;max-height:230px;overflow:auto;background:var(--bg-menu);border:1px solid var(--line-strong);border-radius:8px;padding:4px;box-shadow:var(--shadow-popover)}
.assessment-region-options>button{display:block;text-align:left;width:100%;min-height:32px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:var(--text);font:inherit;cursor:pointer;font-size:13px}
.assessment-region-options>button:hover,.assessment-region-options>button[aria-selected=true]{background:var(--bg-hover);color:var(--text-strong)}
.assessment-panel a{color:var(--accent)}
.assessment-ai-actions{display:flex;gap:7px;flex-wrap:wrap}
.assessment-ai-reply{margin-top:14px}
.assessment-ai-reply pre{font:inherit;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text);background:var(--bg-input);border:1px solid var(--line-subtle);border-radius:6px;padding:12px}
`;
