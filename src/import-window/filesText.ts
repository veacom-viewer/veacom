import { t } from '../i18n';

/** The line under the import window's list: how many files the folder holds, and whether it has a DICOMDIR. One file
 * has messages of its own, as the messages have no plural forms: English says "1 file", not "1 files". */
export function filesText(files: number, dicomdir: boolean): string {
  if (files === 1) return t(dicomdir ? 'import.oneFileDicomdir' : 'import.oneFile');
  return t(dicomdir ? 'import.dicomdir' : 'import.files', { count: files });
}
