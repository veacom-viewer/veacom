import { useImperativeHandle, useState } from 'react';
import type { RefObject } from 'react';
import { fitWidth } from '../ui/overlayFont';

/** Sets the lines the readout shows; empty clears it. */
export type ReadoutSetter = (lines: string[]) => void;

const same = (a: string[], b: string[]) => a.length === b.length && a.every((line, index) => line === b[index]);

/**
 * The value under the pointer (imaging/readout.ts), in the image's bottom-right corner: the pane calls its setter
 * as the pointer moves, so only these lines draw again, never the image or the rest of the overlay.
 * It is its own layer, left out of exported pictures and videos: what was under the pointer is no part of the image.
 */
export function ValueReadout({ ref, right, bottom, width, fontFamily }: {
  ref: RefObject<ReadoutSetter | null>;
  /** Where its lines end on the right, where the lowest one sits and how wide they may be, in pane pixels. */
  right: number; bottom: number; width: number; fontFamily: string;
}) {
  const [lines, setLines] = useState<string[]>([]);
  useImperativeHandle(ref, () => (next: string[]) => setLines(previous => same(previous, next) ? previous : next), []);
  return <svg data-testid="pointer-readout" data-export-exclude aria-hidden="true"
    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'hidden' }}>
    <g fill="#e6e8eb" fontFamily="var(--font-ui)" fontSize={12} stroke="#000" strokeWidth={2.5} paintOrder="stroke" strokeLinejoin="round" textAnchor="end">
      {lines.map((line, index) => <text key={index} x={right} y={bottom - (lines.length - 1 - index) * 16}>{fitWidth(line, width, fontFamily)}</text>)}
    </g>
  </svg>;
}
