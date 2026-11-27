import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getPlaneFrame, sliceAtWorld } from '../src/imaging/geometry';
import { openingSlice } from '../src/imaging/paging';
import type { Series, Volume } from '../src/model';
import {
  atPlaceOf,
  clockText,
  defaultView,
  projectMprCrosshair,
  readSettings,
  sameTilt,
  sourceFrameForView,
  windowClass,
  type Slot,
} from '../src/ui/workspaceHelpers';

function ctSeries(id = 'ct-1', slices = 20): Series {
  return {
    id,
    uid: `1.2.3.${id}`,
    studyUid: '1.2.3.study',
    studyDate: '20260101',
    seriesNumber: 1,
    patientName: 'Synthetic^Patient',
    patientId: 'SYNTH-1',
    modality: 'CT',
    description: 'Synthetic CT',
    dimensions: [64, 64, slices],
    spacing: [1, 1, 2],
    origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    frameOfReferenceUid: '1.2.3.for',
    canReconstruct: true,
    orientationKnown: true,
    pixelType: 'int16',
    components: 1,
    photometricInterpretation: 'MONOCHROME2',
    valueUnit: 'HU',
    suvFactor: null,
    windowCenter: 40,
    windowWidth: 400,
    warnings: [],
  };
}

function makeVolume(series: Series): Volume {
  const count = series.dimensions[0] * series.dimensions[1] * series.dimensions[2];
  return { series, data: new Int16Array(count) };
}

describe('workspaceHelpers', () => {
  it('formats durations as m:ss and h:mm:ss', () => {
    assert.equal(clockText(-500), '0:00');
    assert.equal(clockText(65_000), '1:05');
    assert.equal(clockText(3_661_000), '1:01:01');
  });

  it('inherits series voiFunction in defaultView only when the opening frame lacks its own windowWidth', () => {
    const base = ctSeries('ct-voi', 2);
    const seriesLevel: Series = { ...base, windowWidth: 0.5, windowCenter: 0.25, voiFunction: 'LINEAR_EXACT' };
    assert.equal(defaultView(seriesLevel).windowWidth, 0.5);

    const openIndex = openingSlice(seriesLevel);
    const frameMetadata = Array.from({ length: 2 }, (_, i) => ({
      sopInstanceUid: String(i + 1),
      origin: [0, 0, i * 2] as [number, number, number],
      direction: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number],
      spacing: [1, 1, 2] as [number, number, number],
      ...(i === openIndex ? { windowWidth: 0.5, windowCenter: 0.25 } : {}),
    }));
    const frameOwned: Series = { ...seriesLevel, frameMetadata };
    // Frame defines windowWidth without voiFunction -> DICOM LINEAR clamps < 1 to 1.
    assert.equal(defaultView(frameOwned).windowWidth, 1);
  });

  it('projects MPR crosshair onto paged planes without drifting unrelated axes', () => {
    const volume = makeVolume(ctSeries('ct-mpr', 30));
    const volumes = new Map<string, Volume>([[volume.series.id, volume]]);
    const axial = { ...defaultView(volume.series), mode: 'mpr' as const, plane: 'axial' as const, slice: 10 };
    const sagittal = { ...defaultView(volume.series), mode: 'mpr' as const, plane: 'sagittal' as const, slice: 32 };
    const before: Slot[] = [
      { id: 's1', seriesId: volume.series.id, view: axial },
      { id: 's2', seriesId: volume.series.id, view: sagittal },
    ];
    const after: Slot[] = [
      { id: 's1', seriesId: volume.series.id, view: { ...axial, slice: 15 } },
      { id: 's2', seriesId: volume.series.id, view: sagittal },
    ];
    const startPoint = getPlaneFrame(volume.series, axial).center;
    const projected = projectMprCrosshair(before, after, startPoint, volume.series.id, volumes);
    assert.equal(projected[0], startPoint[0]);
    assert.equal(projected[1], startPoint[1]);
    assert.equal(projected[2], getPlaneFrame(volume.series, after[0].view).center[2]);
    // Unchanged tilt helper check.
    assert.equal(sameTilt(axial, after[0].view), true);
    assert.equal(sameTilt(axial, { ...axial, oblique: [5, 0] }), false);
  });

  it('maps reconstructed views back to nearest source frame and keeps shared-frame pane place', () => {
    const series = ctSeries('ct-a', 20);
    const other = ctSeries('ct-b', 20);
    const view = { ...defaultView(series), mode: 'mpr' as const, plane: 'axial' as const, slice: 12 };
    assert.equal(sourceFrameForView(series, view), sliceAtWorld(series, { ...view, mode: 'source', plane: 'axial' }, getPlaneFrame(series, view).center));
    const placed = atPlaceOf(other, defaultView(other), { series, view });
    assert.equal(placed.slice, 12);
  });

  it('classifies stored, preset, auto, manual, and rgb windows accurately', () => {
    const ct = makeVolume(ctSeries());
    const auto = new Map<string, string>([['slot-1', '250/50']]);
    assert.equal(windowClass(undefined, defaultView(ct.series), auto, 'slot-1'), 'none');
    assert.equal(windowClass(ct, defaultView(ct.series), auto, 'slot-1'), 'stored');
    assert.equal(windowClass(ct, { ...defaultView(ct.series), windowMode: 'manual', windowWidth: 1500, windowCenter: -400 }, auto, 'slot-1'), 'lung');
    assert.equal(windowClass(ct, { ...defaultView(ct.series), windowMode: 'manual', windowWidth: 250, windowCenter: 50 }, auto, 'slot-1'), 'auto');
    assert.equal(windowClass(ct, { ...defaultView(ct.series), windowMode: 'manual', windowWidth: 777, windowCenter: 123 }, auto, 'slot-1'), 'manual');
    const rgb: Volume = { series: { ...ct.series, components: 3 }, data: new Uint8Array(64 * 64 * 3) };
    assert.equal(windowClass(rgb, defaultView(rgb.series), auto, 'slot-1'), 'rgb');
  });

  it('falls back to safe defaults when localStorage is unavailable', () => {
    const settings = readSettings();
    assert.equal(settings.linked, true);
    assert.equal(settings.wheelAction, 'scroll');
    assert.equal(settings.cineFps, 10);
  });
});
