import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nearestTouchpadSpeed, streamSlices, streamWheelSteps, SWIPE_GAP_MS, TOUCHPAD_MAX_SLICES_PER_SECOND, TOUCHPAD_SPEED, TOUCHPAD_SPEEDS, wheelSlices, wheelSteps, type WheelStream } from '../src/imaging/interaction';

// Chromium's wheel events (blink WheelEvent, web_input_event_builders_mac.mm and _win.cc): wheelDeltaY is 120 per raw
// notch, of the opposite sign to deltaY, and adds up when a frame's notches merge; deltaY is pixels, accelerated on
// macOS. Windows gives a notch 100 px (three lines of 100/3 px), and a touchpad's wheel messages a part of that.
const steps = (deltaY: number, wheelDeltaY?: number, zoom?: number) => wheelSteps({ deltaY, deltaMode: 0, wheelDeltaY }, zoom).steps;
const fine = (deltaY: number, wheelDeltaY?: number, zoom?: number) => wheelSteps({ deltaY, deltaMode: 0, wheelDeltaY }, zoom).fine;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

describe('wheel notches and precision scrolling', () => {
  it('moves one slice a notch however macOS accelerates it', () => {
    assert.equal(steps(4.000244140625, -120), 1);
    assert.equal(steps(-4.000244140625, 120), -1);
    assert.equal(steps(83, -120), 1);
    assert.equal(steps(40, -120), 1);
  });
  it('counts the notches Chromium merges into one event', () => {
    assert.equal(steps(240, -360), 3);
    assert.equal(steps(-160, 480), -4);
    assert.equal(steps(13.5, -360), 3);
    // 300 notches at four a frame (240 a second on a 60 Hz screen) arrive as 75 events and move 300 slices.
    assert.equal(Array.from({ length: 75 }).reduce<number>(sum => sum + steps(160, -480), 0), 300);
  });
  it('keeps Windows detents, single and combined', () => {
    assert.equal(steps(100, -120), 1);
    assert.equal(steps(400, -480), 4);
    assert.equal(steps(-600, 720), -6);
    // An observed Windows 240 Hz trace combined 120 detents into 32 browser events.
    const batches = [1, 1, 2, ...Array(29).fill(4)];
    assert.equal(batches.reduce((sum, count) => sum + steps(count * 100, -count * 120), 0), 120);
  });
  it('pages a touchpad by the pixels the system scrolled, a slice per 40 px, with no cap on fast swipes', () => {
    // macOS: three legacy units a pixel.
    near(steps(10, -30), 0.25);
    near(steps(29, -87), 0.725);
    near(steps(30, -90), 0.75);
    near(steps(-4, 12), -0.1);
    // Windows: a touchpad's wheel message of 30 raw units is a quarter notch, 25 px, 1.2 units a pixel.
    near(steps(25, -30), 0.625);
    assert.equal(fine(25, -30), true);
    // Movements that come to whole notches read as notches on their own: within a swipe they stay the swipe's (below).
    assert.equal(steps(80, -240), 2);
    assert.equal(steps(400, -1200), 10);
  });
  it('tells a wheel from a touchpad', () => {
    for (const [deltaY, legacy, zoom] of [[100, -120, 1], [240, -360, 1], [3.65, -109, 1.2 ** 0.5], [4.4, -133, 0.9]] as const) assert.equal(fine(deltaY, legacy, zoom), false);
    for (const [deltaY, legacy] of [[10, -30], [25, -30], [8, -24], [100, 100]] as const) assert.equal(fine(deltaY, legacy), true);
  });
  it('undoes page zoom, which makes a notch 120 / zoom legacy units, truncated', () => {
    assert.equal(steps(3.2, -96, 1.25), 1);
    assert.equal(steps(2.3, -68, 1.75), 1);
    assert.equal(steps(6.9, -205, 1.75), 3);
    // Electron's Zoom In steps by half a zoom level: a factor of 1.2 ** 0.5, a notch of 109 units.
    assert.equal(steps(3.65, -109, 1.2 ** 0.5), 1);
    assert.equal(steps(10.95, -328, 1.2 ** 0.5), 3);
    assert.equal(steps(4.4, -133, 0.9), 1);
    // A float-rounded field one unit short of a whole notch is still the notch.
    assert.equal(steps(3.3, -99, 1.2), 1);
    // A trackpad's pixels are the same at any zoom: 10 px at 125% are 8 CSS px and 24 units.
    near(steps(8, -24, 1.25), 0.25);
  });
  it('takes the direction from deltaY, as events built in script copy it into wheelDeltaY', () => {
    near(steps(100, 100), 2.5);
    near(steps(-100, -100), -2.5);
    assert.equal(steps(100, -120), 1);
  });
  it('pages a line or a page one slice an event, whatever the lines a notch scrolls, and ignores empty events', () => {
    assert.deepEqual(wheelSteps({ deltaY: 3, deltaMode: 1 }), { steps: 1, fine: false });
    assert.deepEqual(wheelSteps({ deltaY: -3, deltaMode: 1, wheelDeltaY: 360 }), { steps: -1, fine: false });
    assert.deepEqual(wheelSteps({ deltaY: -1, deltaMode: 2 }), { steps: -1, fine: false });
    assert.deepEqual(wheelSteps({ deltaY: 80, deltaMode: 0 }), { steps: 2, fine: true });
    assert.equal(steps(0, -120), 0);
    assert.equal(steps(Number.NaN, -120), 0);
  });
});

describe('the touchpad speed', () => {
  it('pages a notch one slice at any speed, and a touchpad by the speed', () => {
    for (const speed of [TOUCHPAD_SPEED.min, TOUCHPAD_SPEED.default, TOUCHPAD_SPEED.max, 100]) {
      assert.equal(wheelSlices({ steps: 1, fine: false }, speed), 1);
      assert.equal(wheelSlices({ steps: -3, fine: false }, speed), -3);
    }
    // A touchpad pages a slice per 16 px (0.4 steps) at the normal speed, and the speed multiplies that.
    near(wheelSlices({ steps: 0.4, fine: true }, 1), 1);
    near(wheelSlices({ steps: 0.4, fine: true }, 0.5), 0.5);
    near(wheelSlices({ steps: -0.4, fine: true }, 3), -3);
    near(wheelSlices({ steps: 0.4, fine: true }, 100), TOUCHPAD_SPEED.max);
    near(wheelSlices({ steps: 0.4, fine: true }, 0), TOUCHPAD_SPEED.min);
    near(wheelSlices({ steps: 0.4, fine: true }, Number.NaN), TOUCHPAD_SPEED.default);
  });
  it('reads a whole-notch-sized movement within a swipe as part of the swipe, and a wheel after it as notches', () => {
    const stream: WheelStream = { fineUntil: 0 };
    // A Windows touchpad: a quarter-notch message starts the swipe, then a message of exactly one notch, 100 px.
    assert.deepEqual(streamWheelSteps({ deltaY: 25, deltaMode: 0, wheelDeltaY: -30 }, 1, 1000, stream), { steps: 0.625, fine: true });
    assert.deepEqual(streamWheelSteps({ deltaY: 100, deltaMode: 0, wheelDeltaY: -120 }, 1, 1100, stream), { steps: 2.5, fine: true });
    // The swipe ended: a wheel's notch is a notch again.
    assert.deepEqual(streamWheelSteps({ deltaY: 100, deltaMode: 0, wheelDeltaY: -120 }, 1, 1100 + SWIPE_GAP_MS + 1, stream), { steps: 1, fine: false });
    // Lines never join a swipe.
    stream.fineUntil = 5000;
    assert.deepEqual(streamWheelSteps({ deltaY: 3, deltaMode: 1 }, 1, 4000, stream), { steps: 1, fine: false });
  });
  it('pages a typical Windows touchpad swipe several times faster than before at the default speed', () => {
    // One deliberate two-finger swipe through Windows' wheel messages: raw units a message, 1000 in all (833 px).
    const raw = [8, 16, 32, 56, 80, 104, 120, 120, 112, 96, 80, 64, 48, 32, 20, 12];
    assert.equal(raw.reduce((sum, unit) => sum + unit, 0), 1000);
    const stream: WheelStream = { fineUntil: 0 };
    const slices = (speed: number) => raw.reduce((sum, unit, index) => sum + wheelSlices(streamWheelSteps({ deltaY: unit * 100 / 120, deltaMode: 0, wheelDeltaY: -unit }, 1, index * 8, stream), speed), 0);
    // Before, Windows touchpads paged a slice per 100–120 px: 7–8 slices for this swipe. Now 1× is 16 px a slice.
    near(slices(TOUCHPAD_SPEED.default), 1000 * 100 / 120 / 16);
    near(slices(1 / 3), 1000 * 100 / 120 / 48);
    near(slices(3), 1000 * 100 / 120 / 16 * 3);
  });
  it('offers ⅓× to 3× of the normal speed, slowest first, 1× by default, and takes any other value as the nearest', () => {
    assert.deepEqual([...TOUCHPAD_SPEEDS].sort((a, b) => a - b), [...TOUCHPAD_SPEEDS]);
    assert.equal(TOUCHPAD_SPEEDS[0], TOUCHPAD_SPEED.min);
    assert.equal(TOUCHPAD_SPEEDS.at(-1), TOUCHPAD_SPEED.max);
    assert.equal(TOUCHPAD_SPEED.default, 1);
    assert.ok(TOUCHPAD_SPEEDS.includes(TOUCHPAD_SPEED.default) && TOUCHPAD_SPEEDS.includes(1 / 3) && TOUCHPAD_SPEEDS.includes(0.5));
    assert.equal(nearestTouchpadSpeed(1), 1);
    assert.equal(nearestTouchpadSpeed(0.33), 1 / 3);
    // By ratio: 1.2 is nearer 1 (×1.2) than 1.5 (×1.25).
    assert.equal(nearestTouchpadSpeed(1.2), 1);
    assert.equal(nearestTouchpadSpeed(2.4), 2.5);
    assert.equal(nearestTouchpadSpeed(0.01), 1 / 3);
    assert.equal(nearestTouchpadSpeed(100), 3);
    for (const value of [undefined, null, 'fast', Number.NaN, 0, -2]) assert.equal(nearestTouchpadSpeed(value), TOUCHPAD_SPEED.default);
  });
});

describe('the touchpad pace', () => {
  // Pages a run of identical events `every` ms apart from `start`, and gives the slices asked for and paged.
  const run = (deltaY: number, count: number, every: number, speed: number, stream: WheelStream = { fineUntil: 0 }, start = 1000) => {
    let asked = 0, paged = 0;
    for (let index = 0; index < count; index++) {
      const now = start + index * every, read = streamWheelSteps({ deltaY, deltaMode: 0, wheelDeltaY: -Math.trunc(deltaY) }, 1, now, stream);
      asked += wheelSlices(read, speed); paged += streamSlices(read, speed, now, stream);
    }
    return { asked, paged };
  };
  it('holds a driver\'s steady run at the pad\'s edge to 60 slices a second at 1×, twice that at 2×', () => {
    assert.equal(TOUCHPAD_MAX_SLICES_PER_SECOND, 60);
    // As recorded on a Windows precision touchpad: 34 px every 8.4 ms (4000 px a second) for 1.6 s.
    const normal = run(34, 190, 8.4, 1);
    near(normal.asked, 190 * 34 / 16);
    // A tenth of a second's worth at once, then the pace.
    assert.ok(Math.abs(normal.paged - (6 + 60 * 189 * 8.4 / 1000)) < 1e-6, String(normal.paged));
    const faster = run(34, 190, 8.4, 2);
    assert.ok(Math.abs(faster.paged - (12 + 120 * 189 * 8.4 / 1000)) < 1e-6, String(faster.paged));
    const backwards = run(-34, 190, 8.4, 1);
    assert.ok(Math.abs(backwards.paged + normal.paged) < 1e-6);
  });
  it('leaves fingers moving slower than that alone', () => {
    // 3 px every 8.4 ms: 22 slices a second at 1×.
    const slow = run(3, 120, 8.4, 1);
    near(slow.paged, slow.asked);
    near(slow.asked, 120 * 3 / 16);
  });
  it('never holds back a mouse wheel\'s notches, and lets a flick through at once after a pause', () => {
    const stream: WheelStream = { fineUntil: 0 };
    let notches = 0;
    for (let index = 0; index < 50; index++) notches += streamSlices(streamWheelSteps({ deltaY: 100, deltaMode: 0, wheelDeltaY: -120 }, 1, 1000, stream), 1, 1000, stream);
    assert.equal(notches, 50);
    run(34, 190, 8.4, 1, stream, 2000);
    // A second after the run the tenth of a second's allowance is back: 96 px at once are six slices.
    near(run(96, 1, 8.4, 1, stream, 2000 + 190 * 8.4 + 1000).paged, 6);
  });
});
