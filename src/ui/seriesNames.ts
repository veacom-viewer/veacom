// What a series is listed as when its own name does not say (as in VEAcom Next): the likely MR sequence with the plane
// it was taken in, and the order a study named only by site codes is listed in. Used by the series list and menu.
import type { Plane, Series } from '../model';
import { acquiredPlane } from '../imaging/geometry';
import { inferSequence, ROLE_NAMES, type SequenceRole } from '../domain/clinical';
import { t } from '../i18n';
import { phaseLabel } from './overlayCorners';

/** A description that says what the series shows; a site's own code ("OBR", "BOC", "MR", "OBL") does not. */
export const INFORMATIVE = /T1|T2|FLAIR|STIR|DWI|DIFF|ADC|TRACE|\bPD\b|SWI|FIESTA|CISS|TOF|MPRAGE|MP-RAGE|BRAVO|VIBE|LAVA|SPACE|CUBE|FSE|TSE|GRE|PERF|MRA|SSFP|B-?FFE|DRIVE/i;

export type Guess = { role: SequenceRole; plane: Plane | null; label: string };

export { patientKey, studyKey } from '../domain/patient';

/** For an MR series, the sequence its acquisition suggests (experimental) with the plane it was taken in, as
 * VEAcom Next names it: "T2 Aksiyel", "T1 Koronal C+"; diffusion without a plane. */
export function sequenceGuess(item: Series, translate = t): Guess | null {
  if (item.modality !== 'MR') return null;
  try {
    const role = inferSequence(item, translate).role;
    if (!role) return null;
    const plane = role === 'dwi' || role === 'adc' ? null : acquiredPlane(item);
    // A diffusion series says its b-value, as VEAcom Next names it ("DWI b1000").
    const b = role === 'dwi' && item.diffusionBValue != null ? `b${item.diffusionBValue}` : '';
    return { role, plane, label: [role === 't1c' ? ROLE_NAMES.t1 : ROLE_NAMES[role], plane && translate(`plane.${plane}` as const), b, role === 't1c' && 'C+'].filter(Boolean).join(' ') };
  } catch { return null; }
}

/** A series as lists name it: its description, and its phase where it is one of several. */
export const seriesName = (item: Series) => [item.description || item.modality, item.phase && phaseLabel(item.phase)].filter(Boolean).join(' · ');

/** The fused series' line in a pane's bottom-right corner. With patient details hidden, and in a copied picture, it names
 * the series as the top-right corner then does, by its modality and phase without its description: "PET" alone for a
 * PET, as the line says so already. */
export function fusionLine(item: Series, hidePatient: boolean, translate = t): string {
  const pet = item.modality === 'PT';
  if (!hidePatient) return translate(pet ? 'viewport.fusionSeries' : 'viewport.fusionWith', { name: seriesName(item) });
  const phase = item.phase ? phaseLabel(item.phase) : '';
  if (!pet) return translate('viewport.fusionWith', { name: [item.modality, phase].filter(Boolean).join(' · ') });
  return phase ? translate('viewport.fusionSeries', { name: phase }) : translate('viewport.fusionPet');
}

/** What exporting a series as DICOM writes: its images, or for a gate of a gated SPECT every gate of its file, as the
 * gates share one file and DICOM export copies files whole. */
export function exportedImages(item: Series): string {
  const gate = item.phase?.gate;
  if (!gate) return t('export.seriesImages', { modality: item.modality, count: item.dimensions[2] });
  const gates = gate.slots * (gate.intervals ?? 1);
  return t('export.gateImages', { modality: item.modality, count: item.dimensions[2] * gates, gates });
}

/** Text for searching: lower case, Turkish letters folded to plain ones (ı/İ to i, ş to s, ğ to g, ü to u, ö to o,
 * ç to c), so "fıesta", "FIESTA" and "fiesta" match alike. */
export const foldSearch = (text: string) => text.toLocaleLowerCase('tr').replace(/[ıİ]/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
  .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[âàá]/g, 'a').replace(/[îì]/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Words a reader may type for each kind, in Turkish and English.
const ROLE_WORDS: Record<SequenceRole, string> = {
  t1: 't1', t1c: 't1 kontrastli contrast gadolinyum gadolinium', t2: 't2', flair: 'flair', stir: 'stir yag baskili fat suppressed',
  ssfp: 'ciss fiesta b-ffe ssfp', dwi: 'dwi difuzyon diffusion trace', adc: 'adc difuzyon diffusion',
};
const PLANE_WORDS: Record<Plane, string> = { axial: 'aksiyel axial', coronal: 'koronal coronal', sagittal: 'sagittal' };
const MODALITY_WORDS: Record<string, string> = { CT: 'bt ct tomografi', MR: 'mr mri', PT: 'pet', NM: 'nukleer nuclear', CR: 'rontgen xray x-ray', DX: 'rontgen xray x-ray', US: 'usg ultrason ultrasound' };

/** Everything a search looks through for a series, folded as `foldSearch` folds the query. */
export function searchText(item: Series, guess: Guess | null | undefined): string {
  return foldSearch([item.description, item.phase?.label, item.phase && phaseLabel(item.phase), item.modality, MODALITY_WORDS[item.modality.toUpperCase()] ?? '', item.patientName.replaceAll('^', ' '),
    item.patientId, item.studyDate, String(item.seriesNumber), guess?.label, guess ? ROLE_WORDS[guess.role] : '', guess?.plane ? PLANE_WORDS[guess.plane] : ''].filter(Boolean).join(' '));
}

/** The guess shown beside a series' name: only when the name itself does not say what the series is. */
export const shownGuess = (item: Series, guess: Guess | null | undefined) => guess && !INFORMATIVE.test(item.description) ? guess.label : '';

/** One study's series in list order: by series number, as the scanner and PACS number them (a contrast series follows
 * the one before contrast), then phase, then name. Series named only by a site code keep this order too; their likely
 * sequence is shown on the card. */
export function sortStudySeries(items: Series[]): Series[] {
  return [...items].sort((a, b) => a.seriesNumber - b.seriesNumber
    || (a.uid && a.uid === b.uid ? (a.phase?.order ?? 0) - (b.phase?.order ?? 0) : 0) || a.description.localeCompare(b.description));
}
