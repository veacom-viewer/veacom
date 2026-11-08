import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertFields } from './support';
import { hitAnnotation, leaderLine, movedHandle, nearestOnPaths, screenPaths, type HitTarget } from '../src/ui/annotationEdit';
import type { Annotation, Vec3 } from '../src/model';

const annotation = (id: string, type: Annotation['type'], points: Vec3[], extra: Partial<Annotation> = {}): Annotation =>
  ({ id, type, points, plane: 'axial', slice: 0, mode: 'mpr', ...extra });
// Screen points are the world x and y here.
const target = (item: Annotation, label: HitTarget['label'] = null): HitTarget => ({ annotation: item, points: item.points.map(p => [p[0], p[1]]), label });

describe('taking hold of a measurement', () => {
  const line = annotation('a', 'length', [[10, 10, 0], [110, 10, 0]]);
  const box = { x: 120, y: 0, width: 60, height: 20 };
  it('finds a handle first, then the label, then the line', () => {
    assertFields(hitAnnotation([target(line, box)], null, [108, 14]), { part: 1 });
    assertFields(hitAnnotation([target(line, box)], null, [150, 10]), { part: 'label' });
    assertFields(hitAnnotation([target(line, box)], null, [60, 14]), { part: 'body' });
    assert.equal(hitAnnotation([target(line, box)], null, [60, 17]), null);
  });
  it('prefers the selected measurement, then the later one', () => {
    const other = annotation('b', 'length', [[10, 10, 0], [10, 110, 0]]);
    assert.equal(hitAnnotation([target(line), target(other)], null, [10, 10])?.annotation.id, 'b');
    assert.equal(hitAnnotation([target(line), target(other)], 'a', [10, 10])?.annotation.id, 'a');
  });
  it('takes an ellipse by its outline, not its inside', () => {
    const ellipse = annotation('e', 'ellipse', [[0, 0, 0], [100, 0, 0], [100, 50, 0], [0, 50, 0]]);
    assertFields(hitAnnotation([target(ellipse)], null, [50, 2]), { part: 'body' });
    assert.equal(hitAnnotation([target(ellipse)], null, [50, 25]), null);
    assert.equal(screenPaths(ellipse, ellipse.points.map(p => [p[0], p[1]]))[0][1], true);
  });
  it('moves one end of a line, and keeps a rectangle a rectangle', () => {
    assert.deepEqual(movedHandle(line, 1, [80, 40, 0]), [[10, 10, 0], [80, 40, 0]]);
    const rectangle = annotation('r', 'rectangle', [[0, 0, 0], [40, 0, 0], [40, 20, 0], [0, 20, 0]]);
    assert.deepEqual(movedHandle(rectangle, 2, [60, 30, 5]), [[0, 0, 0], [60, 0, 0], [60, 30, 0], [0, 30, 0]]);
    assert.deepEqual(movedHandle(rectangle, 0, [-10, -5, 0]), [[-10, -5, 0], [40, -5, 0], [40, 20, 0], [-10, 20, 0]]);
  });
  it('joins a label moved away to the nearest point of its measurement', () => {
    const paths = screenPaths(line, [[10, 10], [110, 10]]);
    assert.deepEqual(leaderLine(paths, { x: 40, y: 60, width: 40, height: 20 }), [[60, 10], [60, 60]]);
    assert.equal(leaderLine(paths, { x: 40, y: 18, width: 40, height: 20 }), null);
    assert.deepEqual(nearestOnPaths(paths, [200, 10]), { point: [110, 10], distance: 90 });
    // A closed shape: from the label's edge to the outline, on the line between their middles.
    const box = annotation('b', 'rectangle', [[0, 0, 0], [40, 0, 0], [40, 20, 0], [0, 20, 0]]);
    assert.deepEqual(leaderLine(screenPaths(box, [[0, 0], [40, 0], [40, 20], [0, 20]]), { x: 100, y: 0, width: 40, height: 20 }), [[40, 10], [100, 10]]);
  });
});
