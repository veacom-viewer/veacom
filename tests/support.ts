// What the tests need beyond node:test and node:assert/strict. Each keeps the meaning the tests were written to.
import assert from 'node:assert/strict';

/** Passes when actual is a number within 10^-digits / 2 of expected (two decimal places by default). */
export function assertClose(actual: number | null | undefined, expected: number, digits = 2, message?: string): void {
  if (actual === expected) return;
  const tolerance = 10 ** -digits / 2;
  if (typeof actual === 'number' && Math.abs(actual - expected) < tolerance) return;
  assert.fail(`${message ? `${message}: ` : ''}expected ${actual} to be within ${tolerance} of ${expected}`);
}

/**
 * Compares only the properties expected names, at every depth; arrays must still match in length and item by item.
 * assert.partialDeepStrictEqual would also pass an array with more items, such as ['one'] for an expected [].
 */
export function assertFields(actual: unknown, expected: unknown, message?: string): void {
  const fields = project(actual, expected);
  if (message === undefined) assert.deepStrictEqual(fields, expected);
  else assert.deepStrictEqual(fields, expected, message);
}
function project(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length ? actual.map((item, index) => project(item, expected[index])) : actual;
  }
  if (!isPlainObject(expected) || typeof actual !== 'object' || actual === null) return actual;
  const fields = actual as Record<string, unknown>;
  return Object.fromEntries(Object.keys(expected).filter(key => key in fields).map(key => [key, project(fields[key], expected[key])]));
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Captured now, so waiting still works while a test fakes timers or the clock.
const realSetTimeout = globalThis.setTimeout, now = performance.now.bind(performance);
/** Calls check until it stops throwing, every interval ms for up to timeout ms, and returns its result. */
export async function waitFor<T>(check: () => T | Promise<T>, { timeout = 1000, interval = 50 } = {}): Promise<T> {
  const deadline = now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (now() >= deadline) throw error;
    }
    await new Promise(resolve => realSetTimeout(resolve, interval));
  }
}

const stubs = new Map<string, PropertyDescriptor | undefined>();
/** Replaces a global, even one Node defines with a getter such as navigator, until restoreGlobals(). */
export function stubGlobal(name: string, value: unknown): void {
  if (!stubs.has(name)) stubs.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
}
/** Puts back every global stubGlobal() replaced; test files call it in afterEach. */
export function restoreGlobals(): void {
  for (const [name, descriptor] of stubs) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  stubs.clear();
}
