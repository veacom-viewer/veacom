import type { Series } from '../model';

export function patientKey(item: Series): string {
  return item.patientKey || `${item.patientId}\u0000${item.patientName}\u0000${item.patientBirthDate ?? ''}`;
}

export function studyKey(item: Series): string {
  return item.studyUid ? `${item.studyUid}\u0000${patientKey(item)}` : `unassigned:${item.id}`;
}
