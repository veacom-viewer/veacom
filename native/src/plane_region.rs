//! Measurements on a reconstructed plane. Emission regions include actual voxel centres
//! whose boxes meet the plane. Other regions sample the interpolated plane.
use crate::{
    geometry::{cross, dot, multiply, norm, sub},
    measure::{polygon_area, polygon_contains, validate_polygon},
    model::SourceSeries,
    probe::{Reader, Sample},
    sampling::{Grid, Normalization, PatientPoint, RegionResult, Shape, Stats, Vector, VoxelPoint},
};
use anyhow::{Result, ensure};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaneRegion {
    origin: PatientPoint,
    u: Vector,
    v: Vector,
    polygon: Vec<[f64; 2]>,
    shape: Shape,
    #[serde(default)]
    normalization: Normalization,
    pixel_units: bool,
    measurement_scale: Option<f64>,
    max_samples: usize,
}
impl PlaneRegion {
    fn world(&self, p: [f64; 2]) -> PatientPoint {
        PatientPoint(std::array::from_fn(|a| {
            self.origin.0[a] + p[0] * self.u[a] + p[1] * self.v[a]
        }))
    }
    fn contains(&self, p: [f64; 2], lo: [f64; 2], hi: [f64; 2]) -> bool {
        match self.shape {
            Shape::Polygon => polygon_contains(p, &self.polygon),
            Shape::Ellipse => {
                (0..2)
                    .map(|a| ((2. * p[a] - lo[a] - hi[a]) / (hi[a] - lo[a])).powi(2))
                    .sum::<f64>()
                    <= 1. + 1e-12
            }
            Shape::Rectangle => (0..2).all(|a| p[a] >= lo[a] - 1e-7 && p[a] <= hi[a] + 1e-7),
        }
    }
}
pub fn measure(source: &SourceSeries, region: &PlaneRegion) -> Result<Option<RegionResult>> {
    let s = &source.info;
    ensure!(
        s.can_reconstruct && s.components == 1 && !s.dimensions.contains(&0),
        "Regular scalar volume required"
    );
    ensure!(
        (norm(region.u) - 1.).abs() < 1e-5
            && (norm(region.v) - 1.).abs() < 1e-5
            && dot(region.u, region.v).abs() < 1e-5,
        "Invalid measurement plane"
    );
    ensure!(
        (1..=200_000).contains(&region.max_samples) && region.polygon.len() <= 10_000,
        "Invalid sampling limits"
    );
    if validate_polygon(&region.polygon).is_err() {
        return Ok(None);
    }
    let lo: [f64; 2] = std::array::from_fn(|a| {
        region
            .polygon
            .iter()
            .map(|p| p[a])
            .fold(f64::INFINITY, f64::min)
    });
    let hi: [f64; 2] = std::array::from_fn(|a| {
        region
            .polygon
            .iter()
            .map(|p| p[a])
            .fold(f64::NEG_INFINITY, f64::max)
    });
    let extent: [f64; 2] = std::array::from_fn(|a| hi[a] - lo[a]);
    let area = if region.shape == Shape::Ellipse {
        std::f64::consts::PI * extent[0] * extent[1] / 4.
    } else {
        polygon_area(&region.polygon)
    };
    if !area.is_finite() || area <= 1e-10 {
        return Ok(None);
    }
    if region.shape != Shape::Polygon {
        ensure!(
            region.polygon.len() == 4
                && (polygon_area(&region.polygon) - extent[0] * extent[1]).abs() <= area * 1e-5,
            "Invalid rectangular outline"
        );
    }
    let grid = Grid::new(s.origin, s.direction, s.spacing)?;
    let normal = cross(region.u, region.v);
    let vertices: Vec<_> = region
        .polygon
        .iter()
        .map(|&p| grid.index(region.world(p)).0)
        .collect();
    let low: Vector =
        std::array::from_fn(|a| vertices.iter().map(|p| p[a]).fold(f64::INFINITY, f64::min));
    let high: Vector = std::array::from_fn(|a| {
        vertices
            .iter()
            .map(|p| p[a])
            .fold(f64::NEG_INFINITY, f64::max)
    });
    let start: [usize; 3] =
        std::array::from_fn(|a| ((low[a].floor() - 1.).max(0.) as usize).min(s.dimensions[a]));
    let end: [usize; 3] =
        std::array::from_fn(|a| ((high[a].ceil() + 2.).max(0.) as usize).min(s.dimensions[a]));
    let scanned = (0..3).fold(1usize, |n, a| {
        n.saturating_mul(end[a].saturating_sub(start[a]))
    });
    let exact = matches!(s.modality.as_str(), "PT" | "NM") && scanned <= 4_000_000;
    let iu = multiply(grid.inverse, region.u);
    let iv = multiply(grid.inverse, region.v);
    let (factor, unit) = region.normalization.quantity(source);
    let mut stats = Stats::default();
    let mut outside = 0;
    let mut record = |sample| match sample {
        Sample::Outside => outside += 1,
        Sample::Padding => stats.padding += 1,
        Sample::NonFinite => stats.invalid += 1,
        Sample::Value { value } => stats.add(value * factor),
    };
    let mut reader = Reader::new(source);
    let mut step;
    let mut downsampled = false;
    if exact {
        ensure!(
            region.shape != Shape::Polygon
                || scanned.saturating_mul(region.polygon.len()) <= 128_000_000,
            "Polygon exceeds sampling budget"
        );
        step = [norm(grid.axes[0]), norm(grid.axes[1])];
        let reach = grid
            .axes
            .iter()
            .map(|&axis| dot(axis, normal).abs())
            .sum::<f64>()
            * 0.5
            * (1. + 1e-9)
            + 1e-9;
        for z in start[2]..end[2] {
            for y in start[1]..end[1] {
                for x in start[0]..end[0] {
                    let delta = sub(
                        grid.world(VoxelPoint([x as f64, y as f64, z as f64])).0,
                        region.origin.0,
                    );
                    if dot(delta, normal).abs() <= reach
                        && region.contains([dot(delta, region.u), dot(delta, region.v)], lo, hi)
                    {
                        record(reader.at(x, y, z)?);
                    }
                }
            }
        }
    } else {
        let mut cols = (extent[0] * norm(iu)).ceil().max(1.);
        let mut rows = (extent[1] * norm(iv)).ceil().max(1.);
        let count = cols * rows;
        ensure!(count.is_finite(), "Invalid sampling extent");
        let limit = region.max_samples as f64;
        if count > limit {
            downsampled = true;
            let ratio = (count / limit).sqrt();
            cols = (cols / ratio).floor().clamp(1., limit);
            rows = (rows / ratio).floor().clamp(1., (limit / cols).floor());
        }
        ensure!(
            region.shape != Shape::Polygon
                || (cols * rows) as usize * region.polygon.len() <= 128_000_000,
            "Polygon exceeds sampling budget"
        );
        step = [extent[0] / cols, extent[1] / rows];
        for row in 0..rows as usize {
            for col in 0..cols as usize {
                let uv = [
                    lo[0] + (col as f64 + 0.5) * step[0],
                    lo[1] + (row as f64 + 0.5) * step[1],
                ];
                if region.contains(uv, lo, hi) {
                    record(reader.sample(grid.index(region.world(uv)).0, true)?);
                }
            }
        }
    }
    if stats.count == 0 {
        return Ok(None);
    }
    let clipped = if exact {
        (0..3).any(|a| low[a] < -0.5000001 || high[a] > s.dimensions[a] as f64 - 0.4999999)
    } else {
        outside != 0
    };
    let mm = !region.pixel_units && (s.spacing_known || region.measurement_scale.is_some());
    let scale = region.measurement_scale.unwrap_or(1.);
    ensure!(scale.is_finite() && scale > 0., "Invalid calibration");
    step = if mm {
        step.map(|v| v * scale)
    } else if exact {
        [1., 1.]
    } else {
        [step[0] * norm(iu), step[1] * norm(iv)]
    };
    Ok(Some(RegionResult {
        mean: stats.mean(),
        min: stats.min,
        max: stats.max,
        standard_deviation: stats.sd(),
        count: stats.count,
        invalid_count: stats.invalid,
        padding_count: stats.padding,
        outside_count: outside,
        clipped,
        area: area
            * if mm {
                scale * scale
            } else {
                norm(cross(iu, iv))
            },
        area_unit: if mm { "mm²" } else { "px²" },
        unit: unit.into(),
        sampling_step: step,
        spatial_unit: if mm { "mm" } else { "px" },
        sampling: if exact {
            "source-voxels"
        } else {
            "derived-interpolated"
        },
        downsampled,
    }))
}
