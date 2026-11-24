// The display panel's alignment section (imaging/registration.ts): which series lies over which, how far the alignment
// moved and turned it, how well the two then match, and the reader's nudges to correct it: a millimetre along a patient
// axis, or half a degree in a plane, about what the active pane shows.
import type { Plane, Series } from '../model';
import { adjusted, alignmentCautions, movement, NUDGE_DEGREES, NUDGE_MM, type Alignment, type Nudge } from '../imaging/registration';
import { useTranslation } from '../i18n/react';
import { RotateCcw, RotateCw } from './icons';
import { WarningBox } from './WarningBox';
import { dicomDate } from '../ui/overlayCorners';

/** Toward the patient's right, left, front, back, head and feet: LPS steps. */
const DIRECTIONS = [
  { letter: 'R', key: 'right', shift: [-NUDGE_MM, 0, 0] },
  { letter: 'L', key: 'left', shift: [NUDGE_MM, 0, 0] },
  { letter: 'A', key: 'anterior', shift: [0, -NUDGE_MM, 0] },
  { letter: 'P', key: 'posterior', shift: [0, NUDGE_MM, 0] },
  { letter: 'S', key: 'superior', shift: [0, 0, NUDGE_MM] },
  { letter: 'I', key: 'inferior', shift: [0, 0, -NUDGE_MM] },
] as const;
const PLANES: readonly Plane[] = ['axial', 'coronal', 'sagittal'];

export function AlignmentSection({ alignment, fixed, moving, onNudge, onAutomatic, onRemove }: {
  alignment: Alignment; fixed: Series | undefined; moving: Series | undefined;
  onNudge: (nudge: Nudge) => void; onAutomatic: () => void; onRemove: () => void;
}) {
  const { t, locale } = useTranslation();
  const { shift, angle } = movement(alignment), manual = adjusted(alignment), cautions = manual ? [] : alignmentCautions(alignment);
  const name = (item: Series | undefined) => item ? [item.description || item.modality, dicomDate(item.studyDate)].filter(Boolean).join(' · ') : '';
  const percent = (value: number) => locale === 'tr' ? `%${Math.round(value * 100)}` : `${Math.round(value * 100)}%`;
  return <div className="alignment-section" data-testid="alignment-section">
    {/* The series registered, while both are still on the list. */}
    {fixed && moving && <p className="field-help">{t('alignment.pair', { moving: name(moving), fixed: name(fixed) })}</p>}
    <dl className="series-details alignment-facts">
      <dt>{t('alignment.movedLabel')}</dt><dd>{t('alignment.moved', { shift: shift.toFixed(1), angle: angle.toFixed(1) })}</dd>
      <dt>{t('alignment.howLabel')}</dt><dd>{t(manual ? 'alignment.adjusted' : 'alignment.automatic')}</dd>
      {!manual && <>
        <dt>{t('alignment.similarityLabel')}</dt><dd data-tooltip={t('alignment.similarityHint')}>{t('alignment.similarity', { value: alignment.similarity.toFixed(2), before: alignment.similarityBefore.toFixed(2) })}</dd>
        <dt>{t('alignment.overlapLabel')}</dt><dd>{percent(alignment.overlap)}</dd>
      </>}
    </dl>
    {cautions.length > 0 && <WarningBox title={t('alignment.check')} className="alignment-cautions"
      dismissKey={`alignment:${alignment.fixed}:${alignment.moving}:${cautions.join(',')}`}>
      {cautions.map(caution => <p key={caution}>{t(caution === 'noBetter' ? 'alignment.caution.noBetter' : 'alignment.caution.littleOverlap')}</p>)}
    </WarningBox>}
    <div className="alignment-row" role="group" aria-label={t('alignment.move', { mm: NUDGE_MM })}>
      <span className="alignment-row-label">{t('alignment.move', { mm: NUDGE_MM })}</span>
      {DIRECTIONS.map(direction => {
        const label = t('alignment.moveToward', { mm: NUDGE_MM, direction: t(`alignment.direction.${direction.key}` as const) });
        return <button key={direction.letter} type="button" className="secondary-button compact alignment-step" data-action="alignment-move"
          aria-label={label} data-tooltip={label} onClick={() => onNudge({ shift: [direction.shift[0], direction.shift[1], direction.shift[2]] })}>{direction.letter}</button>;
      })}
    </div>
    <div className="alignment-row" role="group" aria-label={t('alignment.turn', { degrees: NUDGE_DEGREES })}>
      <span className="alignment-row-label">{t('alignment.turn', { degrees: NUDGE_DEGREES })}</span>
      {PLANES.map(plane => <span key={plane} className="alignment-turn">
        <span>{t(`plane.${plane}` as const)}</span>
        {[false, true].map(clockwise => {
          const label = t(clockwise ? 'alignment.turnClockwise' : 'alignment.turnAnticlockwise', { degrees: NUDGE_DEGREES, plane: t(`planeLower.${plane}` as const) });
          return <button key={String(clockwise)} type="button" className="secondary-button compact alignment-step" data-action="alignment-turn"
            aria-label={label} data-tooltip={label} onClick={() => onNudge({ turn: plane, clockwise })}>{clockwise ? <RotateCw size={14} /> : <RotateCcw size={14} />}</button>;
        })}
      </span>)}
    </div>
    <div className="alignment-actions">
      <button type="button" className="text-button" data-action="alignment-automatic" disabled={!adjusted(alignment)} onClick={onAutomatic}>{t('alignment.backToAutomatic')}</button>
      <button type="button" className="text-button" data-action="alignment-remove" onClick={onRemove}>{t('alignment.remove')}</button>
    </div>
  </div>;
}
