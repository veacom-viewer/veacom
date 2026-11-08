import type { PetAcquisition } from '../model';

/** FDG as identified by the radiopharmaceutical, never by the isotope or series description alone. */
export function petTracer(pet?: PetAcquisition): 'fdg' | 'other' | 'unknown' | 'multiple' {
  if (pet?.multipleAdministrations) return 'multiple';
  const code = pet?.tracerCode?.trim(), scheme = pet?.tracerCodeScheme?.trim();
  if (code && (scheme === 'SCT' || scheme === 'SRT')) {
    return (scheme === 'SCT' && code === '35321007') || (scheme === 'SRT' && code === 'C-B1031') ? 'fdg' : 'other';
  }
  const name = [pet?.tracer, pet?.tracerCodeMeaning].filter(Boolean).join(' ').trim();
  if (/\bFDG\b|fludeoxyglucose|fluoro.{0,4}deoxy.{0,4}glucose/i.test(name)) return 'fdg';
  return name || code ? 'other' : 'unknown';
}

/** A radiopharmaceutical that can be matched between studies. An isotope alone cannot identify the tracer. */
export function comparisonTracer(pet?: PetAcquisition): string | undefined {
  const tracer = petTracer(pet);
  if (tracer === 'fdg') return 'fdg';
  if (tracer !== 'other' || !pet) return undefined;
  if (pet.tracerCodeScheme && pet.tracerCode) return JSON.stringify([pet.tracerCodeScheme, pet.tracerCode]);
  return (pet.tracer || pet.tracerCodeMeaning)?.trim().toUpperCase() || undefined;
}
