//! Measurement coordinates and pixel statistics shared by the native sampling operations.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

use crate::geometry::{cross, dot, inverse, multiply, norm, sub};
use crate::model::{PixelBuffer, SourceSeries};

pub type Vector = [f64; 3];

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct PatientPoint(pub Vector);
#[derive(Clone, Copy, Debug)]
pub struct VoxelPoint(pub Vector);

pub struct Grid {
    pub origin: Vector,
    pub axes: [Vector; 3],
    pub inverse: [f64; 9],
}

impl Grid {
    pub fn new(origin: Vector, direction: [f64; 9], spacing: Vector) -> Result<Self> {
        ensure!(
            spacing.iter().all(|n| n.is_finite() && *n > 0.),
            "Invalid pixel spacing"
        );
        let matrix = std::array::from_fn(|n| direction[n] * spacing[n % 3]);
        Ok(Self {
            origin,
            axes: std::array::from_fn(|i| [matrix[i], matrix[i + 3], matrix[i + 6]]),
            inverse: inverse(matrix).ok_or_else(|| anyhow::anyhow!("Invalid image geometry"))?,
        })
    }
    pub fn index(&self, world: PatientPoint) -> VoxelPoint {
        VoxelPoint(multiply(self.inverse, sub(world.0, self.origin)))
    }
}

#[derive(Clone, Copy)]
pub(super) enum PlaneSample {
    Value(f64),
    Outside,
    Padding,
    Invalid,
}

pub(super) fn plane_sample(source: &SourceSeries, pixels: &PixelBuffer, p: Vector) -> PlaneSample {
    let dims = source.info.dimensions;
    if (0..3).any(|i| !p[i].is_finite() || p[i] < -0.500001 || p[i] > dims[i] as f64 - 0.499999) {
        return PlaneSample::Outside;
    }
    let p: Vector = std::array::from_fn(|i| p[i].clamp(0., dims[i] as f64 - 1.));
    let read = |q: [usize; 3]| {
        let value = pixels.value((q[2] * dims[1] + q[1]) * dims[0] + q[0]);
        if pixels.is_padding(source, q[2], value) {
            PlaneSample::Padding
        } else if value.is_finite() {
            PlaneSample::Value(value)
        } else {
            PlaneSample::Invalid
        }
    };
    let nearest = read(p.map(|v| v.round() as usize));
    if !matches!(nearest, PlaneSample::Value(_)) || p.iter().all(|v| (v - v.round()).abs() < 1e-7) {
        return nearest;
    }
    let low = p.map(|v| v.floor() as usize);
    let frac: Vector = std::array::from_fn(|i| p[i] - low[i] as f64);
    let (mut sum, mut total) = (0., 0.);
    for k in 0..2 {
        for j in 0..2 {
            for i in 0..2 {
                let offset = [i, j, k];
                let weight: f64 = (0..3)
                    .map(|a| {
                        if offset[a] == 0 {
                            1. - frac[a]
                        } else {
                            frac[a]
                        }
                    })
                    .product();
                if weight > 0. {
                    let q = std::array::from_fn(|a| (low[a] + offset[a]).min(dims[a] - 1));
                    if let PlaneSample::Value(value) = read(q) {
                        sum += value * weight;
                        total += weight;
                    }
                }
            }
        }
    }
    if total > 0. {
        PlaneSample::Value(sum / total)
    } else {
        PlaneSample::Invalid
    }
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Normalization {
    #[default]
    Bw,
    Lbm,
    Bsa,
}

impl Normalization {
    pub fn quantity(self, source: &SourceSeries) -> (f64, &str) {
        let s = &source.info;
        let positive = |value: Option<f64>| value.filter(|v| v.is_finite() && *v > 0.);
        let stored_suv = s.value_unit.to_ascii_uppercase().starts_with("SUV");
        if s.modality == "PT" && (stored_suv || positive(s.suv_factor).is_some()) {
            match self {
                Self::Lbm if positive(s.sul_factor).is_some() => {
                    return (s.sul_factor.unwrap(), "SUL");
                }
                Self::Bsa if positive(s.suv_bsa_factor).is_some() => {
                    return (s.suv_bsa_factor.unwrap(), "SUVbsa");
                }
                _ => {}
            }
            if !stored_suv && let Some(factor) = positive(s.suv_factor) {
                return (factor, "SUVbw");
            }
        }
        (1., &s.value_unit)
    }
}

#[derive(Default)]
pub struct Stats {
    pub count: usize,
    pub padding: usize,
    pub invalid: usize,
    pub min: f64,
    pub max: f64,
    mean: f64,
    squares: f64,
    sum: f64,
    correction: f64,
}
impl Stats {
    pub fn add(&mut self, value: f64) {
        if !value.is_finite() {
            self.invalid += 1;
            return;
        }
        if self.count == 0 {
            self.min = value;
            self.max = value;
        }
        self.min = self.min.min(value);
        self.max = self.max.max(value);
        self.count += 1;
        let delta = value - self.mean;
        self.mean += delta / self.count as f64;
        self.squares += delta * (value - self.mean);
        let next = self.sum + value;
        self.correction += if self.sum.abs() >= value.abs() {
            (self.sum - next) + value
        } else {
            (value - next) + self.sum
        };
        self.sum = next;
    }
    pub fn mean(&self) -> f64 {
        let mean = (self.sum + self.correction) / self.count as f64;
        if mean.is_finite() { mean } else { self.mean }
    }
    pub fn sd(&self) -> f64 {
        (self.squares / self.count as f64).max(0.).sqrt()
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameRef {
    pub index: usize,
    #[serde(default)]
    sop_instance_uid: String,
    source_frame_number: Option<u32>,
}
impl FrameRef {
    pub fn validate(&self, source: &SourceSeries) -> Result<()> {
        let frame = source
            .frames
            .get(self.index)
            .ok_or_else(|| anyhow::anyhow!("Source frame unavailable"))?;
        ensure!(
            frame.metadata.sop_instance_uid == self.sop_instance_uid
                && frame.metadata.source_frame_number == self.source_frame_number,
            "Source frame identity changed"
        );
        Ok(())
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    Rectangle,
    Ellipse,
    Polygon,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Region {
    #[serde(flatten)]
    pub plane: RegionPlane,
    pub shape: Shape,
    pub points: Vec<PatientPoint>,
    #[serde(default)]
    pub normalization: Normalization,
    #[serde(default)]
    pub pixel_units: bool,
    pub measurement_scale: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegionPlane {
    Frame(FrameRef),
    VoxelPlane { axis: usize, index: usize },
    Oblique { u: Vector, v: Vector },
}

impl RegionPlane {
    pub fn single_frame(&self, source: &SourceSeries) -> Result<Option<usize>> {
        match self {
            Self::Oblique { .. } => {
                ensure!(source.info.can_reconstruct, "Volume geometry unavailable");
                Ok(None)
            }
            Self::Frame(frame) => {
                frame.validate(source)?;
                Ok(Some(frame.index))
            }
            Self::VoxelPlane { axis, index } => {
                ensure!(
                    source.info.can_reconstruct
                        && *axis < 3
                        && *index < source.info.dimensions[*axis],
                    "Invalid voxel plane"
                );
                Ok((*axis == 2).then_some(*index))
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionResult {
    pub(crate) mean: f64,
    pub(crate) min: f64,
    pub(crate) max: f64,
    pub(crate) standard_deviation: f64,
    pub(crate) count: usize,
    pub(crate) invalid_count: usize,
    pub(crate) padding_count: usize,
    pub(crate) outside_count: usize,
    pub(crate) clipped: bool,
    pub(crate) area: f64,
    pub(crate) area_unit: &'static str,
    pub(crate) unit: String,
    pub(crate) sampling_step: [f64; 2],
    pub(crate) spatial_unit: &'static str,
    pub(crate) sampling: &'static str,
    pub(crate) downsampled: bool,
}

pub fn region(
    source: &SourceSeries,
    pixels: &PixelBuffer,
    request: &Region,
) -> Result<Option<RegionResult>> {
    use crate::measure::{polygon_area, polygon_contains, validate_polygon};
    let single = request.plane.single_frame(source)?;
    if let RegionPlane::Oblique { u, v } = request.plane {
        return reslice::region(source, pixels, request, u, v);
    }
    let [width, height, depth] = source.info.dimensions;
    let length = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(if single.is_some() { 1 } else { depth }));
    ensure!(
        source.info.components == 1 && length == Some(pixels.len()),
        "Invalid region pixel buffer"
    );
    let (grid, axes, fixed, index, calibrated) = match &request.plane {
        RegionPlane::Oblique { .. } => unreachable!(),
        RegionPlane::Frame(frame) => {
            let meta = &source.frames[frame.index].metadata;
            (
                Grid::new(meta.origin, meta.direction, meta.spacing)?,
                [0, 1],
                2,
                0,
                meta.spacing_known,
            )
        }
        RegionPlane::VoxelPlane { axis, index } => {
            let info = &source.info;
            let axes = [[1, 2], [0, 2], [0, 1]][*axis];
            (
                Grid::new(info.origin, info.direction, info.spacing)?,
                axes,
                *axis,
                *index,
                info.spacing_known,
            )
        }
    };
    let [u_axis, v_axis] = axes;
    let basis = [grid.axes[u_axis], grid.axes[v_axis]];
    let mut poly = Vec::with_capacity(request.points.len());
    for p in &request.points {
        let VoxelPoint(ijk) = grid.index(*p);
        let (x, y) = (ijk[u_axis], ijk[v_axis]);
        ensure!(
            x.is_finite() && y.is_finite() && (ijk[fixed] - index as f64).abs() <= 1e-4,
            "Point lies outside the sampling plane"
        );
        poly.push([x, y]);
    }
    if request.shape != Shape::Polygon && poly.len() == 2 {
        let [x, y] = poly[0];
        let [u, v] = poly[1];
        poly = vec![[x, y], [u, y], [u, v], [x, v]];
    }
    if poly.len() < 3 || (request.shape != Shape::Polygon && poly.len() != 4) {
        return Ok(None);
    }
    if validate_polygon(&poly).is_err() {
        return Ok(None);
    }
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for p in &poly {
        for i in 0..2 {
            lo[i] = lo[i].min(p[i]);
            hi[i] = hi[i].max(p[i]);
        }
    }
    let mut area = polygon_area(&poly);
    let center = [
        (poly[0][0] + poly[2][0]) * 0.5,
        (poly[0][1] + poly[2][1]) * 0.5,
    ];
    let u = [
        (poly[1][0] - poly[0][0]) * 0.5,
        (poly[1][1] - poly[0][1]) * 0.5,
    ];
    let v = [
        (poly[poly.len() - 1][0] - poly[0][0]) * 0.5,
        (poly[poly.len() - 1][1] - poly[0][1]) * 0.5,
    ];
    let det = u[0] * v[1] - u[1] * v[0];
    if request.shape != Shape::Polygon {
        let edge = |a: [f64; 2]| std::array::from_fn(|i| a[0] * basis[0][i] + a[1] * basis[1][i]);
        let (a, b) = (edge(u), edge(v));
        let tol = 1e-5 * norm(a).max(norm(b)).max(1.);
        if det == 0.
            || dot(a, b).abs() > tol * norm(a)
            || (0..2).any(|i| {
                ((poly[2][i] - poly[0][i] - 2. * (u[i] + v[i])) * norm(basis[i])).abs() > 2. * tol
            })
        {
            return Ok(None);
        }
    }
    if request.shape == Shape::Ellipse {
        area = std::f64::consts::PI * det.abs();
        for i in 0..2 {
            let r = u[i].hypot(v[i]);
            lo[i] = center[i] - r;
            hi[i] = center[i] + r;
        }
    }
    if !area.is_finite() || area <= 0. {
        return Ok(None);
    }
    let dims = [
        source.info.dimensions[u_axis],
        source.info.dimensions[v_axis],
    ];
    let clipped = (0..2).any(|i| lo[i] < -0.5 - 1e-7 || hi[i] > dims[i] as f64 - 0.5 + 1e-7);
    let first: [usize; 2] =
        std::array::from_fn(|i| (lo[i] - 1e-7).ceil().clamp(0., dims[i] as f64) as usize);
    let end: [usize; 2] =
        std::array::from_fn(|i| ((hi[i] + 1e-7).floor() + 1.).clamp(0., dims[i] as f64) as usize);
    let work = end[0]
        .saturating_sub(first[0])
        .saturating_mul(end[1].saturating_sub(first[1]));
    ensure!(
        work <= 16_000_000
            && (request.shape != Shape::Polygon || work.saturating_mul(poly.len()) <= 128_000_000),
        "Source region exceeds sampling limit"
    );
    let (factor, unit) = request.normalization.quantity(source);
    let mut stats = Stats::default();
    for y in first[1]..end[1] {
        for x in first[0]..end[0] {
            let p = [x as f64, y as f64];
            let inside = if request.shape == Shape::Ellipse {
                let dx = p[0] - center[0];
                let dy = p[1] - center[1];
                ((dx * v[1] - dy * v[0]) / det).powi(2) + ((u[0] * dy - u[1] * dx) / det).powi(2)
                    <= 1. + 1e-12
            } else {
                polygon_contains(p, &poly)
            };
            if inside {
                let mut ijk = [0; 3];
                ijk[fixed] = index;
                ijk[u_axis] = x;
                ijk[v_axis] = y;
                let z = if single.is_some() { 0 } else { ijk[2] };
                let value = pixels.value((z * height + ijk[1]) * width + ijk[0]);
                if pixels.is_padding(source, single.unwrap_or(ijk[2]), value) {
                    stats.padding += 1;
                } else {
                    stats.add(value * factor);
                }
            }
        }
    }
    if stats.count == 0 {
        return Ok(None);
    }
    let mm = !request.pixel_units && (calibrated || request.measurement_scale.is_some());
    let scale = request.measurement_scale.unwrap_or(1.);
    ensure!(
        scale.is_finite() && scale > 0.,
        "Invalid measurement calibration"
    );
    Ok(Some(RegionResult {
        mean: stats.mean(),
        min: stats.min,
        max: stats.max,
        standard_deviation: stats.sd(),
        count: stats.count,
        invalid_count: stats.invalid,
        padding_count: stats.padding,
        outside_count: 0,
        clipped,
        area: if mm {
            area * norm(cross(basis[0], basis[1])) * scale.powi(2)
        } else {
            area
        },
        area_unit: if mm { "mm²" } else { "px²" },
        unit: unit.into(),
        sampling_step: if mm {
            [norm(basis[0]) * scale, norm(basis[1]) * scale]
        } else {
            [1., 1.]
        },
        spatial_unit: if mm { "mm" } else { "px" },
        sampling: "source-voxels",
        downsampled: false,
    }))
}

mod reslice;
