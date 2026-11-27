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

  it('projects MPR crosshair onto paged planes, restored slices, and crosshair clicks without drifting tilted pivots', () => {
    const volume = makeVolume(ctSeries('ct-mpr', 30));
    const volumes = new Map<string, Volume>([[volume.series.id, volume]]);
    const axial = { ...defaultView(volume.series), mode: 'mpr' as const, plane: 'axial' as const, slice: 10 };
    const coronal = { ...defaultView(volume.series), mode: 'mpr' as const, plane: 'coronal' as const, slice: 30 };
    const sagittal = { ...defaultView(volume.series), mode: 'mpr' as const, plane: 'sagittal' as const, slice: 32 };
    const before: Slot[] = [
      { id: 's1', seriesId: volume.series.id, view: axial },
      { id: 's2', seriesId: volume.series.id, view: coronal },
      { id: 's3', seriesId: volume.series.id, view: sagittal },
    ];
    const after: Slot[] = [
      { id: 's1', seriesId: volume.series.id, view: { ...axial, slice: 15 } },
      { id: 's2', seriesId: volume.series.id, view: coronal },
      { id: 's3', seriesId: volume.series.id, view: sagittal },
    ];
    const startPoint: [number, number, number] = [32, 30, 20];
    const projected = projectMprCrosshair(before, after, startPoint, volume.series.id, volumes);
    assert.equal(projected[0], startPoint[0]);
    assert.equal(projected[1], startPoint[1]);
    assert.equal(projected[2], getPlaneFrame(volume.series, after[0].view).center[2]);

    // Undo restoring slice 15 -> 10 moves crosshair back to slice 10.
    const undone = projectMprCrosshair(after, before, projected, volume.series.id, volumes);
    assert.equal(undone[2], getPlaneFrame(volume.series, before[0].view).center[2]);

    // Rotating a plane (tilt changed) must leave the crosshair pivot untouched.
    const rotated: Slot[] = [
      { id: 's1', seriesId: volume.series.id, view: { ...axial, slice: 12, oblique: [15, 0] } },
      before[1],
      before[2],
    ];
    assert.equal(projectMprCrosshair(before, rotated, startPoint, volume.series.id, volumes), startPoint);

    // Clicking between integer slices with snapAll=true snaps onto all three displayed MPR planes.
    const expectedX = getPlaneFrame(volume.series, sagittal).center[0];
    const expectedY = getPlaneFrame(volume.series, coronal).center[1];
    const expectedZ = getPlaneFrame(volume.series, axial).center[2];
    const offSliceClick: [number, number, number] = [expectedX + 0.4, expectedY + 0.3, expectedZ + 0.4];
    const snapped = projectMprCrosshair(before, before, offSliceClick, volume.series.id, volumes, true);
    assert(Math.abs(snapped[0] - expectedX) < 1e-6);
    assert(Math.abs(snapped[1] - expectedY) < 1e-6);
    assert(Math.abs(snapped[2] - expectedZ) < 1e-6);

    // Oblique three-plane intersection: snapped point lies on all three displayed planes simultaneously.
    const tiltedCoronal = { ...coronal, oblique: [20, 0] as [number, number] };
    const tiltedSlice = sliceAtWorld(volume.series, tiltedCoronal, [expectedX, expectedY, expectedZ]);
    const obliqueSlots: Slot[] = [
      before[0],
      { id: 's2', seriesId: volume.series.id, view: { ...tiltedCoronal, slice: tiltedSlice } },
      before[2],
    ];
    const obliqueSnapped = projectMprCrosshair(obliqueSlots, obliqueSlots, offSliceClick, volume.series.id, volumes, true);
    for (const slot of obliqueSlots) {
      const frame = getPlaneFrame(volume.series, slot.view);
      const dist = Math.abs(
        (obliqueSnapped[0] - frame.center[0]) * frame.normal[0]
        + (obliqueSnapped[1] - frame.center[1]) * frame.normal[1]
        + (obliqueSnapped[2] - frame.center[2]) * frame.normal[2],
      ) / Math.hypot(...frame.normal);
      assert(dist < 1e-6, `snapped point off ${slot.view.plane} plane by ${dist}`);
    }

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
