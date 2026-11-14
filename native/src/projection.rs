//! Projection radiographs (CR, DX, MG and the others whose detector records Imager Pixel Spacing): which pixel spacing
//! a measurement uses and what it means, and what the file says about the patient's side and orientation.
//!
//! The rules are those of PS3.3 10.7.1.1 and C.8.11.4: Pixel Spacing (0028,0030) equal to Imager Pixel Spacing
//! (0018,1164) means no correction for geometric magnification was applied; different values mean the image was
//! corrected for a known or assumed magnification, or calibrated against an object of known size at known depth; and
//! with neither Imager Pixel Spacing nor Pixel Spacing Calibration Type (0028,0A02) it cannot be told which. Imager
//! Pixel Spacing is measured at the front of the detector and is never adjusted for magnification. Where it is the
//! only spacing, the Estimated Radiographic Magnification Factor (0018,1114, SID/SOD, C.8.11.5) corrects it to the
//! depth of the table or bucky, as the IHE Mammography Image profile does; Pixel Spacing equal to Imager Pixel Spacing
//! keeps its own millimetres, named the detector plane. Nothing is chosen silently: the basis is
//! sent with every frame, and the interface names it beside each value.
use crate::ingest::{frame_value, nonempty_text, number, numbers, text};
use dicom_core::Tag;
use dicom_object::InMemDicomObject;
use serde::Serialize;

/// Modalities whose images are projections through the patient (PS3.3 C.7.3.1.1.1).
const PROJECTION_MODALITIES: [&str; 8] = ["CR", "DX", "MG", "IO", "PX", "RG", "XA", "RF"];
/// The longest free text kept from a calibration description (LO holds 64 characters).
const MAX_TEXT: usize = 64;

/// What the spacing a measurement uses stands for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Basis {
    /// Pixel Spacing differs from Imager Pixel Spacing, or a calibration type is given: corrected or calibrated.
    Calibrated,
    /// Imager Pixel Spacing divided by the Estimated Radiographic Magnification Factor.
    Magnification,
    /// Imager Pixel Spacing, at the detector: lengths are magnified.
    Detector,
    /// Pixel Spacing alone: whether it was corrected cannot be told (PS3.3 10.7.1.1).
    Unstated,
    /// No spacing at all: pixels only.
    None,
}

/// The calibration, side and orientation of one projection frame, as stored, with the spacing measurements use.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub basis: Basis,
    /// Row then column spacing, in mm, that measurements use; absent with `Basis::None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spacing: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_spacing: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imager_pixel_spacing: Option<[f64; 2]>,
    /// Estimated Radiographic Magnification Factor, when it is one (at least 1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnification: Option<f64>,
    /// Pixel Spacing Calibration Type: GEOMETRY, FIDUCIAL, or another value as stored.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub calibration_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub calibration_description: String,
    /// Distance Source to Detector (SID) and to Patient (SOD), in mm.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_detector: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_patient: Option<f64>,
    /// Patient Orientation (0020,0020): the patient directions of the rows and of the columns, such as L and F.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub patient_orientation: Vec<String>,
    /// Frame, Image or series Laterality, in that order (PS3.3 C.7.3.1, C.7.6.16.2.13): R, L, B or U.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub laterality: String,
    /// Body Part Examined (0018,0015) and View Position (0018,5101), as stored.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub body_part: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub view_position: String,
    /// An Estimated Radiographic Magnification Factor below 1 or not a number, which was left out.
    #[serde(skip)]
    pub ignored_magnification: Option<String>,
}

fn spacing(obj: &InMemDicomObject, tag: Tag) -> Option<[f64; 2]> {
    numbers::<2>(obj, tag).filter(|values| values.iter().all(|value| *value > 0.))
}

fn same(a: [f64; 2], b: [f64; 2]) -> bool {
    (0..2).all(|axis| (a[axis] - b[axis]).abs() <= 1.0e-6_f64.max(a[axis] * 1.0e-4))
}

fn bounded(value: String, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn laterality(obj: &InMemDicomObject, tag: Tag) -> Option<String> {
    nonempty_text(obj, tag)
        .map(|code| code.trim().to_ascii_uppercase())
        .filter(|code| matches!(code.as_str(), "R" | "L" | "B" | "U"))
}

/// Patient Orientation's two values when each names patient directions (A, P, R, L, H, F), else none.
fn patient_orientation(obj: &InMemDicomObject) -> Vec<String> {
    let value = text(obj, Tag(0x0020, 0x0020));
    let parts: Vec<String> = value
        .split('\\')
        .map(|part| part.trim().to_ascii_uppercase())
        .collect();
    let valid = parts.len() == 2
        && parts.iter().all(|part| {
            (1..=3).contains(&part.len()) && part.chars().all(|c| "APRLHF".contains(c))
        });
    if valid { parts } else { Vec::new() }
}

/// The projection facts of frame `frame`, or none for an image that is not a projection (a CT or MR keeps its Pixel
/// Spacing as before).
pub fn read(obj: &InMemDicomObject, frame: usize, modality: &str) -> Option<Projection> {
    let pixel_spacing = frame_value(obj, frame, Tag(0x0028, 0x9110), |v| {
        spacing(v, Tag(0x0028, 0x0030))
    });
    // An enhanced XA or XRF keeps it per frame, in the X-Ray Frame Pixel Data Properties Sequence (C.8.19.6.4).
    let imager_pixel_spacing = frame_value(obj, frame, Tag(0x0028, 0x9443), |group| {
        spacing(group, Tag(0x0018, 0x1164))
    });
    let calibration_type = bounded(text(obj, Tag(0x0028, 0x0a02)).to_ascii_uppercase(), 16);
    // Only the two enumerated values (PS3.3 10.7.1.3) say the spacing was calibrated; other text is kept, claiming nothing.
    let calibrated_type = matches!(calibration_type.as_str(), "GEOMETRY" | "FIDUCIAL");
    let projection = PROJECTION_MODALITIES.contains(&modality)
        || imager_pixel_spacing.is_some()
        || !calibration_type.is_empty();
    if !projection {
        return None;
    }
    let factor = number(obj, Tag(0x0018, 0x1114));
    let magnification = factor.filter(|value| (1.0..10.).contains(value));
    let ignored_magnification = factor
        .filter(|_| magnification.is_none())
        .map(|value| value.to_string())
        .or_else(|| {
            let stored = text(obj, Tag(0x0018, 0x1114));
            (factor.is_none() && !stored.is_empty()).then(|| bounded(stored, 16))
        });
    let corrected = match (pixel_spacing, imager_pixel_spacing) {
        (Some(pixel), Some(imager)) => !same(pixel, imager),
        _ => false,
    };
    let (basis, used) = match (pixel_spacing, imager_pixel_spacing) {
        (Some(pixel), _) if corrected || calibrated_type => (Basis::Calibrated, Some(pixel)),
        (Some(pixel), None) => (Basis::Unstated, Some(pixel)),
        // Pixel Spacing equal to Imager Pixel Spacing measured in its millimetres before this module: it keeps them,
        // now named the detector plane, and the factor is not applied on top until the owner decides it should be.
        (Some(pixel), Some(_)) => (Basis::Detector, Some(pixel)),
        (None, Some(imager)) => match magnification {
            Some(factor) => (
                Basis::Magnification,
                Some([imager[0] / factor, imager[1] / factor]),
            ),
            None => (Basis::Detector, Some(imager)),
        },
        (None, None) => (Basis::None, None),
    };
    Some(Projection {
        basis,
        spacing: used,
        pixel_spacing,
        imager_pixel_spacing,
        magnification,
        calibration_type,
        calibration_description: bounded(text(obj, Tag(0x0028, 0x0a04)), MAX_TEXT),
        source_detector: number(obj, Tag(0x0018, 0x1110)).filter(|value| *value > 0.),
        source_patient: number(obj, Tag(0x0018, 0x1111)).filter(|value| *value > 0.),
        patient_orientation: patient_orientation(obj),
        laterality: frame_value(obj, frame, Tag(0x0020, 0x9071), |group| {
            laterality(group, Tag(0x0020, 0x9072))
        })
        .or_else(|| laterality(obj, Tag(0x0020, 0x0062)))
        .or_else(|| laterality(obj, Tag(0x0020, 0x0060)))
        .unwrap_or_default(),
        body_part: bounded(text(obj, Tag(0x0018, 0x0015)), MAX_TEXT),
        view_position: bounded(text(obj, Tag(0x0018, 0x5101)), 16),
        ignored_magnification,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{DataElement, PrimitiveValue, VR};

    fn film(modality: &str, tags: &[(Tag, VR, &str)]) -> InMemDicomObject {
        let mut obj = InMemDicomObject::new_empty();
        obj.put(DataElement::new(
            Tag(0x0008, 0x0060),
            VR::CS,
            PrimitiveValue::from(modality),
        ));
        for (tag, vr, value) in tags {
            // Values as a file's parser gives them: one string per value.
            let values = value.split('\\').map(str::to_owned).collect();
            obj.put(DataElement::new(*tag, *vr, PrimitiveValue::Strs(values)));
        }
        obj
    }
    const PS: Tag = Tag(0x0028, 0x0030);
    const IPS: Tag = Tag(0x0018, 0x1164);
    const ERMF: Tag = Tag(0x0018, 0x1114);
    const TYPE: Tag = Tag(0x0028, 0x0a02);
    const TEXT: Tag = Tag(0x0028, 0x0a04);

    fn basis(modality: &str, tags: &[(Tag, VR, &str)]) -> (Basis, Option<[f64; 2]>) {
        let projection = read(&film(modality, tags), 0, modality).expect("a projection");
        (projection.basis, projection.spacing)
    }

    #[test]
    fn imager_pixel_spacing_alone_measures_at_the_detector() {
        assert_eq!(
            basis("DX", &[(IPS, VR::DS, "0.33\\0.33")]),
            (Basis::Detector, Some([0.33, 0.33]))
        );
    }

    #[test]
    fn the_magnification_factor_corrects_imager_pixel_spacing_and_is_named() {
        let (kind, used) = basis("DX", &[(IPS, VR::DS, "0.33\\0.33"), (ERMF, VR::DS, "1.1")]);
        assert_eq!(kind, Basis::Magnification);
        let used = used.unwrap();
        assert!((used[0] - 0.3).abs() < 1e-12 && (used[1] - 0.3).abs() < 1e-12);
    }

    #[test]
    fn a_magnification_below_one_or_not_a_number_is_left_out_and_reported() {
        for stored in ["0.9", "abc"] {
            let projection = read(
                &film("DX", &[(IPS, VR::DS, "0.33\\0.33"), (ERMF, VR::DS, stored)]),
                0,
                "DX",
            )
            .unwrap();
            assert_eq!(projection.basis, Basis::Detector, "{stored}");
            assert_eq!(projection.magnification, None);
            assert_eq!(projection.ignored_magnification.as_deref(), Some(stored));
        }
    }

    #[test]
    fn pixel_spacing_equal_to_imager_pixel_spacing_was_not_corrected() {
        assert_eq!(
            basis(
                "DX",
                &[(PS, VR::DS, "0.33\\0.33"), (IPS, VR::DS, "0.33\\0.33")]
            ),
            (Basis::Detector, Some([0.33, 0.33]))
        );
        // Not corrected, but stored as Pixel Spacing: the factor is not applied on top (the numbers stay as they were).
        let projection = read(
            &film(
                "CR",
                &[
                    (PS, VR::DS, "0.33\\0.33"),
                    (IPS, VR::DS, "0.33\\0.33"),
                    (ERMF, VR::DS, "1.1"),
                ],
            ),
            0,
            "CR",
        )
        .unwrap();
        assert_eq!(
            (projection.basis, projection.spacing),
            (Basis::Detector, Some([0.33, 0.33]))
        );
        assert_eq!(
            projection.magnification,
            Some(1.1),
            "The factor is still reported."
        );
    }

    #[test]
    fn pixel_spacing_that_differs_or_a_calibration_type_is_calibrated() {
        assert_eq!(
            basis(
                "DX",
                &[(PS, VR::DS, "0.3\\0.3"), (IPS, VR::DS, "0.33\\0.33")]
            ),
            (Basis::Calibrated, Some([0.3, 0.3]))
        );
        for kind in ["GEOMETRY", "FIDUCIAL"] {
            let projection = read(
                &film(
                    "DX",
                    &[
                        (PS, VR::DS, "0.3\\0.3"),
                        (IPS, VR::DS, "0.33\\0.33"),
                        (TYPE, VR::CS, kind),
                        (TEXT, VR::LO, "25 mm ball"),
                    ],
                ),
                0,
                "DX",
            )
            .unwrap();
            assert_eq!(projection.basis, Basis::Calibrated);
            assert_eq!(projection.calibration_type, kind);
            assert_eq!(projection.calibration_description, "25 mm ball");
            // A calibration never takes the magnification factor on top.
            assert_eq!(projection.spacing, Some([0.3, 0.3]));
        }
        // A type without Imager Pixel Spacing still says the spacing was calibrated.
        assert_eq!(
            basis(
                "DX",
                &[(PS, VR::DS, "0.3\\0.3"), (TYPE, VR::CS, "FIDUCIAL")]
            )
            .0,
            Basis::Calibrated
        );
    }

    #[test]
    fn a_calibration_type_outside_the_enumerated_values_claims_no_calibration() {
        let projection = read(
            &film("DX", &[(PS, VR::DS, "0.3\\0.3"), (TYPE, VR::CS, "UNKNOWN")]),
            0,
            "DX",
        )
        .unwrap();
        assert_eq!(
            (projection.basis, projection.spacing),
            (Basis::Unstated, Some([0.3, 0.3]))
        );
        assert_eq!(projection.calibration_type, "UNKNOWN", "The text is kept.");
        // With Imager Pixel Spacing equal to Pixel Spacing it stays the detector plane; differing, it is calibrated.
        let equal = [
            (PS, VR::DS, "0.33\\0.33"),
            (IPS, VR::DS, "0.33\\0.33"),
            (TYPE, VR::CS, "OTHER"),
        ];
        assert_eq!(basis("DX", &equal).0, Basis::Detector);
        let differing = [
            (PS, VR::DS, "0.3\\0.3"),
            (IPS, VR::DS, "0.33\\0.33"),
            (TYPE, VR::CS, "OTHER"),
        ];
        assert_eq!(basis("DX", &differing).0, Basis::Calibrated);
    }

    #[test]
    fn imager_pixel_spacing_is_read_per_frame_in_an_enhanced_film() {
        use dicom_core::{Length, value::DataSetSequence};
        let sequence = |tag: Tag, items: Vec<InMemDicomObject>| {
            DataElement::new(tag, VR::SQ, DataSetSequence::new(items, Length::UNDEFINED))
        };
        // X-Ray Frame Pixel Data Properties holding Imager Pixel Spacing, as a frame's functional group.
        let group = |value: &str| {
            let mut properties = InMemDicomObject::new_empty();
            properties.put(DataElement::new(
                IPS,
                VR::DS,
                PrimitiveValue::Strs(value.split('\\').map(str::to_owned).collect()),
            ));
            let mut item = InMemDicomObject::new_empty();
            item.put(sequence(Tag(0x0028, 0x9443), vec![properties]));
            item
        };
        // Shared: 0.2 mm. The first frame's own group lacks it; the second frame has its own 0.4 mm.
        let mut obj = film("XA", &[]);
        obj.put(sequence(Tag(0x5200, 0x9229), vec![group("0.2\\0.2")]));
        obj.put(sequence(
            Tag(0x5200, 0x9230),
            vec![InMemDicomObject::new_empty(), group("0.4\\0.4")],
        ));
        let at = |frame| read(&obj, frame, "XA").unwrap();
        assert_eq!(
            (at(0).basis, at(0).spacing),
            (Basis::Detector, Some([0.2, 0.2]))
        );
        assert_eq!(at(1).spacing, Some([0.4, 0.4]));
        assert_eq!(at(1).imager_pixel_spacing, Some([0.4, 0.4]));
        // A classic film keeps it at the top level.
        assert_eq!(
            basis("XA", &[(IPS, VR::DS, "0.3\\0.3")]),
            (Basis::Detector, Some([0.3, 0.3]))
        );
    }

    #[test]
    fn pixel_spacing_alone_on_a_radiograph_cannot_be_told() {
        assert_eq!(
            basis("CR", &[(PS, VR::DS, "0.3\\0.3")]),
            (Basis::Unstated, Some([0.3, 0.3]))
        );
    }

    #[test]
    fn a_radiograph_without_spacing_measures_in_pixels() {
        assert_eq!(basis("DX", &[]), (Basis::None, None));
        // Zero or negative spacing is no spacing.
        assert_eq!(basis("DX", &[(IPS, VR::DS, "0\\0.3")]), (Basis::None, None));
    }

    #[test]
    fn cross_sections_keep_their_pixel_spacing() {
        assert!(read(&film("CT", &[(PS, VR::DS, "0.5\\0.5")]), 0, "CT").is_none());
        // Imager Pixel Spacing makes any image a projection.
        assert!(read(&film("OT", &[(IPS, VR::DS, "0.2\\0.2")]), 0, "OT").is_some());
    }

    #[test]
    fn side_and_orientation_are_read_and_checked() {
        let projection = read(
            &film(
                "DX",
                &[
                    (Tag(0x0020, 0x0020), VR::CS, "L\\F"),
                    (Tag(0x0020, 0x0062), VR::CS, "B"),
                    (Tag(0x0020, 0x0060), VR::CS, "R"),
                    (Tag(0x0018, 0x0015), VR::CS, "LEG"),
                    (Tag(0x0018, 0x5101), VR::CS, "AP"),
                ],
            ),
            0,
            "DX",
        )
        .unwrap();
        assert_eq!(projection.patient_orientation, ["L", "F"]);
        assert_eq!(
            projection.laterality, "B",
            "Image Laterality comes before the series' Laterality."
        );
        assert_eq!(
            (
                projection.body_part.as_str(),
                projection.view_position.as_str()
            ),
            ("LEG", "AP")
        );
        let series_only =
            read(&film("DX", &[(Tag(0x0020, 0x0060), VR::CS, "l")]), 0, "DX").unwrap();
        assert_eq!(series_only.laterality, "L");
        for bad in ["L", "L\\F\\A", "X\\F", "LEFT\\F"] {
            let projection =
                read(&film("DX", &[(Tag(0x0020, 0x0020), VR::CS, bad)]), 0, "DX").unwrap();
            assert!(projection.patient_orientation.is_empty(), "{bad}");
        }
        let unknown = read(&film("DX", &[(Tag(0x0020, 0x0062), VR::CS, "X")]), 0, "DX").unwrap();
        assert_eq!(unknown.laterality, "");
    }

    #[test]
    fn free_text_is_bounded() {
        let long = "x".repeat(500);
        let projection = read(
            &film(
                "DX",
                &[
                    (PS, VR::DS, "0.3\\0.3"),
                    (TYPE, VR::CS, "FIDUCIAL"),
                    (TEXT, VR::LO, &long),
                    (Tag(0x0018, 0x0015), VR::CS, &long),
                ],
            ),
            0,
            "DX",
        )
        .unwrap();
        assert_eq!(projection.calibration_description.len(), MAX_TEXT);
        assert_eq!(projection.body_part.len(), MAX_TEXT);
    }
}
