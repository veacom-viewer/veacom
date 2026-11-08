use super::*;
use crate::measure::{polygon_area, polygon_contains, validate_polygon};

/// Between source planes the scalar grid is interpolated. Emission studies use
/// the intersected voxels when feasible, preserving their maximum uptake.
pub(super) fn region(
    source: &SourceSeries,
    pixels: &PixelBuffer,
    request: &Region,
    u: Vector,
    v: Vector,
) -> Result<Option<RegionResult>> {
    let dims = source.info.dimensions;
    ensure!(
        source.info.components == 1
            && dims.into_iter().try_fold(1usize, usize::checked_mul) == Some(pixels.len()),
        "Invalid volume buffer"
    );
    ensure!(
        (norm(u) - 1.).abs() < 1e-6 && (norm(v) - 1.).abs() < 1e-6 && dot(u, v).abs() < 1e-6,
        "Invalid plane axes"
    );
    if request.points.len() < 3 || (request.shape != Shape::Polygon && request.points.len() != 4) {
        return Ok(None);
    }
    let origin = request.points[0].0;
    let normal = cross(u, v);
    let mut poly = Vec::with_capacity(request.points.len());
    let grid = Grid::new(
        source.info.origin,
        source.info.direction,
        source.info.spacing,
    )?;
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for point in &request.points {
        let d = sub(point.0, origin);
        ensure!(
            point.0.iter().all(|x| x.is_finite()) && dot(d, normal).abs() <= 0.001,
            "Non-coplanar ROI"
        );
        poly.push([dot(d, u), dot(d, v)]);
        let ijk = grid.index(*point).0;
        for i in 0..3 {
            lo[i] = lo[i].min(ijk[i]);
            hi[i] = hi[i].max(ijk[i]);
        }
    }
    if validate_polygon(&poly).is_err() {
        return Ok(None);
    }
    let min: [f64; 2] =
        std::array::from_fn(|i| poly.iter().map(|p| p[i]).fold(f64::INFINITY, f64::min));
    let max: [f64; 2] =
        std::array::from_fn(|i| poly.iter().map(|p| p[i]).fold(f64::NEG_INFINITY, f64::max));
    let span = [max[0] - min[0], max[1] - min[1]];
    let area = if request.shape == Shape::Ellipse {
        std::f64::consts::PI * span[0] * span[1] / 4.
    } else {
        polygon_area(&poly)
    };
    if !area.is_finite() || area <= 1e-10 {
        return Ok(None);
    }
    if request.shape != Shape::Polygon {
        let tol = span[0].max(span[1]).max(1.) * 1e-5;
        if poly[1][1].abs() > tol
            || poly[3][0].abs() > tol
            || (poly[2][0] - poly[1][0]).abs() > tol
            || (poly[2][1] - poly[3][1]).abs() > tol
        {
            return Ok(None);
        }
    }
    let inside = |p: [f64; 2]| match request.shape {
        Shape::Polygon => polygon_contains(p, &poly),
        Shape::Rectangle => (0..2).all(|i| p[i] >= min[i] - 1e-7 && p[i] <= max[i] + 1e-7),
        Shape::Ellipse => {
            (0..2)
                .map(|i| ((2. * p[i] - min[i] - max[i]) / span[i]).powi(2))
                .sum::<f64>()
                <= 1. + 1e-12
        }
    };
    let du = multiply(grid.inverse, u);
    let dv = multiply(grid.inverse, v);
    let first: [usize; 3] =
        std::array::from_fn(|i| (lo[i].floor() - 1.).clamp(0., dims[i] as f64) as usize);
    let end: [usize; 3] =
        std::array::from_fn(|i| (hi[i].ceil() + 2.).clamp(0., dims[i] as f64) as usize);
    let candidates = (0..3).fold(1usize, |n, i| {
        n.saturating_mul(end[i].saturating_sub(first[i]))
    });
    let voxels = matches!(source.info.modality.as_str(), "PT" | "NM") && candidates <= 4_000_000;
    let (factor, unit) = request.normalization.quantity(source);
    let mut stats = Stats::default();
    let mut outside = 0;
    let mut clipped = false;
    let mut reduced = false;
    let step;
    if voxels {
        ensure!(
            request.shape != Shape::Polygon || candidates.saturating_mul(poly.len()) <= 128_000_000,
            "Region exceeds sampling limit"
        );
        let reach = grid
            .axes
            .iter()
            .map(|axis| dot(*axis, normal).abs())
            .sum::<f64>()
            / 2.
            + 1e-7;
        clipped = (0..3).any(|i| lo[i] < -0.5000001 || hi[i] > dims[i] as f64 - 0.4999999);
        step = [norm(grid.axes[0]), norm(grid.axes[1])];
        let offset = sub(grid.origin, origin);
        for z in first[2]..end[2] {
            for y in first[1]..end[1] {
                let mut d: Vector = std::array::from_fn(|i| {
                    offset[i]
                        + z as f64 * grid.axes[2][i]
                        + y as f64 * grid.axes[1][i]
                        + first[0] as f64 * grid.axes[0][i]
                });
                for x in first[0]..end[0] {
                    if dot(d, normal).abs() <= reach && inside([dot(d, u), dot(d, v)]) {
                        let value = pixels.value((z * dims[1] + y) * dims[0] + x);
                        if pixels.is_padding(source, z, value) {
                            stats.padding += 1;
                        } else {
                            stats.add(value * factor);
                        }
                    }
                    for (p, dx) in d.iter_mut().zip(grid.axes[0]) {
                        *p += dx;
                    }
                }
            }
        }
    } else {
        let mut size = [
            (span[0] * norm(du)).ceil().max(1.),
            (span[1] * norm(dv)).ceil().max(1.),
        ];
        if size[0] * size[1] > 200_000. {
            let scale = (size[0] * size[1] / 200_000.).sqrt();
            size[0] = (size[0] / scale).floor().clamp(1., 200_000.);
            size[1] = (size[1] / scale)
                .floor()
                .clamp(1., (200_000. / size[0]).floor());
            reduced = true;
        }
        ensure!(
            request.shape != Shape::Polygon
                || size[0] * size[1] * poly.len() as f64 <= 128_000_000.,
            "Region exceeds sampling limit"
        );
        step = [span[0] / size[0], span[1] / size[1]];
        let start = grid.index(PatientPoint(origin)).0;
        for y in 0..size[1] as usize {
            for x in 0..size[0] as usize {
                let p = [
                    min[0] + (x as f64 + 0.5) * step[0],
                    min[1] + (y as f64 + 0.5) * step[1],
                ];
                if !inside(p) {
                    continue;
                }
                let ijk = std::array::from_fn(|i| start[i] + p[0] * du[i] + p[1] * dv[i]);
                match plane_sample(source, pixels, ijk) {
                    PlaneSample::Value(value) => stats.add(value * factor),
                    PlaneSample::Outside => outside += 1,
                    PlaneSample::Padding => stats.padding += 1,
                    PlaneSample::Invalid => stats.invalid += 1,
                }
            }
        }
    }
    if stats.count == 0 {
        return Ok(None);
    }
    let scale = request.measurement_scale.unwrap_or(1.);
    ensure!(
        scale.is_finite() && scale > 0.,
        "Invalid measurement calibration"
    );
    let mm =
        !request.pixel_units && (source.info.spacing_known || request.measurement_scale.is_some());
    Ok(Some(RegionResult {
        mean: stats.mean(),
        min: stats.min,
        max: stats.max,
        standard_deviation: stats.sd(),
        count: stats.count,
        invalid_count: stats.invalid,
        padding_count: stats.padding,
        outside_count: outside,
        clipped: clipped || outside > 0,
        area: area
            * if mm {
                scale.powi(2)
            } else {
                norm(cross(du, dv))
            },
        area_unit: if mm { "mm²" } else { "px²" },
        unit: unit.into(),
        sampling_step: if mm {
            step.map(|n| n * scale)
        } else if voxels {
            [1., 1.]
        } else {
            [step[0] * norm(du), step[1] * norm(dv)]
        },
        spatial_unit: if mm { "mm" } else { "px" },
        sampling: if voxels {
            "source-voxels"
        } else {
            "derived-interpolated"
        },
        downsampled: reduced,
    }))
}
