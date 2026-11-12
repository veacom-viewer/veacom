import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Series, Vec3, ViewState } from '../src/model';
import { screenMapping, screenToWorld } from '../src/imaging/geometry';
import { assertClose } from './support';

// tools/pet-validation.cjs and its helpers: what it reads, how it compares with the vendor, and where it draws.
const require = createRequire(import.meta.url);
const validation = require('../tools/lib/pet-validation.cjs');
const { axialPlacement } = require('../tools/lib/pet-validation-geometry.cjs');
const { factorRecord, maxActivityBqml, readingRows } = require('../tools/pet-validation.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));

describe('the spheres file', () => {
  const study = (spheres: unknown[], extra = {}) => ({ studies: [{ study: 'GE-01', spheres, ...extra }] });
  const liver = { name: 'liver', role: 'liver', center: [-75, 0, -215] };

  it('reads each study\'s spheres, the liver made 3 cm across and lesions by default', () => {
    const { studies } = validation.readSpheres(study([liver, { name: 'L1', center: [1, 2, 3], radius: 20 }], { series: { number: 4 } }));
    assert.deepEqual(studies, [{ study: 'GE-01', series: { number: 4 }, spheres: [
      { name: 'liver', role: 'liver', center: [-75, 0, -215], radius: 15 }, { name: 'L1', role: 'lesion', center: [1, 2, 3], radius: 20 }] }]);
  });

  it('says what to fix', () => {
    const fails = (json: unknown, pattern: RegExp) => assert.throws(() => validation.readSpheres(json), pattern);
    fails({}, /"studies" list/);
    fails({ studies: [{ study: '../elsewhere', spheres: [liver] }] }, /inside the studies folder/);
    fails({ studies: [{ study: '/tmp/GE-01', spheres: [liver] }] }, /inside the studies folder/);
    fails(study([{ ...liver, radius: 10 }]), /3 cm across/);
    fails(study([liver, { ...liver, name: 'liver 2' }]), /one liver reference/);
    fails(study([liver, liver]), /used twice/);
    fails(study([{ name: 'L1', center: [1, 2], radius: 5 }]), /"center" is \[x, y, z\]/);
    fails(study([{ name: 'L1', center: [1, 2, 3] }]), /"radius" is in mm/);
    fails(study([{ name: 'L1', role: 'spleen', center: [1, 2, 3], radius: 5 }]), /"role" is one of lesion, liver, bloodPool/);
    fails(study([{ name: 'a name far longer than VEAcom keeps', center: [1, 2, 3], radius: 5 }]), /1 to 24 characters/);
    fails(study([liver], { series: { number: '4' } }), /"series" is/);
  });
});

describe('a sphere\'s values as VEAcom shows them', () => {
  it('reads a lesion at 41% with its MTV and TLG', () => {
    const values = validation.parseSphereValues('SUVbw max 7.00 · SUVpeak 6.85 · mean 3.21 · 33.5 mL · ⌀ 40.0 mm · MTV 41% 14.6 mL · TLG 102.1 SUVbw·mL · σ 3.26 · 536 voxels');
    assert.deepEqual(values, { quantity: 'SUVbw', max: 7, peak: 6.85, mean: 3.21, volumeMl: 33.5, diameterMm: 40, mtv: 14.6, tlg: 102.1, sd: 3.26, voxels: 536, notes: [] });
  });

  it('reads a small reference without SUVpeak, in SUL, and keeps what it does not know as notes', () => {
    const values = validation.parseSphereValues('SUL max 1.20 · SULpeak unavailable (no complete 1 cm³ sample inside the VOI) · mean 1.20 · min 1.19 · SULglu max 1.30, peak 1.29 · 1.77 mL · ⌀ 15.0 mm · σ 0.00 · 28 voxels · clipped');
    assert.deepEqual(values, { quantity: 'SUL', max: 1.2, peakUnavailable: true, mean: 1.2, min: 1.19, volumeMl: 1.77, diameterMm: 15, sd: 0, voxels: 28, notes: ['clipped'] });
  });

  it('reads a PET without SUV in its own unit, and refuses what is not a sphere', () => {
    assert.deepEqual(validation.parseSphereValues('Bq/ml max 20000.0 · mean 9000.0 · min 0.0 · 33.5 mL · ⌀ 40.0 mm · σ 10.0 · 536 voxels'),
      { quantity: 'Bq/ml', max: 20000, mean: 9000, min: 0, volumeMl: 33.5, diameterMm: 40, sd: 10, voxels: 536, notes: [] });
    assert.throws(() => validation.parseSphereValues('Calculating…'), /Not a sphere/);
  });
});

describe('the SUV factor\'s parts', () => {
  it('gives lean body mass by Janmahasatian, as VEAcom does, and by James', () => {
    // The synthetic follow-up's man: 70 kg, 1.75 m.
    const man = validation.leanBodyMassRatios({ weightKg: 70, heightM: 1.75, sex: 'M' });
    assertClose(man.janmahasatian, 9270 / (6680 + 216 * 70 / 1.75 ** 2), 9);
    assertClose(man.james, (1.1 * 70 - 128 * (70 / 175) ** 2) / 70, 9);
    const woman = validation.leanBodyMassRatios({ weightKg: 120, heightM: 1.6, sex: 'F' });
    assertClose(woman.janmahasatian, 9270 / (8780 + 244 * 120 / 1.6 ** 2), 9);
    assert.equal(woman.james, (1.07 * 120 - 148 * (120 / 160) ** 2) / 120);
    assert.equal(validation.leanBodyMassRatios({ weightKg: 70, heightM: 1.75, sex: 'O' }), null);
    assert.equal(validation.leanBodyMassRatios({ weightKg: 70, heightM: 175, sex: 'M' }), null);
  });

  it('works back the decay interval from an SUVbw factor', () => {
    const factor = 70_000 / (200e6 * 2 ** (-3600 / 6586.2));
    assertClose(validation.decayMinutes({ factorPerBqml: factor, weightKg: 70, doseBq: 200e6, halfLifeSeconds: 6586.2 }), 60, 9);
    assertClose(validation.decayMinutes({ factorPerBqml: 70_000 / 200e6, weightKg: 70, doseBq: 200e6, halfLifeSeconds: 6586.2 }), 0, 9);
    assert.equal(validation.decayMinutes({ factorPerBqml: factor, weightKg: 70, doseBq: undefined, halfLifeSeconds: 6586.2 }), null);
  });

  it('reads the factor\'s DICOM elements, private ones through their creators', () => {
    const tags = [
      { tag: '(0008,0031)', value: '143000' }, { tag: '(0008,0032)', value: '120000.000000' }, { tag: '(0054,1001)', value: 'CNTS' },
      { tag: '(0009,0011)', value: 'GEMS_PETD_01 ' }, { tag: '(0009,110D)', value: '20000101115900' },
      { tag: '(7053,0010)', value: 'Philips PET Private Group' }, { tag: '(7053,1000)', value: '0.0007' }, { tag: '(7053,1009)', value: '2.5' },
      { tag: '(0018,1020)', value: '[binary: 8 bytes]' }, { tag: '(0054,0016)[1]/(0018,1072)', value: '110000' },
    ];
    const pet = { seriesNumber: 3, description: 'PET AC', valueUnit: 'CNTS', suvFactor: 0.0007, sulFactor: 0.00056, patientSex: 'M', warnings: [],
      petAcquisition: { weight: 70, height: 1.75, injectedActivity: 200e6, halfLife: 6586.2, injectionTime: '110000', decayCorrection: 'START', uptakeSeconds: 3600 } };
    const record = factorRecord('PHI-01', pet, tags);
    assert.equal(record.units, 'CNTS');
    assert.equal(record.series_time, '143000');
    assert.equal(record.ge_scan_datetime, '20000101115900', 'GE\'s block 11 is found through its creator.');
    assert.equal(record.philips_suv_scale_factor, '0.0007');
    assert.equal(record.philips_activity_scale_factor, 2.5);
    assert.equal(record.suvbw_per_bqml, 0.0007 / 2.5, 'Counts become Bq/ml through Philips\' activity concentration factor.');
    assert.equal(record.software_versions, '', 'A value given only as bytes is left out.');
    assertClose(record.sul_per_suvbw, 0.8, 9);
    assert.equal(record._compare.injectionTime, '110000');
  });

  it('reports a body-weight factor only for calibrated body-weight values', () => {
    const tags = [{ tag: '(0054,1001)', value: 'GML' }];
    for (const suvFactor of [null, 0, -1, NaN, Infinity]) {
      const record = factorRecord('GML-01', { valueUnit: 'g/ml', suvFactor, sulFactor: 0.8, warnings: [] }, tags);
      assert.equal(record.value_unit, 'g/ml');
      assert.equal(record.suvbw_factor, '');
      assert.equal(record.sul_factor, '');
      assert.equal(record.sul_per_suvbw, '');
    }
    assert.equal(factorRecord('GML-01', { valueUnit: 'SUVlbm', suvFactor: 1, warnings: [] }, tags).suvbw_factor, '');
    assert.equal(factorRecord('GML-01', { valueUnit: 'SUVbw', suvFactor: 1, warnings: [] }, tags).suvbw_factor, 1);
  });
});

describe('VEAcom against the vendor', () => {
  const values = (quantity: string, max: number, peak?: number, extra = {}) => ({ quantity, max, ...(peak === undefined ? {} : { peak }), notes: [], ...extra });
  const measured = (overrides: Record<string, unknown> = {}) => [{
    study: 'GE-01', factor: { suvbwPerBqml: 3.5e-4, weightKg: 70, heightM: 1.75, sex: 'M', doseBq: 200e6, halfLifeSeconds: 6586.2, injectionTime: '110000', ...overrides },
    spheres: [
      { name: 'liver', values: { SUVbw: values('SUVbw', 2.4, 2.1, { mean: 2 }), SUL: values('SUL', 1.92, 1.68, { mean: 1.6 }) } },
      { name: 'L1', values: { SUVbw: values('SUVbw', 7, 6.5, { mtv: 14.6 }), SUL: values('SUL', 5.59, 5.19) }, maxBqml: 20_000 },
    ],
  }];
  const vendor = (spheres: Record<string, unknown>, suv = {}) => validation.readVendor({ software: 'Workstation 1.0', studies: [{ study: 'GE-01', suv, spheres }] });
  interface Row { sphere: string; quantity: string; measure: string; status: string; note: string; difference_percent: number | ''; veacom: unknown }
  const rows = (vendorFile: unknown, studies = measured()): Row[] => validation.compare(studies, vendorFile);
  const row = (all: Row[], sphere: string, quantity: string, measure: string): Row =>
    all.find(item => item.sphere === sphere && item.quantity === quantity && item.measure === measure) ?? assert.fail(`No row for ${sphere} ${quantity} ${measure}`);

  it('holds SUVmax to 1% and SUVpeak to 5%, and reports means and MTV without a limit', () => {
    const all = rows(vendor({ liver: { SUVbw: { mean: 2.05 } }, L1: { SUVbw: { max: 7.06, peak: 6.8, mtv: 13 } } }));
    assert.deepEqual(all.map(({ sphere, quantity, measure, status }: Row) => `${sphere} ${quantity} ${measure} ${status}`),
      ['liver SUVbw mean reported', 'L1 SUVbw max within', 'L1 SUVbw peak within', 'L1 mL MTV 41% reported']);
    assert.equal(row(all, 'L1', 'SUVbw', 'max').difference_percent, -0.85);
    const beyond = rows(vendor({ L1: { SUVbw: { max: 7.08, peak: 6.9 } } }));
    assert.equal(row(beyond, 'L1', 'SUVbw', 'max').status, 'beyond');
    assert.equal(row(beyond, 'L1', 'SUVbw', 'peak').status, 'beyond');
    assert.match(row(beyond, 'L1', 'SUVbw', 'peak').note, /SUVpeak methods differ/);
  });

  it('compares activity concentrations and reports independently measured factor differences', () => {
    const same = rows(vendor({ L1: { SUVbw: { max: 6.897 }, maxBqml: 20_000 } }, { factor: 3.5e-4 / 1.015 }));
    assert.equal(row(same, 'L1', 'Bq/ml', 'max').status, 'within');
    assert.equal(row(same, '', '', 'SUVbw factor (per Bq/ml)').status, 'beyond');
    assert.match(row(same, '', '', 'SUVbw factor (per Bq/ml)').note, /differ by \+1\.50%, as 2\.4 min of decay would/);
    assert.match(row(same, 'L1', 'SUVbw', 'max').note, /^The maximum activity concentrations agree\. The SUV factors differ by \+1\.50%/);
    const other = rows(vendor({ L1: { SUVbw: { max: 7.2 }, maxBqml: 20_570 } }, { factor: 3.5e-4 }));
    assert.equal(row(other, 'L1', 'Bq/ml', 'max').status, 'beyond');
    assert.match(row(other, 'L1', 'SUVbw', 'max').note, /^The maximum activity concentrations differ/);
    assert.equal(row(other, '', '', 'SUVbw factor (per Bq/ml)').status, 'within');
  });

  it('reports agreement for disjoint spheres with identical activity without claiming voxel identity', () => {
    const sites = [-100, -50].map((x, i) => ({ name: `L${i + 1}`, placed: { center: [x, 0, -215], radius: 8 }, maxBqml: 5714 }));
    const all: Row[] = validation.compare([{ study: 'GE-01', factor: {}, spheres: sites }], vendor({ L1: { maxBqml: 5714 }, L2: { maxBqml: 5714 } }));
    assert.equal(all.length, 2);
    for (const item of all) assert.deepEqual([item.status, item.note], ['within', 'The maximum activity concentrations agree.']);
  });

  it('requires an exact zero for a limited reading with a zero reference', () => {
    const expected = vendor({ L1: { SUVbw: { max: 0, peak: 0, mean: 0 }, maxBqml: 0 } }, { factor: 0 });
    const all = rows(expected);
    for (const item of all.filter(item => item.measure !== 'mean')) {
      assert.deepEqual([item.status, item.difference_percent], ['beyond', '']);
    }
    const zero: Row[] = validation.compare([{ study: 'GE-01', factor: { suvbwPerBqml: 0 }, spheres: [
      { name: 'L1', values: { SUVbw: values('SUVbw', 0, 0, { mean: 2 }) }, maxBqml: 0 },
    ] }], expected);
    assert.deepEqual(zero.map(item => item.status), ['within', 'within', 'within', 'within', 'reported']);
  });

  it('compares the displayed Bq/ml directly and leaves unavailable activity missing', () => {
    const raw = validation.parseSphereValues('Bq/ml max 20000.0 · mean 9164.3');
    const maxBqml = maxActivityBqml(raw, undefined, undefined);
    assert.equal(maxBqml, 20_000);
    const sphere = { name: 'L1', role: 'lesion', requested: { center: [0, 0, 0], radius: 10 }, values: { 'Bq/ml': raw }, maxBqml };
    const study = { study: 'GE-01', series: { number: 3 }, factor: {}, spheres: [sphere] };
    assert.equal(readingRows([study])[0].max_bqml, 20_000);
    const expected = vendor({ L1: { maxBqml: 1000 } });
    const [mismatch] = validation.compare([study], expected);
    assert.deepEqual([mismatch.veacom, mismatch.status, mismatch.difference_percent], [20_000, 'beyond', 1900]);
    const [missing] = validation.compare([{ ...study, spheres: [{ name: 'L1', values: { CNTS: values('CNTS', 5) } }] }], expected);
    assert.equal(missing.status, 'missing');
    assert.equal(maxActivityBqml(values('SUVbw', 7), 7.00021, 0.00035), 7.00021 / 0.00035);
    assert.equal(maxActivityBqml(values('SUVlbm', 7), undefined, 0.00035), undefined);
  });

  it('compares stored lean-body-mass SUV with SUL and retains its normalization', () => {
    for (const [suvType, unit] of [['LBM', 'SUVlbm'], ['LBMJAMES128', 'SUV'], ['LBMJANMA', 'SUV'], ['BSA', 'SUVbsa']]) {
      const factor = factorRecord('GE-01', { valueUnit: unit, suvFactor: 1, warnings: [] }, [
        { tag: '(0054,1001)', value: 'GML' }, { tag: '(0054,1006)', value: suvType },
      ])._compare;
      const raw = validation.parseSphereValues(`${unit} max 7.00 · SULpeak 7.00 · mean 3.21`);
      const all: Row[] = validation.compare([{ study: 'GE-01', factor, spheres: [{ name: 'L1', values: { [unit]: raw } }] }],
        vendor({ L1: { SUVbw: { max: 7 }, SUL: { max: 7, peak: 7 } } }));
      assert.equal(all[0].status, 'missing');
      for (const item of all.slice(1)) {
        if (suvType === 'BSA') assert.equal(item.status, 'missing');
        else assert.deepEqual([item.veacom, item.status, item.note], [7, 'within', `Stored ${unit}, DICOM SUV Type ${suvType}.`]);
      }
    }
  });

  it('recognises SUL by the James lean body mass', () => {
    const ratio = validation.leanBodyMassRatios({ weightKg: 70, heightM: 1.75, sex: 'M' });
    const all = rows(vendor({ L1: { SUL: { max: Number((5.59 * ratio.james / ratio.janmahasatian).toFixed(2)) } } }));
    assert.equal(row(all, 'L1', 'SUL', 'max').status, 'beyond');
    assert.match(row(all, 'L1', 'SUL', 'max').note, /James lean body mass matches/);
  });

  it('compares the SUV parameters the vendor shows', () => {
    const all = rows(vendor({}, { weightKg: 70, heightM: 1.75, sex: 'F', doseMBq: 190, injectionTime: '11:00' }));
    assert.deepEqual(all.map(({ measure, status }: Row) => `${measure} ${status}`),
      ['weight (kg) within', 'height (m) within', 'injected activity (MBq) beyond', 'sex beyond', 'injection time within']);
    assert.match(all[2].note, /residual activity/);
    const late = rows(vendor({}, { injectionTime: '10:59:30' }));
    assert.deepEqual([late[0].status, late[0].veacom, late[0].note], ['beyond', '11:00:00', '30 s apart']);
  });

  it('takes the injection clock from Start DateTime before Start Time', () => {
    const record = factorRecord('GE-01', { petAcquisition: { injectionTime: '103000', injectionDateTime: '19991001104800.25+0100' } }, []);
    assert.equal(record.injection_time, '104800.25');
    assert.equal(record.injection_datetime, '19991001104800.25+0100');
    const [item] = rows(vendor({}, { injectionTime: '10:48:00' }), measured(record._compare));
    assert.deepEqual([item.veacom, item.status], ['10:48:00.25', 'within']);
  });

  it('keeps time precision and continues comparing when a scanner time is invalid', () => {
    for (const [ours, theirs, display, status] of [
      ['11', '11:34:56', '11', 'reported'], ['11', '12:00', '11', 'beyond'], ['11', '11', '11', 'reported'],
      ['1105', '11:05:59', '11:05', 'reported'], ['1100', '11:00', '11:00', 'within'], ['110099', '11:00', undefined, 'missing'],
    ]) {
      const [time, max] = rows(vendor({ L1: { SUVbw: { max: 7 } } }, { injectionTime: theirs }), measured({ injectionTime: ours }));
      assert.deepEqual([time.veacom, time.status, max.status], [display, status, 'within']);
    }
  });

  it('says why VEAcom has no value', () => {
    const studies = measured();
    studies[0].spheres[1] = { name: 'L1', values: { SUVbw: values('SUVbw', 7, undefined, { peakUnavailable: true }) } } as never;
    const all = rows(vendor({ L1: { SUVbw: { peak: 6.9, mtv: 14 }, SUL: { max: 5.6 } }, L9: { SUVbw: { max: 3 } } }), studies);
    assert.deepEqual(all.map(({ measure, status, note }: Row) => `${measure} ${status}: ${note}`), [
      'peak missing: No complete 1 cm³ sphere fits inside the VOI', 'MTV 41% missing: No MTV for this sphere',
      'max missing: VEAcom gave no SUL reading for this series', 'sphere missing: Not in the spheres file for this study']);
    // A PET VEAcom gives no SUV: its values stay in counts, and neither SUVbw nor SUL is compared.
    const counts = [{ ...studies[0], spheres: [{ name: 'L1', values: { CNTS: values('CNTS', 2857) } }] }];
    assert.deepEqual(rows(vendor({ L1: { SUVbw: { max: 7 }, SUL: { max: 5.6 } } }), counts as never).map(({ status, note }: Row) => `${status}: ${note}`),
      ['missing: VEAcom gave no SUVbw reading for this series', 'missing: VEAcom gave no SUL reading for this series']);
    assert.deepEqual(validation.compare([{ study: 'GE-01', error: 'No PET series matches' }], vendor({}, { weightKg: 70 })).map((item: { status: string; note: string }) => `${item.status}: ${item.note}`),
      ['missing: No PET series matches']);
  });

  it('checks the vendor file', () => {
    assert.throws(() => validation.readVendor({ studies: [{ study: 'GE-01', spheres: { L1: { SUVbw: { maximum: 3 } } } }] }), /measures are max, peak, mean, sd, mtv, tlg/);
    assert.throws(() => validation.readVendor({ studies: [{ study: 'GE-01', suv: { injectionTime: '25:00' } }] }), /HH:MM/);
    assert.throws(() => validation.readVendor({ tolerances: { max: -1 }, studies: [] }), /per cent/);
    assert.equal(validation.readVendor({ tolerances: { max: 2 }, studies: [{ study: 'GE-01', suv: { weightKg: 70 } }] }).tolerances.max, 2);
    assert.throws(() => validation.readVendor({ studies: [] }), /at least one study/);
    assert.throws(() => vendor({}), /at least one SUV parameter or sphere reading/);
    assert.throws(() => vendor({ L1: {} }), /at least one sphere reading/);
    assert.throws(() => vendor({ L1: { SUVbw: {} } }), /at least one SUVbw measure/);
    assert.throws(() => vendor({ L1: { SUVBW: { max: 7 } } }), /unknown quantity "SUVBW"/);
    assert.throws(() => vendor({ L1: { maxBqml: 20_000, SUVBW: { max: 7 } } }), /unknown quantity "SUVBW"/);
    assert.throws(() => vendor({}, { injectionTime: '11:00:99' }), /HH:MM/);
  });

  it('checks known synthetic means, MTV and TLG at the displayed precision', t => {
    const temp = mkdtempSync(path.join(tmpdir(), 'veacom-pet-expectations-'));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const folder = path.join(temp, 'study');
    for (const script of ['make-pet-followup.mjs', 'make-pet-validation-inputs.mjs']) {
      execFileSync(process.execPath, [path.join(root, 'tools/fixtures', script), folder]);
    }
    const expected = JSON.parse(readFileSync(path.join(folder, 'pet-validation-expected.json'), 'utf8'));
    const current = expected.studies.find((study: { study: string }) => study.study === 'current');
    const actual = [{ study: 'current', factor: {}, spheres: [
      { name: 'liver', values: { SUL: values('SUL', 1.6, undefined, { mean: 1.6 }) } },
      { name: 'L1', values: { SUVbw: values('SUVbw', 7, 7, { mtv: 14.6, tlg: 102.1 }) } },
    ] }];
    const statuses = () => {
      const all = validation.compare(actual, validation.readVendor(expected));
      return [row(all, 'liver', 'SUL', 'mean'), row(all, 'L1', 'mL', 'MTV 41%'), row(all, 'L1', 'SUVbw', 'TLG')].map(item => item.status);
    };
    assert.deepEqual(statuses(), ['within', 'within', 'within']);
    current.spheres.liver.SUL.mean = 9999;
    current.spheres.L1.SUVbw.mtv += 0.1;
    current.spheres.L1.SUVbw.tlg += 0.1;
    assert.deepEqual(statuses(), ['beyond', 'beyond', 'beyond']);
  });
});

describe('the files it writes', () => {
  it('writes RFC 4180 CSV with a dot for decimals', () => {
    assert.equal(validation.toCsv([{ a: 1.5, b: 'x, "y"', c: undefined }, { a: Number.NaN, b: 'line\nbreak', c: [1, 2] }], ['a', 'b', 'c']),
      'a,b,c\r\n1.5,"x, ""y""",\r\n,"line\nbreak",1 2\r\n');
  });

  it('escapes spreadsheet formulas in text fields and preserves negative numeric readings', () => {
    for (const value of ['=1+2', '+1', '-1', '@SUM(A1)', '  =1+2', '\t=1+2', '＝1+2', '＋1']) {
      assert.equal(validation.toCsv([{ description: value, max: -7.25 }], ['description', 'max']), `description,max\r\n'${value},-7.25\r\n`);
    }
    assert.equal(validation.toCsv([{ description: '=SUM(1,2)' }], ['description']), 'description\r\n"\'=SUM(1,2)"\r\n');
    assert.equal(validation.toCsv([{ name: '\r=1' }], ['name']), 'name\r\n"\'\r=1"\r\n');
  });

  it('writes one row per sphere and quantity, with where VEAcom placed it', () => {
    const [bw, sul, failed] = readingRows([{ study: 'GE-01', series: { number: 3, description: 'PET AC' }, spheres: [
      { name: 'L1', role: 'lesion', requested: { center: [1, 2, 3], radius: 20 }, placed: { center: [1.0000001, 2, 2.5], radius: 20.000000007 }, maxBqml: 20000.123456,
        mtvNote: 'MTV from the largest of 2 regions', values: { SUVbw: { quantity: 'SUVbw', max: 7, peak: 6.9, mtv: 14.6, notes: [] }, SUL: { quantity: 'SUL', max: 5.59, notes: [] } } },
      { name: 'L2', role: 'lesion', requested: { center: [4, 5, 6], radius: 10 }, values: {}, error: 'not measured' }] }]);
    assert.deepEqual([bw.center_x, bw.center_z, bw.radius_mm, bw.max_bqml, bw.mtv41_ml, bw.note], [1, 2.5, 20, 20000.12, 14.6, 'MTV from the largest of 2 regions']);
    assert.deepEqual([sul.quantity, sul.max, sul.max_bqml, sul.note], ['SUL', 5.59, undefined, '']);
    assert.equal(failed.note, 'not measured');
  });

  it('keeps real studies and readings out of the repository', () => {
    assert.equal(validation.inside(path.join(root, 'test-results/x'), root), true);
    assert.equal(validation.inside(root, root), true);
    assert.equal(validation.inside(path.join(root, '..patient-results'), root), true);
    assert.equal(validation.inside(path.join(root, '..', 'studies'), root), false);
    assert.equal(validation.inside(path.join(`${path.resolve(root)}-other`, 'x'), root), false);
  });

  it('rejects a real-study output under a symlink into the checkout before creating directories', t => {
    const temp = mkdtempSync(path.join(tmpdir(), 'veacom-pet-path-'));
    const destination = mkdtempSync(path.join(root, '.pet-validation-test-'));
    t.after(() => { rmSync(temp, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); });
    const alias = path.join(temp, 'external');
    symlinkSync(destination, alias, 'junction');
    const spheres = path.join(temp, 'spheres.json');
    writeFileSync(spheres, JSON.stringify({ studies: [{ study: 'absent', spheres: [{ name: 'L1', center: [0, 0, 0], radius: 8 }] }] }));
    const cli = (output: string) => spawnSync(process.execPath, [path.join(root, 'tools/pet-validation.cjs'), temp, spheres, output], { encoding: 'utf8' });
    const output = path.join(alias, 'new', 'results');
    assert.equal(validation.inside(output, root), true);
    const rejected = cli(output);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /OUTPUT_DIR .* is inside the repository/);
    assert.equal(existsSync(path.join(destination, 'new')), false);
    symlinkSync(destination, path.join(temp, 'absent'), 'junction');
    assert.match(cli(path.join(temp, 'results')).stderr, /resolves outside STUDIES_DIR/);
  });
});

describe('where it draws a sphere', () => {
  const pane: [number, number] = [612, 388];
  // A whole-body PET grid; `direction` row-major with columns i, j, k.
  const pet = (direction: number[], origin: Vec3, frameMetadata?: Series['frameMetadata']): Series => ({
    id: 'pet', dimensions: [192, 192, 120], spacing: [3.65, 3.65, 3.27], origin, direction, canReconstruct: true, modality: 'PT', frameMetadata,
  }) as unknown as Series;
  const view = (mode: 'source' | 'mpr', placement: { slice: number; zoom: number; pan: [number, number] }): ViewState => ({
    mode, plane: 'axial', slice: placement.slice, zoom: placement.zoom, pan: placement.pan, rotation: 0, flipX: false, flipY: false,
  }) as unknown as ViewState;
  const cases: [string, Series][] = [
    ['head first, centred', pet([1, 0, 0, 0, 1, 0, 0, 0, -1], [-348.6, -348.6, 0])],
    ['off centre, slices up the body', pet([1, 0, 0, 0, 1, 0, 0, 0, 1], [-311.2, -381.9, -1203.5])],
    ['rows and columns reversed', pet([-1, 0, 0, 0, -1, 0, 0, 0, -1], [312.4, 299.1, -40])],
  ];
  for (const [name, series] of cases) for (const mode of ['source', 'mpr'] as const) {
    it(`puts the centre in the middle of the pane and the drag on its radius: ${name}, ${mode}`, () => {
      const center: Vec3 = [-61.3, 22.8, series.origin[2] + series.direction[8] * 3.27 * 47.4], radius = 12.5;
      const placement = axialPlacement(series, { mode }, center, radius, pane);
      // VEAcom's own mapping (src/imaging/geometry.ts) for the view the tool sets.
      const mapping = screenMapping(series, view(mode, placement), ...pane);
      const middle = screenToWorld(mapping, pane[0] / 2, pane[1] / 2), edge = screenToWorld(mapping, pane[0] / 2 + placement.radiusPx, pane[1] / 2);
      assertClose(middle[0], center[0], 9);
      assertClose(middle[1], center[1], 9);
      assert(Math.abs(middle[2] - center[2]) <= placement.throughTolerance, `The plane at z = ${middle[2]} passes within half a slice of ${center[2]}.`);
      assertClose(middle[2], placement.planeZ, 9);
      assertClose(Math.hypot(edge[0] - middle[0], edge[1] - middle[1], edge[2] - middle[2]), radius, 9);
      assert(placement.inPlaneTolerance < 0.25, `A pixel is a small part of the radius: ${placement.inPlaneTolerance} mm.`);
      assert.deepEqual(placement.offset(middle).inPlane < 1e-9, true);
    });
  }

  it('follows each acquired slice\'s own position', () => {
    // A stack whose slices are not evenly spaced: VEAcom shows each where its file puts it.
    const zs = Array.from({ length: 120 }, (_, k) => -k * 3.27 - (k > 60 ? 1.1 : 0));
    const frames = zs.map(z => ({ origin: [-348.6, -348.6, z], direction: [1, 0, 0, 0, 1, 0, 0, 0, -1], spacing: [3.65, 3.65, 3.27] }));
    const series = pet([1, 0, 0, 0, 1, 0, 0, 0, -1], [-348.6, -348.6, 0], frames as unknown as Series['frameMetadata']);
    const placement = axialPlacement(series, { mode: 'source' }, [0, 0, zs[80] - 0.4], 10, pane);
    assert.equal(placement.slice, 80);
    assertClose(placement.planeZ, zs[80], 9);
  });
});
