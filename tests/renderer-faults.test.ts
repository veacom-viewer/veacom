import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { exceptionClass } from '../electron/crash-exception.mjs';

it('exposes only the exception class through the sandboxed renderer bridge', () => {
  let bridge!: { reportRendererFailure: (reason: unknown, exception: unknown) => void };
  const messages: unknown[][] = [];
  runInNewContext(readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    process: { argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, api: typeof bridge) => { bridge = api; } },
      ipcRenderer: { send: (...args: unknown[]) => messages.push(args) },
    }),
  });
  const sentinel = 'SYNTHETIC_PRIVATE_PATH';
  const untrustedError = new Error(sentinel);
  Object.defineProperty(untrustedError, 'name', { get() { throw new Error('Must not read the error name'); } });
  Object.defineProperty(untrustedError, 'stack', { get() { throw new Error('Must not read the error stack'); } });
  for (const input of [new TypeError(sentinel), new RangeError(sentinel), new ReferenceError(sentinel), new SyntaxError(sentinel), untrustedError]) {
    bridge.reportRendererFailure('render-failed', exceptionClass(input));
  }
  const unusualError = Object.setPrototypeOf(new Error(sentinel), new Proxy({}, {
    getPrototypeOf() { throw new Error('Must not walk an exception’s prototype chain'); },
  }));
  assert.equal(exceptionClass(unusualError), 'unknown');
  bridge.reportRendererFailure('unhandled-rejection', exceptionClass(sentinel));
  bridge.reportRendererFailure('uncaught-exception', exceptionClass(new RangeError(sentinel)));
  bridge.reportRendererFailure('unhandled-rejection', untrustedError);
  bridge.reportRendererFailure('uncaught-exception', sentinel);
  bridge.reportRendererFailure(sentinel, 'type');
  assert.deepEqual(messages, [
    ...['type', 'range', 'reference', 'syntax', 'unknown'].map(value => ['fault:renderer', 'render-failed', value]),
    ['fault:renderer', 'unhandled-rejection', 'unknown'], ['fault:renderer', 'uncaught-exception', 'range'],
  ]);
});
