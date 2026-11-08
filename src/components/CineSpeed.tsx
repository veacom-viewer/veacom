import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from '../i18n/react';
import { useHeldStep } from '../ui/useHeldStep';
import { Minus, Plus } from './icons';

const REPEAT_MS = 80;
/** How far each repeat moves: one at a time at first, wider the longer the button is held. */
const repeatStep = (repeats: number) => repeats < 10 ? 1 : repeats < 25 ? 2 : repeats < 45 ? 5 : 10;

/** The cine speed while a series plays: − and + change it one frame a second at a time (faster while held), and
 * the number itself can be typed. Whole numbers from 1 to `max`, the series' slice count. */
export function CineSpeed({ fps, max, onChange }: { fps: number; max: number; onChange: (fps: number) => void }) {
  const { t } = useTranslation();
  const clamp = (value: number) => Math.max(1, Math.min(max, Math.round(value)));
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const step = (by: number) => {
    const next = clamp(fps + by);
    if (next !== fps) onChange(next);
    return next !== fps;
  };
  const hold = useHeldStep((by, repeats) => step(by * repeatStep(repeats)), REPEAT_MS);
  const press = (direction: 1 | -1) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    hold(direction, event.pointerId);
  };
  // Enter or Space on a focused button arrives as a click with no pointer: one step each, as the key repeats.
  const key = (direction: 1 | -1) => (event: ReactMouseEvent<HTMLButtonElement>) => { if (event.detail === 0) step(direction); };

  // Leaving the field takes what was typed, unless Esc gave it up (the blur that follows comes before the re-render).
  const givenUp = useRef(false);
  const commit = () => {
    const typed = givenUp.current ? null : draft;
    givenUp.current = false;
    setDraft(null);
    if (typed === null) return;
    const value = Number.parseInt(typed, 10);
    if (Number.isFinite(value)) {
      const next = clamp(value);
      if (next !== fps) onChange(next);
    }
  };
  const editKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); input.current?.blur(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); givenUp.current = true; input.current?.blur(); }
  };

  return <div className="status-fps" role="group" aria-label={t('status.speed')}>
    <button type="button" className="status-button" data-testid="status-fps-down" aria-label={t('status.slower')} data-tooltip={t('status.slower')}
      disabled={fps <= 1} onPointerDown={press(-1)} onClick={key(-1)}><Minus size={13} /></button>
    <label className="status-fps-value" data-tooltip={t('status.speedEdit', { max })}>
      <input ref={input} data-testid="status-fps" type="text" inputMode="numeric" autoComplete="off" spellCheck={false}
        aria-label={t('status.speedValue', { max })} value={draft ?? String(fps)} size={Math.max(2, String(max).length)}
        onFocus={event => { setDraft(String(fps)); event.currentTarget.select(); }}
        onChange={event => setDraft(event.target.value.replace(/\D/g, '').slice(0, String(max).length))}
        onBlur={commit} onKeyDown={editKey} />
      <span aria-hidden="true">{t('status.fpsUnit')}</span>
    </label>
    <button type="button" className="status-button" data-testid="status-fps-up" aria-label={t('status.faster')} data-tooltip={t('status.faster')}
      disabled={fps >= max} onPointerDown={press(1)} onClick={key(1)}><Plus size={13} /></button>
  </div>;
}
