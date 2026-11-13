import { useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { useHeldStep } from '../ui/useHeldStep';
import { streamSlices, streamWheelSteps, TOUCHPAD_SPEED, type WheelStream } from '../imaging/interaction';

// The slice bar down a pane's right edge, as VEAcom 1.x's scroll bar (Qt): 14 px wide, an arrow at each end
// (one slice, repeating while held), the track above or below the handle pages by ten, the handle drags, the
// wheel over it pages as over the image. Positions are in paging order (top = first); `toSlice` maps them back.

const PAGE = 10;
const REPEAT_EVERY_MS = 50;
const MIN_HANDLE_PX = 16;

export function SliceBar({ count, position, label, valueText, onPosition, touchpadSpeed = TOUCHPAD_SPEED.default }: {
  /** Slices in the plane shown. */
  count: number;
  /** The slice shown, in paging order (0 = top of the bar). */
  position: number;
  label: string;
  valueText: string;
  onPosition: (position: number) => void;
  /** How fast a touchpad's swipe over the bar pages; a mouse wheel pages one slice a notch. */
  touchpadSpeed?: number;
}) {
  const track = useRef<HTMLSpanElement>(null);
  const handle = useRef<HTMLSpanElement>(null);
  const pointer = useRef<number | null>(null);
  const drag = useRef<{ start: number; travel: number } | null>(null);
  const wheelRest = useRef(0);
  const wheelStream = useRef<WheelStream>({ fineUntil: 0 });
  const go = (next: number) => {
    const clamped = Math.min(count - 1, Math.max(0, Math.round(next)));
    if (clamped !== position) onPosition(clamped);
    return clamped !== position;
  };
  const step = (by: number) => go(position + by);
  const hold = useHeldStep(step, REPEAT_EVERY_MS);
  const top = count > 1 ? 100 * Math.min(position, count - 1) / (count - 1) : 0;
  const size = 100 * PAGE / (Math.max(0, count - 1) + PAGE);
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pointer.current !== null || !handle.current) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
    const rect = track.current!.getBoundingClientRect(), thumb = handle.current.getBoundingClientRect(), y = event.clientY;
    if (y >= rect.top && y < rect.bottom) {
      if (y < thumb.top) { step(-PAGE); return; }
      if (y > thumb.bottom) { step(PAGE); return; }
      drag.current = { start: rect.top + y - thumb.top, travel: rect.height - thumb.height };
    } else {
      hold(y < rect.top ? -1 : 1, event.pointerId);
    }
    pointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const move = drag.current;
    if (pointer.current === event.pointerId && move && move.travel > 0) go((event.clientY - move.start) / move.travel * (count - 1));
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId === pointer.current) { pointer.current = null; drag.current = null; }
  };
  // Notches, not events: Chromium merges the notches of a frame into one event (see wheelSteps). A notch is one slice;
  // a touchpad's swipe goes by the touchpad speed, as over the image.
  const wheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const read = streamWheelSteps(event.nativeEvent, window.veacom?.zoomFactor?.() ?? 1, event.timeStamp, wheelStream.current);
    if (!read.fine) wheelRest.current = 0;
    wheelRest.current += streamSlices(read, touchpadSpeed, event.timeStamp, wheelStream.current);
    const by = Math.trunc(wheelRest.current); wheelRest.current -= by;
    if (by) step(by);
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const by = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -PAGE, PageDown: PAGE }[event.key];
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : undefined;
    if (by === undefined && to === undefined) return;
    event.preventDefault(); event.stopPropagation();
    if (to !== undefined) go(to); else step(by!);
  };
  return <div className="slice-bar" role="slider" tabIndex={0} aria-orientation="vertical" aria-label={label}
    aria-valuemin={1} aria-valuemax={Math.max(1, count)} aria-valuenow={Math.min(count, position + 1)} aria-valuetext={valueText}
    data-action="slice-slider" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onWheel={wheel} onKeyDown={keyDown}>
    <span className="slice-arrow up" aria-hidden="true" />
    <span className="slice-track" ref={track} aria-hidden="true">{count > 1 && <span ref={handle} className="slice-handle"
      style={{ top: `${top}%`, transform: `translateY(-${top}%)`, height: `min(100%, max(${MIN_HANDLE_PX}px, ${size}%))` }} />}</span>
    <span className="slice-arrow down" aria-hidden="true" />
  </div>;
}
