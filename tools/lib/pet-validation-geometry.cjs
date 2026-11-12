// Where a point in DICOM patient coordinates (LPS, mm) lies in VEAcom's axial pane, so that tools/pet-validation.cjs
// can draw a sphere exactly there. It follows src/imaging/geometry.ts (getPlaneFrame, screenMapping, sliceAtWorld) for a
// pane without rotation or flips, showing either the acquired slices ('source') or a reconstructed axial plane ('mpr').
// The tool reads back where VEAcom kept each sphere and stops if it is not where it was asked to be.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const n = Math.hypot(...a); if (n < 1e-12) throw new Error('Degenerate image direction'); return a.map(value => value / n); };
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
/** Column `c` of a row-major 3 × 3 matrix: the direction of image index i (0), j (1) or k (2). */
const column = (m, c) => [m[c], m[3 + c], m[6 + c]];

function indexToWorld(series, index) {
  const m = series.direction, [i, j, k] = index.map((n, axis) => n * series.spacing[axis]);
  return [series.origin[0] + m[0] * i + m[1] * j + m[2] * k, series.origin[1] + m[3] * i + m[4] * j + m[5] * k, series.origin[2] + m[6] * i + m[7] * j + m[8] * k];
}

function worldToIndexMatrix(series) {
  const [a, b, c, d, e, f, g, h, i] = series.direction;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) throw new Error('The image directions cannot be inverted');
  const inverse = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det,
    (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  return inverse.map((n, index) => n / series.spacing[Math.floor(index / 3)]);
}

const usesSourceFrames = (series, view) => view.mode === 'source' || !series.canReconstruct || series.sourceFramesOnly === true || series.components === 3;

/** One acquired slice as its own image: its position, directions and spacing. */
function sourceFrame(series, k) {
  const metadata = series.frameMetadata?.[k];
  return { origin: metadata?.origin ?? indexToWorld(series, [0, 0, k]), direction: metadata?.direction ?? series.direction, spacing: metadata?.spacing ?? series.spacing };
}

/** The acquired slice nearest `point`, as VEAcom pages to it. */
function nearestSourceSlice(series, point) {
  const count = series.dimensions[2];
  if (!series.frameMetadata?.length) {
    const m = worldToIndexMatrix(series), d = sub(point, series.origin);
    return Math.round(clamp(m[6] * d[0] + m[7] * d[1] + m[8] * d[2], 0, count - 1));
  }
  let nearest = 0, distance = Infinity;
  for (let k = 0; k < count; k++) {
    const frame = sourceFrame(series, k), normal = cross(column(frame.direction, 0), column(frame.direction, 1)), size = Math.hypot(...normal);
    if (size < 1e-10) continue;
    const candidate = Math.abs(dot(sub(point, frame.origin), normal)) / size;
    if (candidate < distance) { nearest = k; distance = candidate; }
  }
  return nearest;
}

/** A reconstructed axial plane's extent: x and y across the image's outer edges, z over its voxel centres. */
function axialExtent(series) {
  const [nx, ny, nz] = series.dimensions, range = values => [Math.min(...values), Math.max(...values)];
  const corners = edge => {
    const low = edge ? -0.5 : 0, points = [];
    for (const z of [low, nz - 1 - low]) for (const y of [low, ny - 1 - low]) for (const x of [low, nx - 1 - low]) points.push(indexToWorld(series, [x, y, z]));
    return points;
  };
  const edges = corners(true), ru = range(edges.map(p => p[0])), rv = range(edges.map(p => p[1])), rn = range(corners(false).map(p => p[2]));
  const m = worldToIndexMatrix(series), nominal = 1 / Math.hypot(m[2], m[5], m[8]);
  const slices = Math.max(1, Math.ceil((rn[1] - rn[0]) / nominal - 1e-7) + 1);
  return { widthMm: ru[1] - ru[0], heightMm: rv[1] - rv[0], center: [(ru[0] + ru[1]) / 2, (rv[0] + rv[1]) / 2], minZ: rn[0],
    step: slices > 1 ? (rn[1] - rn[0]) / (slices - 1) : nominal, slices };
}

/**
 * How to draw a sphere centred at `center` with `radius` (mm) in an axial pane of `series` whose canvas is `size`
 * (CSS pixels, [width, height]) and whose view is `view`: the slice to show (the acquired slice or reconstructed plane
 * nearest the centre), a zoom and pan that bring the centre to the middle of the pane at a scale where a
 * pixel is a small part of the radius, and the length of the drag. `offset(point)` gives how far a placed centre lies
 * from the one asked for, in the plane and across it, and the tolerances say how far is still the same place.
 */
function axialPlacement(series, view, center, radius, [width, height]) {
  let slice, frameCenter, u, v, widthMm, heightMm, throughTolerance;
  if (usesSourceFrames(series, view)) {
    slice = nearestSourceSlice(series, center);
    const frame = sourceFrame(series, slice), [nx, ny] = series.dimensions;
    u = normalize(column(frame.direction, 0)); v = normalize(column(frame.direction, 1));
    frameCenter = indexToWorld(frame, [(nx - 1) / 2, (ny - 1) / 2, 0]);
    widthMm = nx * frame.spacing[0]; heightMm = ny * frame.spacing[1];
    throughTolerance = Math.abs(series.spacing[2]) / 2 + 0.01;
  } else {
    const extent = axialExtent(series);
    // VEAcom pages whole planes (src/App.tsx updateView), so the centre lies on the plane nearest it.
    slice = Math.round(clamp((center[2] - extent.minZ) / extent.step, 0, extent.slices - 1));
    u = [1, 0, 0]; v = [0, 1, 0];
    frameCenter = [extent.center[0], extent.center[1], extent.minZ + slice * extent.step];
    widthMm = extent.widthMm; heightMm = extent.heightMm;
    throughTolerance = extent.step / 2 + 0.01;
  }
  const normal = normalize(cross(u, v)), axis = normal.reduce((best, value, index) => Math.abs(value) > Math.abs(normal[best]) ? index : best, 0);
  const fit = Math.min(width / widthMm, height / heightMm);
  // The radius spans about a quarter of the pane's shorter side.
  const zoom = clamp(0.25 * Math.min(width, height) / (radius * fit), 1, 20), perMm = fit * zoom, d = sub(center, frameCenter);
  return {
    slice, planeZ: frameCenter[axis], zoom, pan: [-dot(d, u) * perMm, -dot(d, v) * perMm], radiusPx: radius * perMm,
    inPlaneTolerance: 1.5 / perMm + 0.01, throughTolerance,
    offset: point => { const e = sub(point, center); return { inPlane: Math.hypot(dot(e, u), dot(e, v)), through: Math.abs(dot(e, normal)) }; },
  };
}

module.exports = { axialPlacement, indexToWorld, nearestSourceSlice, axialExtent };
