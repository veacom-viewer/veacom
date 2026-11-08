// Keyboard navigation and layout for the viewer.

export function focusOnMount(element: HTMLElement | null): void {
  element?.focus({ preventScroll: true });
}

export type NavigationKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/** Next index for a one-dimensional list (menu or toolbar). Disabled entries are skipped and the
 * movement wraps. Returns `current` when nothing else can take focus, -1 for an empty list. */
export function nextIndex(current: number, key: string, enabled: readonly boolean[], orientation: 'vertical' | 'horizontal'): number {
  const count = enabled.length;
  if (!count || !enabled.some(Boolean)) return -1;
  const forward = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const backward = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  const scan = (start: number, step: number) => {
    for (let offset = 0; offset < count; offset++) {
      const index = ((start + step * offset) % count + count) % count;
      if (enabled[index]) return index;
    }
    return current;
  };
  if (key === 'Home') return scan(0, 1);
  if (key === 'End') return scan(count - 1, -1);
  if (key === forward) return scan(current < 0 ? 0 : current + 1, 1);
  if (key === backward) return scan(current < 0 ? count - 1 : current - 1, -1);
  return current;
}

/** Arrow movement in the rows × columns layout picker, clamped to the grid (no wrapping). */
export function moveInGrid(position: readonly [number, number], key: string, size: readonly [number, number]): [number, number] {
  const [row, column] = position, [rows, columns] = size;
  const clamp = (value: number, max: number) => Math.max(1, Math.min(max, value));
  switch (key) {
    case 'ArrowUp': return [clamp(row - 1, rows), column];
    case 'ArrowDown': return [clamp(row + 1, rows), column];
    case 'ArrowLeft': return [row, clamp(column - 1, columns)];
    case 'ArrowRight': return [row, clamp(column + 1, columns)];
    case 'Home': return [1, 1];
    case 'End': return [rows, columns];
    default: return [row, column];
  }
}

export interface ToolbarEntry { id: string; width: number; /** Lower values leave the toolbar first; omit to keep it always. */ priority?: number }

/** Which toolbar entries move into the second row so the rest fits in `available` pixels.
 * Entries without a priority never move. The More button's width is only paid when something moves. */
export function planToolbar(entries: readonly ToolbarEntry[], available: number, overflowWidth: number): Set<string> {
  const hidden = new Set<string>();
  let total = entries.reduce((sum, entry) => sum + entry.width, 0);
  if (total <= available) return hidden;
  total += overflowWidth;
  const movable = entries.filter(entry => entry.priority !== undefined).sort((a, b) => a.priority! - b.priority!);
  for (const entry of movable) {
    if (total <= available) break;
    hidden.add(entry.id);
    total -= entry.width;
  }
  return hidden;
}

/** Splits a measurement summary into lines at its " · " separators so no line is longer than
 * `maxCharacters` unless a single part already is. Parts are never altered or dropped; a line break
 * takes the place of the separator it falls on. */
export function wrapLabel(text: string, maxCharacters: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const parts = paragraph.split(' · ');
    let line = '';
    for (const part of parts) {
      const candidate = line ? `${line} · ${part}` : part;
      if (line && candidate.length > maxCharacters) { lines.push(line); line = part; } else line = candidate;
    }
    lines.push(line);
  }
  return lines;
}
