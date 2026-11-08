import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const study = process.argv[2];
if (!study) throw new Error('Usage: node tools/check-golden-study.mjs <ct-small>');
const metadata = JSON.parse(await readFile(new URL('../tests/golden/ct-small.json', import.meta.url), 'utf8'));
const reference = await readFile(new URL('../tests/golden/ct-small.png', import.meta.url));
assert.equal(createHash('sha256').update(reference).digest('hex'), metadata.pngSha256, 'Golden PNG differs from the recorded reference');
const allowed = new Set(['S01', '.bench-study', 'manifest.json']);
assert((await readdir(study)).every(name => allowed.has(name)), 'Unexpected files in the synthetic study');
const series = path.join(study, 'S01');
assert((await lstat(series)).isDirectory(), 'S01 must be a real directory');
const files = (await readdir(series)).sort();
assert.equal(files.length, 100, 'Expected 100 generated CT slices');
const fingerprint = createHash('sha256');
for (const [index, name] of files.entries()) {
  assert.equal(name, `IM${String(index).padStart(5, '0')}.dcm`);
  const file = path.join(series, name);
  assert((await lstat(file)).isFile(), 'Expected regular fixture files');
  const digest = createHash('sha256').update(await readFile(file)).digest('hex');
  fingerprint.update(`S01/${name}\0${digest}\n`);
}
assert.equal(fingerprint.digest('hex'), metadata.studySha256, 'Study differs from the approved synthetic ct-small');
console.log(`PASS synthetic ct-small fingerprint ${metadata.studySha256}`);
