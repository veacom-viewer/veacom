const { indexToWorld } = require('./pet-validation-geometry.cjs');

/** Largest error at a corner of the synthetic follow-up volume, relative to its known table shift. */
function registrationError(matrix, series, shift) {
  const [nx, ny, nz] = series.dimensions.map(n => n - 1);
  let worstMm = 0;
  for (const i of [0, nx]) for (const j of [0, ny]) for (const k of [0, nz]) {
    const point = indexToWorld(series, [i, j, k]);
    const errors = point.map((value, axis) => {
      const row = axis * 4;
      const mapped = matrix[row] * point[0] + matrix[row + 1] * point[1] + matrix[row + 2] * point[2] + matrix[row + 3];
      return mapped - (value - shift[axis]);
    });
    worstMm = Math.max(worstMm, Math.hypot(...errors));
  }
  const cosine = (matrix[0] + matrix[5] + matrix[10] - 1) / 2;
  return { worstMm, degrees: Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI };
}

module.exports = { registrationError };
