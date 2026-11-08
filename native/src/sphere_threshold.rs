//! Above-threshold PET components on the cropped voxel grid of a measured sphere.
use crate::geometry::{cross, dot};
use crate::model::SourceSeries;
use crate::sampling::{Grid, Vector, VoxelPoint};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Copy, Deserialize, Serialize)]
pub enum Threshold {
    #[serde(rename = "max41")]
    Relative,
    #[serde(rename = "suv2.5")]
    BodyWeight,
}
#[derive(Serialize)]
pub struct Region {
    seed: usize,
    count: usize,
    at: Vector,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metabolic {
    threshold: Threshold,
    level: f64,
    count: usize,
    mtv_ml: f64,
    mean: f64,
    regions: Vec<Region>,
    selection_required: bool,
    first: [usize; 3],
    size: [usize; 3],
    mask_words: Vec<u32>,
}

impl Threshold {
    fn level(self, source: &SourceSeries, factor: f64, max: f64) -> Option<f64> {
        let s = &source.info;
        let level = match self {
            Self::Relative => 0.41 * max,
            Self::BodyWeight => {
                let unit = s.value_unit.to_ascii_uppercase();
                let bw = if unit == "SUVBW" {
                    1.
                } else if unit.starts_with("SUV") || unit.starts_with("SUL") {
                    return None;
                } else {
                    s.suv_factor.filter(|f| f.is_finite() && *f > 0.)?
                };
                2.5 * factor / bw
            }
        };
        (level.is_finite() && level > 0.).then_some(level)
    }
}

pub fn measure(
    source: &SourceSeries,
    grid: &Grid,
    first: [usize; 3],
    size: [usize; 3],
    values: &[f64],
    threshold: Threshold,
    factor: f64,
    max: f64,
    selected: &[usize],
) -> Option<Metabolic> {
    let level = threshold.level(source, factor, max)?;
    let [nx, ny, _] = source.info.dimensions;
    let point = |index: usize| {
        let local = super::sphere::position(index, size);
        std::array::from_fn::<_, 3, _>(|i| first[i] + local[i])
    };
    let global = |local| {
        let [x, y, z] = point(local);
        (z * ny + y) * nx + x
    };
    let selected: HashSet<_> = selected.iter().copied().collect();
    // 1 unvisited, 2 visited, 3 selected.
    let mut marks: Vec<u8> = values
        .iter()
        .map(|v| (v.is_finite() && *v >= level) as u8)
        .collect();
    let mut regions = Vec::new();
    let mut group = Vec::new();
    let mut chosen_count = 0;
    let mut chosen_sum = 0.;
    let mut first_sum = 0.;
    for seed in 0..marks.len() {
        if marks[seed] != 1 {
            continue;
        }
        let seed_index = global(seed);
        let chosen = selected.contains(&seed_index);
        let mark = if chosen { 3 } else { 2 };
        marks[seed] = mark;
        group.clear();
        group.push(seed);
        let mut cursor = 0;
        let mut sum = 0.;
        let mut peak = seed;
        while cursor < group.len() {
            let index = group[cursor];
            cursor += 1;
            sum += values[index];
            if values[index] > values[peak] {
                peak = index;
            }
            let mut visit = |neighbor| {
                if marks[neighbor] == 1 {
                    marks[neighbor] = mark;
                    group.push(neighbor);
                }
            };
            let p = super::sphere::position(index, size);
            let strides = [1, size[0], size[0] * size[1]];
            for axis in 0..3 {
                if p[axis] > 0 {
                    visit(index - strides[axis]);
                }
                if p[axis] + 1 < size[axis] {
                    visit(index + strides[axis]);
                }
            }
        }
        if regions.is_empty() {
            first_sum = sum;
        }
        if chosen {
            chosen_count += group.len();
            chosen_sum += sum;
        }
        regions.push(Region {
            seed: seed_index,
            count: group.len(),
            at: grid.world(VoxelPoint(point(peak).map(|v| v as f64))).0,
        });
    }
    if regions.len() == 1 {
        chosen_count = regions[0].count;
        chosen_sum = first_sum;
    }
    let selection_required = regions.len() > 1 && chosen_count == 0;
    let show_all = regions.len() <= 1 || selection_required;
    let mut mask_words = if regions.is_empty() {
        Vec::new()
    } else {
        vec![0u32; marks.len().div_ceil(32)]
    };
    for (i, mark) in marks.into_iter().enumerate() {
        if mark == 3 || (mark == 2 && show_all) {
            mask_words[i / 32] |= 1 << (i % 32);
        }
    }
    let [i, j, k] = grid.axes;
    let mtv_ml = chosen_count as f64 * dot(i, cross(j, k)).abs() / 1000.;
    Some(Metabolic {
        threshold,
        level,
        count: chosen_count,
        mtv_ml,
        mean: if chosen_count > 0 {
            chosen_sum / chosen_count as f64
        } else {
            0.
        },
        regions,
        selection_required,
        first,
        size,
        mask_words,
    })
}
