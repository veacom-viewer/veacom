import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_LOCALE, setLocale } from '../src/i18n';
import { filesText } from '../src/import-window/filesText';

describe('the import window\'s count of a folder\'s files', () => {
  afterEach(() => setLocale(DEFAULT_LOCALE));

  it('says one file in the singular in English, and any other count in the plural', () => {
    setLocale('en');
    assert.equal(filesText(1, false), '1 file');
    assert.equal(filesText(1, true), '1 file · has a DICOMDIR');
    assert.equal(filesText(0, false), '0 files');
    assert.equal(filesText(2, false), '2 files');
    assert.equal(filesText(1594, true), '1594 files · has a DICOMDIR');
  });

  it('says every count the one way in Turkish', () => {
    setLocale('tr');
    assert.equal(filesText(1, false), '1 dosya');
    assert.equal(filesText(1, true), '1 dosya · DICOMDIR var');
    assert.equal(filesText(2, false), '2 dosya');
    assert.equal(filesText(2, true), '2 dosya · DICOMDIR var');
  });
});
