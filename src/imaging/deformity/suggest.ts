// Landmark suggestions from the round-2 landmark model (docs/landmark-model.md): the input contract of its two ONNX
// graphs, and how their outputs become the kit's landmarks. Pure float math with no runtime, so the tests check every
// step; the Worker (suggest.worker.ts) runs the graphs. Ported from veacom-train's stagea.py (window01, to_canvas,
// decode) and stageb.py (crop_centre, sample_crop, crop_to_film, infer_film), which the exported graphs were trained and
// checked with, step for step: the same percentiles, area average, Gaussian pre-blur, bilinear sampling and rounding.
//
// Film points are DICOM image-relative pixels, as the kit's are ((0, 0) at the top left corner of the top left pixel):
// the model's film coordinates use the same corner origin, so no half-pixel shift is needed.
import { fitCircle, length, type Point, sub } from './plane';
import { LANDMARKS, type LandmarkName } from './landmarks';

/** Stage A v3: the whole film at 2 mm per pixel, top left on a 288 × 864 canvas (576 × 1728 mm); 6 heatmaps at stride 2. */
export const STAGE_A = { rows: 864, columns: 288, mm: 2, stride: 2, window: 3 } as const;
/** Stage B v3: 320 × 320 crops at 0.35 mm per pixel (112 mm); internal stride-2 heatmaps decoded inside the graph. */
export const STAGE_B = { size: 320, pitch: 0.35, hipLateralMm: 22 } as const;

const CONTOUR = Array.from({ length: 8 }, (_, i) => `femoralHeadContour${i}` as const);
/** Stage B's 26 output channels, in order (stageb.CHANNELS). */
export const CHANNELS = ['hipCentre', ...CONTOUR, 'greaterTrochanterTip', 'acetabularMarginLateral',
  'kneeCentre', 'femoralCondyleMedial', 'femoralCondyleLateral', 'tibialPlateauMedial', 'tibialPlateauLateral',
  'tibialSpineCentre', 'fibularHeadTip', 'patellaCentre', 'ankleCentre', 'plafondMedial', 'plafondLateral',
  'femoralShaftProximal', 'femoralShaftDistal', 'tibialShaftProximal', 'tibialShaftDistal'] as const;
export type Channel = typeof CHANNELS[number];

/** Stage B's seven crops of a leg, with the channels each owns (stageb.TYPE_CHANNELS): the hip, knee and ankle, and two
 * along each shaft. */
export const CROPS = {
  hip: ['hipCentre', ...CONTOUR, 'greaterTrochanterTip', 'acetabularMarginLateral'],
  knee: ['kneeCentre', 'femoralCondyleMedial', 'femoralCondyleLateral', 'tibialPlateauMedial', 'tibialPlateauLateral',
    'tibialSpineCentre', 'fibularHeadTip', 'patellaCentre'],
  ankle: ['ankleCentre', 'plafondMedial', 'plafondLateral'],
  femurProximal: ['femoralShaftProximal'], femurDistal: ['femoralShaftDistal'],
  tibiaProximal: ['tibialShaftProximal'], tibiaDistal: ['tibialShaftDistal'],
} as const satisfies Record<string, readonly Channel[]>;
type CropKind = keyof typeof CROPS;
export const CROP_KINDS = Object.keys(CROPS) as CropKind[];
/** Stage B v3 crop-type indices for FiLM conditioning (veacom_train stageb.TYPES). */
export const CROP_TYPE_ID = {
  hip: 0n, knee: 1n, ankle: 2n,
  femurProximal: 3n, femurDistal: 4n, tibiaProximal: 5n, tibiaDistal: 6n,
} as const satisfies Record<CropKind, bigint>;

type Joint = 'hip' | 'knee' | 'ankle';

/** Where a shaft crop is centred: a fixed share of the way between two of stage A's anchors (stageb.SHAFT). Where a
 * shaft point lies along the bone is this definition, not something the model finds: it finds the middle between the
 * cortices on the crop's centre row. */
const SHAFT_CROPS: Record<Exclude<CropKind, Joint>, readonly [Joint, Joint, number]> = {
  femurProximal: ['hip', 'knee', 0.30], femurDistal: ['hip', 'knee', 0.75], tibiaProximal: ['knee', 'ankle', 0.25], tibiaDistal: ['knee', 'ankle', 0.80],
};

/** The kit suggests every landmark. These have no check on real films: BMPLE, the only real films the model learnt
 * from, does not label them, and no reference traced on its films is reliable enough to check them (docs/landmark-model.md).
 * The kit marks them, and the values measured from them while they stay as suggested. The others were checked on
 * BMPLE's 69 test films: the hip, knee and ankle centres, the condyles, the plateau and the lower femoral shaft against
 * the reader's points, the other three shaft points against shaft midlines traced between the cortices. */
export const UNCHECKED = ['greaterTrochanterTip', 'plafondMedial', 'plafondLateral'] as const satisfies readonly LandmarkName[];

/**
 * The model's legs are named by where they lie on the image, as on a standard AP display: `left` is stage A's "R"
 * channels and an unmirrored stage-B crop, `right` its "L" channels and a mirrored crop, so medial is always towards the
 * image's centre. Which patient side that is comes from the film (modelLeg).
 */
export type ImageLeg = 'left' | 'right';

/** The leg's place on the image from its lateral direction there (measure.ts lateralOnImage): a leg's lateral side
 * points away from the other leg. Null unless the film's rows run across the patient (its +x within 25° of left or
 * right), as the model was trained. */
export function modelLeg(lateral: Point | null): ImageLeg | null {
  if (!lateral) return null;
  const size = length(lateral);
  if (!(size > 0) || Math.abs(lateral[0]) < Math.cos(25 * Math.PI / 180) * size) return null;
  return lateral[0] < 0 ? 'left' : 'right';
}

/** Round half to even, as numpy's round and Python's round() do. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value), difference = value - floor;
  if (difference !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/** numpy.percentile's default (linear) on sorted values. */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  const position = (sorted.length - 1) * q / 100, below = Math.floor(position), above = Math.min(sorted.length - 1, below + 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** The window the model sees: the 0.5th and 99.5th percentiles of a grid of samples, every rows/400th row and
 * columns/200th column (stagea.window01). */
export function windowRange(pixels: ArrayLike<number>, columns: number, rows: number): [number, number] {
  const rowStep = Math.max(1, Math.floor(rows / 400)), columnStep = Math.max(1, Math.floor(columns / 200));
  const samples: number[] = [];
  for (let y = 0; y < rows; y += rowStep) for (let x = 0; x < columns; x += columnStep) {
    const value = pixels[y * columns + x];
    if (Number.isFinite(value)) samples.push(value);
  }
  if (!samples.length) throw new Error('The film has no finite pixel values.');
  const sorted = Float64Array.from(samples).sort();
  return [percentile(sorted, 0.5), percentile(sorted, 99.5)];
}

/** The film windowed to [0, 1]. `invert` for MONOCHROME1, so bone is bright as the model learnt it: windowing the
 * inverted values gives exactly 1 minus the windowed values. */
export function windowed(pixels: ArrayLike<number>, columns: number, rows: number, invert: boolean): Float32Array {
  const [low, high] = windowRange(pixels, columns, rows), width = Math.max(high - low, 1e-6);
  const out = new Float32Array(columns * rows);
  for (let i = 0; i < out.length; i++) {
    const value = pixels[i], level = Number.isFinite(value) ? Math.min(1, Math.max(0, (value - low) / width)) : 0;
    out[i] = invert ? 1 - level : level;
  }
  return out;
}

/** Whether the film fits stage A's canvas at its spacing: larger films would lose their bottom or right part. */
export function canvasSize(columns: number, rows: number, mm: readonly [number, number]): { width: number; height: number; fits: boolean } {
  const width = Math.max(1, roundHalfEven(columns * mm[0] / STAGE_A.mm)), height = Math.max(1, roundHalfEven(rows * mm[1] / STAGE_A.mm));
  return { width, height, fits: width <= STAGE_A.columns && height <= STAGE_A.rows };
}

/** Area-average resampling of one axis, as torch's interpolate(mode='area') (adaptive average pooling): output cell i
 * averages input cells floor(i·n/m) to ceil((i+1)·n/m). */
function poolRanges(input: number, output: number): Array<[number, number]> {
  return Array.from({ length: output }, (_, i) => [Math.floor(i * input / output), Math.ceil((i + 1) * input / output)]);
}

/** Stage A's input: the windowed film at 2 mm per pixel, top left on the canvas, zero elsewhere, and the scale from film
 * pixels to canvas pixels along x and y (stagea.to_canvas). */
export function stageACanvas(film: Float32Array, columns: number, rows: number, mm: readonly [number, number]): { canvas: Float32Array; scale: [number, number] } {
  const { width, height } = canvasSize(columns, rows, mm);
  const across = poolRanges(columns, width), down = poolRanges(rows, height);
  const keepWidth = Math.min(width, STAGE_A.columns), keepHeight = Math.min(height, STAGE_A.rows);
  // Each row averaged across first, then the rows averaged: an average over a rectangle of equal weights.
  const narrow = new Float64Array(rows * keepWidth);
  for (let y = 0; y < rows; y++) for (let x = 0; x < keepWidth; x++) {
    const [start, end] = across[x];
    let sum = 0;
    for (let i = start; i < end; i++) sum += film[y * columns + i];
    narrow[y * keepWidth + x] = sum / (end - start);
  }
  const canvas = new Float32Array(STAGE_A.rows * STAGE_A.columns);
  for (let y = 0; y < keepHeight; y++) {
    const [start, end] = down[y];
    for (let x = 0; x < keepWidth; x++) {
      let sum = 0;
      for (let j = start; j < end; j++) sum += narrow[j * keepWidth + x];
      canvas[y * STAGE_A.columns + x] = sum / (end - start);
    }
  }
  return { canvas, scale: [width / columns, height / rows] };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-60, Math.min(60, z))));

/** Stage A's hip, knee and ankle of each leg in film pixels, from its heatmap logits (6 channels of `height` × `width`
 * cells): a softmax per channel, then the weighted mean of a 7 × 7-cell window at the peak (stagea.decode). Each leg's
 * `peak` is the least of its three channels' peak probabilities, the softmax's largest value. When a v3 graph also
 * outputs `presence_logits` (6 logits), each leg receives `jointPresence` and their minimum `presence`. */
export function decodeStageA(logits: ArrayLike<number>, height: number, width: number, scale: readonly [number, number],
  presenceLogits?: ArrayLike<number>): Record<ImageLeg, Anchors> {
  const cells = height * width, r = STAGE_A.window, stride = STAGE_A.stride;
  const found = Array.from({ length: 6 }, (_, channel) => {
    const offset = channel * cells;
    let peak = 0, max = -Infinity;
    for (let i = 0; i < cells; i++) if (logits[offset + i] > max) { max = logits[offset + i]; peak = i; }
    // The softmax's sum over the whole map, relative to its largest value: the peak's probability is its inverse. The
    // window's mean needs only its own weights, as the shared factor cancels.
    let total = 0;
    for (let i = 0; i < cells; i++) total += Math.exp(logits[offset + i] - max);
    const py = Math.floor(peak / width), px = peak % width;
    let sum = 0, sx = 0, sy = 0;
    for (let y = Math.max(0, py - r); y < Math.min(height, py + r + 1); y++) for (let x = Math.max(0, px - r); x < Math.min(width, px + r + 1); x++) {
      const weight = Math.exp(logits[offset + y * width + x] - max);
      sum += weight; sx += weight * (x + 0.5); sy += weight * (y + 0.5);
    }
    return { point: [sx / sum * stride / scale[0], sy / sum * stride / scale[1]] as Point, peak: 1 / total };
  });
  const leg = (first: number): Anchors => {
    const anchors: Anchors = {
      hip: found[first].point, knee: found[first + 1].point, ankle: found[first + 2].point,
      peak: Math.min(found[first].peak, found[first + 1].peak, found[first + 2].peak),
    };
    if (presenceLogits && presenceLogits.length >= first + 3) {
      const jointPresence = [sigmoid(presenceLogits[first]), sigmoid(presenceLogits[first + 1]), sigmoid(presenceLogits[first + 2])] as const;
      anchors.jointPresence = jointPresence;
      anchors.presence = Math.min(jointPresence[0], jointPresence[1], jointPresence[2]);
    }
    return anchors;
  };
  return { left: leg(0), right: leg(3) };
}
/** A leg's joints as stage A finds them, and how sure it is of the least sure of them (see `decodeStageA`). */
export interface Anchors extends Record<Joint, Point> {
  peak: number;
  /** Minimum sigmoid(presence_logits) across the leg's three joints (v3 graphs only). */
  presence?: number;
  /** Per-joint visibility probabilities [hip, knee, ankle] (v3 graphs only). */
  jointPresence?: readonly [number, number, number];
}

/** Where a crop is centred in film pixels: the knee and ankle at their anchors, the hip 22 mm lateral of its centre so the
 * trochanter is in the crop too, and a shaft crop its share of the way between two anchors (stageb.crop_centre). */
export function cropCentre(kind: CropKind, leg: ImageLeg, anchors: Anchors, mm: readonly [number, number]): Point {
  if (kind === 'hip') return [anchors.hip[0] + (leg === 'left' ? -1 : 1) * STAGE_B.hipLateralMm / mm[0], anchors.hip[1]];
  if (kind === 'knee') return anchors.knee;
  if (kind === 'ankle') return anchors.ankle;
  const [from, to, share] = SHAFT_CROPS[kind], a = anchors[from], b = anchors[to];
  return [a[0] + share * (b[0] - a[0]), a[1] + share * (b[1] - a[1])];
}

/** scipy.ndimage.gaussian_filter1d's kernel: radius int(4σ + 0.5). */
function gaussianKernel(sigma: number): Float64Array {
  const radius = Math.floor(4 * sigma + 0.5), kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp(-0.5 * i * i / (sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/** Blurs one axis in place with scipy's 'reflect' edges (d c b a | a b c d | d c b a). */
function blurAxis(data: Float32Array, width: number, height: number, sigma: number, along: 'x' | 'y') {
  const kernel = gaussianKernel(sigma), radius = (kernel.length - 1) / 2;
  const count = along === 'x' ? width : height, lines = along === 'x' ? height : width;
  const line = new Float64Array(count);
  const at = (i: number) => { let k = i; while (k < 0 || k >= count) k = k < 0 ? -k - 1 : 2 * count - k - 1; return line[k]; };
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < count; i++) line[i] = data[along === 'x' ? l * width + i : i * width + l];
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += kernel[k + radius] * at(i + k);
      data[along === 'x' ? l * width + i : i * width + l] = sum;
    }
  }
}

/**
 * One stage-B crop: the windowed film sampled bilinearly around `centre` at 0.35 mm per pixel, after a Gaussian blur of
 * 0.42 crop pixels when the film is finer than 1.2 film pixels per crop pixel (so downsampling does not alias), zero
 * outside the film, mirrored left to right for the image's right leg, and rounded to 8 bits as the crops were in
 * training (stageb.sample_crop, infer_film).
 */
export function sampleCrop(film: Float32Array, columns: number, rows: number, centre: Point, mm: readonly [number, number], mirror: boolean, size: number = STAGE_B.size): Float32Array {
  const sx = STAGE_B.pitch / mm[0], sy = STAGE_B.pitch / mm[1];
  const [cx, cy] = centre;
  const x0 = Math.floor(cx - size * sx / 2 - 4), x1 = Math.ceil(cx + size * sx / 2 + 4);
  const y0 = Math.floor(cy - size * sy / 2 - 4), y1 = Math.ceil(cy + size * sy / 2 + 4);
  const width = x1 - x0, height = y1 - y0, patch = new Float32Array(width * height);
  for (let y = Math.max(y0, 0); y < Math.min(y1, rows); y++) {
    for (let x = Math.max(x0, 0); x < Math.min(x1, columns); x++) patch[(y - y0) * width + (x - x0)] = film[y * columns + x];
  }
  if (sx > 1.2 || sy > 1.2) { blurAxis(patch, width, height, 0.42 * sy, 'y'); blurAxis(patch, width, height, 0.42 * sx, 'x'); }
  const crop = new Float32Array(size * size);
  for (let r = 0; r < size; r++) {
    const gy = (r + 0.5 - size / 2) * sy + cy - 0.5 - y0, iy = Math.floor(gy), fy = gy - iy;
    for (let c = 0; c < size; c++) {
      const gx = (c + 0.5 - size / 2) * (mirror ? -sx : sx) + cx - 0.5 - x0, ix = Math.floor(gx), fx = gx - ix;
      const a = patch[iy * width + ix], b = patch[iy * width + ix + 1], d = patch[(iy + 1) * width + ix], e = patch[(iy + 1) * width + ix + 1];
      const value = Math.fround((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy);
      crop[r * size + c] = Math.min(255, Math.max(0, roundHalfEven(value * 255))) / 255;
    }
  }
  return crop;
}

/** A crop pixel point in film pixels (stageb.crop_to_film). */
export function cropToFilm(uv: Point, centre: Point, mm: readonly [number, number], mirror: boolean, size: number = STAGE_B.size): Point {
  const dx = (uv[0] - size / 2) * (mirror ? -1 : 1), dy = uv[1] - size / 2;
  return [dx * STAGE_B.pitch / mm[0] + centre[0], dy * STAGE_B.pitch / mm[1] + centre[1]];
}

/** The channel that holds `channel` in a mirrored crop: the head outline runs the other way round (stageb.MIRROR_PERM). */
export function mirroredChannel(channel: Channel): Channel {
  const match = /^femoralHeadContour(\d)$/.exec(channel);
  return match ? `femoralHeadContour${7 - Number(match[1])}` as Channel : channel;
}

export interface ChannelPoint {
  point: Point;
  confidence: number;
  /** Predicted RLE Laplace uncertainty (σ_x, σ_y) in millimetres (v3 graphs only). */
  sigmaMm?: readonly [number, number];
}

/** Stage B's outputs for one leg's crops (`kinds`, in order) as film points of their own channels: `coords` is
 * (crops, 26, 2) in crop pixels, `confidence` (crops, 26), each channel's heatmap peak probability, and optional v3
 * `sigmaPx` (crops, 26, 2) in crop pixels. A shaft point is the predicted x on the crop's centre row (stageb.infer_film). */
export function readStageB(coords: ArrayLike<number>, confidence: ArrayLike<number>, kinds: readonly CropKind[], centres: readonly Point[],
  mm: readonly [number, number], mirror: boolean, sigmaPx?: ArrayLike<number>): Partial<Record<Channel, ChannelPoint>> {
  const out: Partial<Record<Channel, ChannelPoint>> = {};
  kinds.forEach((kind, crop) => {
    const isShaft = kind in SHAFT_CROPS;
    for (const channel of CROPS[kind]) {
      const source = CHANNELS.indexOf(mirror ? mirroredChannel(channel) : channel), index = crop * CHANNELS.length + source;
      const row = isShaft ? STAGE_B.size / 2 : coords[index * 2 + 1];
      const entry: ChannelPoint = { point: cropToFilm([coords[index * 2], row], centres[crop], mm, mirror), confidence: confidence[index] };
      if (sigmaPx && index * 2 + 1 < sigmaPx.length) {
        entry.sigmaMm = [sigmaPx[index * 2] * STAGE_B.pitch, isShaft ? 0 : sigmaPx[index * 2 + 1] * STAGE_B.pitch];
      }
      out[channel] = entry;
    }
  });
  return out;
}

export interface Suggestion {
  points: Point[];
  confidence: number;
  /** Predicted RLE Laplace uncertainty (σ_x, σ_y) in millimetres (v3 graphs only). */
  sigmaMm?: readonly [number, number];
}

/**
 * The kit's landmarks from one leg's channel points. The channel names are the kit's (docs/landmark-schema.md in
 * veacom-train maps them), and medial is towards the image's centre on both legs.
 *
 * The kit finds the hip centre by fitting a circle to the femoral head's outline. The model's checked point is the hip
 * centre itself (hipCentre); its outline channels have no real-film check. So the outline is suggested as points on a
 * circle around the checked centre, in the directions of the model's outline points and at their median distance, in
 * millimetres: the circle the kit fits through them has the checked centre exactly, and its size, which no value uses,
 * is the model's estimate of the head's.
 */
export function kitSuggestions(channels: Partial<Record<Channel, ChannelPoint>>, mm: readonly [number, number]): Partial<Record<LandmarkName, Suggestion>> {
  const out: Partial<Record<LandmarkName, Suggestion>> = {};
  for (const name of LANDMARKS) {
    if (name === 'femoralHeadContour') continue;
    const found = channels[name];
    if (found && found.point.every(Number.isFinite)) {
      out[name] = { points: [found.point], confidence: found.confidence, ...(found.sigmaMm ? { sigmaMm: found.sigmaMm } : {}) };
    }
  }
  const centre = channels.hipCentre;
  if (centre && centre.point.every(Number.isFinite)) {
    const plane = (p: Point): Point => [p[0] * mm[0], p[1] * mm[1]], image = (p: Point): Point => [p[0] / mm[0], p[1] / mm[1]];
    const middle = plane(centre.point);
    const offsets = CONTOUR.flatMap(channel => { const p = channels[channel]?.point; return p && p.every(Number.isFinite) ? [sub(plane(p), middle)] : []; })
      .filter(offset => length(offset) > 1e-6);
    const distances = offsets.map(length).sort((a, b) => a - b);
    const radius = distances.length ? (distances[(distances.length - 1) >> 1] + distances[distances.length >> 1]) / 2 : 0;
    const ring = offsets.map(offset => image([middle[0] + offset[0] / length(offset) * radius, middle[1] + offset[1] / length(offset) * radius]));
    // Fewer than three directions, or all on one line, give no circle: no outline is suggested.
    const fitted = radius > 0 ? fitCircle(ring.map(plane)) : null;
    if (fitted && length(sub(fitted.centre, middle)) < 1e-6) {
      out.femoralHeadContour = { points: ring, confidence: centre.confidence, ...(centre.sigmaMm ? { sigmaMm: centre.sigmaMm } : {}) };
    }
  }
  return out;
}
