//! DICOM pixel centres mapped to patient LPS coordinates (PS3.3 C.7.6.2).

const DIRECTION_TOLERANCE: f64 = 1.0e-4;
const POSITION_TOLERANCE_MM: f64 = 1.0e-3;
const SINGULAR_TOLERANCE: f64 = 1.0e-12;

#[derive(Clone, Debug)]
pub struct FrameGeometry {
    pub position: Option<[f64; 3]>,
    pub orientation: Option<[f64; 6]>,
    /// DICOM order: row spacing, then column spacing, in millimetres.
    pub pixel_spacing: Option<[f64; 2]>,
    pub slice_thickness: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct Geometry {
    pub order: Vec<usize>,
    /// Image i, j, k spacing. k is the length of the actual slice displacement.
    pub spacing: [f64; 3],
    pub origin: [f64; 3],
    /// Row-major matrix whose columns are image i, j, k in patient LPS.
    /// The third column need not be perpendicular to the first two (gantry tilt).
    pub direction: [f64; 9],
    pub can_reconstruct: bool,
    /// True only when this affine mapping is supported by the source metadata.
    /// A valid single image has physical geometry, but no reconstructable volume.
    pub has_physical_geometry: bool,
    pub warnings: Vec<crate::message::Note>,
}

pub(crate) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn norm(v: [f64; 3]) -> f64 {
    v[0].hypot(v[1]).hypot(v[2])
}

fn finite(v: [f64; 3]) -> bool {
    v.iter().all(|x| x.is_finite())
}

fn unit(v: [f64; 3]) -> Option<[f64; 3]> {
    let length = norm(v);
    (finite(v) && length.is_finite() && length > SINGULAR_TOLERANCE)
        .then(|| [v[0] / length, v[1] / length, v[2] / length])
}

fn axes(orientation: Option<[f64; 6]>) -> Option<([f64; 3], [f64; 3], [f64; 3])> {
    let orientation = orientation?;
    let i = [orientation[0], orientation[1], orientation[2]];
    let j = [orientation[3], orientation[4], orientation[5]];
    if !finite(i)
        || !finite(j)
        || (norm(i) - 1.0).abs() > DIRECTION_TOLERANCE
        || (norm(j) - 1.0).abs() > DIRECTION_TOLERANCE
        || dot(i, j).abs() > DIRECTION_TOLERANCE
    {
        return None;
    }
    // Keep the source direction cosines for the pixel mapping. Only normalize
    // the cross product used to order images and determine plane separation.
    Some((i, j, unit(cross(i, j))?))
}

/// The unit normal of a plane, its row direction × its column direction, when the orientation is valid.
pub fn plane_normal(orientation: [f64; 6]) -> Option<[f64; 3]> {
    axes(Some(orientation)).map(|(_, _, normal)| normal)
}

fn spacing_valid(spacing: Option<[f64; 2]>) -> Option<[f64; 2]> {
    spacing.filter(|s| s.iter().all(|x| x.is_finite() && *x > 0.0))
}

fn matrix(i: [f64; 3], j: [f64; 3], k: [f64; 3]) -> [f64; 9] {
    [i[0], j[0], k[0], i[1], j[1], k[1], i[2], j[2], k[2]]
}

fn same_spacing(a: [f64; 2], b: [f64; 2]) -> bool {
    (0..2).all(|axis| (a[axis] - b[axis]).abs() <= 1.0e-6_f64.max(a[axis] * 1.0e-4))
}

/// Assemble a regular stack without silently replacing irregular source planes
/// with an averaged volume. Invalid stacks retain display defaults, but their
/// geometry is marked unusable for reconstruction and physical measurements.
pub fn assemble(frames: &[FrameGeometry]) -> Geometry {
    let first = frames.first();
    let source_axes = first.and_then(|frame| axes(frame.orientation));
    let (i, j, normal) = source_axes.unwrap_or(([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]));
    let source_spacing = first.and_then(|frame| spacing_valid(frame.pixel_spacing));
    let pixel_spacing = source_spacing.unwrap_or([1.0, 1.0]);
    let mut geometry = Geometry {
        order: (0..frames.len()).collect(),
        spacing: [
            pixel_spacing[1],
            pixel_spacing[0],
            first
                .and_then(|frame| frame.slice_thickness)
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(1.0),
        ],
        origin: first
            .and_then(|frame| frame.position)
            .filter(|point| finite(*point))
            .unwrap_or([0.0; 3]),
        direction: matrix(i, j, normal),
        can_reconstruct: false,
        has_physical_geometry: false,
        warnings: Vec::new(),
    };
    if frames.is_empty() {
        geometry.warnings.push(note!("geometry.noFrames", "No image frames were found."));
        return geometry;
    }

    if frames
        .iter()
        .any(|frame| frame.position.is_none_or(|point| !finite(point)))
    {
        geometry.warnings.push(note!(
            "geometry.missingPosition",
            "Missing or invalid Image Position (Patient); patient coordinates are unavailable."
        ));
    }
    if frames.iter().any(|frame| axes(frame.orientation).is_none()) {
        geometry.warnings.push(note!(
            "geometry.missingOrientation",
            "Missing or invalid Image Orientation (Patient); patient orientation is unavailable."
        ));
    }
    if frames
        .iter()
        .any(|frame| spacing_valid(frame.pixel_spacing).is_none())
    {
        geometry.warnings.push(note!(
            "geometry.missingSpacing",
            "Missing or invalid Pixel Spacing; display spacing must not be used for measurements."
        ));
    }
    if !geometry.warnings.is_empty() {
        return geometry;
    }

    let pixel_spacing = source_spacing.expect("all frame spacing was validated");
    let positions: Vec<_> = frames.iter().map(|frame| frame.position.unwrap()).collect();
    let mixed_orientation = frames.iter().any(|frame| {
        let (frame_i, frame_j, _) = axes(frame.orientation).unwrap();
        norm(sub(frame_i, i)) > DIRECTION_TOLERANCE || norm(sub(frame_j, j)) > DIRECTION_TOLERANCE
    });
    if mixed_orientation {
        geometry.warnings.push(note!(
            "geometry.mixedOrientation",
            "Frames have different orientations; original frame order is retained and volume reconstruction is disabled."
        ));
        return geometry;
    }
    if frames
        .iter()
        .any(|frame| !same_spacing(pixel_spacing, spacing_valid(frame.pixel_spacing).unwrap()))
    {
        geometry.warnings.push(note!(
            "geometry.mixedSpacing",
            "Frames have different Pixel Spacing; a single physical volume cannot represent them."
        ));
        return geometry;
    }
    if frames.len() == 1 {
        geometry.has_physical_geometry = true;
        geometry.warnings.push(note!(
            "geometry.singleImage",
            "A single image has valid in-plane geometry but no reconstructable slice stack."
        ));
        return geometry;
    }

    // Subtract a common origin before taking the projection to reduce loss of
    // precision for coordinate systems located far from zero.
    let projections: Vec<_> = positions
        .iter()
        .map(|point| dot(sub(*point, positions[0]), normal))
        .collect();
    if projections.iter().any(|value| !value.is_finite()) {
        geometry.warnings.push(note!(
            "geometry.coordinateRange",
            "Patient coordinates exceed the supported numeric range."
        ));
        return geometry;
    }
    geometry
        .order
        .sort_by(|a, b| projections[*a].total_cmp(&projections[*b]));
    geometry.origin = positions[geometry.order[0]];
    let ordered: Vec<_> = geometry
        .order
        .iter()
        .map(|index| positions[*index])
        .collect();
    for pair in geometry.order.windows(2) {
        if projections[pair[1]] - projections[pair[0]] <= POSITION_TOLERANCE_MM {
            geometry.warnings.push(note!(
                "geometry.duplicatePlanes",
                "Duplicate or indistinguishable slice planes; split time points or other acquisition dimensions before reconstruction."
            ));
            return geometry;
        }
    }

    let span = sub(*ordered.last().unwrap(), ordered[0]);
    let count = (frames.len() - 1) as f64;
    let displacement = [span[0] / count, span[1] / count, span[2] / count];
    let separation = dot(displacement, normal);
    let step_length = norm(displacement);
    if !step_length.is_finite() || separation <= POSITION_TOLERANCE_MM {
        geometry.warnings.push(note!(
            "geometry.noDisplacement",
            "Slice displacement does not define a usable volume."
        ));
        return geometry;
    }
    // Scanner positions are often rounded independently. Permit at most a tenth of a
    // millimetre and a small fraction of the plane spacing, including on tilted stacks.
    let tolerance = (separation * 0.125).clamp(POSITION_TOLERANCE_MM, 0.1);
    for (index, position) in ordered.iter().enumerate() {
        let index = index as f64;
        let expected = [
            ordered[0][0] + displacement[0] * index,
            ordered[0][1] + displacement[1] * index,
            ordered[0][2] + displacement[2] * index,
        ];
        if !finite(expected) || norm(sub(*position, expected)) > tolerance {
            geometry.warnings.push(note!(
                "geometry.irregular",
                "Irregular slice positions or missing slices; reconstruction is disabled instead of filling the gaps."
            ));
            return geometry;
        }
    }

    let k = [
        displacement[0] / step_length,
        displacement[1] / step_length,
        displacement[2] / step_length,
    ];
    geometry.direction = matrix(i, j, k);
    geometry.spacing[2] = step_length;
    if inverse(geometry.direction).is_none() {
        geometry.warnings.push(note!(
            "geometry.singular",
            "The patient-space transform is singular."
        ));
        return geometry;
    }
    geometry.has_physical_geometry = true;
    geometry.can_reconstruct = true;
    geometry
}

pub(crate) fn inverse(m: [f64; 9]) -> Option<[f64; 9]> {
    if !m.iter().all(|value| value.is_finite()) {
        return None;
    }
    let cofactors = [
        m[4] * m[8] - m[5] * m[7],
        m[2] * m[7] - m[1] * m[8],
        m[1] * m[5] - m[2] * m[4],
        m[5] * m[6] - m[3] * m[8],
        m[0] * m[8] - m[2] * m[6],
        m[2] * m[3] - m[0] * m[5],
        m[3] * m[7] - m[4] * m[6],
        m[1] * m[6] - m[0] * m[7],
        m[0] * m[4] - m[1] * m[3],
    ];
    let determinant = m[0] * cofactors[0] + m[1] * cofactors[3] + m[2] * cofactors[6];
    if !determinant.is_finite() || determinant.abs() <= SINGULAR_TOLERANCE {
        return None;
    }
    Some(cofactors.map(|value| value / determinant))
}

pub(crate) fn multiply(matrix: [f64; 9], vector: [f64; 3]) -> [f64; 3] {
    [
        matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
        matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
        matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2],
    ]
}

/// Transform a voxel centre to LPS millimetres. Invalid display fallbacks do not
/// produce physical coordinates. Single-frame geometry is valid only at k=0.
pub fn index_to_world(geometry: &Geometry, index: [f64; 3]) -> Option<[f64; 3]> {
    if !geometry.has_physical_geometry
        || !finite(index)
        || (geometry.order.len() == 1 && index[2].abs() > SINGULAR_TOLERANCE)
    {
        return None;
    }
    let relative = multiply(
        geometry.direction,
        [
            index[0] * geometry.spacing[0],
            index[1] * geometry.spacing[1],
            index[2] * geometry.spacing[2],
        ],
    );
    let point = [
        geometry.origin[0] + relative[0],
        geometry.origin[1] + relative[1],
        geometry.origin[2] + relative[2],
    ];
    finite(point).then_some(point)
}

/// Use the full inverse, including shear from gantry tilt. Transposing the
/// direction matrix would be incorrect for such stacks.
pub fn world_to_index(geometry: &Geometry, point: [f64; 3]) -> Option<[f64; 3]> {
    if !geometry.has_physical_geometry
        || !finite(point)
        || !geometry
            .spacing
            .iter()
            .all(|value| value.is_finite() && *value > 0.0)
    {
        return None;
    }
    let relative = multiply(inverse(geometry.direction)?, sub(point, geometry.origin));
    if geometry.order.len() == 1 && relative[2].abs() > POSITION_TOLERANCE_MM {
        return None;
    }
    let index = [
        relative[0] / geometry.spacing[0],
        relative[1] / geometry.spacing[1],
        if geometry.order.len() == 1 {
            0.0
        } else {
            relative[2] / geometry.spacing[2]
        },
    ];
    finite(index).then_some(index)
}

pub fn distance(a: [f64; 3], b: [f64; 3]) -> Option<f64> {
    if !finite(a) || !finite(b) {
        return None;
    }
    let result = norm(sub(a, b));
    result.is_finite().then_some(result)
}

/// Angle a–vertex–c in degrees. Degenerate or non-finite vectors are undefined.
pub fn angle(a: [f64; 3], vertex: [f64; 3], c: [f64; 3]) -> Option<f64> {
    if !finite(a) || !finite(vertex) || !finite(c) {
        return None;
    }
    let a = unit(sub(a, vertex))?;
    let c = unit(sub(c, vertex))?;
    Some(dot(a, c).clamp(-1.0, 1.0).acos().to_degrees())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(position: [f64; 3]) -> FrameGeometry {
        FrameGeometry {
            position: Some(position),
            orientation: Some([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
            pixel_spacing: Some([2.0, 0.5]),
            slice_thickness: Some(9.0),
        }
    }

    fn close(a: [f64; 3], b: [f64; 3]) {
        assert!(norm(sub(a, b)) < 1.0e-9, "{a:?} != {b:?}");
    }

    #[test]
    fn shuffled_slices_use_positions_and_dicom_spacing_order() {
        let g = assemble(&[
            frame([10.0, 20.0, 4.0]),
            frame([10.0, 20.0, 0.0]),
            frame([10.0, 20.0, 2.0]),
        ]);
        assert!(g.can_reconstruct);
        assert_eq!(g.order, [1, 2, 0]);
        assert_eq!(g.spacing, [0.5, 2.0, 2.0]);
        close(
            index_to_world(&g, [6.0, 4.0, 1.0]).unwrap(),
            [13.0, 28.0, 2.0],
        );
        close(
            world_to_index(&g, [13.0, 28.0, 2.0]).unwrap(),
            [6.0, 4.0, 1.0],
        );
    }

    #[test]
    fn accepts_rounded_positions_but_rejects_a_missing_slice() {
        for precision in [10., 100.] {
            let mut frames: Vec<_> = (0..200).map(|i| frame([0., 0., ((100. + i as f64 * 0.625) * precision).round() / precision])).collect();
            assert!(assemble(&frames).can_reconstruct);
            frames.remove(100);
            assert!(!assemble(&frames).can_reconstruct);
        }
    }

    #[test]
    fn gantry_tilt_preserves_each_frame_origin_and_uses_inverse_not_transpose() {
        let g = assemble(&[
            frame([0.0, 0.0, 0.0]),
            frame([0.5, 0.0, 2.0]),
            frame([1.0, 0.0, 4.0]),
        ]);
        assert!(g.can_reconstruct);
        close(
            index_to_world(&g, [0.0, 0.0, 2.0]).unwrap(),
            [1.0, 0.0, 4.0],
        );
        close(
            index_to_world(&g, [4.0, 3.0, 1.0]).unwrap(),
            [2.5, 6.0, 2.0],
        );
        close(
            world_to_index(&g, [2.5, 6.0, 2.0]).unwrap(),
            [4.0, 3.0, 1.0],
        );
    }

    #[test]
    fn oblique_image_maps_known_pixel_centres() {
        let c = std::f64::consts::FRAC_1_SQRT_2;
        let mut a = frame([10.0, 20.0, 30.0]);
        a.orientation = Some([c, c, 0.0, -c, c, 0.0]);
        let mut b = a.clone();
        b.position = Some([10.0, 20.0, 33.0]);
        let g = assemble(&[b, a]);
        let expected = [10.0 - 5.0 * c, 20.0 + 7.0 * c, 33.0];
        close(index_to_world(&g, [2.0, 3.0, 1.0]).unwrap(), expected);
        close(world_to_index(&g, expected).unwrap(), [2.0, 3.0, 1.0]);
    }

    #[test]
    fn negative_axis_directions_preserve_laterality_and_slice_order() {
        let mut a = frame([0.0, 0.0, -4.0]);
        a.orientation = Some([-1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        let mut b = a.clone();
        b.position = Some([0.0, 0.0, 0.0]);
        let mut c = a.clone();
        c.position = Some([0.0, 0.0, -2.0]);
        let g = assemble(&[a, b, c]);
        assert_eq!(g.order, [1, 2, 0]);
        close(
            index_to_world(&g, [2.0, 1.0, 1.0]).unwrap(),
            [-1.0, 2.0, -2.0],
        );
    }

    #[test]
    fn missing_slice_is_not_averaged_into_a_uniform_volume() {
        let g = assemble(&[
            frame([0.0, 0.0, 0.0]),
            frame([0.0, 0.0, 1.0]),
            frame([0.0, 0.0, 3.0]),
        ]);
        assert!(!g.can_reconstruct && !g.has_physical_geometry);
        assert!(g.warnings.iter().any(|s| s.text.contains("Irregular")));
        assert!(index_to_world(&g, [0.0; 3]).is_none());
    }

    #[test]
    fn irregular_in_plane_shift_is_not_accepted_as_gantry_tilt() {
        let g = assemble(&[
            frame([0.0, 0.0, 0.0]),
            frame([1.0, 0.0, 2.0]),
            frame([1.0, 0.0, 4.0]),
        ]);
        assert!(!g.has_physical_geometry);
    }

    #[test]
    fn duplicate_planes_are_rejected() {
        let g = assemble(&[frame([0.0; 3]), frame([0.0; 3])]);
        assert!(!g.can_reconstruct);
        assert!(g.warnings[0].text.contains("Duplicate"));
    }

    #[test]
    fn mixed_orientation_keeps_source_order() {
        let a = frame([0.0, 0.0, 4.0]);
        let mut b = frame([0.0; 3]);
        b.orientation = Some([1.0, 0.0, 0.0, 0.0, 0.0, -1.0]);
        let g = assemble(&[a, b]);
        assert_eq!(g.order, [0, 1]);
        assert!(!g.has_physical_geometry);
    }

    #[test]
    fn single_frame_allows_only_in_plane_physical_coordinates() {
        let g = assemble(&[frame([10.0, 20.0, 30.0])]);
        assert!(g.has_physical_geometry && !g.can_reconstruct);
        close(
            index_to_world(&g, [2.0, 3.0, 0.0]).unwrap(),
            [11.0, 26.0, 30.0],
        );
        close(
            world_to_index(&g, [11.0, 26.0, 30.0]).unwrap(),
            [2.0, 3.0, 0.0],
        );
        assert!(index_to_world(&g, [2.0, 3.0, 1.0]).is_none());
        assert!(world_to_index(&g, [11.0, 26.0, 30.1]).is_none());
    }

    #[test]
    fn missing_or_non_finite_geometry_never_becomes_physical() {
        let mut a = frame([0.0; 3]);
        a.position = None;
        a.pixel_spacing = Some([f64::NAN, 0.5]);
        let g = assemble(&[a]);
        assert!(!g.has_physical_geometry);
        assert_eq!(g.spacing[0..2], [1.0, 1.0]);
        assert!(world_to_index(&g, [0.0; 3]).is_none());
        assert!(assemble(&[]).warnings[0].text.contains("No image"));
    }

    #[test]
    fn invalid_cosines_and_changing_spacing_are_rejected() {
        let mut a = frame([0.0; 3]);
        a.orientation = Some([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        assert!(!assemble(&[a]).has_physical_geometry);
        let mut b = frame([0.0, 0.0, 1.0]);
        b.pixel_spacing = Some([2.0, 1.0]);
        assert!(!assemble(&[frame([0.0; 3]), b]).has_physical_geometry);
    }

    #[test]
    fn distance_and_angle_have_known_results_and_no_nan_outputs() {
        assert_eq!(distance([0.0; 3], [3.0, 4.0, 0.0]), Some(5.0));
        assert_eq!(distance([1.0; 3], [1.0; 3]), Some(0.0));
        assert_eq!(
            angle([1.0, 0.0, 0.0], [0.0; 3], [0.0, 1.0, 0.0]),
            Some(90.0)
        );
        assert_eq!(
            angle([1.0, 0.0, 0.0], [0.0; 3], [-1.0, 0.0, 0.0]),
            Some(180.0)
        );
        assert!(angle([0.0; 3], [0.0; 3], [1.0; 3]).is_none());
        assert!(distance([f64::NAN; 3], [0.0; 3]).is_none());
    }
}
