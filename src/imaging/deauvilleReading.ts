import type { Annotation, ReferenceRole, Volume } from '../model';
import { quantitativeScale } from './annotations';
import { suggestDeauville, type References, type Suggestion, type SuggestionProblem } from './deauville';
import { petTracer } from './petTracer';
import { isSuv, LIVER_REFERENCE_RADIUS_MM, sphereOf, sphereStatisticsFor } from './voi';

export function canAssessLymphoma(volume: Volume): boolean {
  const tracer = petTracer(volume.series.petAcquisition);
  return volume.series.modality === 'PT' && isSuv(quantitativeScale(volume.series).unit) && (tracer === 'fdg' || tracer === 'unknown');
}

const reference = (items: readonly Annotation[], role: ReferenceRole) => items.find(item => item.type === 'sphere' && item.role === role);

type Reading = { problem: SuggestionProblem | 'context' | 'coverage' } | {
  suggestion: Suggestion; lesion: number; references: References; unit: string; basis: string;
};

export function deauvilleReading(lesion: Annotation, annotations: readonly Annotation[], volume: Volume): Reading {
  if (!lesion.fdgLymphoma || lesion.role || !canAssessLymphoma(volume)) return { problem: 'context' };
  const liver = reference(annotations, 'liver'), pool = reference(annotations, 'bloodPool');
  if (!liver || !pool) return { problem: 'missing' };
  const quantity = quantitativeScale(volume.series);
  const measured = [lesion, liver, pool].map(item => {
    const sphere = sphereOf(item), stats = sphereStatisticsFor(item, volume, quantity);
    if (!sphere || !stats || stats.clipped || stats.invalidCount || stats.paddingCount) return null;
    if (item.role === 'liver' && Math.abs(sphere.radius - LIVER_REFERENCE_RADIUS_MM) > 1e-5) return null;
    return { id: item.id, ...sphere, max: stats.max };
  });
  const [focus, hepatic, mediastinal] = measured;
  if (!focus || !hepatic || !mediastinal) return { problem: 'coverage' };
  const references = { liver: hepatic.max, bloodPool: mediastinal.max };
  const suggestion = suggestDeauville(focus.max, references);
  if ('problem' in suggestion) return suggestion;
  return { suggestion, lesion: focus.max, references, unit: quantity.unit, basis: JSON.stringify([volume.series.id, quantity.unit, ...measured]) };
}

export function currentDeauville(lesion: Annotation, annotations: readonly Annotation[], volume: Volume) {
  if (lesion.deauville === undefined || !lesion.deauvilleBasis) return undefined;
  const reading = deauvilleReading(lesion, annotations, volume);
  return 'basis' in reading && reading.basis === lesion.deauvilleBasis ? lesion.deauville : undefined;
}

function geometry(item: Annotation | undefined) {
  return item && JSON.stringify([item.id, sphereOf(item)]);
}

/** Undo keeps the prior reading. Changing either reference invalidates all confirmations on this series. */
export function clearEditedScores(previous: readonly Annotation[], next: Annotation[]): Annotation[] {
  next = next.map(item => {
    const old = item.regionSeeds && previous.find(other => other.id === item.id);
    return old && geometry(old) !== geometry(item) ? { ...item, regionSeeds: undefined } : item;
  });
  if (!next.some(item => item.deauville !== undefined)) return next;
  const changed = (['liver', 'bloodPool'] as const).some(role => geometry(reference(previous, role)) !== geometry(reference(next, role)));
  return next.map(item => {
    const prior = previous.find(old => old.id === item.id);
    if (item.deauville === undefined || prior?.deauville === undefined || (!changed && geometry(prior) === geometry(item))) return item;
    const { deauville: _, deauvilleBasis: _basis, ...rest } = item;
    return rest;
  });
}
