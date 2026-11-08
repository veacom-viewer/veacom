import assert from 'node:assert/strict';
import { it } from 'node:test';
import { petTracer } from '../src/imaging/petTracer';

it('identifies FDG from the radiopharmaceutical and its coding scheme', () => {
  assert.equal(petTracer({ tracerCode: 'C-B1031', tracerCodeScheme: 'SRT' }), 'fdg');
  assert.equal(petTracer({ tracerCode: '35321007', tracerCodeScheme: 'SCT' }), 'fdg');
  assert.equal(petTracer({ tracer: '[18F]FDG' }), 'fdg');
  assert.equal(petTracer({ tracer: 'Ga-68 PSMA-11' }), 'other');
  assert.equal(petTracer({ tracerCode: '35321007', tracerCodeScheme: '99LOCAL' }), 'other');
  assert.equal(petTracer({ tracer: 'FDG', multipleAdministrations: true }), 'multiple');
  assert.equal(petTracer({}), 'unknown');
});
