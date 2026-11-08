import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertClose, assertFields } from './support';
import { roiStatistics } from '../src/imaging/annotations';
import type { ClinicalVolumeDescriptor, ClinicalWorkerRequest, ClinicalWorkerResult } from '../src/domain/clinical.worker';
import type { Annotation, Series, Vec3, Volume } from '../src/model';
import {
  ASSESSMENT_AVAILABLE, adcUnits, annotationOutline, assessmentSummary, candidates, diffusion, enhancement, featureFit, inferSequence, inferStudySequences,
  level, measureStudy, parseAge, rank, regionPoints, roundEven, samplePoints, score, searchRegions,
  type Candidate, type Findings, type RoiMark, type SequenceChoice,
} from '../src/domain/clinical';

function candidate(expected: Candidate['expected'], extra: Partial<Candidate> = {}): Candidate {
  return { id: 'test', name: 'Test', expected, page: null, differential: [], cautions: [], ct: '', finding: '',
    profile: null, source: null, patient: null, frequency: 'sik', ...extra };
}
const perfect: Findings = { t1: 'hipo', t2: 'hiper', kontrast: 'var', dwi: 'kisitli', yayilim: 'ekspansil' };
const expected: Candidate['expected'] = { t1: ['hipo'], t2: ['hiper'], kontrast: 'var', dwi: 'kisitli', yayilim: ['ekspansil'] };
const baseSeries: Series = {
  id: 'one', uid: 'one', studyUid: 'study', patientId: '', patientName: '', studyDate: '', description: 'T2', modality: 'MR', seriesNumber: 1,
  dimensions: [5, 5, 2], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  windowCenter: 100, windowWidth: 200, valueUnit: '', suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2',
  frameOfReferenceUid: 'frame',
};
function volume(series: Partial<Series> = {}, value = 100): Volume {
  const s = { ...baseSeries, ...series };
  return { series: s, data: new Float32Array(s.dimensions[0] * s.dimensions[1] * s.dimensions[2]).fill(value) };
}
function mark(id: string, points: Vec3[], kind: 'lesion' | 'reference', seriesId = 'one', order = 1): RoiMark {
  return { annotation: { id, type: 'polygon', points, plane: 'axial', slice: 0 }, seriesId, kind, order };
}
const lesion = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] as Vec3[];
const reference = [[3, 3, 0], [4, 3, 0], [4, 4, 0], [3, 4, 0]] as Vec3[];

describe('original differential scoring reference cases', () => {
  it('preserves exact five-feature match and ambiguity penalties', () => {
    assert.equal(rank(perfect, [candidate(expected)]).ranked[0].match, 1);
    assertClose(score({ t1: 'hipo' }, candidate({ t1: ['hipo', 'izo', 'hiper'] })).match, 0.7);
  });
  it('applies a separate contradiction multiplier to each conflicting feature', () => {
    assertClose(score({ t1: 'hipo', t2: 'hiper' }, candidate({ t1: ['hiper'], t2: ['hiper'] })).match, 0.35);
    assertClose(score({ t1: 'hipo' }, candidate({ t1: ['izo'] })).match, 0.28);
    // Two contradictions: ((0 + 0 + 1) / 3) * .7 * .7.
    assertClose(score({ t1: 'hipo', t2: 'hiper', dwi: 'kisitli' }, candidate({ t1: ['hiper'], t2: ['hipo'], dwi: 'kisitli' })).match, 0.49 / 3);
    assert.equal(featureFit('t1', 'hipo', ['akim_boslugu']), 0);
  });
  it('weights spread twice but counts it once for feature coverage', () => {
    assertClose(score({ t1: 'hipo', yayilim: 'infiltratif' }, candidate({ t1: ['hipo'], yayilim: ['ekspansil'] })).match, 0.7 / 3);
    const result = rank({ t1: 'hipo', t2: 'hiper', dwi: 'kisitli', kontrast: 'var' }, [candidate({ t1: ['hipo'] }, { frequency: 'orta' })]);
    assertClose(result.ranked[0].match, 0.56);
  });
  it('preserves age and sex adjustments, inclusive age boundaries, and unknown demographics', () => {
    const c = candidate({ t1: ['hipo'] }, { patient: { yas: [10, 20], cinsiyet: 'E' } });
    assertClose(rank({ t1: 'hipo' }, [c], { age: 40, sex: 'K' }).ranked[0].match, 0.12);
    assert.equal(rank({ t1: 'hipo' }, [c], { age: 20, sex: 'E' }).ranked[0].match, 1);
    assert.equal(rank({ t1: 'hipo' }, [c], { age: null, sex: null }).ranked[0].match, 1);
  });
  it('keeps rim enhancement partial fit distinct from a successful reason', () => {
    const result = score({ kontrast: 'yok' }, candidate({ kontrast: 'kapsül' }));
    assert.equal(result.match, 0.6);
    assertFields(result.reasons[0], { fits: false, expected: 'rim', found: 'none' });
  });
  it('keeps unsupported candidates separate and preserves stable ordering of ties', () => {
    const a = candidate({ t1: ['hipo'] }, { id: 'a' }), b = candidate({ t1: ['hipo'] }, { id: 'b' }), missing = candidate({ t2: ['hiper'] }, { id: 'missing' });
    const result = rank({ t1: 'hipo' }, [a, missing, b]);
    assert.deepEqual(result.ranked.map(r => r.candidate.id), ['a', 'b']);
    assert.deepEqual(result.unknown.map(c => c.id), ['missing']);
  });
  // The knowledge base is kept outside the repository for now (src/domain/clinical.ts); these check its content.
  it('preserves the source knowledge counts and CPA additions', { skip: !ASSESSMENT_AVAILABLE }, () => {
    assert.equal(candidates('').length, 137);
    assert.equal(candidates('kt.spa').length, 32);
    assertFields(candidates('kt.spa').find(c => c.name === '(Epi)dermoid kist')?.expected, { dwi: 'kisitli' });
  });
});

describe('signal classification boundaries from original measure.py', () => {
  for (const [ratio, result] of [[0.799, 'hipo'], [0.8, 'izo'], [1.25, 'izo'], [1.251, 'hiper'], [null, null]]) it(`signal ${ratio} -> ${result}`, () => assert.equal(level(ratio as number | null), result));
  for (const [after, result] of [[1.15, 'yok'], [1.1501, 'var'], [1.6, 'var'], [1.6001, 'belirgin']]) it(`enhancement ratio ${after} -> ${result}`, () => assert.equal(enhancement(1, after as number), result));
  it('does not divide by zero precontrast signal', () => assert.equal(enhancement(0, 3), null));
  for (const [dwi, adc, result] of [
    [1.3, null, null], [1.299, null, 'kisitsiz'], [1.3, 0.999, 'kisitli'], [1.3, 1, null],
    [null, 0.799, 'kisitli'], [null, 0.8, null], [1.299, 0.7, 'kisitsiz'], [1.3, 1.15, 'kisitsiz'],
  ]) it(`diffusion (${dwi},${adc}) -> ${result}`, () => assert.equal(diffusion(dwi as number | null, adc as number | null).finding, result));
  it('infers ADC display units independently of the classification ratio', () => {
    assert.deepEqual([1000, 1, 0.001, 100, 4].map(adcUnits), [0.001, 1, 1000, 0.01, null]);
  });
});

describe('contrast phase and MR acquisition metadata', () => {
  const t1 = (extra: Partial<Series> = {}): Series => ({ ...baseSeries, description: 'neck', repetitionTime: 500, echoTime: 10, ...extra });
  it('recognizes tag-only postcontrast T1 and protocol-only contrast names', () => {
    assert.equal(inferSequence(t1({ contrastBolusAgent: 'Gadobutrol' })).role, 't1c');
    assert.equal(inferSequence(t1({ contrastBolusRoute: 'IV' })).role, 't1c');
    assert.equal(inferSequence(t1({ protocolName: 'AX T1 POST_GD' })).role, 't1c');
    assert.equal(inferSequence(t1({ acquisitionContrast: 'T1' })).role, 't1');
  });
  for (const description of ['T1 PRE CONTRAST', 'T1 W/O contrast', 'T1 noncontrast', 'T1 kontrastsiz'])
    it(`keeps ${description} precontrast even with copied global agent tags`, () => {
      assert.equal(inferSequence(t1({ description, contrastBolusAgent: 'Gadobutrol', contrastBolusRoute: 'IV' })).role, 't1');
    });
  it('uses per-frame usage instead of copied series-level labels and agents', () => {
    assert.equal(inferSequence(t1({ description: 'T1 POST', contrastBolusAgent: 'Gadobutrol', contrastBolusPhase: 'PRE_CONTRAST' })).role, 't1');
    assert.equal(inferSequence(t1({ contrastBolusAgent: 'Gadobutrol', contrastBolusAdministered: 'NO' })).role, 't1');
    assert.equal(inferSequence(t1({ contrastBolusPhase: 'POST_CONTRAST', contrastBolusAdministered: 'YES', contrastBolusDetected: 'NO' })).role, 't1c');
    assert.equal(inferSequence(t1({ contrastBolusAdministered: 'YES', contrastBolusDetected: 'NO' })).role, 't1c');
    assert.equal(inferSequence(t1({ contrastBolusDetected: 'NO', contrastBolusAgent: 'Gadobutrol' })).role, 't1c');
  });
  it('excludes mixed frame phases rather than pooling them into a precontrast sequence', () => {
    const mixed = inferSequence(t1({ contrastBolusPhase: 'MIXED', contrastBolusAgent: 'Gadobutrol' }));
    assert.equal(mixed.role, null); assert.ok(mixed.basis.includes('Mixed'));
    assert.equal(inferSequence(t1({ contrastBolusAdministered: 'MIXED' })).role, null);
    assert.equal(inferSequence(t1({ acquisitionContrast: 'MIXED' })).role, null);
  });
  it('preserves the original 3D GRE postcontrast assumption and its boundaries', () => {
    const gre = t1({ sequenceName: 'RSSG', scanningSequence: 'GR', mrAcquisitionType: '3D', repetitionTime: 15, echoTime: 6.2, flipAngle: 20 });
    const assumed = inferSequence(gre);
    assert.equal(assumed.role, 't1c'); assert.ok(assumed.basis.includes('Assumed'));
    assert.equal(inferSequence({ ...gre, description: 'T1 PRE', contrastBolusAgent: 'copied agent' }).role, 't1');
    assert.equal(inferSequence({ ...gre, contrastBolusPhase: 'PRE_CONTRAST' }).role, 't1');
    assert.equal(inferSequence({ ...gre, repetitionTime: 14.9 }).role, 't1');
    assert.equal(inferSequence({ ...gre, flipAngle: 35.1 }).role, 't1');
    assert.equal(inferSequence({ ...gre, sequenceName: 'TOF' }).role, null);
  });
  it('preserves physics-based FLAIR, STIR, inversion-recovery T1 and balanced SSFP', () => {
    assert.equal(inferSequence(t1({ scanningSequence: 'IR', repetitionTime: 9000, echoTime: 120, inversionTime: 2500 })).role, 'flair');
    assert.equal(inferSequence(t1({ scanningSequence: 'IR', repetitionTime: 3000, echoTime: 60, inversionTime: 160 })).role, 'stir');
    assert.equal(inferSequence(t1({ scanningSequence: 'IR', mrAcquisitionType: '3D', repetitionTime: 2000, echoTime: 3, inversionTime: 900 })).role, 't1');
    assert.equal(inferSequence(t1({ scanningSequence: 'GR', mrAcquisitionType: '3D', repetitionTime: 5, echoTime: 2, flipAngle: 50 })).role, 'ssfp');
    assert.equal(inferSequence(t1({ description: 'T2 FLAIR', repetitionTime: 9000, echoTime: 120 })).role, 'flair');
    assert.equal(inferSequence(t1({ acquisitionContrast: 'FLUID_ATTENUATED' })).role, 'flair');
    assert.equal(inferSequence(t1({ imageType: 'DERIVED\\PRIMARY\\ADC', diffusionBValue: 1000 })).role, 'adc');
  });
  const repeatedStudy = (): Series[] => [
    t1({ id: 'before', uid: 'before', sequenceName: '*tse', scanOptions: 'FS', acquisitionTime: '011000' }),
    { ...t1({ id: 't2', uid: 't2', acquisitionTime: '011100' }), repetitionTime: 2500, echoTime: 90 },
    t1({ id: 'repeat', uid: 'repeat', sequenceName: '*tse', scanOptions: 'FS', acquisitionTime: '011200' }),
    t1({ id: 'coronal', uid: 'coronal', sequenceName: '*tse', scanOptions: 'FS', acquisitionTime: '011300', direction: [1, 0, 0, 0, 0, 1, 0, -1, 0] }),
  ];
  it('keeps specialized MR sequences out of generic T2 ranking even with T2 acquisition-contrast tags', () => {
    assert.equal(inferSequence(t1({ description: 'sequence', acquisitionContrast: 'T2', scanningSequence: 'GR', mrAcquisitionType: '3D', repetitionTime: 5, echoTime: 2, flipAngle: 50 })).role, 'ssfp');
    assert.equal(inferSequence(t1({ description: 'sequence', acquisitionContrast: 'T2', scanningSequence: 'IR', repetitionTime: 9000, echoTime: 100, inversionTime: 2000 })).role, 'flair');
    assert.equal(inferSequence(t1({ description: 'sequence', acquisitionContrast: 'T2', scanningSequence: 'IR', repetitionTime: 5000, echoTime: 65, inversionTime: 150 })).role, 'stir');
    assert.equal(inferSequence(t1({ description: 'CISS', acquisitionContrast: 'T2' })).role, 'ssfp');
  });
  it('recognizes a repeated T1 followed by another T1 plane at the end of the study', () => {
    const result = inferStudySequences(repeatedStudy());
    assert.deepEqual([result.before.role, result.t2.role, result.repeat.role, result.coronal.role], ['t1', 't2', 't1c', 't1c']);
    assert.ok(result.repeat.basis.includes('Assumed'));
    const datetime = repeatedStudy().map(series => ({ ...series, acquisitionDateTime: `20261103${series.acquisitionTime}`, acquisitionTime: undefined }));
    assert.equal(inferStudySequences(datetime).repeat.role, 't1c');
  });
  it('rejects a motion repeat, same-time reformats, and a later non-T1 acquisition', () => {
    assert.equal(inferStudySequences(repeatedStudy().filter(s => s.id !== 'coronal')).repeat.role, 't1');
    assert.equal(inferStudySequences(repeatedStudy().map(s => s.id === 'repeat' ? { ...s, acquisitionTime: '011030' } : s)).repeat.role, 't1');
    assert.equal(inferStudySequences(repeatedStudy().map(s => s.id === 't2' ? { ...s, acquisitionTime: '011400' } : s)).repeat.role, 't1');
  });
  it('does not override explicit precontrast, ignore known postcontrast, or cross study/patient boundaries', () => {
    assert.equal(inferStudySequences(repeatedStudy().map(s => s.id === 'repeat' ? { ...s, description: 'T1 PRE' } : s)).repeat.role, 't1');
    const known = inferStudySequences(repeatedStudy().map(s => s.id === 'coronal' ? { ...s, contrastBolusAgent: 'Gadobutrol' } : s));
    assert.equal(known.repeat.role, 't1'); assert.equal(known.coronal.role, 't1c');
    assert.equal(inferStudySequences(repeatedStudy().map(s => s.id === 'coronal' ? { ...s, studyUid: 'other-study' } : s)).repeat.role, 't1');
    assert.equal(inferStudySequences(repeatedStudy().map(s => s.id === 'coronal' ? { ...s, patientId: 'other-patient' } : s)).repeat.role, 't1');
    const nextDay = repeatedStudy().map(s => ({ ...s, acquisitionDateTime: `${s.id === 'coronal' ? '20261104' : '20261103'}${s.acquisitionTime}` }));
    assert.equal(inferStudySequences(nextDay).repeat.role, 't1');
  });
  it('keeps copied precontrast tags from corrupting enhancement and the ranked differential', () => {
    const before = volume({ description: 'T1 PRE', contrastBolusAgent: 'copied agent', repetitionTime: 500, echoTime: 10 }); before.data[0] = 50;
    const after = volume({ id: 'after', uid: 'after', description: 'neck', contrastBolusAgent: 'Gadobutrol', repetitionTime: 500, echoTime: 10 }); after.data[0] = 100;
    const sequences = inferStudySequences([before.series, after.series]);
    assert.equal(sequences.one.role, 't1'); assert.equal(sequences.after.role, 't1c');
    const measured = measureStudy([before, after], [mark('l', lesion, 'lesion'), mark('r', reference, 'reference')], sequences);
    assertFields(measured.findings, { t1: 'hipo', kontrast: 'belirgin' });
    const result = rank(measured.findings, [candidate({ t1: ['hipo'], kontrast: 'yok' }, { id: 'nonenhancing' }), candidate({ t1: ['hipo'], kontrast: 'belirgin' }, { id: 'enhancing' })]);
    assert.deepEqual(result.ranked.map(r => r.candidate.id), ['enhancing', 'nonenhancing']);
    assert.equal(result.ranked[0].match, 1); assertClose(result.ranked[1].match, 0.35);
  });
});

describe('patient-space ROI sampling', () => {
  it('uses ties-to-even at positive and negative half voxels', () => assert.deepEqual([-1.5, -0.5, 0.5, 1.5, 2.5].map(roundEven), [-2, 0, 0, 2, 2]));
  it('computes mean and standard deviation over samples, with distinct voxel count', () => {
    const v = volume(); v.data[0] = 2; v.data[1] = 8;
    const reading = samplePoints(v, [[0, 0, 0], [0.4, 0, 0], [1, 0, 0]])!;
    assert.equal(reading.mean, 4); assertClose(reading.std, Math.sqrt(8)); assert.equal(reading.voxels, 2);
  });
  it('does not cross a signal threshold because of running-mean rounding', () => {
    const v = volume({ dimensions: [20, 1, 1] });
    v.data = new Float32Array([0, 0, 200, 200, 200, 0, 0, 0, 0, 0, 0, 200, 200, 0, 200, 200, 0, 200, 200, 200]);
    const result = samplePoints(v, Array.from({ length: 20 }, (_, i) => [i, 0, 0] as Vec3))!;
    assert.equal(result.mean, 100);
    assert.equal(level(result.mean / 80), 'izo');
  });
  it('keeps Float64 source precision and stable variance for large offsets', () => {
    const v = volume();
    v.data = new Float64Array(v.data.length).fill(2 ** 40);
    v.data[0] = 2 ** 40 + 0.5; v.data[1] = 2 ** 40 + 1.5;
    const result = samplePoints(v, [[0, 0, 0], [1, 0, 0]])!;
    assert.equal(result.mean, 2 ** 40 + 1); assert.equal(result.std, 0.5);
  });
  it('requires at least 80% of sampled points inside the volume', () => {
    const points = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [99, 0, 0]] as Vec3[];
    assert.equal(samplePoints(volume(), points)?.coverage, 0.8);
    assert.equal(samplePoints(volume(), [...points, [99, 0, 0]]), null);
  });
  it('reports excluded non-finite and outside samples without changing the 80% acceptance boundary', () => {
    const v = volume({ dimensions: [10, 1, 1] }); v.data[4] = Number.NaN;
    const points = [...Array.from({ length: 9 }, (_, i) => [i, 0, 0] as Vec3), [99, 0, 0] as Vec3];
    const result = samplePoints(v, points)!;
    assertFields(result, { mean: 100, std: 0, samples: 10, coverage: 0.8, invalidSamples: 1, outsideSamples: 1 });
    assert.equal(samplePoints(v, [...points, [99, 0, 0]]), null);
    const invalid = volume(); invalid.data.fill(Number.POSITIVE_INFINITY);
    assert.equal(samplePoints(invalid, [[0, 0, 0]]), null);
  });
  it('surfaces accepted partial ROI coverage in readings, visible warnings and the copied summary', () => {
    const v = volume(); v.data[1 * 5 + 1] = Number.NaN;
    const broadLesion = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]] as Vec3[];
    const measurement = measureStudy([v], [mark('l', broadLesion, 'lesion'), mark('r', reference, 'reference')], { one: { role: 't2', bValue: null, basis: '' } });
    assertFields(measurement.readings[0].lesion, { coverage: 15 / 16, invalidSamples: 1, outsideSamples: 0, mean: 100 });
    assert.equal(measurement.readings[0].ratio, 1);
    assert.equal(measurement.findings.t2, 'izo');
    assert.ok(measurement.readings[0].issue.includes('93.75% valid coverage'));
    assert.ok(measurement.warnings[0].includes('excluded 1 non-finite and 0 outside-image samples'));
    const summary = assessmentSummary({ region: '', patient: { age: null, sex: null }, findings: measurement.findings, measurement, ranked: [], note: '' });
    assert.ok(summary.includes('93.75% valid coverage'));
    assert.ok(summary.includes('excluded 1 non-finite and 0 outside-image samples'));
  });
  it('uses each source frame geometry and preview offset without inventing a volume affine', () => {
    const v = volume({ canReconstruct: false, frameMetadata: [
      { origin: [0, 0, 0], direction: baseSeries.direction, spacing: [1, 1, 1] },
      { origin: [10, 20, 30], direction: [0, -1, 0, 1, 0, 0, 0, 0, 1], spacing: [2, 3, 4] },
    ] });
    v.data[36] = 777;
    assert.equal(samplePoints(v, [[4, 22, 30]], 1)?.mean, 777);
    assert.equal(samplePoints(v, [[4, 22, 30]]), null);
    const preview: Volume = { ...v, data: v.data.slice(25, 50), sourceFrameIndex: 1 };
    assert.equal(samplePoints(preview, [[4, 22, 30]])?.mean, 777);
    assert.equal(samplePoints(preview, [[0, 0, 0]], 0), null);
  });
  it('combines explicitly marked irregular source frames in their own geometry', () => {
    const v = volume({ canReconstruct: false, frameMetadata: [
      { origin: [0, 0, 0], direction: baseSeries.direction, spacing: [1, 1, 1] },
      { origin: [100, 0, 0], direction: baseSeries.direction, spacing: [1, 1, 1] },
    ] });
    v.data.fill(100, 0, 25); v.data.fill(200, 25); v.data[0] = 50; v.data[25] = 300;
    const sourceMark = (frame: number, kind: RoiMark['kind']) => {
      const start = kind === 'lesion' ? 0 : 3;
      const outline: Vec3[] = [[start, start, 0], [start + 0.75, start, 0], [start + 0.75, start + 0.75, 0], [start, start + 0.75, 0]];
      const result = mark(`${kind}${frame}`, outline.map(p => [p[0] + frame * 100, p[1], p[2]]), kind);
      result.annotation.mode = 'source'; result.annotation.sourceFrame = frame; result.annotation.slice = frame;
      return result;
    };
    const result = measureStudy([v], [sourceMark(0, 'lesion'), sourceMark(1, 'lesion'), sourceMark(0, 'reference'), sourceMark(1, 'reference')], { one: { role: 't2', bValue: null, basis: '' } });
    assertFields(result.readings[0].lesion, { mean: 175, voxels: 2 });
    assertFields(result.readings[0].reference, { mean: 150, voxels: 2, sampling: 'source-voxels' });
    assertClose(result.readings[0].ratio, 7 / 6);
  });
  it('matches viewport source ROI mean, SD, extrema and edge inclusion exactly', () => {
    const v = volume(); v.data.fill(10); v.data[2] = 1000;
    const source = mark('source', [[-0.25, -0.25, 0], [2.75, -0.25, 0], [2.75, 0.75, 0], [-0.25, 0.75, 0]], 'lesion');
    source.annotation.mode = 'source'; source.annotation.sourceFrame = 0;
    const ref = mark('ref', [[3, 3, 0], [3.75, 3, 0], [3.75, 3.75, 0], [3, 3.75, 0]], 'reference');
    ref.annotation.mode = 'source'; ref.annotation.sourceFrame = 0;
    const expected = roiStatistics(source.annotation, v)!;
    const measured = measureStudy([v], [source, ref], { one: { role: 't2', bValue: null, basis: '' } }).readings[0];
    assert.equal(expected.count, 3); assert.equal(expected.mean, 340); assert.equal(expected.min, 10); assert.equal(expected.max, 1000);
    assertClose(expected.standardDeviation, Math.sqrt(217800));
    assertFields(measured.lesion, { mean: expected.mean, std: expected.standardDeviation, min: 10, max: 1000, voxels: 3, sampling: 'source-voxels' });
    assert.equal(measured.reference?.voxels, 1);
  });
  it('keeps the exact source-ROI 1.25 signal boundary despite uneven accumulation order', () => {
    const v = volume({ dimensions: [21, 1, 1] });
    v.data = new Float32Array([0, 0, 200, 200, 200, 0, 0, 0, 0, 0, 0, 200, 200, 0, 200, 200, 0, 200, 200, 200, 80]);
    const source = mark('l', [[-0.25, -0.25, 0], [19.25, -0.25, 0], [19.25, 0.25, 0], [-0.25, 0.25, 0]], 'lesion');
    const ref = mark('r', [[19.75, -0.25, 0], [20.25, -0.25, 0], [20.25, 0.25, 0], [19.75, 0.25, 0]], 'reference');
    for (const item of [source, ref]) { item.annotation.mode = 'source'; item.annotation.sourceFrame = 0; }
    assert.equal(roiStatistics(source.annotation, v)?.mean, 100);
    const result = measureStudy([v], [source, ref], { one: { role: 't2', bValue: null, basis: '' } });
    assert.equal(result.readings[0].ratio, 1.25); assert.equal(result.findings.t2, 'izo');
  });
  it('excludes declared modality padding with the actual decoded float precision', () => {
    const v = volume({ dimensions: [5, 1, 1], pixelType: 'float32', paddingRange: [-3276.8, -3276.8] });
    v.data[4] = -3276.8;
    const result = samplePoints(v, Array.from({ length: 5 }, (_, i) => [i, 0, 0] as Vec3))!;
    assertFields(result, { mean: 100, coverage: 0.8, paddingSamples: 1, invalidSamples: 0 });
    v.data[4] = -3276.7;
    assert.equal(samplePoints(v, [[4, 0, 0]])?.paddingSamples, 0);
  });
  it('maps translated, anisotropic and sheared patient coordinates through the full inverse', () => {
    const v = volume({ origin: [10, -5, 8], spacing: [2, 3, 4], direction: [1, 0, 0.2, 0, 1, 0, 0, 0, 1] });
    v.data[(1 * 5 + 2) * 5 + 3] = 751;
    assert.equal(samplePoints(v, [[16.8, 1, 12]])?.mean, 751);
  });
  it('rejects nonplanar, degenerate and RGB measurements', () => {
    assert.deepEqual(regionPoints([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), []);
    assert.deepEqual(regionPoints([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 2]]), []);
    assert.equal(samplePoints(volume({ components: 3 }), [[0, 0, 0]]), null);
  });
  it('fills an oblique ROI within its plane and expands ellipse corners to the curved outline', () => {
    const outline = [[0, 0, 0], [2, 0, 2], [2, 2, 2], [0, 2, 0]] as Vec3[];
    const points = regionPoints(outline);
    assert.ok(points.length > 10); assert.equal(points.every(p => Math.abs(p[0] - p[2]) < 1e-9), true);
    const ellipse: Annotation = { id: 'e', type: 'ellipse', plane: 'axial', slice: 0, points: [[0, 0, 0], [4, 0, 0], [4, 2, 0], [0, 2, 0]] };
    assert.equal(annotationOutline(ellipse).length, 96);
    assert.deepEqual(annotationOutline(ellipse)[0], [4, 1, 0]);
  });
  it('blocks overlapping lesion and reference ROIs', () => {
    const result = measureStudy([volume()], [mark('l', lesion, 'lesion'), mark('r', lesion, 'reference')], { one: { role: 't2', bValue: null, basis: '' } });
    assert.match(result.blockers[0], /overlap/);
  });
  it('does not transfer ROIs across patients, different coordinate frames or invalid geometry', () => {
    const marks = [mark('l', lesion, 'lesion'), mark('r', reference, 'reference')];
    const sequences: Record<string, SequenceChoice> = { one: { role: 't1', bValue: null, basis: '' }, two: { role: 't2', bValue: null, basis: '' } };
    for (const change of [{ studyUid: 'other' }, { frameOfReferenceUid: 'other' }, { frameOfReferenceUid: undefined }, { canReconstruct: false }, { spacingKnown: false }]) {
      const result = measureStudy([volume(), volume({ id: 'two', ...change })], marks, sequences);
      assert.equal(result.readings.find(r => r.seriesId === 'two')?.ratio, null);
    }
  });
  it('prefers diffusion marks on diffusion series and ordinary marks on other sequences', () => {
    const t1 = volume(), dwi = volume({ id: 'dwi' }), adc = volume({ id: 'adc' });
    t1.data[0] = 150; t1.data[1] = 80;
    dwi.data[0] = 90; dwi.data[1] = 200;
    adc.data[0] = 90; adc.data[1] = 50;
    const smallDiffusionRoi = [[1, 0, 0], [1.2, 0, 0], [1.2, 0.2, 0], [1, 0.2, 0]] as Vec3[];
    const marks = [mark('normal-lesion', lesion, 'lesion', 'one', 1), mark('reference', reference, 'reference', 'one', 2), mark('diffusion-lesion', smallDiffusionRoi, 'lesion', 'dwi', 100)];
    const result = measureStudy([t1, dwi, adc], marks, { one: { role: 't1', bValue: null, basis: '' }, dwi: { role: 'dwi', bValue: 1000, basis: '' }, adc: { role: 'adc', bValue: null, basis: '' } });
    assert.deepEqual(result.readings.map(r => r.ratio), [1.5, 2, 0.5]);
    assert.equal(result.findings.dwi, 'kisitli');
  });
  it('does not compare ROI overlap in unrelated coordinate frames', () => {
    const result = measureStudy([volume(), volume({ id: 'two', frameOfReferenceUid: 'other' })],
      [mark('l', lesion, 'lesion'), mark('r', lesion, 'reference', 'two')],
      { one: { role: 't1', bValue: null, basis: '' }, two: { role: 't2', bValue: null, basis: '' } });
    assert.deepEqual(result.blockers, []);
  });
  it('selects the highest known positive DWI b value and preserves missing-b ambiguity', () => {
    const v1 = volume(), v2 = volume({ id: 'two' }), adc = volume({ id: 'adc' });
    for (const point of regionPoints(lesion)) {
      const offset = (roundEven(point[2]) * 5 + roundEven(point[1])) * 5 + roundEven(point[0]);
      v1.data[offset] = 100; v2.data[offset] = 150; adc.data[offset] = 90;
    }
    const marks = [mark('l', lesion, 'lesion'), mark('r', reference, 'reference')];
    const sequences: Record<string, SequenceChoice> = { one: { role: 'dwi', bValue: 0, basis: '' }, two: { role: 'dwi', bValue: 1000, basis: '' }, adc: { role: 'adc', bValue: null, basis: '' } };
    assert.equal(measureStudy([v1, v2, adc], marks, sequences).findings.dwi, 'kisitli');
    sequences.two.bValue = null;
    const missing = measureStudy([v1, v2, adc], marks, sequences);
    assert.equal(missing.findings.dwi, null); assert.match(missing.warnings.join(' '), /known b value/);
  });
});

describe('sequence and summary handling', () => {
  it('excludes localizers and preserves different MR roles', () => {
    assert.equal(inferSequence({ ...baseSeries, description: 'T1 LOCALIZER' }).role, null);
    assert.equal(inferSequence({ ...baseSeries, description: 'Ax T1 +C' }).role, 't1c');
    assert.equal(inferSequence({ ...baseSeries, description: 'T2 FLAIR' }).role, 'flair');
    for (const description of ['T1 kontrastsiz', 'T1 W/O contrast', 'T1 WO contrast', 'T1 pre contrast']) assert.equal(inferSequence({ ...baseSeries, description }).role, 't1');
    assert.equal(inferSequence({ ...baseSeries, description: 'T1 GD' }).role, 't1c');
    assert.equal(inferSequence({ ...baseSeries, description: 'ep2d_diff_tra', diffusionBValue: 1000, repetitionTime: 3500, echoTime: 80 }).role, 'dwi');
    assert.equal(inferSequence({ ...baseSeries, description: 'T2*', repetitionTime: 3500, echoTime: 80 }).role, null);
    assert.equal(inferSequence({ ...baseSeries, description: 'eADC', diffusionBValue: 1000 }).role, null);
    assert.equal(inferSequence({ ...baseSeries, description: 'DWI b1000', diffusionBValue: 800 }).bValue, 800);
    assert.equal(inferSequence({ ...baseSeries, description: 'sequence 2', repetitionTime: 2500, echoTime: 80 }).role, 't2');
  });
  it('finds regions using aliases and Turkish dotted or dotless i', () => {
    // Synthetic regions: the knowledge base's own are kept outside the repository (src/domain/clinical.ts).
    const synthetic = [
      { id: 'kt.spa', name: 'Serebellopontin açı', aliases: ['CPA', 'IAC'] },
      { id: 'kt.petroz_apeks', name: 'Petroz apeks', aliases: ['PET'] },
      { id: 'temporal.ic_kulak', name: 'İç kulak', aliases: [] },
    ];
    const ids = (query: string) => searchRegions(query, synthetic).map(r => r.id);
    assert.ok(ids('CPA').includes('kt.spa'));
    assert.ok(ids('PET').includes('kt.petroz_apeks'));
    assert.deepEqual(ids('İÇ KULAK'), ['temporal.ic_kulak']);
    assert.deepEqual(ids('PONTİN AÇI'), ['kt.spa']);
    // ç is not c.
    assert.deepEqual(ids('ıc kulak'), []);
    assert.deepEqual(ids('ıac'), ['kt.spa']);
  });
  it('reads DICOM and legacy age units', () => {
    assert.equal(parseAge('024M'), 2); assertClose(parseAge('10 ay'), 10 / 12); assert.equal(parseAge('unknown'), null);
  });
  it('omits image identifiers and uses an age band in the copied summary', () => {
    const input = volume({ description: 'SECRET SERIES', patientName: 'SECRET NAME', patientId: 'SECRET ID', patientAge: 43 });
    const measurement = measureStudy([input], [], { one: { role: 't2', bValue: null, basis: '' } });
    const ranked = rank({ t1: 'hipo' }, [candidate({ t1: ['hipo'] }, { patient: { yas: [20, 60] } })], { age: 43, sex: 'K' }).ranked;
    const summary = assessmentSummary({ region: 'kt.spa', patient: { age: 43, sex: 'K' }, findings: { t1: 'hipo' }, measurement, ranked, note: 'Review diffusion.', manualFeatures: ['t1'] });
    assert.ok(!summary.includes('43 years')); assert.ok(summary.includes('clinician selected'));
    assert.ok(summary.includes('40–44 years')); assert.ok(summary.includes('Review diffusion.')); assert.ok(!summary.includes('SECRET'));
    assert.ok(summary.includes('not diagnostic probabilities'));
    assert.ok(summary.includes('Available sequences: T2'));
    const infant = assessmentSummary({ region: '', patient: { age: 0.25, sex: null }, findings: {}, measurement, ranked: [], note: '', lesionSlices: 3 });
    assert.ok(infant.includes('under 1 year')); assert.ok(infant.includes('span 3 slices'));
  });
});


describe('background measurement protocol', () => {
  it('stages bounded transferred copies, validates completion and dtype, and cancels stale generations', async () => {
    const scope = globalThis as unknown as { onmessage?: (event: MessageEvent<ClinicalWorkerRequest>) => void; postMessage?: (result: ClinicalWorkerResult) => void };
    const previousMessage = scope.onmessage, previousPost = scope.postMessage;
    try {
      await import('../src/domain/clinical.worker');
      const dispatch = (data: ClinicalWorkerRequest) => scope.onmessage!({ data } as MessageEvent<ClinicalWorkerRequest>);
      const request = (data: ClinicalWorkerRequest) => new Promise<ClinicalWorkerResult>(resolve => { scope.postMessage = resolve; dispatch(data); });
      const input = volume(); input.data[0] = 150;
      const descriptor = (version: number): ClinicalVolumeDescriptor => ({ series: input.series, version, pixelType: 'float32', byteLength: input.data.byteLength });
      const marks = [mark('l', lesion, 'lesion'), mark('r', reference, 'reference')];
      const sequences: Record<string, SequenceChoice> = { one: { role: 't2', bValue: null, basis: '' } };
      const chunk = (id: number, offset: number, count: number) => {
        const copy = new Uint8Array(count);
        copy.set(new Uint8Array(input.data.buffer, input.data.byteOffset + offset, count));
        dispatch(structuredClone({ type: 'chunk', id, seriesId: 'one', offset, bytes: copy.buffer } as ClinicalWorkerRequest, { transfer: [copy.buffer] }));
        assert.equal(copy.byteLength, 0);
        assert.equal(input.data.byteLength, 200);
      };
      assertFields(await request({ type: 'begin', id: 1, volumes: [descriptor(1)] }), { type: 'ready', missing: ['one'] });
      dispatch({ type: 'start', id: 1, seriesId: 'one' }); chunk(1, 0, 80); chunk(1, 80, 120);
      assertFields(await request({ type: 'commit', id: 1, seriesId: 'one' }), { type: 'committed' });
      const first = await request({ type: 'measure', id: 1, marks, sequences });
      if (first.type !== 'result') throw new Error('Expected a complete measurement.');
      assert.deepEqual(first.measurement, measureStudy([input], marks, sequences));
      assert.equal(first.measurement.findings.t2, 'hiper');
      assertFields(await request({ type: 'begin', id: 2, volumes: [descriptor(1)] }), { type: 'ready', missing: [] });
      const cached = await request({ type: 'measure', id: 2, marks, sequences });
      if (cached.type !== 'result') throw new Error('Expected cached measurement.');
      assert.deepEqual(cached.measurement, first.measurement);
      const moved = { ...descriptor(1), series: { ...input.series, origin: [1, 0, 0] as Vec3 } };
      assertFields(await request({ type: 'begin', id: 3, volumes: [moved] }), { type: 'ready', missing: [] });
      const movedResult = await request({ type: 'measure', id: 3, marks, sequences });
      if (movedResult.type !== 'result') throw new Error('Expected measurement with refreshed geometry.');
      assert.equal(movedResult.measurement.readings[0].lesion, null);
      await request({ type: 'begin', id: 4, volumes: [] });
      assertFields(await request({ type: 'begin', id: 5, volumes: [descriptor(1)] }), { type: 'ready', missing: ['one'] });
      dispatch({ type: 'start', id: 5, seriesId: 'one' }); chunk(5, 0, 80);
      assertFields(await request({ type: 'commit', id: 5, seriesId: 'one' }), { type: 'error', message: 'Image upload is incomplete.' });
      await request({ type: 'begin', id: 6, volumes: [descriptor(2)] });
      dispatch({ type: 'start', id: 6, seriesId: 'one' }); chunk(6, 0, 80); dispatch({ type: 'cancel', id: 6 });
      assertFields(await request({ type: 'begin', id: 7, volumes: [descriptor(3)] }), { type: 'ready', missing: ['one'] });
      chunk(6, 80, 120); dispatch({ type: 'commit', id: 6, seriesId: 'one' });
      dispatch({ type: 'begin', id: 6, volumes: [] });
      input.data[0] = 75;
      dispatch({ type: 'start', id: 7, seriesId: 'one' }); chunk(7, 0, 200);
      await request({ type: 'commit', id: 7, seriesId: 'one' });
      const replacement = await request({ type: 'measure', id: 7, marks, sequences });
      if (replacement.type !== 'result') throw new Error('Expected replacement image measurement.');
      assert.deepEqual(replacement.measurement, measureStudy([input], marks, sequences));
      assert.equal(replacement.measurement.findings.t2, 'hipo');
      await request({ type: 'begin', id: 8, volumes: [descriptor(4)] });
      assertFields(await request({ type: 'measure', id: 8, marks, sequences }), { type: 'error', message: 'Image upload must complete before measurement.' });
      await request({ type: 'begin', id: 9, volumes: [descriptor(5)] }); dispatch({ type: 'start', id: 9, seriesId: 'one' });
      assertFields(await request({ type: 'chunk', id: 9, seriesId: 'one', offset: 4, bytes: new ArrayBuffer(20) }), { type: 'error', message: 'Invalid or out-of-order image chunk.' });
      assertFields(await request({ type: 'begin', id: 10, volumes: [{ ...descriptor(6), pixelType: 'uint16' }] }), { type: 'error', message: 'Image byte count does not match its dimensions and pixel type.' });
      const oversized: ClinicalVolumeDescriptor = { ...descriptor(7), series: { ...input.series, dimensions: [134217729, 1, 1] }, byteLength: 512 * 1024 * 1024 + 4 };
      const blocked = await request({ type: 'begin', id: 11, volumes: [oversized] });
      assert.equal(blocked.type, 'error'); if (blocked.type === 'error') assert.ok(blocked.message.includes('512 MB'));
      const preview = { ...descriptor(8), byteLength: 100, sourceFrameIndex: 1 };
      assertFields(await request({ type: 'begin', id: 12, volumes: [preview] }), { type: 'ready', missing: ['one'] });
      dispatch({ type: 'start', id: 12, seriesId: 'one' });
      const bytes = input.data.buffer.slice(100, 200) as ArrayBuffer;
      dispatch({ type: 'chunk', id: 12, seriesId: 'one', offset: 0, bytes });
      assertFields(await request({ type: 'commit', id: 12, seriesId: 'one' }), { type: 'committed' });
      const invalidPreview = await request({ type: 'begin', id: 13, volumes: [{ ...preview, sourceFrameIndex: 2 }] });
      assertFields(invalidPreview, { type: 'error', message: 'Invalid source frame index.' });
    } finally {
      if (previousMessage) scope.onmessage = previousMessage; else delete scope.onmessage;
      if (previousPost) scope.postMessage = previousPost; else delete scope.postMessage;
    }
  });
});
