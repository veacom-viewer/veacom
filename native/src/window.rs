//! Window the selected frame or reconstructed plane. The renderer receives two numbers.
use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::geometry::multiply;
use crate::model::{PixelBuffer, SourceSeries};
use crate::sampling::{FrameRef, Grid, PatientPoint, PlaneSample, Vector, plane_sample};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Window {
    pub frame: Option<FrameRef>,
    pub plane: Option<PlaneGrid>,
    pub automatic: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaneGrid {
    origin: PatientPoint,
    right: Vector,
    down: Vector,
    columns: usize,
    rows: usize,
}

pub fn calculate(source: &SourceSeries, pixels: &PixelBuffer, request: &Window) -> Result<Value> {
    let [nx, ny, _] = source.info.dimensions;
    ensure!(
        source.info.components == 1 && nx > 0 && ny > 0,
        "Windowing requires a scalar image"
    );
    let plane = if let Some(p) = &request.plane {
        ensure!(
            source.info.can_reconstruct && request.frame.is_none(),
            "Invalid reconstructed plane"
        );
        let count = p.columns.saturating_mul(p.rows);
        ensure!(
            count > 0
                && count <= 16_000_000
                && [p.origin.0, p.right, p.down]
                    .iter()
                    .flatten()
                    .all(|n| n.is_finite()),
            "Invalid plane grid"
        );
        let grid = Grid::new(
            source.info.origin,
            source.info.direction,
            source.info.spacing,
        )?;
        Some((
            p.columns,
            count,
            grid.index(p.origin).0,
            multiply(grid.inverse, p.right),
            multiply(grid.inverse, p.down),
        ))
    } else {
        None
    };
    let length = plane.map_or(pixels.len(), |p| p.1);
    let sample = |i: usize| {
        if let Some((width, _, start, right, down)) = plane {
            let p = std::array::from_fn(|a| {
                start[a] + (i % width) as f64 * right[a] + (i / width) as f64 * down[a]
            });
            return match plane_sample(source, pixels, p) {
                PlaneSample::Value(v) => Some(v),
                _ => None,
            };
        }
        let value = pixels.value(i);
        let frame = request.frame.as_ref().map_or(i / (nx * ny), |f| f.index);
        (value.is_finite() && !pixels.is_padding(source, frame, value)).then_some(value)
    };
    let count = if request.automatic {
        length.min(65_536)
    } else {
        length
    };
    let mut samples = Vec::with_capacity(if request.automatic { count } else { 0 });
    let (mut low, mut high) = (f64::INFINITY, f64::NEG_INFINITY);
    for n in 0..count {
        let i = if count == length || count <= 1 {
            n
        } else {
            (n as u64 * (length - 1) as u64 / (count - 1) as u64) as usize
        };
        if let Some(value) = sample(i) {
            low = low.min(value);
            high = high.max(value);
            if request.automatic {
                samples.push(value);
            }
        }
    }
    if low > high {
        return Ok(Value::Null);
    }
    if request.automatic {
        samples.sort_unstable_by(f64::total_cmp);
        let index = request.frame.as_ref().map(|f| f.index);
        let corner_fill = index.is_some_and(|i| source.frames[i].metadata.padding_range.is_none())
            && source.info.padding_range.is_none()
            && source.info.modality == "CT"
            && source.info.value_unit == "HU"
            && low < -1024.
            && [0, nx - 1, (ny - 1) * nx, nx * ny - 1]
                .into_iter()
                .all(|i| sample(i) == Some(low));
        let start = if corner_fill {
            samples.partition_point(|v| *v <= low)
        } else {
            0
        };
        let values = if samples.len() - start >= 16 {
            &samples[start..]
        } else {
            &samples
        };
        let percentile = |q: f64| {
            let p = (values.len() - 1) as f64 * q;
            values[p.floor() as usize] * (1. - p.fract()) + values[p.ceil() as usize] * p.fract()
        };
        low = percentile(0.01);
        high = percentile(0.99);
    }
    Ok(json!({"windowCenter": low * 0.5 + high * 0.5, "windowWidth": (high - low).max(1.)}))
}
