// Motion in the interface is brief and has a reason (docs/design-guidelines.md, "Motion with a reason"): nothing
// animates without end. An endless animation also makes the app draw a frame at every screen refresh for as long as
// it shows, which a slow PC pays for exactly while it loads a study.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '../src');

it('has no animation that runs without end', () => {
  const sheets = readdirSync(source, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.css'));
  assert.ok(sheets.length > 0);
  for (const sheet of sheets) {
    // CSS keywords are read in any case.
    const endless = readFileSync(path.join(source, sheet), 'utf8').split('\n').filter(line => /\binfinite\b/i.test(line));
    assert.deepEqual(endless, [], `${sheet} animates without end`);
  }
});
