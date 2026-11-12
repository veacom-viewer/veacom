import { patientKey, studyKey } from '../domain/patient';
import { useEffect, useRef, useState } from 'react';
import { Download, Film, FolderOpen, HardDrive, X } from './icons';
import type { ExportEstimate, Series } from '../model';
import { assertSeriesEngine, bridgeCan } from '../api';
import { exportViewportImages, exportViewportVideo } from '../export-video';
import { errorMessage, type Translator } from '../i18n';
import { useTranslation } from '../i18n/react';
import { warningTexts } from '../i18n/core';
import { usage } from '../usage/tracker';
import { MAX_EXPORT_SERIES } from '../../electron/export-limits.mjs';
import { pickState, togglePicked } from '../ui/exportSelection';
import { phaseLabel } from '../ui/overlayCorners';
import { exportedImages } from '../ui/seriesNames';
import './ExportDialog.css';

// One export window, as VEAcom 1.x's (after RadiAnt's): what to export (DICOM, pictures, video, DICOMDIR), which
// images (the current slice, the current series, every series, or those picked), and where. Everything goes to one
// remembered folder (the Desktop at first) without asking again; the window closes when the export starts and its
// progress shows in the status bar.

export type ExportMode = 'dicom' | 'media' | 'video' | 'images';
export interface ExportDialogProps {
  mode: ExportMode;
  series: Series[];
  activeSeriesId: string;
  /** The pane being exported as pictures or video: its slices are captured as shown. */
  video?: {
    viewport: HTMLElement;
    /** The series the pane shows: a slice drawn from another one stops the export. */
    seriesId?: string;
    originalSlice: number;
    frameCount: number;
    setSlice: (slice: number) => void | Promise<void>;
    /** The series' own pixel size, for 1:1 pictures. */
    nativeSize?: { width: number; height: number };
    /** The pane pages against the slice order (an axial stack stored from the feet up): down the page is a lower index. */
    backwards?: boolean;
    /** What the pane adds to a slice's own number, and the total it shows beside it: a stack paged with its reference
     * image counts that image too (imaging/paging.ts). */
    numberOffset?: number; numberTotal?: number; numbersBackwards?: boolean;
  };
  /** The acquired slice on screen (its file), for "current slice" DICOM. */
  currentFrame?: number;
  onClose: () => void;
  /** The export runs on with the window hidden; the status bar shows it. */
  background?: boolean;
  onBackground?: () => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onProgress?: (done: number, total: number) => void;
  /** Set to a function that stops the export (the status bar's Cancel). */
  cancelRef?: { current: (() => void) | null };
  onComplete: (message: string, warnings?: string[], revealPath?: string) => void;
  onFailed?: (message: string) => void;
  onModeChange?: (mode: ExportMode) => void;
  /** Why a kind cannot be chosen now (pictures and video wait for a series to finish loading). */
  unavailable?: Partial<Record<ExportMode, string>>;
  /** Every pane on screen as one picture. */
  onPicture?: (format: 'png' | 'jpeg', layout: boolean) => void;
}

const KINDS: Array<{ mode: ExportMode; label: 'export.kindDicom' | 'export.kindImages' | 'export.kindVideo' | 'export.kindMedia' }> = [
  { mode: 'dicom', label: 'export.kindDicom' }, { mode: 'images', label: 'export.kindImages' }, { mode: 'video', label: 'export.kindVideo' }, { mode: 'media', label: 'export.kindMedia' },
];
type Scope = 'slice' | 'series' | 'all' | 'picked' | 'layout';
type Anonymity = 'none' | 'partial' | 'full';
type Target = 'cd' | 'usb' | 'folder';
type Size = 'native' | 'screen' | 'fit';
type Annotations = 'full' | 'basic' | 'none';
const FIT_SIZES = [[1280, 720], [1920, 1080], [1024, 1024], [512, 512]] as const;
const studyDate = (value: string) => /^\d{8}$/.test(value) ? `${value.slice(6)}.${value.slice(4, 6)}.${value.slice(0, 4)}` : value;
/** As Windows gives sizes (MB of 1024 KB), to a decimal under 100: "4,4 MB", so it reads as the folder's properties do. */
const sizeText = (bytes: number, locale: string) => {
  for (const [unit, scale] of [['GB', 2 ** 30], ['MB', 2 ** 20], ['KB', 2 ** 10]] as const) {
    if (bytes >= scale) { const value = bytes / scale; return `${value.toLocaleString(locale, { maximumFractionDigits: value < 100 ? 1 : 0 })} ${unit}`; }
  }
  return `${bytes} B`;
};
const timeText = (seconds: number, t: Translator) => seconds < 1 ? t('export.timeUnderSecond') : seconds < 90 ? t('export.timeSeconds', { n: Math.round(seconds) }) : t('export.timeMinutes', { n: Math.round(seconds / 60) });
function groupExportSeries(series: Series[]) {
  const studies = new Map<string, Series[]>();
  for (const item of series) {
    const key = studyKey(item), study = studies.get(key);
    if (study) study.push(item); else studies.set(key, [item]);
  }
  return [...studies.entries()];
}

function imageExportName(series: Series | undefined, includePatient: boolean) {
  if (!includePatient) return 'VEAcom';
  return [series?.patientName.replaceAll('^', ' ').trim(), series?.description].filter(Boolean).join(' - ') || 'VEAcom';
}

const OPEN_AFTER = 'veacom:export-open-after', MORE = 'veacom:export-more', PREFIX = 'veacom:export-prefix';
const remembered = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* a convenience only */ } };

/** A row of choices, one picked (radio buttons laid out side by side). */
function Choice<T extends string>({ label, value, options, onChange, name, action }: { label: string; value: T; name: string; action: string; options: Array<[T, string, boolean?]>; onChange: (value: T) => void }) {
  return <div className="export-row" role="radiogroup" aria-label={label}><span className="export-row-label">{label}</span>
    <div className="export-radios">{options.map(([key, text, disabled]) => <label key={key} className={`export-radio${disabled ? ' is-disabled' : ''}`}>
      <input type="radio" name={name} value={key} data-action={action} checked={value === key} disabled={disabled} onChange={() => onChange(key)} /><span>{text}</span></label>)}</div></div>;
}

/** A box over several series: ticked when all of them are picked, a dash when only some are (src/ui/exportSelection.ts). */
function PickAll({ ids, picked, action, onToggle }: { ids: string[]; picked: ReadonlySet<string>; action: string; onToggle: (ids: string[]) => void }) {
  const state = pickState(ids, picked);
  return <input type="checkbox" data-action={action} checked={state.all} ref={box => { if (box) box.indeterminate = state.partial; }} onChange={() => onToggle(ids)} />;
}

export function ExportDialog({ mode, series, activeSeriesId, video, currentFrame, background = false, onClose, onComplete, onFailed, onBackground, busy, onBusyChange, onProgress, cancelRef, onModeChange, unavailable = {}, onPicture }: ExportDialogProps) {
  const { locale, t } = useTranslation();
  const active = series.find(item => item.id === activeSeriesId);
  const isImages = mode === 'images', isVideo = mode === 'video', isMedia = mode === 'media', captures = isImages || isVideo;
  const patients = new Set(series.map(patientKey)).size;
  const [scope, setScope] = useState<Scope>('series');
  const [picked, setPicked] = useState(() => new Set(series.filter(item => active && studyKey(item) === studyKey(active)).map(item => item.id)));
  const [folder, setFolder] = useState('');
  const [openAfter, setOpenAfter] = useState(() => remembered(OPEN_AFTER) === '1');
  const [anonymity, setAnonymity] = useState<Anonymity>('none');
  const [target, setTarget] = useState<Target>('folder');
  const targets = ([['cd', 'discBurning'], ['usb', 'usbExport'], ['folder', null]] as const)
    .filter(([, feature]) => !feature || bridgeCan(feature)).map(([key]) => key);
  const [neuro, setNeuro] = useState(false);
  // Off each time the window opens, as in VEAcom 1.x: a plain DICOM folder unless asked for.
  const [zip, setZip] = useState(false);
  const [smallest, setSmallest] = useState(false);
  const [estimates, setEstimates] = useState(() => new Map<string, ExportEstimate>());
  const [label, setLabel] = useState('VEACOM');
  const [pictureFormat, setPictureFormat] = useState<'png' | 'jpeg'>('png');
  const [quality, setQuality] = useState(92);
  const [fps, setFps] = useState(15);
  const [size, setSize] = useState<Size>('screen');
  const [fit, setFit] = useState(1);
  const [annotations, setAnnotations] = useState<Annotations>('full');
  const [more, setMore] = useState(() => remembered(MORE) === '1');
  const [prefix, setPrefix] = useState(() => remembered(PREFIX) ?? '');
  const [reverse, setReverse] = useState(false);
  const [start, setStart] = useState(1 + (video?.numberOffset ?? 0));
  const [end, setEnd] = useState((video?.frameCount ?? 1) + (video?.numberOffset ?? 0));
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const isWindows = /Windows/i.test(navigator.userAgent);
  useEffect(() => { void window.veacom?.exportFolder?.().then(setFolder).catch(() => {}); }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { abort.current?.abort(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { usage.touch('dialog'); }, [zip, smallest, scope, picked, anonymity, target, neuro, label, pictureFormat, quality, fps, size, fit, annotations, start, end, busy, error, openAfter]);
  // A kind without a scope of its own falls back to one it has.
  const scopes: Scope[] = isImages ? ['slice', 'series', 'layout'] : isVideo ? ['series'] : isMedia ? ['series', 'all', 'picked'] : ['slice', 'series', 'all', 'picked'];
  const shownScope: Scope = scopes.includes(scope) ? scope : 'series';

  const groups = groupExportSeries(series);
  const ids = shownScope === 'all' ? series.map(item => item.id) : shownScope === 'picked' ? series.filter(item => picked.has(item.id)).map(item => item.id) : active ? [active.id] : [];
  const fitSize = { width: FIT_SIZES[fit][0], height: FIT_SIZES[fit][1] };
  const outputSize = size === 'native' ? video?.nativeSize : size === 'fit' ? fitSize : undefined;
  // Slices are numbered as the pane numbers them.
  const backwards = Boolean(video?.backwards), count = video?.frameCount ?? 1, offset = video?.numberOffset ?? 0;
  const indexOf = (shown: number) => video?.numbersBackwards ? count - (shown - offset) : shown - offset - 1;
  const sliceRange = shownScope === 'slice' && video ? { start: video.originalSlice, end: video.originalSlice }
    : { start: Math.min(indexOf(start), indexOf(end)), end: Math.max(indexOf(start), indexOf(end)) };
  const order = { descending: backwards !== reverse, numberOf: (slice: number) => (video?.numbersBackwards ? count - slice : slice + 1) + offset, prefix };
  const rangeValid = !captures || (Boolean(video) && Number.isInteger(start) && Number.isInteger(end) && start >= 1 + offset && start <= end && end <= (video?.frameCount ?? 0) + offset);
  // One DICOM export holds at most MAX_EXPORT_SERIES series (electron/export-limits.mjs), a disc's as well.
  const tooMany = !captures && ids.length > MAX_EXPORT_SERIES;
  const ready = Boolean(window.veacom) && (shownScope === 'layout' || (captures ? rangeValid && (isImages || (fps >= 1 && fps <= 120)) : ids.length > 0))
    && !(mode === 'dicom' && shownScope === 'slice' && currentFrame === undefined) && !tooMany;
  // "1 seri, 24 dosya: 12,4 MB → yaklaşık 6,1 MB, 2 sn": a few of the files compressed for real, a moment after a change.
  const zipping = mode === 'dicom' && zip && ids.length > 0 && !tooMany;
  const estimateOptions = {
    anonymize: anonymity !== 'none', full: anonymity === 'full', smallest,
    frame: shownScope === 'slice' ? currentFrame : undefined, engineGeneration: series.find(item => item.id === ids[0])?.engineGeneration,
  };
  const estimateKey = zipping ? JSON.stringify([ids, estimateOptions]) : '';
  const result = estimates.get(estimateKey);
  useEffect(() => {
    if (!estimateKey || result) return;
    const timer = setTimeout(() => {
      void window.veacom?.estimateExport?.(ids, estimateOptions).then(value => {
        setEstimates(known => new Map(known).set(estimateKey, value));
      }).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [estimateKey, result, ids, estimateOptions]);
  const estimateText = result && t('export.estimate', {
    what: shownScope === 'slice' ? t('export.estimateOne') : t('export.estimateFiles', { series: ids.length, files: result.files }),
    before: sizeText(result.before, locale), after: sizeText(result.after, locale), time: timeText(result.seconds, t),
  });
  const toggle = (toggled: string[]) => setPicked(current => togglePicked(current, toggled));
  const chooseFolder = async () => { const chosen = await window.veacom?.chooseExportFolder?.(); if (chosen) setFolder(chosen); };

  const submit = async () => {
    if (busy || abort.current || !ready) return;
    const bridge = window.veacom;
    if (!bridge) { setError(t('export.desktopRequired')); return; }
    if (isImages && shownScope === 'layout') { onPicture?.(pictureFormat, true); onClose(); return; }
    onBusyChange(true); setError('');
    const task = isImages ? 'export-images-done' : isVideo ? 'export-video-done' : isMedia ? (target === 'cd' ? 'export-disc-done' : 'export-media-done') : 'export-dicom-done';
    const controller = new AbortController(); abort.current = controller;
    // The status bar's Cancel: a capture stops between slices; a disc export, and a DICOM, USB or folder export, stop
    // in main and the engine, which remove what they wrote.
    if (cancelRef) cancelRef.current = () => {
      controller.abort();
      if (isMedia && target === 'cd') void bridge.cancelIso?.().catch(() => {});
      else if (!captures) void bridge.cancelExport?.().catch(() => {});
    };
    // The window goes; the status bar shows the export until it is done.
    onBackground?.();
    const performExport = async () => {
      let message: string, warnings: string[] = [], reveal: string | undefined;
      const selected = series.filter(item => ids.includes(item.id));
      const connections = captures ? [] : await Promise.all(selected.map(assertSeriesEngine));
      const engineGeneration = connections[0]?.generation;
      if (connections.some(core => core.generation !== engineGeneration) || !captures && new Set(selected.map(item => item.engineGeneration)).size > 1) throw new Error(t('export.differentEngines'));
      const overlays = { includeOverlays: annotations !== 'none', hideIdentity: annotations === 'basic' };
      if (isImages && video) {
        const name = imageExportName(active, annotations === 'full');
        const directory = await exportViewportImages({ ...video, format: pictureFormat, quality: quality / 100, range: sliceRange, outputSize, ...overlays, ...order, here: true,
          suggestedName: name, signal: controller.signal, onProgress });
        if (!directory) { usage.milestone(task, 'cancel'); onClose(); return; }
        message = t('export.imagesSaved', { count: sliceRange.end - sliceRange.start + 1, path: directory }); reveal = directory;
      } else if (isVideo && video) {
        const path = await exportViewportVideo({ ...video, fps, range: sliceRange, outputSize, ...overlays, descending: order.descending,
          suggestedName: `${prefix}${annotations === 'full' && active?.description || 'VEAcom'}-video`, signal: controller.signal, onProgress });
        if (!path) { usage.milestone(task, 'cancel'); onClose(); return; }
        message = t('export.videoSaved', { path }); reveal = path;
      } else if (isMedia && target === 'cd') {
        if (!bridge.exportIso) throw new Error(t('export.desktopRequired'));
        const exported = await bridge.exportIso(ids, { anonymize: anonymity !== 'none', full: anonymity === 'full', decompress: neuro, label, openBurner: isWindows, engineGeneration });
        if (!exported) { usage.milestone(task, 'cancel'); onClose(); return; }
        message = isWindows ? t('export.isoSavedBurner', { path: exported.path }) : t('export.isoSaved', { path: exported.path });
        warnings = warningTexts(exported); reveal = exported.path;
      } else {
        const exported = await bridge.exportDicom(ids, { anonymize: anonymity !== 'none', full: anonymity === 'full', dicomdir: isMedia, decompress: isMedia && neuro,
          root: isMedia && target === 'usb', here: !(isMedia && target === 'usb'), frame: shownScope === 'slice' ? currentFrame : undefined,
          zip: mode === 'dicom' && zip, smallest: mode === 'dicom' && zip && smallest, engineGeneration });
        if (!exported) { usage.milestone(task, 'cancel'); onClose(); return; }
        message = exported.archives?.length ? t('export.zipSaved', { path: exported.directory }) : t('export.dicomSaved', { path: exported.directory });
        warnings = warningTexts(exported); reveal = exported.directory;
      }
      usage.milestone(task, 'ok');
      if (openAfter && reveal) void bridge.revealExport?.(reveal).catch(() => {});
      onComplete(message, warnings, reveal);
      onClose();
    };
    await performExport().catch(failure => {
      usage.milestone(task, controller.signal.aborted ? 'cancel' : 'error');
      const text = controller.signal.aborted ? t('export.cancelled') : failure instanceof Error ? errorMessage(failure) : t('export.failed');
      if (onFailed) { onFailed(text); onClose(); } else setError(text);
    }).finally(() => { abort.current = null; if (cancelRef) cancelRef.current = null; onBusyChange(false); });
  };

  const scopeName = (key: Scope) => key === 'slice' ? (isImages ? t('export.scopeImage') : t('export.scopeSlice')) : key === 'series' ? t('export.scopeSeries')
    : key === 'all' ? (patients > 1 ? t('export.scopeAllPatients', { count: patients }) : t('export.scopeAll')) : key === 'picked' ? t('export.scopePicked') : t('export.scopeLayout');
  const folderRow = <div className="export-row"><span className="export-row-label">{t('export.folder')}</span>
    <div className="export-folder"><FolderOpen size={15} aria-hidden="true" /><span className="export-folder-path" title={folder}>{folder || '…'}</span>
      <button type="button" className="secondary-button compact" data-action="export-folder-change" onClick={() => void chooseFolder()}>{t('export.change')}</button></div></div>;
  const anonymityRow = <Choice name="anonymity" action="export-anonymity" label={t('export.anonymity')} value={anonymity} onChange={setAnonymity}
    options={[['none', t('export.anonNone')], ['partial', t('export.anonPartial')], ['full', t('export.anonFull')]]} />;

  return <div className={`modal-backdrop export-backdrop${background ? ' is-background' : ''}`} aria-hidden={background || undefined} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
  }}>
    <section ref={dialog} className="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title" tabIndex={-1}>
      <header>{captures ? <Film size={19} /> : <HardDrive size={19} />}<h2 id="export-dialog-title">{t('export.title')}</h2>
        <button className="icon-button" aria-label={t('export.close')} data-testid="export-close" disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="export-dialog-content">
          <fieldset disabled={busy}>
            <div className="export-kinds" role="radiogroup" aria-label={t('export.kind')}>
              {KINDS.map(kind => <button type="button" key={kind.mode} role="radio" aria-checked={mode === kind.mode} data-action="export-kind" data-kind={kind.mode}
                className={mode === kind.mode ? 'is-selected' : ''} aria-disabled={Boolean(unavailable[kind.mode]) || undefined} data-tooltip={unavailable[kind.mode]}
                onClick={() => { if (mode !== kind.mode && !unavailable[kind.mode]) onModeChange?.(kind.mode); }}>{t(kind.label)}</button>)}
            </div>
            {scopes.length > 1 && <Choice name="scope" action="export-scope" label={t('export.scope')} value={shownScope} onChange={setScope}
              options={scopes.map(key => [key, scopeName(key), mode === 'dicom' && key === 'slice' && currentFrame === undefined])} />}
            {/* A box on the list and one on each study pick all of their series, or none when all were picked. */}
            {shownScope === 'picked' && <div className="export-series-list" role="group" aria-label={t('export.seriesHeading')}>
              <label className="export-pick-row export-pick-all">
                <PickAll action="export-select-all" ids={series.map(item => item.id)} picked={picked} onToggle={toggle} />
                <span><strong>{t('export.selectAll')}</strong><small>{t('export.seriesPicked', { picked: ids.length, total: series.length })}</small></span>
              </label>
              {groups.map(([key, items]) => {
                const studyIds = items.map(item => item.id);
                return <section className="export-study" key={key}>
                  <h4><label className="export-pick-row">
                    <PickAll action="export-select-study" ids={studyIds} picked={picked} onToggle={toggle} />
                    <span><strong>{items[0].patientName.replaceAll('^', ' ').trim() || items[0].patientId || t('series.unnamedPatient')}</strong>
                      <small>{studyDate(items[0].studyDate) || t('export.undatedStudy')} · {pickState(studyIds, picked).count} / {items.length}</small></span>
                  </label></h4>
                  {items.map(item => <label className="export-series-row" key={item.id}>
                    <input type="checkbox" data-action="export-series" checked={picked.has(item.id)} onChange={() => toggle([item.id])} />
                    <span><strong>{[item.description || t('export.seriesNumber', { number: item.seriesNumber }), item.phase && phaseLabel(item.phase)].filter(Boolean).join(' · ')}</strong><small>{exportedImages(item)}</small></span>
                  </label>)}
                </section>;
              })}
            </div>}
            {!captures && shownScope !== 'all' && series.some(item => ids.includes(item.id) && item.phase?.gate)
              && <p className="export-note" data-testid="export-gates">{t('export.gatesNote')}</p>}
            {tooMany && <p className="export-note" data-testid="export-too-many">{t('export.tooManySeries', { max: MAX_EXPORT_SERIES })}</p>}
            {captures && <>
              {isImages && <Choice name="picture-format" action="export-picture-format" label={t('export.format')} value={pictureFormat} onChange={setPictureFormat} options={[['png', 'PNG'], ['jpeg', 'JPEG']]} />}
              {shownScope !== 'layout' && <Choice name="annotations" action="export-annotations" label={t('export.annotations')} value={annotations} onChange={setAnnotations}
                options={[['full', t('export.annFull')], ['basic', t('export.annBasic')], ['none', t('export.annNone')]]} />}
              {/* The rest waits under "More settings", as in VEAcom 1.x: left alone, every slice goes, in the order on screen. */}
              {shownScope !== 'layout' && <button type="button" className="export-more" aria-expanded={more} data-action="export-more" onClick={() => { setMore(open => !open); remember(MORE, more ? '0' : '1'); }}>
                {t('export.more')}<span aria-hidden="true">{more ? '▴' : '▾'}</span></button>}
              {more && shownScope !== 'layout' && <div className="export-more-box">
                <Choice name="size" action="export-size" label={t('export.size')} value={size} onChange={setSize}
                  options={[['native', t('export.sizeNative'), !video?.nativeSize], ['screen', t('export.sizeScreen')], ['fit', t('export.sizeFit')]]} />
                {size === 'fit' && <div className="export-row"><span className="export-row-label" />
                  <select aria-label={t('export.sizeFit')} data-action="export-size" value={fit} onChange={event => setFit(Number(event.target.value))}>
                    {FIT_SIZES.map(([w, h], index) => <option key={index} value={index}>{w} × {h}</option>)}</select></div>}
                {(isVideo || pictureFormat === 'jpeg') && <div className="export-row"><span className="export-row-label">{isVideo ? t('export.fps') : t('export.quality')}</span>
                  {isVideo ? <input type="number" className="export-number" data-action="export-fps" min={1} max={120} step={1} value={fps} onChange={event => setFps(Number(event.target.value))} />
                    : <span className="export-slider"><input type="range" data-action="export-quality" min={50} max={100} step={1} value={quality} onChange={event => setQuality(Number(event.target.value))} /><output>{quality}</output></span>}</div>}
                {shownScope === 'series' && video && <div className="export-row"><span className="export-row-label">{t('export.slices')}</span>
                  <span className="export-range"><input type="number" className="export-number" data-action="export-first-slice" min={1 + offset} max={video.frameCount + offset} value={start} onChange={event => setStart(Number(event.target.value))} />
                    –<input type="number" className="export-number" data-action="export-last-slice" min={start} max={video.frameCount + offset} value={end} onChange={event => setEnd(Number(event.target.value))} />
                    <small>/ {video.numberTotal ?? video.frameCount}</small></span></div>}
                <div className="export-row"><span className="export-row-label">{t('export.prefix')}</span>
                  <input data-action="export-prefix" value={prefix} maxLength={40} placeholder="IMG_" onChange={event => { const next = event.target.value.replace(/[^\p{L}\p{N} _.-]/gu, ''); setPrefix(next); remember(PREFIX, next); }} /></div>
                {isVideo && <label className="export-check"><input type="checkbox" data-action="export-reverse" checked={reverse} onChange={event => setReverse(event.target.checked)} /><span>{t('export.reverse')}</span></label>}
              </div>}
            </>}
            {mode === 'dicom' && anonymityRow}
            {isMedia && <>
              {/* Where the bridge cannot burn a disc or write a stick's root (the browser), a folder is the only target. */}
              {targets.length > 1 && <Choice name="target" action="export-target" label={t('export.target')} value={target} onChange={setTarget}
                options={targets.map(key => [key, t(key === 'cd' ? 'export.targetCd' : key === 'usb' ? 'export.targetUsb' : 'export.targetFolder')])} />}
              {target === 'cd' && <div className="export-row"><span className="export-row-label">{t('export.discLabel')}</span><input data-action="export-disc-label" value={label} maxLength={32} onChange={event => setLabel(event.target.value)} /></div>}
              {target === 'usb' && <p className="export-note">{t('export.usbNote')}</p>}
              <label className="export-check"><input type="checkbox" data-action="export-neuro" checked={neuro} onChange={event => setNeuro(event.target.checked)} /><span>{t('export.neuro')}</span></label>
              {anonymityRow}
            </>}
            {anonymity !== 'none' && (mode === 'dicom' || isMedia) && <p className="export-note export-caution">{anonymity === 'full' ? t('export.anonFullNote') : t('export.anonymizeNote')}</p>}
            {mode === 'dicom' && bridgeCan('zipExport') && <div className="export-zip">
              <label className="export-check"><input type="checkbox" data-action="export-zip" checked={zip} onChange={event => { setZip(event.target.checked); if (!event.target.checked) setSmallest(false); }} /><span>{t('export.zip')}</span></label>
              <label className={`export-check export-sub${zip ? '' : ' is-disabled'}`}><input type="checkbox" data-action="export-smallest" checked={smallest} disabled={!zip} onChange={event => setSmallest(event.target.checked)} /><span>{t('export.smallest')}</span></label>
              {zip && <p className="export-estimate" data-testid="export-estimate" aria-live="polite">{estimateText || '…'}</p>}
            </div>}
            {shownScope !== 'layout' && !(isMedia && target !== 'folder') && bridgeCan('exportFolder') && folderRow}
            {shownScope !== 'layout' && bridgeCan('exportFolder') && <label className="export-check"><input type="checkbox" data-action="export-open-after" checked={openAfter} onChange={event => { setOpenAfter(event.target.checked); remember(OPEN_AFTER, event.target.checked ? '1' : '0'); }} /><span>{t('export.openAfter')}</span></label>}
          </fieldset>
          {!window.veacom && <p className="export-error">{t('export.desktopRequired')}</p>}
          {error && <p className="export-error" role="alert">{error}</p>}
        </div>
        <footer>
          <button type="button" className="secondary-button" data-testid="export-dismiss" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="primary-button" data-testid="export-submit" disabled={busy || !ready}><Download size={15} />{t('export.start')}</button>
        </footer>
      </form>
    </section>
  </div>;
}

export default ExportDialog;
