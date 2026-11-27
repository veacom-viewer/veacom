import { useState } from 'react';
import { GripVertical, Layers, Link2, LoaderCircle, Maximize2, Minimize2, X } from './icons';
import { SliceBar } from './SliceBar';
import { Viewport } from './Viewport';
import { useTranslation } from '../i18n/react';
import { isProjection, projectionAngle, sliceCount } from '../imaging/geometry';
import { placed, sharePlaneSpace } from '../imaging/linking';
import { pagingPlace, placeInSequence, shownSlice, stackSliceAt } from '../imaging/paging';
import { suvWindowText } from '../imaging/quantity';
import { alignedTransform, type Alignment } from '../imaging/registration';
import { renderedView, resolveView, usesSourceFrames } from '../imaging/viewState';
import type { Annotation, FusionSettings, Joined, SegmentationOverlay, Series, Tool, Vec3, ViewportProps, ViewState, Volume } from '../model';
import { general } from '../ui/overlayCorners';
import { seriesName } from '../ui/seriesNames';
import { draggedSeries, PANE_DRAG, type PaneToast, type Settings, type Slot } from '../ui/workspaceHelpers';

export function ViewportCell({ slot, index, paneCount, volume, metadata, active, tool, annotations, crosshair, fusion, segmentations, loading, loadError, linked, interaction, references, joined, onCross, alignments, aligned,
  onActivate, onViewChange, onAnnotationsChange, onCrosshairChange, onDropSeries, onClose, onMaximize, onRestore, onCyclePlane, onFusionAdjust, onRotateReference, clickPicksPoint, span, onSwap, toast, caliper }: {
  slot: Slot; index: number; paneCount: number; volume: Volume | undefined; metadata: Series | undefined; active: boolean; tool: Tool; segmentations: SegmentationOverlay[];
  annotations: Annotation[]; crosshair: Vec3 | null; fusion: FusionSettings | null; loading: boolean; loadError?: string; linked: boolean;
  interaction: Settings; references: { id: string; series: Series; view: ViewState; color?: string }[];
  /** Frames of reference aligned (imaging/registration.ts): another pane's plane in an aligned frame is drawn here too. */
  alignments: readonly Alignment[];
  /** This pane shows a series, or a fused overlay, placed by an alignment: said in its corner. */
  aligned?: 'automatic' | 'adjusted';
  /** The stack and its reference image this pane pages as one sequence, and the way to the place of it that the
   * other of the two holds. */
  joined: Joined | null; onCross: (id: string, place: number) => void;
  onActivate: (id: string) => void; onViewChange: (id: string, patch: Partial<ViewState>) => void;
  onAnnotationsChange: (seriesId: string, annotations: Annotation[]) => void;
  onRotateReference?: ViewportProps['onRotateReference']; clickPicksPoint?: boolean;
  /** The last pane widens over the columns the grid has no pane for. */
  span?: number; onSwap: (from: string, to: string) => void;
  /** A short note in this pane (what was just put in it, or the arrangement it belongs to), with an undo or a keep. */
  toast?: PaneToast;
  onFusionAdjust: (next: { upperSuv: number; opacity: number }) => void;
  onCrosshairChange: (point: Vec3) => void; onDropSeries: (slotId: string, seriesIds: string[]) => void;
  onClose: (id: string) => void; onMaximize: (id: string) => void; onCyclePlane: (id: string) => void;
  /** Set while this pane is maximized: back to the layout it came from. */
  onRestore?: () => void;
  /** A CLOSE caliper under way here: what to click next. */
  caliper?: ViewportProps['caliper'];
}) {
  const { t } = useTranslation();
  const activate = () => onActivate(slot.id);
  const update = (patch: Partial<ViewState>) => onViewChange(slot.id, patch);
  const annotate = (next: Annotation[]) => { if (slot.seriesId) onAnnotationsChange(slot.seriesId, next); };
  const cyclePlane = () => onCyclePlane(slot.id);
  const cross = (place: number) => onCross(slot.id, place);
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
  // The bar and the counter go in paging order: an axial stack from the top down (see paging.ts). A stack and its
  // reference image are one sequence in both (`joined`).
  const atSlice = Math.min(requestedView.slice, count - 1);
  const at = volume ? placeInSequence(volume.series, requestedView, atSlice, count, joined) : { place: atSlice, total: count };
  const shown = volume ? shownSlice(volume.series, displayView, Math.min(displayView.slice, count - 1), count, joined) : { number: atSlice + 1, total: count };
  /** The slice bar moved to a place: a slice of this series, or the place the other of a stack and its reference image holds. */
  const toPlace = (place: number) => {
    if (!volume) return;
    if (!joined) update({ slice: pagingPlace(volume.series, requestedView, place, count) });
    else if (joined.lead ? place !== joined.leadAt : place === joined.leadAt) cross(place);
    else if (!joined.lead) update({ slice: stackSliceAt(volume.series, requestedView, place, count, joined) });
  };
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
        showPointerValue={interaction.showPointerValue}
        mouseBindings={interaction.mouseBindings} wheelAction={interaction.wheelAction} touchpadSpeed={interaction.touchpadSpeed} reverseWheel={interaction.reverseWheel}
        showOverlay={interaction.showOverlay} showScale={interaction.showScale} hidePatientData={interaction.hidePatientData} hideMeasurements={interaction.hideMeasurements} segmentations={segmentations} onCyclePlane={cyclePlane} joined={joined} onCross={cross} aligned={aligned} caliper={caliper} />
        : <div className="empty-viewport" data-export-exclude>{loading ? <LoaderCircle size={22} /> : <Layers size={24} strokeWidth={1.4} />}
          <span>{loading ? t('viewport.opening') : metadata?.dimensions[2] === 0 ? t('series.noImages') : t('viewport.selectOrDrag')}</span></div>}
      {toast && <div className="pane-toast" role="status" data-export-exclude><span>{toast.text}</span>
        {toast.onUndo && (toast.undoAction === 'arrangement' ? <button type="button" data-action="arrangement-undo" onClick={toast.onUndo}>{t('pair.undo')}</button>
          : toast.undoAction === 'alignment' ? <button type="button" data-action="alignment-undo" onClick={toast.onUndo}>{t('pair.undo')}</button>
          : toast.undoAction === 'checklist-show' ? <button type="button" data-action="checklist-show-undo" onClick={toast.onUndo}>{t('pair.undo')}</button>
          : <button type="button" data-action="pair-undo" onClick={toast.onUndo}>{t('pair.undo')}</button>)}
        {toast.onKeep && (toast.keepAction === 'keep-plain' ? <button type="button" data-action="arrangement-keep-plain" onClick={toast.onKeep}>{t('arrangement.keep')}</button>
          : <button type="button" data-action="arrangement-keep" onClick={toast.onKeep}>{t('arrangement.keep')}</button>)}
        {toast.onOpen && <button type="button" data-action="compare-open" onClick={toast.onOpen}>{t('compare.open')}</button>}</div>}
      {loadError && <div className="viewport-error" role="status" data-export-exclude>{volume ? t('viewport.previewOnly') : ''}{loadError}</div>}
    </div>
    {volume && <footer className="viewport-footer" data-export-exclude>
      <span data-export-label>{projected ? `${projectionAngle(displayView.slice)}°` : <>{shown.number} / {shown.total}{loading ? t('viewport.sourceFramesSuffix', { count: metadata?.dimensions[2] ?? '?' }) : ''}</>}</span>
      <SliceBar count={at.total} position={at.place} valueText={projected ? `${projectionAngle(at.place)}°` : `${shownSlice(volume.series, requestedView, atSlice, count, joined).number} / ${at.total}`}
        label={projected ? t('projection.slider') : usesSourceFrames(volume.series, requestedView) ? t('viewport.sourceFrameSlider') : t('viewport.sliceSlider', { plane: t(`planeLower.${requestedView.plane}` as const) })}
        onPosition={toPlace} touchpadSpeed={interaction.touchpadSpeed} />
      <span data-export-label>{displayView.voiLut !== undefined ? t('viewport.voiLut') : windowText ?? `W ${general(displayView.windowWidth)} · L ${general(displayView.windowCenter)}${displayView.voiFunction ? ` · ${t(displayView.voiFunction === 'SIGMOID' ? 'viewport.sigmoid' : 'viewport.linearExact')}` : ''}`}</span>
      <span className="zoom-indicator">{Math.round(displayView.zoom * 100)}%</span>
    </footer>}
  </section>;
}
