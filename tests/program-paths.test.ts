// VEAcom starts a few of the system's own programs (PowerShell, hdiutil, codesign). Each is named by its full path, so
// the one that runs is the system's, whatever folder VEAcom was started in.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const electron = path.resolve(import.meta.dirname, '../electron');

it('starts every program by its full path', () => {
  const started: string[] = [];
  for (const name of readdirSync(electron).filter(file => file.endsWith('.cjs'))) {
    const source = readFileSync(path.join(electron, name), 'utf8');
    // The first argument of a call that starts a program, where it is written out as text. Not a method of the same
    // name (a pattern's exec, the engine manager's launch).
    for (const [, program] of source.matchAll(/(?<![.\w])(?:spawn|execFile|execute|exec|launch)\(\s*['"`]([^'"`]+)['"`]/g)) {
      started.push(program);
      assert.match(program, /^\//, `${name} starts ${program} by its name alone`);
    }
  }
  // The pattern still finds the calls it is there to check.
  assert.ok(started.includes('/usr/bin/hdiutil'));
});
