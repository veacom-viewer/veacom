import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { imageExportName } from '../src/ui/exportName';

// A made-up series, named as DICOM writes a person's name.
const series = { patientName: 'SYNTHETIC^REVIEW', description: 'Axial 1 mm' };

describe('the folder a series\' pictures are exported into', () => {
  it('names the patient and the series when the pictures show them', () => {
    assert.equal(imageExportName(series, true), 'SYNTHETIC REVIEW - Axial 1 mm');
  });
  it('names neither when the pictures show no patient details', () => {
    assert.equal(imageExportName(series, false), 'VEAcom');
  });
  it('is plain when the series gives no name and no description', () => {
    assert.equal(imageExportName({ patientName: '', description: '' }, true), 'VEAcom');
    assert.equal(imageExportName(undefined, true), 'VEAcom');
  });
});
