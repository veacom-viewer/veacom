import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moveInGrid, nextIndex, planToolbar, wrapLabel } from '../src/ui/navigation';
import { modifierKey, presetFor } from '../src/ui/presets';
import { overlayKeepOut, placeLabelBeside, shapeBox, shapeKeepOut } from '../src/ui/labelPlacement';

describe('menu and toolbar keyboard movement', () => {
  const all = [true, true, true, true];
  it('moves down and up through a menu, wrapping at both ends', () => {
    assert.equal(nextIndex(0, 'ArrowDown', all, 'vertical'), 1);
    assert.equal(nextIndex(3, 'ArrowDown', all, 'vertical'), 0);
    assert.equal(nextIndex(0, 'ArrowUp', all, 'vertical'), 3);
  });
  it('skips disabled entries and jumps to the first and last enabled one', () => {
    const enabled = [false, true, false, true, false];
    assert.equal(nextIndex(1, 'ArrowDown', enabled, 'vertical'), 3);
    assert.equal(nextIndex(3, 'ArrowDown', enabled, 'vertical'), 1);
    assert.equal(nextIndex(3, 'Home', enabled, 'vertical'), 1);
    assert.equal(nextIndex(1, 'End', enabled, 'vertical'), 3);
  });
  it('starts from the first or last entry when nothing has focus yet', () => {
    assert.equal(nextIndex(-1, 'ArrowDown', all, 'vertical'), 0);
    assert.equal(nextIndex(-1, 'ArrowUp', all, 'vertical'), 3);
  });
  it('uses left and right in a toolbar and ignores the other axis', () => {
    assert.equal(nextIndex(1, 'ArrowRight', all, 'horizontal'), 2);
    assert.equal(nextIndex(0, 'ArrowLeft', all, 'horizontal'), 3);
    assert.equal(nextIndex(1, 'ArrowDown', all, 'horizontal'), 1);
  });
  it('reports when nothing can take focus', () => {
    assert.equal(nextIndex(0, 'ArrowDown', [], 'vertical'), -1);
    assert.equal(nextIndex(0, 'ArrowDown', [false, false], 'vertical'), -1);
  });
});

describe('layout picker', () => {
  it('moves within the 5 × 5 grid without wrapping', () => {
    assert.deepEqual(moveInGrid([1, 1], 'ArrowRight', [5, 5]), [1, 2]);
    assert.deepEqual(moveInGrid([1, 1], 'ArrowUp', [5, 5]), [1, 1]);
    assert.deepEqual(moveInGrid([5, 5], 'ArrowDown', [5, 5]), [5, 5]);
    assert.deepEqual(moveInGrid([3, 2], 'End', [5, 5]), [5, 5]);
    assert.deepEqual(moveInGrid([3, 2], 'Home', [5, 5]), [1, 1]);
  });
});

describe('toolbar overflow', () => {
  const entries = [
    { id: 'file', width: 100 }, { id: 'tools', width: 200 },
    { id: 'fusion', width: 40, priority: 1 }, { id: 'link', width: 40, priority: 3 }, { id: 'orientation', width: 60, priority: 2 },
  ];
  it('keeps everything when it fits, without paying for the overflow button', () => {
    assert.deepEqual([...planToolbar(entries, 440, 36)], []);
  });
  it('moves the lowest priorities first until the rest and the overflow button fit', () => {
    assert.deepEqual([...planToolbar(entries, 420, 36)], ['fusion', 'orientation']);
    assert.deepEqual([...planToolbar(entries, 300, 36)].sort(), ['fusion', 'link', 'orientation']);
  });
  it('never moves entries without a priority', () => {
    assert.equal(planToolbar(entries, 10, 36).has('tools'), false);
  });
});

describe('measurement label wrapping', () => {
  const roi = '1876.1 mm² · mean 221.8 HU · min 3.0 · max 805.0 · σ 295.4 · 994 source voxels';
  it('breaks long summaries at separators and keeps every part', () => {
    const lines = wrapLabel(roi, 30);
    assert.equal(lines.every(line => line.length <= 30), true);
    assert.equal(lines.join(' · '), roi);
  });
  it('leaves short labels and existing line breaks alone', () => {
    assert.deepEqual(wrapLabel('217.0 mm', 30), ['217.0 mm']);
    assert.deepEqual(wrapLabel('a\nb', 30), ['a', 'b']);
  });
  it('keeps a single part that is longer than the limit on its own line', () => {
    assert.deepEqual(wrapLabel('İç odak — şüpheli ğ/ü/ö/ç ve uzun bir not', 10), ['İç odak — şüpheli ğ/ü/ö/ç ve uzun bir not']);
  });
});

describe('window presets and shortcut labels', () => {
  it('names the preset that matches the displayed window', () => {
    assert.equal(presetFor(400, 40)?.key, 'thorax');
    assert.equal(presetFor(1500.2, -400.4)?.key, 'lung');
    assert.equal(presetFor(2800, 600)?.key, 'temporalBone');
    assert.equal(presetFor(401, 40), undefined);
  });
  it('prints the macOS command key only on Apple platforms', () => {
    assert.equal(modifierKey('MacIntel'), '⌘');
    assert.equal(modifierKey('Win32'), 'Ctrl');
    assert.equal(modifierKey('Linux x86_64'), 'Ctrl');
  });
});

describe('measurement label placement', () => {
  const pane = { width: 400, height: 360 }, size = { width: 120, height: 21 };
  const letters = overlayKeepOut(pane.width, pane.height, 120);
  const intersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const chip = (point: { x: number; y: number }) => ({ ...point, ...size });
  const clearOfText = (point: { x: number; y: number }) => !letters.some(box => intersects(chip(point), box));
  it('puts a label to the right of its shape, centred on it, when there is room', () => {
    const shape = shapeBox([[120, 180], [180, 220]]);
    assert.deepEqual(placeLabelBeside(shape, size, pane, letters, [shape]), { x: shape.x + shape.width + 6, y: 189.5 });
  });
  it('does not cover its own ROI when another side is free', () => {
    const shape = shapeBox([[250, 150], [330, 230]]);
    assert.equal(intersects(chip(placeLabelBeside(shape, size, pane, letters, [shape])), shape), false);
  });
  // Cases from review: a large ROI or a diagonal line used to push the label onto a laterality letter.
  it('keeps a large ellipse label off the orientation letters and corner text', () => {
    const shape = shapeBox([[70, 60], [370, 60], [370, 320], [70, 320]]);
    assert.equal(clearOfText(placeLabelBeside(shape, size, pane, letters, [shape], [70, 320])), true);
  });
  it('keeps a 280 × 240 ellipse label off the top letter and the patient corner', () => {
    const shape = shapeBox([[60, 40], [340, 40], [340, 280], [60, 280]]);
    assert.equal(clearOfText(placeLabelBeside(shape, size, pane, letters, [shape], [60, 280])), true);
  });
  it('limits a long line at high zoom to boxes near the pane that still cover its visible part', () => {
    const line: [number, number][] = [[-50_000, 100], [50_000, 300]];
    const boxes = shapeKeepOut(line, false, 6, pane);
    assert.ok(boxes.length <= 49);
    assert.equal(boxes.every(box => box.x + box.width >= -40 && box.x <= pane.width + 40), true);
    const onLine = (x: number) => [x, 100 + (x + 50_000) / 100_000 * 200] as const;
    for (const x of [0, 137, 200, 399]) {
      const [px, py] = onLine(x);
      assert.equal(boxes.some(box => px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height), true);
    }
    assert.deepEqual(shapeKeepOut([[-900, -900], [-500, -800]], false, 6, pane), []);
  });
  it('lets a diagonal line keep out only its stroke, so its label stays off the letters', () => {
    const line: [number, number][] = [[40, 330], [380, 40]];
    const stroke = shapeKeepOut(line, false);
    const point = placeLabelBeside(shapeBox(line), size, pane, letters, stroke, line[1]);
    assert.equal(clearOfText(point), true);
    assert.equal(stroke.some(box => intersects(chip(point), box)), false);
  });
});
