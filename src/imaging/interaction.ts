interface WheelInput { deltaY: number; deltaMode: number; wheelDeltaY?: number; }

/** Wheel input in steps: the whole notches of a mouse wheel, or a part of a touchpad's swipe. */
export interface WheelSteps {
  /** Signed: whole notches, or a part of a swipe in steps of 40 px (wheelSlices makes slices of them). */
  steps: number;
  /** A touchpad, or another device that scrolls by pixels: its steps follow the touchpad speed. */
  fine: boolean;
}

/** The touchpad speeds the setting offers, slowest first, as multiples of the normal speed: a slice per 16 px of
 * scrolling. A mouse wheel ignores them. */
export const TOUCHPAD_SPEEDS: readonly number[] = [1 / 3, 0.5, 0.75, 1, 1.5, 2, 2.5, 3];
export const TOUCHPAD_SPEED = { min: 1 / 3, max: 3, default: 1 } as const;
const PIXELS_PER_STEP = 40;
/** A touchpad's slices a step at the normal speed: a slice per 16 px. */
const TOUCHPAD_SLICES_PER_STEP = PIXELS_PER_STEP / 16;

/** The offered speed nearest to `value` by ratio; the default for anything that is not a speed. */
export function nearestTouchpadSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return TOUCHPAD_SPEED.default;
  return TOUCHPAD_SPEEDS.reduce((best, speed) => Math.abs(Math.log(speed / value)) < Math.abs(Math.log(best / value)) ? speed : best);
}

// Wheel input in notches, a slice each, as VEAcom 1.x counted it with Qt (120 units a notch) at any speed. A notch is
// always one slice, whatever the touchpad speed: a skipped slice can hide a finding.
// Chromium hands the page at most one wheel event a frame, adding up the notches that arrived within it, and on macOS
// deltaY carries the system's acceleration (a slow notch is about 4 px, a fast one many times that): deltaY can neither
// count notches nor tell a wheel from a trackpad. The legacy wheelDeltaY can: Chromium fills it with 120 per raw,
// unaccelerated notch and sums it when it merges events. A touchpad's events carry a part of that, so they are told
// apart by it, and counted by the pixels the system scrolled (deltaY), 40 px a step, which the touchpad speed turns
// into slices (wheelSlices). Chromium
// scales a touchpad's legacy field differently by system (3 units a pixel on macOS, 1.2 through Windows' wheel
// messages), its pixels the same way everywhere.
// Page zoom divides both fields by `zoom` and truncates the legacy one to a whole number (110% makes a notch 109): `zoom`
// undoes the division, and a count within a legacy unit of whole notches (the truncation, with room for rounding) is
// taken as them. The display's own scale does not change them.
export function wheelSteps(event: WheelInput, zoom = 1): WheelSteps {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return { steps: 0, fine: false };
  // The direction is deltaY's: an event built in script carries wheelDeltaY with deltaY's sign, Chromium's the opposite.
  const sign = Math.sign(event.deltaY), legacy = event.wheelDeltaY;
  if (event.deltaMode === 0 && legacy && Number.isFinite(legacy)) {
    const notches = Math.abs(legacy) * zoom / 120, whole = Math.round(notches);
    if (whole && Math.abs(notches - whole) <= 1.5 * zoom / 120) return { steps: sign * whole, fine: false };
    return { steps: event.deltaY * zoom / PIXELS_PER_STEP, fine: true };
  }
  // No legacy field (not Chromium). Lines and pages come from a wheel: one slice an event, whatever the number of lines
  // the system scrolls for a notch. Pixels come from a touchpad, or from a wheel the browser smooths, which reads as one.
  if (event.deltaMode === 1 || event.deltaMode === 2) return { steps: sign, fine: false };
  return { steps: event.deltaY * zoom / PIXELS_PER_STEP, fine: true };
}

/** How long a touchpad's swipe lasts past its last fine part. */
export const SWIPE_GAP_MS = 300;

/** A pane's or slice bar's wheel input over time: when the current swipe ends, and the touchpad slices it may still
 * page now (streamSlices) and when that was worked out. */
export interface WheelStream { fineUntil: number; allowance?: number; allowanceAt?: number }

/** The slices of one event of a stream. A touchpad's movement can come to whole notches by chance; during a swipe
 * (within SWIPE_GAP_MS of its last fine part) such an event is read as part of the swipe, by its pixels. A mouse
 * wheel turned within that time is read the same way, which changes only its speed. */
export function streamWheelSteps(event: WheelInput, zoom: number, now: number, stream: WheelStream): WheelSteps {
  const read = wheelSteps(event, zoom);
  if (read.steps === 0) return read;
  if (!read.fine && !(event.deltaMode === 0 && now < stream.fineUntil)) return read;
  stream.fineUntil = now + SWIPE_GAP_MS;
  return read.fine ? read : { steps: event.deltaY * zoom / PIXELS_PER_STEP, fine: true };
}

const touchpadSpeedOf = (value: number) => Number.isFinite(value) ? Math.max(TOUCHPAD_SPEED.min, Math.min(TOUCHPAD_SPEED.max, value)) : TOUCHPAD_SPEED.default;

/** The slices an event moves by at a touchpad speed: notches one each, a touchpad's pixels by the speed (a slice per
 * 16 px at 1×). */
export function wheelSlices(read: WheelSteps, touchpadSpeed: number): number {
  if (!read.fine) return read.steps;
  return read.steps * TOUCHPAD_SLICES_PER_STEP * touchpadSpeedOf(touchpadSpeed);
}

/** The most a touchpad pages at 1×, in slices a second; the speed multiplies it. Some touchpad drivers keep scrolling
 * on their own while the fingers rest at the pad's edge, steadily at the speed the fingers had when they got there,
 * for as long as they stay: measured on a Windows precision touchpad, 650–4000 px a second for one to two seconds,
 * twice the fingers' own pace on average. Such a run, or a hard flick, goes no faster than this, so the pace stays
 * that of moving fingers wherever they are on the pad: 60 a second is about their average pace at 1× there, and half
 * a slice a frame at 120 Hz, so no slice is passed over. Slower movement is untouched. */
export const TOUCHPAD_MAX_SLICES_PER_SECOND = 60;
/** After a pause a touchpad may page a tenth of a second's worth at once, so a short flick answers at once. */
const TOUCHPAD_BURST_SECONDS = 0.1;

/** The slices one event of a stream moves by: wheelSlices, with a touchpad held to TOUCHPAD_MAX_SLICES_PER_SECOND at
 * its speed. What goes past that is dropped, not kept for later, so the image stops when the fingers do. A mouse
 * wheel's notches are never held back: each is a slice. */
export function streamSlices(read: WheelSteps, touchpadSpeed: number, now: number, stream: WheelStream): number {
  const slices = wheelSlices(read, touchpadSpeed);
  if (!read.fine || slices === 0) return slices;
  const rate = TOUCHPAD_MAX_SLICES_PER_SECOND * touchpadSpeedOf(touchpadSpeed), most = rate * TOUCHPAD_BURST_SECONDS;
  const elapsed = stream.allowanceAt === undefined ? Infinity : Math.max(0, now - stream.allowanceAt) / 1000;
  const allowance = Math.min(most, (stream.allowance ?? most) + elapsed * rate);
  const paged = Math.min(Math.abs(slices), allowance);
  stream.allowance = allowance - paged; stream.allowanceAt = now;
  return Math.sign(slices) * paged;
}
