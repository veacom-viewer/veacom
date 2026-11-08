import type { Annotation, Series, Volume } from '../model';
import type { KeptPrior, LesionValues } from '../domain/petStudies';
import { studyGlucose, type StudyGlucose } from './glucose';
import { petTracer } from './petTracer';
import { bodyWeight, isLesion, lesionValues, valuesIn } from './lesions';
import { measurableVolume } from './voi';
import { quantitativeScale } from './annotations';

export interface PriorLesion { id: string; name: string; threshold?: Annotation['threshold']; values?: LesionValues }
/** The prior's lesions, and for an FDG prior the glucose its study was read with (for SULglu), if any. */
export interface PriorLesions { date: string; kept: boolean; lesions: PriorLesion[]; glucose: StudyGlucose | null }

export function priorLesions(prior: Series | null, annotations: Readonly<Record<string, Annotation[]>>, volumes: ReadonlyMap<string, Volume>,
  kept: KeptPrior | null, unit: string): PriorLesions | null {
  const volume = prior && volumes.get(prior.id);
  if (prior && volume && measurableVolume(volume)) {
    const displayed = quantitativeScale(volume.series);
    const factor = unit === 'SUL' ? volume.series.sulFactor : unit === 'SUVbsa' ? volume.series.suvBsaFactor : undefined;
    const quantity = displayed.unit === unit ? displayed : unit === 'SUVbw' ? bodyWeight(volume.series)
      : factor && Number.isFinite(factor) && factor > 0 ? { factor, unit } : null;
    const lesions = (annotations[prior.id] ?? []).filter(item => isLesion(item) && item.label)
      .map(item => ({ id: item.id, name: item.label!, threshold: item.threshold,
        values: quantity ? lesionValues(item, volume, quantity) ?? undefined : undefined }));
    const glucose = petTracer(volume.series.petAcquisition) === 'fdg' ? studyGlucose(volume.series.petAcquisition, volume.series.typedGlucose) : null;
    if (lesions.length) return { date: prior.studyDate, kept: false, lesions, glucose };
  }
  if (!kept) return null;
  const lesions = (kept.series.lesions ?? []).flatMap(item => item.id ? [{ id: item.id, name: item.name, threshold: item.threshold,
    values: item.values ? valuesIn(item.values, unit, kept.series) ?? undefined : undefined }] : []);
  const glucose = kept.series.tracer === 'fdg' ? studyGlucose({ glucose: kept.series.acquisition?.glucose }, kept.glucose) : null;
  return lesions.length ? { date: kept.date, kept: true, lesions, glucose } : null;
}
