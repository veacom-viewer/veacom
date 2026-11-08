// "Copy for the report" in a PET's Findings: what a nuclear medicine reader would otherwise retype into the report, as
// text in the interface language. The technique as the PET acquisition panel shows it, the liver and blood pool
// references, a line for each lesion of the lesion table with its change against the prior lesion the reader matched,
// and what limits the numbers: the engine's reason for refusing SUV, the acquisition panel's checks and the follow-up's
// comparability cautions. Numbers are written as the lesion table and the panel write them, each with its unit, and with
// what limits them: a sphere partly outside the image, voxels left out, a contour waiting for its regions. A value is
// called SUV only when the engine calibrated the PET in SUV; a PET it refused gives its technique and says why.
import type { Annotation, DeauvilleScore, PetAcquisition, ReferenceRole, Series, Volume } from '../model';
import type { LesionValues } from '../domain/petStudies';
import { translate, type Locale, type MessageKey, type MessageParams } from '../i18n';
import { coreText, type CoreNote } from '../i18n/core';
import { dicomDate, general } from '../ui/overlayCorners';
import { quantitativeScale } from './annotations';
import { petHasSuv } from './emission';
import { currentDeauville } from './deauvilleReading';
import { studyGlucose, sulGlu, sulGluGlucose, type StudyGlucose } from './glucose';
import { isLesion, lesionValues, percentChange, percentText } from './lesions';
import { flagText, petFlags, petRows, withTypedGlucose, type PetFlag, type PetRow } from './petAcquisition';
import { comparisonFlags, comparisonText, type Compared, type ComparisonFlag, type PetPrior } from './petComparison';
import type { PriorLesions } from './priorLesions';
import { isSuv, measurableVolume, peakName, sphereStatisticsFor, thresholdVolumeFor, type SphereStatistics, type ThresholdId } from './voi';

export interface PetReportInput {
  /** The PET: its volume's series when it has one, which carries the PET values setting. */
  series: Series;
  volume: Volume | undefined;
  annotations: readonly Annotation[];
  /** The glucose the reader typed for its study, in mmol/l, used when its files record none. */
  typedGlucose?: number;
  /** Its prior's lesions, as the lesion table reads them. */
  lesionPrior: PriorLesions | null;
  /** Its prior's acquisition, as the panels compare it. */
  comparison: { current: Compared; prior: PetPrior; limited: boolean } | null;
}

/** Changes in per cent, where the lesion table shows one. */
export type Changes = Partial<Record<'max' | 'peak' | 'mtv' | 'tlg', number>>;
/** What limits a sphere's values: part of it outside the image, and padding or non-finite voxels left out. */
export interface Coverage { clipped: boolean; padding: number; invalid: number }

export interface ReportLesion {
  name: string;
  /** In the report's unit, MTV in mL; null when they cannot be measured. */
  values: LesionValues | null;
  coverage?: Coverage;
  threshold?: ThresholdId;
  /** Why a lesion with a threshold has no MTV: its regions are not selected yet, or it cannot be had. */
  contour?: 'regions' | 'unavailable';
  changes: Changes;
  /** The prior lesion the reader matched it with: whether it has values in the report's unit, and whether the two were
   * contoured at different thresholds. */
  prior?: { name: string; measured: boolean; differentThreshold: boolean };
  /** SULglu max and peak with their changes: in SUL, on an FDG PET with a glucose. */
  sulGlu?: { max: number; peak?: number; changes: Changes };
  /** The Deauville score the reader confirmed, while its basis stands. */
  deauville?: DeauvilleScore;
}

/** A reference sphere's max and mean in the report's unit; neither when it cannot be measured. */
export interface ReportReference { role: ReferenceRole; max?: number; mean?: number; coverage?: Coverage }

export interface PetReport {
  /** This study's date, YYYYMMDD. */
  date: string;
  /** The acquisition as the panel shows it: with the typed glucose where the files record none. */
  pet: PetAcquisition;
  glucoseTyped: boolean;
  /** Whether the engine calibrated the PET in SUV, and the SUV it is read in: SUVbw, SUL or SUVbsa ('' without SUV). */
  suv: boolean;
  unit: string;
  /** The engine's reasons for giving the PET no SUV. */
  refusals: CoreNote[];
  references: ReportReference[];
  lesions: ReportLesion[];
  /** Why spheres on an SUV PET have no values: its whole volume has not loaded, or it cannot be measured in 3D. */
  unmeasured: 'loading' | 'reconstruct' | null;
  /** The date of the prior the lesions are compared with. */
  priorDate: string | null;
  /** The glucose SULglu uses for this study and for the prior, when SULglu is shown. */
  sulGlu: { glucose: StudyGlucose; prior: StudyGlucose | null } | null;
  /** The acquisition panel's checks before reading SUV. */
  flags: PetFlag[];
  /** What limits the comparison with the prior. */
  comparison: (NonNullable<PetReportInput['comparison']> & { flags: ComparisonFlag[] }) | null;
}

const change = (now: number | undefined, before: number | undefined) => percentChange(now, before) ?? undefined;
/** `changes` without the ones that cannot be told. */
const told = (changes: Changes): Changes => Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
const coverageOf = (stats: SphereStatistics | null): Coverage | undefined => stats && (stats.clipped || stats.paddingCount || stats.invalidCount)
  ? { clipped: stats.clipped, padding: stats.paddingCount, invalid: stats.invalidCount } : undefined;

/** What the report says, read from the PET's measurements as the lesion table and the acquisition panel read them. */
export function petReport({ series, volume, annotations, typedGlucose, lesionPrior, comparison }: PetReportInput): PetReport {
  const shown = volume?.series ?? series, quantity = quantitativeScale(shown), suv = isSuv(quantity.unit) && petHasSuv(shown);
  const measured = volume && measurableVolume(volume) ? volume : null;
  const statistics = (sphere: Annotation) => measured ? sphereStatisticsFor(sphere, measured, quantity) : null;
  const glucose = suv ? sulGluGlucose(shown, quantity.unit) : null, priorGlucose = lesionPrior?.glucose ?? null;
  const corrected = (value: number | undefined, at: StudyGlucose | null) => value === undefined || !at ? undefined : sulGlu(value, at);
  const references: ReportReference[] = suv ? (['liver', 'bloodPool'] as const).flatMap(role => {
    const sphere = annotations.find(item => item.type === 'sphere' && item.role === role), stats = sphere ? statistics(sphere) : null;
    const coverage = coverageOf(stats);
    return sphere ? [stats ? { role, max: stats.max, mean: stats.mean, ...(coverage ? { coverage } : {}) } : { role }] : [];
  }) : [];
  const lesions = suv ? annotations.filter(item => isLesion(item) && item.label).map(lesion => {
    const values = measured ? lesionValues(lesion, measured, quantity) : null;
    const matched = lesionPrior?.lesions.find(item => item.id === lesion.priorLesionId);
    const before = matched?.values, sameThreshold = !!lesion.threshold && matched?.threshold === lesion.threshold;
    const item: ReportLesion = { name: lesion.label!, values, changes: told({ max: change(values?.max, before?.max), peak: change(values?.peak, before?.peak),
      mtv: sameThreshold ? change(values?.mtv, before?.mtv) : undefined, tlg: sameThreshold ? change(values?.tlg, before?.tlg) : undefined }) };
    const coverage = values ? coverageOf(statistics(lesion)) : undefined;
    if (coverage) item.coverage = coverage;
    if (lesion.threshold) {
      item.threshold = lesion.threshold;
      if (measured && values && values.mtv === undefined) item.contour = thresholdVolumeFor(lesion, measured, quantity)?.selectionRequired ? 'regions' : 'unavailable';
    }
    if (matched) item.prior = { name: matched.name, measured: !!before, differentThreshold: !!lesion.threshold && !!matched.threshold && !sameThreshold };
    if (glucose && values) {
      const peak = corrected(values.peak, glucose);
      item.sulGlu = { max: sulGlu(values.max, glucose), ...(peak === undefined ? {} : { peak }),
        changes: told({ max: change(sulGlu(values.max, glucose), corrected(before?.max, priorGlucose)), peak: change(peak, corrected(before?.peak, priorGlucose)) }) };
    }
    const score = measured ? currentDeauville(lesion, annotations, measured) : undefined;
    if (score !== undefined) item.deauville = score;
    return item;
  }) : [];
  // As the measurement list says it (src/imaging/annotations.ts, sphereSummary).
  const unmeasured = suv && !measured && annotations.some(item => item.type === 'sphere')
    ? !volume || (volume.sourceFrameIndex !== undefined && volume.series.canReconstruct) ? 'loading' as const : 'reconstruct' as const : null;
  const pet = withTypedGlucose(shown.petAcquisition ?? {}, typedGlucose);
  return {
    date: shown.studyDate, pet, glucoseTyped: studyGlucose(shown.petAcquisition, typedGlucose)?.source === 'typed',
    suv, unit: suv ? quantity.unit : '', refusals: (shown.warningNotes ?? []).filter(note => note.code?.startsWith('series.suv')),
    references, lesions, unmeasured,
    priorDate: suv && lesionPrior ? lesionPrior.date : null,
    sulGlu: glucose && lesions.length ? { glucose, prior: lesionPrior ? priorGlucose : null } : null,
    flags: petFlags(pet, shown.patientSex),
    comparison: comparison && { ...comparison, flags: comparisonFlags(comparison.current, comparison.prior.acquisition, comparison.limited) },
  };
}

/** The acquisition panel's rows the technique gives, in the panel's order. */
const TECHNIQUE: readonly PetRow['key'][] = ['tracer', 'activity', 'uptake', 'weight', 'height', 'glucose'];
/** The PET values setting's names for the SUVs it gives (src/i18n, inspector.suv*). */
const SUV_NAMES: Readonly<Record<string, MessageKey>> = { SUVbw: 'inspector.suvBw', SUL: 'inspector.suvLbm', SUVbsa: 'inspector.suvBsa' };
/** The measurement list's words for voxels left out, one and many. */
const LEFT_OUT = { invalid: ['roi.nonFiniteVoxel', 'roi.nonFiniteVoxels'], padding: ['roi.paddingVoxel', 'roi.paddingVoxels'] } as const;
const mmol = (glucose: StudyGlucose) => general(Math.round(glucose.mmol * 100) / 100);

/** The report as text in `locale`: a title with the study date, then technique, references, lesions and cautions, each
 * under its heading and left out when it has nothing to say. */
export function petReportText(report: PetReport, locale: Locale): string {
  const say = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
  /** A value as the lesion table writes it, with its unit, and its change in brackets where there is one. */
  const amount = (value: number, digits: number, unit: string, changed?: number) =>
    `${value.toFixed(digits)} ${unit}${changed === undefined ? '' : ` (${percentText(changed, locale)})`}`;
  const sentences = (...said: string[]) => said.map(sentence => `${sentence}.`).join(' ');
  /** What limits a sphere's values; voxels left out in the measurement list's words, without its separator. */
  const limits = (coverage?: Coverage) => !coverage ? [] : [
    ...(coverage.clipped ? [say('report.clipped')] : []),
    ...(['invalid', 'padding'] as const).flatMap(kind => coverage[kind]
      ? [say(LEFT_OUT[kind][coverage[kind] === 1 ? 0 : 1], { count: coverage[kind] }).replace(/^\s*·\s*/, '')] : []),
  ];
  const date = dicomDate(report.date), before = report.priorDate === null ? '' : dicomDate(report.priorDate), unit = report.unit;

  const technique = petRows(report.pet, say).filter(row => TECHNIQUE.includes(row.key) && row.value !== null)
    .map(row => `${say(`pet.${row.key}`)}: ${row.key === 'glucose' && report.glucoseTyped ? say('report.glucoseTyped', { value: row.value! }) : row.value}`);
  if (report.suv) technique.push(`${say('inspector.petValues')}: ${SUV_NAMES[unit] ? say(SUV_NAMES[unit]) : unit}`);

  const references = report.references.map(({ role, max, mean, coverage }) => {
    const name = say(role === 'liver' ? 'sphere.roleLiver' : 'sphere.roleBloodPool');
    return max === undefined || mean === undefined ? sentences(say('report.unavailable', { name }))
      : sentences(say('report.reference', { name, max: amount(max, 2, unit), mean: amount(mean, 2, unit) }), ...limits(coverage));
  });

  // Every change is marked when something limits the comparison, as the lesion table marks it.
  const marked = report.priorDate !== null && !!report.comparison?.flags.length;
  const lesions = report.lesions.map(lesion => {
    const { values, changes, sulGlu: corrected, prior } = lesion;
    if (!values) return sentences(say('report.unavailable', { name: lesion.name }));
    const parts = [say('report.max', { value: amount(values.max, 2, unit, changes.max) }),
      values.peak === undefined ? say('sphere.noPeak', { name: peakName(unit) }) : say('report.peak', { value: amount(values.peak, 2, unit, changes.peak) })];
    if (values.mtv !== undefined) parts.push(say('report.mtv', { value: amount(values.mtv, values.mtv < 10 ? 2 : 1, 'mL', changes.mtv) }));
    if (values.tlg !== undefined) parts.push(say('report.tlg', { value: amount(values.tlg, 1, `${unit}·mL`, changes.tlg) }));
    if (lesion.threshold) parts.push(say('report.threshold', { threshold: say(lesion.threshold === 'max41' ? 'sphere.thresholdMax41' : 'sphere.thresholdSuv') }));
    if (lesion.contour) parts.push(say(lesion.contour === 'regions' ? 'report.regionsNeeded' : 'report.mtvUnavailable'));
    if (corrected) {
      parts.push(say('report.max', { value: amount(corrected.max, 2, 'SULglu', corrected.changes.max) }));
      if (corrected.peak !== undefined) parts.push(say('report.peak', { value: amount(corrected.peak, 2, 'SULglu', corrected.changes.peak) }));
    }
    if (lesion.deauville !== undefined) parts.push(say('deauville.label', { score: lesion.deauville }));
    const said = [`${lesion.name}: ${parts.join(', ')}`, ...limits(lesion.coverage)];
    // A matched prior lesion is named with both dates, even when no change can be told against it.
    if (prior && report.priorDate !== null) {
      const compared = Object.keys({ ...changes, ...corrected?.changes }).length > 0;
      said.push(say(compared ? 'report.change' : 'report.changeUnavailable', { prior: prior.name, before, now: date }));
      if (!prior.measured) said.push(say('report.priorNoValues', { prior: prior.name, unit }));
      if (prior.differentThreshold) said.push(say('lesion.differentThreshold'));
      if (compared && marked) said.push(say('lesion.changeCaution'));
    }
    return sentences(...said);
  });
  if (report.sulGlu) {
    const { glucose, prior } = report.sulGlu;
    const own = say(glucose.source === 'typed' ? 'lesion.sulGluTyped' : 'lesion.sulGluFile', { glucose: mmol(glucose) });
    const earlier = report.priorDate === null ? '' : ` ${prior ? say(prior.source === 'typed' ? 'lesion.sulGluPriorTyped' : 'lesion.sulGluPriorFile', { date: before, glucose: mmol(prior) })
      : say('lesion.sulGluNoPrior', { date: before })}`;
    lesions.push(own + earlier, say('pet.glucoseCaveat'));
  }

  const comparison = report.comparison;
  const cautions = [
    ...(report.suv ? [] : [say('report.noSuv')]),
    ...report.refusals.map(note => coreText(note, locale)),
    ...(report.unmeasured ? [say(report.unmeasured === 'loading' ? 'sphere.wholeVolume' : 'sphere.notMeasurable')] : []),
    ...report.flags.map(flag => flagText(flag, report.pet, say)),
    ...(comparison ? comparison.flags.map(flag => comparisonText(flag, comparison.current, comparison.prior, comparison.limited, say)) : []),
  ];

  const sections = [[say('report.technique'), ...technique], [say('report.references'), ...references], [say('lesion.table'), ...lesions], [say('report.cautions'), ...cautions]];
  return [date ? `${say('report.title')} · ${date}` : say('report.title'), ...sections.filter(lines => lines.length > 1).map(lines => lines.join('\n'))].join('\n\n');
}
