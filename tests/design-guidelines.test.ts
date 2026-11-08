import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// docs/design-guidelines.md, "Banned": no side stripes. A border on one side is only a 1px divider in a --line
// token, and no inset shadow draws a bar down a side. The owner banned the coloured strip in November 2026.
const root = path.resolve(import.meta.dirname, '../src');
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.(css|tsx?)$/.test(entry.name) ? [path.join(directory, entry.name)] : []);

const allowed: Record<string, RegExp> = {
  '': /^(none|0|1px solid var\(--line[\w-]*\))$/,
  width: /^(0|1px)$/,
  color: /^(var\(--line[\w-]*\)|transparent)$/,
  style: /^[a-z-]+$/,
};
const normal = (value: string) => value.trim().replace(/\s*!important$/, '').replace(/\s+/g, ' ').toLowerCase();

/** Each place in `text` (CSS, or a React style object) that sets a side stripe, with its line number. */
function sideStripes(text: string): string[] {
  const found: string[] = [];
  const line = (index: number) => text.slice(0, index).split('\n').length;
  for (const match of text.matchAll(/border-(?:left|right|inline-start|inline-end)(?:-(width|color|style))?\s*:\s*([^;}"'`]+)/g)) {
    if (!allowed[match[1] ?? ''].test(normal(match[2]))) found.push(`${line(match.index)}: ${match[0].trim()}`);
  }
  for (const match of text.matchAll(/border(?:Left|Right|InlineStart|InlineEnd)(Width|Color|Style)?\s*:\s*(?:(['"`])([^'"`]*)\2|(\d+(?:\.\d+)?))/g)) {
    const value = match[3] ?? (Number(match[4]) === 0 ? '0' : `${match[4]}px`);
    if (!allowed[(match[1] ?? '').toLowerCase()].test(normal(value))) found.push(`${line(match.index)}: ${match[0].trim()}`);
  }
  for (const match of text.matchAll(/(?:box-shadow|boxShadow|--shadow-[\w-]+)\s*:\s*['"`]?([^;}'"`]+)/g)) {
    for (const shadow of match[1].split(/,(?![^(]*\))/)) {
      if (!/\binset\b/i.test(shadow)) continue;
      const [x, y] = shadow.replace(/(?:rgba?|hsla?|var)\([^)]*\)|#[0-9a-f]{3,8}\b|\binset\b/gi, ' ').trim().split(/\s+/).map(parseFloat);
      if (Number.isFinite(x) && x !== 0 && !(Number.isFinite(y) && y !== 0)) found.push(`${line(match.index)}: ${shadow.trim()}`);
    }
  }
  return found;
}

describe('design guidelines', () => {
  it('finds side stripes in CSS and React styles, and lets 1px line dividers through', () => {
    assert.deepEqual(sideStripes('.deauville { padding: 6px 8px; border-left: 2px solid var(--accent); }'), ['1: border-left: 2px solid var(--accent)']);
    assert.equal(sideStripes('.row {\n  border-inline-start-color: var(--warning);\n}').length, 1);
    assert.equal(sideStripes('.card { border-right-width: 3px; }').length, 1);
    assert.equal(sideStripes('.note { box-shadow: inset 3px 0 0 var(--accent); }').length, 1);
    assert.equal(sideStripes('.note { box-shadow: 0 0 0 1px var(--line), -4px 0 0 0 var(--danger) inset; }').length, 1);
    assert.equal(sideStripes("<div style={{ borderLeft: '4px solid var(--accent)' }} />").length, 1);
    assert.equal(sideStripes('<div style={{ borderLeftWidth: 2 }} />').length, 1);
    assert.deepEqual(sideStripes([
      '.inspector { border-left: 1px solid var(--line); }',
      '.kinds > button + button { border-left:1px solid var(--line-strong); }',
      '.pane { border-right: none; border-left-width: 1px; border-left-color: var(--line-subtle); }',
      '--shadow-popover: 0 10px 30px rgba(0, 0, 0, .5), 0 1px 0 rgba(255, 255, 255, .03) inset;',
      '.field { box-shadow: inset 0 0 0 1px var(--line); }',
      "<div style={{ borderLeft: '1px solid var(--line)' }} />",
    ].join('\n')), []);
  });

  it('gives every box of warnings or cautions its dismiss button, through WarningBox', () => {
    // The owner asked for a dismiss button at the top of every warning box (November 2026).
    const boxes = files(root).filter(file => file.endsWith('.tsx') && !file.endsWith(`${path.sep}WarningBox.tsx`))
      .flatMap(file => [...readFileSync(file, 'utf8').matchAll(/className=[{"'`][^>]*\bgeometry-warnings\b/g)].map(() => path.relative(root, file)));
    assert.deepEqual(boxes, []);
    assert.match(readFileSync(path.join(root, 'components/WarningBox.tsx'), 'utf8'), /data-action="warning-dismiss"/);
  });

  it('has no side stripes anywhere in the interface', () => {
    const stripes = files(root).flatMap(file => sideStripes(readFileSync(file, 'utf8')).map(found => `${path.relative(root, file)}:${found}`));
    assert.deepEqual(stripes, []);
  });
});
