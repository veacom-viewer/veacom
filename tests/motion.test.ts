// Motion in the interface is brief and has a reason (docs/design-guidelines.md, "Motion with a reason"): nothing
// animates without end. An endless animation also makes the app draw a frame at every screen refresh for as long as
// it shows, which a slow PC pays for exactly while it loads a study.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '../src');

/** A stylesheet's animation declarations that run without end, as written but on one line. A declaration is one of a
 * block's, up to its semicolon or brace, over as many lines as it takes: comments and quoted text hold none, and
 * what comes before a "{" after its last ";" is a selector or an at-rule. It runs without end when one of its
 * values is the keyword `infinite`, in any case, `!important` or not; an animation's name that only holds the word does
 * not. */
function endlessAnimations(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const declarations = [...text.matchAll(/([^{}]*)([{}]|$)/g)].flatMap(([, part, end]) => end === '{' ? part.split(';').slice(0, -1) : part.split(';'));
  return declarations.flatMap(declaration => {
    const found = /^\s*((?:-[a-z]+-)?animation(?:-iteration-count)?)\s*:([\s\S]*)$/i.exec(declaration);
    const values = found?.[2].replace(/!\s*important\b/gi, ' ').split(/[\s,]+/) ?? [];
    if (!found || !values.some(value => value.toLowerCase() === 'infinite')) return [];
    return [`${found[1]}: ${found[2].trim().replace(/\s+/g, ' ')}`];
  });
}

it('finds an endless animation in an animation declaration only, in any case and over several lines', () => {
  assert.deepEqual(endlessAnimations('.a { animation: turn 1s linear INFINITE; }'), ['animation: turn 1s linear INFINITE']);
  assert.deepEqual(endlessAnimations('.a {\n  animation:\n    turn 1s\n    infinite;\n}'), ['animation: turn 1s infinite']);
  assert.deepEqual(endlessAnimations('.a { Animation-Iteration-Count: infinite }'), ['Animation-Iteration-Count: infinite']);
  assert.deepEqual(endlessAnimations('.a { -webkit-animation: turn 1s infinite; }'), ['-webkit-animation: turn 1s infinite']);
  assert.deepEqual(endlessAnimations('@media (min-width: 1px) { .a { color: red; animation: turn 1s infinite } }'), ['animation: turn 1s infinite']);
  assert.deepEqual(endlessAnimations('.a { animation: turn 1s infinite!important; }'), ['animation: turn 1s infinite!important']);
  assert.deepEqual(endlessAnimations('.a { animation-iteration-count: INFINITE ! important }'), ['animation-iteration-count: INFINITE ! important']);
  // A selector, quoted text, a comment, an animation named after the word, and an animation that ends are not.
  assert.deepEqual(endlessAnimations('.infinite-scroll { overflow: auto; }\n/* animation: turn 1s infinite; */'), []);
  assert.deepEqual(endlessAnimations('a[title=" animation: infinite"] { color: red; }'), []);
  assert.deepEqual(endlessAnimations('.a { animation: infinite-scroll 1s linear; }'), []);
  assert.deepEqual(endlessAnimations('.a { animation: turn 1s 3; transition: opacity 0.2s; }'), []);
});

it('has no animation that runs without end', () => {
  const sheets = readdirSync(source, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.css'));
  assert.ok(sheets.length > 0);
  for (const sheet of sheets) assert.deepEqual(endlessAnimations(readFileSync(path.join(source, sheet), 'utf8')), [], `${sheet} animates without end`);
});
