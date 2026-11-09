import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';
import { assertFields } from './support';

const root = fileURLToPath(new URL('..', import.meta.url));
const { decodePng, encodePng } = createRequire(import.meta.url)('../tools/lib/png.cjs');
const { closeDesktop } = createRequire(import.meta.url)('../tools/lib/close-desktop.cjs');
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'veacom-gate-test-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const node = (script: string, args: string[], cwd = root) =>
  spawnSync(process.execPath, [path.join(root, script), ...args], { cwd, encoding: 'utf8', timeout: 10000 });

it('rejects React memoization APIs in JS and TSX while allowing unrelated names and types', async () => {
  const config = path.join(dir, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: { allowJs: true, moduleResolution: 'bundler', module: 'esnext', jsx: 'react-jsx',
    paths: { react: [createRequire(import.meta.url).resolve('@types/react/package.json').replace(/package\.json$/, 'index.d.ts')] } }, include: ['*.jsx', '*.tsx'] }));
  await writeFile(path.join(dir, 'allowed.tsx'), [
    "import React, { useState, type memo as MemoType } from 'react';",
    "import type { useCallback } from 'react';",
    'type Memo = typeof React.useMemo;',
    "const text = 'React.memo and useCallback'; // import { useMemo } from 'react'",
    'const memo = (n: number) => n;',
    'function shadow(React: { memo: typeof memo }) { return React.memo(1); }',
    'export const Example = () => <div>{useState(1)[0]}</div>;',
  ].join('\n'));
  const check = () => node('tools/check-react-memo.mjs', [config]);
  const allowed = check();
  assert.equal(allowed.status, 0, allowed.stderr);

  await writeFile(path.join(dir, 'hooks.tsx'), [
    "import { useCallback as keep } from 'react';",
    "export { useMemo as cache } from 'react';",
    "import Default from 'react'; import * as R from 'react';",
    'const wrap = Default.memo;',
    'const { useCallback } = R;',
    "const key = 'useMemo' as const; const cacheByKey = R[key];",
    "const namespace = R; const wrapped = namespace['memo'];",
    "import { memo, useMemo } from 'react';",
  ].join('\n'));
  await writeFile(path.join(dir, 'view.jsx'), [
    "const { useMemo: compute } = require('react');",
    "async function render() { return (await import('react')).memo; }",
  ].join('\n'));
  const rejected = check();
  assert.equal(rejected.status, 1, rejected.stderr);
  const reports = [...rejected.stderr.matchAll(/(\w+\.[jt]sx):([0-9]+):[0-9]+ React\.(\w+)/g)].map(([, file, line, api]) => `${file}:${line} ${api}`);
  assert.deepEqual(reports.sort(), ['hooks.tsx:1 useCallback', 'hooks.tsx:2 useMemo', 'hooks.tsx:4 memo', 'hooks.tsx:5 useCallback',
    'hooks.tsx:6 useMemo', 'hooks.tsx:7 memo', 'hooks.tsx:8 memo', 'hooks.tsx:8 useMemo', 'view.jsx:1 useMemo', 'view.jsx:2 memo']);
});

it('the PNG diff CLI exits unsuccessfully for a one-level change', async () => {
  const golden = path.join(root, 'tests/golden/ct-small.png'), other = path.join(dir, 'changed.png');
  const changed = decodePng(await readFile(golden)); changed.data[0] ^= 1;
  await writeFile(other, encodePng(changed));
  const result = node('tools/diff-png.mjs', [golden, other]);
  assert.equal(result.status, 1);
  assertFields(JSON.parse(result.stdout), { passed: false, differingPixels: 1, maxChannelDifference: 1 });
});

it('rejects medical images, archives and the telemetry credential file in Git', async () => {
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  await writeFile(path.join(dir, 'readme.txt'), 'synthetic test');
  assert.equal(spawnSync('git', ['add', 'readme.txt'], { cwd: dir }).status, 0);
  assert.equal(node('tools/check-repository.mjs', [], dir).status, 0);
  const fakeDicom = Buffer.alloc(132); fakeDicom.write('DICM', 128);
  await mkdir(path.join(dir, 'electron'));
  const bad: [string, Buffer][] = [['scan.bin', fakeDicom], ['archive.bin', Buffer.from('504b0304', 'hex')],
    ['DICOMDIR', Buffer.alloc(0)], ['scan.ima', Buffer.alloc(0)], ['scan.dicom', Buffer.alloc(0)],
    ['electron/telemetry-endpoint.json', Buffer.from('{}')]];
  for (const [name, bytes] of bad) await writeFile(path.join(dir, name), bytes);
  assert.equal(spawnSync('git', ['add', '-f', '--', ...bad.map(([name]) => name)], { cwd: dir }).status, 0);
  const result = node('tools/check-repository.mjs', [], dir);
  assert.equal(result.status, 1);
  for (const [name] of bad) assert.ok(result.stderr.includes(name));
});

it('rejects committed editor hooks, unlisted dependency names and crates from outside crates.io', async () => {
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  const check = () => node('tools/check-repository.mjs', [], dir);
  const crate = (name: string, source?: string) => `[[package]]\nname = "${name}"\nversion = "1.0.0"\n${source ? `source = "${source}"\n` : ''}`;
  const pnpmLock = (names: string[]) => `lockfileVersion: '9.0'\n\npackages:\n\n${names.map(name => `  '${name}@1.0.0':\n    resolution: {integrity: sha512-x}\n`).join('\n')}\nsnapshots:\n\n${names.map(name => `  '${name}@1.0.0': {}\n`).join('\n')}`;
  const cratesIo = 'registry+https://github.com/rust-lang/crates.io-index';
  git('init', '-q');
  await mkdir(path.join(dir, 'tools'));
  await writeFile(path.join(dir, 'pnpm-lock.yaml'), pnpmLock(['left-pad', '@scope/pkg']));
  await writeFile(path.join(dir, 'Cargo.lock'), `version = 4\n\n${crate('app')}\n${crate('serde', cratesIo)}`);
  await writeFile(path.join(dir, 'tools/dependency-names.txt'), '# names\nnpm left-pad\nnpm @scope/pkg\ncrate serde\n');
  git('add', '.');
  assert.equal(check().status, 0);

  await writeFile(path.join(dir, 'pnpm-lock.yaml'), pnpmLock(['left-pad', '@scope/pkg', 'plain-crypto-js']));
  let result = check();
  assert.equal(result.status, 1); assert.ok(result.stderr.includes('npm plain-crypto-js'));

  await writeFile(path.join(dir, 'pnpm-lock.yaml'), pnpmLock(['left-pad']));
  result = check();
  assert.equal(result.status, 1); assert.ok(result.stderr.includes('delete their lines')); assert.ok(result.stderr.includes('npm @scope/pkg'));

  await writeFile(path.join(dir, 'pnpm-lock.yaml'), pnpmLock(['left-pad', '@scope/pkg']));
  await writeFile(path.join(dir, 'Cargo.lock'), `version = 4\n\n${crate('serde', 'git+https://example.com/serde#abc')}`);
  result = check();
  assert.equal(result.status, 1); assert.ok(result.stderr.includes('Crates must come from crates.io'));

  await writeFile(path.join(dir, 'Cargo.lock'), `version = 4\n\n${crate('serde', cratesIo)}`);
  const hooks = ['.claude/settings.json', '.vscode/tasks.json', 'native/.vscode/tasks.json', '.mcp.json'];
  for (const file of hooks) { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), '{}'); }
  git('add', '-f', '--', ...hooks);
  result = check();
  assert.equal(result.status, 1);
  for (const file of hooks) assert.ok(result.stderr.includes(file));
});

it('counts a check as started when something runs it, not when only a comment names it', async () => {
  const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0);
  const check = () => node('tools/check-repository.mjs', [], dir);
  git('init', '-q');
  await mkdir(path.join(dir, '.github/workflows'), { recursive: true });
  await mkdir(path.join(dir, 'tools'));
  await writeFile(path.join(dir, 'tools/check-new.cjs'), "console.log('checked');\n");
  await writeFile(path.join(dir, 'tools/other.mjs'), '// check-new.cjs runs in CI.\n/* see check-new.cjs */\nexport {};\n');
  await writeFile(path.join(dir, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    steps:\n      # tools/check-new.cjs\n      - run: echo hello\n');
  await writeFile(path.join(dir, 'tools/run.sh'), 'echo ready;# tools/check-new.cjs\necho \\" # tools/check-new.cjs\n');
  git('add', '.');
  let result = check();
  assert.equal(result.status, 1); assert.ok(result.stderr.includes('Nothing starts these checks')); assert.ok(result.stderr.includes('tools/check-new.cjs'));
  // A # or // inside quotes is no comment: the command after it still counts.
  await writeFile(path.join(dir, 'tools/run.sh'), 'echo "ticket #42"; node tools/check-new.cjs\n');
  git('add', '.');
  result = check();
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(dir, 'tools/run.sh'), "echo 'see https://example.com/#top'\n");
  await writeFile(path.join(dir, 'tools/other.mjs'), "const url = 'https://example.com/a'; spawn('node', ['tools/check-new.cjs']);\n");
  result = check();
  assert.equal(result.status, 0, result.stderr);
  await writeFile(path.join(dir, 'tools/other.mjs'), 'export {};\n');
  await writeFile(path.join(dir, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    steps:\n      - run: node tools/check-new.cjs # the new check\n');
  result = check();
  assert.equal(result.status, 0, result.stderr);
});

it('the local gate stops before app launch when a study has the right names but wrong bytes', { skip: process.platform === 'win32' }, async () => {
  const study = path.join(dir, 'study'), series = path.join(study, 'S01'), bin = path.join(dir, 'bin');
  await mkdir(series, { recursive: true }); await mkdir(bin);
  await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(path.join(series, `IM${String(i).padStart(5, '0')}.dcm`), 'synthetic wrong input')));
  const rejected = node('tools/check-golden-study.mjs', [study]);
  assert.equal(rejected.status, 1); assert.ok(rejected.stderr.includes('Study differs from the approved synthetic ct-small'));
  const stop = 'echo unexpected >> "$UNEXPECTED_COMMAND"\nexit 99\n';
  await writeFile(path.join(bin, 'node'), '#!/bin/sh\ncase "$1" in tools/check-repository.mjs|tools/check-golden-study.mjs) exec "$REAL_NODE" "$@";; esac\n' + stop, { mode: 0o755 });
  for (const name of ['pnpm', 'cargo']) await writeFile(path.join(bin, name), '#!/bin/sh\n' + stop, { mode: 0o755 });
  const unexpected = path.join(dir, 'unexpected');
  const run = spawnSync('bash', ['tools/verify.sh', study, path.join(dir, 'evidence')], { cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, REAL_NODE: process.execPath, UNEXPECTED_COMMAND: unexpected } });
  assert.equal(run.status, 1); assert.ok(run.stderr.includes('FAIL fixture')); assert.equal(existsSync(unexpected), false);
});

it('closes a desktop app that quits, and kills one that does not with what it started, without throwing', async () => {
  let closes = 0;
  assert.equal(await closeDesktop({ close: async () => { closes++; }, process: () => ({ exitCode: 0, signalCode: null }) }, 1000), true);
  assert.equal(closes, 1);
  assert.equal(await closeDesktop(undefined), true);
  // close() fails, but the app quits by itself in time: nothing is killed.
  const quitting = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore' });
  assert.equal(await closeDesktop({ close: async () => { throw new Error('Target closed'); }, process: () => quitting }, 5000), true);
  assert.deepEqual([quitting.exitCode, quitting.signalCode], [0, null]);
  // An app that never quits, with a child of its own as the imaging engine. Playwright starts the app as the leader of a
  // process group of its own, except on Windows.
  const engineScript = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })";
  const app = spawn(process.execPath, ['-e', `console.log(${engineScript}.pid); setInterval(() => {}, 1000);`],
    { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
  const engine = Number(String((await once(app.stdout, 'data') as [Buffer])[0]).trim());
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const { exitCode } = process, { error } = console, said: string[] = [];
  console.error = (...args: unknown[]) => { said.push(args.join(' ')); };
  const started = Date.now();
  let quit: boolean, marked: typeof process.exitCode;
  try {
    quit = await closeDesktop({ close: () => new Promise(() => {}), process: () => app }, 300);
    marked = process.exitCode;
  } finally { console.error = error; process.exitCode = exitCode; }
  const elapsed = Date.now() - started;
  for (const until = Date.now() + 3000; alive(engine) && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 50));
  const survivors = [app.pid!, engine].filter(alive);
  for (const pid of survivors) process.kill(pid, 'SIGKILL');
  assert.deepEqual(survivors, [], 'the app and its engine are gone');
  assert.equal(quit, false); assert.equal(marked, 1);
  assert.ok(elapsed < 4000, `closed after ${elapsed} ms`);
  assert.match(said.join('\n'), /did not quit within 0.3 s/);
});
