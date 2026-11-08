import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// An undefined custom property makes a declaration invalid at computed-value time, so a renamed token
// silently turns a panel transparent (the assessment panel did once). Every var(--x) must be defined.
const root = path.resolve(import.meta.dirname, '../src');
const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.(css|tsx?)$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
// Set inline by React: the viewport grid (App.tsx) and a segmentation's colour (SeriesBrowser.tsx).
const runtime = new Set(['--grid-rows', '--grid-columns', '--segment-color']);

describe('style tokens', () => {
  it('defines every custom property the interface uses', () => {
    const sources = files(root).map(file => [file, readFileSync(file, 'utf8')] as const);
    const defined = new Set(sources.flatMap(([, text]) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1])));
    const missing = sources.flatMap(([file, text]) => [...text.matchAll(/var\((--[\w-]+)/g)]
      .map(match => match[1]).filter(name => !defined.has(name) && !runtime.has(name)).map(name => `${path.relative(root, file)}: ${name}`));
    assert.deepEqual([...new Set(missing)], []);
  });
});
