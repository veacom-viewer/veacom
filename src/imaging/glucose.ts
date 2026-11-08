import type { PetAcquisition, Series } from '../model';
import { petTracer } from './petTracer';

/** The population average SULglu is normalised to. */
export const SULGLU_REFERENCE_MMOL = 5.0;
/** mg/dl in one mmol/l of glucose (DICOM CP-1229). */
export const GLUCOSE_MG_PER_MMOL = 18.0182;
export type GlucoseUnit = 'mmol' | 'mgdl';
export type GlucoseSource = 'file' | 'typed';
export interface StudyGlucose { mmol: number; source: GlucoseSource }
export const plausibleGlucose = (mmol: unknown): mmol is number =>
  typeof mmol === 'number' && Number.isFinite(mmol) && mmol > 0;

/** DICOM Acquisition Context has precedence over a reader's fallback for the study. */
export function studyGlucose(pet: PetAcquisition | undefined, typed?: number): StudyGlucose | null {
  if (plausibleGlucose(pet?.glucose)) return { mmol: pet.glucose, source: 'file' };
  return plausibleGlucose(typed) ? { mmol: typed, source: 'typed' } : null;
}

/** The glucose SULglu uses for a series shown in `unit`: an FDG PET shown in SUL, with a glucose; null otherwise. */
export function sulGluGlucose(series: Series, unit: string): StudyGlucose | null {
  if (unit !== 'SUL' || series.modality !== 'PT' || petTracer(series.petAcquisition) !== 'fdg') return null;
  return studyGlucose(series.petAcquisition, series.typedGlucose);
}

/** SULglu from SUL: SUL × glucose / 5.0 mmol/l. */
export const sulGlu = (sul: number, glucose: Pick<StudyGlucose, 'mmol'>) => sul * glucose.mmol / SULGLU_REFERENCE_MMOL;

/** A glucose the reader typed in `unit`, in mmol/l; null when it is not a number in the range a glucose can be. */
export function typedGlucoseMmol(text: string, unit: GlucoseUnit): number | null {
  const decimal = text.trim().replace(',', '.');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(decimal)) return null;
  const value = Number(decimal);
  const mmol = unit === 'mgdl' ? value / GLUCOSE_MG_PER_MMOL : value;
  return plausibleGlucose(mmol) ? mmol : null;
}

/** A glucose in mmol/l as the reader types it in `unit`: up to two decimals in mmol/l, whole mg/dl. */
export const glucoseInUnit = (mmol: number, unit: GlucoseUnit) => unit === 'mgdl' ? String(Math.round(mmol * GLUCOSE_MG_PER_MMOL)) : String(Math.round(mmol * 100) / 100);

/** A glucose as the panel shows it: in mmol/l, to at most two decimals, and in mg/dl. */
export const glucoseText = (mmol: number) => `${Math.round(mmol * 100) / 100} mmol/l (${Math.round(mmol * GLUCOSE_MG_PER_MMOL)} mg/dl)`;
