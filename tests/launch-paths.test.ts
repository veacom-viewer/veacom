import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';

interface Options { packaged?: boolean; cwd?: string; isFile?: (file: string) => boolean }
const require = createRequire(import.meta.url);
const { launchPaths } = require('../electron/launch-paths.cjs') as { launchPaths: (argv: unknown, options?: Options) => string[] };

const cwd = path.resolve('launch-folder');
const at = (...parts: string[]) => path.resolve(cwd, ...parts);

describe('the paths a launch names', () => {
  it('reads --study in a source run and in an installed app, from the launch\'s own folder', () => {
    assert.deepEqual(launchPaths(['electron', '.', '--study', 'ct'], { cwd }), [at('ct')]);
    assert.deepEqual(launchPaths(['VEAcom.exe', '--study', at('disc')], { packaged: true, cwd }), [at('disc')]);
    assert.deepEqual(launchPaths(['VEAcom.exe', '--allow-file-access', '--study', 'a b', '--original-process-start-time=1'], { packaged: true, cwd }), [at('a b')]);
  });

  it('takes no study from a flag without a value', () => {
    assert.deepEqual(launchPaths(['electron', '.', '--study'], { cwd }), []);
    assert.deepEqual(launchPaths(['electron', '.', '--study', '--other'], { cwd }), []);
  });

  it('reads bare arguments as paths only in an installed app', () => {
    assert.deepEqual(launchPaths(['electron', '.', 'ct'], { cwd }), []);
    assert.deepEqual(launchPaths(['VEAcom.exe', 'one.dcm', '--switch', at('two.dcm'), 'one.dcm', ''], { packaged: true, cwd }), [at('one.dcm'), at('two.dcm')]);
    assert.deepEqual(launchPaths(['VEAcom.exe'], { packaged: true, cwd }), []);
  });

  it('opens the folder of a DICOMDIR file, and a folder of that name as it is', () => {
    const file = at('disc', 'DICOMDIR');
    assert.deepEqual(launchPaths(['VEAcom.exe', '--study', file], { packaged: true, cwd, isFile: given => given === file }), [at('disc')]);
    assert.deepEqual(launchPaths(['VEAcom.exe', at('disc', 'dicomdir')], { packaged: true, cwd, isFile: () => true }), [at('disc')]);
    assert.deepEqual(launchPaths(['VEAcom.exe', '--study', file], { packaged: true, cwd, isFile: () => false }), [file]);
  });

  it('mends a quoted drive and strips stray quotes', { skip: process.platform !== 'win32' }, () => {
    assert.deepEqual(launchPaths(['VEAcom.exe', '--study', 'E:"'], { packaged: true, cwd }), ['E:\\']);
    assert.deepEqual(launchPaths(['VEAcom.exe', '--study', 'E:\\.'], { packaged: true, cwd }), ['E:\\']);
    assert.deepEqual(launchPaths(['VEAcom.exe', '"C:\\studies\\ct"'], { packaged: true, cwd }), ['C:\\studies\\ct']);
  });

  it('reads a path with a drive and no folder from the launch\'s folder on that drive, or from the drive\'s root', { skip: process.platform !== 'win32' }, () => {
    assert.deepEqual(launchPaths(['VEAcom.exe', '--study', 'C:scan'], { packaged: true, cwd: 'C:\\studies' }), ['C:\\studies\\scan']);
    // The launch's folder is on another drive. This process has a folder of its own on its drive, which is not the
    // launch's: the path is not read from there.
    const own = process.cwd().slice(0, 2).toUpperCase(), other = own === 'Q:' ? 'R:' : 'Q:';
    assert.match(own, /^[A-Z]:$/);
    assert.deepEqual(launchPaths(['VEAcom.exe', '--study', `${own}scan`], { packaged: true, cwd: `${other}\\studies` }), [`${own}\\scan`]);
    assert.deepEqual(launchPaths(['VEAcom.exe', `${own}`], { packaged: true, cwd: `${other}\\studies` }), [`${own}\\`]);
  });

  it('ignores anything that is not a list of strings', () => {
    assert.deepEqual(launchPaths(undefined, { packaged: true, cwd }), []);
    assert.deepEqual(launchPaths(['VEAcom.exe', 7, null, 'ct'], { packaged: true, cwd }), [at('ct')]);
  });
});
