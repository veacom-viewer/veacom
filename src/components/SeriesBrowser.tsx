import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { ChevronDown, Eye, EyeOff, Images, Search, Shapes, TriangleAlert, X } from './icons';
import type { Series, Volume } from '../model';
import { isPaddingValue } from '../imaging/geometry';
import { voiGrey, windowGrey } from '../imaging/viewState';
import type { Translator } from '../i18n';
import { useTranslation } from '../i18n/react';
import { warningTexts } from '../i18n/core';
import { usage } from '../usage/tracker';
import { referenceImages } from '../ui/referenceImages';
import { foldSearch, patientKey, searchText, sequenceGuess, shownGuess, sortStudySeries, studyKey } from '../ui/seriesNames';
import { phaseLabel } from '../ui/overlayCorners';
import { Glyph } from './Glyph';
import { Menu, MenuDivider, MenuHeading, MenuItem } from './Toolbar';
import './SeriesBrowser.css';

export interface SeriesBrowserProps {
  series: Series[];
  activeId: string | null;
  loadingIds: Set<string>;
  /** Segmentations drawn over their images; selecting one shows or hides it. */
  shownSegmentationIds?: ReadonlySet<string>;
  /** Series whose preview could not be made: their card shows a dash. */
  failedIds?: ReadonlySet<string>;
}
interface SeriesActions { select: (series: Series) => void; remove: (ids: string[]) => void }

/** A drag of several picked cards carries their ids here, in the order they were picked. */
export const SERIES_LIST_DRAG = 'application/x-veacom-series-list';
/** VEAcom 1.x (Qt) started a drag after ten pixels; the window starts one after a few. */
const CLICK_SLOP_PX = 10;

// Each series' preview is drawn once and kept, as VEAcom 1.x did: the middle slice in its own window (else the
// series', a CT's 400/60, else its 1st-99th percentile), shrunk by averaging so fine detail does not alias. Opening
// the series later, or the list drawing the card again, shows the same picture: it is not redrawn from the volume.
const PREVIEW_WIDTH = 80, PREVIEW_HEIGHT = 84, PREVIEW_SCALE = 2;
const drawnPreviews = new Map<string, ImageData>();
const previewUpdates = new EventTarget();

function drawPreview(volume: Volume): ImageData | null {
  const { dimensions, photometricInterpretation } = volume.series;
  const [columns, rows, slices] = dimensions;
  const outWidth = PREVIEW_WIDTH * PREVIEW_SCALE, outHeight = PREVIEW_HEIGHT * PREVIEW_SCALE;
  const picture = new ImageData(outWidth, outHeight);
  for (let at = 3; at < picture.data.length; at += 4) picture.data[at] = 255;
  if (columns < 1 || rows < 1 || slices < 1) return picture;
  const slice = volume.sourceFrameIndex ?? Math.floor((slices - 1) / 2);
  const base = (volume.sourceFrameIndex === undefined ? slice : 0) * rows * columns;
  const frame = volume.series.frameMetadata?.[slice];
  const spacing = frame?.spacing ?? volume.series.spacing;
  const rgb = volume.series.components === 3;
  let windowCenter = frame?.windowCenter ?? volume.series.windowCenter, windowWidth = frame?.windowWidth ?? volume.series.windowWidth;
  if (!rgb && !(windowWidth > 0 && Number.isFinite(windowCenter))) {
    if (volume.series.modality === 'CT') { windowCenter = 60; windowWidth = 400; }
    else {
      // Percentiles rather than min/max: a few extreme pixels would otherwise flatten the preview to black.
      const sample: number[] = [];
      const stride = Math.max(1, Math.floor(rows * columns / 4096));
      for (let index = 0; index < rows * columns; index += stride) { const value = volume.data[base + index]; if (Number.isFinite(value) && !isPaddingValue(volume.series, value, slice)) sample.push(value); }
      sample.sort((a, b) => a - b);
      const low = sample[Math.floor(sample.length * 0.01)] ?? 0, high = sample[Math.floor(sample.length * 0.99)] ?? 1;
      windowCenter = (low + high) / 2; windowWidth = Math.max(1, high - low);
    }
  }
  const aspect = (columns * (spacing[0] || 1)) / (rows * (spacing[1] || 1));
  const width = Math.max(1, Math.round(Math.min(outWidth, outHeight * aspect)));
  const height = Math.max(1, Math.round(Math.min(outHeight, outWidth / aspect)));
  const left = Math.floor((outWidth - width) / 2), top = Math.floor((outHeight - height) / 2);
  const inverted = photometricInterpretation === 'MONOCHROME1';
  // A frame without a window shows with its VOI LUT, as the viewport does in DICOM window mode.
  const lut = frame?.voiLut !== undefined && frame.windowWidth === undefined ? volume.series.voiLuts?.[frame.voiLut] : undefined;
  const grey = (value: number) => {
    if (!Number.isFinite(value) || isPaddingValue(volume.series, value, slice)) return 0;
    const level = Math.min(1, Math.max(0, lut ? voiGrey(lut, value) : windowGrey(value, windowCenter, Math.max(1, windowWidth), frame?.voiFunction)));
    return inverted ? 1 - level : level;
  };
  for (let y = 0; y < height; y += 1) {
    const row0 = Math.floor(y * rows / height), row1 = Math.max(row0 + 1, Math.floor((y + 1) * rows / height));
    const rowStep = Math.max(1, Math.floor((row1 - row0) / 6));
    for (let x = 0; x < width; x += 1) {
      const column0 = Math.floor(x * columns / width), column1 = Math.max(column0 + 1, Math.floor((x + 1) * columns / width));
      const columnStep = Math.max(1, Math.floor((column1 - column0) / 6));
      // The pixels this preview pixel covers, averaged (at most 6 x 6 of them).
      let red = 0, green = 0, blue = 0, count = 0;
      for (let row = row0; row < Math.min(rows, row1); row += rowStep) {
        for (let column = column0; column < Math.min(columns, column1); column += columnStep) {
          const pixel = base + row * columns + column;
          if (rgb) { red += volume.data[pixel * 3]; green += volume.data[pixel * 3 + 1]; blue += volume.data[pixel * 3 + 2]; }
          else { const level = grey(volume.data[pixel]) * 255; red += level; green += level; blue += level; }
          count += 1;
        }
      }
      const at = ((top + y) * outWidth + left + x) * 4;
      picture.data[at] = Math.round(red / count); picture.data[at + 1] = Math.round(green / count); picture.data[at + 2] = Math.round(blue / count);
    }
  }
  return picture;
}

/** The middle of a series, in its source order: what its card shows. */
export const thumbnailFrame = (series: { dimensions: number[] }) => Math.max(0, Math.floor((series.dimensions[2] - 1) / 2));
/** Whether a series' card picture has been drawn. */
export const hasThumbnail = (id: string) => drawnPreviews.has(id);
/** Draws a series' card picture once, from its middle frame or a whole volume (whose middle it takes), and keeps it, so
 * it does not change as the series loads. A volume holding another single frame (the first, which an opened pane
 * shows at once) is not used. */
export function keepThumbnail(volume: Volume) {
  if (drawnPreviews.has(volume.series.id)) return;
  if (volume.sourceFrameIndex !== undefined && volume.sourceFrameIndex !== thumbnailFrame(volume.series)) return;
  const picture = drawPreview(volume);
  if (picture) {
    drawnPreviews.set(volume.series.id, picture);
    previewUpdates.dispatchEvent(new Event(volume.series.id));
  }
}

export function forgetThumbnail(id: string) {
  if (drawnPreviews.delete(id)) previewUpdates.dispatchEvent(new Event(id));
}

function Preview({ id, empty, failed }: { id: string; empty: boolean; failed: boolean }) {
  const { t } = useTranslation();
  const subscribe = (notify: () => void) => {
    previewUpdates.addEventListener(id, notify);
    return () => previewUpdates.removeEventListener(id, notify);
  };
  const picture = useSyncExternalStore(subscribe, () => drawnPreviews.get(id));
  const paint = (canvas: HTMLCanvasElement | null) => {
    if (picture) canvas?.getContext('2d')?.putImageData(picture, 0, 0);
  };
  if (picture) return <canvas ref={paint} width={PREVIEW_WIDTH * PREVIEW_SCALE} height={PREVIEW_HEIGHT * PREVIEW_SCALE} style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT }} aria-hidden="true" />;
  if (empty) return <span className="series-preview-note">{t('series.noImages')}</span>;
  if (failed) return <span className="series-preview-note" title={t('series.previewFailed')}>—</span>;
  return <Images size={28} strokeWidth={1.1} className="series-preview-placeholder" />;
}

function timeLabel(value = '') {
  const digits = value.split('.')[0].trim();
  return /^\d{4}/.test(digits) ? `${digits.slice(0, 2)}:${digits.slice(2, 4)}` : '';
}
function dateLabel(value: string, t: Translator) {
  return /^\d{8}$/.test(value) ? `${value.slice(6, 8)}.${value.slice(4, 6)}.${value.slice(0, 4)}` : value || t('series.dateUnavailable');
}

function SegmentationCard({ item, series, shown, onSelect, onMenu }: { item: Series; series: Series[]; shown: boolean; onSelect: (series: Series) => void; onMenu: (event: ReactMouseEvent<HTMLElement>) => void }) {
  const { t } = useTranslation();
  const segments = item.segmentation?.segments ?? [];
  const reference = series.find(value => !value.segmentation && value.uid === item.segmentation?.referencedSeriesUid);
  const target = reference ? reference.description || reference.modality : '';
  const color = segments[0]?.color ? `rgb(${segments[0].color.join(', ')})` : '#f2a541';
  const names = segments.map(segment => segment.label).filter(Boolean).join(', ');
  const count = t(segments.length === 1 ? 'segmentation.segment' : 'segmentation.segments', { count: segments.length });
  const description = item.description || t('segmentation.untitled');
  return <button
    type="button"
    className={`series-card is-segmentation${shown ? ' is-shown' : ''}`}
    aria-pressed={shown}
    aria-label={`${description}, ${t('segmentation.kind')}, ${count}${target ? `, ${t('segmentation.drawnOn', { target })}` : ''}, ${t(shown ? 'segmentation.shown' : 'segmentation.hidden')}`}
    title={[t(shown ? 'segmentation.hide' : 'segmentation.show'), target ? t('segmentation.drawnOn', { target }) : '', names ? t('segmentation.segmentNames', { names }) : ''].filter(Boolean).join('\n')}
    data-testid={`series-${item.id}`}
    data-action="segmentation-toggle"
    draggable
    onDragStart={event => { event.dataTransfer.setData('application/x-veacom-series', item.id); event.dataTransfer.effectAllowed = 'copy'; }}
    onClick={() => onSelect(item)}
    onContextMenu={onMenu}
  >
    <span className="series-card-description" title={item.description}>{description}</span>
    <span className="series-segmentation" style={{ '--segment-color': color } as CSSProperties}>
      <Shapes size={19} strokeWidth={1.4} aria-hidden="true" />
      <span>{t('segmentation.kind')}</span>
      <small>{count}</small>
      {shown ? <Eye size={11} className="series-segmentation-state" aria-hidden="true" /> : <EyeOff size={11} className="series-segmentation-state" aria-hidden="true" />}
    </span>
  </button>;
}

/** What a right click (or Shift+F10, the menu key) was on: a series card, a study heading or the list. */
interface ListMenu { x: number; y: number; opener: HTMLElement | null; item?: Series; study?: string }
interface RemoveQuestion { message: string; ids: string[] }

function patientName(item: Series, t: Translator) { return item.patientName.replaceAll('^', ' ') || item.patientId || t('series.unnamedPatient'); }

function groupStudies(series: Series[]) {
  type Study = { key: string; first: Series; items: Series[] };
  const patients = new Map<string, { key: string; first: Series; studies: Map<string, Study> }>();
  for (const item of series) {
    const key = `patient:${patientKey(item)}`;
    let patient = patients.get(key);
    if (!patient) { patient = { key, first: item, studies: new Map() }; patients.set(key, patient); }
    const id = studyKey(item), study = patient.studies.get(id);
    if (study) study.items.push(item);
    else patient.studies.set(id, { key: id, first: item, items: [item] });
  }
  return [...patients.values()].map(patient => ({ ...patient,
    studies: [...patient.studies.values()].map(study => ({ ...study, items: sortStudySeries(study.items) })),
  }));
}

export function SeriesMenuItems({ series, activeId, shown, onSelect }: {
  series: Series[]; activeId?: string; shown: ReadonlySet<string>; onSelect: (item: Series) => void;
}) {
  const { t } = useTranslation();
  // A stack and its reference image are one series here as in the list (ui/referenceImages.ts).
  const references = referenceImages(series), counted = new Set([...references.values()].map(item => item.id));
  const patients = groupStudies(series.filter(item => !counted.has(item.id)));
  return patients.map((patient, index) => <Fragment key={patient.key}>
    {index > 0 && <MenuDivider />}
    {patients.length > 1 && <MenuHeading>{patient.first.patientName.replaceAll('^', ' ').trim() || patient.first.patientId || '—'}</MenuHeading>}
    {patient.studies.flatMap(study => study.items.map(item => {
      const guess = shownGuess(item, sequenceGuess(item, t)), reference = references.get(item.id);
      return <MenuItem action="segmentation-kind" key={item.id} kind={item.segmentation ? 'checkbox' : 'radio'}
        checked={item.segmentation ? shown.has(item.id) : activeId === item.id || (reference !== undefined && reference.id === activeId)}
        meta={`${item.modality} · ${item.dimensions[2] + Number(reference !== undefined)}`} onClick={() => onSelect(item)}>
        {item.segmentation ? `${t('segmentation.kind')} · ` : ''}{item.description || item.modality}{item.phase ? ` · ${phaseLabel(item.phase)}` : ''}{guess ? ` · ${guess}` : ''}
      </MenuItem>;
    }))}
  </Fragment>);
}

/** Asks before a study, a patient or the whole list leaves the list (VEAcom 1.x asked too). */
function RemoveDialog({ question, onRemove, onClose }: { question: RemoveQuestion; onRemove: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="dialog remove-dialog" aria-labelledby="remove-title" aria-describedby="remove-message" data-testid="series-remove-dialog"
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="remove-title">{t('series.removeTitle')}</h2></header>
    <p id="remove-message">{question.message}<br />{t('series.removeNote')}</p>
    <footer>
      <button type="button" className="secondary-button" data-testid="series-remove-cancel" onClick={onClose}>{t('series.removeCancel')}</button>
      <button type="button" className="primary-button" data-testid="series-remove-confirm" autoFocus onClick={() => { onRemove(); onClose(); }}>{t('series.removeConfirm')}</button>
    </footer>
  </dialog>;
}

function storeGuessNames(enabled: boolean) {
  try { localStorage.setItem('veacom:guess-names', enabled ? '1' : '0'); } catch { /* Storage may be disabled. */ }
}

export function SeriesBrowser({ series, activeId, loadingIds, shownSegmentationIds, failedIds, actionsRef, inert }: SeriesBrowserProps & { actionsRef: RefObject<SeriesActions>; inert: boolean }) {
  return <div className="series-browser-slot" inert={inert || undefined}>
    <SeriesList series={series} activeId={activeId} loadingIds={loadingIds} shownSegmentationIds={shownSegmentationIds} failedIds={failedIds}
      onSelect={item => actionsRef.current.select(item)} onRemove={ids => actionsRef.current.remove(ids)} />
  </div>;
}

function SeriesList({ series, activeId, loadingIds, shownSegmentationIds, failedIds, onSelect, onRemove }: SeriesBrowserProps & { onSelect: SeriesActions['select']; onRemove: SeriesActions['remove'] }) {
  const { locale, t } = useTranslation();
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  // The likely sequence in place of a series' own name (VEAcom Next's "sequence names"), remembered.
  const [guessNames, setGuessNames] = useState(() => { try { return localStorage.getItem('veacom:guess-names') === '1'; } catch { return false; } });
  const toggleGuessNames = () => {
    setGuessNames(!guessNames);
    storeGuessNames(!guessNames);
  };
  const findButton = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => { usage.touch('panel'); }, [search, searchOpen, collapsed]);
  const guesses = new Map(series.map(item => [item.id, sequenceGuess(item, t)]));
  const query = foldSearch(search.trim());
  const searching = Boolean(query);
  const searchIndex = searching ? new Map(series.map(item => [item.id, searchText(item, guesses.get(item.id))])) : null;
  const words = query.split(/\s+/);
  // A stack and its reference image are one series to the reader (ui/referenceImages.ts): the image has no card of
  // its own, the stack's card counts it among its images, and paging past the stack's end reaches it.
  const references = referenceImages(series), onCards = new Set([...references.values()].map(item => item.id));
  const listed = series.filter(item => !onCards.has(item.id));
  // The stack's card stands for its reference image too: a search that finds only that image keeps the card.
  const found = searchIndex ? (item: Series) => words.every(word => searchIndex.get(item.id)!.includes(word)) : null;
  const studies = groupStudies(found ? listed.filter(item => found(item) || found(references.get(item.id) ?? item)) : listed);
  // A study that opens goes to the top of the list, and the list goes there with it: a reader who had scrolled down
  // sees it arrive.
  const scroller = useRef<HTMLDivElement>(null);
  const firstStudy = studies.at(0)?.studies.at(0)?.key;
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [firstStudy]);

  // Ctrl and Shift pick several cards, as in a folder; dragging one of them drags them all, in the order
  // they were picked, and they open side by side (VEAcom 1.x). A plain click picks one and opens it.
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const pressed = useRef<{ x: number; y: number; ctrl: boolean; shift: boolean } | null>(null);
  if (picked.some(id => !guesses.has(id))) setPicked(picked.filter(id => guesses.has(id)));
  const pick = (item: Series, ctrl: boolean, shift: boolean) => {
    if (shift && anchor.current) {
      const order = studies.flatMap(patient => collapsed.has(patient.key) && !search ? [] : patient.studies.flatMap(study => collapsed.has(study.key) && !search ? [] : study.items.filter(item => !item.segmentation).map(item => item.id)));
      const from = order.indexOf(anchor.current), to = order.indexOf(item.id);
      if (from >= 0 && to >= 0) {
        const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        setPicked(current => {
          const chosen = ctrl ? [...new Set([...current, ...range])] : range;
          const kept = current.filter(id => chosen.includes(id));
          return [...kept, ...chosen.filter(id => !kept.includes(id))];
        });
        return;
      }
    }
    anchor.current = item.id;
    if (ctrl) { setPicked(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id]); return; }
    setPicked([item.id]);
    onSelect(item);
  };
  const dragStart = (event: ReactDragEvent<HTMLElement>, item: Series) => {
    const ids = picked.length > 1 && picked.includes(item.id) ? picked : [item.id];
    event.dataTransfer.setData('application/x-veacom-series', item.id);
    if (ids.length > 1) event.dataTransfer.setData(SERIES_LIST_DRAG, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'copy';
  };
  // A hand that moved a little while clicking began a drag that ended nowhere, and nothing opened:
  // such a drag is taken for the click it was.
  const dragEnd = (event: ReactDragEvent<HTMLElement>, item: Series) => {
    const at = pressed.current; pressed.current = null;
    if (!at || event.dataTransfer.dropEffect !== 'none') return;
    if (Math.hypot(event.clientX - at.x, event.clientY - at.y) <= CLICK_SLOP_PX) pick(item, at.ctrl, at.shift);
  };

  function toggleStudy(key: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const [menu, setMenu] = useState<ListMenu | null>(null);
  const [question, setQuestion] = useState<RemoveQuestion | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openMenu = (event: ReactMouseEvent<HTMLElement>, at: Pick<ListMenu, 'item' | 'study'>) => {
    event.preventDefault(); event.stopPropagation();
    const opener = event.currentTarget;
    // The keyboard's menu key gives no pointer position: the menu opens at the element.
    const keyboard = event.clientX === 0 && event.clientY === 0, box = opener.getBoundingClientRect();
    setMenu({ x: keyboard ? box.left + 12 : event.clientX, y: keyboard ? box.top + Math.min(box.height, 24) : event.clientY, opener, ...at });
  };
  const closeMenu = (refocus = true) => { if (refocus && menu?.opener?.isConnected) menu.opener.focus({ preventScroll: true }); setMenu(null); };
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [menu]);
  const act = (action: () => void) => { closeMenu(false); action(); };
  const studyItems = (key: string) => series.filter(item => studyKey(item) === key);
  const askStudy = (key: string) => {
    const items = studyItems(key); if (!items.length) return;
    setQuestion({ ids: items.map(item => item.id), message: t('series.removeStudyQuestion', { name: `${patientName(items[0], t)} · ${dateLabel(items[0].studyDate, t)}`, count: items.length }) });
  };
  const askPatient = (item: Series) => {
    const items = series.filter(value => patientKey(value) === patientKey(item));
    setQuestion({ ids: items.map(value => value.id), message: t('series.removePatientQuestion', { name: patientName(item, t), count: items.length }) });
  };
  const askAll = () => setQuestion({ ids: series.map(item => item.id), message: t('series.removeAllQuestion', { count: series.length }) });
  // Collapse all folds every patient band, as in VEAcom Next.
  const studyKeys = () => studies.map(patient => patient.key);
  const menuStudy = menu?.study ?? (menu?.item ? studies.flatMap(patient => patient.studies).find(study => study.items.some(item => item.id === menu.item!.id))?.key : undefined);
  const menuPatient = menuStudy ? studyItems(menuStudy)[0] : undefined;
  const patientStudies = menuPatient ? new Set(series.filter(item => patientKey(item) === patientKey(menuPatient)).map(item => item.studyUid || item.id)).size : 0;

  return <aside className="series-browser" aria-label={t('series.browser')}>
    <div className="series-browser-scroll" ref={scroller} onContextMenu={event => openMenu(event, {})}>
      {studies.map(patient => {
        const patientHidden = collapsed.has(patient.key) && !search;
        const patientName = patient.first.patientName.replaceAll('^', ' ').trim();
        return <section key={patient.key} className="series-patient">
          <button type="button" className="series-patient-heading" data-action="patient-toggle" aria-expanded={!patientHidden} onClick={() => toggleStudy(patient.key)} onContextMenu={event => openMenu(event, { study: patient.studies[0].key })}>
            <ChevronDown size={13} className={patientHidden ? 'is-collapsed' : ''} />
            <strong>{patientName || patient.first.patientId || '—'}</strong>
            <span className="series-patient-details">{patient.first.patientBirthDate && <span title={t('series.birthDate')}>{dateLabel(patient.first.patientBirthDate, t)}</span>}{patient.first.patientId && <span title={t('series.patientId')}>{patient.first.patientId}</span>}</span>
          </button>
          {!patientHidden && patient.studies.map(study => {
        const hidden = collapsed.has(study.key) && !search;
        const selected = study.items.some(item => item.id === activeId);
        const modalities = [...new Set(study.items.map(item => item.modality).filter(Boolean))].join('/');
        return <section key={study.key} className={`series-study${selected ? ' is-selected' : ''}`}>
          <button type="button" className="series-study-heading" data-action="study-toggle" aria-expanded={!hidden} onClick={() => toggleStudy(study.key)} onContextMenu={event => openMenu(event, { study: study.key })}>
            <ChevronDown size={13} className={hidden ? 'is-collapsed' : ''} />
            <strong>{[dateLabel(study.first.studyDate, t), timeLabel(study.first.studyTime)].filter(Boolean).join(' ') || '—'}</strong>
            <span className="series-study-details">{study.first.studyDescription && <span title={study.first.studyDescription}>{study.first.studyDescription}</span>}<small>{t('series.studySummary', { modalities: modalities || 'DICOM', count: study.items.length })}</small></span>
          </button>
          {!hidden && <div className="series-study-items">{study.items.map(item => {
            if (item.segmentation) return <SegmentationCard key={item.id} item={item} series={series} shown={shownSegmentationIds?.has(item.id) ?? false} onSelect={onSelect} onMenu={event => openMenu(event, { item })} />;
            const loading = loadingIds.has(item.id);
            const reference = references.get(item.id);
            // The card is the open one while its series or its reference image is shown.
            const active = item.id === activeId || (reference !== undefined && reference.id === activeId);
            const several = picked.length > 1 && picked.includes(item.id);
            return <button
              type="button"
              key={item.id}
              className={`series-card${active ? ' is-active' : ''}${several ? ' is-picked' : ''}`}
              aria-pressed={active}
              aria-label={t('series.cardLabel', { description: item.description || t('series.untitled'), phase: item.phase ? `, ${phaseLabel(item.phase)}` : '', modality: item.modality, count: item.dimensions[2] + Number(reference !== undefined), warnings: item.warnings.length ? t('series.cardWarnings') : '' })}
              aria-busy={loading}
              aria-describedby={item.warnings.length ? `series-warnings-${item.id}` : undefined}
              data-testid={`series-${item.id}`}
              data-action="series-pick"
              draggable
              onPointerDown={event => { if (event.button === 0) pressed.current = { x: event.clientX, y: event.clientY, ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }; }}
              onDragStart={event => dragStart(event, item)}
              onDragEnd={event => dragEnd(event, item)}
              onClick={event => pick(item, event.ctrlKey || event.metaKey, event.shiftKey)}
              onContextMenu={event => openMenu(event, { item })}
            >
              <span className="series-card-description" title={guesses.get(item.id) ? `${item.description}\n${t('series.sequenceGuess', { sequence: guesses.get(item.id)!.label })}` : item.description}>{guessNames && shownGuess(item, guesses.get(item.id)) ? guesses.get(item.id)!.label : item.description || t('series.untitled')}</span>
              {!guessNames && shownGuess(item, guesses.get(item.id)) && <span className="series-sequence-guess" title={t('series.sequenceGuess', { sequence: guesses.get(item.id)!.label })}>{guesses.get(item.id)!.label}</span>}
              {item.phase && <span className="series-phase-label">{phaseLabel(item.phase)}</span>}
              <span className="series-preview">
                <Preview id={item.id} empty={item.dimensions[2] === 0} failed={Boolean(failedIds?.has(item.id) && !loading)} />
                {item.warnings.length > 0 && <span className="series-warning" aria-hidden="true" data-tooltip={warningTexts(item, locale).join(' · ')}><TriangleAlert size={11} /></span>}
                <span className="series-image-count">{item.dimensions[2] + Number(reference !== undefined)}</span>
                {several && <span className="sr-only">{t('series.picked', { number: picked.indexOf(item.id) + 1, count: picked.length })}</span>}
                {item.warnings.length > 0 && <span id={`series-warnings-${item.id}`} className="sr-only">{warningTexts(item, locale).join('. ')}</span>}
              </span>
            </button>;
          })}</div>}
        </section>;
          })}
        </section>;
      })}
      {studies.length === 0 && <div className="series-sidebar-empty"><Images size={24} strokeWidth={1.2} /><strong>{series.length ? t('series.noMatch') : t('series.noStudy')}</strong></div>}
    </div>
    {searchOpen && <div className="series-search">
      <input data-action="series-search" ref={searchInput} autoFocus onBlur={event => { if (!search.trim() && event.relatedTarget !== findButton.current) setSearchOpen(false); }} aria-label={t('series.search')} placeholder={t('series.searchPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} spellCheck={false} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSearch(''); setSearchOpen(false); findButton.current?.focus(); } }} />
      {search && <button data-action="series-search-clear" type="button" aria-label={t('series.clearSearch')} onClick={() => { setSearch(''); searchInput.current?.focus(); }}><X size={12} /></button>}
    </div>}
    <div className="series-browser-footnote"><span>{t('series.count', { count: series.length - onCards.size })}</span><button type="button" className="series-guess-toggle" aria-pressed={guessNames} aria-label={t('series.guessNames')} data-action="series-guess-names" data-tooltip={t('series.guessNames')} onClick={toggleGuessNames}><Glyph name="sequences" size={15} /></button><button ref={findButton} type="button" aria-label={t('series.find')} data-testid="series-find" aria-expanded={searchOpen} data-tooltip={t('series.find')} onClick={() => { setSearchOpen(open => !open); if (searchOpen) setSearch(''); }}><Search size={13} /></button></div>
    {menu && <div ref={menuRef} className="context-anchor" style={{ left: menu.x, top: menu.y }}>
      <Menu label={t('series.menu')} onClose={() => closeMenu()} className={`context-menu${menu.y > window.innerHeight - 320 ? ' menu-up' : ''}`} testId="series-menu">
        {menu.item && <>
          <MenuItem action="series-open-active" onClick={() => { const item = menu.item!; act(() => onSelect(item)); }}>{t('series.openInActive')}</MenuItem>
          <MenuItem action="series-remove" onClick={() => { const item = menu.item!, reference = references.get(item.id); act(() => onRemove(reference ? [item.id, reference.id] : [item.id])); }}>{t('series.removeSeries')}</MenuItem>
          <MenuDivider />
        </>}
        {menu.study && <MenuItem action="study-toggle" onClick={() => { const key = menu.study!; act(() => toggleStudy(key)); }}>{t(collapsed.has(menu.study) ? 'series.expand' : 'series.collapse')}</MenuItem>}
        <MenuItem action="series-collapse-all" disabled={!studies.length || Boolean(search)} onClick={() => act(() => setCollapsed(new Set(studyKeys())))}>{t('series.collapseAll')}</MenuItem>
        <MenuItem action="series-expand-all" disabled={!collapsed.size} onClick={() => act(() => setCollapsed(new Set()))}>{t('series.expandAll')}</MenuItem>
        {menuStudy && <>
          <MenuDivider />
          <MenuItem action="study-remove" onClick={() => act(() => askStudy(menuStudy))}>{t('series.removeStudy')}</MenuItem>
          {menuPatient && patientStudies > 1 && <MenuItem action="patient-remove" onClick={() => act(() => askPatient(menuPatient))}>{t('series.removePatient')}</MenuItem>}
        </>}
        {series.length > 0 && <><MenuDivider /><MenuItem action="series-clear" onClick={() => act(askAll)}>{t('series.clearList')}</MenuItem></>}
      </Menu>
    </div>}
    {question && <RemoveDialog question={question} onRemove={() => onRemove(question.ids)} onClose={() => setQuestion(null)} />}
  </aside>;
}
