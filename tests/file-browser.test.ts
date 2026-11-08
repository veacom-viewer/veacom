import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { browse, chosenPaths, localPath } = require('../electron/file-browser.cjs');

const windows = (value: string, places: string[] = []) => localPath(value, { places, paths: path.win32, platform: 'win32' });
const mac = (value: string) => localPath(value, { platform: 'darwin', paths: path.posix });

describe('import window paths', () => {
  it('takes local absolute paths, resolved', () => {
    assert.equal(windows('C:\\Studies\\..\\CD'), 'C:\\CD');
    assert.equal(windows('d:/DICOM'), 'd:\\DICOM');
    assert.equal(mac('/Volumes/CD/../CD/DICOM'), '/Volumes/CD/DICOM');
    assert.equal(mac('/Users/ayse/network'), '/Users/ayse/network');
  });

  it('refuses relative paths and other values', () => {
    for (const value of ['DICOM', 'C:DICOM', '', 42, null]) assert.throws(() => windows(value as string), { message: /Invalid folder\./ });
    assert.throws(() => mac('DICOM'), { message: /Invalid folder\./ });
  });

  it('refuses network shares and device paths, which would connect to the host they name', () => {
    for (const value of ['\\\\attacker\\share', '//attacker/share', '\\\\attacker\\share\\..\\..\\x', '\\\\?\\C:\\Studies', '\\\\?\\UNC\\attacker\\share', '\\\\.\\PhysicalDrive0', '//./pipe/x']) {
      assert.throws(() => windows(value), { message: /Invalid folder\./ }, value);
    }
    for (const value of ['/net/attacker', '/net/attacker/export', '/net', '/NET/attacker', '/Net/attacker']) assert.throws(() => mac(value), { message: /Invalid folder\./ }, value);
  });

  it('takes a network folder inside a usual place, as Windows keeps them for redirected folders', () => {
    const documents = '\\\\files\\home$\\ayse\\Documents';
    assert.equal(windows('\\\\FILES\\home$\\ayse\\documents\\CD', [documents]), '\\\\FILES\\home$\\ayse\\documents\\CD');
    assert.equal(windows(documents, [documents]), documents);
    assert.equal(windows(`${documents}\\..x`, [documents]), `${documents}\\..x`);
    for (const value of ['\\\\files\\home$\\ayse', `${documents}\\..\\Private`, '\\\\attacker\\home$\\ayse\\Documents']) {
      assert.throws(() => windows(value, [documents]), { message: /Invalid folder\./ }, value);
    }
    assert.throws(() => windows('\\\\?\\UNC\\files\\home$\\ayse\\Documents', [documents]), { message: /Invalid folder\./ });
  });

  it('lists no network folder', async () => {
    const network = process.platform === 'win32' ? '\\\\127.0.0.1\\share' : process.platform === 'darwin' ? '/NET/127.0.0.1' : 'share';
    await assert.rejects(browse(network), { message: /Invalid folder\./ });
  });

  it('opens up to 4096 local paths, resolved and without repeats', () => {
    const study = path.resolve('/studies/ct'), other = path.resolve('/studies/mr');
    assert.deepEqual(chosenPaths([study, `${other}/../mr`, study]), [study, other]);
    const network = process.platform === 'win32' ? '\\\\attacker\\share' : process.platform === 'darwin' ? '/net/attacker' : 'relative';
    for (const paths of [[], 'C:\\', [study, network], [study, 'relative'], Array(4097).fill(study)]) assert.throws(() => chosenPaths(paths as string[]), { message: /^Invalid / });
  });
});
