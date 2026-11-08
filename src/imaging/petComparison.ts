// Serial FDG PET QC. EANM v3 supplements 3 and 4 govern uptake time.
// UPICT Oncology v2 §4.2.2 defines a significant fasting glucose change as >50% from baseline.
import type { PetAcquisition } from '../model';
import type { PetSeriesRecord } from '../domain/petStudies';
import { t } from '../i18n';
import { dicomDate, general } from '../ui/overlayCorners';
import { glucoseText, studyGlucose, type StudyGlucose } from './glucose';
import { FDG_GLUCOSE_MMOL } from './petAcquisition';
import { petTracer } from './petTracer';

/** Supplemental File 3: a repeat study's uptake time within 10 min of the prior's. */
export const REPEAT_UPTAKE_SECONDS = 10 * 60;
const LIMITED_UPTAKE_SECONDS = 5 * 60;
const GLUCOSE_CHANGE_FRACTION = 0.5;
const uptakeLimit = (limited: boolean) => limited ? LIMITED_UPTAKE_SECONDS : REPEAT_UPTAKE_SECONDS;

/** What a study is compared on: whether it is FDG, its uptake time (s), scanner model, reconstruction and glucose. */
export interface Compared { fdg: boolean; uptakeSeconds?: number; scannerModel?: string; reconstruction?: string; glucose: StudyGlucose | null }
/** The prior a PET is compared with: its study date (YYYYMMDD), whether it was kept on this computer rather than
 * loaded, and what it recorded. */
export interface PetPrior { date: string; kept: boolean; acquisition: Compared }

const text = (value: string | undefined) => value?.trim() || undefined;
const seconds = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;

/** A loaded PET as compared, with the glucose the reader typed for its study. */
export function compared(pet: PetAcquisition | undefined, typed?: number): Compared {
  return { fdg: petTracer(pet) === 'fdg', uptakeSeconds: seconds(pet?.uptakeSeconds), scannerModel: text(pet?.scannerModel),
    reconstruction: text(pet?.reconstruction), glucose: studyGlucose(pet, typed) };
}

/** A PET kept on this computer (src/domain/petStudies.ts) as compared, with the glucose typed for its study. */
export function keptCompared(record: PetSeriesRecord, typed?: number): Compared {
  const kept = record.acquisition ?? {};
  return { fdg: record.tracer === 'fdg', uptakeSeconds: seconds(kept.uptakeSeconds), scannerModel: text(kept.scannerModel),
    reconstruction: text(kept.reconstruction), glucose: studyGlucose({ glucose: kept.glucose }, typed) };
}

export type ComparisonFlag = 'priorUptake' | 'priorScanner' | 'priorReconstruction' | 'priorGlucoseHigh' | 'priorGlucoseLow' | 'glucoseChange';

/** Shared by both panels. A change in the readings or uptake tolerance shows the caution again. */
export const comparisonKey = (seriesId: string, prior: PetPrior, current: Compared, limited: boolean) =>
  JSON.stringify(['pet-comparison', seriesId, prior.date, prior.acquisition, current, limited]);

/** Two recorded names alike but for case and spacing. */
const alike = (a: string, b: string) => a.replace(/\s+/g, ' ').toUpperCase() === b.replace(/\s+/g, ' ').toUpperCase();

/** The limited-view tolerance applies to the follow-up, regardless of the prior's coverage. */
export function comparisonFlags(current: Compared, prior: Compared, limited = false): ComparisonFlag[] {
  const flags: ComparisonFlag[] = [];
  if (current.fdg && prior.fdg && current.uptakeSeconds !== undefined && prior.uptakeSeconds !== undefined
    && Math.abs(current.uptakeSeconds - prior.uptakeSeconds) > uptakeLimit(limited)) flags.push('priorUptake');
  if (current.scannerModel && prior.scannerModel && !alike(current.scannerModel, prior.scannerModel)) flags.push('priorScanner');
  if (current.reconstruction && prior.reconstruction && !alike(current.reconstruction, prior.reconstruction)) flags.push('priorReconstruction');
  const glucose = prior.glucose?.mmol;
  if (prior.fdg && glucose !== undefined) {
    if (glucose >= FDG_GLUCOSE_MMOL.high) flags.push('priorGlucoseHigh');
    else if (glucose < FDG_GLUCOSE_MMOL.low) flags.push('priorGlucoseLow');
  }
  if (current.fdg && prior.fdg && current.glucose && prior.glucose) {
    const baseline = prior.glucose.mmol;
    const difference = Math.abs(current.glucose.mmol - baseline);
    // Exactly 50% remains inside the limit, including decimal mmol/l and converted mg/dl.
    if (difference > baseline * (GLUCOSE_CHANGE_FRACTION + Number.EPSILON)) flags.push('glucoseChange');
  }
  return flags;
}

/** The uptake times' difference in minutes, rounded up to a tenth, so a flagged difference never reads as 10. */
export const uptakeDifference = (current: Compared, prior: Compared) =>
  Math.ceil(Math.abs(current.uptakeSeconds! - prior.uptakeSeconds!) / 6) / 10;

/** A comparison flag as the panel and the lesion table say it. */
export function comparisonText(flag: ComparisonFlag, current: Compared, prior: PetPrior, limited = false, translate = t): string {
  const date = dicomDate(prior.date);
  if (flag === 'priorUptake') return translate('pet.flag.priorUptake', { date, difference: general(uptakeDifference(current, prior.acquisition)), limit: uptakeLimit(limited) / 60 });
  if (flag === 'glucoseChange') return translate('pet.flag.glucoseChange', { before: general(Math.round(prior.acquisition.glucose!.mmol * 100) / 100), now: general(Math.round(current.glucose!.mmol * 100) / 100) });
  if (flag === 'priorGlucoseHigh' || flag === 'priorGlucoseLow') return translate(`pet.flag.${flag}`, { date, glucose: general(Math.round(prior.acquisition.glucose!.mmol * 100) / 100),
    limit: flag === 'priorGlucoseHigh' ? FDG_GLUCOSE_MMOL.high : FDG_GLUCOSE_MMOL.low });
  return translate(`pet.flag.${flag}`, { date });
}

export interface PriorRow { key: 'uptake' | 'scanner' | 'reconstruction' | 'glucose'; value: string | null; source?: StudyGlucose['source'] }

/** The prior's rows in the panel, as this study's own rows read; null where it recorded nothing. */
export function comparisonRows({ uptakeSeconds, scannerModel, reconstruction, glucose }: Compared, translate = t): PriorRow[] {
  return [
    { key: 'uptake', value: uptakeSeconds === undefined ? null : translate('pet.minutes', { minutes: general(uptakeSeconds / 60) }) },
    { key: 'scanner', value: scannerModel ?? null },
    { key: 'reconstruction', value: reconstruction ?? null },
    { key: 'glucose', value: glucose ? glucoseText(glucose.mmol) : null, ...(glucose ? { source: glucose.source } : {}) },
  ];
}
