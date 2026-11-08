import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldSearch, patientKey, searchText, sortStudySeries, studyKey } from '../src/ui/seriesNames';
import type { Series } from '../src/model';

const series = (patch: Partial<Series>) => ({ id: 's', uid: 'u', studyUid: 'st', patientId: 'P1', patientName: 'DOE^JANE', studyDate: '20260101', description: '', modality: 'MR',
  seriesNumber: 3, dimensions: [8, 8, 8], spacing: [1, 1, 1], origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 0, windowWidth: 1, valueUnit: '', suvFactor: null,
  canReconstruct: true, orientationKnown: true, warnings: [], photometricInterpretation: 'MONOCHROME2', ...patch }) as Series;

describe('series order', () => {
  it('separates identically labeled patients and reused study UIDs from two issuers', () => {
    const first = { id: 'a', patientId: 'LOCAL-1', patientName: 'SYNTHETIC', patientKey: 'site-A', studyUid: '2.25.1' } as Series;
    const second = { ...first, id: 'b', patientKey: 'site-B' };
    assert.notEqual(patientKey(first), patientKey(second));
    assert.notEqual(studyKey(first), studyKey(second));
  });
  it('keeps study and patient actions inside the selected birth-date group', () => {
    const selected = series({ id: 'first', patientBirthDate: '19800101' });
    const sibling = series({ id: 'second', patientBirthDate: '19800101' });
    const otherStudy = series({ id: 'third', studyUid: 'another-study', patientBirthDate: '19800101' });
    const otherPatient = series({ id: 'fourth', patientBirthDate: '19900101' });
    const items = [selected, sibling, otherStudy, otherPatient];
    assert.deepEqual(items.filter(item => studyKey(item) === studyKey(selected)), [selected, sibling]);
    assert.deepEqual(items.filter(item => patientKey(item) === patientKey(selected)), [selected, sibling, otherStudy]);
  });
  it('follows the series numbers, also when every series is named by a site code', () => {
    // As a Teletip download names them: the protocol number for every series.
    const named = (id: string, seriesNumber: number) => series({ id, uid: id, description: '517146096', seriesNumber });
    const listed = sortStudySeries([named('t2', 9), named('t1-post', 7), named('dwi', 3), named('t1-pre', 6)]);
    assert.deepEqual(listed.map(item => item.id), ['dwi', 't1-pre', 't1-post', 't2']);
  });
});

describe('series search', () => {
  it('forgives Turkish letters and case', () => {
    assert.equal(foldSearch('FIESTA'), 'fiesta');
    assert.equal(foldSearch('fıesta'), 'fiesta');
    assert.equal(foldSearch('Difüzyon'), 'difuzyon');
    assert.equal(foldSearch('Şırnak Çağ Öğür'), 'sirnak cag ogur');
  });
  it('finds a series by the words for its kind, in either language', () => {
    const dwi = searchText(series({ description: 'OBL' }), { role: 'dwi', plane: null, label: 'DWI b1000' });
    assert.ok(dwi.includes(foldSearch('difüzyon')));
    assert.ok(dwi.includes('diffusion'));
    const ssfp = searchText(series({ description: 'MR' }), { role: 'ssfp', plane: 'axial', label: 'CISS / FIESTA Aksiyel' });
    assert.ok(ssfp.includes(foldSearch('fıesta')));
    assert.ok(ssfp.includes('axial'));
    assert.ok(searchText(series({ modality: 'CT', description: 'Kemik' }), null).includes('bt'));
  });
});
