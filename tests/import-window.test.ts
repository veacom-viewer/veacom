// The import window runs where the application page cannot reach it (electron/import-view.cjs). That only holds if
// its own code cannot be changed by a package: everything it loads must be this repository's own source. The build
// checks the same of its chunks (vite.config.ts); this finds it sooner, from the sources.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SPECIFIERS = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const SOURCE = path.join(root, 'src') + path.sep;

function resolve(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier);
  const found = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`${path.relative(root, from)}: cannot resolve ${specifier}`);
  return found;
}

function loaded(entry: string): { files: Set<string>; packages: string[] } {
  const files = new Set<string>(), packages: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    // Only this repository's own sources, and no TSX, where the React plugin adds its runtime without an import line.
    if (!file.startsWith(SOURCE) || file.endsWith('.tsx')) packages.push(path.relative(root, file));
    const source = readFileSync(file, 'utf8');
    if (file.endsWith('.css')) {
      for (const [, url] of source.matchAll(/@import\s+(?:url\()?['"]?([^'")\s;]+)/g)) packages.push(`${path.relative(root, file)} -> ${url}`);
      return;
    }
    if (file.endsWith('.json')) return;
    for (const [statement, specifier] of source.matchAll(SPECIFIERS)) {
      if (/^(?:import|export)\s+type\s/.test(statement)) continue;
      if (!specifier.startsWith('.')) { packages.push(`${path.relative(root, file)} -> ${specifier}`); continue; }
      visit(resolve(file, specifier));
    }
    // A dynamic import or require of anything but a plain relative path cannot be followed: it is refused.
    for (const [call] of source.matchAll(/\b(?:import|require)\s*\([^)]*\)?/g)) {
      const relative = /^import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)$/.exec(call);
      if (relative) visit(resolve(file, relative[1])); else packages.push(`${path.relative(root, file)} -> ${call}`);
    }
  };
  visit(entry);
  return { files, packages };
}

describe('import window', () => {
  it('loads first-party code only', () => {
    const html = readFileSync(path.join(root, 'import.html'), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(scripts, ['/src/import-window/main.ts']);
    const { files, packages } = loaded(path.join(root, 'src/import-window/main.ts'));
    assert.deepEqual(packages, []);
    assert.ok([...files].map(file => path.relative(root, file).split(path.sep).join('/')).includes('src/i18n/index.ts'));
  });

  it('has no bridge in the application page', () => {
    const preload = readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
    for (const channel of ['importview:', 'files:browse', 'files:choose', 'files:places']) assert.ok(!preload.includes(channel));
  });
});
