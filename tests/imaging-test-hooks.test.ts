import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createImagingTestHooks } = require('../electron/imaging-test-hooks.cjs');

afterEach(() => mock.timers.reset());

describe('test pixel gates', () => {
  it('fails a wait for a request that never comes after 60 s instead of hanging the check', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const hooks = createImagingTestHooks();
    const gate = hooks.api.holdPixelRequests('frame', 3);
    const waiting = assert.rejects(hooks.api.waitForHeldPixelRequest(gate), { message: /No frame request reached the test gate/ });
    mock.timers.tick(60_000);
    await waiting;
  });

  it('resolves with a request that arrives before the deadline, and keeps holding it until released', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const hooks = createImagingTestHooks();
    const gate = hooks.api.holdPixelRequests('frame', 3);
    const waiting = hooks.api.waitForHeldPixelRequest(gate);
    let passed = false;
    const held = hooks.beforePixel({ kind: 'frame', index: 3 }, new AbortController().signal).then(() => { passed = true; });
    assert.deepEqual(await waiting, { kind: 'frame', index: 3 });
    mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(passed, false);
    hooks.api.releasePixelRequests(gate);
    await held;
    assert.equal(passed, true);
  });
});
