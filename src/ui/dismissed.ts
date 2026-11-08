// Boxes of warnings or cautions the reader dismissed in this session (components/WarningBox.tsx), each known by a key
// that names the box and what it says. A dismissed box comes back when what it says changes (a new key), and in the
// next session: nothing here is kept.
import { useSyncExternalStore } from 'react';

const dismissed = new Set<string>();
const listeners = new Set<() => void>();

/** Dismisses the box known by `key` for this session. */
export function dismiss(key: string): void {
  if (dismissed.has(key)) return;
  dismissed.add(key);
  for (const listener of [...listeners]) listener();
}

export const isDismissed = (key: string) => dismissed.has(key);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether the box known by `key` was dismissed, re-rendering when it is. */
export function useDismissed(key: string): boolean {
  const read = () => dismissed.has(key);
  return useSyncExternalStore(subscribe, read, read);
}
