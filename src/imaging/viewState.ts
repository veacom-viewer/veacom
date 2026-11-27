import type { Series, ViewState, VoiFunction, Volume } from '../model';

export function usesSourceFrames(series: Series, view: Pick<ViewState, 'mode'>): boolean {
  return view.mode === 'source' || !series.canReconstruct || series.sourceFramesOnly === true || series.components === 3;
}

/** DICOM PS3.3 C.11.2.1.2-3 permits any positive width for SIGMOID and LINEAR_EXACT. */
export function displayWindowWidth(width: number, curve?: VoiFunction): number {
  return Number.isFinite(width) && (curve ? width > 0 : width >= 1) ? width : 1;
}

export function resolveView(volume: Volume, view: ViewState): ViewState {
  // A projection pages through angles even while renderedView shows the single acquired preview frame.
  const source = usesSourceFrames(volume.series, view) || (volume.sourceFrameIndex !== undefined && !view.projection);
  const slice = source ? Math.max(0, Math.min(volume.series.dimensions[2] - 1, Math.round(view.slice))) : view.slice;
  let center = view.windowCenter, width = view.windowWidth, voiLut: number | undefined;
  const frame = volume.series.frameMetadata?.[slice];
  const frameHasWindow = Number.isFinite(frame?.windowWidth) && frame!.windowWidth! > 0;
  // The displayed frame's window curve shapes manual windows too: dragging changes the centre and width
  // of the same curve rather than jumping to a straight one. Reconstructed planes stay linear.
  const voiFunction = source && (!view.sharedWindow || view.windowMode === 'dicom')
    ? (frameHasWindow ? frame?.voiFunction : frame?.voiFunction ?? volume.series.voiFunction)
    : undefined;
  if (view.windowMode === 'dicom' && source) {
    center = Number.isFinite(frame?.windowCenter) ? frame!.windowCenter! : volume.series.windowCenter;
    width = frameHasWindow ? frame!.windowWidth! : volume.series.windowWidth;
    if (!Number.isFinite(center)) center = 0;
    // A frame without a window is shown with its own VOI LUT; the window is then the LUT's range, where manual changes start.
    if (frame?.voiLut !== undefined && !Number.isFinite(frame.windowWidth) && volume.series.voiLuts?.[frame.voiLut]) voiLut = frame.voiLut;
  }
  width = displayWindowWidth(width, voiFunction);
  if ((!source || (view.mode === 'source' && view.plane === 'axial' && !view.oblique?.some(Boolean)))
    && slice === view.slice && center === view.windowCenter && width === view.windowWidth && voiLut === view.voiLut && voiFunction === view.voiFunction) return view;
  return { ...view, ...(source ? { mode: 'source' as const, plane: 'axial' as const, oblique: undefined } : {}), slice, windowCenter: center, windowWidth: width, voiLut, voiFunction };
}

/**
 * The display grey (0 to 1) of a modality value through a window (PS3.3 C.11.2.1.2–3): LINEAR, as the
 * renderer has always drawn it, LINEAR_EXACT, or SIGMOID, 1 / (1 + exp(-4 (x - c) / w)).
 */
export function windowGrey(value: number, center: number, width: number, voiFunction?: VoiFunction): number {
  const w = displayWindowWidth(width, voiFunction);
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
  return resolveView(volume, { ...view, ...patch, ...(patch.windowMode === 'dicom' ? { sharedWindow: undefined } : {}), ...(manualWindow ? { windowMode: 'manual' as const } : {}) });
}

export function renderedView(volume: Volume, view: ViewState): ViewState {
  return resolveView(volume, volume.sourceFrameIndex === undefined ? view : { ...view, mode: 'source', slice: volume.sourceFrameIndex });
}
