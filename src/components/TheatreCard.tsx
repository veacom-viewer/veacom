import { createPortal } from 'react-dom';
import type { Series } from '../model';
import { useTranslation } from '../i18n/react';
import { topLeftLines } from '../ui/overlayCorners';
import { seriesName } from '../ui/seriesNames';
import { CHECKLISTS, checklistRows, type CheckedSide, type ChecklistState } from '../ui/preopChecklist';
import './TheatreCard.css';

function SideCell({ checked, span }: { checked: CheckedSide; span?: number }) {
  return <td colSpan={span} data-side={checked.side} className={checked.marked ? undefined : 'is-empty'}>
    <strong>{checked.word}</strong>
    {checked.measured && <span>{checked.measured}</span>}
    {checked.slice && <span>{checked.plane} · {checked.slice}</span>}
  </td>;
}

/** The checklist on one printed page for theatre: the patient, each item's right and left side with its answer, its
 * measurement and where it was seen, and how many sides are not marked. It is only ever printed (TheatreCard.css). */
export function TheatreCard({ series, state, hidePatient, printedAt }: { series: Series; state: ChecklistState; hidePatient: boolean; printedAt: Date }) {
  const { locale, t } = useTranslation();
  const groups = checklistRows(state.kind, state.answers, state.notes, locale);
  const sides = groups.flatMap(group => group.items.flatMap(item => item.sides));
  // As the image's corner gives it, unless the reader hid the patient's data.
  const identity = hidePatient ? [t('card.patientHidden')] : topLeftLines(series, false, t).map(line => line.text);
  // Written as the study date is beside it (01.01.2000 12:00).
  const two = (value: number) => String(value).padStart(2, '0');
  const printed = `${two(printedAt.getDate())}.${two(printedAt.getMonth() + 1)}.${printedAt.getFullYear()} ${two(printedAt.getHours())}:${two(printedAt.getMinutes())}`;
  return createPortal(<article className="theatre-card" data-testid="theatre-card" lang={locale}>
    <header>
      <h1>{t('checklist.print')} · {CHECKLISTS[state.kind].title[locale]}</h1>
      <p className="theatre-card-identity">{identity.join(' · ')}</p>
      <p>{seriesName(series)} · {t('card.printed', { date: printed })}</p>
    </header>
    <table>
      <colgroup><col className="theatre-card-item" /><col /><col /></colgroup>
      <thead><tr><th scope="col" /><th scope="col">{t('checklist.right')}</th><th scope="col">{t('checklist.left')}</th></tr></thead>
      {groups.map(group => <tbody key={group.title}>
        <tr className="theatre-card-group"><th scope="rowgroup" colSpan={3}>{group.title}</th></tr>
        {group.items.map(item => <tr key={item.id} data-item={item.id}>
          <th scope="row">{item.label}{item.difference && <small>{item.difference}</small>}</th>
          {item.sided ? item.sides.map(checked => <SideCell key={checked.side} checked={checked} />) : <SideCell checked={item.sides[0]} span={2} />}
        </tr>)}
      </tbody>)}
    </table>
    <footer>{t('card.notMarked', { count: sides.filter(side => !side.marked).length, total: sides.length })} · {t('card.footer')}</footer>
  </article>, document.body);
}

export default TheatreCard;
