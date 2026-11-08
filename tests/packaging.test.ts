import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { it } from 'node:test';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const json = (file: string) => JSON.parse(read(file));
const policy = (file: string) => read(file).split('\n')
  .filter(line => /^(minimumReleaseAge|minimumReleaseAgeIgnoreMissingTime|trustPolicy|blockExoticSubdeps|strictDepBuilds): /.test(line));

// electron-builder installs apart from the root, in packaging/, so the root install never fetches its tree.
it('keeps electron-builder in its own install, with the pnpm and supply-chain policy of the root', () => {
  const root = json('package.json'), packaging = json('packaging/package.json');
  assert.ok(!Object.keys({ ...root.dependencies, ...root.devDependencies }).includes('electron-builder'));
  assert.match(packaging.devDependencies['electron-builder'], /^\d+\.\d+\.\d+$/);
  // Without the same packageManager, a laptop's global pnpm would install packaging/ and misread its lockfile.
  assert.equal(packaging.packageManager, root.packageManager);
  // packaging/ is a workspace of its own and inherits none of the root's settings.
  assert.equal(policy('pnpm-workspace.yaml').length, 5);
  assert.deepEqual(policy('packaging/pnpm-workspace.yaml'), policy('pnpm-workspace.yaml'));
});
