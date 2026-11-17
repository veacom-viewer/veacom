// Projection radiographs (CR, DX and the others whose detector records Imager Pixel Spacing): what the spacing their
// measurements use stands for, the side the film shows, and its orientation letters from Patient Orientation. The
// engine chose the spacing by PS3.3 10.7.1.1 (native/src/projection.rs); here it is named beside every value.
import type { FrameMetadata, ManualCalibration, Projection, Series, Vec3 } from '../model';
import { dot, orientationLabel, type ScreenMapping } from './geometry';
import { t } from '../i18n';

/** What a measurement's millimetres stand for. `patient` is a cross-section's own Pixel Spacing, named nowhere. */
export type CalibrationState = 'calibrated' | 'magnification' | 'detector' | 'scanned' | 'unstated' | 'manual' | 'pixels' | 'patient';

export type { ManualCalibration };
/** A saved plan can restore a known scale without a marker, or the film's original DICOM calibration. */
export type FilmCalibration = ManualCalibration | { method: 'scale'; scale: number } | { method: 'dicom' };
export type FilmCalibrations = Readonly<Partial<Record<string, FilmCalibration>>>;

/** An unidentified frame can only be matched within the same import revision. */
export function filmKey(series: Pick<Series, 'id' | 'frameMetadata' | 'sourceRevision' | 'catalogRevision' | 'engineGeneration'>, frame: number): string {
  const metadata = series.frameMetadata?.[frame];
  return metadata?.sopInstanceUid ? `${series.id}:${metadata.sopInstanceUid}:${metadata.sourceFrameNumber ?? 1}`
    : `${series.id}:#${series.engineGeneration ?? 0}:${series.sourceRevision ?? series.catalogRevision ?? 0}:${frame}`;
}

/**
 * The series with each calibrated film's scale on that film alone. A ball or ruler stands at one film's magnification,
 * so it is carried by the frame's metadata: the film (sourceFrameSeries) measures with it and names it, and the
 * series' other films keep their own spacing, or the series' known-length scale.
 */
export function withFilmCalibrations(series: Series, films: FilmCalibrations | undefined): Series {
  if (!films || !Object.keys(films).length) return series;
  function apply<T extends Series | FrameMetadata>(image: T, index: number): T {
    const film = films?.[filmKey(series, index)];
    if (!film) return image;
    return { ...image, measurementScale: film.method === 'dicom' ? undefined : film.scale,
      manualCalibration: film.method === 'ball' || film.method === 'ruler' ? film : undefined };
  }
  if (!series.frameMetadata?.length) return series.dimensions[2] === 1 ? apply(series, 0) : series;
  return { ...series, frameMetadata: series.frameMetadata.map(apply) };
}

/** The known object behind the film's current scale, if that scale came from one. */
export function manualCalibration(series: Series): ManualCalibration | null {
  const recorded = series.manualCalibration, scale = series.measurementScale;
  return recorded && scale !== undefined && Math.abs(recorded.scale - scale) <= 1e-12 * Math.max(1, scale) ? recorded : null;
}

export const projectionOf = (series: Series): Projection | undefined => series.projection ?? series.frameMetadata?.[0]?.projection;
export const isProjectionFilm = (series: Series) => projectionOf(series) !== undefined;

/** A standing long-leg film, which the assessment button opens the deformity plan on: a DX or CR whose Body Part
 * Examined names the leg, or whose image is at least twice as tall as it is wide. A doubtful one opens all the same,
 * with a caution in the panel (feasibility study, step S0: a caution, never a block). */
export function isLongLegFilm(series: Series): boolean {
  if (series.modality !== 'DX' && series.modality !== 'CR') return false;
  if (/^(LEG|LOWER ?LIMB|LOWEXM|LOWER ?EXTREMITY)$/i.test(projectionOf(series)?.bodyPart?.trim() ?? '')) return true;
  const [width, height] = series.dimensions, [across, down] = series.spacing;
  return height * down >= 2 * width * across;
}

export function calibrationState(series: Series, units = series.measurementUnits): CalibrationState {
  if (units === 'px') return 'pixels';
  const scale = series.measurementScale;
  if (scale !== undefined && Number.isFinite(scale) && scale > 0) return 'manual';
  const projection = projectionOf(series);
  if (projection) return projection.basis === 'none' ? 'pixels' : projection.basis;
  return series.spacingKnown === true ? 'patient' : 'pixels';
}

/** Millimetres per pixel along the columns (x) and the rows (y) that measurements use, or null in pixels only. */
export function millimetresPerPixel(series: Series): [number, number] | null {
  const state = calibrationState(series, 'auto');
  if (state === 'pixels') return null;
  const scale = state === 'manual' ? series.measurementScale! : 1;
  const [x, y] = series.spacing;
  return [x * scale, y * scale];
}

const digits = (value: number) => value.toFixed(value >= 10 ? 1 : 2);

export function pixelSpacingText(series: Series): string {
  const mm = millimetresPerPixel(series);
  if (!mm) return t('inspector.notCalibrated');
  const tag = calibrationTag(series, 'auto');
  return `${mm.map(value => value.toFixed(2)).join(' × ')} mm${tag ? ` · ${tag}` : ''}`;
}

/** The short name a measurement on a projection film carries after its millimetres; empty elsewhere. */
export function calibrationTag(series: Series, units = series.measurementUnits): string {
  if (!isProjectionFilm(series)) return '';
  const state = calibrationState(series, units), projection = projectionOf(series);
  if (state === 'manual') {
    const known = manualCalibration(series);
    return known ? t(known.method === 'ball' ? 'calibration.tagBall' : 'calibration.tagRuler', { size: known.knownMm.toFixed(1) }) : t('calibration.tagManual');
  }
  if (state === 'magnification') return t('calibration.tagMagnification', { factor: digits(projection?.magnification ?? 1) });
  if (state === 'calibrated') return t('calibration.tagCalibrated');
  if (state === 'detector') return t('calibration.tagDetector');
  if (state === 'scanned') return t('calibration.tagScanned');
  if (state === 'unstated') return t('calibration.tagUnstated');
  return '';
}

/** The calibration in a line, for the pane and the planning panel: what the millimetres stand for and from what. */
export function calibrationText(series: Series, units = series.measurementUnits): string {
  const state = calibrationState(series, units), projection = projectionOf(series);
  if (state === 'manual') {
    const known = manualCalibration(series);
    if (!known) return t('calibration.manual');
    return t(known.method === 'ball' ? 'calibration.ball' : 'calibration.ruler', { size: known.knownMm.toFixed(1) })
      + (known.method === 'ball' && !known.depthConfirmed ? ` · ${t('calibration.depthUnconfirmed')}` : '');
  }
  if (state === 'calibrated') {
    const type = projection?.calibrationType;
    return type === 'GEOMETRY' ? t('calibration.geometry') : type === 'FIDUCIAL' ? t('calibration.fiducial') : t('calibration.calibrated');
  }
  if (state === 'magnification') return t('calibration.magnification', { factor: digits(projection?.magnification ?? 1) });
  if (state === 'detector') return t('calibration.detector');
  if (state === 'scanned') return t('calibration.scanned');
  if (state === 'unstated') return t('calibration.unstated');
  if (state === 'pixels') return t('calibration.pixels');
  return '';
}

/** The side the film shows, from its laterality: Right, Left, Both, Unpaired, or that it is not recorded. */
export function sideText(series: Series): string {
  const laterality = projectionOf(series)?.laterality;
  if (laterality === 'R') return t('side.right');
  if (laterality === 'L') return t('side.left');
  if (laterality === 'B') return t('side.both');
  if (laterality === 'U') return t('side.unpaired');
  return t('side.unknown');
}

/** The projection film's line in the pane, bottom left: its side and its calibration. Empty for other images. */
export function projectionLine(series: Series): string {
  return isProjectionFilm(series) ? `${sideText(series)} · ${calibrationText(series)}` : '';
}

const LETTERS: Partial<Record<string, Vec3>> = { L: [1, 0, 0], R: [-1, 0, 0], P: [0, 1, 0], A: [0, -1, 0], H: [0, 0, 1], F: [0, 0, -1] };
const OPPOSITE: Record<string, string> = { L: 'R', R: 'L', P: 'A', A: 'P', H: 'F', F: 'H' };

/** The patient direction of each screen edge of a projection film that records Patient Orientation, in the viewer's
 * letters (R, L, A, P, S, I), following the view's turn and flips; null when the film does not say. Only for films
 * whose image orientation is unknown: an image with Image Orientation (Patient) is labelled from it as before. */
export function projectionEdgeLabels(series: Series, mapping: ScreenMapping): { left: string; right: string; top: string; bottom: string } | null {
  const orientation = projectionOf(series)?.patientOrientation;
  if (series.orientationKnown === true || !orientation) return null;
  const d = series.direction, across: Vec3 = [d[0], d[3], d[6]], down: Vec3 = [d[1], d[4], d[7]];
  const label = (screen: Vec3, sign: number) => {
    const x = sign * dot(screen, across), y = sign * dot(screen, down);
    // PS3.3 C.7.6.1.1.1 orders the letters by contribution but supplies no direction cosines for an oblique axis.
    if (Math.abs(x) < 1e-6 || Math.abs(y) < 1e-6) {
      const code = Math.abs(x) > Math.abs(y) ? orientation[0] : orientation[1];
      const positive = Math.abs(x) > Math.abs(y) ? x > 0 : y > 0;
      return [...code].map(c => positive ? c : OPPOSITE[c]).join('').replaceAll('H', 'S').replaceAll('F', 'I');
    }
    const row = LETTERS[orientation[0]], column = LETTERS[orientation[1]];
    return row && column ? orientationLabel([x * row[0] + y * column[0], x * row[1] + y * column[1], x * row[2] + y * column[2]]) : '';
  };
  return { left: label(mapping.right, -1), right: label(mapping.right, 1), top: label(mapping.down, -1), bottom: label(mapping.down, 1) };
}
