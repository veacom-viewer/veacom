import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { en } from '../src/i18n/en';
import { tr } from '../src/i18n/tr';
import { DEFAULT_LOCALE, LocalizedError, errorMessage, getLocale, isMessageKey, setLocale, t, translate } from '../src/i18n';
import { annotationSummary } from '../src/imaging/annotations';
import { assessmentSummary, diffusion, inferSequence, measureStudy, rank, word, type Candidate, type Patient } from '../src/domain/clinical';
import type { Annotation, Series, Volume } from '../src/model';

const require = createRequire(import.meta.url);
const main = require('../electron/i18n.cjs') as {
  messages: Record<'tr' | 'en', Record<string, string>>; DEFAULT_LOCALE: string;
  load: (directory: string) => string; getLocale: () => string; setLocale: (locale: string) => string; t: (key: string, params?: object) => string;
};
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
const directories: string[] = [];

afterEach(async () => {
  setLocale('en');
  main.setLocale('en');
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('interface dictionaries', () => {
  it('give every message in both languages with the same placeholders', () => {
    for (const [name, english, turkish] of [['renderer', en, tr], ['main process', main.messages.en, main.messages.tr]] as const) {
      assert.deepEqual(Object.keys(turkish).sort(), Object.keys(english).sort(), name);
      for (const key of Object.keys(english)) {
        const a = (english as Record<string, string>)[key], b = (turkish as Record<string, string>)[key];
        assert.ok(b.trim().length > 0, `${name} ${key}`);
        assert.deepEqual(placeholders(b), placeholders(a), `${name} ${key}`);
      }
    }
  });

  it('use VEAcom 1.2.1 wording for the controls 1.x had', () => {
    // From app/ui/main_window.py, interaction.py, viewport.py and app/diagnosis/*.py at v1.2.1.
    assert.equal(tr['toolbar.label'], 'Araçlar');
    assert.deepEqual([tr['preset.lung'], tr['preset.liver'], tr['preset.bone'], tr['preset.brain'], tr['preset.angiography']], ['Akciğer', 'Karaciğer', 'Kemik', 'Beyin', 'Anjiyo']);
    assert.equal(tr['toolbar.windowPresets'], 'Pencere ön ayarları');
    assert.equal(tr['toolbar.showReferences'], 'Kesişim çizgileri');
    assert.equal(tr['toolbar.hidePatientData'], 'Hasta bilgilerini gizle');
    assert.equal(tr['toolbar.exportMedia'], 'DICOMDIR olarak dışa aktar');
    assert.equal(tr['tool.window'], 'Pencere / Seviye (W/L)');
    assert.equal(tr['viewport.close'], 'Bu pencereyi kapat');
    assert.equal(tr['assessment.markLesion'], 'Lezyonu işaretle');
    assert.equal(tr['clinical.blocker.overlap'], 'Lezyon ve referans aynı yerde. Referansı lezyonun dışında, normal bir dokudan işaretle.');
  });

  it('start in Turkish and keep main-process and renderer defaults equal', () => {
    assert.equal(DEFAULT_LOCALE, 'tr');
    assert.equal(main.DEFAULT_LOCALE, 'tr');
  });
});

describe('renderer translation', () => {
  it('fills placeholders and switches language at run time', () => {
    setLocale('tr');
    assert.equal(getLocale(), 'tr');
    assert.equal(t('status.loadingSeries', { count: 3 }), '3 seri yükleniyor…');
    setLocale('en');
    assert.equal(t('status.loadingSeries', { count: 3 }), 'Loading 3 series…');
    assert.equal(translate('tr', 'status.ready'), 'Hazır');
  });

  it('re-translates errors that carry a message key', () => {
    setLocale('tr');
    const error = new LocalizedError('engine.sourceChanged');
    assert.equal(error.message, tr['engine.sourceChanged']);
    setLocale('en');
    assert.equal(errorMessage(error), en['engine.sourceChanged']);
    assert.equal(errorMessage(Object.assign(new Error('English'), { messageKey: 'video.chooseRange' })), en['video.chooseRange']);
    assert.equal(errorMessage(new Error('Plain')), 'Plain');
  });

  it('knows every key the standalone video exporter uses', async () => {
    // export-video.ts has no imports (a test loads it on its own), so its keys are checked here.
    const source = await readFile(new URL('../src/export-video.ts', import.meta.url), 'utf8');
    const keys = [...source.matchAll(/videoError\('([\w.]+)'/g)].map(match => match[1]);
    assert.ok(keys.length > 10);
    for (const key of keys) assert.equal(isMessageKey(key), true, key);
  });
});

const series = (overrides: Partial<Series> = {}): Series => ({
  id: 's', uid: 'u', studyUid: 'study', patientId: 'P', patientName: 'Synthetic', studyDate: '', description: '', modality: 'CT',
  seriesNumber: 1, dimensions: [4, 4, 2], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true, spacingKnown: true, orientationKnown: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2', ...overrides,
});
const volume = (overrides: Partial<Series> = {}): Volume => ({ series: series(overrides), data: new Float32Array(32).fill(12) });
const annotation = (type: Annotation['type'], points: Annotation['points']): Annotation => ({ id: type, type, points, plane: 'axial', slice: 0, mode: 'mpr' });

describe('Turkish measurement and assessment text', () => {
  it('describes measurements in Turkish without changing numbers or units', () => {
    setLocale('tr');
    assert.equal(annotationSummary(annotation('length', [[0, 0, 0], [3, 4, 0]]), volume()), '5.0 mm');
    assert.equal(annotationSummary(annotation('probe', [[40, 40, 0]]), volume()), 'Görüntünün dışında');
    assert.equal(annotationSummary(annotation('probe', [[1, 1, 0]]), volume({ valueUnit: '' })), '12.0 değer');
    assert.match(annotationSummary(annotation('rectangle', [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]]), volume()), /^MPR örnekleri \(enterpolasyonlu\) · 4\.0 mm² · ort\. 12\.0 HU/);
  });

  it('reads findings and diffusion in 1.x terms', () => {
    setLocale('tr');
    assert.equal(word('kisitli'), 'kısıtlı');
    assert.equal(word('kapsül'), 'kapsül');
    assert.deepEqual(diffusion(1.5, 0.7), { finding: 'kisitli', reason: 'DWI parlak, ADC düşük.' });
    assert.ok(inferSequence(series({ modality: 'MR', description: 'T1 kontrastsiz', repetitionTime: 500, echoTime: 10 })).basis.includes('kontrastsız'));
  });

  it('writes the second-opinion summary in Turkish with a lesion\'s Turkish name', () => {
    // A synthetic lesion: the knowledge base is kept outside the repository (src/domain/clinical.ts).
    const lesion: Candidate = { id: 'synthetic', name: 'Sentetik kist', englishName: 'Synthetic cyst', expected: { t2: ['hiper'] }, page: null,
      differential: [], cautions: [], ct: '', finding: '', profile: null, source: null, patient: null, frequency: 'sik' };
    const patient: Patient = { age: 43, sex: 'K' };
    const measurement = measureStudy([], [], {});
    const summary = () => assessmentSummary({ region: '', patient, findings: { t2: 'hiper' }, measurement, ranked: rank({ t2: 'hiper' }, [lesion], patient).ranked, note: '' });
    setLocale('tr');
    const text = summary();
    assert.ok(text.includes('Bölge: Tüm bölgeler'));
    assert.ok(text.includes('Hasta: 40–44 yaş; cinsiyet: kadın.'));
    assert.ok(text.includes('T2: hiper [ölçülen]'));
    assert.ok(text.includes('Uygulamanın sıralaması (uyum / 100):'));
    assert.ok(text.includes('Sentetik kist: '));
    setLocale('en');
    const english = summary();
    assert.ok(english.includes('Region: All regions'));
    assert.ok(english.includes('Age band: 40–44 years; sex: female.'));
    assert.ok(english.includes('T2 signal: high [measured]'));
    assert.ok(english.includes('Synthetic cyst: '));
  });
});

describe('main-process language setting', () => {
  it('defaults to Turkish, remembers the user\'s choice and yields to VEACOM_LOCALE', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'veacom-locale-'));
    directories.push(directory);
    const previous = process.env.VEACOM_LOCALE;
    try {
      delete process.env.VEACOM_LOCALE;
      assert.equal(main.load(directory), 'tr');
      assert.equal(main.t('startup.failed'), 'VEAcom başlatılamadı');
      main.setLocale('en');
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8')), { locale: 'en' });
      main.setLocale('tr');
      assert.equal(main.load(directory), 'tr');
      await writeFile(path.join(directory, 'preferences.json'), JSON.stringify({ locale: 'en', other: 1 }));
      assert.equal(main.load(directory), 'en');
      main.setLocale('tr');
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8')), { locale: 'tr', other: 1 });
      process.env.VEACOM_LOCALE = 'en';
      assert.equal(main.load(directory), 'en');
      assert.throws(() => main.setLocale('de'));
    } finally { process.env.VEACOM_LOCALE = previous; }
  });
});
