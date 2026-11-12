//! Rigid registration: the rotation and translation (six degrees of freedom) that lay one series over another, found
//! from their pixels alone. It is for series in frames of reference of their own: two visits of one patient, or a PET
//! and a CT or MR acquired apart, whose patient coordinates do not correspond.
//!
//! The measure is normalised mutual information (Studholme, Hill and Hawkes 1999): it needs no intensity relation
//! between the two images (CT to CT, PET to CT or MR), and unlike plain mutual information it does not reward a smaller
//! overlap. It is read at fixed points of the fixed volume, set off inside their voxels by a repeatable jitter so the
//! two voxel grids lining up adds no false peak, from a joint histogram whose moving side is spread over two bins
//! (a linear Parzen window), so it changes smoothly as the transform does. Both volumes are box-averaged, coarse to
//! fine: about 8 mm, then 4 mm, then the finest each allows within `MAX_LEVEL_VOXELS`. The coarsest level first tries
//! offsets along the patient's long axis, the table axis, where two visits differ most, then every level refines all
//! six parameters by compass search with halving steps.
//!
//! The result is deterministic: no random numbers, a fixed order of work, and each candidate transform measured whole
//! by one thread. Nothing here changes a series: the transform is returned, and only display and sampling apply it.

use crate::{
    model::{PixelBuffer, SourceSeries},
    sampling::Grid,
};
use anyhow::{Result, bail};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

/// Joint histogram bins for each image.
const BINS: usize = 48;
/// The voxel sizes the coarse levels aim for, in mm.
const COARSE_SPACING: [f64; 2] = [8.0, 4.0];
/// At most this many voxels in one level of one volume (32 MiB as f32).
const MAX_LEVEL_VOXELS: usize = 8 << 20;
/// Points of the fixed volume measured at the coarsest, middle and finest levels.
const SAMPLES: [usize; 3] = [1 << 14, 1 << 16, 1 << 17];
/// Of the fixed points, at least this share must fall inside the moving volume for a transform to count, or this share
/// of as many as the moving volume could hold, if more. A small overlap of featureless tissue (two ends of a trunk) can
/// match better than the whole anatomy; elastix likewise asks for a quarter of its points.
const MIN_OVERLAP: f64 = 0.05;
const MIN_SHARE_OF_CAPACITY: f64 = 0.5;
/// Offsets along the long axis are tried where the two volumes' extents share at least this part of the shorter one.
const MIN_EXTENT_OVERLAP: f64 = 0.3;
/// Most compass-search sweeps at one level, each measuring up to 12 candidates.
const MAX_SWEEPS: usize = 400;

/// Where the moving series lies in the fixed series' patient coordinates, and how well the two then match.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    /// Row-major 4 × 4 rigid transform: a point of the moving series' patient coordinates (LPS mm) to the fixed
    /// series'. Its inverse takes fixed points to the moving series.
    pub matrix: [f64; 16],
    /// The same transform the other way, fixed to moving, as p ↦ R (p − centre) + centre + shift: R as angles about
    /// the patient's x (right to left), y (front to back) and z (feet to head) axes, in degrees, applied in that order;
    /// `shift` is where the anatomy at the fixed series' `centre` lies in the moving series, less `centre`, in mm.
    pub rotation: [f64; 3],
    pub shift: [f64; 3],
    /// The fixed series' body centre the rotation turns about, in its patient coordinates.
    pub centre: [f64; 3],
    /// The whole rotation, in degrees.
    pub angle: f64,
    /// Normalised mutual information as the entropy correlation coefficient: 0 for unrelated images, 1 for images
    /// that determine each other. Measured on the finest level at the result, and with the two series' coordinates
    /// taken as one (`similarityBefore`, 0 where they do not overlap).
    pub similarity: f64,
    pub similarity_before: f64,
    /// The share of the fixed volume's measured points that fall inside the moving volume at the result.
    pub overlap: f64,
    /// Transforms measured, and levels refined.
    pub evaluations: usize,
    pub levels: usize,
}

/// Whether a series can be registered: a volume placed in the patient, with its own spacing and orientation.
fn check(source: &SourceSeries) -> Result<()> {
    let info = &source.info;
    if !info.can_reconstruct
        || !info.spacing_known
        || !info.orientation_known
        || info.components != 1
        || info.dimensions.iter().any(|n| *n < 2)
    {
        bail!(coded!(
            "registration.needsVolumes",
            "Alignment needs two volumes placed in the patient, with known spacing and orientation"
        ));
    }
    Ok(())
}

pub fn check_pair(fixed: &SourceSeries, moving: &SourceSeries) -> Result<()> {
    check(fixed)?;
    check(moving)?;
    let (a, b) = (&fixed.info, &moving.info);
    if a.patient_key.is_empty()
        || a.patient_key != b.patient_key
        || (a.patient_id.is_empty() && a.patient_name.is_empty())
    {
        bail!(coded!(
            "registration.patientMismatch",
            "Alignment requires both series to belong to the same identified patient"
        ));
    }
    Ok(())
}

/// Finds the transform that lays `moving` over `fixed`. Stops with an error once `cancelled` is set.
pub fn register(
    fixed: (&SourceSeries, &PixelBuffer),
    moving: (&SourceSeries, &PixelBuffer),
    cancelled: &AtomicBool,
) -> Result<Registration> {
    check_pair(fixed.0, moving.0)?;
    let stop = || -> Result<()> {
        if cancelled.load(Ordering::Acquire) || crate::progress::is_stopping() {
            bail!(coded!("job.cancelled", "Operation cancelled"));
        }
        Ok(())
    };
    let pyramid = pyramid(fixed, moving, &stop)?;
    let coarsest = &pyramid[0];
    let finest = &pyramid[pyramid.len() - 1];
    let fixed_range = intensity_range(&finest.fixed);
    let moving_range = intensity_range(&finest.moving);
    if fixed_range.1 <= fixed_range.0 || moving_range.1 <= moving_range.0 {
        bail!(coded!(
            "registration.failed",
            "These series could not be aligned: too little of them overlaps or shows the same anatomy"
        ));
    }
    // The rotation turns about the fixed body's centre, so turning and moving stay apart; the first guess puts the two
    // bodies' centres together.
    let centre = foreground_centre(&coarsest.fixed);
    let start = sub(foreground_centre(&coarsest.moving), centre);
    let floor = (MIN_SHARE_OF_CAPACITY
        * (finest.moving.box_volume() / finest.fixed.box_volume()).min(1.0))
    .max(MIN_OVERLAP);
    let mut evaluations = 0;
    let mut best: Option<([f64; 6], f64)> = None;
    for (index, level) in pyramid.iter().enumerate() {
        stop()?;
        let last = index + 1 == pyramid.len();
        let budget = SAMPLES[SAMPLES.len() - pyramid.len() + index];
        let samples = Samples::new(&level.fixed, centre, budget, fixed_range);
        if samples.points.len() < 64 {
            bail!(coded!(
                "registration.failed",
                "These series could not be aligned: too little of them overlaps or shows the same anatomy"
            ));
        }
        let radius = samples.radius().clamp(30.0, 200.0);
        let measure = Measure {
            samples: &samples,
            moving: &level.moving,
            centre,
            range: moving_range,
            floor,
        };
        let spacing = level.fixed.mean_spacing().max(level.moving.mean_spacing());
        let steps = |translation: f64| {
            [
                translation / radius,
                translation / radius,
                translation / radius,
                translation,
                translation,
                translation,
            ]
        };
        let (first, smallest) = if last {
            (0.5 * spacing, 0.01 * spacing)
        } else {
            (spacing, 0.1 * spacing)
        };
        let starts = match best {
            Some((parameters, _)) => vec![parameters],
            None => {
                let (starts, tried) = long_axis_starts(&measure, level, start, &stop)?;
                evaluations += tried;
                starts
            }
        };
        let mut found: Option<([f64; 6], f64)> = None;
        for parameters in starts {
            let (parameters, cost, used) =
                optimise(&measure, parameters, steps(first), steps(smallest), &stop)?;
            evaluations += used;
            if found.is_none_or(|(_, lowest)| cost < lowest) {
                found = Some((parameters, cost));
            }
        }
        best = found;
    }
    let (parameters, _) = best.expect("at least one level");
    let finest_samples = Samples::new(
        &finest.fixed,
        centre,
        SAMPLES[SAMPLES.len() - 1],
        fixed_range,
    );
    let measure = Measure {
        samples: &finest_samples,
        moving: &finest.moving,
        centre,
        range: moving_range,
        floor,
    };
    let after = measure.evaluate(&parameters);
    // No rotation and no shift: the two series' coordinates taken as one.
    let identity = measure.evaluate(&[0.0; 6]);
    let overlap = after.inside as f64 / finest_samples.points.len().max(1) as f64;
    if overlap < floor || after.nmi <= 1.0 + 1e-6 {
        bail!(coded!(
            "registration.failed",
            "These series could not be aligned: too little of them overlaps or shows the same anatomy"
        ));
    }
    Ok(result(
        parameters,
        centre,
        after,
        identity,
        overlap,
        evaluations + 2,
        pyramid.len(),
    ))
}

fn result(
    parameters: [f64; 6],
    centre: [f64; 3],
    after: Score,
    before: Score,
    overlap: f64,
    evaluations: usize,
    levels: usize,
) -> Registration {
    let rotation = rotation_matrix(&parameters);
    let shift = [parameters[3], parameters[4], parameters[5]];
    // Fixed to moving: p ↦ R (p − c) + c + t. Its inverse, moving to fixed: p ↦ Rᵀ (p − c − t) + c.
    let back = transpose(rotation);
    let offset = sub(centre, mul(back, add(centre, shift)));
    let mut matrix = [0.0; 16];
    for row in 0..3 {
        for column in 0..3 {
            matrix[row * 4 + column] = back[row * 3 + column];
        }
        matrix[row * 4 + 3] = offset[row];
    }
    matrix[15] = 1.0;
    let trace = rotation[0] + rotation[4] + rotation[8];
    let angle = ((trace - 1.0) / 2.0).clamp(-1.0, 1.0).acos().to_degrees();
    let ecc = |score: Score| {
        if score.inside == 0 {
            0.0
        } else {
            (2.0 - 2.0 / score.nmi).max(0.0)
        }
    };
    Registration {
        matrix,
        rotation: [
            parameters[0].to_degrees(),
            parameters[1].to_degrees(),
            parameters[2].to_degrees(),
        ],
        shift,
        centre,
        angle,
        similarity: ecc(after),
        similarity_before: ecc(before),
        overlap,
        evaluations,
        levels,
    }
}

/// One level of both volumes.
struct Pair {
    fixed: Level,
    moving: Level,
}

/// A volume box-averaged to a coarser grid: its values (NaN where the series has none: padding, or not a number) and
/// where its voxels lie in the patient.
struct Level {
    dims: [usize; 3],
    values: Vec<f32>,
    grid: Grid,
    spacing: [f64; 3],
}

impl Level {
    fn world(&self, index: [f64; 3]) -> [f64; 3] {
        let axes = &self.grid.axes;
        std::array::from_fn(|row| {
            self.grid.origin[row]
                + axes[0][row] * index[0]
                + axes[1][row] * index[1]
                + axes[2][row] * index[2]
        })
    }

    /// The space its voxels fill, in mm³.
    fn box_volume(&self) -> f64 {
        let [a, b, c] = self.grid.axes;
        let determinant = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
        determinant.abs() * self.dims.iter().product::<usize>() as f64
    }

    fn mean_spacing(&self) -> f64 {
        (self.spacing[0] * self.spacing[1] * self.spacing[2]).cbrt()
    }

    /// The trilinear value at a voxel index; None outside the volume or next to a voxel without a value.
    #[inline]
    fn sample(&self, index: [f64; 3]) -> Option<f32> {
        let [nx, ny, nz] = self.dims;
        let [x, y, z] = index;
        if !(x >= 0.0
            && y >= 0.0
            && z >= 0.0
            && x <= (nx - 1) as f64
            && y <= (ny - 1) as f64
            && z <= (nz - 1) as f64)
        {
            return None;
        }
        let (x0, y0, z0) = (
            (x as usize).min(nx - 2),
            (y as usize).min(ny - 2),
            (z as usize).min(nz - 2),
        );
        let value = trilinear(
            &self.values,
            nx,
            nx * ny,
            x0 + nx * y0 + nx * ny * z0,
            [
                (x - x0 as f64) as f32,
                (y - y0 as f64) as f32,
                (z - z0 as f64) as f32,
            ],
        );
        value.is_finite().then_some(value)
    }

    /// The patient z (feet to head) its voxel centres span.
    fn z_extent(&self) -> [f64; 2] {
        let [nx, ny, nz] = self.dims.map(|n| (n - 1) as f64);
        let mut extent = [f64::INFINITY, f64::NEG_INFINITY];
        for corner in 0..8 {
            let index = [
                if corner & 1 == 0 { 0.0 } else { nx },
                if corner & 2 == 0 { 0.0 } else { ny },
                if corner & 4 == 0 { 0.0 } else { nz },
            ];
            let z = self.world(index)[2];
            extent = [extent[0].min(z), extent[1].max(z)];
        }
        extent
    }
}

/// The value between eight voxels, `at` the first; NaN if any of them is NaN.
#[inline]
fn trilinear(values: &[f32], row: usize, plane: usize, at: usize, f: [f32; 3]) -> f32 {
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let c00 = lerp(values[at], values[at + 1], f[0]);
    let c10 = lerp(values[at + row], values[at + row + 1], f[0]);
    let c01 = lerp(values[at + plane], values[at + plane + 1], f[0]);
    let c11 = lerp(values[at + plane + row], values[at + plane + row + 1], f[0]);
    lerp(lerp(c00, c10, f[1]), lerp(c01, c11, f[1]), f[2])
}

/// Both volumes at each level, coarse to fine; a level that would repeat the one before it is left out.
fn pyramid(
    fixed: (&SourceSeries, &PixelBuffer),
    moving: (&SourceSeries, &PixelBuffer),
    stop: &dyn Fn() -> Result<()>,
) -> Result<Vec<Pair>> {
    let mut targets: Vec<Option<f64>> = COARSE_SPACING
        .iter()
        .map(|spacing| Some(*spacing))
        .collect();
    targets.push(None);
    let mut levels: Vec<([usize; 3], [usize; 3])> = Vec::new();
    for target in targets {
        let factors = (factors(fixed.0, target), factors(moving.0, target));
        if let Some(previous) = levels.last()
            && (0..3).all(|axis| {
                factors.0[axis] >= previous.0[axis] && factors.1[axis] >= previous.1[axis]
            })
        {
            // Not finer than the level before: replaces it only if it is the same.
            continue;
        }
        levels.push(factors);
    }
    let mut pyramid = Vec::with_capacity(levels.len());
    for (fixed_factors, moving_factors) in levels {
        stop()?;
        let fixed = level(fixed.0, fixed.1, fixed_factors)?;
        stop()?;
        pyramid.push(Pair {
            fixed,
            moving: level(moving.0, moving.1, moving_factors)?,
        });
    }
    Ok(pyramid)
}

/// How many voxels of a series go into one voxel of a level, along each axis: about `target` mm (the series' own
/// voxels when None), within `MAX_LEVEL_VOXELS`, leaving at least two voxels along each axis.
fn factors(source: &SourceSeries, target: Option<f64>) -> [usize; 3] {
    let dims = source.info.dimensions;
    let spacing = source.info.spacing;
    let for_target = |target: f64| -> [usize; 3] {
        std::array::from_fn(|axis| {
            ((target / spacing[axis]).round().max(1.0) as usize).min((dims[axis] / 2).max(1))
        })
    };
    let voxels = |factors: [usize; 3]| {
        (0..3)
            .map(|axis| dims[axis] / factors[axis])
            .product::<usize>()
    };
    let mut target =
        target.unwrap_or_else(|| spacing.iter().copied().fold(f64::INFINITY, f64::min));
    let mut factors = for_target(target);
    while voxels(factors) > MAX_LEVEL_VOXELS {
        target *= 1.25;
        let coarser = for_target(target);
        if coarser == factors {
            // Every axis is as coarse as it can go.
            if (0..3).all(|axis| factors[axis] >= (dims[axis] / 2).max(1)) {
                break;
            }
            continue;
        }
        factors = coarser;
    }
    factors
}

/// A series box-averaged by `factors`: each level voxel is the mean of the series voxels it covers that have a value.
fn level(source: &SourceSeries, pixels: &PixelBuffer, factors: [usize; 3]) -> Result<Level> {
    let info = &source.info;
    let dims: [usize; 3] =
        std::array::from_fn(|axis| (info.dimensions[axis] / factors[axis]).max(1));
    anyhow::ensure!(
        info.dimensions.iter().product::<usize>() == pixels.len(),
        "Invalid volume buffer"
    );
    let full = Grid::new(info.origin, info.direction, info.spacing)?;
    let spacing: [f64; 3] = std::array::from_fn(|axis| info.spacing[axis] * factors[axis] as f64);
    // The level's first voxel is the centre of the series voxels it averages.
    let origin: [f64; 3] = std::array::from_fn(|row| {
        info.origin[row]
            + (0..3)
                .map(|axis| full.axes[axis][row] * (factors[axis] as f64 - 1.0) / 2.0)
                .sum::<f64>()
    });
    let grid = Grid::new(origin, info.direction, spacing)?;
    // Padding as `PixelBuffer::is_padding` reads it, frame by frame (a frame is a slice of the volume).
    let single = matches!(pixels, PixelBuffer::F32(_));
    let padding: Vec<Option<[f64; 2]>> = (0..info.dimensions[2])
        .map(|frame| {
            let range = source
                .frames
                .get(frame)
                .and_then(|f| f.metadata.padding_range)
                .or(info.padding_range)?;
            let [a, b] = if single {
                range.map(|n| f64::from(n as f32))
            } else {
                range
            };
            Some([a.min(b), a.max(b)])
        })
        .collect();
    let values = match pixels {
        PixelBuffer::I16(data) => average(data, info.dimensions, factors, dims, &padding),
        PixelBuffer::U16(data) => average(data, info.dimensions, factors, dims, &padding),
        PixelBuffer::U8(data) => average(data, info.dimensions, factors, dims, &padding),
        PixelBuffer::F32(data) => average(data, info.dimensions, factors, dims, &padding),
        PixelBuffer::F64(data) => average(data, info.dimensions, factors, dims, &padding),
    };
    Ok(Level {
        dims,
        values,
        grid,
        spacing,
    })
}

fn average<T: Copy + Into<f64> + Sync>(
    data: &[T],
    full: [usize; 3],
    factors: [usize; 3],
    dims: [usize; 3],
    padding: &[Option<[f64; 2]>],
) -> Vec<f32> {
    let plane = dims[0] * dims[1];
    let mut values = vec![f32::NAN; plane * dims[2]];
    // The level voxel each series column and row falls in; series voxels past the last whole block are left out.
    let column: Vec<usize> = (0..dims[0] * factors[0]).map(|x| x / factors[0]).collect();
    let row: Vec<usize> = (0..dims[1] * factors[1]).map(|y| y / factors[1]).collect();
    let threads = crate::parallel::available(2).min(8);
    crate::parallel::for_each(
        "register-level",
        threads,
        values.chunks_mut(plane).enumerate(),
        |(z, target)| {
            let mut sums = vec![0.0f64; plane];
            let mut counts = vec![0u32; plane];
            for source_z in z * factors[2]..(z + 1) * factors[2] {
                let range = padding.get(source_z).copied().flatten();
                for (y, &level_row) in row.iter().enumerate() {
                    let start = (source_z * full[1] + y) * full[0];
                    let line = &data[start..start + column.len()];
                    for (value, &level_column) in line.iter().zip(&column) {
                        let value: f64 = (*value).into();
                        if !value.is_finite()
                            || range.is_some_and(|[low, high]| value >= low && value <= high)
                        {
                            continue;
                        }
                        let at = level_row * dims[0] + level_column;
                        sums[at] += value;
                        counts[at] += 1;
                    }
                }
            }
            for ((target, sum), count) in target.iter_mut().zip(&sums).zip(&counts) {
                if *count > 0 {
                    *target = (sum / f64::from(*count)) as f32;
                }
            }
        },
    );
    values
}

/// The values the joint histogram spans: from the 0.5th to the 99.5th percentile, so a few extreme voxels do not
/// squeeze everything else into a few bins.
fn intensity_range(level: &Level) -> (f32, f32) {
    let stride = (level.values.len() / 262_144).max(1);
    let mut values: Vec<f32> = level
        .values
        .iter()
        .step_by(stride)
        .copied()
        .filter(|v| v.is_finite())
        .collect();
    if values.is_empty() {
        return (0.0, 0.0);
    }
    values.sort_by(f32::total_cmp);
    let at = |share: f64| values[((values.len() - 1) as f64 * share).round() as usize];
    (at(0.005), at(0.995))
}

/// The centre of the body: the mean place of the voxels above the threshold that best splits the values in two
/// (Otsu's), which parts air from tissue on a CT and background from the body on PET; all voxels if none is above it.
fn foreground_centre(level: &Level) -> [f64; 3] {
    let (low, high) = level
        .values
        .iter()
        .filter(|v| v.is_finite())
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(a, b), v| {
            (a.min(*v), b.max(*v))
        });
    let threshold = if high > low {
        let mut histogram = [0u64; 256];
        let scale = 255.0 / (high - low) as f64;
        for value in level.values.iter().filter(|v| v.is_finite()) {
            histogram[(((*value - low) as f64 * scale) as usize).min(255)] += 1;
        }
        let total: u64 = histogram.iter().sum();
        let weighted: f64 = histogram
            .iter()
            .enumerate()
            .map(|(bin, n)| bin as f64 * *n as f64)
            .sum();
        let (mut below, mut below_weighted, mut best, mut split) = (0u64, 0.0, -1.0, 0usize);
        for (bin, n) in histogram.iter().enumerate() {
            below += n;
            below_weighted += bin as f64 * *n as f64;
            let above = total - below;
            if below == 0 || above == 0 {
                continue;
            }
            let difference =
                below_weighted / below as f64 - (weighted - below_weighted) / above as f64;
            let between = below as f64 * above as f64 * difference * difference;
            if between > best {
                best = between;
                split = bin;
            }
        }
        low as f64 + (split as f64 + 1.0) / scale
    } else {
        f64::NEG_INFINITY
    };
    let mut sum = [0.0; 3];
    let mut count = 0usize;
    let mut all = [0.0; 3];
    let mut all_count = 0usize;
    let [nx, ny, _] = level.dims;
    for (at, value) in level.values.iter().enumerate() {
        if !value.is_finite() {
            continue;
        }
        let p = level.world([
            (at % nx) as f64,
            ((at / nx) % ny) as f64,
            (at / (nx * ny)) as f64,
        ]);
        all = add(all, p);
        all_count += 1;
        if *value as f64 > threshold {
            sum = add(sum, p);
            count += 1;
        }
    }
    let (sum, count) = if count > 0 {
        (sum, count)
    } else {
        (all, all_count.max(1))
    };
    sum.map(|v| v / count as f64)
}

/// The fixed volume's measured points: where each lies relative to the rotation centre, and its histogram bin.
struct Samples {
    points: Vec<[f32; 3]>,
    bins: Vec<u16>,
}

impl Samples {
    /// About `count` points on a regular grid of the level, each set off within its voxel by a repeatable jitter.
    fn new(level: &Level, centre: [f64; 3], count: usize, range: (f32, f32)) -> Self {
        let voxels = level.values.len();
        let stride = ((voxels as f64 / count as f64).cbrt().ceil() as usize).max(1);
        let scale = BINS as f32 / (range.1 - range.0).max(f32::MIN_POSITIVE);
        let (mut points, mut bins) = (Vec::new(), Vec::new());
        let [nx, ny, nz] = level.dims;
        for z in (stride / 2..nz).step_by(stride) {
            for y in (stride / 2..ny).step_by(stride) {
                for x in (stride / 2..nx).step_by(stride) {
                    let jitter = jitter((z * ny + y) * nx + x);
                    let index = [
                        x as f64 + jitter[0],
                        y as f64 + jitter[1],
                        z as f64 + jitter[2],
                    ];
                    let Some(value) = level.sample(index) else {
                        continue;
                    };
                    let place = sub(level.world(index), centre);
                    points.push(place.map(|v| v as f32));
                    bins.push(
                        (((value - range.0) * scale) as i64).clamp(0, BINS as i64 - 1) as u16,
                    );
                }
            }
        }
        Self { points, bins }
    }

    /// How far the points lie from the centre, root mean square: a turn of one radian moves them about this far.
    fn radius(&self) -> f64 {
        let sum: f64 = self
            .points
            .iter()
            .map(|p| p.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>())
            .sum();
        (sum / self.points.len().max(1) as f64).sqrt()
    }
}

/// A repeatable offset within ±0.4 voxel for the point numbered `index` (SplitMix64).
fn jitter(index: usize) -> [f64; 3] {
    let mut state = (index as u64)
        .wrapping_mul(0x9e37_79b9_7f4a_7c15)
        .wrapping_add(0x6a09_e667_f3bc_c909);
    std::array::from_fn(|_| {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^= z >> 31;
        ((z >> 11) as f64 / (1u64 << 53) as f64 - 0.5) * 0.8
    })
}

#[derive(Clone, Copy, Debug)]
struct Score {
    nmi: f64,
    inside: usize,
}

/// Measures how well a transform lays the moving level over the fixed points.
struct Measure<'a> {
    samples: &'a Samples,
    moving: &'a Level,
    centre: [f64; 3],
    range: (f32, f32),
    /// The least share of the points that must fall inside the moving volume.
    floor: f64,
}

impl Measure<'_> {
    /// Lower is better: minus the normalised mutual information, or 0 when too few points overlap to say.
    fn cost(&self, parameters: &[f64; 6]) -> f64 {
        let score = self.evaluate(parameters);
        if (score.inside as f64) < self.floor * self.samples.points.len() as f64
            || score.inside < 64
        {
            return 0.0;
        }
        -score.nmi
    }

    fn evaluate(&self, parameters: &[f64; 6]) -> Score {
        // Fixed point p, stored as p − c, to the moving index: M⁻¹ (R (p − c) + c + t − o).
        let rotation = rotation_matrix(parameters);
        let a = multiply3(self.moving.grid.inverse, rotation);
        let b = mul(
            self.moving.grid.inverse,
            sub(
                add(self.centre, [parameters[3], parameters[4], parameters[5]]),
                self.moving.grid.origin,
            ),
        );
        let [nx, ny, nz] = self.moving.dims;
        let (mx, my, mz) = ((nx - 1) as f64, (ny - 1) as f64, (nz - 1) as f64);
        let (row, plane) = (nx, nx * ny);
        let values = &self.moving.values;
        let low = self.range.0;
        let scale = (BINS - 1) as f32 / (self.range.1 - self.range.0).max(f32::MIN_POSITIVE);
        let mut histogram = vec![0.0f64; BINS * BINS];
        let mut inside = 0usize;
        for (point, bin) in self.samples.points.iter().zip(&self.samples.bins) {
            let q = point.map(f64::from);
            let x = a[0] * q[0] + a[1] * q[1] + a[2] * q[2] + b[0];
            let y = a[3] * q[0] + a[4] * q[1] + a[5] * q[2] + b[1];
            let z = a[6] * q[0] + a[7] * q[1] + a[8] * q[2] + b[2];
            if !(x >= 0.0 && y >= 0.0 && z >= 0.0 && x <= mx && y <= my && z <= mz) {
                continue;
            }
            let (x0, y0, z0) = (
                (x as usize).min(nx - 2),
                (y as usize).min(ny - 2),
                (z as usize).min(nz - 2),
            );
            let value = trilinear(
                values,
                row,
                plane,
                x0 + row * y0 + plane * z0,
                [
                    (x - x0 as f64) as f32,
                    (y - y0 as f64) as f32,
                    (z - z0 as f64) as f32,
                ],
            );
            if !value.is_finite() {
                continue;
            }
            inside += 1;
            let u = ((value - low) * scale).clamp(0.0, (BINS - 1) as f32);
            let lower = (u as usize).min(BINS - 2);
            let weight = f64::from(u - lower as f32);
            let at = *bin as usize * BINS + lower;
            histogram[at] += 1.0 - weight;
            histogram[at + 1] += weight;
        }
        Score {
            nmi: normalised_mutual_information(&histogram),
            inside,
        }
    }
}

/// (H(F) + H(M)) / H(F, M) from a joint histogram: 1 for independent images, 2 for images that determine each other.
fn normalised_mutual_information(histogram: &[f64]) -> f64 {
    let total: f64 = histogram.iter().sum();
    if total <= 0.0 {
        return 1.0;
    }
    let mut rows = [0.0f64; BINS];
    let mut columns = [0.0f64; BINS];
    let mut joint = 0.0;
    for (at, h) in histogram.iter().enumerate() {
        if *h > 0.0 {
            joint += h * h.ln();
            rows[at / BINS] += h;
            columns[at % BINS] += h;
        }
    }
    let entropy = |sum_h_ln_h: f64| total.ln() - sum_h_ln_h / total;
    let marginal = |values: &[f64]| {
        values
            .iter()
            .filter(|h| **h > 0.0)
            .map(|h| h * h.ln())
            .sum::<f64>()
    };
    let joint_entropy = entropy(joint);
    if joint_entropy <= 1e-12 {
        return 1.0;
    }
    (entropy(marginal(&rows)) + entropy(marginal(&columns))) / joint_entropy
}

/// Starting points for the coarsest level: the shift that puts the two bodies' centres together, moved along the
/// patient's long axis a level voxel at a time wherever the two volumes then share enough length, measured without
/// rotation; the three best local minima of those, and the two series' own coordinates taken as one.
fn long_axis_starts(
    measure: &Measure,
    level: &Pair,
    start: [f64; 3],
    stop: &dyn Fn() -> Result<()>,
) -> Result<(Vec<[f64; 6]>, usize)> {
    stop()?;
    let fixed = level.fixed.z_extent();
    let moving = level.moving.z_extent();
    let shorter = (fixed[1] - fixed[0]).min(moving[1] - moving[0]);
    let step = level
        .fixed
        .spacing
        .iter()
        .copied()
        .fold(f64::INFINITY, f64::min)
        .max(
            level
                .moving
                .spacing
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min),
        );
    // A shift t puts moving z at fixed z − t.
    let shared = |shift: f64| {
        (fixed[1].min(moving[1] - shift) - fixed[0].max(moving[0] - shift)) / shorter.max(1e-6)
    };
    let reach = ((fixed[1] - fixed[0]) + (moving[1] - moving[0])) / step;
    let count = reach.ceil() as i64 + 1;
    let candidates: Vec<[f64; 6]> = (-count..=count)
        .map(|n| {
            [
                0.0,
                0.0,
                0.0,
                start[0],
                start[1],
                start[2] + n as f64 * step,
            ]
        })
        .filter(|candidate| shared(candidate[5]) >= MIN_EXTENT_OVERLAP)
        .collect();
    let costs = costs(measure, &candidates);
    let mut minima: Vec<(f64, usize)> = (0..candidates.len())
        .filter(|&n| {
            costs[n] < 0.0
                && (n == 0 || costs[n] <= costs[n - 1])
                && (n + 1 == candidates.len() || costs[n] <= costs[n + 1])
        })
        .map(|n| (costs[n], n))
        .collect();
    minima.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut starts: Vec<[f64; 6]> = minima.iter().take(3).map(|(_, n)| candidates[*n]).collect();
    let own = [0.0; 6];
    if measure.cost(&own) < 0.0 && !starts.contains(&own) {
        starts.push(own);
    }
    if starts.is_empty() {
        starts.push([0.0, 0.0, 0.0, start[0], start[1], start[2]]);
    }
    Ok((starts, candidates.len() + 1))
}

/// Each candidate's cost, measured in parallel, each by one thread from start to end.
fn costs(measure: &Measure, candidates: &[[f64; 6]]) -> Vec<f64> {
    let mut costs = vec![0.0; candidates.len()];
    let threads = crate::parallel::available(2)
        .min(12)
        .min(candidates.len().max(1));
    crate::parallel::for_each(
        "register",
        threads,
        costs.iter_mut().zip(candidates),
        |(cost, candidate)| *cost = measure.cost(candidate),
    );
    costs
}

/// Compass search: each sweep measures every parameter moved by its step either way and takes the best move that
/// lowers the cost, then goes on that way while it keeps lowering it; a sweep with none halves every step, until the
/// steps are below `smallest`.
fn optimise(
    measure: &Measure,
    start: [f64; 6],
    first: [f64; 6],
    smallest: [f64; 6],
    stop: &dyn Fn() -> Result<()>,
) -> Result<([f64; 6], f64, usize)> {
    let mut point = start;
    let mut cost = measure.cost(&point);
    let mut steps = first;
    let mut evaluations = 1;
    for _ in 0..MAX_SWEEPS {
        stop()?;
        if (0..6).all(|n| steps[n] < smallest[n]) {
            break;
        }
        let moves: Vec<(usize, f64)> = (0..6)
            .filter(|n| steps[*n] >= smallest[*n])
            .flat_map(|n| [(n, steps[n]), (n, -steps[n])])
            .collect();
        let candidates: Vec<[f64; 6]> = moves
            .iter()
            .map(|(n, delta)| {
                let mut moved = point;
                moved[*n] += delta;
                moved
            })
            .collect();
        let found = costs(measure, &candidates);
        evaluations += candidates.len();
        let best =
            (0..candidates.len()).min_by(|a, b| found[*a].total_cmp(&found[*b]).then(a.cmp(b)));
        match best {
            Some(n) if found[n] < cost - 1e-12 => {
                point = candidates[n];
                cost = found[n];
                let (axis, delta) = moves[n];
                loop {
                    let mut further = point;
                    further[axis] += delta;
                    let further_cost = measure.cost(&further);
                    evaluations += 1;
                    if further_cost < cost - 1e-12 {
                        point = further;
                        cost = further_cost;
                    } else {
                        break;
                    }
                }
            }
            _ => steps = steps.map(|step| step / 2.0),
        }
    }
    Ok((point, cost, evaluations))
}

/// R = Rz(γ) Ry(β) Rx(α), row-major, from the parameters' first three (radians).
fn rotation_matrix(parameters: &[f64; 6]) -> [f64; 9] {
    let (sa, ca) = parameters[0].sin_cos();
    let (sb, cb) = parameters[1].sin_cos();
    let (sg, cg) = parameters[2].sin_cos();
    [
        cg * cb,
        cg * sb * sa - sg * ca,
        cg * sb * ca + sg * sa,
        sg * cb,
        sg * sb * sa + cg * ca,
        sg * sb * ca - cg * sa,
        -sb,
        cb * sa,
        cb * ca,
    ]
}

fn multiply3(a: [f64; 9], b: [f64; 9]) -> [f64; 9] {
    std::array::from_fn(|at| {
        let (row, column) = (at / 3, at % 3);
        (0..3).map(|k| a[row * 3 + k] * b[k * 3 + column]).sum()
    })
}

fn transpose(m: [f64; 9]) -> [f64; 9] {
    [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

fn mul(m: [f64; 9], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|row| m[row * 3] * v[0] + m[row * 3 + 1] * v[1] + m[row * 3 + 2] * v[2])
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{geometry::Geometry, model::Series};

    /// A body of known shape in patient millimetres: a trunk with lungs, a spine, a liver and two hot spheres. `pet`
    /// gives PET-like values (uptake), else CT-like ones (HU).
    fn body(p: [f64; 3], pet: bool) -> f32 {
        let inside = |c: [f64; 3], r: [f64; 3]| {
            ((p[0] - c[0]) / r[0]).powi(2)
                + ((p[1] - c[1]) / r[1]).powi(2)
                + ((p[2] - c[2]) / r[2]).powi(2)
                <= 1.0
        };
        if !inside([0.0, 0.0, 0.0], [70.0, 50.0, 400.0]) {
            return if pet { 0.0 } else { -1000.0 };
        }
        let (mut hu, mut uptake) = (40.0, 1.0);
        if (p[0]).hypot(p[1] - 32.0) < 9.0 {
            (hu, uptake) = (700.0, 1.1);
        }
        for side in [-1.0, 1.0] {
            if inside([side * 32.0, -4.0, 20.0], [22.0, 28.0, 45.0]) {
                (hu, uptake) = (-820.0, 0.3);
            }
        }
        if inside([-30.0, 0.0, -50.0], [30.0, 28.0, 22.0]) {
            (hu, uptake) = (60.0, 2.0);
        }
        if inside([22.0, -10.0, -30.0], [9.0, 9.0, 9.0]) {
            (hu, uptake) = (30.0, 8.0);
        }
        if inside([10.0, 15.0, 45.0], [6.0, 6.0, 6.0]) {
            (hu, uptake) = (50.0, 5.0);
        }
        if pet { uptake * 1000.0 } else { hu }
    }

    /// A volume of `body` sampled on a grid whose patient coordinates are the body's moved by `to_body` (a point of the
    /// volume's coordinates is at `to_body(p)` in the body's).
    fn volume(
        dims: [usize; 3],
        spacing: [f64; 3],
        origin: [f64; 3],
        pet: bool,
        to_body: impl Fn([f64; 3]) -> [f64; 3],
    ) -> (SourceSeries, PixelBuffer) {
        let direction = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let mut values = Vec::with_capacity(dims.iter().product());
        for z in 0..dims[2] {
            for y in 0..dims[1] {
                for x in 0..dims[0] {
                    let p = [
                        origin[0] + x as f64 * spacing[0],
                        origin[1] + y as f64 * spacing[1],
                        origin[2] + z as f64 * spacing[2],
                    ];
                    values.push(body(to_body(p), pet));
                }
            }
        }
        let info = Series {
            patient_key: "synthetic-site-patient".into(),
            patient_id: "SYNTHETIC".into(),
            dimensions: dims,
            spacing,
            origin,
            direction,
            can_reconstruct: true,
            spacing_known: true,
            orientation_known: true,
            components: 1,
            modality: if pet { "PT".into() } else { "CT".into() },
            ..Default::default()
        };
        let geometry = Geometry {
            order: (0..dims[2]).collect(),
            spacing,
            origin,
            direction,
            can_reconstruct: true,
            has_physical_geometry: true,
            warnings: Vec::new(),
        };
        (
            SourceSeries {
                info,
                frames: Vec::new(),
                geometry,
                documents: Vec::new(),
            },
            PixelBuffer::F32(values),
        )
    }

    /// The rigid transform taking the body's coordinates to a moved volume's, and its inverse.
    fn moved(rotation: [f64; 3], shift: [f64; 3]) -> (impl Fn([f64; 3]) -> [f64; 3], [f64; 9]) {
        let r = rotation_matrix(&[
            rotation[0].to_radians(),
            rotation[1].to_radians(),
            rotation[2].to_radians(),
            0.0,
            0.0,
            0.0,
        ]);
        // The moving volume's point p shows the body at Rᵀ (p − shift).
        let to_body = move |p: [f64; 3]| mul(transpose(r), sub(p, shift));
        (to_body, r)
    }

    fn apply(matrix: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
        std::array::from_fn(|row| {
            matrix[row * 4] * p[0]
                + matrix[row * 4 + 1] * p[1]
                + matrix[row * 4 + 2] * p[2]
                + matrix[row * 4 + 3]
        })
    }

    /// The farthest a point of the fixed volume lands from where it should, over the corners of a 200 mm box.
    fn worst_error(found: &Registration, truth: impl Fn([f64; 3]) -> [f64; 3]) -> f64 {
        let mut worst: f64 = 0.0;
        for corner in 0..8 {
            let p = [
                if corner & 1 == 0 { -60.0 } else { 60.0 },
                if corner & 2 == 0 { -45.0 } else { 45.0 },
                if corner & 4 == 0 { -100.0 } else { 100.0 },
            ];
            // `truth` maps a moving point to the fixed (body) one; the found matrix does the same.
            let q = truth(p);
            let error = sub(apply(&found.matrix, p), q);
            worst = worst.max((error[0].powi(2) + error[1].powi(2) + error[2].powi(2)).sqrt());
        }
        worst
    }

    static NEVER: AtomicBool = AtomicBool::new(false);

    #[test]
    fn a_ct_moved_and_turned_is_laid_back_over_the_first_within_half_a_millimetre() {
        let fixed = volume(
            [48, 40, 56],
            [3.0, 3.0, 4.0],
            [-70.5, -58.5, -110.0],
            false,
            |p| p,
        );
        let (to_body, rotation) = moved([3.0, -2.0, 5.0], [6.0, -9.0, 34.0]);
        // Another grid, as another visit's: its own spacing, extent and place.
        let moving = volume(
            [52, 44, 60],
            [2.8, 2.6, 3.5],
            [-73.0, -50.0, -80.0],
            false,
            to_body,
        );
        let found = register((&fixed.0, &fixed.1), (&moving.0, &moving.1), &NEVER).unwrap();
        let truth = |p: [f64; 3]| mul(transpose(rotation), sub(p, [6.0, -9.0, 34.0]));
        let error = worst_error(&found, truth);
        assert!(error < 0.5, "worst error {error:.3} mm: {found:?}");
        assert!((found.angle - 6.16).abs() < 0.2, "{found:?}");
        assert!(
            found.similarity > found.similarity_before && found.similarity > 0.3,
            "{found:?}"
        );
        assert!(found.overlap > 0.5, "{found:?}");
    }

    #[test]
    fn a_pet_is_laid_over_a_ct_of_the_same_body_acquired_apart() {
        let fixed = volume(
            [48, 40, 56],
            [3.0, 3.0, 4.0],
            [-70.5, -58.5, -110.0],
            false,
            |p| p,
        );
        let (to_body, rotation) = moved([0.0, 0.0, -4.0], [-5.0, 7.0, -20.0]);
        let moving = volume(
            [36, 30, 40],
            [4.0, 4.0, 4.0],
            [-70.0, -60.0, -60.0],
            true,
            to_body,
        );
        let found = register((&fixed.0, &fixed.1), (&moving.0, &moving.1), &NEVER).unwrap();
        let truth = |p: [f64; 3]| mul(transpose(rotation), sub(p, [-5.0, 7.0, -20.0]));
        let error = worst_error(&found, truth);
        assert!(error < 1.0, "worst error {error:.3} mm: {found:?}");
    }

    #[test]
    fn the_same_registration_twice_gives_the_same_bits() {
        let fixed = volume(
            [32, 28, 36],
            [4.0, 4.0, 5.0],
            [-62.0, -54.0, -90.0],
            false,
            |p| p,
        );
        let (to_body, _) = moved([1.0, 2.0, -3.0], [3.0, 2.0, 12.0]);
        let moving = volume(
            [32, 28, 36],
            [4.0, 4.0, 5.0],
            [-62.0, -54.0, -80.0],
            false,
            to_body,
        );
        let first = register((&fixed.0, &fixed.1), (&moving.0, &moving.1), &NEVER).unwrap();
        let second = register((&fixed.0, &fixed.1), (&moving.0, &moving.1), &NEVER).unwrap();
        assert_eq!(
            first.matrix.map(f64::to_bits),
            second.matrix.map(f64::to_bits)
        );
        assert_eq!(first, second);
    }

    #[test]
    fn a_volume_that_is_not_placed_or_has_nothing_to_match_is_refused() {
        let (mut flat, pixels) = volume(
            [16, 16, 16],
            [4.0, 4.0, 4.0],
            [-32.0, -32.0, -32.0],
            false,
            |p| p,
        );
        flat.info.can_reconstruct = false;
        let (other, other_pixels) = volume(
            [16, 16, 16],
            [4.0, 4.0, 4.0],
            [-32.0, -32.0, -32.0],
            false,
            |p| p,
        );
        let error = register((&flat, &pixels), (&other, &other_pixels), &NEVER).unwrap_err();
        assert_eq!(
            crate::message::coded(&error).map(|note| note.code),
            Some("registration.needsVolumes")
        );
        flat.info.can_reconstruct = true;
        flat.info.patient_key = "different-issuer".into();
        let error = register((&flat, &pixels), (&other, &other_pixels), &NEVER).unwrap_err();
        assert_eq!(
            crate::message::coded(&error).map(|note| note.code),
            Some("registration.patientMismatch")
        );
        flat.info.patient_key.clone_from(&other.info.patient_key);
        let blank = PixelBuffer::F32(vec![5.0; 16 * 16 * 16]);
        let error = register((&flat, &blank), (&other, &other_pixels), &NEVER).unwrap_err();
        assert_eq!(
            crate::message::coded(&error).map(|note| note.code),
            Some("registration.failed")
        );
    }

    #[test]
    fn a_cancelled_registration_stops() {
        let fixed = volume(
            [16, 16, 16],
            [4.0, 4.0, 4.0],
            [-32.0, -32.0, -32.0],
            false,
            |p| p,
        );
        let cancelled = AtomicBool::new(true);
        let error = register((&fixed.0, &fixed.1), (&fixed.0, &fixed.1), &cancelled).unwrap_err();
        assert_eq!(
            crate::message::coded(&error).map(|note| note.code),
            Some("job.cancelled")
        );
    }

    #[test]
    fn padding_is_left_out_of_a_level() {
        let (mut source, _) = volume([4, 4, 2], [1.0, 1.0, 1.0], [0.0, 0.0, 0.0], false, |p| p);
        source.info.padding_range = Some([-2000.0, -2000.0]);
        let mut values = vec![10.0f32; 32];
        values[0] = -2000.0;
        let level = level(&source, &PixelBuffer::F32(values), [2, 2, 1]).unwrap();
        assert_eq!(level.dims, [2, 2, 2]);
        assert!(
            level.values.iter().all(|v| *v == 10.0),
            "{:?}",
            level.values
        );
        // The level's first voxel is the centre of the four it averages.
        assert_eq!(level.world([0.0, 0.0, 0.0]), [0.5, 0.5, 0.0]);
    }
}
