// Windows in a series' own quantity: SUV for a PET that has what SUV needs (body weight, the same SUVbw as the fusion
// scale), HU for a CT. The renderer windows stored values with DICOM's linear function, so a window given in a
// quantity is turned into the exact centre and width that draw it: "SUV 0–5" on screen is what the pixels show.
import type { Series, ViewState } from '../model';
import { petHasSuv } from './emission';
import { general } from '../ui/overlayCorners';

export type QuantityUnit = 'SUV' | 'HU';
export interface QuantityWindow { unit: QuantityUnit; from: number; to: number }

/** What a stored value is multiplied by to read in `unit`, or null when the series has no such quantity. A PET without
 * SUV has none: nothing on it is called SUV. */
export function quantityScale(series: Series, unit: QuantityUnit): number | null {
  if (unit === 'HU') return series.modality === 'CT' && series.valueUnit === 'HU' ? 1 : null;
  if (!petHasSuv(series)) return null;
  return /^SUV/i.test(series.valueUnit) ? 1 : series.suvFactor;
}

/** Conversion from decoded pixels to SUV normalized by actual body weight. */
export function bodyWeightFactor(series: Series): number | null {
  if (!petHasSuv(series)) return null;
  if (/^SUVbw$/i.test(series.valueUnit)) return 1;
  if (/^SU[VL]/i.test(series.valueUnit)) return null;
  return quantityScale(series, 'SUV');
}

/** The centre and width (in stored values) that draw `from` as black and `to` as white: the inverse of
 * `windowGrey`'s linear function, (v - (c - 0.5)) / (w - 1) + 0.5. */
export function windowFor(series: Series, window: QuantityWindow): Pick<ViewState, 'windowCenter' | 'windowWidth'> | null {
  const scale = quantityScale(series, window.unit);
  if (!scale || !(window.to > window.from)) return null;
  const low = window.from / scale, high = window.to / scale;
  return { windowCenter: (low + high) / 2 + 0.5, windowWidth: high - low + 1 };
}

/** The window a view draws, in `unit`: where its grey starts and where it ends. */
export function windowIn(series: Series, view: Pick<ViewState, 'windowCenter' | 'windowWidth'>, unit: QuantityUnit): QuantityWindow | null {
  const scale = quantityScale(series, unit);
  if (!scale) return null;
  const half = (Math.max(1, view.windowWidth) - 1) / 2, middle = view.windowCenter - 0.5;
  return { unit, from: (middle - half) * scale, to: (middle + half) * scale };
}

/** The window that shows `view`'s range of `from` on series `to`, in `unit`: SUV 0–10 on one PET is SUV 0–10 on another,
 * whatever their own values per SUV. Null when either series lacks the quantity. */
export function sameRangeWindow(from: Series, view: Pick<ViewState, 'windowCenter' | 'windowWidth'>, to: Series, unit: QuantityUnit): Pick<ViewState, 'windowCenter' | 'windowWidth'> | null {
  const range = windowIn(from, view, unit);
  return range && range.to > range.from ? windowFor(to, range) : null;
}

/** A PET's window as it reads on screen, "SUV 0–5", when the PET has SUV; null otherwise (the W/L line stays). */
export function suvWindowText(series: Series, view: Pick<ViewState, 'windowCenter' | 'windowWidth'>): string | null {
  const window = windowIn(series, view, 'SUV');
  if (!window) return null;
  const round = (value: number) => general(Math.round(value * 10) / 10 || 0);
  return `SUV ${round(window.from)}–${round(window.to)}`;
}

/** The PET windows the presets menu offers in SUV, as nuclear medicine readers use them. */
export const SUV_PRESETS = [{ key: 'suv5', to: 5 }, { key: 'suv7', to: 7 }, { key: 'suv10', to: 10 }] as const;

/** The SUV preset a view shows, if any (to a tenth of an SUV). */
export function suvPresetFor(series: Series, view: Pick<ViewState, 'windowCenter' | 'windowWidth'>): typeof SUV_PRESETS[number] | undefined {
  const window = windowIn(series, view, 'SUV');
  return window && Math.abs(window.from) < 0.05 ? SUV_PRESETS.find(preset => Math.abs(window.to - preset.to) < 0.05) : undefined;
}

/** How a PET opens in any pane, as PET is read: inverted grey, SUV 0–5 when it has SUV, else its own window. */
export function petLook(series: Series): Partial<ViewState> {
  if (series.modality !== 'PT') return {};
  const window = windowFor(series, { unit: 'SUV', from: 0, to: 5 });
  return { inverted: true, palette: undefined, ...(window ? { ...window, windowMode: 'manual' as const } : {}) };
}
