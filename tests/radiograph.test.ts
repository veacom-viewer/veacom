import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { Annotation, Projection, Series } from '../src/model';
import { annotationSummary } from '../src/imaging/annotations';
import { screenMapping, sourceFrameSeries } from '../src/imaging/geometry';
import { calibrationState, calibrationTag, calibrationText, filmKey, manualCalibration, millimetresPerPixel, pixelSpacingText, projectionEdgeLabels, projectionLine, sideText, withFilmCalibrations, type ManualCalibration } from '../src/imaging/radiograph';
import { setLocale } from '../src/i18n';

// A one-frame DX of 100 × 300 pixels, as the engine lists it: its frame carries the projection facts
// (native/src/projection.rs), and the series' spacing is the one the engine chose.
function film(projection: Projection | undefined, extra: Partial<Series> = {}): Series {
  const spacing = projection?.spacing;
  return {
    id: 'dx', uid: '1', studyUid: '2', patientId: 'SYNTHETIC', patientName: 'Synthetic', studyDate: '', description: 'Long leg',
    modality: 'DX', seriesNumber: 1, dimensions: [100, 300, 1], spacing: spacing ? [spacing[1], spacing[0], 1] : [1, 1, 1], origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 2048, windowWidth: 4096, valueUnit: '', suvFactor: null, canReconstruct: false,
    spacingKnown: Boolean(spacing), orientationKnown: false, warnings: [], photometricInterpretation: 'MONOCHROME2',
    frameMetadata: [{ origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], spacing: spacing ? [spacing[1], spacing[0], 1] : [1, 1, 1], spacingKnown: Boolean(spacing), orientationKnown: false, ...(projection ? { projection } : {}) }],
    ...extra,
  };
}

const detector: Projection = { basis: 'detector', spacing: [0.33, 0.33], imagerPixelSpacing: [0.33, 0.33], patientOrientation: ['L', 'F'], laterality: 'B' };
// Every combination of spacing tags the engine tells apart, by the basis it gives (native/src/projection.rs tests).
const cases: Array<{ name: string; projection: Projection | undefined; state: string; tag: string; text: string; mm: [number, number] | null }> = [
  { name: 'Nominal Scanned Pixel Spacing', projection: { basis: 'scanned', spacing: [0.33, 0.33] }, state: 'scanned', tag: 'scanned film', text: 'Nominal spacing on the scanned film', mm: [0.33, 0.33] },
  { name: 'Pixel Spacing only', projection: { basis: 'unstated', spacing: [0.3, 0.3], pixelSpacing: [0.3, 0.3] }, state: 'unstated', tag: 'calibration not stated', text: 'Pixel Spacing: correction not stated', mm: [0.3, 0.3] },
  { name: 'Imager Pixel Spacing only', projection: detector, state: 'detector', tag: 'detector plane', text: 'Detector plane, not corrected', mm: [0.33, 0.33] },
  { name: 'Imager Pixel Spacing and ERMF', projection: { basis: 'magnification', spacing: [0.3, 0.3], imagerPixelSpacing: [0.33, 0.33], magnification: 1.1 }, state: 'magnification', tag: 'ERMF ×1.10', text: 'Detector ÷ ERMF 1.10: table depth', mm: [0.3, 0.3] },
  { name: 'Pixel Spacing equal to Imager', projection: { basis: 'detector', spacing: [0.33, 0.33], pixelSpacing: [0.33, 0.33], imagerPixelSpacing: [0.33, 0.33] }, state: 'detector', tag: 'detector plane', text: 'Detector plane, not corrected', mm: [0.33, 0.33] },
  { name: 'GEOMETRY', projection: { basis: 'calibrated', spacing: [0.3, 0.3], pixelSpacing: [0.3, 0.3], imagerPixelSpacing: [0.33, 0.33], calibrationType: 'GEOMETRY' }, state: 'calibrated', tag: 'calibrated', text: 'Calibrated for magnification (GEOMETRY)', mm: [0.3, 0.3] },
  { name: 'FIDUCIAL', projection: { basis: 'calibrated', spacing: [0.3, 0.3], pixelSpacing: [0.3, 0.3], imagerPixelSpacing: [0.33, 0.33], calibrationType: 'FIDUCIAL' }, state: 'calibrated', tag: 'calibrated', text: 'Calibrated on an object (FIDUCIAL)', mm: [0.3, 0.3] },
  { name: 'Pixel Spacing differs, no type', projection: { basis: 'calibrated', spacing: [0.3, 0.3], pixelSpacing: [0.3, 0.3], imagerPixelSpacing: [0.33, 0.33] }, state: 'calibrated', tag: 'calibrated', text: 'Calibrated, method not stated', mm: [0.3, 0.3] },
  { name: 'no spacing', projection: { basis: 'none' }, state: 'pixels', tag: '', text: 'Pixels only', mm: null },
];

afterEach(() => { setLocale('en'); });

describe('the calibration of a projection film', () => {
  for (const item of cases) {
    it(`names ${item.name} in the pane and after each size`, () => {
      const series = sourceFrameSeries(film(item.projection), 0);
      assert.equal(calibrationState(series), item.state);
      assert.equal(calibrationTag(series), item.tag);
      assert.equal(calibrationText(series), item.text);
      assert.deepEqual(millimetresPerPixel(series), item.mm);
      assert.equal(projectionLine(series), `Both sides · ${item.text}`.replace('Both sides', item.projection?.laterality === 'B' ? 'Both sides' : 'Side not recorded'));
    });
  }

  it('says nothing new for a cross-section', () => {
    const ct = film(undefined, { modality: 'CT', spacing: [0.5, 0.5, 1], spacingKnown: true });
    assert.equal(calibrationState(ct), 'patient');
    assert.equal(calibrationTag(ct), '');
    assert.equal(projectionLine(ct), '');
    const length: Annotation = { id: 'l', type: 'length', points: [[0, 0, 0], [30, 40, 0]], plane: 'axial', slice: 0, mode: 'mpr' };
    assert.equal(annotationSummary(length, { series: { ...ct, dimensions: [100, 100, 1] }, data: new Float32Array(10000) }), '50.0 mm');
  });

  it('writes the calibration after a length and an ROI area on the film, never after pixels', () => {
    const series = film(detector);
    const volume = { series, data: new Uint16Array(100 * 300) };
    const length: Annotation = { id: 'l', type: 'length', points: [[0, 0, 0], [0, 33, 0]], plane: 'axial', slice: 0, mode: 'source', sourceFrame: 0 };
    assert.equal(annotationSummary(length, volume), '33.0 mm · detector plane');
    const pixels = film({ basis: 'none' });
    assert.equal(annotationSummary({ ...length, points: [[0, 0, 0], [0, 40, 0]] }, { series: pixels, data: new Uint16Array(100 * 300) }), '40.0 px');
    const area = annotationSummary({ id: 'r', type: 'rectangle', points: [[0, 0, 0], [3.3, 3.3, 0]], plane: 'axial', slice: 0, mode: 'source', sourceFrame: 0 }, volume);
    assert.match(area, / · detector plane$/);
  });

  it('names a ball or ruler scale only while it is the film\'s scale', () => {
    const scaled = { ...film(detector), measurementScale: 1 / 1.1 };
    assert.equal(calibrationState(scaled), 'manual');
    assert.equal(calibrationTag(scaled), 'scale set by hand');
    const ball: ManualCalibration = { method: 'ball', knownMm: 25, scale: 1 / 1.1 };
    const source = film(detector);
    const calibrated = (calibration: ManualCalibration) => sourceFrameSeries(withFilmCalibrations(source, { [filmKey(source, 0)]: calibration }), 0);
    assert.equal(calibrationState(calibrated(ball)), 'manual');
    assert.equal(calibrationTag(calibrated(ball)), 'ball 25.0 mm');
    assert.equal(calibrationText(calibrated(ball)), 'Ball 25.0 mm · ball depth not confirmed');
    assert.equal(calibrationText(calibrated({ ...ball, depthConfirmed: true })), 'Ball 25.0 mm');
    const mm = millimetresPerPixel(calibrated(ball))!;
    assert.ok(Math.abs(mm[0] - 0.3) < 1e-12 && Math.abs(mm[1] - 0.3) < 1e-12);
    // A known-length calibration made later replaces the scale: the ball is no longer named.
    assert.equal(manualCalibration({ ...calibrated(ball), measurementScale: 0.95 }), null);
    assert.equal(calibrationTag({ ...calibrated(ball), measurementScale: 0.95 }), 'scale set by hand');
    assert.equal(calibrationTag(calibrated({ method: 'ruler', knownMm: 200, scale: 1 / 1.1 })), 'ruler 200.0 mm');
    // A film with only one frame and no frame list takes it on the series.
    const noMetadata = { ...source, frameMetadata: undefined };
    const bare = withFilmCalibrations(noMetadata, { [filmKey(noMetadata, 0)]: ball });
    assert.equal(manualCalibration(bare), ball);
    // The reader's choice of pixels wins.
    assert.equal(calibrationState({ ...calibrated(ball), measurementUnits: 'px' }), 'pixels');
  });

  it('keeps a ball or ruler on the film it was measured on, not on the series\' other films', () => {
    // One CR series of two films, such as the AP long leg with a ball and a repeat: the ball is on the first only.
    const one = { ...film(detector).frameMetadata![0], sopInstanceUid: '2.25.1', sourceFrameNumber: 1 };
    const two = { ...one, sourceFrameNumber: 2 };
    const series = film(detector, { dimensions: [100, 300, 2], frameMetadata: [one, two] });
    const films = { [filmKey(series, 0)]: { method: 'ball' as const, knownMm: 25, scale: 1 / 1.1, depthConfirmed: true } };
    const decorated = withFilmCalibrations(series, films);
    const [first, second] = [sourceFrameSeries(decorated, 0), sourceFrameSeries(decorated, 1)];
    assert.equal(calibrationText(first), 'Ball 25.0 mm');
    assert.equal(calibrationState(second), 'detector');
    assert.equal(calibrationTag(second), 'detector plane');
    assert.equal(calibrationText(second), 'Detector plane, not corrected');
    assert.deepEqual(millimetresPerPixel(second), [0.33, 0.33]);
    // A length on each film: 100 pixels at 0.33 mm, divided by the ball's 1.1 on its own film only.
    const volume = { series: decorated, data: new Uint16Array(100 * 300 * 2) };
    const length = (frame: number): Annotation => ({ id: `l${frame}`, type: 'length', points: [[0, 0, 0], [0, 33, 0]], plane: 'axial', slice: frame, mode: 'source', sourceFrame: frame });
    assert.equal(annotationSummary(length(0), volume), '30.0 mm · ball 25.0 mm');
    assert.equal(annotationSummary(length(1), volume), '33.0 mm · detector plane');
    // An area too: 33 × 33 mm at the detector, (33 / 1.1)² = 900 mm² on the ball's film.
    const box = (frame: number): Annotation => ({ id: `r${frame}`, type: 'rectangle', points: [[0, 0, 0], [33, 33, 0]], plane: 'axial', slice: frame, mode: 'source', sourceFrame: frame });
    assert.match(annotationSummary(box(0), volume), /^900\.0 mm² .* · ball 25\.0 mm$/);
    assert.match(annotationSummary(box(1), volume), /^1089\.0 mm² .* · detector plane$/);
    // The series' known-length scale stays on the films without a ball of their own; the ball outranks it on its film.
    const both = withFilmCalibrations({ ...series, measurementScale: 0.95 }, films);
    assert.equal(calibrationTag(sourceFrameSeries(both, 0)), 'ball 25.0 mm');
    assert.equal(calibrationTag(sourceFrameSeries(both, 1)), 'scale set by hand');
    // No calibration: the series as it was.
    assert.equal(withFilmCalibrations(series, {}), series);
    const reordered = withFilmCalibrations({ ...series, frameMetadata: [two, one] }, films);
    assert.equal(pixelSpacingText(sourceFrameSeries(reordered, 0)), '0.33 × 0.33 mm · detector plane');
    assert.equal(pixelSpacingText(sourceFrameSeries(reordered, 1)), '0.30 × 0.30 mm · ball 25.0 mm');
  });

  it('shows a manual scale in the inspector on a film without DICOM spacing', () => {
    const source = film({ basis: 'none' });
    assert.equal(pixelSpacingText(source), 'Not calibrated');
    const decorated = withFilmCalibrations(source, { [filmKey(source, 0)]: { method: 'ruler', knownMm: 100, scale: 0.25 } });
    const shown = sourceFrameSeries(decorated, 0);
    assert.equal(pixelSpacingText(shown), '0.25 × 0.25 mm · ruler 100.0 mm');
    assert.equal(pixelSpacingText({ ...shown, measurementUnits: 'px' }), '0.25 × 0.25 mm · ruler 100.0 mm');
  });

  it('gives the side from the laterality, and says when it is not recorded', () => {
    const side = (laterality?: string) => sideText(film({ ...detector, laterality }));
    assert.deepEqual([side('R'), side('L'), side('B'), side('U'), side(undefined)], ['Right', 'Left', 'Both sides', 'Unpaired part', 'Side not recorded']);
    setLocale('tr');
    assert.equal(projectionLine(film(detector)), 'İki taraf · Dedektör düzlemi, düzeltilmemiş');
    assert.equal(calibrationTag(film(detector)), 'dedektör düzlemi');
  });
});

describe('orientation letters from Patient Orientation', () => {
  const mapping = (series: Series, view: Partial<{ rotation: number; flipX: boolean; flipY: boolean }> = {}) => screenMapping(series,
    { plane: 'axial', slice: 0, windowCenter: 0, windowWidth: 1, zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false, mode: 'source', ...view }, 400, 800);
  it('labels each edge, following flips and quarter turns', () => {
    const series = sourceFrameSeries(film(detector), 0);
    assert.deepEqual(projectionEdgeLabels(series, mapping(series)), { left: 'R', right: 'L', top: 'S', bottom: 'I' });
    assert.deepEqual(projectionEdgeLabels(series, mapping(series, { flipX: true })), { left: 'L', right: 'R', top: 'S', bottom: 'I' });
    assert.deepEqual(projectionEdgeLabels(series, mapping(series, { rotation: 90 })), { left: 'I', right: 'S', top: 'R', bottom: 'L' });
    const mirrored = sourceFrameSeries(film({ ...detector, patientOrientation: ['R', 'F'] }), 0);
    assert.deepEqual(projectionEdgeLabels(mirrored, mapping(mirrored)), { left: 'L', right: 'R', top: 'S', bottom: 'I' });
  });
  it('gives none without Patient Orientation, or where the image orientation is known', () => {
    const series = film({ ...detector, patientOrientation: undefined });
    assert.equal(projectionEdgeLabels(series, mapping(series)), null);
    const oriented = film(detector, { orientationKnown: true });
    assert.equal(projectionEdgeLabels(oriented, mapping(oriented)), null);
  });
  it('preserves the primary DICOM direction and leaves ambiguous oblique edges blank', () => {
    const series = sourceFrameSeries(film({ ...detector, patientOrientation: ['A', 'FR'] }), 0);
    assert.deepEqual(projectionEdgeLabels(series, mapping(series)), { left: 'P', right: 'A', top: 'SL', bottom: 'IR' });
    assert.deepEqual(projectionEdgeLabels(series, mapping(series, { rotation: 90 })), { left: 'IR', right: 'SL', top: 'P', bottom: 'A' });
    assert.deepEqual(projectionEdgeLabels(series, mapping(series, { rotation: 30 })), { left: '', right: '', top: '', bottom: '' });
  });
});
