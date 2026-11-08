import { studyKey } from './patient';
import type { Annotation, Series, Vec3, Volume } from '../model';
import { annotationSourceIndex, roiStatistics, type RoiStatistics } from '../imaging/annotations';
import { add, sub, scale, dot, cross, normalize, worldToIndexMatrix, sourceFrameSeries, isPaddingValue } from '../imaging/geometry';
import { getLocale, t } from '../i18n';

export const CLINICAL_COPY_CHUNK_BYTES = 4 * 1024 * 1024;
export const CLINICAL_CACHE_BYTES = 512 * 1024 * 1024;
export const FEATURES = ['t1', 't2', 'kontrast', 'dwi', 'yayilim'] as const;
export type Feature = typeof FEATURES[number];
export type Findings = Partial<Record<Feature, string | null>>;
export type SequenceRole = 't1' | 't1c' | 't2' | 'stir' | 'flair' | 'ssfp' | 'dwi' | 'adc';
export const ROLE_NAMES: Record<SequenceRole, string> = { t1: 'T1', t1c: 'T1 C+', t2: 'T2', stir: 'STIR', flair: 'FLAIR', ssfp: 'CISS / FIESTA', dwi: 'DWI', adc: 'ADC' };
/** A finding's name in the interface language (1.x: T1, T2, Kontrast, Difüzyon, Yayılım). */
export const featureName = (feature: Feature): string => t(`clinical.feature.${feature}` as const);
// The knowledge base's Turkish finding words, as its lezyonlar.json stores them (it is kept outside the repository).
const WORD_KEYS = ['hipo', 'izo', 'hiper', 'sinyal_yok', 'akim_boslugu', 'yok', 'var', 'belirgin', 'kapsul', 'heterojen',
  'degisken', 'kisitli', 'kisitsiz', 'ekspansil', 'infiltratif'] as const;
type WordKey = typeof WORD_KEYS[number];
/** One knowledge-base finding word in the interface language; unknown words are shown as stored. */
export function word(value: string): string {
  const key = value === 'kapsül' ? 'kapsul' : value;
  return (WORD_KEYS as readonly string[]).includes(key) ? t(`clinical.word.${key as WordKey}` as const) : value;
}
export const words = (value: string | string[]) => (Array.isArray(value) ? value : [value]).map(word).join(' / ');
export interface Patient { age: number | null; sex: 'E' | 'K' | null; }
export interface Candidate {
  id: string; name: string; englishName?: string; expected: Partial<Record<Feature, string | string[]>>;
  page: number | string | null; differential: string[]; cautions: string[]; ct: string; finding: string;
  profile: string | null; source: string | null; patient: { yas?: number[]; cinsiyet?: string } | null;
  frequency: 'sik' | 'orta' | 'nadir';
}
export interface Reason { feature: string; fits: boolean; expected: string; found: string; kind?: Feature | 'age' | 'sex'; }
export interface RankedCandidate { candidate: Candidate; match: number; compared: number; reasons: Reason[]; }
interface KnowledgeRecord { id?: string; t1?: string[]; t2?: string[]; kontrast?: string; dwi?: string; }
interface LesionRecord {
  id: string; ad: string; en?: string; bolge: string[]; lezyon?: boolean; profil?: string; mr?: KnowledgeRecord;
  yayilim?: string; sayfa?: number | string; ayirici?: string[]; dikkat?: string[]; bt?: string;
  kaynak?: string; hasta?: { yas?: number[]; cinsiyet?: string };
}
type KnowledgeBase = {
  kaynak: { kitap: string; yazar: string; yayinevi: string; isbn: string; not: string };
  kaynak_radiopaedia?: { ad: string; lisans: string; url: string };
  bolgeler: { id: string; ad: string; ara?: string[] }[];
  mr_profilleri: KnowledgeRecord[]; lezyonlar: LesionRecord[];
  siklik: Record<string, Partial<Record<'sik' | 'nadir', string[]>>>;
  spa_tablosu: { satirlar: (KnowledgeRecord & { tani: string; bulgu: string })[] };
};
// The lesion knowledge base is not shipped. Its entries are drawn from Radiopaedia (CC BY-NC-SA, whose terms rule
// out text and data mining) and from a textbook, so it is kept outside the repository until that is cleared. With
// it empty the assessment has no candidates, and the interface keeps it switched off (ASSESSMENT_AVAILABLE).
const data: KnowledgeBase = {
  kaynak: { kitap: '', yazar: '', yayinevi: '', isbn: '', not: '' },
  bolgeler: [], mr_profilleri: [], lezyonlar: [], siklik: {}, spa_tablosu: { satirlar: [] },
};
export const ASSESSMENT_AVAILABLE = data.lezyonlar.length > 0;
export const source = data.kaynak;
export const radiopaedia = data.kaynak_radiopaedia;
export const regions = data.bolgeler.map(r => ({ id: r.id, name: r.ad, aliases: r.ara ?? [] }));
export const foldRegion = (text: string) => text.toLowerCase().replaceAll('i\u0307', 'i').replaceAll('ı', 'i');
/** The regions (the knowledge base's by default) whose name or an alias contains `query`, Turkish dotted and dotless i alike. */
export const searchRegions = (query: string, list = regions) => list.filter(region => [region.name, ...region.aliases].some(word => foldRegion(word).includes(foldRegion(query.trim()))));
export const sameRoiSlice = (a: Annotation, b: Annotation, series?: Series) => {
  if (a.mode === 'source' || b.mode === 'source') {
    if (a.mode !== b.mode) return false;
    const left = series ? annotationSourceIndex(a, series) : a.sourceFrame ?? a.slice;
    const right = series ? annotationSourceIndex(b, series) : b.sourceFrame ?? b.slice;
    return left !== null && left === right;
  }
  return a.plane === b.plane && a.slice === b.slice;
};
export const referenceTissue = (region: string) => t(region === 'kt.spa' ? 'clinical.referenceBrain' : 'clinical.referenceMuscle');
/** A lesion's name: the knowledge base's Turkish name, or its English name where one is recorded. */
export const candidateName = (candidate: Pick<Candidate, 'name' | 'englishName'>) => getLocale() === 'tr' ? candidate.name : candidate.englishName || candidate.name;
const profiles = new Map(data.mr_profilleri.map(p => [p.id, p]));
function expected(record: KnowledgeRecord = {}): Candidate['expected'] {
  const result: Candidate['expected'] = {};
  for (const key of ['t1', 't2', 'kontrast', 'dwi'] as const) if (record[key]) result[key] = record[key];
  return result;
}
function frequency(region: string, keys: string[]): Candidate['frequency'] {
  for (const level of ['sik', 'nadir'] as const) if (keys.some(key => data.siklik[region]?.[level]?.includes(key))) return level;
  return 'orta';
}
const plain = (name: string) => name.toLowerCase().replaceAll('i\u0307', 'i').replace(/[()]/g, '');
export function candidates(region: string): Candidate[] {
  const found = data.lezyonlar.filter(l => (!region || l.bolge.includes(region)) && l.lezyon !== false).map(l => {
    const wanted = { ...expected(profiles.get(l.profil)), ...expected(l.mr) };
    if (l.yayilim) wanted.yayilim = l.yayilim === 'ikisi' ? ['ekspansil', 'infiltratif'] : [l.yayilim];
    return { id: l.id, name: l.ad, englishName: l.en, expected: wanted, page: l.sayfa ?? null,
      differential: l.ayirici ?? [], cautions: l.dikkat ?? [], ct: l.bt ?? '', finding: '', profile: l.profil ?? null,
      source: l.kaynak ?? null, patient: l.hasta ?? null, frequency: frequency(region, [l.id, `profil:${l.profil ?? 'None'}`]) };
  });
  if (region === 'kt.spa') for (const row of data.spa_tablosu.satirlar) {
    const stem = plain(row.tani).slice(0, 6), same = found.filter(c => plain(c.name).includes(stem));
    for (const candidate of same) {
      candidate.expected = { ...expected(row), ...candidate.expected };
      candidate.finding ||= row.bulgu;
    }
    if (!same.length) found.push({ id: `spa:${row.tani}`, name: row.tani, englishName: undefined, expected: expected(row), page: '116-120',
      differential: [], cautions: [], ct: '', finding: row.bulgu, profile: null, source: null, patient: null,
      frequency: frequency(region, [row.tani]) });
  }
  return found;
}
const signal: Record<string, number> = { hipo: 0, izo: 1, hiper: 2, sinyal_yok: 0, akim_boslugu: 0 };
const enhancementFits: Record<string, Record<string, number>> = {
  yok: { yok: 1, var: 0, belirgin: 0 }, var: { yok: 0, var: 1, belirgin: 0.8 },
  belirgin: { yok: 0, var: 0.7, belirgin: 1 }, kapsul: { yok: 0.6, var: 0.6, belirgin: 0.3 },
  heterojen: { yok: 0.3, var: 1, belirgin: 0.8 }, degisken: { yok: 0.7, var: 0.7, belirgin: 0.7 },
};
enhancementFits['kapsül'] = enhancementFits.kapsul;
export function featureFit(feature: Feature, found: string, wanted: string | string[]): number {
  if (feature === 't1' || feature === 't2') {
    const values = Array.isArray(wanted) ? wanted : [wanted];
    if (values.includes(found)) return 1 - 0.15 * (values.length - 1);
    const near = Math.min(...values.map(value => Math.abs(signal[found] - (signal[value] ?? 1))));
    return near === 1 ? 0.4 : 0;
  }
  if (feature === 'kontrast') return enhancementFits[String(wanted)]?.[found] ?? 0.5;
  if (feature === 'yayilim') return wanted.includes(found) ? (wanted.length === 1 ? 1 : 0.9) : 0;
  return found === wanted ? 1 : 0;
}
export function score(found: Findings, candidate: Candidate): { match: number; compared: number; reasons: Reason[] } {
  let total = 0, weights = 0, compared = 0, against = 1;
  const reasons: Reason[] = [];
  for (const feature of FEATURES) {
    const value = found[feature], wanted = candidate.expected[feature];
    if (!value || !wanted || !wanted.length) continue;
    const fit = featureFit(feature, value, wanted), weight = feature === 'yayilim' ? 2 : 1;
    total += fit * weight; weights += weight; compared++;
    if (fit < 0.5) against *= 0.7;
    reasons.push({ feature: featureName(feature), expected: words(wanted), found: words(value), kind: feature,
      fits: ['t1', 't2', 'yayilim'].includes(feature) ? wanted.includes(value) : fit >= 0.7 });
  }
  return { match: weights ? total / weights * against : 0, compared, reasons };
}
export function rank(found: Findings, options: Candidate[], patient?: Patient): { ranked: RankedCandidate[]; unknown: Candidate[] } {
  const asked = FEATURES.filter(f => found[f]).length, ranked: RankedCandidate[] = [], unknown: Candidate[] = [];
  for (const candidate of options) {
    const result = score(found, candidate);
    if (!result.compared) { unknown.push(candidate); continue; }
    let factor = 1;
    const who = candidate.patient;
    if (who && patient) {
      if (who.yas && patient.age !== null) {
        const [low, high] = who.yas, fits = low <= patient.age && patient.age <= high;
        if (!fits) factor *= 0.4;
        result.reasons.push({ feature: t('clinical.age'), kind: 'age', expected: high < 100 ? t('clinical.ageRange', { low, high }) : t('clinical.ageFrom', { low }),
          found: t('clinical.years', { age: patient.age }), fits });
      }
      if (who.cinsiyet && patient.sex) {
        const fits = who.cinsiyet === patient.sex;
        if (!fits) factor *= 0.3;
        result.reasons.push({ feature: t('clinical.typicalSex'), kind: 'sex', expected: t(who.cinsiyet === 'E' ? 'clinical.male' : 'clinical.female'),
          found: t(patient.sex === 'E' ? 'clinical.male' : 'clinical.female'), fits });
      }
    }
    ranked.push({ candidate, ...result, match: result.match * (0.6 + 0.4 * result.compared / Math.max(asked, 1)) * (candidate.frequency === 'sik' ? 1 : 0.8) * factor });
  }
  ranked.sort((a, b) => b.match - a.match);
  return { ranked, unknown };
}

export function level(ratio: number | null): string | null { return ratio === null ? null : ratio < 0.8 ? 'hipo' : ratio > 1.25 ? 'hiper' : 'izo'; }
export function enhancement(before: number | null, after: number | null): string | null {
  if (!before || after === null) return null;
  const rise = after / before;
  return rise > 1.6 ? 'belirgin' : rise > 1.15 ? 'var' : 'yok';
}
export function adcUnits(reference: number): number | null {
  return [1e-3, 1, 1e3, 1e-2].find(factor => reference * factor >= 0.5 && reference * factor <= 3) ?? null;
}
export function diffusion(dwi: number | null, adc: number | null): { finding: string | null; reason: string } {
  const bright = dwi !== null && dwi >= 1.3;
  if (adc === null) return dwi === null ? { finding: null, reason: '' } : bright
    ? { finding: null, reason: t('clinical.diffusion.needsAdc') }
    : { finding: 'kisitsiz', reason: t('clinical.diffusion.notBright') };
  if (adc >= 1.15) return { finding: 'kisitsiz', reason: t(bright ? 'clinical.diffusion.adcNotLowShine' : 'clinical.diffusion.adcNotLow') };
  if (dwi !== null && !bright) return { finding: 'kisitsiz', reason: t('clinical.diffusion.notBright') };
  if (bright && adc < 1) return { finding: 'kisitli', reason: t('clinical.diffusion.brightLowAdc') };
  if (adc < 0.8) return { finding: 'kisitli', reason: t('clinical.diffusion.lowAdc') };
  return { finding: null, reason: t('clinical.diffusion.borderline') };
}
export function parseAge(value?: string | null): number | null {
  const found = value?.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(y|m|w|d|ay|hf|gün)$/);
  if (!found) return null;
  return Number(found[1]) / ({ y: 1, m: 12, ay: 12, w: 52.18, hf: 52.18, d: 365.25, gün: 365.25 }[found[2]] ?? 1);
}
export interface SequenceChoice { role: SequenceRole | null; bValue: number | null; basis: string; }
const beforeContrastName = /\bpre\b|pre[- ]?(c|gd|cont)|\bnon\b|non[- ]?c|kontrastsiz|\bwo\b|w\/o|without/;
const afterContrastName = /\+\s*c\b|\bc\s*\+|\bpost\b|post[- ]?(c|gd|gad|cont)|gado|\bgd\b|kontrastli|contrast/;
const localizerName = /locali[sz]er|scout|survey|scano|\bloc\b|3[- ]?plane|planlama/;
const sequenceText = (series: Series) => [series.description, series.protocolName, series.sequenceName].filter(Boolean).join(' ').toLowerCase().replaceAll('_', ' ');
interface ContrastEvidence { state: 'pre' | 'post' | 'uncertain' | null; basis: string; }
function contrastEvidence(series: Series, translate = t): ContrastEvidence {
  const phase = series.contrastBolusPhase?.trim().toUpperCase(), administered = series.contrastBolusAdministered?.trim().toUpperCase();
  const detected = series.contrastBolusDetected?.trim().toUpperCase();
  if (phase === 'MIXED' || administered === 'MIXED') return { state: 'uncertain', basis: translate('clinical.basis.mixedContrast') };
  // Frame usage describes this acquisition; an agent name can be copied across a whole examination.
  if (phase === 'PRE_CONTRAST' || administered === 'NO') return { state: 'pre', basis: translate('clinical.basis.precontrastUsage') };
  if (phase && ['POST_CONTRAST', 'IMMEDIATE', 'DYNAMIC', 'STEADY_STATE', 'DELAYED', 'ARTERIAL', 'CAPILLARY', 'VENOUS', 'PORTAL_VENOUS'].includes(phase)) return { state: 'post', basis: translate('clinical.basis.postcontrastPhase') };
  if (administered === 'YES' || detected === 'YES') return { state: 'post', basis: translate('clinical.basis.contrastRecorded') };
  const name = sequenceText(series);
  if (beforeContrastName.test(name)) return { state: 'pre', basis: translate('clinical.basis.precontrastName') };
  if (afterContrastName.test(name)) return { state: 'post', basis: translate('clinical.basis.postcontrastName') };
  if (series.contrastBolusAgent?.trim() || series.contrastBolusRoute?.trim()) return { state: 'post', basis: translate('clinical.basis.contrastTag') };
  return { state: null, basis: '' };
}
interface MrKind { role: SequenceRole | null; basis: string; assumedContrast?: boolean; }
function physicsKind(series: Series, translate = t): MrKind | null {
  const tr = series.repetitionTime ?? 0, te = series.echoTime ?? 0, ti = series.inversionTime ?? 0, flip = series.flipAngle ?? 0;
  const scanning = series.scanningSequence?.toUpperCase() ?? '';
  const name = `${series.sequenceName ?? ''} ${series.protocolName ?? ''}`.toLowerCase();
  const threeD = series.mrAcquisitionType?.toUpperCase() === '3D';
  const gradient = scanning.includes('GR') || /^\*(?:fl|fi|ci|tfi)/.test(name);
  const inverted = scanning.includes('IR') || ti > 50;
  const kind = (role: SequenceRole | null, assumedContrast = false): MrKind => ({ role, assumedContrast, basis: translate('clinical.basis.acquisitionParameters') });
  if (/ci3d|fiesta|b-?ffe|tfi/.test(name) || (gradient && threeD && tr > 0 && tr < 15 && te < 6 && flip >= 30)) return kind('ssfp');
  if (inverted && ti >= 1500 && tr >= 4000) return kind('flair');
  if (inverted && ti >= 80 && ti <= 300) return kind('stir');
  if (inverted && threeD && ti > 300 && ti < 1400) return kind('t1');
  if (/swi/.test(name) || /\bSWI\b/.test(series.imageType ?? '')) return kind(null);
  if (gradient) {
    if (/tof|angio|\bmra/.test(name)) return kind(null);
    if (threeD && tr >= 15 && tr <= 50 && te < 10 && flip >= 15 && flip <= 35) return kind('t1', true);
    if (te >= 15 && (flip === 0 || flip <= 35)) return kind(null);
    if (tr > 0 && tr < 300 && te < 10) return kind('t1');
  }
  if (tr > 0 && tr < 1000 && te > 0 && te < 30) return kind('t1');
  if (tr >= 1500 && te >= 60) return kind('t2');
  if (tr >= 1500 && te > 0 && te < 45) return kind(null);
  return null;
}
function mrKind(series: Series, translate = t): MrKind {
  const name = sequenceText(series), imageType = (series.imageType ?? '').toUpperCase();
  const kind = (role: SequenceRole | null, basis: string): MrKind => ({ role, basis });
  if (series.modality.toUpperCase() !== 'MR' || localizerName.test(name) || /LOCALIZER/.test(imageType)) return kind(null, translate('clinical.basis.notDiagnostic'));
  if (/\beadc\b|exponential adc|exponential diffusion/.test(name) || /(?:^|[\\ ,])(?:EADC|EXP)(?:$|[\\ ,])/.test(imageType)) return kind(null, translate('clinical.basis.exponentialAdc'));
  if (/\badc\b|apparent diffusion/.test(name) || /(?:^|[\\ ,])ADC(?:$|[\\ ,])/.test(imageType)) return kind('adc', translate('clinical.basis.adc'));
  const acquisitionContrast = series.acquisitionContrast?.toUpperCase();
  if (/DIFFUSION|TRACE/.test(imageType) || acquisitionContrast === 'DIFFUSION' || (series.diffusionBValue ?? 0) > 0) return kind('dwi', translate('clinical.basis.diffusionMetadata'));
  if (/\bdwi\b|diffusion|\bdiff\b|\bep2d\b|\btrace\b/.test(name)) return kind('dwi', translate('clinical.basis.nameVerify'));
  if (acquisitionContrast === 'MIXED') return kind(null, translate('clinical.basis.mixedAcquisition'));
  if (/t2\s*\*|t2star|\bswi\b|\btof\b|\bmra\b|angio|\bpd\b|perfusion/.test(name)) return kind(null, translate('clinical.basis.notUsed'));
  const physical = physicsKind(series, translate);
  if (physical && (physical.role === null || ['ssfp', 'flair', 'stir'].includes(physical.role))) return physical;
  if (/flair/.test(name)) return kind('flair', translate('clinical.basis.nameVerify'));
  if (/\bstir\b/.test(name)) return kind('stir', translate('clinical.basis.nameVerify'));
  if (/ciss|fiesta|b-?ffe/.test(name)) return kind('ssfp', translate('clinical.basis.nameVerify'));
  const acquisitionRoles: Record<string, SequenceRole | null> = { T1: 't1', T2: 't2', FLUID_ATTENUATED: 'flair', STIR: 'stir', T2_STAR: null, TOF: null, PROTON_DENSITY: null, FLOW_ENCODED: null, PERFUSION: null, TAGGING: null };
  if (acquisitionContrast && Object.hasOwn(acquisitionRoles, acquisitionContrast)) return {
    role: acquisitionRoles[acquisitionContrast], basis: translate('clinical.basis.acquisitionContrast'),
    assumedContrast: acquisitionContrast === 'T1' && physical?.role === 't1' && physical.assumedContrast,
  };
  if (physical) return physical;
  if (/t1|mprage|mp-rage|bravo/.test(name)) return kind('t1', translate('clinical.basis.nameVerify'));
  if (/t2/.test(name)) return kind('t2', translate('clinical.basis.nameVerify'));
  return kind(null, translate('clinical.basis.unknown'));
}
export function inferSequence(series: Series, translate = t): SequenceChoice {
  const namedB = sequenceText(series).match(/\bb[= -]?(\d+(?:\.\d+)?)/)?.[1];
  const bValue = series.diffusionBValue ?? (namedB ? Number(namedB) : null);
  const kind = mrKind(series, translate);
  if (kind.role !== 't1') return { role: kind.role, bValue, basis: kind.basis };
  const contrast = contrastEvidence(series, translate);
  if (contrast.state === 'uncertain') return { role: null, bValue, basis: contrast.basis };
  if (contrast.state) return { role: contrast.state === 'post' ? 't1c' : 't1', bValue, basis: translate('clinical.basis.combined', { kind: kind.basis, contrast: contrast.basis }) };
  if (kind.assumedContrast) return { role: 't1c', bValue, basis: translate('clinical.basis.assumedGre') };
  return { role: 't1', bValue, basis: translate('clinical.basis.phaseUnknown', { basis: kind.basis }) };
}
function acquisitionSeconds(series: Series): number | null {
  const datetime = series.acquisitionDateTime?.trim();
  const value = datetime && /^\d{8}\d{4}/.test(datetime) ? datetime.slice(8).replace(/[+-]\d{4}$/, '') : series.acquisitionTime?.trim();
  const match = value?.match(/^(\d{2})(\d{2})(?:(\d{2})(?:\.(\d{1,6}))?)?$/);
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]), seconds = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 60) return null;
  return hours * 3600 + minutes * 60 + seconds + Number(`0.${match[4] ?? 0}`);
}
function repeatSignature(series: Series): string | null {
  if (!(series.repetitionTime! > 0) || !(series.echoTime! > 0) || series.orientationKnown === false || series.direction.length !== 9) return null;
  const d = series.direction, normal = cross([d[0], d[3], d[6]], [d[1], d[4], d[7]]);
  if (!normal.every(Number.isFinite) || Math.hypot(...normal) < 1e-6) return null;
  const plane = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  return JSON.stringify([series.sequenceName ?? '', series.repetitionTime, series.echoTime, series.scanOptions ?? '', plane]);
}
export function inferStudySequences(seriesList: Series[], translate = t): Record<string, SequenceChoice> {
  const choices = Object.fromEntries(seriesList.map(series => [series.id, inferSequence(series, translate)]));
  const studies = new Map<string, Series[]>();
  for (const series of seriesList) if (series.modality.toUpperCase() === 'MR') {
    const key = studyKey(series);
    studies.set(key, [...(studies.get(key) ?? []), series]);
  }
  for (const study of studies.values()) {
    if (study.some(series => ['post', 'uncertain'].includes(contrastEvidence(series, translate).state ?? ''))) continue;
    const dates = new Set(study.map(series => series.acquisitionDateTime?.match(/^\d{8}/)?.[0]).filter(Boolean));
    if (dates.size > 1) continue;
    const takings: { series: Series; when: number; same: string }[] = [], others: number[] = [];
    for (const series of study) {
      const when = acquisitionSeconds(series);
      if (when === null || localizerName.test(sequenceText(series)) || /LOCALIZER/.test(series.imageType ?? '')) continue;
      const same = repeatSignature(series);
      if (mrKind(series, translate).role === 't1' && same) takings.push({ series, when, same });
      else others.push(when);
    }
    takings.sort((a, b) => a.when - b.when);
    const firstSeen = new Map<string, number>();
    let injected: number | null = null;
    for (const taking of takings) {
      const first = firstSeen.get(taking.same);
      if (first !== undefined && taking.when - first > 30 && contrastEvidence(taking.series, translate).state !== 'pre') { injected = taking.when; break; }
      if (first === undefined) firstSeen.set(taking.same, taking.when);
    }
    if (injected === null || others.some(when => when >= injected!) || new Set(takings.filter(t => t.when >= injected!).map(t => t.same)).size < 2) continue;
    for (const taking of takings) if (taking.when >= injected && contrastEvidence(taking.series, translate).state !== 'pre' && choices[taking.series.id].role === 't1') {
      choices[taking.series.id] = { ...choices[taking.series.id], role: 't1c', basis: translate('clinical.basis.assumedRepeat') };
    }
  }
  return choices;
}

export interface Sample { mean: number; std: number; min: number; max: number; sampling: 'source-voxels' | 'derived-nearest'; voxels: number; coverage: number; samples: number; invalidSamples: number; outsideSamples: number; paddingSamples: number; }
// DICOM's original Python sampling uses NumPy's round-to-even, including at negative half voxels.
export function roundEven(n: number): number {
  const low = Math.floor(n), fraction = n - low;
  return fraction === 0.5 ? (low % 2 === 0 ? low : low + 1) : Math.round(n);
}
export function annotationOutline(annotation: Annotation): Vec3[] {
  if (!['rectangle', 'ellipse', 'polygon'].includes(annotation.type) || annotation.points.length < 3) return [];
  if (annotation.type !== 'ellipse') return annotation.points;
  if (annotation.points.length !== 4) return [];
  const [a, b, c, d] = annotation.points, center = scale(add(a, c), 0.5);
  const u = scale(sub(b, a), 0.5), v = scale(sub(d, a), 0.5);
  return Array.from({ length: 96 }, (_, i) => add(center, add(scale(u, Math.cos(i * Math.PI / 48)), scale(v, Math.sin(i * Math.PI / 48)))));
}
export function regionPoints(outline: Vec3[]): Vec3[] {
  if (outline.length < 3 || outline.some(p => p.some(n => !Number.isFinite(n)))) return [];
  const origin = outline[0];
  const edge = outline.slice(1).find(p => Math.hypot(...sub(p, origin)) > 1e-8);
  if (!edge) return [];
  const u = normalize(sub(edge, origin));
  const perpendicular = outline.slice(1).map(p => cross(u, sub(p, origin))).find(p => Math.hypot(...p) > 1e-8);
  if (!perpendicular) return [];
  const normal = normalize(perpendicular), v = normalize(cross(normal, u));
  if (outline.some(p => Math.abs(dot(sub(p, origin), normal)) > 0.1)) return [];
  const polygon = outline.map(p => [dot(sub(p, origin), u), dot(sub(p, origin), v)]);
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const low = [Math.min(...xs), Math.min(...ys)], high = [Math.max(...xs), Math.max(...ys)];
  const step = Math.max(0.5, Math.sqrt(((high[0] - low[0] + 1e-9) * (high[1] - low[1] + 1e-9)) / 40000));
  const points: Vec3[] = [];
  for (let iy = 0; low[1] + iy * step <= high[1] + step; iy++) for (let ix = 0; low[0] + ix * step <= high[0] + step; ix++) {
    const x = low[0] + ix * step, y = low[1] + iy * step;
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [ax, ay] = polygon[i], [bx, by] = polygon[j];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    if (inside) points.push(add(origin, add(scale(u, x), scale(v, y))));
  }
  return points.length ? points : outline;
}
interface SamplePointSet { points: Vec3[]; sourceFrame?: number; }
export type StudyVolume = Pick<Volume, 'series' | 'sourceFrameIndex'>;
export type SampleTask = { seriesId: string; mode: 'source' | 'derived'; annotations: Annotation[] };
function samplePointSets(volume: Volume, sets: SamplePointSet[]): Sample | null {
  const total = sets.reduce((count, set) => count + set.points.length, 0);
  if (!total || volume.series.components === 3) return null;
  const unique = new Set<number>(), frameLength = volume.series.dimensions[0] * volume.series.dimensions[1];
  let count = 0, sum = 0, mean = 0, squaredDeviations = 0, min = Infinity, max = -Infinity, invalidSamples = 0, outsideSamples = 0, paddingSamples = 0;
  try {
    for (const set of sets) {
      const selectedFrame = set.sourceFrame ?? volume.sourceFrameIndex;
      if (selectedFrame !== undefined && (!Number.isInteger(selectedFrame) || selectedFrame < 0 || selectedFrame >= volume.series.dimensions[2]
        || (volume.sourceFrameIndex !== undefined && selectedFrame !== volume.sourceFrameIndex))) { outsideSamples += set.points.length; continue; }
      const geometry = selectedFrame === undefined ? volume.series : sourceFrameSeries(volume.series, selectedFrame);
      const d = geometry.dimensions, matrix = worldToIndexMatrix(geometry), origin = geometry.origin;
      const frameOffset = selectedFrame === undefined || volume.sourceFrameIndex !== undefined ? 0 : selectedFrame * frameLength;
      for (const world of set.points) {
        const x = world[0] - origin[0], y = world[1] - origin[1], z = world[2] - origin[2];
        const i = roundEven(matrix[0] * x + matrix[1] * y + matrix[2] * z);
        const j = roundEven(matrix[3] * x + matrix[4] * y + matrix[5] * z);
        const k = roundEven(matrix[6] * x + matrix[7] * y + matrix[8] * z);
        if (!(i >= 0 && i < d[0] && j >= 0 && j < d[1] && k >= 0 && k < d[2])) { outsideSamples++; continue; }
        const offset = frameOffset + (k * d[1] + j) * d[0] + i, value = volume.data[offset];
        if (!Number.isFinite(value)) { invalidSamples++; continue; }
        if (isPaddingValue(volume.series, value, selectedFrame ?? k)) { paddingSamples++; continue; }
        count++; sum += value; min = Math.min(min, value); max = Math.max(max, value);
        const difference = value - mean;
        mean += difference / count; squaredDeviations += difference * (value - mean); unique.add(offset);
      }
    }
  } catch { return null; }
  if (count / total < 0.8) return null;
  if (Number.isFinite(sum)) mean = sum / count;
  return { mean, std: Math.sqrt(Math.max(0, squaredDeviations / count)), min, max, sampling: 'derived-nearest', voxels: unique.size, coverage: count / total,
    samples: total, invalidSamples, outsideSamples, paddingSamples };
}
export function samplePoints(volume: Volume, points: Vec3[], sourceFrame?: number): Sample | null {
  return samplePointSets(volume, [{ points, sourceFrame }]);
}

function sourceRoiSamples(volume: Volume, annotations: Annotation[]): Sample | null {
  return combineSourceRegions(annotations.map(annotation => roiStatistics(annotation, volume)));
}
export function combineSourceRegions(statistics: (RoiStatistics | null)[]): Sample | null {
  // A clipped source outline has no trustworthy total voxel count outside the image.
  if (statistics.some(stats => !stats || stats.clipped)) return null;
  const valid = statistics.filter(stats => stats !== null);
  const count = valid.reduce((sum, stats) => sum + stats.count, 0);
  const invalidSamples = valid.reduce((sum, stats) => sum + stats.invalidCount, 0);
  const outsideSamples = valid.reduce((sum, stats) => sum + stats.outsideCount, 0);
  const paddingSamples = valid.reduce((sum, stats) => sum + stats.paddingCount, 0);
  const samples = count + invalidSamples + outsideSamples + paddingSamples;
  if (!count || count / samples < 0.8) return null;
  const mean = valid.length === 1 ? valid[0].mean : valid.reduce((sum, stats) => sum + stats.mean * stats.count, 0) / count;
  const variance = valid.reduce((sum, stats) => sum + stats.count * (stats.standardDeviation ** 2 + (stats.mean - mean) ** 2), 0) / count;
  return { mean, std: valid.length === 1 ? valid[0].standardDeviation : Math.sqrt(Math.max(0, variance)),
    min: Math.min(...valid.map(stats => stats.min)), max: Math.max(...valid.map(stats => stats.max)),
    sampling: 'source-voxels', voxels: count, coverage: count / samples, samples, invalidSamples, outsideSamples, paddingSamples };
}
export const sampleMethod = (sample: Sample | null) => t(sample?.sampling === 'source-voxels' ? 'clinical.sampleSource' : 'clinical.sampleDerived');

export interface RoiMark { annotation: Annotation; seriesId: string; kind: 'lesion' | 'reference'; order: number; }
export interface Reading { seriesId: string; role: SequenceRole; bValue: number | null; lesion: Sample | null; reference: Sample | null; ratio: number | null; issue: string; }
export interface Measurement { readings: Reading[]; findings: Findings; diffusionReason: string; blockers: string[]; warnings: string[]; }
const isDiffusion = (role: SequenceRole | null) => role === 'adc' || role === 'dwi';
function sharesCoordinates(a: Series, b: Series): boolean {
  return studyKey(a) === studyKey(b) && (a.id === b.id || (a.canReconstruct && b.canReconstruct
    && a.spacingKnown !== false && b.spacingKnown !== false
    && Boolean(a.frameOfReferenceUid) && a.frameOfReferenceUid === b.frameOfReferenceUid));
}
export const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b), mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
};
export function* studySamples(volumes: StudyVolume[], marks: RoiMark[], sequences: Record<string, SequenceChoice>, translate = t): Generator<SampleTask, Measurement, Sample | null> {
  const readings: Reading[] = [], warnings: string[] = [], blockers: string[] = [];
  const byId = new Map(volumes.map(v => [v.series.id, v]));
  const filled = marks.map(mark => ({ ...mark, points: regionPoints(annotationOutline(mark.annotation)),
    diffusion: isDiffusion(sequences[mark.seriesId]?.role ?? null) })).filter(mark => mark.points.length && byId.has(mark.seriesId));
  function* sampleMarks(volume: StudyVolume, kind: RoiMark['kind'], diffusionSeries: boolean): Generator<SampleTask, Sample | null, Sample | null> {
    const relevant = filled.filter(m => m.kind === kind && sharesCoordinates(byId.get(m.seriesId)!.series, volume.series));
    const directSource = (mark: typeof filled[number]) => mark.seriesId === volume.series.id && mark.annotation.mode === 'source';
    const groups = new Map<string, typeof relevant>();
    for (const mark of relevant) {
      const key = `${mark.seriesId}:${directSource(mark) ? 'source' : 'derived'}`;
      groups.set(key, [...(groups.get(key) ?? []), mark]);
    }
    const ordered = [...groups.values()].sort((a, b) => Number(a[0].diffusion !== diffusionSeries) - Number(b[0].diffusion !== diffusionSeries)
      || Math.max(...b.map(m => m.order)) - Math.max(...a.map(m => m.order)));
    const task = (group: typeof relevant): SampleTask => ({ seriesId: volume.series.id,
      mode: directSource(group[0]) ? 'source' : 'derived', annotations: group.map(mark => {
        const item = mark.annotation;
        // A mark drawn on another series is sampled in patient space on the target volume.
        return mark.seriesId === volume.series.id ? item : { ...item, mode: 'mpr', sourceFrame: undefined };
      }) });
    for (const group of ordered) {
      const result = yield task(group);
      if (result) return result;
    }
    relevant.sort((a, b) => Number(a.diffusion !== diffusionSeries) - Number(b.diffusion !== diffusionSeries) || b.order - a.order);
    for (const mark of relevant) {
      const result = yield task([mark]);
      if (result) return result;
    }
    return null;
  }
  for (const volume of volumes) {
    const selection = sequences[volume.series.id] ?? inferSequence(volume.series, translate);
    if (!selection.role || volume.series.components === 3) continue;
    if (!volume.series.frameOfReferenceUid && filled.some(m => m.seriesId !== volume.series.id)) warnings.push(translate('clinical.warning.noFrame'));
    if (filled.some(m => m.seriesId !== volume.series.id && byId.get(m.seriesId)?.series.frameOfReferenceUid && volume.series.frameOfReferenceUid && byId.get(m.seriesId)?.series.frameOfReferenceUid !== volume.series.frameOfReferenceUid)) warnings.push(translate('clinical.warning.differentFrames'));
    const lesion = yield* sampleMarks(volume, 'lesion', isDiffusion(selection.role));
    const reference = yield* sampleMarks(volume, 'reference', isDiffusion(selection.role));
    const ratio = lesion && reference && reference.mean > 0 ? lesion.mean / reference.mean : null;
    const partial: string[] = [];
    for (const [label, sample] of [[translate('clinical.lesionRoi'), lesion], [translate('clinical.referenceRoi'), reference]] as const) if (sample && sample.coverage < 1) {
      const percentage = (Math.floor(sample.coverage * 10000) / 100).toFixed(2);
      partial.push(translate('clinical.partialCoverage', { label, percent: percentage, invalid: sample.invalidSamples, outside: sample.outsideSamples })
        + (sample.paddingSamples ? translate('clinical.paddingExcluded', { count: sample.paddingSamples }) : ''));
    }
    const unavailable = !lesion ? translate('clinical.lesionMissing') : !reference ? translate('clinical.referenceMissing')
      : reference.mean <= 0 ? translate('clinical.referencePositive') : '';
    const issue = [unavailable, ...partial].filter(Boolean).join(' ');
    if (partial.length) warnings.push(translate('clinical.roleWarning', { role: ROLE_NAMES[selection.role], details: partial.join(' ') }));
    readings.push({ seriesId: volume.series.id, role: selection.role, bValue: selection.bValue, lesion, reference, ratio, issue });
    if (!volume.series.canReconstruct) warnings.push(translate('clinical.warning.irregular'));
  }
  const ratios = (...roles: SequenceRole[]) => readings.filter(r => roles.includes(r.role) && r.ratio !== null).map(r => r.ratio!);
  const t1 = median(ratios('t1')), t2 = median(ratios('t2')) ?? median(ratios('stir'));
  const positiveB = readings.filter(r => r.role === 'dwi' && r.bValue !== null && r.bValue > 0);
  const highestB = Math.max(...positiveB.map(r => r.bValue!));
  const dwi = median(positiveB.filter(r => r.bValue === highestB && r.ratio !== null).map(r => r.ratio!));
  const diff = diffusion(dwi, median(ratios('adc')));
  if (readings.some(r => r.role === 'dwi' && r.bValue === null)) warnings.push(translate('clinical.warning.noBValue'));
  if (!ratios('t2').length && ratios('stir').length) warnings.push(translate('clinical.warning.stirFallback'));
  if (filled.some(m => m.kind === 'lesion') && filled.some(m => m.kind === 'reference')) {
    const bounds = (points: Vec3[]) => {
      const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
      for (const p of points) for (let axis = 0; axis < 3; axis++) {
        const cell = roundEven(p[axis]); low[axis] = Math.min(low[axis], cell); high[axis] = Math.max(high[axis], cell);
      }
      return { low, high };
    };
    const cells = new Map<RoiMark, Set<string>>();
    const getCells = (mark: typeof filled[number]) => {
      let found = cells.get(mark);
      if (!found) { found = new Set(mark.points.map(p => p.map(roundEven).join(','))); cells.set(mark, found); }
      return found;
    };
    const withBounds = filled.map(mark => ({ mark, ...bounds(mark.points) }));
    const lesionMarks = withBounds.filter(m => m.mark.kind === 'lesion'), referenceMarks = withBounds.filter(m => m.mark.kind === 'reference');
    for (const lesion of lesionMarks) for (const reference of referenceMarks) {
      if (!sharesCoordinates(byId.get(lesion.mark.seriesId)!.series, byId.get(reference.mark.seriesId)!.series)) continue;
      if (lesion.low.some((low, axis) => low > reference.high[axis] || lesion.high[axis] < reference.low[axis])) continue;
      const a = getCells(lesion.mark), b = getCells(reference.mark);
      let shared = 0;
      for (const cell of a) if (b.has(cell)) shared++;
      if (shared >= 0.5 * Math.min(a.size, b.size)) blockers.push(translate('clinical.blocker.overlap'));
    }
    const all = readings.filter(r => r.ratio !== null).map(r => r.ratio!);
    if (all.length >= 2 && all.every(ratio => Math.abs(ratio - 1) < 0.08)) blockers.push(translate('clinical.blocker.equal'));
  }
  return { readings, findings: { t1: level(t1), t2: level(t2), kontrast: enhancement(t1, median(ratios('t1c'))), dwi: diff.finding },
    diffusionReason: diff.reason, blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
}
export function measureStudy(volumes: Volume[], marks: RoiMark[], sequences: Record<string, SequenceChoice>, translate = t): Measurement {
  const samples = studySamples(volumes, marks, sequences, translate);
  let step = samples.next();
  while (!step.done) {
    const { seriesId, mode, annotations } = step.value;
    const volume = volumes.find(v => v.series.id === seriesId)!;
    const result = mode === 'source' ? sourceRoiSamples(volume, annotations) : samplePointSets(volume,
      annotations.map(item => ({ points: regionPoints(annotationOutline(item)), sourceFrame: item.sourceFrame })));
    step = samples.next(result);
  }
  return step.value;
}
export function assessmentSummary(input: { region: string; patient: Patient; findings: Findings; measurement: Measurement; ranked: RankedCandidate[]; note: string; manualFeatures?: Feature[]; lesionSlices?: number }): string {
  const { region, patient, findings, measurement, ranked, note } = input;
  const ageBand = patient.age === null ? t('clinical.ageUnknown') : patient.age < 1 ? t('clinical.ageUnderOne')
    : t('clinical.ageBand', { low: Math.floor(patient.age / 5) * 5, high: Math.floor(patient.age / 5) * 5 + 4 });
  const sex = patient.sex === 'E' ? t('clinical.male') : patient.sex === 'K' ? t('clinical.female') : t('clinical.unknown');
  return [
    t('clinical.summary.title'),
    t('clinical.summary.purpose'),
    t('clinical.summary.region', { region: regions.find(r => r.id === region)?.name ?? t('clinical.summary.allRegions') }),
    t('clinical.summary.patient', { age: ageBand, sex }),
    t('clinical.summary.sequences', { sequences: [...new Set(measurement.readings.map(r => ROLE_NAMES[r.role]))].join(', ') || t('clinical.unknown') }),
    input.lesionSlices && input.lesionSlices > 1 ? t('clinical.summary.lesionSlices', { count: input.lesionSlices }) : '',
    t('clinical.summary.reference', { tissue: referenceTissue(region) }),
    ...FEATURES.map(f => t('clinical.summary.finding', { feature: featureName(f), value: findings[f] ? words(findings[f]!) : t('clinical.unknown'),
      basis: t(input.manualFeatures?.includes(f) ? 'clinical.summary.clinicianSelected' : findings[f] ? 'clinical.summary.measured' : 'clinical.summary.unavailable') })),
    ...measurement.readings.filter(r => r.ratio !== null).map(r => t('clinical.summary.reading', {
      role: ROLE_NAMES[r.role], b: r.bValue === null ? '' : t('clinical.summary.bValue', { value: r.bValue }), ratio: r.ratio!.toFixed(3),
      lesion: r.lesion!.mean.toFixed(3), reference: r.reference!.mean.toFixed(3),
      lesionMethod: sampleMethod(r.lesion), lesionCount: r.lesion!.voxels, lesionSd: r.lesion!.std.toFixed(3),
      extremaLabel: t(r.lesion!.sampling === 'source-voxels' ? 'clinical.summary.minMax' : 'clinical.summary.sampleMinMax'),
      min: r.lesion!.min.toFixed(3), max: r.lesion!.max.toFixed(3),
      referenceMethod: sampleMethod(r.reference), referenceCount: r.reference!.voxels, referenceSd: r.reference!.std.toFixed(3),
      unranked: r.role === 'flair' || r.role === 'ssfp' ? t('clinical.summary.unranked') : '' })),
    measurement.diffusionReason, ...measurement.warnings, ...measurement.blockers,
    t('clinical.summary.rankedHeading'),
    ...ranked.slice(0, 8).map(r => t('clinical.summary.candidate', { name: candidateName(r.candidate), match: (r.match * 100).toFixed(1),
      reasons: r.reasons.map(reason => t('clinical.summary.reason', { feature: reason.feature, expected: reason.expected,
        found: reason.kind === 'age' ? ageBand : reason.found, fit: reason.fits ? '' : t('clinical.summary.doesNotFit') })).join('; ') })),
    note.trim() ? t('clinical.summary.note', { note: note.trim() }) : '',
    t('clinical.summary.source', { book: source.kitap, publisher: source.yayinevi }),
  ].filter(Boolean).join('\n');
}
