import type { Series } from '../model';

/** The folder a series' pictures are exported into. It names the patient and the series only when the pictures show
 * them too (`includePatient`): with the overlays reduced or off, or patient details hidden in the viewer, it is plain
 * "VEAcom". */
export function imageExportName(series: Pick<Series, 'patientName' | 'description'> | undefined, includePatient: boolean): string {
  if (!includePatient) return 'VEAcom';
  return [series?.patientName.replaceAll('^', ' ').trim(), series?.description].filter(Boolean).join(' - ') || 'VEAcom';
}
