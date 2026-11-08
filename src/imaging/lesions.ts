// The lesion table's primitives: a lesion is a sphere VOI that is no reference region. It keeps the name it was given
// when drawn (L1, L2…), its values are kept in SUVbw with the ratios that read them in SUL or SUVbsa, and it is
// compared with a prior lesion selected by the reader.
import type { Annotation, Series, Volume } from '../model';
import type { LesionValues, PetSeriesRecord } from '../domain/petStudies';
import { bodyWeightFactor } from './quantity';
import { sphereStatisticsFor, thresholdVolumeFor, type Quantity, type SphereStatistics } from './voi';

export const isLesion = (annotation: Annotation) => annotation.type === 'sphere' && !annotation.role;
const NUMBERED = /^L(\d+)$/;

/** The measurements with every unnamed lesion named after the highest name in use (L1, L2…), so names stay put when a
 * lesion is deleted and when another lesion is drawn. */
export function nameLesions(annotations: readonly Annotation[]): Annotation[] {
  if (!annotations.some(item => isLesion(item) && !item.label)) return annotations as Annotation[];
  let highest = 0;
  for (const item of annotations) { const match = item.type === 'sphere' ? NUMBERED.exec(item.label ?? '') : null; if (match) highest = Math.max(highest, Number(match[1])); }
  return annotations.map(item => isLesion(item) && !item.label ? { ...item, label: `L${++highest}` } : item);
}

/** SUVbw, the quantity kept values are in; null for a series without SUV. */
export function bodyWeight(series: Series): Quantity | null {
  const factor = bodyWeightFactor(series);
  return factor ? { factor, unit: 'SUVbw' } : null;
}

/** A lesion's values in SUVbw: max, mean, peak, and MTV and TLG at its threshold. Null without SUV or a whole volume. */
export function lesionValues(annotation: Annotation, volume: Volume, quantity = bodyWeight(volume.series)): LesionValues | null {
  if (!quantity) return null;
  const stats = sphereStatisticsFor(annotation, volume, quantity);
  if (!stats) return null;
  return measuredValues({ ...stats, metabolic: annotation.threshold ? thresholdVolumeFor(annotation, volume, quantity) : null });
}

export function measuredValues(stats: SphereStatistics | null | undefined): LesionValues | null {
  if (!stats) return null;
  const values: LesionValues = { max: stats.max, mean: stats.mean };
  if (stats.peak) values.peak = stats.peak.value;
  const metabolic = stats.metabolic;
  if (metabolic && !metabolic.selectionRequired) { values.mtv = metabolic.mtvMl; if (metabolic.tlg !== undefined) values.tlg = metabolic.tlg; }
  return values;
}

/** SUL and SUVbsa per SUVbw on a series, where it has them. */
export function seriesRatios(series: Series): Pick<PetSeriesRecord, 'sulPerBw' | 'bsaPerBw'> {
  const bw = bodyWeight(series)?.factor, ratios: Pick<PetSeriesRecord, 'sulPerBw' | 'bsaPerBw'> = {};
  const ratio = (factor: number | null | undefined) => bw && factor != null && Number.isFinite(factor) && factor > 0 ? factor / bw : undefined;
  const sul = ratio(series.sulFactor), bsa = ratio(series.suvBsaFactor);
  if (sul) ratios.sulPerBw = sul;
  if (bsa) ratios.bsaPerBw = bsa;
  return ratios;
}

/** Kept SUVbw values read in `unit` (SUVbw, SUL or SUVbsa) with the ratios kept beside them; null when they cannot be.
 * MTV is a volume: the same in any SUV. */
export function valuesIn(values: LesionValues, unit: string, ratios: Pick<PetSeriesRecord, 'sulPerBw' | 'bsaPerBw'>): LesionValues | null {
  const ratio = unit === 'SUVbw' ? 1 : unit === 'SUL' ? ratios.sulPerBw : unit === 'SUVbsa' ? ratios.bsaPerBw : undefined;
  if (!ratio) return null;
  const read: LesionValues = { max: values.max * ratio, mean: values.mean * ratio };
  if (values.peak !== undefined) read.peak = values.peak * ratio;
  if (values.mtv !== undefined) read.mtv = values.mtv;
  if (values.tlg !== undefined) read.tlg = values.tlg * ratio;
  return read;
}

/** The change from `before` to `now`, in per cent; null when it cannot be told. */
export function percentChange(now: number | undefined, before: number | undefined): number | null {
  if (now === undefined || before === undefined || !Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
  return (now - before) / before * 100;
}

/** A change in per cent as the lesion table writes it, whole: "−30%" in English and "−%30" in Turkish, with no sign
 * when it rounds to nothing. */
export function percentText(value: number, locale: string): string {
  const sign = value > 0.05 ? '+' : value < -0.05 ? '−' : '', amount = Math.abs(value).toFixed(0);
  return locale === 'tr' ? `${sign}%${amount}` : `${sign}${amount}%`;
}
