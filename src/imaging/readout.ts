import { hasPixels, type ViewVolume } from '../model';
import { nativeProbe, nativeRay } from './nativeMeasurements';
// The value under the pointer, shown in an image corner as the reader moves over a pane: the voxel there in the series'
// own quantity, read as the probe reads it (the nearest voxel), and on a fused image the PET's value at the same point.
// A PET reads in the SUV chosen under PET values (SUVbw, SUL or SUVbsa) only when it has what that SUV needs; a PET
// without SUV reads in its stored unit and is never called SUV (annotations.ts quantitativeScale).
import type { FusionSettings, Series, Vec3, ViewState, Volume } from '../model';
import { quantitativeScale, quantityText } from './annotations';
import { clamp, isPaddingValue, isProjection, sampleVolume, sourceFrameSeries, worldToIndex } from './geometry';
import { rayMaximum } from './projection';
import { usesSourceFrames } from './viewState';
import { t } from '../i18n';

/** A series' name on the readout: PET for a PT, its modality otherwise. */
const seriesName = (series: Series) => series.modality === 'PT' ? 'PET' : series.modality;

/** The stored value of the voxel nearest `world` on the pane, as the probe reads it: on an acquired frame that frame's
 * pixel, on a reconstructed plane the volume's voxel. Null off the image, on padding, on a value that is not a number,
 * and while the frame shown is not loaded yet. */
export function voxelAt(volume: Volume, view: Pick<ViewState, 'mode' | 'slice'>, world: Vec3): number | null {
  const series = volume.series;
  if (series.components === 3 || !world.every(Number.isFinite)) return null;
  if (!usesSourceFrames(series, view) && volume.sourceFrameIndex === undefined) {
    const value = sampleVolume(volume, world);
    return value !== null && Number.isFinite(value) ? value : null;
  }
  const index = Math.round(view.slice);
  if (volume.sourceFrameIndex !== undefined && volume.sourceFrameIndex !== index) return null;
  const frame = sourceFrameSeries(series, index), [nx, ny] = frame.dimensions;
  const offset = volume.sourceFrameIndex === undefined ? index * nx * ny : 0;
  const point = worldToIndex(frame, world);
  if (!point.every(Number.isFinite) || Math.abs(point[2]) > 0.5 || point[0] < -0.5 || point[0] > nx - 0.5 || point[1] < -0.5 || point[1] > ny - 0.5
    || offset + nx * ny > volume.data.length) return null;
  const value = volume.data[offset + clamp(Math.round(point[1]), 0, ny - 1) * nx + clamp(Math.round(point[0]), 0, nx - 1)];
  return Number.isFinite(value) && !isPaddingValue(frame, value) ? value : null;
}

/** A stored value in the series' quantity, with its unit ("3.42 SUL", "35.0 HU", "1234.5 Bq/ml"). */
export function quantityAt(series: Series, stored: number, normalization = series.suvNormalization): string | null {
  const quantity = quantitativeScale(normalization === series.suvNormalization ? series : { ...series, suvNormalization: normalization });
  const value = stored * quantity.factor;
  return Number.isFinite(value) ? quantityText(value, quantity.unit) : null;
}

/** The corner's lines for the pointer at `world` on a pane drawing `view` (as rendered): the pane's own value, then on a
 * fused pane the PET's. On a whole-volume MIP, the hottest voxel on the pointer's ray through native voxels. Empty
 * where there is no value (off the image, on padding, an RGB image). */
export function pointerReadout(volume: Volume, view: ViewState, world: Vec3, fusion?: FusionSettings | null): string[] {
  const series = volume.series, name = seriesName(series);
  if (isProjection(series, view)) {
    const brightest = series.components === 3 ? null : rayMaximum(volume, view, world);
    const text = brightest === null ? null : quantityAt(series, brightest);
    return text ? [t('readout.rayMax', { name, value: text })] : [];
  }
  const lines: string[] = [];
  const stored = voxelAt(volume, view, world), own = stored === null ? null : quantityAt(series, stored);
  if (own) lines.push(t('readout.value', { name, value: own }));
  if (fusion && hasPixels(fusion.volume) && fusion.volume.series.components !== 3) {
    // The PET's nearest voxel at the same point in the patient, as the fused probe reads it.
    const pet = sampleVolume(fusion.volume, world), text = pet === null || !Number.isFinite(pet) ? null : quantityAt(fusion.volume.series, pet);
    if (text) lines.push(t('readout.value', { name: seriesName(fusion.volume.series), value: text }));
  }
  return lines;
}

interface PointerSample { series: Series; value: number | null; ray?: boolean }

export function formatPointerSamples(samples: PointerSample[], normalization: Series['suvNormalization']): string[] {
  return samples.flatMap(({ series, value, ray }) => {
    const text = value === null ? null : quantityAt(series, value, normalization);
    return text ? [t(ray ? 'readout.rayMax' : 'readout.value', { name: seriesName(series), value: text })] : [];
  });
}

/** Stored values on the displayed frame, including the hottest voxel under a MIP pixel. */
export async function nativePointerSamples(volume: ViewVolume, view: ViewState, world: Vec3, fusion?: FusionSettings | null): Promise<PointerSample[]> {
  const series = volume.series;
  if (series.components === 3) return [];
  if (isProjection(series, view)) {
    const hit = await nativeRay(series, view, world, false);
    return [{ series, value: hit?.value ?? null, ray: true }];
  }
  const targets = [{ series, frame: usesSourceFrames(series, view) ? Math.round(view.slice) : undefined }];
  if (fusion && fusion.volume.series.components !== 3) targets.push({ series: fusion.volume.series, frame: undefined });
  return Promise.all(targets.map(async ({ series, frame }) => {
    const { value } = await nativeProbe(series, world, frame);
    return { series, value };
  }));
}
