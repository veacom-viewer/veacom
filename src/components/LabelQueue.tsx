// Labelling a folder of long-leg films (docs/deformity-planning.md, "Labelling a folder"), above the deformity plan: the
// film shown and the state of each film's plan file, previous and next, the run's settings, and Save and next, the only
// control that writes a plan. Opening a film puts the plan file beside it on the film, unless it does not open.
import { useEffect, useEffectEvent, useRef } from 'react';
import type { Volume } from '../model';
import { sourceFrameSeries } from '../imaging/geometry';
import { projectionOf, type FilmCalibration } from '../imaging/radiograph';
import type { Side } from '../imaging/deformity/measure';
import { deformity, filmKey } from '../ui/deformityStore';
import { parsePlanFile, planFile } from '../ui/deformityFile';
import { labelQueue, planState, sidesFor, useLabelQueue } from '../ui/labelQueue';
import { errorMessage, type MessageKey } from '../i18n';
import { useTranslation } from '../i18n/react';
import { ChevronLeft, ChevronRight } from './icons';
import './LabelQueue.css';

const SIDES: Array<{ sides: Side[]; label: MessageKey }> = [{ sides: ['R'], label: 'label.right' }, { sides: ['L'], label: 'label.left' }, { sides: ['R', 'L'], label: 'label.both' }];

export function LabelQueue({ volume, slice, planOpen, longLeg, onGo, onCalibrate }: {
  /** The active pane's film and frame. */
  volume: Volume | undefined; slice: number;
  /** The deformity plan is open on it, and whether it can open there (a long-leg film). */
  planOpen: boolean; longLeg: boolean;
  /** Opens another film of the folder. */
  onGo: (index: number) => void;
  onCalibrate: (seriesId: string, key: string, calibration: FilmCalibration | null) => void;
}) {
  const { t } = useTranslation();
  const queue = useLabelQueue();
  const folder = queue.folder;
  const shown = Boolean(volume && queue.seriesIds.includes(volume.series.id));
  // The film's plan file, put on it once it is shown: a film this session has already planned keeps its plan.
  const parsing = useRef<number | null>(null);
  const load = useEffectEvent(() => {
    if (!folder || !volume || queue.busy || queue.loaded?.index === queue.index || parsing.current === queue.index || !queue.seriesIds.includes(volume.series.id)) return;
    const index = queue.index, item = folder.films[index], series = volume.series, frameIndex = Math.round(slice);
    const frame = sourceFrameSeries(series, frameIndex), key = filmKey(series, frameIndex);
    const film = deformity.ensure(series, frameIndex, sidesFor(queue.sides, projectionOf(frame)?.laterality));
    if ((item.plan === null && !item.tooLarge) || film.plans.some(plan => Object.keys(plan.points).length)) { labelQueue.loaded(index); return; }
    if (item.plan === null) { labelQueue.loaded(index, t('deformity.reason.size')); return; }
    parsing.current = index;
    void parsePlanFile(item.plan, film, frame).then(result => {
      // Applied only to the film it was read for, unchanged meanwhile.
      if (labelQueue.get().index !== index || deformity.get().films[key] !== film) return;
      if ('error' in result) { labelQueue.loaded(index, t(`deformity.reason.${result.error}` as MessageKey)); return; }
      // The film as its file has it: no Undo step, as a film opened with its plan has nothing before it.
      deformity.change(key, now => ({ ...now, plans: result.plans, active: result.plans[result.active].id, marker: result.marker, patientRight: result.patientRight }), false);
      onCalibrate(series.id, key, result.calibration);
      labelQueue.loaded(index);
    }, (error: unknown) => labelQueue.loaded(index, errorMessage(error))).finally(() => { if (parsing.current === index) parsing.current = null; });
  });
  useEffect(() => { load(); }, [folder, volume, slice, queue.busy, queue.index, queue.loaded, queue.seriesIds]);
  if (!folder) return null;

  const index = queue.index, total = folder.films.length, refused = queue.loaded?.index === index ? queue.loaded.refused : undefined;
  const withPlan = folder.films.filter(film => planState(film) === 'saved' || planState(film) === 'shown').length;
  const stateText = (state: ReturnType<typeof planState>) => t(`label.state.${state}` as MessageKey);
  // Why Save and next waits, if it does.
  const why = queue.busy ? t('label.opening') : !shown || !planOpen ? t('label.notShown') : refused ? t('label.refused', { reason: refused })
    : queue.loaded?.index !== index ? t('label.opening') : null;
  const go = (next: number) => { labelQueue.say(null); onGo(next); };
  const saveAndNext = async () => {
    const bridge = window.veacom?.labelFolder;
    if (why || !volume || !bridge) return;
    const series = volume.series, frameIndex = Math.round(slice), film = deformity.get().films[filmKey(series, frameIndex)];
    if (!film || !labelQueue.begin()) return;
    try {
      const text = JSON.stringify(await planFile(film, sourceFrameSeries(series, frameIndex)), null, 2);
      const name = await bridge.write(folder.token, index, text);
      labelQueue.saved(index, text);
      labelQueue.end(t(index + 1 >= total ? 'label.lastSaved' : folder.writes === 'download' ? 'label.downloaded' : 'label.saved', { file: name }));
    } catch (error) {
      // Not written: the plan stays on the film, and the reader stays on it.
      labelQueue.end(t('label.failed', { reason: errorMessage(error) }));
      return;
    }
    if (index + 1 < total) onGo(index + 1);
  };
  return <section className="label-queue" aria-label={t('label.title')} data-testid="label-queue" data-index={index} data-busy={queue.busy || undefined}>
    <header>
      <h2>{t('label.title')}</h2>
      <span className="label-queue-folder" title={folder.folder}>{folder.folder}</span>
      <button type="button" className="text-button" data-action="label-stop" onClick={() => labelQueue.stop()}>{t('label.stop')}</button>
    </header>
    <div className="label-queue-film">
      <button type="button" className="icon-button" data-action="label-previous" aria-label={t('label.previous')} data-tooltip={t('label.previous')}
        disabled={queue.busy || index === 0} onClick={() => go(index - 1)}><ChevronLeft size={16} /></button>
      <select data-action="label-film" aria-label={t('label.film')} value={index} disabled={queue.busy} onChange={event => go(Number(event.target.value))}>
        {folder.films.map((film, i) => <option key={film.name} value={i}>{t('label.filmOption', { number: i + 1, name: film.name, state: stateText(planState(film)) })}</option>)}
      </select>
      <button type="button" className="icon-button" data-action="label-next" aria-label={t('label.next')} data-tooltip={t('label.next')}
        disabled={queue.busy || index + 1 >= total} onClick={() => go(index + 1)}><ChevronRight size={16} /></button>
    </div>
    <p className="label-queue-progress" data-plan={planState(folder.films[index])}>
      {t('label.progress', { number: index + 1, total, saved: withPlan })} · {stateText(planState(folder.films[index]))}</p>
    <div className="label-queue-settings">
      <span id="label-suggestions">{t('label.suggestions')}</span>
      <div className="deformity-segments" role="radiogroup" aria-labelledby="label-suggestions">{([true, false] as const).map(on =>
        <button key={String(on)} type="button" role="radio" aria-checked={queue.suggestions === on} className="secondary-button compact" data-action="label-suggestions"
          onClick={() => labelQueue.setSuggestions(on)}>{t(on ? 'label.on' : 'label.off')}</button>)}</div>
      <span id="label-legs">{t('label.legs')}</span>
      <div className="deformity-segments" role="radiogroup" aria-labelledby="label-legs" data-tooltip={t('label.legsHint')}>{SIDES.map(option =>
        <button key={option.label} type="button" role="radio" aria-checked={queue.sides.join() === option.sides.join()} className="secondary-button compact" data-action="label-legs"
          onClick={() => labelQueue.setSides(option.sides)}>{t(option.label)}</button>)}</div>
    </div>
    {folder.writes === 'download' && <p className="label-queue-note" role="note">{t('label.downloads')}</p>}
    {refused && <p className="deformity-caution" role="note" data-testid="label-refused">{t('label.refused', { reason: refused })}</p>}
    {!longLeg && !queue.busy && shown && <p className="label-queue-note" role="note">{t('label.noPlan')}</p>}
    <div className="label-queue-actions">
      <span className="label-queue-status" role="status" data-testid="label-status">{queue.busy ? t('label.opening') : queue.status ?? ''}</span>
      <button type="button" className="primary-button compact" data-action="label-save-next" disabled={Boolean(why)} data-tooltip={why ?? undefined}
        onClick={() => void saveAndNext()}>{t('label.saveNext')}</button>
    </div>
  </section>;
}
