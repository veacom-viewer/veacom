import { Fragment, useState } from 'react';
import type { Series } from '../model';
import { flagText, petFlags, petRows, withTypedGlucose } from '../imaging/petAcquisition';
import { glucoseInUnit, typedGlucoseMmol, type GlucoseUnit, type StudyGlucose } from '../imaging/glucose';
import { comparisonRows, type Compared, type ComparisonFlag, type PetPrior } from '../imaging/petComparison';
import { dicomDate } from '../ui/overlayCorners';
import { WarningBox } from './WarningBox';
import { useTranslation } from '../i18n/react';

interface TypedGlucose {
  value?: number;
  ready: boolean;
  failed: boolean;
  set: (mmol: number | null) => boolean;
}

function GlucoseInput({ typed }: { typed: TypedGlucose }) {
  const { locale, t } = useTranslation();
  const [unit, setUnit] = useState<GlucoseUnit>(() => locale === 'tr' ? 'mgdl' : 'mmol');
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (typed.value === undefined ? '' : glucoseInUnit(typed.value, unit));
  const invalid = !!draft?.trim() && typedGlucoseMmol(draft, unit) === null;
  const keep = () => {
    if (draft === null || invalid) return;
    const mmol = typedGlucoseMmol(draft, unit);
    if (typed.set(mmol)) setDraft(null);
  };
  return <div className="pet-glucose">
    <label htmlFor="pet-glucose-input">{t('pet.glucoseInput')}</label>
    <div className="pet-glucose-fields">
      <input id="pet-glucose-input" data-action="pet-glucose" type="text" inputMode="decimal" autoComplete="off" value={shown} disabled={!typed.ready}
        aria-invalid={invalid || undefined} aria-describedby="pet-glucose-help"
        onChange={event => setDraft(event.target.value)} onBlur={keep}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); keep(); }
          if (event.key === 'Escape') { event.stopPropagation(); setDraft(null); }
        }} />
      <select data-action="pet-glucose-unit" aria-label={t('pet.glucoseUnit')} value={unit}
        onChange={event => { setUnit(event.target.value as GlucoseUnit); setDraft(null); }}>
        <option value="mmol">mmol/l</option><option value="mgdl">mg/dl</option>
      </select>
    </div>
    {invalid && <p className="pet-glucose-error" role="alert">{t('pet.glucoseInvalid')}</p>}
    <p className="field-help" id="pet-glucose-help">{t('pet.glucoseHelp')}</p>
  </div>;
}

function Reading({ value, source, field, prior = false }: { value: string | null; source?: StudyGlucose['source']; field: string; prior?: boolean }) {
  const { t } = useTranslation();
  return <><span className={value === null ? 'is-missing' : undefined} data-pet-row={prior ? undefined : field} data-prior-row={prior ? field : undefined}>
    {value ?? t('pet.notRecorded')}</span>
    {source && <small className="pet-source" data-glucose-source={source}>{t(`pet.glucoseSource.${source}`)}</small>}</>;
}

interface Props {
  series: Series;
  prior: PetPrior | null;
  current: Compared;
  cautionKey: string;
  cautions: { flag: ComparisonFlag; text: string }[];
  typed: TypedGlucose;
  limited: boolean;
  onLimited: (checked: boolean) => void;
}

export function PetAcquisitionPanel({ series, prior, current, cautions, cautionKey, typed, limited, onLimited }: Props) {
  const { t } = useTranslation();
  const pet = withTypedGlucose(series.petAcquisition ?? {}, typed.value), flags = petFlags(pet, series.patientSex);
  const currentRows = comparisonRows(current, t), priorRows = prior ? comparisonRows(prior.acquisition, t) : [];
  const rows = petRows(pet, t).filter(row => !prior || !currentRows.some(item => item.key === row.key));
  return <section className="panel-block" aria-labelledby="pet-acquisition-title" data-testid="pet-acquisition">
    <h3 className="block-title" id="pet-acquisition-title">{t('pet.section')}</h3>
    <dl className="series-details">{rows.map(row => <Fragment key={row.key}>
      <dt>{t(`pet.${row.key}`)}</dt><dd><Reading field={row.key} value={row.value} source={row.key === 'glucose' ? current.glucose?.source : undefined} /></dd>
    </Fragment>)}</dl>
    {prior && <div className="pet-prior" data-testid="pet-prior">
      <table className="pet-compare-table" aria-label={t('pet.compare')}>
        <thead><tr><td /><th scope="col">{t('pet.current')}<small>{dicomDate(series.studyDate)}</small></th>
          <th scope="col">{t(prior.kept ? 'pet.savedPrior' : 'pet.previous')}<small>{dicomDate(prior.date)}</small></th></tr></thead>
        <tbody>{currentRows.map((row, i) => <tr key={row.key}><th scope="row">{t(`pet.${row.key}`)}</th>
          <td><Reading field={row.key} value={row.value} source={row.source} /></td>
          <td><Reading field={row.key} value={priorRows[i].value} source={priorRows[i].source} prior /></td></tr>)}</tbody>
      </table>
      {current.fdg && <label className="pet-limited"><input type="checkbox" checked={limited} disabled={!typed.ready}
        data-action="pet-limited-view" onChange={event => onLimited(event.target.checked)} />{t('pet.limitedView')}</label>}
      {cautions.length > 0 && <WarningBox title={t('pet.compare')} className="pet-flags" testId="pet-compare-flags" dismissKey={cautionKey}>
        {cautions.map(({ flag, text }) => <p key={flag} data-flag={flag}>{text}</p>)}</WarningBox>}
    </div>}
    {current.fdg && current.glucose?.source !== 'file' && <GlucoseInput typed={typed} />}
    {current.fdg && current.glucose && <p className="field-help">{t('pet.glucoseCaveat')}</p>}
    {typed.failed && <p className="pet-glucose-error" role="alert">{t('pet.acquisitionNotSaved')}</p>}
    {flags.length > 0 && <WarningBox title={t('pet.check')} className="pet-flags" testId="pet-flags" dismissKey={JSON.stringify([series.id, flags, pet])}>
      {flags.map(flag => <p key={flag} data-flag={flag}>{flagText(flag, pet, t)}</p>)}</WarningBox>}
  </section>;
}
