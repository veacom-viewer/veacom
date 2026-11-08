interface WheelInput { deltaY: number; deltaMode: number; wheelDeltaY?: number; }

// Wheel input in notches, a slice each, as VEAcom 1.x counted it with Qt (120 units a notch) at any speed.
// Chromium hands the page at most one wheel event a frame, adding up the notches that arrived within it, and on macOS
// deltaY carries the system's acceleration (a slow notch is about 4 px, a fast one many times that): deltaY can neither
// count notches nor tell a wheel from a trackpad. The legacy wheelDeltaY can: Chromium fills it with 120 per raw,
// unaccelerated notch and sums it when it merges events. Trackpads and Magic Mice get 3 units a pixel there, so they
// page a slice per 40 px, in step with the swipe however fast it is.
// Page zoom divides the field by `zoom` and truncates it to a whole number (110% makes a notch 109): `zoom` undoes the
// division, and a count within a legacy unit of whole notches (the truncation, with room for rounding) is taken as them.
export function wheelSliceSteps(event: WheelInput, zoom = 1): number {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0;
  const legacy = event.wheelDeltaY;
  if (event.deltaMode === 0 && legacy && Number.isFinite(legacy)) {
    // The direction is deltaY's: an event built in script carries wheelDeltaY with deltaY's sign, Chromium's the opposite.
    const notches = Math.abs(legacy) * zoom / 120, whole = Math.round(notches);
    return Math.sign(event.deltaY) * (whole && Math.abs(notches - whole) <= 1.5 * zoom / 120 ? whole : notches);
  }
  // No legacy field (not Chromium): a line is a notch, a page one step, and pixels go 40 to the notch.
  return event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? Math.sign(event.deltaY) : event.deltaY * zoom / 40;
}
