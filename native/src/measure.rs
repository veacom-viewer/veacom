use anyhow::{Result, bail, ensure};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::geometry::{angle, distance, world_to_index};
use crate::model::{PixelBuffer, SourceSeries};

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn norm(v: [f64; 3]) -> f64 {
    v[0].hypot(v[1]).hypot(v[2])
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[derive(Clone, Debug, Deserialize)]
pub struct Plane {
    pub origin: [f64; 3],
    pub u: [f64; 3],
    pub v: [f64; 3],
}

fn sample_bounds(
    low: [f64; 2],
    high: [f64; 2],
    dimensions: [usize; 2],
) -> Result<([usize; 2], [usize; 2])> {
    let start: [f64; 2] = std::array::from_fn(|axis| low[axis].ceil().max(0.0));
    let end: [f64; 2] =
        std::array::from_fn(|axis| high[axis].floor().min((dimensions[axis] - 1) as f64));
    ensure!(
        (0..2).all(|axis| start[axis] <= end[axis]),
        "The region contains no voxel centres."
    );
    let start = start.map(|n| n as usize);
    let end = end.map(|n| n as usize);
    ensure!(
        (end[0] - start[0] + 1).saturating_mul(end[1] - start[1] + 1) <= 16_000_000,
        "Region exceeds the 16 million sample limit."
    );
    Ok((start, end))
}

fn indices(source: &SourceSeries, points: &[[f64; 3]]) -> Result<Vec<[f64; 3]>> {
    ensure!(
        source.geometry.has_physical_geometry && source.info.spacing_known,
        "Physical geometry is unavailable; millimetre measurements cannot be calculated."
    );
    points
        .iter()
        .map(|point| {
            let index = world_to_index(&source.geometry, *point)
                .ok_or_else(|| anyhow::anyhow!("Point does not map to valid patient geometry."))?;
            ensure!(
                inside(index, source.info.dimensions),
                "Measurement point lies outside the image volume."
            );
            Ok(index)
        })
        .collect()
}

fn inside(point: [f64; 3], dimensions: [usize; 3]) -> bool {
    (0..3).all(|axis| {
        dimensions[axis] > 0
            && point[axis].is_finite()
            && point[axis] >= -0.5
            && point[axis] <= dimensions[axis] as f64 - 0.5
    })
}

fn nearest_index(point: [f64; 3], dimensions: [usize; 3]) -> [usize; 3] {
    std::array::from_fn(|axis| {
        point[axis]
            .round()
            .clamp(0.0, (dimensions[axis] - 1) as f64) as usize
    })
}

fn offset(index: [usize; 3], dimensions: [usize; 3]) -> usize {
    (index[2] * dimensions[1] + index[1]) * dimensions[0] + index[0]
}

fn scalar_buffer(source: &SourceSeries, pixels: &PixelBuffer) -> Result<()> {
    ensure!(
        source.info.components == 1,
        "Pixel statistics require a scalar image, not an RGB image."
    );
    let expected = source
        .info
        .dimensions
        .iter()
        .try_fold(1usize, |count, size| count.checked_mul(*size));
    ensure!(
        expected == Some(pixels.len()),
        "Pixel buffer length does not match the source geometry."
    );
    Ok(())
}

#[derive(Default)]
struct Statistics {
    count: usize,
    mean: f64,
    m2: f64,
    min: f64,
    max: f64,
}
impl Statistics {
    fn push(&mut self, value: f64) -> Result<()> {
        ensure!(
            value.is_finite(),
            "The selected region contains a non-finite pixel value."
        );
        if self.count == 0 {
            self.min = value;
            self.max = value;
        }
        self.count += 1;
        let delta = value - self.mean;
        self.mean += delta / self.count as f64;
        self.m2 += delta * (value - self.mean);
        self.min = self.min.min(value);
        self.max = self.max.max(value);
        Ok(())
    }
    fn stddev(&self) -> f64 {
        (self.m2 / self.count as f64).max(0.0).sqrt()
    }
}

pub(crate) fn polygon_area(points: &[[f64; 2]]) -> f64 {
    let origin = points[0];
    let mut twice_area = 0.0;
    for index in 0..points.len() {
        let a = [points[index][0] - origin[0], points[index][1] - origin[1]];
        let next = points[(index + 1) % points.len()];
        let b = [next[0] - origin[0], next[1] - origin[1]];
        twice_area += a[0] * b[1] - a[1] * b[0];
    }
    twice_area.abs() * 0.5
}

pub(crate) fn validate_polygon(points: &[[f64; 2]]) -> Result<()> {
    let mut vertices = points.to_vec();
    vertices.dedup();
    if vertices.first() == vertices.last() {
        vertices.pop();
    }
    ensure!(
        vertices.len() >= 3,
        "Polygon needs at least three distinct vertices."
    );
    let orientation = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    };
    for i in 0..vertices.len() {
        let a = vertices[i];
        let b = vertices[(i + 1) % vertices.len()];
        for j in (i + 2)..vertices.len() {
            if i == 0 && j == vertices.len() - 1 {
                continue;
            }
            let c = vertices[j];
            let d = vertices[(j + 1) % vertices.len()];
            let disjoint = (0..2).any(|axis| {
                a[axis].max(b[axis]) < c[axis].min(d[axis]) - 1.0e-9
                    || c[axis].max(d[axis]) < a[axis].min(b[axis]) - 1.0e-9
            });
            if disjoint {
                continue;
            }
            let o = [
                orientation(a, b, c),
                orientation(a, b, d),
                orientation(c, d, a),
                orientation(c, d, b),
            ];
            let crosses =
                |x: f64, y: f64| x.abs() <= 1.0e-9 || y.abs() <= 1.0e-9 || x.signum() != y.signum();
            ensure!(
                !(crosses(o[0], o[1]) && crosses(o[2], o[3])),
                "Self-intersecting polygon regions are not supported."
            );
        }
    }
    Ok(())
}

pub(crate) fn polygon_contains(point: [f64; 2], polygon: &[[f64; 2]]) -> bool {
    let mut contained = false;
    for index in 0..polygon.len() {
        let a = polygon[index];
        let b = polygon[(index + 1) % polygon.len()];
        let ab = [b[0] - a[0], b[1] - a[1]];
        let ap = [point[0] - a[0], point[1] - a[1]];
        let determinant = ab[0] * ap[1] - ab[1] * ap[0];
        if determinant.abs() <= 1.0e-9 * ab[0].hypot(ab[1]).max(1.0)
            && point[0] >= a[0].min(b[0]) - 1.0e-9
            && point[0] <= a[0].max(b[0]) + 1.0e-9
            && point[1] >= a[1].min(b[1]) - 1.0e-9
            && point[1] <= a[1].max(b[1]) + 1.0e-9
        {
            return true;
        }
        if (a[1] > point[1]) != (b[1] > point[1])
            && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            contained = !contained;
        }
    }
    contained
}

fn area_scale(source: &SourceSeries, axes: [usize; 2]) -> f64 {
    let basis = |axis: usize| {
        [
            source.info.direction[axis] * source.info.spacing[axis],
            source.info.direction[3 + axis] * source.info.spacing[axis],
            source.info.direction[6 + axis] * source.info.spacing[axis],
        ]
    };
    norm(cross(basis(axes[0]), basis(axes[1])))
}

fn add_suv_stats(output: &mut Value, source: &SourceSeries, statistics: &Statistics) {
    if let Some(factor) = source
        .info
        .suv_factor
        .filter(|factor| factor.is_finite() && *factor > 0.0)
    {
        output["suv"] = json!({"mean": statistics.mean * factor, "min": statistics.min * factor,
            "max": statistics.max * factor, "stddev": statistics.stddev() * factor, "unit":"SUVbw"});
    }
}

fn trilinear(pixels: &PixelBuffer, position: [f64; 3], dimensions: [usize; 3]) -> Result<f64> {
    ensure!(
        inside(position, dimensions),
        "The selected region extends outside the volume."
    );
    let position: [f64; 3] =
        std::array::from_fn(|a| position[a].clamp(0.0, (dimensions[a] - 1) as f64));
    let low = position.map(|n| n.floor() as usize);
    let high: [usize; 3] = std::array::from_fn(|a| (low[a] + 1).min(dimensions[a] - 1));
    let fraction: [f64; 3] = std::array::from_fn(|a| position[a] - low[a] as f64);
    let mut value = 0.0;
    for z in 0..2 {
        for y in 0..2 {
            for x in 0..2 {
                let corner = [x, y, z];
                let index = std::array::from_fn(|a| if corner[a] == 0 { low[a] } else { high[a] });
                let weight: f64 = (0..3)
                    .map(|a| {
                        if corner[a] == 0 {
                            1.0 - fraction[a]
                        } else {
                            fraction[a]
                        }
                    })
                    .product();
                if weight > 0.0 {
                    let sample = pixels.value(offset(index, dimensions));
                    ensure!(
                        sample.is_finite(),
                        "The selected region contains a non-finite pixel value."
                    );
                    value += weight * sample;
                }
            }
        }
    }
    Ok(value)
}

fn plane_roi(
    source: &SourceSeries,
    pixels: &PixelBuffer,
    points: &[[f64; 3]],
    kind: &str,
    plane: &Plane,
) -> Result<Value> {
    scalar_buffer(source, pixels)?;
    indices(source, points)?;
    ensure!(
        points.len() >= if kind == "polygon" { 3 } else { 2 },
        "Not enough points for this region."
    );
    ensure!(
        kind == "polygon" || points.len() == 2,
        "Rectangle and ellipse regions require two opposite corners."
    );
    ensure!(
        plane.origin.iter().all(|v| v.is_finite()),
        "Sampling plane origin must be finite."
    );
    let lengths = [norm(plane.u), norm(plane.v)];
    ensure!(
        lengths.iter().all(|n| n.is_finite() && *n > 1.0e-12),
        "Sampling plane has an invalid axis."
    );
    let u = plane.u.map(|n| n / lengths[0]);
    let v = plane.v.map(|n| n / lengths[1]);
    ensure!(
        dot(u, v).abs() < 1.0e-6,
        "Sampling plane axes must be perpendicular."
    );
    let normal = cross(u, v);
    let mut polygon = Vec::with_capacity(points.len());
    for point in points {
        let delta = sub(*point, plane.origin);
        ensure!(
            dot(delta, normal).abs() <= 0.001,
            "Measurement points are not on the supplied sampling plane."
        );
        polygon.push([dot(delta, u), dot(delta, v)]);
    }
    let world =
        |uv: [f64; 2]| std::array::from_fn(|a| plane.origin[a] + u[a] * uv[0] + v[a] * uv[1]);
    if kind == "polygon" {
        validate_polygon(&polygon)?;
    }
    let low: [f64; 2] =
        std::array::from_fn(|a| polygon.iter().map(|p| p[a]).fold(f64::INFINITY, f64::min));
    let high: [f64; 2] = std::array::from_fn(|a| {
        polygon
            .iter()
            .map(|p| p[a])
            .fold(f64::NEG_INFINITY, f64::max)
    });
    let extent = [high[0] - low[0], high[1] - low[1]];
    let area = match kind {
        "polygon" => polygon_area(&polygon),
        "ellipse" => std::f64::consts::PI * extent[0] * extent[1] / 4.0,
        _ => extent[0] * extent[1],
    };
    ensure!(
        area.is_finite() && area > 1.0e-12,
        "Region area is zero or undefined."
    );
    let center = [(low[0] + high[0]) * 0.5, (low[1] + high[1]) * 0.5];
    let index_center = world_to_index(&source.geometry, world(center))
        .ok_or_else(|| anyhow::anyhow!("Sampling plane does not match source geometry."))?;
    let index_u = world_to_index(&source.geometry, world([center[0] + 1.0, center[1]]))
        .map(|p| sub(p, index_center))
        .ok_or_else(|| anyhow::anyhow!("Sampling plane does not match source geometry."))?;
    let index_v = world_to_index(&source.geometry, world([center[0], center[1] + 1.0]))
        .map(|p| sub(p, index_center))
        .ok_or_else(|| anyhow::anyhow!("Sampling plane does not match source geometry."))?;
    if kind == "ellipse" {
        for a in 0..3 {
            let radius = (index_u[a] * extent[0] * 0.5).hypot(index_v[a] * extent[1] * 0.5);
            ensure!(
                index_center[a] - radius >= -0.5 - 1.0e-8
                    && index_center[a] + radius <= source.info.dimensions[a] as f64 - 0.5 + 1.0e-8,
                "The selected ellipse extends outside the volume."
            );
        }
    } else if kind == "rectangle" {
        for uv in [
            [low[0], low[1]],
            [low[0], high[1]],
            [high[0], low[1]],
            [high[0], high[1]],
        ] {
            let index = world_to_index(&source.geometry, world(uv))
                .ok_or_else(|| anyhow::anyhow!("Invalid sampling plane."))?;
            ensure!(
                inside(index, source.info.dimensions),
                "The selected rectangle extends outside the volume."
            );
        }
    }
    // Grid cells are no larger than one native voxel along either plane axis.
    let counts = [
        (extent[0] * norm(index_u)).ceil().max(1.0),
        (extent[1] * norm(index_v)).ceil().max(1.0),
    ];
    ensure!(
        counts[0].is_finite() && counts[1].is_finite() && counts[0] * counts[1] <= 4_000_000.0,
        "Oblique region exceeds the 4 million sample limit."
    );
    ensure!(
        kind != "polygon" || counts[0] * counts[1] * polygon.len() as f64 <= 128_000_000.0,
        "Polygon is too detailed for this region size."
    );
    let counts = counts.map(|n| n as usize);
    let step = [extent[0] / counts[0] as f64, extent[1] / counts[1] as f64];
    let mut statistics = Statistics::default();
    for row in 0..counts[1] {
        for col in 0..counts[0] {
            let uv = [
                low[0] + (col as f64 + 0.5) * step[0],
                low[1] + (row as f64 + 0.5) * step[1],
            ];
            let included = match kind {
                "polygon" => polygon_contains(uv, &polygon),
                "ellipse" => {
                    ((uv[0] - center[0]) / (extent[0] * 0.5)).powi(2)
                        + ((uv[1] - center[1]) / (extent[1] * 0.5)).powi(2)
                        <= 1.0
                }
                _ => true,
            };
            if included {
                let index = world_to_index(&source.geometry, world(uv))
                    .ok_or_else(|| anyhow::anyhow!("Invalid sampling plane."))?;
                statistics.push(trilinear(pixels, index, source.info.dimensions)?)?;
            }
        }
    }
    ensure!(
        statistics.count > 0,
        "Region is too small to contain a sample on the selected grid."
    );
    let mut output = json!({"kind":kind,"area":area,"areaUnit":"mm²","count":statistics.count,
        "mean":statistics.mean,"min":statistics.min,"max":statistics.max,"stddev":statistics.stddev(),
        "unit":source.info.stored_unit(),"sampling":"plane-grid-trilinear","sampleSpacing":step});
    add_suv_stats(&mut output, source, &statistics);
    Ok(output)
}

pub fn measure_with_plane(
    source: &SourceSeries,
    pixels: &PixelBuffer,
    points: &[[f64; 3]],
    kind: &str,
    plane: Option<&Plane>,
) -> Result<Value> {
    let kind = if kind == "rect" { "rectangle" } else { kind };
    if let Some(plane) = plane {
        if matches!(kind, "rectangle" | "ellipse" | "polygon") {
            return plane_roi(source, pixels, points, kind, plane);
        }
    }
    measure(source, pixels, points, kind)
}

fn roi(
    source: &SourceSeries,
    pixels: &PixelBuffer,
    points: &[[f64; 3]],
    kind: &str,
) -> Result<Value> {
    scalar_buffer(source, pixels)?;
    ensure!(
        points.len() >= if kind == "polygon" { 3 } else { 2 },
        "Not enough points for this region."
    );
    ensure!(
        kind == "polygon" || points.len() == 2,
        "Rectangle and ellipse regions require two opposite corners."
    );
    let positions = indices(source, points)?;
    let ranges: [f64; 3] = std::array::from_fn(|axis| {
        let min = positions
            .iter()
            .map(|p| p[axis])
            .fold(f64::INFINITY, f64::min);
        let max = positions
            .iter()
            .map(|p| p[axis])
            .fold(f64::NEG_INFINITY, f64::max);
        max - min
    });
    let fixed = (0..3)
        .min_by(|a, b| ranges[*a].total_cmp(&ranges[*b]))
        .unwrap();
    ensure!(
        ranges[fixed] <= 1.0e-4,
        "Oblique regions require an explicit sampling plane."
    );
    let slice = positions[0][fixed];
    ensure!(
        (slice - slice.round()).abs() <= 1.0e-4,
        "This region is between source planes; provide an explicit sampling plane."
    );
    let axes: Vec<_> = (0..3).filter(|axis| *axis != fixed).collect();
    let axes = [axes[0], axes[1]];
    let polygon: Vec<_> = positions.iter().map(|p| [p[axes[0]], p[axes[1]]]).collect();
    if kind == "polygon" {
        validate_polygon(&polygon)?;
    }
    let low: [f64; 2] = std::array::from_fn(|axis| {
        polygon
            .iter()
            .map(|p| p[axis])
            .fold(f64::INFINITY, f64::min)
    });
    let high: [f64; 2] = std::array::from_fn(|axis| {
        polygon
            .iter()
            .map(|p| p[axis])
            .fold(f64::NEG_INFINITY, f64::max)
    });
    let extent = [high[0] - low[0], high[1] - low[1]];
    let area = if kind == "polygon" {
        polygon_area(&polygon)
    } else if kind == "ellipse" {
        std::f64::consts::PI * extent[0] * extent[1] / 4.0
    } else {
        extent[0] * extent[1]
    } * area_scale(source, axes);
    ensure!(
        area.is_finite() && area > 1.0e-12,
        "Region area is zero or undefined."
    );
    let dimensions = source.info.dimensions;
    let (start, end) = sample_bounds(low, high, [dimensions[axes[0]], dimensions[axes[1]]])?;
    ensure!(
        kind != "polygon"
            || (end[0] - start[0] + 1)
                .saturating_mul(end[1] - start[1] + 1)
                .saturating_mul(polygon.len())
                <= 128_000_000,
        "Polygon is too detailed for this region size."
    );
    let mut statistics = Statistics::default();
    let mut excluded_padding = 0usize;
    for v in start[1]..=end[1] {
        for u in start[0]..=end[0] {
            let uv = [u as f64, v as f64];
            let included = match kind {
                "polygon" => polygon_contains(uv, &polygon),
                "ellipse" => {
                    let dx = (uv[0] - (low[0] + high[0]) * 0.5) / (extent[0] * 0.5);
                    let dy = (uv[1] - (low[1] + high[1]) * 0.5) / (extent[1] * 0.5);
                    dx * dx + dy * dy <= 1.0 + 1.0e-12
                }
                _ => true,
            };
            if included {
                let mut index = [0; 3];
                index[fixed] = slice.round() as usize;
                index[axes[0]] = u;
                index[axes[1]] = v;
                let value=pixels.value(offset(index, dimensions));
                if value.is_nan() && source.frames.get(index[2]).is_some_and(|frame|frame.metadata.padding_is_nan) {
                    excluded_padding+=1;
                } else {
                    statistics.push(value)?;
                }
            }
        }
    }
    ensure!(
        statistics.count > 0,
        "The region contains no voxel centres."
    );
    let mut output = json!({"kind":kind,"area":area,"areaUnit":"mm²","count":statistics.count,
        "mean":statistics.mean,"min":statistics.min,"max":statistics.max,"stddev":statistics.stddev(),
        "unit":source.info.stored_unit(),"sampling":"source-voxel-centres","excludedPadding":excluded_padding});
    add_suv_stats(&mut output, source, &statistics);
    Ok(output)
}

pub fn measure(
    source: &SourceSeries,
    pixels: &PixelBuffer,
    points: &[[f64; 3]],
    kind: &str,
) -> Result<Value> {
    ensure!(!points.is_empty(), "Measurement requires points.");
    let positions = indices(source, points)?;
    match kind {
        "length" | "line" | "distance" => {
            ensure!(points.len() == 2, "Length requires two points.");
            Ok(
                json!({"kind":kind,"value":distance(points[0],points[1]).ok_or_else(||anyhow::anyhow!("Invalid length."))?,"unit":"mm"}),
            )
        }
        "polyline" => {
            ensure!(points.len() >= 2, "Polyline requires at least two points.");
            let value: f64 = points
                .windows(2)
                .map(|pair| {
                    distance(pair[0], pair[1])
                        .ok_or_else(|| anyhow::anyhow!("Invalid polyline segment."))
                })
                .collect::<Result<Vec<_>>>()?
                .iter()
                .sum();
            ensure!(
                value.is_finite(),
                "Polyline length exceeds the supported range."
            );
            Ok(json!({"kind":kind,"value":value,"unit":"mm"}))
        }
        "angle" => {
            ensure!(points.len() == 3, "Angle requires three points.");
            let value = angle(points[0], points[1], points[2])
                .ok_or_else(|| anyhow::anyhow!("Angle has a zero-length arm."))?;
            Ok(json!({"kind":kind,"value":value,"unit":"deg"}))
        }
        "cobb" => {
            ensure!(
                points.len() == 4,
                "Cobb angle requires four points defining two lines."
            );
            let a = sub(points[1], points[0]);
            let b = sub(points[3], points[2]);
            let value = angle(a, [0.0; 3], b)
                .ok_or_else(|| anyhow::anyhow!("Cobb angle has a zero-length line."))?;
            Ok(json!({"kind":kind,"value":value.min(180.0-value),"unit":"deg"}))
        }
        "probe" => {
            scalar_buffer(source, pixels)?;
            ensure!(points.len() == 1, "Pixel probe requires one point.");
            let index = nearest_index(positions[0], source.info.dimensions);
            let value = pixels.value(offset(index, source.info.dimensions));
            ensure!(value.is_finite(), "The selected pixel is not finite.");
            let mut result = json!({"kind":kind,"value":value,"unit":source.info.stored_unit(),"index":index,"world":points[0]});
            if let Some(factor) = source
                .info
                .suv_factor
                .filter(|factor| factor.is_finite() && *factor > 0.0)
            {
                result["suv"] = json!(value * factor);
            }
            Ok(result)
        }
        "rectangle" | "rect" => roi(source, pixels, points, "rectangle"),
        "ellipse" | "polygon" => roi(source, pixels, points, kind),
        _ => bail!("Unsupported measurement kind: {kind}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{FrameGeometry, assemble, index_to_world};
    use crate::model::Series;

    fn phantom() -> (SourceSeries, PixelBuffer) {
        let frames: Vec<_> = (0..5)
            .map(|z| FrameGeometry {
                position: Some([10.0, 20.0, 30.0 + 4.0 * z as f64]),
                orientation: Some([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
                pixel_spacing: Some([3.0, 2.0]),
                slice_thickness: Some(4.0),
            })
            .collect();
        let geometry = assemble(&frames);
        let info = Series {
            catalog_revision: 0,
            source_revision: 0,
            id: "phantom".into(),
            uid: "1.2".into(),
            study_uid: "1.3".into(),
            patient_key: String::new(),
            previous_pet_id: None,
            patient_id: String::new(),
            patient_name: String::new(),
            study_date: String::new(),
            description: String::new(),
            modality: "CT".into(),
            series_number: 1,
            dimensions: [5, 5, 5],
            spacing: geometry.spacing,
            origin: geometry.origin,
            direction: geometry.direction,
            window_center: 100.0,
            window_width: 200.0,
            window_from_pixels: false,
            value_unit: "HU".into(),
            suv_factor: Some(0.5),
            sul_factor: None,
            suv_bsa_factor: None,
            can_reconstruct: geometry.can_reconstruct,
            warnings: Default::default(),
            photometric_interpretation: "MONOCHROME2".into(),
            frame_of_reference_uid: "1.4".into(),
            components: 1,
            pixel_type: "float32".into(),
            spacing_known: true,
            orientation_known: true,
            patient_age: None,
            patient_sex: String::new(),
            echo_time: None,
            repetition_time: None,
            inversion_time: None,
            diffusion_b_value: None,
            acquisition: Default::default(),
            frame_metadata: Vec::new(),
            phase: None,
            padding_range: None,
            segmentation: None,
            voi_luts: Vec::new(),
        };
        let values = (0..125)
            .map(|i| ((i % 5) + 10 * ((i / 5) % 5) + 100 * (i / 25)) as f32)
            .collect();
        (
            SourceSeries {
                info,
                geometry,
                frames: vec![],
                documents: vec![],
            },
            PixelBuffer::F32(values),
        )
    }

    fn points(source: &SourceSeries, indices: &[[f64; 3]]) -> Vec<[f64; 3]> {
        indices
            .iter()
            .map(|p| index_to_world(&source.geometry, *p).unwrap())
            .collect()
    }

    fn near(value: &Value, expected: f64) {
        assert!(
            (value.as_f64().unwrap() - expected).abs() < 1.0e-9,
            "{value} != {expected}"
        );
    }

    #[test]
    fn physical_rectangle_statistics_on_anisotropic_volume() {
        let (source, pixels) = phantom();
        for (corners, area) in [
            ([[1.0, 1.0, 2.0], [3.0, 3.0, 2.0]], 24.0),
            ([[1.0, 2.0, 1.0], [3.0, 2.0, 3.0]], 32.0),
            ([[2.0, 1.0, 1.0], [2.0, 3.0, 3.0]], 48.0),
        ] {
            let result =
                measure(&source, &pixels, &points(&source, &corners), "rectangle").unwrap();
            near(&result["area"], area);
            near(&result["mean"], 222.0);
            assert_eq!(result["count"], 9);
        }
        let result = measure(
            &source,
            &pixels,
            &points(&source, &[[1.0, 1.0, 2.0], [3.0, 3.0, 2.0]]),
            "rectangle",
        )
        .unwrap();
        near(&result["stddev"], (202.0_f64 / 3.0).sqrt());
        near(&result["min"], 211.0);
        near(&result["max"], 233.0);
        near(&result["suv"]["mean"], 111.0);
    }

    #[test]
    fn ellipse_and_polygon_masks_have_known_areas_and_counts() {
        let (source, pixels) = phantom();
        let ellipse = measure(
            &source,
            &pixels,
            &points(&source, &[[1.0, 1.0, 2.0], [3.0, 3.0, 2.0]]),
            "ellipse",
        )
        .unwrap();
        near(&ellipse["area"], 6.0 * std::f64::consts::PI);
        near(&ellipse["mean"], 222.0);
        assert_eq!(ellipse["count"], 5);
        let polygon = measure(
            &source,
            &pixels,
            &points(
                &source,
                &[[0.0, 0.0, 2.0], [4.0, 0.0, 2.0], [0.0, 4.0, 2.0]],
            ),
            "polygon",
        )
        .unwrap();
        near(&polygon["area"], 48.0);
        near(&polygon["mean"], 200.0 + 44.0 / 3.0);
        assert_eq!(polygon["count"], 15);
    }

    #[test]
    fn gantry_tilt_area_uses_affine_basis_cross_product() {
        let (mut source, pixels) = phantom();
        let frames: Vec<_> = (0..5)
            .map(|z| FrameGeometry {
                position: Some([10.0 + z as f64, 20.0, 30.0 + 4.0 * z as f64]),
                orientation: Some([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
                pixel_spacing: Some([3.0, 2.0]),
                slice_thickness: Some(4.0),
            })
            .collect();
        source.geometry = assemble(&frames);
        source.info.direction = source.geometry.direction;
        source.info.spacing = source.geometry.spacing;
        let result = measure(
            &source,
            &pixels,
            &points(&source, &[[1.0, 2.0, 1.0], [3.0, 2.0, 3.0]]),
            "rectangle",
        )
        .unwrap();
        near(&result["area"], 32.0);
        near(&result["mean"], 222.0);
        let sagittal = measure(
            &source,
            &pixels,
            &points(&source, &[[2.0, 1.0, 1.0], [2.0, 3.0, 3.0]]),
            "rectangle",
        )
        .unwrap();
        near(&sagittal["area"], 12.0 * 17.0_f64.sqrt());
    }

    #[test]
    fn self_intersecting_polygons_are_rejected_and_closed_simple_polygons_accepted() {
        assert!(validate_polygon(&[[0.0, 0.0], [3.0, 2.0], [0.0, 3.0], [2.0, 0.0]]).is_err());
        assert!(
            validate_polygon(&[[0.0, 0.0], [3.0, 0.0], [3.0, 3.0], [0.0, 3.0], [0.0, 0.0]]).is_ok()
        );
    }

    #[test]
    fn empty_edge_roi_unknown_geometry_and_outside_points_are_rejected() {
        let (mut source, pixels) = phantom();
        let corners = points(&source, &[[-0.4, 1.0, 2.0], [-0.1, 3.0, 2.0]]);
        assert!(
            measure(&source, &pixels, &corners, "rectangle")
                .unwrap_err()
                .to_string()
                .contains("no voxel centres")
        );
        assert!(
            measure(
                &source,
                &pixels,
                &points(&source, &[[-0.6, 0.0, 0.0]]),
                "probe"
            )
            .is_err()
        );
        source.geometry.has_physical_geometry = false;
        assert!(
            measure(
                &source,
                &pixels,
                &[[10.0, 20.0, 30.0], [12.0, 20.0, 30.0]],
                "length"
            )
            .is_err()
        );
    }

    #[test]
    fn oblique_rectangle_trilinear_sampling_preserves_a_linear_phantom_mean() {
        let (source, pixels) = phantom();
        let q = std::f64::consts::FRAC_1_SQRT_2;
        let plane = Plane {
            origin: [14.0, 26.0, 38.0],
            u: [1.0, 0.0, 0.0],
            v: [0.0, q, q],
        };
        let corners = [
            [12.0, 26.0 - 2.0 * q, 38.0 - 2.0 * q],
            [16.0, 26.0 + 2.0 * q, 38.0 + 2.0 * q],
        ];
        assert!(measure(&source, &pixels, &corners, "rectangle").is_err());
        let result =
            measure_with_plane(&source, &pixels, &corners, "rectangle", Some(&plane)).unwrap();
        near(&result["area"], 16.0);
        near(&result["mean"], 222.0);
        assert_eq!(result["count"], 4);
        assert_eq!(result["sampling"], "plane-grid-trilinear");
        assert!((trilinear(&pixels, [1.2, 2.3, 3.4], [5, 5, 5]).unwrap() - 364.2).abs() < 1.0e-10);
    }

    #[test]
    fn lengths_angles_and_probe_use_patient_space_and_rescaled_values() {
        let (source, pixels) = phantom();
        let length = measure(
            &source,
            &pixels,
            &points(&source, &[[0.0, 0.0, 0.0], [3.0, 4.0, 0.0]]),
            "length",
        )
        .unwrap();
        near(&length["value"], 180.0_f64.sqrt());
        let angle = measure(
            &source,
            &pixels,
            &points(
                &source,
                &[[1.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            ),
            "angle",
        )
        .unwrap();
        near(&angle["value"], 90.0);
        let probe = measure(
            &source,
            &pixels,
            &points(&source, &[[1.2, 2.3, 3.4]]),
            "probe",
        )
        .unwrap();
        near(&probe["value"], 321.0);
        near(&probe["suv"], 160.5);
        assert_eq!(probe["index"], json!([1, 2, 3]));
    }
    #[test]
    fn statistics_are_population_statistics() {
        let mut s = Statistics::default();
        for n in [1.0, 2.0, 3.0, 4.0] {
            s.push(n).unwrap();
        }
        assert_eq!(s.mean, 2.5);
        assert_eq!(s.count, 4);
        assert!((s.stddev() - 1.25_f64.sqrt()).abs() < 1e-12);
        assert!(s.push(f64::NAN).is_err());
    }
    #[test]
    fn polygon_mask_includes_boundary_and_excludes_concavity() {
        let p = [
            [0.0, 0.0],
            [3.0, 0.0],
            [3.0, 1.0],
            [1.0, 1.0],
            [1.0, 3.0],
            [0.0, 3.0],
        ];
        assert_eq!(polygon_area(&p), 5.0);
        assert!(polygon_contains([0.0, 1.0], &p));
        assert!(polygon_contains([0.5, 2.5], &p));
        assert!(!polygon_contains([2.0, 2.0], &p));
    }
    #[test]
    fn probe_bounds_and_layout_are_explicit() {
        assert!(inside([0.0, 0.0, 0.0], [2, 3, 4]));
        assert!(!inside([-0.6, 0.0, 0.0], [2, 3, 4]));
        assert!(!inside([2.0, 0.0, 0.0], [2, 3, 4]));
        assert_eq!(nearest_index([1.49, 1.8, 2.1], [2, 3, 4]), [1, 2, 2]);
        assert_eq!(offset([1, 2, 2], [2, 3, 4]), 17);
    }
}
