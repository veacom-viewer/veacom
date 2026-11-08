import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Annotation, PetAcquisition, Series, Vec3, Volume } from '../src/model';
import type { LesionValues } from '../src/domain/petStudies';
import type { PriorLesions } from '../src/imaging/priorLesions';
import { deauvilleReading } from '../src/imaging/deauvilleReading';
import { percentText } from '../src/imaging/lesions';
import { compared, type PetPrior } from '../src/imaging/petComparison';
import { petReport, petReportText, type PetReportInput } from '../src/imaging/petReport';

// A synthetic FDG PET whose every value is known, in SUVbw: background 1, a lesion of 8 within 10 mm of (40, 40, 40), the
// liver at 2 and the blood pool at 1.5. Its stored values are Bq/ml, 2 per SUVbw (and 1.6 per SUL).
const center = (value: number): Vec3 => [value, value, value];
const at = ([x, y, z]: Vec3) => (z / 2 * 40 + y / 2) * 40 + x / 2;
const regions: Array<{ at: Vec3; radius: number; suv: number }> = [
  { at: center(40), radius: 10, suv: 8 }, { at: [20, 20, 62], radius: 18, suv: 2 }, { at: [62, 62, 20], radius: 10, suv: 1.5 },
];
const data = new Float32Array(40 * 40 * 40);
for (let z = 0; z < 40; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
  const region = regions.find(({ at: from, radius }) => Math.hypot(x * 2 - from[0], y * 2 - from[1], z * 2 - from[2]) <= radius);
  data[(z * 40 + y) * 40 + x] = (region?.suv ?? 1) / 0.5;
}
const acquisition: PetAcquisition = {
  tracer: 'Fludeoxyglucose F^18^', injectedActivity: 350e6, injectionTime: '090000', scanStart: '20000101100000', uptakeSeconds: 3600,
  weight: 80, height: 1.8, glucose: 5.4, scannerModel: 'SYNTHETIC PET 2', reconstruction: 'OSEM TOF PSF 4i5s',
};
const pet: Series = {
  id: 'pet', uid: '1', studyUid: '2', patientId: 'TEST', patientName: 'Synthetic', studyDate: '20000101', description: 'Synthetic PET',
  modality: 'PT', patientSex: 'M', petAcquisition: acquisition, seriesNumber: 1, dimensions: [40, 40, 40], spacing: [2, 2, 2], origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 5, windowWidth: 10, valueUnit: 'Bq/ml', suvFactor: 0.5, sulFactor: 0.625,
  canReconstruct: true, spacingKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
};
const sphere = (id: string, from: Vec3, radius: number, extra: Partial<Annotation> = {}): Annotation =>
  ({ id, type: 'sphere', points: [from, [from[0] + radius, from[1], from[2]]], plane: 'axial', slice: 0, mode: 'mpr', ...extra });
const liver = sphere('liver', [20, 20, 62], 15, { role: 'liver' }), pool = sphere('pool', [62, 62, 20], 6, { role: 'bloodPool' });

/** The PET's lesion L1, contoured at 41% of its max, with its Deauville score confirmed against the two references where
 * the PET has SUV. */
function measured(series: Series): { volume: Volume; annotations: Annotation[] } {
  const volume: Volume = { series, data };
  const lesion = sphere('l1', center(40), 12, { label: 'L1', threshold: 'max41', fdgLymphoma: true, priorLesionId: 'p1' });
  const reading = deauvilleReading(lesion, [lesion, liver, pool], volume);
  return { volume, annotations: ['basis' in reading ? { ...lesion, deauville: 5 as const, deauvilleBasis: reading.basis } : lesion, liver, pool] };
}

// The prior: its lesion P1, at the same threshold, read in the same SUV; acquired 72 min after injection on another scanner
// with another reconstruction (tests/pet-comparison.test.ts).
const priorAcquisition: PetAcquisition = { tracer: 'Fludeoxyglucose F^18^', uptakeSeconds: 4320, scannerModel: 'SYNTHETIC PET 1', reconstruction: 'OSEM 3i24s' };
const priorPet: PetPrior = { date: '19991001', kept: false, acquisition: compared(priorAcquisition) };
const lesionPrior = (values: LesionValues = { max: 10, mean: 5, peak: 10, mtv: 5.15, tlg: 51.5 }, glucose: PriorLesions['glucose'] = null): PriorLesions =>
  ({ date: '19991001', kept: false, lesions: [{ id: 'p1', name: 'P1', threshold: 'max41', values }], glucose });

function report(series: Series, input: Partial<PetReportInput> = {}): PetReportInput {
  const { volume, annotations } = measured(series);
  return { series, volume, annotations, lesionPrior: lesionPrior(), comparison: { current: compared(series.petAcquisition), prior: priorPet, limited: false }, ...input };
}
const text = (input: PetReportInput, locale: 'en' | 'tr') => petReportText(petReport(input), locale);
/** A number followed by an SUV's name: a value called SUV. */
const SUV_VALUE = /\d\s*(SUV|SUL)|SU[VL](max|peak|bw|bsa)/;

describe('the PET report text', () => {
  it('gives the technique, references, each lesion with its change and the cautions, with every unit, in English', () => {
    assert.equal(text(report(pet), 'en'), [
      'PET findings · 01.01.2000',
      '',
      'Technique',
      'Tracer: Fludeoxyglucose F¹⁸',
      'Injected activity: 350 MBq (9.46 mCi)',
      'Uptake time: 60 min',
      'Weight: 80 kg',
      'Height: 1.8 m',
      'Blood glucose: 5.4 mmol/l (97 mg/dl)',
      'PET values: SUVbw · body weight',
      '',
      'Reference regions',
      'Liver reference (3 cm sphere): max 2.00 SUVbw, mean 2.00 SUVbw.',
      'Mediastinal blood pool reference: max 1.50 SUVbw, mean 1.50 SUVbw.',
      '',
      'Lesions',
      'L1: max 8.00 SUVbw (−20%), peak 8.00 SUVbw (−20%), MTV 4.12 mL (−20%), TLG 33.0 SUVbw·mL (−36%), threshold 41% of SUVmax, Deauville 5. '
        + 'Change from P1 on 01.10.1999 to 01.01.2000. May not be comparable.',
      '',
      'Cautions',
      'Uptake differs by 12 min from 01.10.1999. EANM limit 10 min.',
      'Scanner model differs from 01.10.1999.',
      'Reconstruction differs from 01.10.1999.',
    ].join('\n'));
  });

  it('says the same in Turkish, with the numbers as the lesion table writes them', () => {
    assert.equal(text(report(pet), 'tr'), [
      'PET bulguları · 01.01.2000',
      '',
      'Teknik',
      'Radyofarmasötik: Fludeoxyglucose F¹⁸',
      'Enjekte edilen aktivite: 350 MBq (9.46 mCi)',
      'Bekleme süresi: 60 dk',
      'Ağırlık: 80 kg',
      'Boy: 1.8 m',
      'Kan şekeri: 5.4 mmol/l (97 mg/dl)',
      'PET değerleri: SUVbw · vücut ağırlığı',
      '',
      'Referans bölgeler',
      'Karaciğer referansı (3 cm küre): maks 2.00 SUVbw, ort. 2.00 SUVbw.',
      'Mediastinal kan havuzu referansı: maks 1.50 SUVbw, ort. 1.50 SUVbw.',
      '',
      'Lezyonlar',
      'L1: maks 8.00 SUVbw (−%20), tepe 8.00 SUVbw (−%20), MTV 4.12 mL (−%20), TLG 33.0 SUVbw·mL (−%36), eşik SUVmax değerinin %41’i, Deauville 5. '
        + '01.10.1999 tarihli P1 lezyonundan 01.01.2000 tarihine değişim. Karşılaştırılamayabilir.',
      '',
      'Uyarılar',
      '01.10.1999 tarihli çekimle bekleme süresi farkı 12 dk. EANM sınırı 10 dk.',
      'Tarayıcı modeli 01.10.1999 tarihli çekimden farklı.',
      'Rekonstrüksiyon 01.10.1999 tarihli çekimden farklı.',
    ].join('\n'));
  });

  it('reads in the SUV chosen under PET values, with SULglu, its formula and caveat beside SUL', () => {
    const sul: Series = { ...pet, suvNormalization: 'lbm' };
    const prior = lesionPrior({ max: 12.5, mean: 6, peak: 12.5, mtv: 4.12, tlg: 40 });
    for (const [locale, expected] of [['en', [
      'PET values: SUL · lean body mass (Janmahasatian)',
      'Liver reference (3 cm sphere): max 2.50 SUL, mean 2.50 SUL.',
      'L1: max 10.00 SUL (−20%), peak 10.00 SUL (−20%), MTV 4.12 mL (0%), TLG 41.2 SUL·mL (+3%), threshold 41% of SUVmax, max 10.80 SULglu, peak 10.80 SULglu, Deauville 5. '
        + 'Change from P1 on 01.10.1999 to 01.01.2000.',
      'SULglu = SUL × glucose / 5.0 mmol/l, here 5.4 mmol/l from the file. No glucose for 01.10.1999: no SULglu change.',
      'Glucose correction has no proven benefit for response assessment (EANM 2025).',
    ]], ['tr', [
      'PET değerleri: SUL · yağsız vücut kütlesi (Janmahasatian)',
      'L1: maks 10.00 SUL (−%20), tepe 10.00 SUL (−%20), MTV 4.12 mL (%0), TLG 41.2 SUL·mL (+%3), eşik SUVmax değerinin %41’i, maks 10.80 SULglu, tepe 10.80 SULglu, Deauville 5. '
        + '01.10.1999 tarihli P1 lezyonundan 01.01.2000 tarihine değişim.',
      'SULglu = SUL × kan şekeri / 5.0 mmol/l; burada dosyadaki 5.4 mmol/l. 01.10.1999 için kan şekeri yok: SULglu değişimi hesaplanamaz.',
    ]]] as const) {
      const lines = text(report(sul, { lesionPrior: prior, comparison: null }), locale).split('\n');
      for (const line of expected) assert.ok(lines.includes(line), `${locale}: ${line}\n${lines.join('\n')}`);
    }
    // With the prior's own glucose, SULglu has its change too: 10.8 against 12.5 × 8.1 / 5 = 20.25.
    const withGlucose = text(report(sul, { lesionPrior: lesionPrior({ max: 12.5, mean: 6, peak: 12.5 }, { mmol: 8.1, source: 'typed' }), comparison: null }), 'en');
    assert.match(withGlucose, /max 10\.80 SULglu \(−47%\), peak 10\.80 SULglu \(−47%\)/);
    assert.match(withGlucose, /01\.10\.1999: 8\.1 mmol\/l typed\./);
  });

  it('keeps a matched prior lesion and both dates when no change can be told against it', () => {
    // The prior has no SUL (no height, say): its lesion has no values to compare in SUL.
    const unmeasured: PriorLesions = { date: '19991001', kept: false, lesions: [{ id: 'p1', name: 'P1', threshold: 'max41' }], glucose: null };
    const sul: Series = { ...pet, suvNormalization: 'lbm' }, input = report(sul, { lesionPrior: unmeasured, comparison: null });
    assert.match(text(input, 'en'), /, Deauville 5\. Change from P1 on 01\.10\.1999 to 01\.01\.2000 unavailable\. P1 has no values in SUL\.\n/);
    assert.match(text(input, 'tr'), /, Deauville 5\. 01\.10\.1999 tarihli P1 lezyonundan 01\.01\.2000 tarihine değişim hesaplanamadı\. P1 için SUL değeri yok\.\n/);
  });

  it('gives every caution: the acquisition panel\'s checks and the comparison\'s, in both languages', () => {
    const late: Series = { ...pet, petAcquisition: { ...acquisition, uptakeSeconds: 4800, glucose: 12 } };
    const cautions = (locale: 'en' | 'tr') => text(report(late, { lesionPrior: null, comparison: { current: compared(late.petAcquisition), prior: priorPet, limited: true } }), locale).split('\n\n').at(-1);
    // 80 min against the prior's 72: within 10 min, but not within the 5 min of a lesion-region follow-up.
    assert.equal(cautions('en'), ['Cautions', 'FDG uptake time 80 min: outside 55–75 min (EANM 2025)',
      'Blood glucose 12 mmol/l: at 11 mmol/l or above, EANM 2025 advises rescheduling FDG', 'Uptake differs by 8 min from 01.10.1999. EANM limit 5 min.',
      'Scanner model differs from 01.10.1999.', 'Reconstruction differs from 01.10.1999.'].join('\n'));
    assert.equal(cautions('tr'), ['Uyarılar', 'FDG bekleme süresi 80 dk: 55–75 dk aralığının dışında (EANM 2025)',
      'Kan şekeri 12 mmol/l: 11 mmol/l ve üzerinde EANM 2025 FDG çekiminin ertelenmesini önerir', '01.10.1999 tarihli çekimle bekleme süresi farkı 8 dk. EANM sınırı 5 dk.',
      'Tarayıcı modeli 01.10.1999 tarihli çekimden farklı.', 'Rekonstrüksiyon 01.10.1999 tarihli çekimden farklı.'].join('\n'));
    // Without anything that limits the comparison, the changes are not marked.
    assert.doesNotMatch(text(report(pet, { comparison: null }), 'en'), /May not be comparable|Cautions/);
  });

  it('marks a glucose the reader typed, and leaves out what the files do not record', () => {
    const typed: Series = { ...pet, petAcquisition: { ...acquisition, glucose: undefined, height: undefined, injectedActivity: undefined } };
    const technique = (locale: 'en' | 'tr') => text(report(typed, { typedGlucose: 6.1, comparison: null }), locale).split('\n\n')[1];
    assert.equal(technique('en'), ['Technique', 'Tracer: Fludeoxyglucose F¹⁸', 'Uptake time: 60 min', 'Weight: 80 kg',
      'Blood glucose: 6.1 mmol/l (110 mg/dl), typed by the reader', 'PET values: SUVbw · body weight'].join('\n'));
    assert.match(technique('tr'), /\nKan şekeri: 6\.1 mmol\/l \(110 mg\/dl\), elle girildi\n/);
    assert.match(text(report(typed, { typedGlucose: 6.1, comparison: null }), 'en'), /\nCautions\nHeight not recorded: no SUL or SUVbsa\nInjected activity not recorded$/);
  });

  it('calls nothing SUV on a PET without SUV: technique, and why it has none, in both languages', () => {
    const own: Series = { ...pet, suvFactor: null, sulFactor: null, petAcquisition: { ...acquisition, weight: undefined },
      warnings: ['SUV unavailable: incomplete or inconsistent weight, dose, decay correction, or injection timing'],
      warningNotes: [{ code: 'series.suvIncomplete', text: 'SUV unavailable: incomplete or inconsistent weight, dose, decay correction, or injection timing' }] };
    const input = report(own, { comparison: null });
    assert.equal(petReport(input).lesions.length, 0, 'Its lesions are not quantified.');
    const english = text(input, 'en'), turkish = text(input, 'tr');
    assert.equal(english, ['PET findings · 01.01.2000', '', 'Technique', 'Tracer: Fludeoxyglucose F¹⁸', 'Injected activity: 350 MBq (9.46 mCi)',
      'Uptake time: 60 min', 'Height: 1.8 m', 'Blood glucose: 5.4 mmol/l (97 mg/dl)', '',
      'Cautions', 'This PET has no SUV: no lesion or reference value is given.',
      'SUV unavailable: incomplete or inconsistent weight, dose, decay correction, or injection timing', 'Patient weight not recorded'].join('\n'));
    assert.equal(turkish, ['PET bulguları · 01.01.2000', '', 'Teknik', 'Radyofarmasötik: Fludeoxyglucose F¹⁸', 'Enjekte edilen aktivite: 350 MBq (9.46 mCi)',
      'Bekleme süresi: 60 dk', 'Boy: 1.8 m', 'Kan şekeri: 5.4 mmol/l (97 mg/dl)', '',
      'Uyarılar', 'Bu PET’te SUV yok: lezyon ya da referans değeri verilmedi.',
      'SUV hesaplanamıyor: ağırlık, doz, bozunma düzeltmesi ya da enjeksiyon zamanı eksik veya tutarsız.', 'Hastanın ağırlığı kayıtlı değil'].join('\n'));
    for (const said of [english, turkish]) assert.doesNotMatch(said, SUV_VALUE);
  });

  it('honours the engine refusing SUV for a file that stores SUV, and says why, in both languages', () => {
    // Units GML without attenuation correction: the file's unit says SUVbw, the engine gives no SUV factor
    // (native/src/ingest.rs, suv_factor), so the lesion table's unit alone would call its values SUV.
    const refused: Series = { ...pet, valueUnit: 'SUVbw', suvFactor: null, sulFactor: null,
      warnings: ['SUV unavailable: the image is not corrected for attenuation and decay'],
      warningNotes: [{ code: 'series.suvNotCorrected', text: 'SUV unavailable: the image is not corrected for attenuation and decay' }] };
    const input = report(refused, { comparison: null });
    const english = text(input, 'en'), turkish = text(input, 'tr');
    assert.equal(english.split('\n\n').at(-1), ['Cautions', 'This PET has no SUV: no lesion or reference value is given.',
      'SUV unavailable: the image is not corrected for attenuation and decay'].join('\n'));
    assert.equal(turkish.split('\n\n').at(-1), ['Uyarılar', 'Bu PET’te SUV yok: lezyon ya da referans değeri verilmedi.',
      'SUV hesaplanamıyor: görüntüde atenüasyon ve bozunma düzeltmesi yok.'].join('\n'));
    for (const said of [english, turkish]) {
      assert.doesNotMatch(said, SUV_VALUE);
      assert.doesNotMatch(said, /Reference regions|Lesions|Referans bölgeler|Lezyonlar|PET values|PET değerleri/);
    }
  });

  it('says what limits a sphere: part of it outside the image, and voxels left out', () => {
    // The liver sphere reaches 7 mm past the image's edge; one voxel in the lesion's sphere is not a number and another
    // is padding, both outside its uptake.
    const partial = data.slice();
    partial[at([40, 50, 44])] = Number.NaN;
    partial[at([50, 40, 44])] = -1;
    const series: Series = { ...pet, paddingRange: [-1, -1] }, edge = sphere('liver', [8, 40, 30], 15, { role: 'liver' });
    const lesion = sphere('l1', center(40), 12, { label: 'L1', threshold: 'max41' });
    const input: PetReportInput = { series, volume: { series, data: partial }, annotations: [lesion, edge], lesionPrior: null, comparison: null };
    for (const [locale, liverLine, lesionLine] of [
      ['en', 'Liver reference (3 cm sphere): max 1.00 SUVbw, mean 1.00 SUVbw. Partly outside the image: only the part inside is measured.',
        'L1: max 8.00 SUVbw, peak 8.00 SUVbw, MTV 4.12 mL, TLG 33.0 SUVbw·mL, threshold 41% of SUVmax. 1 non-finite voxel excluded. 1 padding voxel excluded.'],
      ['tr', 'Karaciğer referansı (3 cm küre): maks 1.00 SUVbw, ort. 1.00 SUVbw. Kısmen görüntünün dışında: yalnızca içteki kısım ölçüldü.',
        'L1: maks 8.00 SUVbw, tepe 8.00 SUVbw, MTV 4.12 mL, TLG 33.0 SUVbw·mL, eşik SUVmax değerinin %41’i. 1 sayısal olmayan voksel çıkarıldı. 1 dolgu vokseli çıkarıldı.'],
    ] as const) {
      const lines = text(input, locale).split('\n');
      assert.ok(lines.includes(liverLine) && lines.includes(lesionLine), lines.join('\n'));
    }
  });

  it('names the threshold of a contour still waiting for its regions, and why it has no MTV', () => {
    // Two separate hot spots inside one sphere: at 41% of its max, the reader selects which belong to the lesion.
    const split = new Float32Array(data.length).fill(2);
    for (let z = 0; z < 40; z++) for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      if (Math.hypot(x * 2 - 40, y * 2 - 40, z * 2 - 40) <= 4) split[(z * 40 + y) * 40 + x] = 16;
    }
    split[at([40, 40, 50])] = 16;
    const lesion = sphere('l1', center(40), 12, { label: 'L1', threshold: 'max41' });
    const input: PetReportInput = { series: pet, volume: { series: pet, data: split }, annotations: [lesion], lesionPrior: null, comparison: null };
    assert.match(text(input, 'en'), /\nL1: max 8\.00 SUVbw, peak [\d.]+ SUVbw, threshold 41% of SUVmax, MTV unavailable until the lesion’s regions are selected\.$/);
    assert.match(text(input, 'tr'), /\nL1: maks 8\.00 SUVbw, tepe [\d.]+ SUVbw, eşik SUVmax değerinin %41’i, lezyonun bölgeleri seçilene kadar MTV hesaplanamaz\.$/);
  });

  it('says a value is unavailable rather than leave it out, and why, and an SUV peak that cannot be sampled', () => {
    const { annotations } = measured(pet);
    const unloaded = text({ series: pet, volume: undefined, annotations, lesionPrior: null, comparison: null }, 'en');
    assert.match(unloaded, /\nLiver reference \(3 cm sphere\): values unavailable\.\nMediastinal blood pool reference: values unavailable\.\n/);
    assert.match(unloaded, /\nL1: values unavailable\.\n\nCautions\nMeasured once the whole volume has loaded$/);
    const flat: Series = { ...pet, canReconstruct: false };
    assert.match(text({ series: flat, volume: { series: flat, data }, annotations, lesionPrior: null, comparison: null }, 'tr'),
      /\nL1: değerler hesaplanamadı\.\n\nUyarılar\nKüre VOI için yeniden yapılandırılabilen bir hacim gerekir$/);
    // A lesion too small for a whole 1 cm³ sphere has no SUVpeak, and says why.
    const small = sphere('l2', center(40), 3, { label: 'L2' });
    const line = text({ series: pet, volume: { series: pet, data }, annotations: [small], lesionPrior: null, comparison: null }, 'en').split('\n').at(-1);
    assert.equal(line, 'L2: max 8.00 SUVbw, SUVpeak unavailable (no complete 1 cm³ sample inside the VOI).');
  });
});

describe('a change in per cent', () => {
  it('is written as the lesion table writes it in each language', () => {
    assert.deepEqual([-20, 3.4, 0.04].map(value => percentText(value, 'en')), ['−20%', '+3%', '0%']);
    assert.deepEqual([-20, 3.4, 0.04].map(value => percentText(value, 'tr')), ['−%20', '+%3', '%0']);
  });
});
