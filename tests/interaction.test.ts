import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wheelSliceSteps } from '../src/imaging/interaction';

// Chromium's wheel events (blink WheelEvent, web_input_event_builders_mac.mm): wheelDeltaY is 120 per raw notch, of the
// opposite sign to deltaY, and adds up when a frame's notches merge; deltaY is pixels, accelerated on macOS.
const steps = (deltaY: number, wheelDeltaY?: number, zoom?: number) => wheelSliceSteps({ deltaY, deltaMode: 0, wheelDeltaY }, zoom);
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
  it('pages trackpads in step with the swipe, with no cap on fast ones', () => {
    // Continuous devices report three legacy units a pixel: a slice per 40 px, rising steadily with speed.
    near(steps(10, -30), 0.25);
    near(steps(29, -87), 0.725);
    near(steps(30, -90), 0.75);
    assert.equal(steps(80, -240), 2);
    assert.equal(steps(400, -1200), 10);
    near(steps(-4, 12), -0.1);
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
    near(steps(100, 100), 100 / 120);
    near(steps(-100, -100), -100 / 120);
    assert.equal(steps(100, -120), 1);
  });
  it('falls back without the legacy field and ignores empty events', () => {
    assert.equal(wheelSliceSteps({ deltaY: 3, deltaMode: 1 }), 3);
    assert.equal(wheelSliceSteps({ deltaY: -3, deltaMode: 1, wheelDeltaY: 360 }), -3);
    assert.equal(wheelSliceSteps({ deltaY: -1, deltaMode: 2 }), -1);
    assert.equal(steps(80), 2);
    assert.equal(steps(0, -120), 0);
    assert.equal(steps(Number.NaN, -120), 0);
  });
});
