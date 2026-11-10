import { studyKey } from '../domain/patient';
import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { ClipboardCheck, Copy, Crosshair, Printer, Ruler, X } from './icons';
import type { CaliperKind, Series } from '../model';
import type { MessageKey } from '../i18n';
import { useTranslation } from '../i18n/react';
import { copyText } from '../ui/clipboard';
import { printPage } from '../ui/print';
import { TheatreCard } from './TheatreCard';
import { CALIPERS, caliperName, caliperShort, ITEM_CALIPERS } from '../imaging/calipers';
import { keepChecklist, keptChecklist, subscribeChecklists } from '../ui/checklistStore';
import { modifierKey } from '../ui/presets';
import { CHECKLISTS, FINDING, answerByKey, checklistKey, checklistKind, checklistSummary, moveCell, type ChecklistCell, type ChecklistState, type ChecklistKind, type Side, type SliceNote } from '../ui/preopChecklist';
import { usage } from '../usage/tracker';
import './PreopChecklist.css';

/** The pre-operative checklist beside the images: each finding marked per side, with the slice it was seen on, and the
 * items with a caliper measured on the image. */
export function PreopChecklist({ series, hidePatient, onClose, onNote, onGoTo, onMeasure, measuring, measureBlocked, headingRef }: {
  series: Series; onClose: () => void;
  /** The reader hid the patient's data: the theatre card leaves it out too. */
  hidePatient: boolean;
  /** The slice on screen now (null without one). */
  onNote: () => SliceNote | null;
  onGoTo: (note: SliceNote) => void;
  /** Starts the caliper for an item and side, or stops the one under way. */
  onMeasure: (item: string, side: Side, kind: CaliperKind) => void;
  /** The caliper under way in this study. */
  measuring: { item: string; side: Side } | null;
  /** Why a caliper cannot be used on the active pane now, or null. */
  measureBlocked: (kind: CaliperKind) => MessageKey | null;
  headingRef?: (heading: HTMLHeadingElement | null) => void;
}) {
  const { locale, t } = useTranslation();
  const key = studyKey(series);
  const detected = checklistKind(series);
  // Kept per study while the viewer is open (closing the panel keeps it); a caliper on the image records into it too.
  const saved = useSyncExternalStore(subscribeChecklists, () => keptChecklist(key));
  const state: ChecklistState = saved ? { ...saved, kind: detected ?? saved.kind } : { kind: detected ?? 'pns', answers: {}, notes: {} };
  // "Copied" holds while the checklist is as it was copied.
  const [copiedFrom, setCopiedFrom] = useState<{ state: ChecklistState | undefined } | null>(null);
  const copied = copiedFrom !== null && copiedFrom.state === saved;
  // The panel's state lives in a store, so the usage timings are told that an answer changed something.
  const update = (next: ChecklistState) => { keepChecklist(key, next); usage.touch('panel'); };
  const body = useRef<HTMLDivElement>(null);
  // The side column the keys last used, for ↑ and ↓ out of a one-answer row.
  const column = useRef<'right' | 'left'>('right');
  const list = CHECKLISTS[state.kind];
  const items = list.groups.flatMap(group => group.items);
  const sidesOf = (sided: boolean): Side[] => sided ? ['right', 'left'] : ['both'];
  const total = items.reduce((sum, item) => sum + (item.sided ? 2 : 1), 0);
  const done = items.reduce((sum, item) => sum + sidesOf(item.sided).filter(side => state.answers[item.id]?.[side]).length, 0);
  const answer = (id: string, side: Side, value: string) => update({ ...state, answers: { ...state.answers, [id]: { ...state.answers[id], [side]: state.answers[id]?.[side] === value ? undefined : value } } });
  // What Clear, or a slice note in place of a measurement, took away: Undo puts it back while the checklist is still as
  // that change left it, so it never overwrites anything done since.
  const [undo, setUndo] = useState<{ before: ChecklistState; after: ChecklistState; text: string } | null>(null);
  const undoable = undo !== null && undo.after === saved ? undo : null;
  const change = (next: ChecklistState, text: string) => { update(next); if (saved) setUndo({ before: saved, after: next, text }); };
  const sideName = (side: Side) => side === 'both' ? '' : t(side === 'right' ? 'checklist.right' : 'checklist.left');
  const note = (id: string, side: Side, label: string) => {
    const here = onNote();
    if (!here) return;
    const next = { ...state, notes: { ...state.notes, [id]: { ...state.notes[id], [side]: here } } };
    // A side holds one note: a slice note drops a caliper's record there (its drawing stays on the image).
    if (state.notes[id]?.[side]?.caliper) change(next, t('checklist.noteReplaced', { where: side === 'both' ? label : `${label} · ${sideName(side)}` }));
    else update(next);
  };
  const clear = () => {
    const next = { ...state, answers: {}, notes: {} };
    const marked = [state.answers, state.notes].some(record => Object.values(record).some(sides => Object.values(sides ?? {}).some(Boolean)));
    if (marked) change(next, t('checklist.cleared')); else update(next);
  };
  const restore = (button: HTMLElement) => {
    if (!undoable) return;
    // The Undo line goes with it: focus moves to Clear beside where it was (found now, while the button is in the page).
    const clearButton = button.closest('.preop-checklist')?.querySelector<HTMLElement>('[data-action="checklist-clear"]');
    update(undoable.before);
    setUndo(null);
    requestAnimationFrame(() => clearButton?.focus());
  };
  const copy = async () => {
    const text = checklistSummary(state.kind, state.answers, state.notes, locale);
    try { await copyText(text); setCopiedFrom({ state: saved }); } catch { setCopiedFrom(null); }
  };
  const mac = modifierKey(navigator.platform) === '⌘';
  // Alt chords, not single keys: the setting that turns single-key shortcuts off (WCAG 2.1.4) leaves them on.
  const answerKeys = (digit: number, both = false) => mac ? `⌥${both ? '⇧' : ''}${digit}` : `Alt+${both ? 'Shift+' : ''}${digit}`;
  /** The side of a row an element is in, or null outside the rows. */
  const cellOf = (element: Element): ChecklistCell | null => {
    const row = items.findIndex(item => item.id === element.closest<HTMLElement>('[data-item]')?.dataset.item);
    if (row < 0) return null;
    const side = element.closest<HTMLElement>('[data-side]')?.dataset.side as Side | undefined;
    return { row, side: side ?? (items[row].sided ? column.current : 'both') };
  };
  /** Moves the keyboard to a side: its answers take focus, and the whole row comes into view. */
  const focusCell = (cell: ChecklistCell) => {
    if (cell.side !== 'both') column.current = cell.side;
    const row = body.current?.querySelector<HTMLElement>(`[data-item="${items[cell.row].id}"]`);
    row?.querySelector<HTMLElement>(`[data-side="${cell.side}"] .preop-choice`)?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  };
  /** The checklist's keys (docs/close-calipers.md): from its heading or a row, never while a caliper waits for its points.
   * Fields and the image never get here: the panel only hears keys pressed inside it. */
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    const meaning = checklistKey(event), target = event.target as Element;
    if (!meaning || measuring) return;
    const at = cellOf(target);
    if (!at && !('move' in meaning && meaning.move === 'down' && target.matches('h2'))) return;
    event.preventDefault();
    if ('move' in meaning) {
      usage.action('checklist-key-move', 'key', { burst: true }); usage.touch('panel');
      focusCell(at ? moveCell(items, at, meaning.move, column.current) : { row: 0, side: items[0].sided ? column.current : 'both' });
      return;
    }
    const answered = at && answerByKey(state, items, at, meaning.answer, meaning.both);
    if (!answered) return;
    usage.action(meaning.both ? 'checklist-key-both' : 'checklist-key-answer', 'key');
    update(answered.state);
    focusCell(answered.next);
  };
  // The theatre card, stamped with when it was printed: in the page from the first print on, and only ever on paper.
  const [printedAt, setPrintedAt] = useState<Date | null>(null);
  const [printFailed, setPrintFailed] = useState(false);
  const print = async () => {
    flushSync(() => { setPrintedAt(new Date()); setPrintFailed(false); });
    try { await printPage(); } catch { setPrintFailed(true); }
  };

  return <section className="preop-checklist" aria-label={t('checklist.title')} data-testid="preop-checklist" onKeyDown={keys}>
    <header><ClipboardCheck size={17} aria-hidden="true" /><h2 ref={headingRef} tabIndex={-1}>{t('checklist.title')}</h2>
      <span className="preop-count" aria-label={t('checklist.count', { done, total })}>{done} / {total}</span>
      <button type="button" className="icon-button" aria-label={t('checklist.close')} data-action="checklist-close" onClick={onClose}><X size={16} /></button></header>
    {/* A recognised study shows its own list only; the choice is offered when the descriptions do not say. */}
    {detected ? <div className="preop-kind-name">{list.title[locale]}</div> : <div className="preop-kinds" role="radiogroup" aria-label={t('checklist.kind')}>
      {(['pns', 'temporal'] as const).map((kind: ChecklistKind) => <button key={kind} type="button" role="radio" aria-checked={state.kind === kind} data-action="checklist-kind" className={state.kind === kind ? 'is-selected' : ''}
        onClick={() => update({ ...state, kind })}>{CHECKLISTS[kind].title[locale]}</button>)}
    </div>}
    <div className="preop-columns" aria-hidden="true"><span /><span>{t('checklist.right')}</span><span>{t('checklist.left')}</span></div>
    <div className="preop-body" ref={body}>
      {list.groups.map(group => <div className="preop-group" key={group.title.en}>
        <h3>{group.title[locale]}</h3>
        {group.items.map(item => {
          const options = item.options ?? FINDING, kind = ITEM_CALIPERS[item.id];
          return <div className={`preop-row${item.sided ? '' : ' is-single'}`} key={item.id} data-item={item.id}>
            <div className="preop-name"><strong>{item.label[locale]}</strong><small>{item.hint[locale]}</small></div>
            {sidesOf(item.sided).map(side => {
              const seen = state.notes[item.id]?.[side], measured = seen?.caliper?.result;
              const armed = measuring?.item === item.id && measuring.side === side;
              const why = kind && !armed ? measureBlocked(kind) : null;
              const nearLimit = measured && 'reading' in measured && 'nearLimit' in measured.reading && measured.reading.nearLimit;
              const named = (label: string) => side === 'both' ? label : `${label} · ${sideName(side)}`;
              return <div className="preop-side" key={side} data-side={side}>
                {/* The keys focus the whole side (tabIndex -1 keeps Tab on its buttons); each answer shows its keys. */}
                <div className="preop-choice" role="radiogroup" tabIndex={-1} aria-label={named(item.label[locale])}>
                  {options.map((option, index) => {
                    const digit = index + 1;
                    return <button key={option.value} type="button" role="radio" data-action="checklist-answer" aria-checked={state.answers[item.id]?.[side] === option.value}
                      data-tooltip={option.value === 'unknown' ? t('checklist.unknown') : option[locale]} data-shortcut={answerKeys(digit)}
                      data-tooltip-hint={item.sided ? t('checklist.bothKey', { keys: answerKeys(digit, true) }) : undefined} aria-keyshortcuts={`Alt+${digit}${item.sided ? ` Alt+Shift+${digit}` : ''}`}
                      className={`preop-option is-${option.value}${state.answers[item.id]?.[side] === option.value ? ' is-on' : ''}`} onClick={() => answer(item.id, side, option.value)}>{option[locale]}</button>;
                  })}
                </div>
                <div className="preop-side-tools">
                  {/* A side holds one note: the slice noted here or a caliper's measurement, whichever came last. */}
                  <button type="button" className="icon-button preop-tool" data-action="checklist-note" aria-label={named(t('checklist.note'))} data-tooltip={t('checklist.note')}
                    onClick={() => note(item.id, side, item.label[locale])}><Crosshair size={15} /></button>
                  {kind && <button type="button" className={`icon-button preop-tool${armed ? ' is-on' : ''}${why ? ' is-unavailable' : ''}`} data-action="checklist-caliper"
                    aria-pressed={armed} aria-disabled={why ? true : undefined} aria-description={why ? t(why) : undefined}
                    aria-label={armed ? t('caliper.stop') : named(t('caliper.measure', { name: caliperName(kind, locale) }))}
                    data-tooltip={armed ? t('caliper.stop') : t('caliper.measure', { name: caliperName(kind, locale) })} data-tooltip-hint={why ? t(why) : armed ? undefined : t(CALIPERS[kind].plane === 'coronal' ? 'caliper.onCoronal' : 'caliper.onSagittal')}
                    onClick={why ? undefined : () => onMeasure(item.id, side, kind)}><Ruler size={15} /></button>}
                  {seen && <button type="button" className="preop-seen" data-action="checklist-go" data-tooltip={measured ? t('checklist.measuredOn', { value: caliperShort(measured, locale), slice: seen.shown }) : t('checklist.seenOn', { slice: seen.shown })}
                    onClick={() => onGoTo(seen)}>{measured ? caliperShort(measured, locale) : t('checklist.seenOn', { slice: seen.shown })}</button>}
                  {nearLimit && <span className="preop-limit">{t('caliper.nearLimit')}</span>}
                </div>
              </div>;
            })}
          </div>;
        })}
      </div>)}
    </div>
    {undoable && <p className="preop-undo" role="status">{undoable.text}
      <button type="button" className="text-button" data-action="checklist-undo" onClick={event => restore(event.currentTarget)}>{t('notice.undo')}</button></p>}
    {printFailed && <p className="preop-print-failed" role="alert">{t('checklist.printFailed')}</p>}
    <footer><span className="preop-help">{t('checklist.help')}</span>
      <button type="button" className="secondary-button compact" data-action="checklist-clear" onClick={clear}>{t('checklist.clear')}</button>
      <button type="button" className="secondary-button compact" data-action="checklist-print" data-tooltip={t('checklist.print')} data-tooltip-hint={t('checklist.printHint')}
        aria-description={t('checklist.printHint')} onClick={() => void print()}><Printer size={14} />{t('checklist.print')}</button>
      <button type="button" className="primary-button compact" data-action="checklist-copy" onClick={() => void copy()}><Copy size={14} />{copied ? t('report.copied') : t('report.copy')}</button></footer>
    {printedAt && <TheatreCard series={series} state={state} hidePatient={hidePatient} printedAt={printedAt} />}
  </section>;
}

export default PreopChecklist;
