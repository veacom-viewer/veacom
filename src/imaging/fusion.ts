// PET/CT fusion as VEAcom Next does it: the partner series found by itself, the PET scanner's own look, and a scale for
// a PET without SUV (Python: app/ui/fusion.py). A reconstructed SPECT is fused the same way, always on its own scale; the
// gates of a gated SPECT on the one their file shares.
import type { FusionSettings, PixelArray, Series } from '../model';
import { findRole } from '../arrangements/roles';
import { FUSION } from '../arrangements/builtin';
import { indexToWorld } from './geometry';
import { shareFrame } from './linking';
import { isEmission } from './emission';

export { isEmission, overlayKind } from './emission';

/** A series laid over another as PET is: a PET, or a SPECT reconstructed into a volume. Planar gamma camera images
 * have no place in the patient to be fused at. */
export const fusesAsOverlay = (series: Series) => !series.segmentation && (series.modality === 'PT' || (series.modality === 'NM' && series.canReconstruct));

/** Whether `overlay` is drawn over `base`: in one frame of reference, never over itself or over another emission image. */
export const fusesOver = (base: Series, overlay: Series) => base.id !== overlay.id && !isEmission(base) && shareFrame(base, overlay);

/** How a SPECT is fused while the reader has not changed the fusion: it has no scanner look, so uptake only, in hot
 * metal, with its own high activity at the top of the scale (see `petScale`). */
export const SPECT_LOOK = { palette: 'hot_metal', blend: 'uptake', opacity: 0.7, upper: 5 } as const satisfies { palette: FusionSettings['palette']; blend: FusionSettings['blend']; opacity: number; upper: number };

/** The look of each maker's workstation: colour scale, blending, PET opacity, top of the SUV scale and CT window. */
export const DEVICE_LOOKS = {
  GE: { palette: 'ge', blend: 'classic', opacity: 0.5, upperSuv: 10, ctWindow: [400, 40] },
  Siemens: { palette: 'hot_metal', blend: 'classic', opacity: 0.65, upperSuv: 5, ctWindow: [250, 10] },
} as const satisfies Record<string, { palette: FusionSettings['palette']; blend: FusionSettings['blend']; opacity: number; upperSuv: number; ctWindow: readonly [number, number] }>;
export type DeviceMaker = keyof typeof DEVICE_LOOKS;

/** Siemens for a Siemens PET, GE for any other (as in Next). */
export const deviceMaker = (pet: Series): DeviceMaker => (pet.manufacturer ?? '').toUpperCase().includes('SIEMENS') ? 'Siemens' : 'GE';

/** Ctrl + drag on a fused image: the top of the scale doubles every this many pixels to the right; the opacity goes
 * from none to full over this many pixels up. */
export const PET_DRAG_DOUBLING_PX = 120;
export const PET_DRAG_OPACITY_PX = 250;
export const UPPER_LIMITS = [0.5, 60] as const;
export const OPACITY_LIMITS = [0.1, 1] as const;

export function draggedFusion(start: { upperSuv: number; opacity: number }, dx: number, dy: number): { upperSuv: number; opacity: number } {
  return {
    upperSuv: Math.min(UPPER_LIMITS[1], Math.max(UPPER_LIMITS[0], start.upperSuv * 2 ** (dx / PET_DRAG_DOUBLING_PX))),
    opacity: Math.min(OPACITY_LIMITS[1], Math.max(OPACITY_LIMITS[0], start.opacity - dy / PET_DRAG_OPACITY_PX)),
  };
}

/** The series of the same study to fuse `target` with: for a CT, the attenuation-corrected PET covering most of it;
 * for a PET, the CT acquired with it (as many slices as far apart), else the one covering most of it. Only series
 * the two can be drawn together with (`fits`) are taken. */
export function bestPartner(target: Series, candidates: readonly Series[], modality: 'PT' | 'CT', fits: (series: Series) => boolean): Series | null {
  // The ranking is the fusion arrangement's (src/arrangements/builtin.ts): AC first, the same grid, the most overlap, slices.
  return findRole({ modality, prefer: FUSION.roles[modality === 'PT' ? 'overlay' : 'ct'].prefer }, candidates, target, fits);
}

/** After contrast, as series are usually named ("T1_postcontrast", "T1 +C", "C+", "GAD", "kontrastlı", "KM"). */
export const afterContrast = (series: Series) => /post|c\+|\+c|gad|kontrastl|(^|[\s_+-])km($|[\s_+-])/i.test(series.description);

/** The head-to-feet range a series covers, in patient millimetres. */
function zRange(series: Series): [number, number] {
  const first = indexToWorld(series, [0, 0, 0])[2], last = indexToWorld(series, [0, 0, Math.max(0, series.dimensions[2] - 1)])[2];
  return [Math.min(first, last), Math.max(first, last)];
}

/** MR over MR: of the MR series shown beside an MR, the one to fuse it with. The one on the other side of
 * contrast first, then one on the same slice grid, then the one covering most of it. Only series the two can be drawn
 * together with (`fits`). */
export function mrPartner(target: Series, beside: readonly Series[], fits: (series: Series) => boolean): Series | null {
  const same = beside.filter(item => item.modality === 'MR' && item.id !== target.id && item.studyUid === target.studyUid && !item.segmentation && fits(item));
  if (!same.length) return null;
  const [low, high] = zRange(target), contrast = afterContrast(target);
  const score = (item: Series) => {
    const grid = item.dimensions[2] === target.dimensions[2] && Math.abs(item.spacing[2] - target.spacing[2]) < 1e-3;
    const [a, b] = zRange(item);
    return [Number(afterContrast(item) !== contrast), Number(grid), Math.max(0, Math.min(high, b) - Math.max(low, a))];
  };
  return same.reduce((best, item) => {
    const a = score(item), b = score(best);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? item : best;
    return best;
  });
}

/** Of two MR series, the one after contrast and the one before it: by name where a name says, else by series number
 * (contrast comes later). */
export function contrastPair(a: Series, b: Series): [after: Series, before: Series] {
  if (afterContrast(a) !== afterContrast(b)) return afterContrast(a) ? [a, b] : [b, a];
  return a.seriesNumber >= b.seriesNumber ? [a, b] : [b, a];
}

/** A PET in SUV, or with what SUV needs. Only a PET: a SPECT is never read in SUV here. */
export const petHasSuv = (pet: Series) => pet.modality === 'PT' && (/^SUV/i.test(pet.valueUnit) || (pet.suvFactor != null && Number.isFinite(pet.suvFactor) && pet.suvFactor > 0));

/** The name of the top of the fusion scale: SUV only for a PET that has SUV (none chosen yet: SUV, the usual case). */
export const fusionScaleMaxKey = (pet: Series | undefined) => pet && !petHasSuv(pet) ? 'fusion.scaleMax' as const : 'fusion.suvMax' as const;

const levels = new WeakMap<PixelArray, number>();
/** For a PET without SUV: its own high activity, the 99.5th percentile of its positive values, which the colour scale
 * puts where SUV 5 would be (as in Next). */
export function petAutoLevel(data: PixelArray): number {
  const known = levels.get(data);
  if (known !== undefined) return known;
  const step = Math.max(1, Math.floor(data.length / 500_000));
  const positive: number[] = [];
  for (let i = 0; i < data.length; i += step) if (data[i] > 0 && Number.isFinite(data[i])) positive.push(data[i]);
  positive.sort((a, b) => a - b);
  const at = 0.995 * (positive.length - 1), low = Math.floor(at);
  const level = positive.length ? positive[low] + (positive[Math.min(low + 1, positive.length - 1)] - positive[low]) * (at - low) : 1;
  levels.set(data, level > 0 ? level : 1);
  return levels.get(data)!;
}

/** What a stored PET value is multiplied by before the colour scale: 1 in SUV, the SUV factor, or for a PET without
 * SUV so that its own high activity reads as SUV 5. */
export function petScale(pet: { series: Series; data: PixelArray }): number {
  // An MR laid over an MR: the top of its own display window reads as the top of the default scale (5), as other viewers
  // colour it, so ordinary tissue stays red and only what is bright turns yellow. A gate of a gated SPECT: the top of the
  // window every gate of its file shares (native/src/ingest.rs, share_gate_windows), so a gate that counted less looks
  // dimmer over the CT, as it does on its own.
  if (pet.series.modality === 'MR' || pet.series.phase?.gate) {
    const top = pet.series.windowCenter + pet.series.windowWidth / 2;
    if (Number.isFinite(top) && top > 0) return 5 / top;
  }
  if (petHasSuv(pet.series)) return /^SUV/i.test(pet.series.valueUnit) ? 1 : pet.series.suvFactor!;
  return 5 / petAutoLevel(pet.data);
}
