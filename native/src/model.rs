use crate::geometry::{FrameGeometry, Geometry};
use crate::source_file::SourceFile;
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionMetadata {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub protocol_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sequence_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub scanning_sequence: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sequence_variant: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub scan_options: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub mr_acquisition_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub manufacturer: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub image_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub acquisition_time: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub acquisition_date_time: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub acquisition_contrast: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub contrast_bolus_agent: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub contrast_bolus_route: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub contrast_bolus_start_time: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub contrast_bolus_administered: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub contrast_bolus_detected: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub contrast_bolus_phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flip_angle: Option<f64>,
    /// Shown in the image corners: who, when and where (as stored), and the scanner's field and slice.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub patient_birth_date: String,
    /// Patient's Age as stored (e.g. 045Y, 006M), so the corner shows its own unit.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub patient_age_text: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub study_time: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub study_description: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub institution_name: String,
    /// The hospital's number for the study (Accession Number): the protocol number readers look for.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub accession_number: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnetic_field_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_thickness: Option<f64>,
    /// A PET's tracer, injection and patient, for its acquisition panel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pet_acquisition: Option<PetAcquisition>,
}

/// What a PET records of its tracer, the injection and the patient, as stored, with the uptake time worked out from
/// the earliest recorded acquisition. Every field may be missing.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetAcquisition {
    /// Radiopharmaceutical (0018,0031), e.g. "Fludeoxyglucose F^18^".
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tracer: String,
    /// Radiopharmaceutical Code Sequence (0054,0304): its code value (e.g. C-B1031) and meaning.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tracer_code: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tracer_code_scheme: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub tracer_code_meaning: String,
    /// Radionuclide Code Sequence (0054,0300): its meaning, e.g. "^18^Fluorine".
    #[serde(skip_serializing_if = "String::is_empty")]
    pub radionuclide: String,
    /// Radionuclide Total Dose (0018,1074), in Bq.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injected_activity: Option<f64>,
    /// Radionuclide Half Life (0018,1075), in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub half_life: Option<f64>,
    /// Radiopharmaceutical Start DateTime (0018,1078) and Start Time (0018,1072), as stored.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub injection_date_time: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub injection_time: String,
    /// The file timezone of injection times without their own offset.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub injection_offset: String,
    /// More than one administration could apply to this series.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub multiple_administrations: bool,
    /// Earliest recorded acquisition date and time, including its UTC offset when known.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub scan_start: String,
    /// Seconds from the injection to the scan start.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptake_seconds: Option<f64>,
    /// Patient's Weight (0010,1030) in kg and Patient's Size (0010,1020) in m.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    /// Blood glucose in mmol/l, from the Acquisition Context (0040,0555) as CP-1229 records it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glucose: Option<f64>,
    /// Decay Correction (0054,1102): START, ADMIN or NONE.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub decay_correction: String,
    /// Manufacturer's Model Name (0008,1090) and Reconstruction Method (0054,1103), as stored: a patient's repeat
    /// studies are compared on the same system with the same reconstruction (EANM 2025, Supplemental File 3).
    #[serde(skip_serializing_if = "String::is_empty")]
    pub scanner_model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reconstruction: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseIdentity {
    pub kind: String,
    pub value: String,
    pub label: String,
    /// Display order within the original series; the source value remains separate.
    pub order: f64,
    #[serde(skip)]
    pub sort_values: Vec<f64>,
    /// For one gate of a gated SPECT, which gate it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
}

/// One gate of a gated SPECT (Image Type `RECON GATED TOMO`): a time slot of the cardiac cycle within one R-R interval
/// window, the range of beat lengths that window accepted (PS3.3 C.8.4.8.1.6 and C.8.4.8.1.7, C.8.4.13).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    /// The time slot, from 1, of the Number of Time Slots (0054,0071).
    pub slot: u16,
    pub slots: u16,
    /// The R-R interval window, from 1, of the Number of R-R Intervals (0054,0061): given only where the file holds
    /// several, with the beats that window accepted: Low and High R-R Value (0018,1081) and (0018,1082), in ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intervals: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beats: Option<[f64; 2]>,
    /// Time Slot Time (0054,0073): the total time, in ms, the acquisition counted into this gate over all the beats it
    /// accepted (C.8.4.13.1.2). Not where the gate lies in the cardiac cycle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_time: Option<f64>,
}

impl PhaseIdentity {
    pub fn heap_bytes(&self) -> usize {
        self.kind.capacity()
            + self.value.capacity()
            + self.label.capacity()
            + self.sort_values.capacity() * std::mem::size_of::<f64>()
    }
}

/// What can tell one frame's phase from others at the same position, read at
/// import. Text is bounded and the import budget counts it; import clears the
/// hints once the series' phase is decided.
#[derive(Clone, Debug, Default)]
pub struct PhaseHints {
    pub explicit: Option<PhaseIdentity>,
    pub dimensions: Option<PhaseIdentity>,
    pub trigger_time: Option<f64>,
    pub acquisition_number: Option<i64>,
    pub in_stack_position: Option<u32>,
    pub stack_id: String,
    pub acquisition_time: String,
    pub acquisition_date_time: String,
    pub description: Option<String>,
    /// The dimension organization a dimension index belongs to (a hash of its UID), and
    /// the value that index stands for where the frame holds it.
    pub dimension_scope: Option<u64>,
    pub dimension_value: Option<f64>,
    /// The gate of a gated SPECT the frame belongs to: with its explicit temporal position, the gate number.
    pub gate: Option<Gate>,
}

impl PhaseHints {
    pub fn heap_bytes(&self) -> usize {
        self.explicit.as_ref().map_or(0, PhaseIdentity::heap_bytes)
            + self
                .dimensions
                .as_ref()
                .map_or(0, PhaseIdentity::heap_bytes)
            + self.stack_id.capacity()
            + self.acquisition_time.capacity()
            + self.acquisition_date_time.capacity()
            + self.description.as_ref().map_or(0, String::capacity)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMetadata {
    pub origin: [f64; 3],
    pub direction: [f64; 9],
    pub spacing: [f64; 3],
    pub position_known: bool,
    pub orientation_known: bool,
    pub spacing_known: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_number: Option<i32>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sop_instance_uid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_frame_number: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_center: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_width: Option<f64>,
    /// Inclusive padding range in decoded modality units, never raw stored values.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding_range: Option<[f64; 2]>,
    /// Stored padding was masked before a non-injective modality LUT.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub padding_is_nan: bool,
    /// A segmentation frame: the segment it holds and the source image it was drawn on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_number: Option<u16>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub referenced_sop_instance_uid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referenced_frame_number: Option<u32>,
    /// The VOI LUT this frame is displayed with, an index into the series' `voi_luts`; only for
    /// frames that store no window, as a window takes precedence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voi_lut: Option<u32>,
    /// How the stored window maps values to grey when it is not LINEAR: SIGMOID or LINEAR_EXACT
    /// (VOI LUT Function, PS3.3 C.11.2.1.3). Only for frames that store a window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voi_function: Option<&'static str>,
    /// A gamma camera frame: which detector took it, in which view, energy window and phase.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nm: Option<NmFrame>,
}

/// What a gamma camera (NM) frame is, from the vectors its file's Frame Increment Pointer names (PS3.3 C.8.4.8). The
/// view comes from the detector's View Code Sequence; the detector, energy window and phase are set only where the
/// file holds more than one of them, as only then do they tell frames apart.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NmFrame {
    /// ANT, POST, RAO, LAO, RPO, LPO, R LAT or L LAT.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detector: Option<u16>,
    /// The energy window's name, or its range in keV when it has none.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub energy_window: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<u16>,
}

/// A VOI LUT (PS3.3 C.11.2): modality values from `first` map to `data`, clamped at both ends;
/// outputs run from 0 to 2^bits - 1.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiLut {
    pub first: i64,
    pub bits: u16,
    pub data: Vec<u16>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub explanation: String,
}

/// One segment of a DICOM Segmentation (SEG) object.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub number: u16,
    pub label: String,
    /// sRGB from the segment's recommended CIELab display value, when it has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<[u8; 3]>,
}

/// What a segmentation series holds and which image series it belongs to. Its frames
/// are masks, not images: the viewer draws them over the referenced series.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segmentation {
    /// SegmentationType: BINARY, FRACTIONAL or LABELMAP.
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub referenced_series_uid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referenced_series: Option<Vec<(String, String)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referenced_instances: Option<Vec<(String, Option<u32>)>>,
    pub segments: Vec<Segment>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub catalog_revision: u64,
    pub source_revision: u64,
    pub id: String,
    pub uid: String,
    pub study_uid: String,
    pub patient_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_pet_id: Option<String>,
    pub patient_id: String,
    pub patient_name: String,
    pub study_date: String,
    pub description: String,
    pub modality: String,
    pub series_number: i32,
    pub dimensions: [usize; 3],
    pub spacing: [f64; 3],
    pub origin: [f64; 3],
    pub direction: [f64; 9],
    pub window_center: f64,
    pub window_width: f64,
    /// No frame stores a window, so the core measured one from the pixels.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub window_from_pixels: bool,
    pub value_unit: String,
    /// What the stored PET values are multiplied by for SUV: SUVbw from Bq/ml, 1 for values already in SUV.
    pub suv_factor: Option<f64>,
    /// The same for SUL (lean body mass) and SUVbsa (body surface area), where the patient's height (and, for
    /// SUL, sex) are recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sul_factor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suv_bsa_factor: Option<f64>,
    pub can_reconstruct: bool,
    /// Serialized as `warnings` (English texts) and `warningNotes` (the same, for translation).
    #[serde(flatten)]
    pub warnings: crate::message::Notes,
    pub photometric_interpretation: String,
    pub frame_of_reference_uid: String,
    pub components: u8,
    pub pixel_type: String,
    pub spacing_known: bool,
    pub orientation_known: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patient_age: Option<f64>,
    pub patient_sex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub echo_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repetition_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inversion_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diffusion_b_value: Option<f64>,
    #[serde(flatten)]
    pub acquisition: AcquisitionMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<PhaseIdentity>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub frame_metadata: Vec<FrameMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding_range: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segmentation: Option<Segmentation>,
    /// The distinct VOI LUTs the frames refer to.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub voi_luts: Vec<VoiLut>,
}

pub fn is_suv_unit(unit: &str) -> bool {
    unit.get(..3).is_some_and(|prefix| {
        prefix.eq_ignore_ascii_case("SUV") || prefix.eq_ignore_ascii_case("SUL")
    })
}

impl Series {
    /// GML values retain their physical unit when the engine declines SUV calibration.
    pub fn stored_unit(&self) -> &str {
        if self.modality == "PT"
            && is_suv_unit(&self.value_unit)
            && !self.suv_factor.is_some_and(|v| v.is_finite() && v > 0.)
        {
            "g/ml"
        } else {
            &self.value_unit
        }
    }
}

#[derive(Clone, Debug)]
pub struct Frame {
    pub source: Arc<SourceFile>,
    pub index: u32,
    pub sop_uid: String,
    pub instance_number: i32,
    pub geometry: FrameGeometry,
    pub slope: f64,
    pub intercept: f64,
    pub activity: Option<Arc<crate::gamma_camera::ActivityMapping>>,
    pub ordinary_image: bool,
    /// Extra decoder threads for JPEG Baseline or Extended, one per stored component.
    pub jpeg_component_threads: u8,
    /// The VOI LUT that applies to the frame; `import` moves it into the series.
    pub voi_lut: Option<Arc<VoiLut>>,
    /// Set on every frame of a segmentation; `import` moves it into the series.
    pub segmentation: Option<Arc<Segmentation>>,
    pub metadata: FrameMetadata,
    pub phase_hints: PhaseHints,
}

#[derive(Clone)]
pub struct SourceSeries {
    pub info: Series,
    pub frames: Vec<Frame>,
    pub geometry: Geometry,
    pub documents: Vec<Arc<SourceFile>>,
}

pub enum PixelBuffer {
    I16(Vec<i16>),
    U16(Vec<u16>),
    U8(Vec<u8>),
    F32(Vec<f32>),
    F64(Vec<f64>),
}
impl PixelBuffer {
    /// Bytes retained by the pixel allocation, including spare capacity after removing an alpha channel.
    pub fn allocated_bytes(&self) -> usize {
        match self {
            Self::I16(v) => v.capacity() * size_of::<i16>(),
            Self::U16(v) => v.capacity() * size_of::<u16>(),
            Self::U8(v) => v.capacity(),
            Self::F32(v) => v.capacity() * size_of::<f32>(),
            Self::F64(v) => v.capacity() * size_of::<f64>(),
        }
    }

    pub fn is_padding(&self, source: &SourceSeries, frame: usize, value: f64) -> bool {
        let metadata = source.frames.get(frame).map(|f| &f.metadata);
        if value.is_nan() {
            return metadata.is_some_and(|m| m.padding_is_nan);
        }
        let Some(range) = metadata
            .and_then(|m| m.padding_range)
            .or(source.info.padding_range)
        else {
            return false;
        };
        let [a, b] = if matches!(self, Self::F32(_)) {
            range.map(|n| f64::from(n as f32))
        } else {
            range
        };
        (a.min(b)..=a.max(b)).contains(&value)
    }

    pub fn len(&self) -> usize {
        match self {
            Self::I16(v) => v.len(),
            Self::U16(v) => v.len(),
            Self::U8(v) => v.len(),
            Self::F32(v) => v.len(),
            Self::F64(v) => v.len(),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn value(&self, index: usize) -> f64 {
        match self {
            Self::I16(v) => v[index] as f64,
            Self::U16(v) => v[index] as f64,
            Self::U8(v) => v[index] as f64,
            Self::F32(v) => v[index] as f64,
            Self::F64(v) => v[index],
        }
    }
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::I16(_) => "int16",
            Self::U16(_) => "uint16",
            Self::U8(_) => "uint8",
            Self::F32(_) => "float32",
            Self::F64(_) => "float64",
        }
    }
    /// The samples' bytes as they lie in memory, without a copy: little-endian, as the pixel routes send them (main.rs
    /// builds for little-endian targets only).
    pub fn bytes(&self) -> &[u8] {
        match self {
            Self::I16(v) => bytes_of(v),
            Self::U16(v) => bytes_of(v),
            Self::U8(v) => v,
            Self::F32(v) => bytes_of(v),
            Self::F64(v) => bytes_of(v),
        }
    }
}

/// Sample types whose every bit pattern is a value and which have no padding: their memory can be read as bytes.
trait Plain: Copy {}
impl Plain for i16 {}
impl Plain for u16 {}
impl Plain for f32 {}
impl Plain for f64 {}

fn bytes_of<T: Plain>(values: &[T]) -> &[u8] {
    // SAFETY: `Plain` types are primitive numbers, without padding or uninitialised bytes, and u8 needs no alignment;
    // the byte slice covers exactly the values' memory and borrows it for as long as they are borrowed.
    unsafe {
        std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values))
    }
}

#[derive(Clone)]
pub struct Volume(pub Arc<PixelBuffer>);

impl AsRef<[u8]> for Volume {
    fn as_ref(&self) -> &[u8] {
        self.0.bytes()
    }
}

#[derive(Serialize)]
pub struct ImportResult {
    pub series: Vec<Series>,
    #[serde(flatten)]
    pub warnings: crate::message::Notes,
}

#[cfg(test)]
mod tests {
    use super::PixelBuffer;

    #[test]
    fn pixel_bytes_are_the_samples_little_endian() {
        assert_eq!(
            PixelBuffer::I16(vec![-2, 0x0102]).bytes(),
            [0xfe, 0xff, 0x02, 0x01]
        );
        assert_eq!(PixelBuffer::U16(vec![0xabcd]).bytes(), [0xcd, 0xab]);
        assert_eq!(PixelBuffer::U8(vec![7, 8]).bytes(), [7, 8]);
        assert_eq!(PixelBuffer::F32(vec![1.0]).bytes(), 1.0f32.to_le_bytes());
        assert_eq!(
            PixelBuffer::F64(vec![-0.5, f64::NAN]).bytes(),
            [(-0.5f64).to_le_bytes(), f64::NAN.to_le_bytes()].concat()
        );
        assert!(PixelBuffer::F64(Vec::new()).bytes().is_empty());
    }
}
