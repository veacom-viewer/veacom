import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Annotation, FrameMetadata, Series, Vec3 } from '../src/model';
import { getPlaneFrame } from '../src/imaging/geometry';
import { measurementEdits, measurementScope, recoverCalibration, recoverMeasurement, saveCalibration, saveMeasurement } from '../src/domain/measurementRecovery';

const direction = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const frames: FrameMetadata[] = [1, 2, 3].map((number, index) => ({
  sopInstanceUid: '1.2.345.10', sourceFrameNumber: number,
  origin: [0, 0, index], spacing: [1, 1, 1], direction, spacingKnown: true, positionKnown: true, orientationKnown: true,
}));
const series: Series = {
  id: 'stack', patientId: 'TEST-A', patientName: 'SYNTHETIC^SAME', patientKey: 'issued-test-id',
  studyUid: '1.2.345', uid: '1.2.345.2', frameOfReferenceUid: '1.2.345.11', seriesNumber: 1, studyDate: '',
  description: '', modality: 'CT', dimensions: [8, 8, 3], spacing: [1, 1, 1], origin: [0, 0, 0], direction,
  windowCenter: 40, windowWidth: 400, valueUnit: 'HU', suvFactor: null, canReconstruct: true,
  warnings: [], photometricInterpretation: 'MONOCHROME2', frameMetadata: frames,
};
const ruler: Annotation = {
  id: 'source-ruler', type: 'length', mode: 'source', sourceSopInstanceUid: frames[1].sopInstanceUid,
  sourceFrame: 1, sourceFrameNumber: 2, slice: 1, plane: 'axial', points: [[1, 2, 1], [5, 2, 1]],
  labelShift: [0, 2, 0], color: '#ffcc00',
};
const scopeOf = async (item: Series) => { const scope = await measurementScope(item); assert.ok(scope); return scope; };

describe('measurement recovery', () => {
  it('requires patient, study and series identity and stores digests for the source image', async () => {
    const scope = await scopeOf(series), record = await saveMeasurement(series, scope, ruler);
    for (const changed of [{ patientKey: 'other-issuer-patient' }, { studyUid: 'other-study' }, { uid: 'other-series' }]) {
      const other = { ...series, ...changed }, key = await scopeOf(other);
      assert.notEqual(key, scope);
      assert.equal(await recoverMeasurement(other, key, record), null);
    }
    for (const changed of [{ patientKey: undefined }, { studyUid: '' }, { uid: '' }]) assert.equal(measurementScope({ ...series, ...changed }), undefined);
    for (const raw of [series.patientKey!, series.patientName, series.patientId, series.studyUid, ruler.sourceSopInstanceUid!]) assert.ok(!JSON.stringify(record).includes(raw));
    assert.match(scope, /^[0-9a-f]{64}$/);
    assert.deepEqual(await recoverMeasurement(series, scope, record), ruler);
  });

  it('follows the exact frame through reordering, rejects missing or duplicated images and changed geometry', async () => {
    const scope = await scopeOf(series), record = await saveMeasurement(series, scope, ruler);
    const swapped = { ...series, frameMetadata: [frames[1], frames[2], frames[0]] };
    assert.deepEqual(await recoverMeasurement(swapped, scope, record), { ...ruler, slice: 0, sourceFrame: 0 });
    for (const metadata of [[frames[0], frames[2]], [frames[1], frames[1], frames[2]],
      [frames[0], { ...frames[1], origin: [4, 0, 1] as Vec3 }, frames[2]],
      [frames[0], { ...frames[1], spacingKnown: false }, frames[2]], undefined]) {
      assert.equal(await recoverMeasurement({ ...series, frameMetadata: metadata }, scope, record), null);
    }
    assert.equal(await recoverMeasurement({ ...series, frameOfReferenceUid: 'different' }, scope, record), null);
    await assert.rejects(saveMeasurement(series, scope, { ...ruler, sourceSopInstanceUid: undefined }), /reference/);
    await assert.rejects(saveMeasurement(series, scope, { ...ruler, points: [[0, 0, 0], [4, 1, 0]] }), /reference/);
  });

  it('binds an oblique drawing to its complete ordered reconstruction', async () => {
    const scope = await scopeOf(series), view = { slice: 3, plane: 'coronal' as const, mode: 'mpr' as const, oblique: [12, -5] as [number, number] };
    const a: Annotation = { id: 'oblique', type: 'text', label: 'Synthetic note', points: [getPlaneFrame(series, view).center], ...view };
    const record = await saveMeasurement(series, scope, a);
    assert.deepEqual(await recoverMeasurement({ ...series }, scope, record), a);
    for (const slice of [0, 100]) {
      assert.equal(await recoverMeasurement(series, scope, { ...record, drawing: { ...a, slice } }), null);
    }
    for (const changed of [{ canReconstruct: false }, { id: 'other-stack' }, { spacing: [1, 1, 2] as Vec3 },
      { frameMetadata: [...frames].reverse() }, { frameMetadata: frames.slice(1) }, { frameMetadata: [{ ...frames[0], sopInstanceUid: undefined }, ...frames.slice(1)] }]) {
      assert.equal(await recoverMeasurement({ ...series, ...changed }, scope, record), null);
    }
  });

  it('rejects damaged records without drawing them or changing a valid neighbour', async () => {
    const scope = await scopeOf(series), record = await saveMeasurement(series, scope, ruler);
    for (const row of [null, 1, {}, { ...record, id: 'different' }, { ...record, reference: 5 },
      ...[{ points: [[1, 1, 1]] }, { points: [[NaN, 0, 1], [1, 1, 1]] }, { label: 13 }, { color: 'invalid' }, { caliper: {} }, { oblique: [4] }]
        .map(change => ({ ...record, drawing: { ...record.drawing, ...change } }))]) {
      assert.equal(await recoverMeasurement(series, scope, row), null);
    }
    assert.deepEqual(await recoverMeasurement(series, scope, record), ruler);
  });

  it('writes only edited IDs and leaves PET sphere ownership with the PET record', () => {
    const renamed = { ...ruler, label: 'Renamed' }, other = { ...ruler, id: 'other' }, sphere: Annotation = { ...ruler, id: 'sphere', type: 'sphere' };
    assert.deepEqual(measurementEdits(series, [ruler, other], [renamed, sphere]), { put: [renamed, sphere], remove: ['other'] });
    assert.deepEqual(measurementEdits(series, [renamed, sphere], [ruler, other]), { put: [ruler, other], remove: ['sphere'] });
    assert.deepEqual(measurementEdits({ ...series, modality: 'PT' }, [ruler, sphere], [renamed]), { put: [renamed], remove: [] });
    assert.deepEqual(measurementEdits(series, [ruler], [ruler]), { put: [], remove: [] });
  });

  it('restores a film ruler on its own frame and a series scale only on its original grid', async () => {
    const scope = await scopeOf(series), film = { frame: 1, value: { method: 'ruler' as const, scale: 2, knownMm: 80 } };
    const saved = await saveCalibration(series, scope, film);
    const reordered = { ...series, frameMetadata: [frames[1], frames[0], frames[2]] };
    assert.deepEqual(await recoverCalibration(reordered, scope, saved.put), [{ ...film, frame: 0 }]);
    assert.deepEqual(await saveCalibration(reordered, scope, { frame: 0, value: null }), { id: saved.id });
    const grid = { frame: null, value: { method: 'scale' as const, scale: 3 } }, record = await saveCalibration(series, scope, grid);
    assert.deepEqual(await recoverCalibration(series, scope, record.put), [grid]);
    assert.deepEqual(await recoverCalibration(reordered, scope, record.put), [0, 1, 2].map(frame => ({ frame, value: grid.value })));
    const mixed = { ...series, frameMetadata: [frames[2], { ...frames[0], sopInstanceUid: 'unseen' }] };
    assert.deepEqual(await recoverCalibration(mixed, scope, record.put), [{ frame: 0, value: grid.value }]);
    const duplicated = { ...series, frameMetadata: [frames[0], { ...frames[0], direction: [...direction].reverse() }, frames[2]] };
    assert.deepEqual(await recoverCalibration(duplicated, scope, record.put), [{ frame: 2, value: grid.value }]);
    for (const change of [{ scope: 'other' }, { id: 'other' }, { calibration: { method: 'ruler', scale: -1, knownMm: 2 } },
      { calibration: { method: 'ball', scale: 1, knownMm: 5, depthConfirmed: 'yes' } }]) {
      assert.deepEqual(await recoverCalibration(series, scope, { ...saved.put, ...change }), []);
    }
  });
});
