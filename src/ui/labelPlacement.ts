// Where a measurement label chip goes in a pane. Orientation letters and corner text are keep-out areas:
// laterality must stay readable, so a label moves to the left of or below its anchor before it covers them.

export interface Box { x: number; y: number; width: number; height: number }

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** Keep-out boxes for the overlay text the viewport draws (see Viewport.tsx): orientation letters at the edge
 * midpoints, patient/series text in the top corners, zoom/window text bottom left and the scale bottom right. */
/** How many text lines each corner holds (16 px apart); the bottom right ones stand above the scale bar. */
export interface CornerLines { topLeft: number; topRight: number; bottomLeft: number; bottomRight: number }
const TWO_LINES: CornerLines = { topLeft: 2, topRight: 2, bottomLeft: 2, bottomRight: 0 };

export function overlayKeepOut(width: number, height: number, cornerWidth: number, lines: CornerLines = TWO_LINES): Box[] {
  const top = (count: number) => Math.max(40, 8 + 16 * count);
  const bottom = Math.max(42, 10 + 16 * lines.bottomLeft);
  return [
    { x: 0, y: height / 2 - 13, width: 30, height: 26 }, { x: width - 30, y: height / 2 - 13, width: 30, height: 26 },
    { x: width / 2 - 15, y: 0, width: 30, height: 26 }, { x: width / 2 - 15, y: height - 68, width: 30, height: 24 },
    { x: 0, y: 0, width: cornerWidth + 14, height: top(lines.topLeft) }, { x: width - cornerWidth - 14, y: 0, width: cornerWidth + 14, height: top(lines.topRight) },
    { x: 0, y: height - bottom, width: Math.min(width * 0.62, 250), height: bottom }, { x: width - 124, y: height - 42, width: 124, height: 42 },
    ...lines.bottomRight ? [{ x: width - cornerWidth - 14, y: height - 42 - 16 * lines.bottomRight, width: cornerWidth + 14, height: 16 * lines.bottomRight }] : [],
  ];
}

/** Screen bounding box of a shape's points, padded so a label is not drawn over its strokes or handles. */
export function shapeBox(points: readonly (readonly [number, number])[], padding = 6): Box {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const x = Math.min(...xs) - padding, y = Math.min(...ys) - padding;
  return { x, y, width: Math.max(...xs) - Math.min(...xs) + padding * 2, height: Math.max(...ys) - Math.min(...ys) + padding * 2 };
}

/** The part of segment a→b inside the rectangle [x0, x1] × [y0, y1] (Liang–Barsky), or null when none is. */
function clipSegment(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

/** Keep-out boxes for a shape: its padded box when closed (ROIs), small boxes along the stroke for lines, so a
 * diagonal line does not reserve the whole rectangle it spans. With `bounds`, only the part of a line near the
 * pane counts, and each segment has at most 48 boxes (they grow to stay touching): at high zoom a line can be
 * thousands of pixels long, and this runs on every pan and zoom frame. */
export function shapeKeepOut(points: readonly (readonly [number, number])[], closed: boolean, padding = 6, bounds?: { width: number; height: number }): Box[] {
  if (closed || points.length < 2) return [shapeBox(points, points.length === 1 ? 10 : padding)];
  const boxes: Box[] = [];
  for (let index = 1; index < points.length; index++) {
    let [ax, ay] = points[index - 1], [bx, by] = points[index];
    if (bounds) {
      const visible = clipSegment(ax, ay, bx, by, -40, -40, bounds.width + 40, bounds.height + 40);
      if (!visible) continue;
      [ax, ay, bx, by] = visible;
    }
    const length = Math.hypot(bx - ax, by - ay), steps = Math.min(48, Math.max(1, Math.ceil(length / 10))), half = Math.max(padding, length / steps / 2);
    for (let step = 0; step <= steps; step++) {
      const x = ax + (bx - ax) * step / steps, y = ay + (by - ay) * step / steps;
      boxes.push({ x: x - half, y: y - half, width: half * 2, height: half * 2 });
    }
  }
  return boxes;
}

/** A chip beside its shape: right of it, else left, below or above; then inside a large shape, then at `anchor`.
 * The first place clear of everything wins. Otherwise overlay text and other labels (`hard`) count a thousand
 * times more than shapes (`soft`): laterality letters and patient text are never traded for a tidier layout. */
export function placeLabelBeside(shape: Box, size: { width: number; height: number }, pane: { width: number; height: number },
  hard: readonly Box[], soft: readonly Box[] = [], anchor?: readonly [number, number], margin = 8): { x: number; y: number } {
  const gap = 6, middle = shape.y + shape.height / 2 - size.height / 2;
  const clampX = (x: number) => Math.min(Math.max(margin, x), Math.max(margin, pane.width - size.width - margin));
  const clampY = (y: number) => Math.min(Math.max(margin, y), Math.max(margin, pane.height - size.height - margin));
  const points = [
    { x: shape.x + shape.width + gap, y: middle }, { x: shape.x - gap - size.width, y: middle },
    { x: shape.x, y: shape.y + shape.height + gap }, { x: shape.x, y: shape.y - gap - size.height },
    { x: shape.x + gap * 2, y: shape.y + gap * 2 },
    ...(anchor ? [{ x: anchor[0] + 12, y: anchor[1] - 10 - size.height / 2 }] : []),
  ];
  const candidates = points.map(point => ({ x: clampX(point.x), y: clampY(point.y) }));
  let best = candidates[0], bestScore = Infinity;
  for (const candidate of candidates) {
    const box = { ...candidate, ...size };
    const score = hard.reduce((sum, area) => sum + overlap(box, area), 0) * 1000 + soft.reduce((sum, area) => sum + overlap(box, area), 0);
    if (score === 0) return candidate;
    if (score < bestScore) { best = candidate; bestScore = score; }
  }
  return best;
}
