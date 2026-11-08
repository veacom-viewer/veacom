import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import messages from '../electron/core-messages.json';
import { setLocale } from '../src/i18n';
import { coreErrorText, coreText, warningTexts, type CoreNote } from '../src/i18n/core';

const require = createRequire(import.meta.url);
const main = require('../electron/i18n.cjs') as { setLocale: (locale: string) => void; coreText: (note: CoreNote) => string; coreErrorText: (body: string) => string };
const placeholders = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]));

// Every coded message the engine can send, read from its source: note!("code", "English template", …).
const engine = new Map<string, string>();
const sources = new URL('../native/src/', import.meta.url);
for (const file of readdirSync(sources).filter(name => name.endsWith('.rs') && name !== 'message.rs')) {
  const text = readFileSync(new URL(file, sources), 'utf8');
  for (const [, code, template] of text.matchAll(/(?:note|coded)!\(\s*"([\w.]+)",\s*"((?:[^"\\]|\\.)*)"/g)) {
    assert.equal(engine.get(code) ?? template, template, `${code} has one English template`);
    engine.set(code, template);
  }
}

afterEach(() => { setLocale('en'); main.setLocale('en'); });

describe('engine message translations', () => {
  it('cover every coded engine message and nothing else, with the engine\'s placeholders', () => {
    assert.ok(engine.size > 50);
    assert.deepEqual(Object.keys(messages.tr).sort(), [...engine.keys()].sort());
    for (const [code, template] of Object.entries(messages.tr)) {
      const allowed = placeholders(engine.get(code)!);
      for (const name of placeholders(template)) assert.equal(allowed.has(name), true, `${code} uses {${name}}`);
    }
  });

  const reason: CoreNote = { code: 'file.notDicom', text: 'Missing DICOM file meta marker' };
  const unreadable: CoreNote = { code: 'import.fileUnreadable', params: { file: 'notes.txt', reason }, text: 'notes.txt: Missing DICOM file meta marker' };
  const plain: CoreNote = { code: 'import.fileUnreadable', params: { file: 'a.dcm', reason: 'Basic Offset Table does not match' }, text: 'a.dcm: Basic Offset Table does not match' };
  const none: CoreNote = { code: 'import.noImages', params: { details: [unreadable, plain] }, text: 'No supported images were found. notes.txt: Missing DICOM file meta marker; a.dcm: Basic Offset Table does not match' };

  it('translate nested messages and keep uncoded detail in English', () => {
    setLocale('tr');
    assert.equal(coreText(none), 'Desteklenen görüntü bulunamadı. notes.txt okunamadı: DICOM dosyası değil (DICOM başlığı yok); a.dcm okunamadı: Basic Offset Table does not match');
    assert.equal(coreText(reason), 'DICOM dosyası değil (DICOM başlığı yok)');
    assert.equal(coreText({ code: 'file.missing', params: { detail: 'No such file or directory (os error 2)' }, text: 'No such file or directory (os error 2)' }), 'Dosya artık yerinde değil; CD, DVD ya da USB bellek çıkarılmış olabilir');
    assert.equal(coreText({ code: 'unknown.code', text: 'From a newer engine' }), 'From a newer engine');
    assert.equal(coreText({ text: 'Uncoded' }), 'Uncoded');
    setLocale('en');
    assert.equal(coreText(none), none.text);
  });

  it('show warnings translated, then plain ones a client added, and fall back for older engines', () => {
    setLocale('tr');
    const irregular: CoreNote = { code: 'geometry.irregular', text: 'Irregular slice positions or missing slices; reconstruction is disabled instead of filling the gaps.' };
    assert.deepEqual(warningTexts({ warnings: [irregular.text, 'Added by the main process'], warningNotes: [irregular] }), ['Kesit konumları düzensiz ya da eksik kesit var; boşluklar doldurulmadı, hacim oluşturulamaz.', 'Added by the main process']);
    assert.deepEqual(warningTexts({ warnings: ['Old engine text'] }), ['Old engine text']);
    assert.deepEqual(warningTexts({ warnings: ['Short'], warningNotes: [irregular, irregular] }), ['Short']);
  });

  it('read error bodies the same way in the renderer and the main process', () => {
    const body = JSON.stringify({ error: none.text, note: none });
    for (const locale of ['tr', 'en'] as const) {
      setLocale(locale); main.setLocale(locale);
      assert.equal(main.coreErrorText(body), coreErrorText(body));
      assert.equal(main.coreText(unreadable), coreText(unreadable));
    }
    assert.equal(coreErrorText(JSON.stringify({ error: 'Plain' })), 'Plain');
    assert.equal(coreErrorText('Not JSON'), 'Not JSON');
  });
});
