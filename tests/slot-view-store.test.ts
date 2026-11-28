import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isWindowOnlyChange, SlotViewStore } from '../src/ui/slotViewStore';
import type { ViewState } from '../src/model';
import type { Slot } from '../src/ui/workspaceHelpers';

function view(overrides: Partial<ViewState> = {}): ViewState {
  return {
    mode: 'source',
    plane: 'axial',
    slice: 10,
    windowWidth: 400,
    windowCenter: 40,
    zoom: 1,
    pan: [0, 0],
    rotation: 0,
    flipX: false,
    flipY: false,
    inverted: false,
    palette: 'gray',
    ...overrides,
  };
}

function slot(id: string, v: ViewState): Slot {
  return { id, seriesId: 's1', view: v };
}

describe('SlotViewStore', () => {
  it('detects window-only view changes accurately', () => {
    const base = view();
    assert.equal(isWindowOnlyChange(base, base), false);
    assert.equal(isWindowOnlyChange(base, { ...base, windowWidth: 1500, windowCenter: -600 }), true);
    assert.equal(isWindowOnlyChange(base, { ...base, slice: 11 }), false);
    assert.equal(isWindowOnlyChange(base, { ...base, zoom: 1.5 }), false);
    assert.equal(isWindowOnlyChange(base, { ...base, pan: [5, 0] }), false);
    assert.equal(isWindowOnlyChange(base, { ...base, rotation: 90 }), false);
    assert.equal(isWindowOnlyChange(base, { ...base, plane: 'coronal' }), false);
    assert.equal(isWindowOnlyChange(base, { ...base, inverted: true }), false);
  });

  it('notifies only changed slots and bumps referenceVersion only on geometry changes', () => {
    const store = new SlotViewStore();
    const v1 = view({ slice: 5 });
    const v2 = view({ slice: 20 });
    store.syncSlots([slot('p1', v1), slot('p2', v2)]);

    let p1Calls = 0, p2Calls = 0, refCalls = 0;
    const unsub1 = store.subscribe('p1', () => { p1Calls++; });
    const unsub2 = store.subscribe('p2', () => { p2Calls++; });
    const unsubRef = store.subscribeReferences(() => { refCalls++; });

    // No-op sync triggers nothing.
    store.syncSlots([slot('p1', v1), slot('p2', v2)]);
    assert.equal(p1Calls, 0);
    assert.equal(p2Calls, 0);
    assert.equal(refCalls, 0);

    // Window-only change notifies p1 only, not p2 or reference lines.
    const v1Window = { ...v1, windowWidth: 1200, windowCenter: -400 };
    store.syncSlots([slot('p1', v1Window), slot('p2', v2)]);
    assert.equal(p1Calls, 1);
    assert.equal(p2Calls, 0);
    assert.equal(refCalls, 0);
    assert.equal(store.get('p1', v1), v1Window);

    // Slice change notifies p1 and bumps referenceVersion.
    const v1Slice = { ...v1Window, slice: 6 };
    store.syncSlots([slot('p1', v1Slice), slot('p2', v2)]);
    assert.equal(p1Calls, 2);
    assert.equal(p2Calls, 0);
    assert.equal(refCalls, 1);
    assert.equal(store.referenceVersion(), 1);

    // Removing p2 clears it from the store so fallback is returned.
    store.syncSlots([slot('p1', v1Slice)]);
    assert.equal(store.get('p2', v2), v2);

    // Immediate flag is exposed only during synchronous frame notifications.
    const seenImmediate: boolean[] = [];
    const unsubImm = store.subscribe('p1', () => { seenImmediate.push(store.isImmediate()); });
    store.syncSlots([slot('p1', { ...v1Slice, slice: 7 })]);
    store.syncSlots([slot('p1', { ...v1Slice, slice: 8 })], true);
    assert.deepEqual(seenImmediate, [false, true]);
    assert.equal(store.isImmediate(), false);

    unsubImm();
    unsub1();
    unsub2();
    unsubRef();
  });
});
