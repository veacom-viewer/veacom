// The texts in the image corners, as VEAcom Next puts them: who and when top left, what top right,
// where the slice lies bottom left, the scanner's settings bottom right.
import type { NmFrame, Series } from '../model';
import { t } from '../i18n';

/** A corner line, and a shorter form for when the full one does not fit (the full text stays in its title). */
/** `identity`: the line names the patient (name, birth date, institution); left out of basic (anonymous) exports. */
export interface CornerLine { text: string; short?: string; identity?: boolean }

/** 20240305 → 05.03.2024; anything else as stored. */
export const dicomDate = (value = '') => /^\d{8}$/.test(value) ? `${value.slice(6, 8)}.${value.slice(4, 6)}.${value.slice(0, 4)}` : value.trim();

/** 101530.25 → 10:15; nothing when it is not a time. */
export function dicomTime(value = ''): string {
  const digits = value.split('.')[0].trim();
  return /^\d{4}/.test(digits) ? `${digits.slice(0, 2)}:${digits.slice(2, 4)}` : '';
}

/** Patient's Age in its own unit: 045Y → 45y, 006M → 6 ay. */
export function ageText(value = '', translate = t): string {
  const match = /^(\d{1,3})([DWMY])$/.exec(value.trim().toUpperCase());
  return match ? translate(`age.${match[2] as 'D' | 'W' | 'M' | 'Y'}`, { n: Number(match[1]) }) : '';
}

export function sexText(value = '', translate = t): string {
  const code = value.trim().toUpperCase();
  return code === 'M' || code === 'F' || code === 'O' ? translate(`sex.${code}`) : code;
}

/** Like %g: 1.5 → 1.5, 3 → 3, 4.7600001 → 4.76. */
export const general = (value: number) => String(Number(value.toPrecision(6)));

/** Name (age sex), birth date, study date and time; with patient data hidden, age and sex alone. */
export function topLeftLines(series: Series, hidePatient: boolean, translate = t): CornerLine[] {
  const bits = [ageText(series.patientAgeText, translate), sexText(series.patientSex, translate)].filter(Boolean).join(' ');
  if (hidePatient) return bits ? [{ text: bits }] : [];
  const lines: CornerLine[] = [];
  const name = series.patientName.replaceAll('^', ' ').trim();
  const who = name && bits ? `${name} (${bits})` : name || bits;
  if (who) lines.push({ text: who, identity: Boolean(name) });
  const birth = dicomDate(series.patientBirthDate);
  if (birth) lines.push({ text: translate('viewport.birthDate', { date: birth }), short: birth, identity: true });
  const studyDate = dicomDate(series.studyDate);
  const when = [studyDate, dicomTime(series.studyTime)].filter(Boolean).join(' ');
  if (studyDate) lines.push({ text: translate('viewport.studyDate', { date: when }), short: when });
  return lines;
}

/** A gamma camera frame as NM readers name it: its view, then its detector, energy window and phase where the file
 * holds several ("ANT · Detector 1"). */
export function nmFrameText(frame: NmFrame | undefined, translate = t): string {
  if (!frame) return '';
  return [frame.view, frame.detector ? translate('nm.detector', { n: frame.detector }) : '', frame.energyWindow,
    frame.phase ? translate('nm.phase', { n: frame.phase }) : ''].filter(Boolean).join(' · ');
}

/** A phase as it is shown: the engine's label, or for a gate of a gated SPECT its R-R window where the file holds
 * several, its time slot and the time it counted, in the interface's language ("Gate 3/8 · 118 s acquired"). The time
 * is the gate's Time Slot Time, to three significant digits, never a delay after the R wave. */
export function phaseLabel(phase: NonNullable<Series['phase']>): string {
  const gate = phase.gate;
  if (!gate) return phase.label;
  const window = gate.interval === undefined ? ''
    : gate.beats ? t('nm.rrWindowBeats', { n: gate.interval, low: general(gate.beats[0]), high: general(gate.beats[1]) })
      : t('nm.rrWindow', { n: gate.interval });
  const time = gate.slotTime === undefined ? '' : t('nm.gateAcquired', { seconds: general(Number((gate.slotTime / 1000).toPrecision(3))) });
  return [window, t('nm.gate', { n: gate.slot, of: gate.slots }), time].filter(Boolean).join(' · ');
}

/** Institution, study and series descriptions (hidden with patient data), then modality and phase, and for a gamma
 * camera frame (`nm`) what it is. */
export function topRightLines(series: Series, hidePatient: boolean, nm?: NmFrame, translate = t): CornerLine[] {
  const texts = hidePatient ? [] : [series.institutionName, series.studyDescription, series.description]
    .map(text => text?.trim() ?? '').filter((text, index, all) => text && all.indexOf(text) === index);
  const institution = series.institutionName?.trim();
  const lines: CornerLine[] = texts.map(text => ({ text, identity: text === institution || undefined }));
  const frame = nmFrameText(nm, translate);
  if (series.modality) lines.push({ text: `${series.modality}${series.phase ? ` · ${phaseLabel(series.phase)}` : ''}${frame ? ` · ${frame}` : ''}` });
  return lines;
}

/** Slice thickness (where the acquired slices are shown) and where the slice lies, in mm. */
export function sliceDetail(thickness: number | undefined, location: number | null, translate = t): string {
  return [thickness ? translate('viewport.thickness', { value: thickness.toFixed(1) }) : '',
    location !== null ? translate('viewport.location', { value: location.toFixed(1) }) : ''].filter(Boolean).join('  ');
}

/** For MR: field strength, then TR and TE. */
export function scannerLines(series: Series): string[] {
  if (series.modality.toUpperCase() !== 'MR') return [];
  const lines: string[] = [];
  if (series.magneticFieldStrength) lines.push(`FS: ${general(series.magneticFieldStrength)}`);
  const timings = ([['TR', series.repetitionTime], ['TE', series.echoTime]] as const)
    .filter(([, value]) => value).map(([name, value]) => `${name}: ${general(value!)}`);
  if (timings.length) lines.push(timings.join(' '));
  return lines;
}
