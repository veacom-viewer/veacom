import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

// Padding and missing values reach the shaders as NaN. On Windows, ANGLE's Direct3D shader compiler may
// optimise GLSL's isnan and isinf away (padding drew white in inverted images, and float pixels next to
// padding went dark), so the shaders test the exponent bits instead. This can only fail on Windows, so
// guard the source here.
describe('shader NaN tests', () => {
  for (const file of ['../src/imaging/sliceRenderer.ts', '../src/components/VolumeView.tsx']) {
    it(`${file.split('/').pop()} does not use isnan or isinf`, () => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /\bis(?:nan|inf)\s*\(/);
      assert.ok(source.includes('floatBitsToUint'));
    });
  }
});
