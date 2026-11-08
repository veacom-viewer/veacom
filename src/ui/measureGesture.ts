import { screenToWorld, worldToScreen, type ScreenMapping } from '../imaging/geometry';
import type { Tool, Vec3 } from '../model';

/** Patient-space points of a two-point measurement from `startWorld` to the screen point `end` in the current
 * view. The start is re-projected through `mapping` every time, so zooming, panning or rotating between the two
 * clicks of a click-click measurement still gives a rectangle (or ellipse box) square to the screen. The first
 * point is `startWorld` itself; the others are screen-to-patient mappings, exactly as a drag produces them. */
export function twoPointWorld(mapping: ScreenMapping, mode: Tool, startWorld: Vec3, end: readonly [number, number]): Vec3[] {
  if (mode !== 'rectangle' && mode !== 'ellipse') return [startWorld, screenToWorld(mapping, end[0], end[1])];
  const [x, y] = worldToScreen(mapping, startWorld);
  return [startWorld, screenToWorld(mapping, end[0], y), screenToWorld(mapping, end[0], end[1]), screenToWorld(mapping, x, end[1])];
}
