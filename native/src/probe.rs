//! Exact frame-local samples. Reconstruction reads only the source planes it visits.
use crate::{
    frames,
    geometry::{dot, norm},
    model::{PixelBuffer, SourceSeries},
    sampling::{FrameRef, Grid, PatientPoint, Vector, VoxelPoint},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Sample {
    Outside,
    Padding,
    NonFinite,
    Value { value: f64 },
}

pub struct Reader<'a> {
    source: &'a SourceSeries,
    last: Option<(usize, Arc<PixelBuffer>)>,
}
impl<'a> Reader<'a> {
    pub fn new(source: &'a SourceSeries) -> Self {
        Self { source, last: None }
    }
    pub fn at(&mut self, x: usize, y: usize, z: usize) -> Result<Sample> {
        if self.last.as_ref().is_none_or(|(frame, _)| *frame != z) {
            self.last = Some((z, frames::read(self.source, z)?));
        }
        let pixels = &self.last.as_ref().unwrap().1;
        let [nx, ny, _] = self.source.info.dimensions;
        ensure!(
            nx.checked_mul(ny) == Some(pixels.len()),
            "Incomplete scalar source frame"
        );
        let value = pixels.value(y * nx + x);
        Ok(if pixels.is_padding(self.source, z, value) {
            Sample::Padding
        } else if value.is_finite() {
            Sample::Value { value }
        } else {
            Sample::NonFinite
        })
    }
    pub fn sample(&mut self, p: Vector, interpolate: bool) -> Result<Sample> {
        let dims = self.source.info.dimensions;
        if (0..3).any(|i| !p[i].is_finite() || p[i] < -0.500001 || p[i] > dims[i] as f64 - 0.499999)
        {
            return Ok(Sample::Outside);
        }
        let clamp = |n: f64, a: usize| n.clamp(0., (dims[a] - 1) as f64) as usize;
        let near: [usize; 3] = std::array::from_fn(|a| clamp(p[a].round(), a));
        let nearest = self.at(near[0], near[1], near[2])?;
        if !interpolate || !matches!(nearest, Sample::Value { .. }) {
            return Ok(nearest);
        }
        let base = p.map(f64::floor);
        let fraction: Vector = std::array::from_fn(|a| p[a] - base[a]);
        let mut value = 0.;
        let mut total = 0.;
        for k in 0..8 {
            let mut weight = 1.;
            let index: [usize; 3] = std::array::from_fn(|a| {
                let offset = (k >> a) & 1;
                weight *= if offset == 0 {
                    1. - fraction[a]
                } else {
                    fraction[a]
                };
                clamp(base[a] + offset as f64, a)
            });
            if weight > 0.
                && let Sample::Value { value: voxel } = self.at(index[0], index[1], index[2])?
            {
                value += voxel * weight;
                total += weight;
            }
        }
        let result = value / total;
        Ok(if result.is_finite() {
            Sample::Value { value: result }
        } else {
            Sample::NonFinite
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Probe {
    point: PatientPoint,
    frame: Option<FrameRef>,
}
pub fn probe(source: &SourceSeries, request: &Probe) -> Result<Sample> {
    let s = &source.info;
    ensure!(
        s.components == 1 && !s.dimensions.contains(&0),
        "Scalar source required"
    );
    if let Some(frame) = &request.frame {
        frame.validate(source)?;
        let m = &source.frames[frame.index].metadata;
        let p = Grid::new(m.origin, m.direction, m.spacing)?
            .index(request.point)
            .0;
        if p[2].abs() > 1e-4 {
            return Ok(Sample::Outside);
        }
        return Reader::new(source).sample([p[0], p[1], frame.index as f64], false);
    }
    ensure!(s.can_reconstruct, "Regular volume required");
    Reader::new(source).sample(
        Grid::new(s.origin, s.direction, s.spacing)?
            .index(request.point)
            .0,
        false,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ray {
    point: PatientPoint,
    normal: Vector,
    right: Vector,
    down: Vector,
    reach: f64,
    pick: bool,
}
#[derive(Serialize)]
pub struct Hit {
    value: f64,
    point: Vector,
}
pub fn ray(source: &SourceSeries, ray: &Ray) -> Result<Option<Hit>> {
    let s = &source.info;
    ensure!(
        s.components == 1 && s.can_reconstruct && !s.dimensions.contains(&0),
        "Regular scalar volume required"
    );
    for axis in [ray.normal, ray.right, ray.down] {
        ensure!((norm(axis) - 1.).abs() < 1e-4, "Invalid projection axes");
    }
    ensure!(
        dot(ray.normal, ray.right).abs() < 1e-4
            && dot(ray.normal, ray.down).abs() < 1e-4
            && dot(ray.right, ray.down).abs() < 1e-4,
        "Invalid projection axes"
    );
    let step = (s.spacing.into_iter().fold(f64::INFINITY, f64::min) / 2.).max(0.25);
    ensure!(
        ray.reach.is_finite() && ray.reach > 0. && 2. * ray.reach / step <= 131072.,
        "Invalid ray length"
    );
    let grid = Grid::new(s.origin, s.direction, s.spacing)?;
    let mut reader = Reader::new(source);
    let mut best = None::<Hit>;
    let count = (2. * ray.reach / step).floor() as usize;
    for ring in 0..if ray.pick { 3 } else { 1 } {
        for angle in 0..if ring == 0 { 1 } else { 8 } {
            let theta = angle as f64 * std::f64::consts::FRAC_PI_4;
            let start: Vector = std::array::from_fn(|a| {
                ray.point.0[a]
                    + 2. * ring as f64 * (theta.cos() * ray.right[a] + theta.sin() * ray.down[a])
            });
            for i in 0..=count {
                let depth = i as f64 * step - ray.reach;
                let world = PatientPoint(std::array::from_fn(|a| start[a] + depth * ray.normal[a]));
                let index = grid.index(world);
                if let Sample::Value { value } = reader.sample(index.0, false)?
                    && best.as_ref().is_none_or(|hit| value > hit.value)
                {
                    let point = grid
                        .world(VoxelPoint(std::array::from_fn(|a| {
                            index.0[a].round().clamp(0., (s.dimensions[a] - 1) as f64)
                        })))
                        .0;
                    best = Some(Hit { value, point });
                }
            }
        }
    }
    Ok(best)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowRequest {
    pub frame: Option<FrameRef>,
    pub full_range: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    window_center: f64,
    window_width: f64,
}
pub fn window(source: &SourceSeries, request: &WindowRequest) -> Result<Option<Window>> {
    let [nx, ny, nz] = source.info.dimensions;
    ensure!(
        source.info.components == 1 && ![nx, ny, nz].contains(&0),
        "Invalid scalar volume"
    );
    let frame_len = nx
        .checked_mul(ny)
        .ok_or_else(|| anyhow::anyhow!("Invalid frame size"))?;
    let first = request.frame.as_ref().map_or(0, |f| f.index);
    let frames = if let Some(frame) = &request.frame {
        frame.validate(source)?;
        1
    } else {
        nz
    };
    let size = frame_len
        .checked_mul(frames)
        .ok_or_else(|| anyhow::anyhow!("Invalid volume size"))?;
    let mut reader = Reader::new(source);
    let mut low = f64::INFINITY;
    let mut high = f64::NEG_INFINITY;
    let count = if request.full_range {
        size
    } else {
        size.min(65_536)
    };
    let mut sorted = Vec::new();
    for i in 0..count {
        let index = if count == size {
            i
        } else {
            ((i as u128 * (size - 1) as u128) / (count - 1) as u128) as usize
        };
        if let Sample::Value { value } =
            reader.at(index % nx, (index / nx) % ny, first + index / frame_len)?
        {
            low = low.min(value);
            high = high.max(value);
            if !request.full_range {
                sorted.push(value);
            }
        }
    }
    if low > high {
        return Ok(None);
    }
    if !request.full_range {
        sorted.sort_unstable_by(f64::total_cmp);
        let percentile = |f: f64| {
            let at = (sorted.len() - 1) as f64 * f;
            sorted[at.floor() as usize] * (1. - at.fract())
                + sorted[at.ceil() as usize] * at.fract()
        };
        low = percentile(0.01);
        high = percentile(0.99);
    }
    let width = (high - low).max(1.);
    ensure!(
        width.is_finite(),
        "Window exceeds the supported value range"
    );
    Ok(Some(Window {
        window_center: low / 2. + high / 2.,
        window_width: width,
    }))
}
