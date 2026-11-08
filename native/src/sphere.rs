//! Spherical VOI statistics and the highest complete 1 cm³ weighted sphere inside it.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use crate::geometry::{dot, norm, sub};
use crate::model::SourceSeries;
use crate::probe::{Reader, Sample};
use crate::sampling::{Grid, Normalization, PatientPoint, Stats, Vector, VoxelPoint};
use crate::sphere_threshold::{self, Metabolic, Threshold};

const MAX_VOXELS: usize = 16_000_000;
fn peak_radius() -> f64 {
    (750. / std::f64::consts::PI).cbrt()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sphere {
    center: PatientPoint,
    radius: f64,
    #[serde(default)]
    normalization: Normalization,
    #[serde(default)]
    threshold: Option<Threshold>,
    #[serde(default)]
    region_seeds: Vec<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SphereResult {
    unit: String,
    count: usize,
    mean: f64,
    max: f64,
    min: f64,
    standard_deviation: f64,
    max_at: Vector,
    volume_ml: f64,
    diameter_mm: f64,
    peak: Option<Peak>,
    metabolic: Option<Metabolic>,
    clipped: bool,
    padding_count: usize,
    invalid_count: usize,
}
#[derive(Serialize)]
struct Peak {
    value: f64,
    at: Vector,
}

pub(super) fn position(n: usize, size: [usize; 3]) -> [usize; 3] {
    [n % size[0], n / size[0] % size[1], n / (size[0] * size[1])]
}
fn offset(p: [usize; 3], size: [usize; 3]) -> usize {
    (p[2] * size[1] + p[1]) * size[0] + p[0]
}
fn linear(axes: [Vector; 3], p: Vector) -> Vector {
    std::array::from_fn(|i| p[0] * axes[0][i] + p[1] * axes[1][i] + p[2] * axes[2][i])
}

struct Kernel {
    weights: Vec<([isize; 3], f64)>,
    total: f64,
    half: [usize; 3],
}
fn kernel(grid: &Grid) -> Option<Kernel> {
    let r = peak_radius();
    let mut corner: f64 = 0.;
    for x in [-0.5, 0.5] {
        for y in [-0.5, 0.5] {
            for z in [-0.5, 0.5] {
                corner = corner.max(norm(linear(grid.axes, [x, y, z])));
            }
        }
    }
    let mut half = [0; 3];
    for (i, h) in half.iter_mut().enumerate() {
        let row: Vector = grid.inverse[3 * i..3 * i + 3].try_into().ok()?;
        let width = ((r + corner) * norm(row)).ceil();
        if !width.is_finite() || width > 64. {
            return None;
        }
        *h = width as usize;
    }
    let k = grid.axes[2];
    let kk = dot(k, k);
    let mut weights = Vec::new();
    let [hx, hy, hz] = half.map(|n| n as isize);
    for z in -hz..=hz {
        for y in -hy..=hy {
            for x in -hx..=hx {
                let center = linear(grid.axes, [x as f64, y as f64, z as f64]);
                let d = norm(center);
                if d - corner >= r {
                    continue;
                }
                let weight = if d + corner <= r {
                    1.
                } else {
                    let mut sum = 0.;
                    for j in 0..16 {
                        for i in 0..16 {
                            let u = (i as f64 + 0.5) / 16. - 0.5;
                            let v = (j as f64 + 0.5) / 16. - 0.5;
                            let q = std::array::from_fn(|a| {
                                center[a] + u * grid.axes[0][a] + v * grid.axes[1][a]
                            });
                            let along = dot(q, k);
                            let disc = along * along - kk * (dot(q, q) - r * r);
                            if disc > 0. {
                                let root = disc.sqrt();
                                sum += (((-along + root) / kk).min(0.5)
                                    - ((-along - root) / kk).max(-0.5))
                                .max(0.);
                            }
                        }
                    }
                    sum / 256.
                };
                if weight > 0. {
                    weights.push(([x, y, z], weight));
                }
            }
        }
    }
    let total = weights.iter().map(|(_, w)| w).sum();
    Some(Kernel {
        weights,
        total,
        half,
    })
}

// Sliding maximum along each axis gives an upper bound on every candidate's weighted mean.
fn box_maximum(values: &[f64], size: [usize; 3], half: [usize; 3]) -> Vec<f64> {
    let mut current: Vec<_> = values
        .iter()
        .map(|v| if v.is_nan() { f64::NEG_INFINITY } else { *v })
        .collect();
    let mut next = vec![0.; values.len()];
    let mut stride = 1;
    for (axis, &length) in size.iter().enumerate() {
        let block = stride * length;
        for base in (0..values.len()).step_by(block) {
            for line in 0..stride {
                let at = |n: usize| base + line + n * stride;
                let mut queue = VecDeque::<usize>::new();
                let mut right = 0;
                for i in 0..length {
                    while right < length && right <= i + half[axis] {
                        while queue
                            .back()
                            .is_some_and(|&n| current[at(n)] <= current[at(right)])
                        {
                            queue.pop_back();
                        }
                        queue.push_back(right);
                        right += 1;
                    }
                    while queue.front().is_some_and(|&n| n + half[axis] < i) {
                        queue.pop_front();
                    }
                    next[at(i)] = current[at(queue[0])];
                }
            }
        }
        std::mem::swap(&mut current, &mut next);
        stride = block;
    }
    current
}

fn peak(
    grid: &Grid,
    values: &[f64],
    size: [usize; 3],
    first: [usize; 3],
    candidates: &[usize],
    seed: usize,
) -> Option<Peak> {
    if candidates.is_empty() {
        return None;
    }
    let kernel = kernel(grid)?;
    let bound = box_maximum(values, size, kernel.half);
    let mut best = f64::NEG_INFINITY;
    let mut location = None;
    for &n in std::iter::once(&seed).chain(candidates) {
        if bound[n] <= best {
            continue;
        }
        let center = position(n, size);
        let mean = kernel.weights.iter().try_fold(0., |sum, (d, w)| {
            let p = [
                center[0].checked_add_signed(d[0])?,
                center[1].checked_add_signed(d[1])?,
                center[2].checked_add_signed(d[2])?,
            ];
            if (0..3).any(|i| p[i] >= size[i]) {
                return None;
            }
            let v = values[offset(p, size)];
            v.is_finite().then_some(sum + v * w)
        });
        if let Some(mean) = mean.map(|sum| sum / kernel.total).filter(|v| *v > best) {
            best = mean;
            location = Some(
                grid.world(VoxelPoint(std::array::from_fn(|i| {
                    (first[i] + center[i]) as f64
                })))
                .0,
            );
        }
    }
    location.map(|at| Peak { value: best, at })
}

pub fn measure(source: &SourceSeries, request: &Sphere) -> Result<Option<SphereResult>> {
    let s = &source.info;
    if !s.can_reconstruct || !s.spacing_known || s.components != 1 {
        return Ok(None);
    }
    ensure!(
        request.radius.is_finite() && request.radius > 0.,
        "Invalid sphere radius"
    );
    let grid = Grid::new(s.origin, s.direction, s.spacing)?;
    let middle = grid.index(request.center).0;
    let mut first = [0; 3];
    let mut size = [0; 3];
    let mut clipped = false;
    for axis in 0..3 {
        let row: Vector = std::array::from_fn(|i| grid.inverse[axis * 3 + i]);
        let reach = norm(row) * request.radius;
        let (low, high) = (middle[axis] - reach, middle[axis] + reach);
        ensure!(
            low.is_finite() && high.is_finite(),
            "Invalid sphere geometry"
        );
        clipped |= low < -0.5 - 1e-9 || high > s.dimensions[axis] as f64 - 0.5 + 1e-9;
        first[axis] = (low - 1e-9).ceil().clamp(0., s.dimensions[axis] as f64) as usize;
        let end = ((high + 1e-9).floor() + 1.).clamp(0., s.dimensions[axis] as f64) as usize;
        size[axis] = end.saturating_sub(first[axis]);
    }
    let count = size.into_iter().try_fold(1usize, usize::checked_mul);
    let Some(n) = count.filter(|n| *n > 0 && *n <= MAX_VOXELS) else {
        return Ok(None);
    };
    let (factor, unit) = request.normalization.quantity(source);
    let suv = s.modality == "PT"
        && (unit.to_ascii_uppercase().starts_with("SUV")
            || unit.to_ascii_uppercase().starts_with("SUL"));
    let threshold = request.threshold.filter(|_| suv);
    let find_peak = suv && request.radius >= peak_radius();
    let mut stats = Stats::default();
    let mut reader = Reader::new(source);
    let mut max_at = [0.; 3];
    let mut values = if find_peak || threshold.is_some() {
        vec![f64::NAN; n]
    } else {
        Vec::new()
    };
    let mut candidates = Vec::new();
    let mut seed = 0;
    let mut seed_value = f64::NEG_INFINITY;
    let reach = request.radius.powi(2) * (1. + 1e-12) + 1e-9;
    let center_reach = (request.radius - peak_radius()).powi(2) + 1e-9;
    for i in 0..n {
        let local = position(i, size);
        let p = std::array::from_fn(|a| first[a] + local[a]);
        let world = grid.world(VoxelPoint(p.map(|v| v as f64))).0;
        let delta = sub(world, request.center.0);
        let d = dot(delta, delta);
        if d > reach {
            continue;
        }
        let raw = match reader.at(p[0], p[1], p[2])? {
            Sample::Value { value } => value,
            Sample::Padding => {
                stats.padding += 1;
                continue;
            }
            Sample::Outside | Sample::NonFinite => {
                stats.invalid += 1;
                continue;
            }
        };
        let value = raw * factor;
        if value.is_finite() && (stats.count == 0 || value > stats.max) {
            max_at = world;
        }
        stats.add(value);
        if !values.is_empty() && value.is_finite() {
            values[i] = value;
            if find_peak && d <= center_reach {
                candidates.push(i);
                if value > seed_value {
                    seed = i;
                    seed_value = value;
                }
            }
        }
    }
    if stats.count == 0 {
        return Ok(None);
    }
    let peak = if find_peak {
        peak(&grid, &values, size, first, &candidates, seed)
    } else {
        None
    };
    Ok(Some(SphereResult {
        unit: unit.to_owned(),
        count: stats.count,
        mean: stats.mean(),
        max: stats.max,
        min: stats.min,
        standard_deviation: stats.sd(),
        max_at,
        volume_ml: 4. / 3. * std::f64::consts::PI * request.radius.powi(3) / 1000.,
        diameter_mm: request.radius * 2.,
        peak,
        metabolic: threshold.and_then(|t| {
            sphere_threshold::measure(
                source,
                &grid,
                first,
                size,
                &values,
                t,
                factor,
                stats.max,
                &request.region_seeds,
            )
        }),
        clipped,
        padding_count: stats.padding,
        invalid_count: stats.invalid,
    }))
}
