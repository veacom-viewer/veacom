// Labelling a folder of long-leg films (docs/deformity-planning.md, "Labelling a folder"), above the deformity plan: the
// film shown and the state of each film's plan file, previous and next, the run's settings, and Save and next, the only
// control that writes a plan. Opening a film puts the plan file beside it on the film; one that does not open is never
// replaced.
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

export function LabelQueue({ volume, slice, planOpen, longLeg, hidePatientData, onGo, onCalibrate }: {
  /** The active pane's film and frame. */
  volume: Volume | undefined; slice: number;
  /** The deformity plan is open on it, and whether it can open there (a long-leg film). */
  planOpen: boolean; longLeg: boolean;
  /** File and folder names can name the patient: hidden with patient data, the films are numbered only. */
  hidePatientData: boolean;
  /** Opens another film of the folder. */
  onGo: (index: number) => void;
  onCalibrate: (seriesId: string, key: string, calibration: FilmCalibration | null) => void;
}) {
  const { t } = useTranslation();
  const queue = useLabelQueue();
  const folder = queue.folder;
  const shown = Boolean(volume && queue.seriesIds.includes(volume.series.id));
  // The film's plan file, put on it once it is shown. A plan file that does not open is refused whatever the film holds,
  // so it is never written over; one that opens is put on the film unless this session has already planned it.
  const parsing = useRef<string | null>(null);
  const load = useEffectEvent(() => {
    if (!folder || !volume || queue.busy || queue.loaded?.index === queue.index || parsing.current === `${folder.token}:${queue.index}` || !queue.seriesIds.includes(volume.series.id)) return;
    const index = queue.index, item = folder.films[index], series = volume.series, frameIndex = Math.round(slice), reading = `${folder.token}:${index}`;
    // The run and film the file was read for: a run stopped or another folder chosen meanwhile is not touched.
    const current = () => labelQueue.get().folder?.token === folder.token && labelQueue.get().index === index;
    const frame = sourceFrameSeries(series, frameIndex), key = filmKey(series, frameIndex);
    const film = deformity.ensure(series, frameIndex, sidesFor(queue.sides, projectionOf(frame)?.laterality));
    if (queue.held[index]) { labelQueue.loaded(index, queue.held[index]); return; }
    if (item.unreadable) { labelQueue.loaded(index, t('label.unreadable')); return; }
    if (item.plan === null) { labelQueue.loaded(index); return; }
    parsing.current = reading;
    void parsePlanFile(item.plan, film, frame).then(result => {
      // Read for the film shown: another film's, it stays refused; applied only to the film unchanged meanwhile.
      if (!current()) return;
      if ('error' in result) { labelQueue.loaded(index, t(`deformity.reason.${result.error}` as MessageKey)); return; }
      const now = deformity.get().films[key];
      // Planned while the file was read: neither is put over the other, and Save waits rather than write over a plan the
      // reader never saw.
      if (now !== film) { labelQueue.hold(index, t('label.changedWhileRead')); return; }
      if (!film.plans.some(plan => Object.keys(plan.points).length)) {
        // The film as its file has it: no Undo step, as a film opened with its plan has nothing before it.
        deformity.change(key, current => ({ ...current, plans: result.plans, active: result.plans[result.active].id, marker: result.marker, patientRight: result.patientRight }), false);
        onCalibrate(series.id, key, result.calibration);
      }
      labelQueue.loaded(index);
    }, (error: unknown) => { if (current()) labelQueue.loaded(index, errorMessage(error)); }).finally(() => { if (parsing.current === reading) parsing.current = null; });
  });
  useEffect(() => { load(); }, [folder, volume, slice, queue.busy, queue.index, queue.loaded, queue.seriesIds]);
  // What was last done can name a file: hiding patient data takes it away.
  useEffect(() => { if (hidePatientData) labelQueue.say(null); }, [hidePatientData]);
  // Save and next disables itself while the next film opens: focus comes back to it once that film's plan file is read,
  // if focus was lost meanwhile (not where the reader has put it since).
  const save = useRef<HTMLButtonElement>(null), refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || queue.busy || queue.loaded?.index !== queue.index) return;
    refocus.current = false;
    if (save.current && !save.current.disabled && (document.activeElement === null || document.activeElement === document.body)) save.current.focus();
  });
  if (!folder) return null;

  const index = queue.index, total = folder.films.length, refused = queue.loaded?.index === index ? queue.loaded.refused : undefined;
  const withPlan = folder.films.filter(film => ['saved', 'shown', 'empty'].includes(planState(film))).length;
  const stateText = (state: ReturnType<typeof planState>) => t(`label.state.${state}` as MessageKey);
  // The folder's and the files' names, unless patient data is hidden.
  const named = (name: string, hidden: MessageKey) => hidePatientData ? t(hidden) : name;
  // Why Save and next waits, if it does.
  // A plan file holds one plan for one frame: a file of several frames is not labelled here.
  const why = queue.busy ? t('label.opening') : !shown || !planOpen ? t('label.notShown') : volume && volume.series.dimensions[2] > 1 ? t('label.multiFrame')
    : refused ? t('label.refused', { reason: refused }) : queue.loaded?.index !== index ? t('label.opening') : null;
  const noPlan = !longLeg && !queue.busy && shown, reason = Boolean(why) && !refused && !queue.busy && !noPlan;
  const go = (next: number) => { refocus.current = false; labelQueue.say(null); onGo(next); };
  const saveAndNext = async () => {
    const bridge = window.veacom?.labelFolder;
    if (why || !volume || !bridge) return;
    const series = volume.series, frameIndex = Math.round(slice), key = filmKey(series, frameIndex), film = deformity.get().films[key];
    if (!film || !labelQueue.begin()) return;
    // A run stopped, or another folder chosen, meanwhile: its queue is left alone.
    const same = () => labelQueue.get().folder?.token === folder.token;
    refocus.current = true;
    try {
      const text = JSON.stringify(await planFile(film, sourceFrameSeries(series, frameIndex)), null, 2);
      const name = named(await bridge.write(folder.token, index, text), 'label.planFile');
      if (!same()) return;
      labelQueue.saved(index, text);
      // Planned further while it was written: the film stays, so the next press saves what is on it.
      if (deformity.get().films[key] !== film) { labelQueue.end(t('label.changedWhileSaved', { file: name })); return; }
      labelQueue.end(t(index + 1 >= total ? 'label.lastSaved' : folder.writes === 'download' ? 'label.downloaded' : 'label.saved', { file: name }));
    } catch (error) {
      // Not written: the plan stays on the film, and the reader stays on it.
      if (same()) labelQueue.end(t('label.failed', { reason: errorMessage(error) }));
      return;
    }
    if (index + 1 < total) onGo(index + 1);
  };
  return <section className="label-queue" aria-label={t('label.title')} data-testid="label-queue" data-index={index} data-busy={queue.busy || undefined}>
    <header>
      <h2>{t('label.title')}</h2>
      {!hidePatientData && <span className="label-queue-folder" title={folder.folder}>{folder.folder}</span>}
      <button type="button" className="text-button" data-action="label-stop" disabled={queue.busy} onClick={() => labelQueue.stop()}>{t('label.stop')}</button>
    </header>
    <div className="label-queue-film">
      <button type="button" className="icon-button" data-action="label-previous" aria-label={t('label.previous')} data-tooltip={t('label.previous')}
        disabled={queue.busy || index === 0} onClick={() => go(index - 1)}><ChevronLeft size={16} /></button>
      <select data-action="label-film" aria-label={t('label.film')} value={index} disabled={queue.busy} onChange={event => go(Number(event.target.value))}>
        {folder.films.map((film, i) => <option key={film.name} value={i}>{hidePatientData ? t('label.filmOptionHidden', { number: i + 1, state: stateText(planState(film)) })
          : t('label.filmOption', { number: i + 1, name: film.name, state: stateText(planState(film)) })}</option>)}
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
    {refused && <p className="deformity-caution" role="status" id="label-refused" data-testid="label-refused">{t('label.refused', { reason: refused })}</p>}
    {noPlan && <p className="label-queue-note" role="note" id="label-no-plan">{t('label.noPlan')}</p>}
    {/* Why Save and next waits, as its description; the refusal or the note above says it already. */}
    {reason && <p className="label-queue-note" id="label-save-reason">{why}</p>}
    <div className="label-queue-actions">
      <span className="label-queue-status" role="status" data-testid="label-status">{queue.busy ? t('label.opening') : queue.status ?? ''}</span>
      <button ref={save} type="button" className="primary-button compact" data-action="label-save-next" disabled={Boolean(why)}
        aria-describedby={reason ? 'label-save-reason' : refused ? 'label-refused' : noPlan ? 'label-no-plan' : undefined} onClick={() => void saveAndNext()}>{t('label.saveNext')}</button>
    </div>
  </section>;
}
