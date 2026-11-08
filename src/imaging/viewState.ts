import type { Series, ViewState, VoiFunction, Volume } from '../model';

export function usesSourceFrames(series: Series, view: Pick<ViewState, 'mode'>): boolean {
  return view.mode === 'source' || !series.canReconstruct || series.sourceFramesOnly === true || series.components === 3;
}

export function resolveView(volume: Volume, view: ViewState): ViewState {
  const source = volume.sourceFrameIndex !== undefined || usesSourceFrames(volume.series, view);
  const slice = source ? Math.max(0, Math.min(volume.series.dimensions[2] - 1, Math.round(view.slice))) : view.slice;
  let center = view.windowCenter, width = view.windowWidth, voiLut: number | undefined;
  // The displayed frame's window curve shapes manual windows too: dragging changes the centre and width
  // of the same curve rather than jumping to a straight one. Reconstructed planes stay linear.
  const voiFunction = source && !view.sharedWindow ? volume.series.frameMetadata?.[slice]?.voiFunction : undefined;
  if (view.windowMode === 'dicom' && source) {
    const frame = volume.series.frameMetadata?.[slice];
    center = Number.isFinite(frame?.windowCenter) ? frame!.windowCenter! : volume.series.windowCenter;
    width = Number.isFinite(frame?.windowWidth) && frame!.windowWidth! > 0 ? frame!.windowWidth! : volume.series.windowWidth;
    if (!Number.isFinite(center)) center = 0;
    if (!Number.isFinite(width) || width <= 0) width = 1;
    // A frame without a window is shown with its own VOI LUT; the window is then the LUT's range, where manual changes start.
    if (frame?.voiLut !== undefined && !Number.isFinite(frame.windowWidth) && volume.series.voiLuts?.[frame.voiLut]) voiLut = frame.voiLut;
  }
  if ((!source || (view.mode === 'source' && view.plane === 'axial' && !view.oblique?.some(Boolean)))
    && slice === view.slice && center === view.windowCenter && width === view.windowWidth && voiLut === view.voiLut && voiFunction === view.voiFunction) return view;
  return { ...view, ...(source ? { mode: 'source' as const, plane: 'axial' as const, oblique: undefined } : {}), slice, windowCenter: center, windowWidth: width, voiLut, voiFunction };
}

/**
 * The display grey (0 to 1) of a modality value through a window (PS3.3 C.11.2.1.2–3): LINEAR, as the
 * renderer has always drawn it, LINEAR_EXACT, or SIGMOID, 1 / (1 + exp(-4 (x - c) / w)).
 */
export function windowGrey(value: number, center: number, width: number, voiFunction?: VoiFunction): number {
  const w = Math.max(1, width);
  if (voiFunction === 'SIGMOID') return 1 / (1 + Math.exp(-4 * (value - center) / w));
  if (voiFunction === 'LINEAR_EXACT') return Math.min(1, Math.max(0, (value - center) / w + 0.5));
  if (w <= 1) return value > center - 0.5 ? 1 : 0;
  return Math.min(1, Math.max(0, (value - (center - 0.5)) / (w - 1) + 0.5));
}

/** The display grey (0 to 1) of a modality value through a VOI LUT: the nearest entry, clamped at both ends. */
export function voiGrey(lut: { first: number; bits: number; data: ArrayLike<number> }, value: number): number {
  const index = Math.max(0, Math.min(lut.data.length - 1, Math.round(value) - lut.first));
  return lut.data[index] / (2 ** lut.bits - 1);
}

export function patchView(volume: Volume, view: ViewState, patch: Partial<ViewState>): ViewState {
  const manualWindow = patch.windowMode === undefined && (patch.windowWidth !== undefined || patch.windowCenter !== undefined);
  return resolveView(volume, { ...view, ...patch, ...(manualWindow ? { windowMode: 'manual' as const } : {}) });
}

export function renderedView(volume: Volume, view: ViewState): ViewState {
  return resolveView(volume, volume.sourceFrameIndex === undefined ? view : { ...view, mode: 'source', slice: volume.sourceFrameIndex });
}
