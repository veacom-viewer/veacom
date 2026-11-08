use crate::geometry::{cross, dot, norm, sub};
use crate::model::SourceSeries;
use crate::probe::{Reader, Sample as Voxel};
use crate::sampling::{FrameRef, Grid, PatientPoint, Stats, Vector};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointSet {
    outline: Vec<PatientPoint>,
    pub frame: Option<FrameRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    mean: f64,
    std: f64,
    min: f64,
    max: f64,
    sampling: &'static str,
    voxels: usize,
    coverage: f64,
    samples: usize,
    invalid_samples: usize,
    outside_samples: usize,
    padding_samples: usize,
}

// The same half-open polygon fill and half-millimetre minimum grid as the assessment's regionPoints.
fn visit_outline(
    points: &[PatientPoint],
    visit: &mut impl FnMut(PatientPoint) -> Result<()>,
) -> Result<()> {
    if points.len() < 3 {
        return Ok(());
    }
    let origin = points[0].0;
    let unit = |v: Vector| v.map(|n| n / norm(v));
    let Some(u) = points
        .iter()
        .map(|p| sub(p.0, origin))
        .find(|v| norm(*v) > 1e-8)
        .map(unit)
    else {
        return Ok(());
    };
    let Some(n) = points
        .iter()
        .map(|p| cross(u, sub(p.0, origin)))
        .find(|v| norm(*v) > 1e-8)
        .map(unit)
    else {
        return Ok(());
    };
    let v = unit(cross(n, u));
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    let mut poly = Vec::with_capacity(points.len());
    for p in points {
        let d = sub(p.0, origin);
        if dot(d, n).abs() > 0.1 {
            return Ok(());
        }
        let xy = [dot(d, u), dot(d, v)];
        for i in 0..2 {
            lo[i] = lo[i].min(xy[i]);
            hi[i] = hi[i].max(xy[i]);
        }
        poly.push(xy);
    }
    let [w, h] = [hi[0] - lo[0], hi[1] - lo[1]];
    let step = 0.5f64.max(((w + 1e-9) * (h + 1e-9) / 40000.).sqrt());
    let extent = |d: f64| ((d / step).ceil() + 2.) as usize;
    ensure!(
        extent(w)
            .saturating_mul(extent(h))
            .saturating_mul(points.len())
            <= 128_000_000,
        "Assessment region exceeds sampling limit"
    );
    let mut any = false;
    for j in 0..extent(h) {
        let y = lo[1] + j as f64 * step;
        if y > hi[1] + step {
            break;
        }
        for i in 0..extent(w) {
            let x = lo[0] + i as f64 * step;
            if x > hi[0] + step {
                break;
            }
            let mut inside = false;
            for k in 0..poly.len() {
                let [ax, ay] = poly[k];
                let [bx, by] = poly[(k + poly.len() - 1) % poly.len()];
                if (ay > y) != (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax {
                    inside = !inside;
                }
            }
            if inside {
                any = true;
                visit(PatientPoint(std::array::from_fn(|k| {
                    origin[k] + u[k] * x + v[k] * y
                })))?;
            }
        }
    }
    if !any {
        for p in points {
            visit(*p)?;
        }
    }
    Ok(())
}

pub fn measure(source: &SourceSeries, sets: &[PointSet]) -> Result<Option<Sample>> {
    ensure!(
        sets.len() <= 128 && sets.iter().all(|s| s.outline.len() <= 10000),
        "Too many assessment regions or points"
    );
    let [nx, ny, nz] = source.info.dimensions;
    let mut reader = Reader::new(source);
    let mut stats = Stats::default();
    let mut outside = 0;
    let mut total = 0;
    let mut unique = HashSet::new();
    for set in sets {
        let frame = set.frame.as_ref().map(|f| f.index);
        if let Some(f) = &set.frame {
            f.validate(source)?;
        }
        let (grid, depth) = if let Some(i) = frame {
            let m = &source.frames[i].metadata;
            (Grid::new(m.origin, m.direction, m.spacing)?, 1)
        } else {
            let s = &source.info;
            (Grid::new(s.origin, s.direction, s.spacing)?, nz)
        };
        visit_outline(&set.outline, &mut |p| {
            total += 1;
            let ijk = grid.index(p).0.map(f64::round_ties_even);
            if ijk
                .iter()
                .zip([nx, ny, depth])
                .any(|(&n, size)| !n.is_finite() || n < 0. || n >= size as f64)
            {
                outside += 1;
                return Ok(());
            }
            let [x, y, k] = ijk.map(|n| n as usize);
            let z = frame.unwrap_or(k);
            match reader.at(x, y, z)? {
                Voxel::Padding => stats.padding += 1,
                Voxel::NonFinite | Voxel::Outside => stats.invalid += 1,
                Voxel::Value { value } => {
                    unique.insert((z * ny + y) * nx + x);
                    stats.add(value);
                }
            }
            Ok(())
        })?;
    }
    if stats.count == 0 || (stats.count as f64) < 0.8 * total as f64 {
        return Ok(None);
    }
    Ok(Some(Sample {
        mean: stats.mean(),
        std: stats.sd(),
        min: stats.min,
        max: stats.max,
        sampling: "derived-nearest",
        voxels: unique.len(),
        coverage: stats.count as f64 / total as f64,
        samples: total,
        invalid_samples: stats.invalid,
        outside_samples: outside,
        padding_samples: stats.padding,
    }))
}
