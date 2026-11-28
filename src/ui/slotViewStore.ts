import { useSyncExternalStore } from 'react';
import type { ViewState } from '../model';
import type { Slot } from './workspaceHelpers';

/** True when `a` and `b` differ only in display window values (no slice, plane, zoom, pan, or rotation change). */
export function isWindowOnlyChange(a: ViewState, b: ViewState): boolean {
  if (a === b) return false;
  return a.plane === b.plane
    && a.mode === b.mode
    && a.slice === b.slice
    && a.zoom === b.zoom
    && a.pan[0] === b.pan[0]
    && a.pan[1] === b.pan[1]
    && a.rotation === b.rotation
    && a.flipX === b.flipX
    && a.flipY === b.flipY
    && a.inverted === b.inverted
    && a.palette === b.palette
    && a.voiLut === b.voiLut
    && a.voiFunction === b.voiFunction
    && a.projection === b.projection
    && a.slab?.mode === b.slab?.mode
    && a.slab?.thickness === b.slab?.thickness
    && (a.oblique?.[0] ?? 0) === (b.oblique?.[0] ?? 0)
    && (a.oblique?.[1] ?? 0) === (b.oblique?.[1] ?? 0);
}

/** Per-pane live view store so high-frequency paging and window drags update only the active pane's
 * footer and viewport instead of re-rendering the entire workspace tree on every animation frame. */
export class SlotViewStore {
  private views = new Map<string, ViewState>();
  private listeners = new Map<string, Set<() => void>>();
  private refListeners = new Set<() => void>();
  private refVersion = 0;
  private immediate = false;

  syncSlots(slots: readonly Slot[], immediate = false): void {
    const changed: string[] = [];
    let geometryChanged = false;
    const present = new Set<string>();
    for (const slot of slots) {
      present.add(slot.id);
      const previous = this.views.get(slot.id);
      if (previous !== slot.view) {
        this.views.set(slot.id, slot.view);
        changed.push(slot.id);
        if (!previous || !isWindowOnlyChange(previous, slot.view)) geometryChanged = true;
      }
    }
    for (const id of this.views.keys()) {
      if (!present.has(id)) this.views.delete(id);
    }
    const prevImmediate = this.immediate;
    this.immediate = immediate;
    try {
      for (const id of changed) {
        const group = this.listeners.get(id);
        if (group) for (const listener of group) listener();
      }
    } finally {
      this.immediate = prevImmediate;
    }
    if (geometryChanged && this.refListeners.size) {
      this.refVersion++;
      for (const listener of this.refListeners) listener();
    }
  }

  isImmediate(): boolean {
    return this.immediate;
  }

  get(slotId: string, fallback: ViewState): ViewState {
    return this.views.get(slotId) ?? fallback;
  }

  subscribe(slotId: string, listener: () => void): () => void {
    let group = this.listeners.get(slotId);
    if (!group) {
      group = new Set();
      this.listeners.set(slotId, group);
    }
    group.add(listener);
    return () => {
      group.delete(listener);
      if (!group.size) this.listeners.delete(slotId);
    };
  }

  referenceVersion(): number {
    return this.refVersion;
  }

  subscribeReferences(listener: () => void): () => void {
    this.refListeners.add(listener);
    return () => { this.refListeners.delete(listener); };
  }
}

export function useSlotView(store: SlotViewStore | undefined, slotId: string, fallback: ViewState): ViewState {
  return useSyncExternalStore(
    listener => store ? store.subscribe(slotId, listener) : () => {},
    () => store ? store.get(slotId, fallback) : fallback,
  );
}

export function useReferenceVersion(store: SlotViewStore | undefined, active: boolean): number {
  return useSyncExternalStore(
    listener => store && active ? store.subscribeReferences(listener) : () => {},
    () => store && active ? store.referenceVersion() : 0,
  );
}
