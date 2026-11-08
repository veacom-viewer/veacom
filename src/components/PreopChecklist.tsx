import { studyKey } from '../domain/patient';
import { useState } from 'react';
import { ClipboardCheck, Copy, Crosshair, X } from './icons';
import type { Series } from '../model';
import { useTranslation } from '../i18n/react';
import { copyText } from '../ui/clipboard';
import { CHECKLISTS, FINDING, checklistKind, checklistSummary, type Answers, type ChecklistKind, type Notes, type Side, type SliceNote } from '../ui/preopChecklist';
import './PreopChecklist.css';

// Each study's answers stay while the viewer is open (closing the panel keeps them).
const kept = new Map<string, { kind: ChecklistKind; answers: Answers; notes: Notes }>();

/** The pre-operative checklist beside the images: each finding marked per side, with the slice it was seen on. */
export function PreopChecklist({ series, onClose, onNote, onGoTo, headingRef }: {
  series: Series; onClose: () => void;
  /** The slice on screen now (null without one). */
  onNote: () => SliceNote | null;
  onGoTo: (note: SliceNote) => void;
  headingRef?: (heading: HTMLHeadingElement | null) => void;
}) {
  const { locale, t } = useTranslation();
  const key = studyKey(series);
  const detected = checklistKind(series);
  const [state, setState] = useState(() => { const saved = kept.get(key); return saved ? { ...saved, kind: detected ?? saved.kind } : { kind: detected ?? 'pns' as ChecklistKind, answers: {}, notes: {} }; });
  const [copied, setCopied] = useState(false);
  const update = (next: typeof state) => { kept.set(key, next); setState(next); setCopied(false); };
  const list = CHECKLISTS[state.kind];
  const items = list.groups.flatMap(group => group.items);
  const total = items.reduce((sum, item) => sum + (item.sided ? 2 : 1), 0);
  const done = items.reduce((sum, item) => sum + (item.sided ? (['right', 'left'] as const) : (['both'] as const)).filter(side => state.answers[item.id]?.[side]).length, 0);
  const answer = (id: string, side: Side, value: string) => update({ ...state, answers: { ...state.answers, [id]: { ...state.answers[id], [side]: state.answers[id]?.[side] === value ? undefined : value } } });
  const note = (id: string) => { const here = onNote(); if (here) update({ ...state, notes: { ...state.notes, [id]: here } }); };
  const copy = async () => {
    const text = checklistSummary(state.kind, state.answers, state.notes, locale);
    try { await copyText(text); setCopied(true); } catch { setCopied(false); }
  };

  return <section className="preop-checklist" aria-label={t('checklist.title')} data-testid="preop-checklist">
    <header><ClipboardCheck size={17} aria-hidden="true" /><h2 ref={headingRef} tabIndex={-1}>{t('checklist.title')}</h2>
      <span className="preop-count" aria-label={t('checklist.count', { done, total })}>{done} / {total}</span>
      <button type="button" className="icon-button" aria-label={t('checklist.close')} data-action="checklist-close" onClick={onClose}><X size={16} /></button></header>
    {/* A recognised study shows its own list only; the choice is offered when the descriptions do not say. */}
    {detected ? <div className="preop-kind-name">{list.title[locale]}</div> : <div className="preop-kinds" role="radiogroup" aria-label={t('checklist.kind')}>
      {(['pns', 'temporal'] as const).map(kind => <button key={kind} type="button" role="radio" aria-checked={state.kind === kind} data-action="checklist-kind" className={state.kind === kind ? 'is-selected' : ''}
        onClick={() => update({ ...state, kind })}>{CHECKLISTS[kind].title[locale]}</button>)}
    </div>}
    <div className="preop-columns" aria-hidden="true"><span /><span>{t('checklist.right')}</span><span>{t('checklist.left')}</span><span /></div>
    <div className="preop-body">
      {list.groups.map(group => <div className="preop-group" key={group.title.en}>
        <h3>{group.title[locale]}</h3>
        {group.items.map(item => {
          const options = item.options ?? FINDING, sides: Side[] = item.sided ? ['right', 'left'] : ['both'], seen = state.notes[item.id];
          return <div className={`preop-row${item.sided ? '' : ' is-single'}`} key={item.id} data-item={item.id}>
            <div className="preop-name"><strong>{item.label[locale]}</strong><small>{item.hint[locale]}</small>
              {seen && <button type="button" className="preop-seen" data-action="checklist-go" onClick={() => onGoTo(seen)}>{t('checklist.seenOn', { slice: seen.shown })}</button>}</div>
            {sides.map(side => <div className="preop-choice" role="radiogroup" key={side} aria-label={`${item.label[locale]} · ${side === 'both' ? '' : side === 'right' ? t('checklist.right') : t('checklist.left')}`}>
              {options.map(option => <button key={option.value} type="button" role="radio" data-action="checklist-answer" aria-checked={state.answers[item.id]?.[side] === option.value}
                className={`preop-option is-${option.value}${state.answers[item.id]?.[side] === option.value ? ' is-on' : ''}`} onClick={() => answer(item.id, side, option.value)}>{option[locale]}</button>)}
            </div>)}
            <button type="button" className="icon-button preop-note" data-action="checklist-note" aria-label={t('checklist.note')} data-tooltip={t('checklist.note')} onClick={() => note(item.id)}><Crosshair size={15} /></button>
          </div>;
        })}
      </div>)}
    </div>
    <footer><span className="preop-help">{t('checklist.help')}</span>
      <button type="button" className="secondary-button compact" data-action="checklist-clear" onClick={() => update({ ...state, answers: {}, notes: {} })}>{t('checklist.clear')}</button>
      <button type="button" className="primary-button compact" data-action="checklist-copy" onClick={() => void copy()}><Copy size={14} />{copied ? t('report.copied') : t('report.copy')}</button></footer>
  </section>;
}

export default PreopChecklist;
