// Motion in the interface is brief and has a reason (docs/design-guidelines.md, "Motion with a reason"): nothing
// animates without end. An endless animation also makes the app draw a frame at every screen refresh for as long as
// it shows, which a slow PC pays for exactly while it loads a study.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '../src');

/** A stylesheet's animation declarations that run without end, as written but on one line. CSS keywords are read in
 * any case; a declaration's value runs to its semicolon or brace, over as many lines as it takes; comments and
 * selectors are no declarations. */
function endlessAnimations(css: string): string[] {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[{;\s])((?:-[a-z]+-)?animation(?:-iteration-count)?)\s*:\s*([^;{}]*)/gi);
  return [...declarations].filter(([, , value]) => /\binfinite\b/i.test(value)).map(([, name, value]) => `${name}: ${value.trim().replace(/\s+/g, ' ')}`);
}

it('finds an endless animation in an animation declaration only, in any case and over several lines', () => {
  assert.deepEqual(endlessAnimations('.a { animation: turn 1s linear INFINITE; }'), ['animation: turn 1s linear INFINITE']);
  assert.deepEqual(endlessAnimations('.a {\n  animation:\n    turn 1s\n    infinite;\n}'), ['animation: turn 1s infinite']);
  assert.deepEqual(endlessAnimations('.a { Animation-Iteration-Count: infinite }'), ['Animation-Iteration-Count: infinite']);
  assert.deepEqual(endlessAnimations('.a { -webkit-animation: turn 1s infinite; }'), ['-webkit-animation: turn 1s infinite']);
  // A selector, a comment and an animation that ends are not.
  assert.deepEqual(endlessAnimations('.infinite-scroll { overflow: auto; }\n/* animation: turn 1s infinite; */'), []);
  assert.deepEqual(endlessAnimations('.a { animation: turn 1s 3; transition: opacity 0.2s; }'), []);
});

it('has no animation that runs without end', () => {
  const sheets = readdirSync(source, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.css'));
  assert.ok(sheets.length > 0);
  for (const sheet of sheets) assert.deepEqual(endlessAnimations(readFileSync(path.join(source, sheet), 'utf8')), [], `${sheet} animates without end`);
});
