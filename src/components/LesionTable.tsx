// PET lesion measurements and changes against the prior lesion selected by the reader. In SUL, with a blood glucose,
// each lesion also gives SULglu under its SUL values (imaging/glucose.ts). What limits the comparison with the prior
// (imaging/petComparison.ts) marks every change and is said under the table.
import { Fragment } from 'react';
import type { Annotation, ViewVolume as Volume } from '../model';
import type { PriorLesions } from '../imaging/priorLesions';
import { currentDeauville } from '../imaging/deauvilleReading';
import { quantitativeScale } from '../imaging/annotations';
import { isLesion, measuredValues, percentChange, percentText } from '../imaging/lesions';
import { useMeasuredSpheres } from '../imaging/useMeasuredSpheres';
import { isSuv, measurableVolume } from '../imaging/voi';
import { sulGlu, sulGluGlucose, type StudyGlucose } from '../imaging/glucose';
import { dicomDate, general } from '../ui/overlayCorners';
import { useTranslation } from '../i18n/react';
import { WarningBox } from './WarningBox';
import { TriangleAlert } from './icons';

const mmol = (glucose: StudyGlucose) => general(Math.round(glucose.mmol * 100) / 100);
const corrected = (value: number | undefined, glucose: StudyGlucose | null | undefined) => value === undefined || !glucose ? undefined : sulGlu(value, glucose);

function Cell({ now, before, digits, caution }: { now: number | undefined; before: number | undefined; digits: number; caution: string }) {
  const { locale } = useTranslation();
  const change = percentChange(now, before);
  return <td>{now === undefined || !Number.isFinite(now) ? '—' : now.toFixed(digits)}
    {change !== null ? <small data-change className={caution ? 'is-caution' : undefined}>{percentText(change, locale)}{caution
      && <span className="change-caution" role="img" aria-label={caution} data-tooltip={caution} data-caution><TriangleAlert size={11} /></span>}</small> : null}</td>;
}

export function LesionTable({ annotations, volume, prior, onMatch, saveFailed, onRetry, cautions, cautionKey }: { annotations: readonly Annotation[]; volume: Volume | undefined; prior: PriorLesions | null; onMatch: (seriesId: string, id: string, priorId: string | undefined) => void; saveFailed: boolean; onRetry: () => void; cautions: readonly string[]; cautionKey: string }) {
  const { t } = useTranslation();
  const measured = useMeasuredSpheres(annotations, volume);
  if (!volume || volume.series.modality !== 'PT' || !measurableVolume(volume)) return null;
  const quantity = quantitativeScale(volume.series), lesions = annotations.filter(item => isLesion(item) && item.label);
  if (!isSuv(quantity.unit) || !lesions.length) return null;
  const assignments = new Map(lesions.filter(item => item.priorLesionId).map(item => [item.priorLesionId, item.id]));
  // SULglu: an FDG PET shown in SUL, with a glucose; the prior's change needs the prior's own glucose.
  const glucose = sulGluGlucose(volume.series, quantity.unit), priorGlucose = prior?.glucose;
  const caution = prior && cautions.length ? [t('lesion.changeCaution'), ...cautions].join(' ') : '';
  return <section className="panel-block lesion-table" aria-labelledby="lesion-table-title" data-lesion-table>
    <h3 className="block-title" id="lesion-table-title">{t('lesion.table')}</h3>
    <div className="lesion-table-scroll"><table>
      <thead><tr><th scope="col">{t('lesion.lesion')}</th><th scope="col">{t('lesion.max')}</th><th scope="col">{t('lesion.peak')}</th>
        <th scope="col">{t('lesion.mtv')}</th><th scope="col">{t('lesion.tlg')}</th><th scope="col">{t('lesion.score')}</th></tr></thead>
      <tbody>{lesions.map(lesion => {
        const values = measuredValues(measured.get(lesion)?.result);
        const matched = prior?.lesions.find(item => item.id === lesion.priorLesionId);
        const before = matched?.values, sameThreshold = !!lesion.threshold && matched?.threshold === lesion.threshold;
        return <Fragment key={lesion.id}><tr data-lesion={lesion.label}>
          <th scope="row">{lesion.label}{prior && <select data-action="lesion-match" aria-label={t('lesion.match', { name: lesion.label! })}
            title={matched?.name ?? t('lesion.unmatched')} value={matched?.id ?? ''} onChange={event => onMatch(volume.series.id, lesion.id, event.target.value || undefined)}>
            <option value="">{t('lesion.unmatched')}</option>
            {prior.lesions.map(item => <option key={item.id} value={item.id}
              disabled={assignments.has(item.id) && assignments.get(item.id) !== lesion.id}>{item.name}</option>)}
          </select>}{matched && lesion.threshold && matched.threshold && !sameThreshold && <small>{t('lesion.differentThreshold')}</small>}</th>
          <Cell now={values?.max} before={before?.max} digits={2} caution={caution} />
          <Cell now={values?.peak} before={before?.peak} digits={2} caution={caution} />
          <Cell now={values?.mtv} before={sameThreshold ? before?.mtv : undefined} digits={values?.mtv !== undefined && values.mtv < 10 ? 2 : 1} caution={caution} />
          <Cell now={values?.tlg} before={sameThreshold ? before?.tlg : undefined} digits={1} caution={caution} />
          <td>{currentDeauville(lesion, annotations, volume, item => measured.get(item)?.result ?? null) ?? '—'}</td>
        </tr>
        {glucose && <tr className="lesion-sulglu" data-lesion-sulglu={lesion.label}>
          <th scope="row">{t('lesion.sulGlu')}</th>
          <Cell now={corrected(values?.max, glucose)} before={corrected(before?.max, priorGlucose)} digits={2} caution={caution} />
          <Cell now={corrected(values?.peak, glucose)} before={corrected(before?.peak, priorGlucose)} digits={2} caution={caution} />
          <td colSpan={3} />
        </tr>}</Fragment>;
      })}</tbody>
    </table></div>
    <p className="field-help">{t('lesion.units', { unit: quantity.unit })}</p>
    {glucose && <p className="field-help" data-sulglu-note>{t(glucose.source === 'typed' ? 'lesion.sulGluTyped' : 'lesion.sulGluFile', { glucose: mmol(glucose) })}
      {prior && ` ${priorGlucose ? t(priorGlucose.source === 'typed' ? 'lesion.sulGluPriorTyped' : 'lesion.sulGluPriorFile', { date: dicomDate(prior.date), glucose: mmol(priorGlucose) })
        : t('lesion.sulGluNoPrior', { date: dicomDate(prior.date) })}`}</p>}
    {glucose && <p className="field-help">{t('pet.glucoseCaveat')}</p>}
    <p className="field-help" data-lesion-prior>{prior ? t(prior.kept ? 'lesion.priorKept' : 'lesion.prior', { date: dicomDate(prior.date) }) : t('lesion.noPrior')}</p>
    {caution && <WarningBox title={t('pet.compare')} className="lesion-cautions" testId="lesion-cautions" dismissKey={cautionKey}>
      {cautions.map(text => <p key={text}>{text}</p>)}</WarningBox>}
    <p className="field-help">{t(saveFailed ? 'lesion.saveFailed' : 'lesion.kept')}</p>
    {saveFailed && <button type="button" className="secondary-button compact" data-action="pet-retry-save" onClick={onRetry}>{t('lesion.retrySave')}</button>}
  </section>;
}
