// What a reader measured on a PET study, kept on this computer for this user (localStorage, as the workspace settings
// are) so that it comes back when the study is opened again: per PET series, the reference spheres (liver and
// mediastinal blood pool) and the lesion table (each lesion sphere with its name, threshold, confirmed Deauville score
// and values), with what a later study is compared on (the uptake time, scanner model, reconstruction and the file's
// blood glucose); per study, the blood glucose the reader typed for SULglu. Studies and series are known by a SHA-256
// digest scoped to the patient and reconstruction, never by the UIDs or names themselves. The
// study date is kept, to find a patient's prior study. Nothing here leaves the computer.
import type { DeauvilleScore, PetAcquisition, ReferenceRole, Series, Vec3 } from '../model';
import { plausibleGlucose } from '../imaging/glucose';

export const PET_STUDIES_STORAGE = 'veacom:pet-studies:v1';
/** At most this many studies are kept; the ones saved longest ago go first. */
export const PET_STUDIES_LIMIT = 300;
export const REFERENCE_ROLES: readonly ReferenceRole[] = ['liver', 'bloodPool'];
const THRESHOLD_IDS = ['max41', 'suv2.5'] as const;
const SCORES: readonly DeauvilleScore[] = [1, 2, 3, 4, 5, 'X'];

export interface StoredSphere { id?: string; center: Vec3; radius: number }
/** A stored lesion uses SUVbw. The live table may use another explicitly named SUV normalization. */
export interface LesionValues { max: number; mean: number; peak?: number; mtv?: number; tlg?: number }
export interface StoredLesion extends StoredSphere {
  name: string;
  threshold?: typeof THRESHOLD_IDS[number];
  deauville?: DeauvilleScore;
  deauvilleBasis?: string;
  fdgLymphoma?: boolean;
  priorLesionId?: string;
  regionSeeds?: number[];
  values?: LesionValues;
}
/** What a PET's files recorded that a later study is compared on (src/imaging/petComparison.ts): seconds from the
 * injection to the scan, the scanner model, the reconstruction method and blood glucose in mmol/l. */
export interface StoredAcquisition { uptakeSeconds?: number; scannerModel?: string; reconstruction?: string; glucose?: number }
export interface PetSeriesRecord {
  references: Partial<Record<ReferenceRole, StoredSphere>>;
  lesions?: StoredLesion[];
  tracer?: string;
  /** SUL and SUVbsa per SUVbw on this series (its patient's height, weight and sex then), to read kept values in either. */
  sulPerBw?: number; bsaPerBw?: number;
  acquisition?: StoredAcquisition;
  /** The reader confirmed this series covers only the lesion region. */
  limitedView?: true;
}
export interface PetStudyRecord {
  savedAt: number; series: Record<string, PetSeriesRecord>;
  /** A digest of the patient's ID and name, and the study date (YYYYMMDD): how a later study finds this one. */
  patient?: string; date?: string;
  /** The blood glucose in mmol/l the reader typed for this study, for SULglu (src/imaging/glucose.ts). */
  glucose?: number;
}
export type PetStudyRecords = Record<string, PetStudyRecord>;

const DIGEST = /^[0-9a-f]{64}$/, DATE = /^\d{8}$/, NAME = /^[^\u0000-\u001f]{1,24}$/, RECORDED = /^[^\u0000-\u001f]{1,64}$/;
const isPoint = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e6);
const isValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e9;
const positive = (value: unknown): value is number => isValue(value) && value > 0;

const isId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,96}$/.test(value);
function readSphere(value: unknown): StoredSphere | null {
  if (!value || typeof value !== 'object') return null;
  const sphere = value as Record<string, unknown>;
  return isPoint(sphere.center) && typeof sphere.radius === 'number' && Number.isFinite(sphere.radius) && sphere.radius > 0 && sphere.radius < 1e4
    ? { ...(isId(sphere.id) ? { id: sphere.id } : {}), center: [sphere.center[0], sphere.center[1], sphere.center[2]], radius: sphere.radius } : null;
}

function readValues(value: unknown): LesionValues | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const stored = value as Record<string, unknown>;
  if (!isValue(stored.max) || !isValue(stored.mean)) return undefined;
  const values: LesionValues = { max: stored.max, mean: stored.mean };
  for (const key of ['peak', 'mtv', 'tlg'] as const) if (isValue(stored[key])) values[key] = stored[key];
  return values;
}

function readLesion(value: unknown): StoredLesion | null {
  const sphere = readSphere(value);
  if (!sphere) return null;
  const stored = value as Record<string, unknown>;
  if (typeof stored.name !== 'string' || !NAME.test(stored.name)) return null;
  const lesion: StoredLesion = { ...sphere, name: stored.name };
  if (THRESHOLD_IDS.includes(stored.threshold as typeof THRESHOLD_IDS[number])) lesion.threshold = stored.threshold as typeof THRESHOLD_IDS[number];
  if (isId(stored.priorLesionId)) lesion.priorLesionId = stored.priorLesionId;
  if (stored.fdgLymphoma === true) lesion.fdgLymphoma = true;
  if (Array.isArray(stored.regionSeeds) && stored.regionSeeds.every(n => Number.isSafeInteger(n) && n >= 0)) lesion.regionSeeds = stored.regionSeeds;
  if (lesion.fdgLymphoma && SCORES.includes(stored.deauville as DeauvilleScore) && typeof stored.deauvilleBasis === 'string' && stored.deauvilleBasis.length <= 4096) {
    lesion.deauville = stored.deauville as DeauvilleScore;
    lesion.deauvilleBasis = stored.deauvilleBasis;
  }
  const values = readValues(stored.values);
  if (values) lesion.values = values;
  return lesion;
}

/** What a PET's acquisition keeps for a later study's comparison, from its files; nothing when it recorded none of it. */
export function storedAcquisition(pet: PetAcquisition | undefined): StoredAcquisition | undefined {
  const kept: StoredAcquisition = {};
  if (isValue(pet?.uptakeSeconds) && pet.uptakeSeconds >= 0) kept.uptakeSeconds = pet.uptakeSeconds;
  for (const key of ['scannerModel', 'reconstruction'] as const) {
    const value = pet?.[key];
    if (typeof value === 'string' && RECORDED.test(value.trim())) kept[key] = value.trim();
  }
  if (positive(pet?.glucose)) kept.glucose = pet.glucose;
  return Object.keys(kept).length ? kept : undefined;
}
const readAcquisition = (value: unknown) => value && typeof value === 'object' ? storedAcquisition(value as PetAcquisition) : undefined;

const holds = (record: PetSeriesRecord) => !!(record.acquisition || record.limitedView || record.lesions?.length || Object.keys(record.references).length);

/** The records as stored, checked as `readSettings` checks the workspace: anything unknown or malformed is dropped. A
 * record written before lesions were kept (references only) reads as it was. */
export function readPetStudies(raw: string | null): PetStudyRecords {
  let stored: unknown;
  try { stored = JSON.parse(raw ?? 'null'); } catch { return {}; }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const records: PetStudyRecords = {};
  for (const [study, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!DIGEST.test(study) || !value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt) || !record.series || typeof record.series !== 'object') continue;
    const series: Record<string, PetSeriesRecord> = {};
    for (const [id, entry] of Object.entries(record.series as Record<string, unknown>)) {
      if (!DIGEST.test(id) || !entry || typeof entry !== 'object') continue;
      const fields = entry as Record<string, unknown>, kept = fields.references as Record<string, unknown> | undefined;
      const result: PetSeriesRecord = { references: {} };
      for (const role of REFERENCE_ROLES) { const sphere = readSphere(kept?.[role]); if (sphere) result.references[role] = sphere; }
      if (Array.isArray(fields.lesions)) {
        const lesions = fields.lesions.flatMap(item => readLesion(item) ?? []);
        if (lesions.length) result.lesions = lesions;
      }
      if (typeof fields.tracer === 'string' && fields.tracer.length <= 512) result.tracer = fields.tracer;
      if (positive(fields.sulPerBw)) result.sulPerBw = fields.sulPerBw;
      if (positive(fields.bsaPerBw)) result.bsaPerBw = fields.bsaPerBw;
      const acquisition = readAcquisition(fields.acquisition);
      if (acquisition) result.acquisition = acquisition;
      if (fields.limitedView === true) result.limitedView = true;
      if (holds(result)) series[id] = result;
    }
    const glucose = plausibleGlucose(record.glucose) ? record.glucose : undefined;
    if (!Object.keys(series).length && glucose === undefined) continue;
    records[study] = { savedAt: record.savedAt, series, ...(glucose !== undefined ? { glucose } : {}) };
    if (typeof record.patient === 'string' && DIGEST.test(record.patient)) records[study].patient = record.patient;
    if (typeof record.date === 'string' && DATE.test(record.date)) records[study].date = record.date;
  }
  return records;
}

/** The records with one series' record replaced (or removed, when it holds nothing) and the study's patient and date
 * set, keeping at most `limit` studies. */
export function withPetSeries(records: PetStudyRecords, study: string, series: string, record: PetSeriesRecord | null, now: number,
  info: { patient?: string; date?: string } = {}, limit = PET_STUDIES_LIMIT): PetStudyRecords {
  const next: PetStudyRecords = { ...records };
  const entries = { ...next[study]?.series };
  if (record && holds(record)) entries[series] = record; else delete entries[series];
  return withStudy(next, study, entries, next[study]?.glucose, now, info, limit);
}

/** The records with the blood glucose typed for a study set (or cleared, with null), keeping at most `limit` studies. */
export function withStudyGlucose(records: PetStudyRecords, study: string, glucose: number | null, now: number,
  info: { patient?: string; date?: string } = {}, limit = PET_STUDIES_LIMIT): PetStudyRecords {
  if (glucose !== null && !plausibleGlucose(glucose)) return records;
  return withStudy({ ...records }, study, { ...records[study]?.series }, glucose ?? undefined, now, info, limit);
}

/** `next` with a study's series and typed glucose, its patient and date set; the study goes when it keeps nothing. */
function withStudy(next: PetStudyRecords, study: string, entries: Record<string, PetSeriesRecord>, glucose: number | undefined, now: number,
  info: { patient?: string; date?: string }, limit: number): PetStudyRecords {
  if (Object.keys(entries).length || glucose !== undefined) {
    const patient = Object.hasOwn(info, 'patient') ? info.patient : next[study]?.patient, date = info.date && DATE.test(info.date) ? info.date : next[study]?.date;
    next[study] = { savedAt: now, series: entries, ...(patient ? { patient } : {}), ...(date ? { date } : {}), ...(glucose !== undefined ? { glucose } : {}) };
  } else delete next[study];
  const studies = Object.entries(next);
  if (studies.length <= limit) return next;
  return Object.fromEntries(studies.sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, limit));
}

/** Whether two series records hold the same spheres, lesions and values. */
export function sameSeriesRecord(a: PetSeriesRecord | null | undefined, b: PetSeriesRecord | null | undefined): boolean {
  const empty = (record: PetSeriesRecord | null | undefined) => !record || !holds(record);
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  return JSON.stringify(canonical(a!)) === JSON.stringify(canonical(b!));
}
const canonical = (record: PetSeriesRecord) => ({ liver: record.references.liver ?? null, bloodPool: record.references.bloodPool ?? null,
  lesions: record.lesions ?? [], tracer: record.tracer, sulPerBw: record.sulPerBw ?? null, bsaPerBw: record.bsaPerBw ?? null, acquisition: record.acquisition ?? null, limitedView: !!record.limitedView });

/** A kept prior: its study date, the series compared with, and the blood glucose typed for its study. */
export interface KeptPrior { date: string; series: PetSeriesRecord; glucose?: number }

/** Most recent comparable stored study. Tied studies or reconstructions require the reader to open the desired one. */
export function priorRecord(records: PetStudyRecords, patient: string | undefined, date: string, tracer: string | undefined, preferMeasured = false): KeptPrior | null {
  if (!patient || !tracer || !DATE.test(date)) return null;
  const eligible: KeptPrior[] = [];
  for (const study of Object.values(records)) {
    if (study.patient !== patient || !study.date || study.date >= date) continue;
    for (const series of Object.values(study.series)) {
      if (series.tracer !== tracer || (!series.lesions?.length && !series.acquisition)) continue;
      eligible.push({ date: study.date, series, ...(study.glucose !== undefined ? { glucose: study.glucose } : {}) });
    }
  }
  // An intervening unmarked exam must not displace the lesion table's measured prior.
  const measured = preferMeasured ? eligible.filter(prior => prior.series.lesions?.length) : [];
  const candidates = measured.length ? measured : eligible;
  const latest = candidates.reduce((date, prior) => date > prior.date ? date : prior.date, '');
  const matches = candidates.filter(prior => prior.date === latest);
  return matches.length === 1 ? matches[0] : null;
}

/** The SHA-256 digest of a text, as lowercase hex. */
export async function uidDigest(uid: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The native patient key includes the issuer and is scoped to the study for unissued IDs. */
export function patientDigest(series: Pick<Series, 'patientId' | 'patientKey'>): string | undefined {
  return series.patientId.trim() && series.patientKey && DIGEST.test(series.patientKey) ? series.patientKey : undefined;
}
