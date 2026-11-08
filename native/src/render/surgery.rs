//! Exact patient-space picks and burr strokes against a particular mask revision.
use super::layers::Layers;
use crate::{
    geometry::{dot, multiply, norm, sub},
    model::SourceSeries,
    probe::{Reader, Sample},
    sampling::{Grid, PatientPoint, Vector, VoxelPoint},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Crop {
    pub min: [usize; 3],
    pub max: [usize; 3],
}
impl Crop {
    pub fn validate(&self, s: &SourceSeries) -> Result<()> {
        ensure!(
            (0..3).all(|a| self.min[a] <= self.max[a] && self.max[a] < s.info.dimensions[a]),
            "Invalid surgical crop"
        );
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Touch {
    pub target: String,
    pub layer_revision: u32,
    origin: PatientPoint,
    direction: Vector,
    threshold: f64,
    crop: Crop,
    radius: Option<f64>,
    stroke_depth: Option<f64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Touched {
    point: Vector,
    depth: Option<f64>,
    stroke_depth: f64,
    changed: Vec<u32>,
}

struct Surface<'a> {
    reader: Reader<'a>,
    layers: &'a Layers,
    dimensions: [usize; 3],
    origin: Vector,
    along: Vector,
    entry: f64,
    exit: f64,
    threshold: f64,
}
impl Surface<'_> {
    fn hit(&mut self, original: bool, changed: &[u32]) -> Result<Option<f64>> {
        let step = 0.5 / self.along.into_iter().map(f64::abs).fold(0., f64::max);
        let count = ((self.exit - self.entry) / step).ceil() as usize;
        ensure!(count <= 65536, "Pick ray exceeds sampling budget");
        let mut visible = |distance: f64| -> Result<bool> {
            let p: Vector = std::array::from_fn(|a| self.origin[a] + distance * self.along[a]);
            let n: [usize; 3] = std::array::from_fn(|a| {
                p[a].round().clamp(0., (self.dimensions[a] - 1) as f64) as usize
            });
            let flat = (n[2] * self.dimensions[1] + n[1]) * self.dimensions[0] + n[0];
            let mask = self.layers.mask_at(flat);
            if mask == 2
                || (!original && (mask == 1 || changed.binary_search(&(flat as u32)).is_ok()))
            {
                return Ok(false);
            }
            Ok(matches!(self.reader.sample(p,true)?,Sample::Value{value} if value>=self.threshold))
        };
        let mut lo = self.entry;
        for i in 0..=count {
            let mut hi = (self.entry + i as f64 * step).min(self.exit);
            if visible(hi)? {
                for _ in 0..10 {
                    let middle = (hi + lo) * 0.5;
                    if visible(middle)? {
                        hi = middle;
                    } else {
                        lo = middle;
                    }
                }
                return Ok(Some(hi));
            }
            lo = hi;
        }
        Ok(None)
    }
}
pub fn touch(source: &SourceSeries, layers: &Layers, request: &Touch) -> Result<Option<Touched>> {
    let s = &source.info;
    request.crop.validate(source)?;
    ensure!(
        s.can_reconstruct && s.components == 1 && request.threshold.is_finite(),
        "Invalid surgical volume"
    );
    let grid = Grid::new(s.origin, s.direction, s.spacing)?;
    let len = norm(request.direction);
    ensure!(
        len.is_finite() && len > 1e-12 && request.origin.0.iter().all(|v| v.is_finite()),
        "Invalid pick ray"
    );
    let direction = request.direction.map(|v| v / len);
    let origin = grid.index(request.origin).0;
    let along = multiply(grid.inverse, direction);
    let mut entry = 0f64;
    let mut exit = f64::INFINITY;
    for a in 0..3 {
        let low = request.crop.min[a] as f64 - 0.5;
        let high = request.crop.max[a] as f64 + 0.5;
        if along[a].abs() < 1e-12 {
            if origin[a] < low || origin[a] > high {
                return Ok(None);
            }
        } else {
            let first = (low - origin[a]) / along[a];
            let last = (high - origin[a]) / along[a];
            entry = entry.max(first.min(last));
            exit = exit.min(first.max(last));
        }
    }
    if !exit.is_finite() || exit < entry {
        return Ok(None);
    }
    let mut surface = Surface {
        reader: Reader::new(source),
        layers,
        dimensions: s.dimensions,
        origin,
        along,
        entry,
        exit,
        threshold: request.threshold,
    };
    let Some(hit) = surface.hit(false, &[])? else {
        return Ok(None);
    };
    let original = surface.hit(true, &[])?;
    let stroke_depth = request.stroke_depth.unwrap_or(hit);
    let at = |distance: f64| std::array::from_fn(|a| request.origin.0[a] + distance * direction[a]);
    let mut out = Touched {
        point: at(hit),
        depth: original.map(|d| (hit - d).max(0.)),
        stroke_depth,
        changed: Vec::new(),
    };
    if let Some(radius) = request.radius {
        ensure!(
            radius.is_finite() && radius > 0. && stroke_depth.is_finite() && stroke_depth >= 0.,
            "Invalid burr"
        );
        if hit > stroke_depth + radius {
            return Ok(None);
        }
        out.point = at(hit.min(stroke_depth) + radius / 2.);
        let middle = grid.index(PatientPoint(out.point)).0;
        let reach: Vector = std::array::from_fn(|a| {
            norm(grid.inverse[a * 3..a * 3 + 3].try_into().unwrap()) * radius
        });
        let low: [usize; 3] = std::array::from_fn(|a| {
            ((middle[a] - reach[a]).ceil().max(0.) as usize).max(request.crop.min[a])
        });
        let high: [usize; 3] = std::array::from_fn(|a| {
            ((middle[a] + reach[a]).floor().max(0.) as usize).min(request.crop.max[a])
        });
        let count = (0..3).fold(1usize, |n, a| {
            n.saturating_mul((high[a] + 1).saturating_sub(low[a]))
        });
        ensure!(
            count <= 2_000_000,
            "Burr exceeds the stroke sampling budget"
        );
        for z in low[2]..=high[2] {
            for y in low[1]..=high[1] {
                for x in low[0]..=high[0] {
                    let flat = (z * s.dimensions[1] + y) * s.dimensions[0] + x;
                    let delta = sub(
                        grid.world(VoxelPoint([x as f64, y as f64, z as f64])).0,
                        out.point,
                    );
                    if dot(delta, delta) <= radius * radius + 1e-10
                        && layers.mask_at(flat) == 0
                        && matches!(surface.reader.at(x, y, z)?, Sample::Value { .. })
                    {
                        out.changed.push(flat.try_into()?);
                    }
                }
            }
        }
        if let Some(after) = surface.hit(false, &out.changed)? {
            out.depth = original.map(|d| (after - d).max(0.));
        } else {
            out.depth = None;
        }
    }
    Ok(Some(out))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub target: String,
    pub layer_revision: u32,
    pub crop: Crop,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    min: [usize; 3],
    max: [usize; 3],
    inside_count: usize,
}
pub fn selected(source: &SourceSeries, layers: &Layers, request: &Selection) -> Result<Bounds> {
    request.crop.validate(source)?;
    let [nx, ny, _] = source.info.dimensions;
    let mut result = Bounds {
        min: source.info.dimensions,
        max: [0; 3],
        inside_count: 0,
    };
    let mut reader = Reader::new(source);
    let crop = request.crop;
    for z in crop.min[2]..=crop.max[2] {
        for y in crop.min[1]..=crop.max[1] {
            for x in crop.min[0]..=crop.max[0] {
                if layers.mask_at((z * ny + y) * nx + x) != 0
                    || !matches!(reader.at(x, y, z)?, Sample::Value { .. })
                {
                    continue;
                }
                result.inside_count += 1;
                for (a, n) in [x, y, z].into_iter().enumerate() {
                    result.min[a] = result.min[a].min(n);
                    result.max[a] = result.max[a].max(n);
                }
            }
        }
    }
    ensure!(
        result.inside_count > 0,
        "The selected region contains no source voxels."
    );
    Ok(result)
}
