// The PET acquisition panel (inspector, Findings): what a PET records of its tracer, the injection and the patient, and
// what a nuclear medicine reader checks before trusting its SUV, after EANM's FDG tumour imaging guideline, version 3.0
// (Boellaard et al., The EANM Journal 2025;1:100006): the weight, height and sex SUV and SUL need, the injected activity
// and times are there, and an FDG scan started within the uptake window, with blood glucose in range.
import type { PetAcquisition, Series } from '../model';
import { t } from '../i18n';
import { petTracer } from './petTracer';
import { dicomDate, dicomTime, general } from '../ui/overlayCorners';
import { glucoseText, plausibleGlucose } from './glucose';

/** EANM version 3.0, Supplemental File 3, after the QIBA FDG PET/CT profile (Kinahan et al., Radiology 2020;294:647–57):
 * "a 60 min interval is recommended with an acceptable range of 55 – 75 min" from the injection to the start of
 * acquisition, as version 2.0 (2015) had it. Its "within 10 min" is for a patient's repeat studies, against each other. */
export const FDG_UPTAKE_MINUTES = { from: 55, to: 75 } as const;
/** EANM version 3.0, section 9.4: with plasma glucose below 11 mmol/l an FDG study can be performed; at or above it, it
 * should ideally be rescheduled; on arrival glucose should not be below 4 mmol/l. */
export const FDG_GLUCOSE_MMOL = { low: 4, high: 11 } as const;
/** Patient's Size the engine takes as metres for SUL and SUVbsa (native/src/ingest.rs, body_size_ratios). */
const HEIGHT_METRES = { from: 0.3, to: 2.5 } as const;
/** Bq in one millicurie. */
const BQ_PER_MCI = 3.7e7;
export const isFdg = (pet: PetAcquisition) => petTracer(pet) === 'fdg';

/** Use a typed value for the panel and its checks only when DICOM has no glucose. */
export const withTypedGlucose = (pet: PetAcquisition, typed?: number): PetAcquisition =>
  !plausibleGlucose(pet.glucose) && plausibleGlucose(typed) ? { ...pet, glucose: typed } : pet;

const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
/** DICOM writes superscripts between carets: "F^18^" → "F¹⁸". */
export const superscripts = (text: string) => text.replace(/\^(\d+)\^/g, (_, digits: string) => [...digits].map(digit => SUPERSCRIPTS[Number(digit)]).join(''));

/** The minutes from the injection to the scan start, when both are known and in order. */
export const uptakeMinutes = (pet: PetAcquisition) => pet.uptakeSeconds !== undefined && Number.isFinite(pet.uptakeSeconds) ? pet.uptakeSeconds / 60 : null;

export type PetFlag = 'multipleAdministrations' | 'weight' | 'height' | 'heightUnit' | 'sex' | 'activity' | 'injectionTime' | 'scanStart' | 'uptakeUnknown' | 'uptakeRange'
  | 'glucoseHigh' | 'glucoseLow';

/** What is missing or outside the guideline (EANM version 3.0): no weight, a height missing or not in metres, no male or
 * female sex (the guideline asks for all three; SUL needs them), no injected activity, no injection time or scan start
 * (or times that give no uptake), and for FDG an uptake time outside 55–75 min or blood glucose at or above 11 mmol/l or
 * below 4 mmol/l. `sex`: Patient's Sex (Series.patientSex). */
export function petFlags(pet: PetAcquisition, sex?: string): PetFlag[] {
  const flags: PetFlag[] = [];
  if (!(pet.weight! > 0)) flags.push('weight');
  if (!(pet.height! > 0)) flags.push('height');
  else if (pet.height! < HEIGHT_METRES.from || pet.height! > HEIGHT_METRES.to) flags.push('heightUnit');
  if (!/^[MF]$/i.test(sex?.trim() ?? '')) flags.push('sex');
  if (pet.multipleAdministrations) flags.push('multipleAdministrations');
  else if (!(pet.injectedActivity! > 0)) flags.push('activity');
  const injection = Boolean(pet.injectionDateTime?.trim() || pet.injectionTime?.trim());
  if (!injection && !pet.multipleAdministrations) flags.push('injectionTime');
  if (!pet.scanStart) flags.push('scanStart');
  const minutes = uptakeMinutes(pet);
  if (minutes === null && injection && pet.scanStart) flags.push('uptakeUnknown');
  if (minutes !== null && isFdg(pet) && (minutes < FDG_UPTAKE_MINUTES.from || minutes > FDG_UPTAKE_MINUTES.to)) flags.push('uptakeRange');
  const glucose = pet.glucose;
  if (glucose !== undefined && glucose > 0 && isFdg(pet)) {
    if (glucose >= FDG_GLUCOSE_MMOL.high) flags.push('glucoseHigh');
    else if (glucose < FDG_GLUCOSE_MMOL.low) flags.push('glucoseLow');
  }
  return flags;
}

/** A flag as the panel says it. */
export function flagText(flag: PetFlag, pet: PetAcquisition, translate = t): string {
  if (flag === 'uptakeRange') return translate('pet.flag.uptakeRange', { minutes: general(uptakeMinutes(pet)!), ...FDG_UPTAKE_MINUTES });
  if (flag === 'heightUnit') return translate('pet.flag.heightUnit', { height: general(pet.height!) });
  if (flag === 'glucoseHigh') return translate('pet.flag.glucoseHigh', { glucose: general(pet.glucose!), limit: FDG_GLUCOSE_MMOL.high });
  if (flag === 'glucoseLow') return translate('pet.flag.glucoseLow', { glucose: general(pet.glucose!), limit: FDG_GLUCOSE_MMOL.low });
  return translate(`pet.flag.${flag}` as const);
}

/** "YYYYMMDD" of a DICOM date-time, if it has one. */
const dayOf = (value?: string) => /^\d{8}/.exec(value?.trim() ?? '')?.[0];

/** The injection and scan start as clock times, with their dates only when the two fall on different days. */
function times(pet: PetAcquisition): { injection: string | null; scan: string | null } {
  const injectionDay = dayOf(pet.injectionDateTime), scanDay = dayOf(pet.scanStart);
  const zone = (value?: string) => {
    const offset = value?.match(/([+-])(\d{2})(\d{2})$/);
    return offset ? ` UTC${offset[1]}${offset[2]}:${offset[3]}` : '';
  };
  const clock = (day: string | undefined, time: string) => (injectionDay && scanDay && injectionDay !== scanDay && day ? `${dicomDate(day)} ` : '') + dicomTime(time);
  const injection = pet.injectionDateTime && injectionDay ? clock(injectionDay, pet.injectionDateTime.slice(8)) : pet.injectionTime ? dicomTime(pet.injectionTime) : '';
  const scan = pet.scanStart && scanDay ? clock(scanDay, pet.scanStart.slice(8)) : '';
  return { injection: injection ? injection + (zone(pet.injectionDateTime) || zone(pet.injectionOffset)) : null,
    scan: scan ? scan + zone(pet.scanStart) : null };
}

export interface PetRow { key: 'tracer' | 'activity' | 'injection' | 'scanStart' | 'uptake' | 'weight' | 'height' | 'glucose' | 'scanner' | 'reconstruction'; value: string | null }

/** The panel's rows in reading order; null where the file records nothing. */
export function petRows(pet: PetAcquisition, translate = t): PetRow[] {
  const tracer = [pet.tracer, pet.tracerCodeMeaning, pet.radionuclide].map(text => text?.trim()).find(Boolean);
  const activity = pet.injectedActivity! > 0 ? `${general(Math.round(pet.injectedActivity! / 1e5) / 10)} MBq (${general(Math.round(pet.injectedActivity! / BQ_PER_MCI * 100) / 100)} mCi)` : null;
  const minutes = uptakeMinutes(pet), { injection, scan } = times(pet);
  return [
    { key: 'tracer', value: tracer ? superscripts(tracer) : null },
    { key: 'activity', value: activity },
    { key: 'injection', value: injection },
    { key: 'scanStart', value: scan },
    { key: 'uptake', value: minutes === null ? null : translate('pet.minutes', { minutes: general(minutes) }) },
    { key: 'weight', value: pet.weight! > 0 ? `${general(pet.weight!)} kg` : null },
    { key: 'height', value: pet.height! > 0 ? `${general(pet.height!)} m` : null },
    { key: 'glucose', value: pet.glucose! > 0 ? glucoseText(pet.glucose!) : null },
    { key: 'scanner', value: pet.scannerModel?.trim() || null },
    { key: 'reconstruction', value: pet.reconstruction?.trim() || null },
  ];
}

/** The PET whose acquisition the panel shows: the active series when it is a PET, else the PET fused in its study. */
export function panelPet(active: Series | null | undefined, fused: Series | null | undefined): Series | null {
  if (active?.modality === 'PT') return active;
  return fused?.modality === 'PT' && active && fused.studyUid === active.studyUid ? fused : null;
}
