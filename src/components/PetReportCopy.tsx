// "Copy for the report" in a PET's Findings, as the pre-operative checklist has it, with no toolbar button: the PET's
// technique, references, lesions and cautions as text in the interface language (src/imaging/petReport.ts).
import { useState } from 'react';
import { Copy } from './icons';
import { petReport, petReportText, type PetReportInput } from '../imaging/petReport';
import { useMeasuredSpheres } from '../imaging/useMeasuredSpheres';
import { useTranslation } from '../i18n/react';
import { copyText } from '../ui/clipboard';

/** `loading`: the PET's volume is still loading, so its lesions have no values yet. Once it has loaded, what cannot be
 * measured is said in the text. */
export function PetReportCopy({ loading, ...input }: PetReportInput & { loading: boolean }) {
  const { locale, t } = useTranslation();
  const [last, setLast] = useState<{ text: string; copied: boolean; attempt: number } | null>(null);
  // The lesion table's values: the report waits while the engine measures a sphere.
  const spheres = useMeasuredSpheres(input.annotations, input.volume);
  const busy = loading || [...spheres.values()].some(entry => entry.state === 'idle' || entry.state === 'pending');
  const text = busy ? null : petReportText(petReport({ ...input, measured: sphere => spheres.get(sphere)?.result }), locale);
  const copy = async () => {
    if (text === null) return;
    const attempt = (last?.attempt ?? 0) + 1;
    try { await copyText(text); setLast({ text, copied: true, attempt }); } catch { setLast({ text, copied: false, attempt }); }
  };
  // "Copied", or why not, stands until the text would change.
  const shown = last && last.text === text ? last : null;
  return <div className="pet-report-copy">
    <button type="button" className="primary-button compact" data-action="pet-report-copy" aria-disabled={busy || undefined}
      aria-describedby={shown && !shown.copied ? 'pet-report-error' : undefined}
      data-tooltip={loading ? t('sphere.wholeVolume') : undefined} onClick={() => void copy()}>
      <Copy size={14} />{shown?.copied ? t('report.copied') : t('report.copy')}</button>
    {shown && !shown.copied && <p className="pet-report-error" id="pet-report-error" role="alert" key={shown.attempt}>{t('report.copyFailed')}</p>}
  </div>;
}
