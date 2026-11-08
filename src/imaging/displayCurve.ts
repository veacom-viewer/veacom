import type { DisplayCurve } from '../model';

export const DISPLAY_CURVES = { linear: 0, sqrt: 1, log: 2 } as const;

/** The logarithmic curve's constant k in log(1 + k·t) / log(1 + k). 9 makes it log10(1 + 9t), the log mapping Horos
 * (Horos/Sources/DefaultsOsiriX.m, "Logarithmic Table") and 3D Slicer (vtkImageMapToWindowLevelAddon.h,
 * "Logarithmic" scalar mapping) put on the windowed grey. Other viewers pick other constants (Weasis 2, Orthanc Stone
 * 255); no NM guideline names one. */
export const LOG_CURVE_K = 9;

/**
 * The display curve on a windowed grey t (0 to 1), as the slice shader draws it (src/imaging/sliceRenderer.ts): t
 * itself, its square root, or log(1 + k·t) / log(1 + k) with k = LOG_CURVE_K. Each keeps 0 at 0 and 1 at 1, so the
 * window's ends stay black and white and its upper end is still where the image saturates. It comes after the window,
 * VOI LUT or VOI function, and before inversion and the palette.
 */
export function curveGrey(t: number, curve: DisplayCurve = 'linear'): number {
  if (curve === 'sqrt') return Math.sqrt(t);
  if (curve === 'log') return Math.log1p(LOG_CURVE_K * t) / Math.log1p(LOG_CURVE_K);
  return t;
}
