//! Gamma camera (NM) files say what each frame is outside the frames. The Frame Increment Pointer (0028,0009) names
//! vectors that give every frame its detector, energy window, phase or slice (PS3.3 C.8.4.8). The Detector Information
//! Sequence (0054,0022) gives each detector's view and, for a reconstructed SPECT, where its first slice lies and how
//! it faces (C.8.4.11). The slices follow along row × column, Spacing Between Slices apart; a negative spacing stacks
//! them the other way (C.8.4.15).
//!
//! A gated SPECT (`RECON GATED TOMO`) holds one such volume per gate: its frames go by R-R Interval Vector, Time Slot
//! Vector and Slice Vector, the slice fastest (Table C.8-8). An R-R interval is a window of beat lengths (normal beats
//! in one, ectopic ones in another), and each window's beats are cut into the same Number of Time Slots. The NM
//! Multi-gated Acquisition Module says, window by window, how long each time slot counted (C.8.4.13).

use crate::geometry::plane_normal;
use crate::ingest::{first, number, numbers, text};
use crate::model::{Gate, NmFrame};
use dicom_core::{PrimitiveValue, Tag};
use dicom_object::InMemDicomObject;

const FRAME_INCREMENT_POINTER: Tag = Tag(0x0028, 0x0009);
const ENERGY_WINDOW_VECTOR: Tag = Tag(0x0054, 0x0010);
const ENERGY_WINDOWS: Tag = Tag(0x0054, 0x0012);
const DETECTOR_VECTOR: Tag = Tag(0x0054, 0x0020);
const DETECTORS: Tag = Tag(0x0054, 0x0022);
const PHASE_VECTOR: Tag = Tag(0x0054, 0x0030);
const RR_INTERVAL_VECTOR: Tag = Tag(0x0054, 0x0060);
const RR_INTERVALS: Tag = Tag(0x0054, 0x0061);
const GATED_INFORMATION: Tag = Tag(0x0054, 0x0062);
const DATA_INFORMATION: Tag = Tag(0x0054, 0x0063);
const TIME_SLOT_VECTOR: Tag = Tag(0x0054, 0x0070);
const TIME_SLOTS: Tag = Tag(0x0054, 0x0071);
const TIME_SLOT_INFORMATION: Tag = Tag(0x0054, 0x0072);
const TIME_SLOT_TIME: Tag = Tag(0x0054, 0x0073);
const SLICE_VECTOR: Tag = Tag(0x0054, 0x0080);
const SLICES: Tag = Tag(0x0054, 0x0081);
/// Energy window names are cut to this many characters.
const MAX_NAME: usize = 16;

/// The views of CID 26 (Nuclear Medicine Projection) that NM readers name by an abbreviation, by code value: SNOMED
/// CT, the SNOMED RT value it replaced, and for anterior and posterior the retired antero-posterior and
/// postero-anterior.
const VIEWS: [(&str, &[&str]); 8] = [
    ("ANT", &["399321004", "G-5215", "G-5200"]),
    ("POST", &["399001007", "G-5216", "G-5201"]),
    ("RAO", &["399108003", "G-5206"]),
    ("LAO", &["399074003", "G-5207"]),
    ("RPO", &["399075002", "G-5208"]),
    ("LPO", &["399136008", "G-5209"]),
    ("R LAT", &["399297009", "G-5222"]),
    ("L LAT", &["399118008", "G-5223"]),
];

/// What a gamma camera file says about its frames.
pub struct GammaCamera {
    /// For each frame, 1-based: its detector, energy window and phase.
    detectors: Option<Vec<u16>>,
    windows: Option<Vec<u16>>,
    phases: Option<Vec<u16>>,
    /// Each detector's view, and each energy window's name, in sequence order.
    views: Vec<Option<&'static str>>,
    window_names: Vec<String>,
    slices: Option<Slices>,
    gates: Option<Gates>,
}

/// A gated SPECT's gates: each frame's gate, numbered from 1 window by window, and what each gate is.
struct Gates {
    of_frame: Vec<u32>,
    gates: Vec<Gate>,
}

/// Where a reconstructed SPECT's slices lie.
struct Slices {
    first: [f64; 3],
    orientation: [f64; 6],
    /// From one slice to the next: Spacing Between Slices along row × column.
    step: [f64; 3],
    /// Each frame's slice number, 1-based.
    numbers: Vec<u16>,
}

/// Every tag the Frame Increment Pointer names (a multi-valued AT).
fn pointers(obj: &InMemDicomObject) -> Vec<Tag> {
    match obj
        .get(FRAME_INCREMENT_POINTER)
        .and_then(|element| element.value().primitive())
    {
        Some(PrimitiveValue::Tags(tags)) => tags.to_vec(),
        _ => Vec::new(),
    }
}

/// A frame vector, when the Frame Increment Pointer names it and it holds a number from 1 up for each frame.
fn vector(obj: &InMemDicomObject, pointers: &[Tag], tag: Tag, frames: usize) -> Option<Vec<u16>> {
    if !pointers.contains(&tag) {
        return None;
    }
    let values = obj.get(tag)?.to_multi_int::<u32>().ok()?;
    (values.len() == frames
        && values
            .iter()
            .all(|value| (1..=u32::from(u16::MAX)).contains(value)))
    .then(|| values.into_iter().map(|value| value as u16).collect())
}

/// Whether a vector holds more than one value: only then does it tell frames apart.
fn several(values: &Option<Vec<u16>>) -> bool {
    values
        .as_ref()
        .is_some_and(|values| values.iter().any(|value| *value != values[0]))
}

/// A count from 1, such as the Number of Time Slots.
fn count(obj: &InMemDicomObject, tag: Tag) -> Option<u16> {
    obj.get(tag)?
        .to_int::<u16>()
        .ok()
        .filter(|value| *value >= 1)
}

/// A gated SPECT's gates, when its R-R Interval and Time Slot Vectors give every frame a window and a time slot within
/// their counts, and the counts share the frames out evenly. Only a file without an R-R Interval Vector, neither named
/// by the Frame Increment Pointer nor held, has one window, and only if it says so or says nothing. A vector the file
/// holds must give every frame a window (C.8.4.8): one that does not names no gates.
fn read_gates(obj: &InMemDicomObject, pointers: &[Tag], frames: usize) -> Option<Gates> {
    let slots = count(obj, TIME_SLOTS)?;
    let time_slots = vector(obj, pointers, TIME_SLOT_VECTOR, frames)?;
    let absent = !pointers.contains(&RR_INTERVAL_VECTOR) && obj.get(RR_INTERVAL_VECTOR).is_none();
    let (intervals, windows) = if !absent {
        (
            count(obj, RR_INTERVALS)?,
            vector(obj, pointers, RR_INTERVAL_VECTOR, frames)?,
        )
    } else if obj.get(RR_INTERVALS).is_none() || count(obj, RR_INTERVALS) == Some(1) {
        (1, vec![1; frames])
    } else {
        return None;
    };
    // Every gate holds Number of Slices frames (C.8.4.8.1.8), so the gates the counts make share the frames out evenly.
    // This is checked before any gate is made: the counts are only what the file says, the frames what it holds.
    let volumes = usize::from(intervals) * usize::from(slots);
    if volumes > frames || !frames.is_multiple_of(volumes) {
        return None;
    }
    if time_slots.iter().any(|slot| *slot > slots)
        || windows.iter().any(|window| *window > intervals)
    {
        return None;
    }
    // Item n of the Gated Information Sequence is window n (C.8.4.13), and its Data Information Sequence holds one item
    // for the sum of all angular views (C.8.4.13.1.1), with the window's beat lengths and one Time Slot Information
    // item for each time slot. Anything else names nothing.
    let described: &[InMemDicomObject] = obj
        .get(GATED_INFORMATION)
        .and_then(|element| element.items())
        .filter(|items| items.len() == usize::from(intervals))
        .unwrap_or(&[]);
    let data = |window: u16| -> Option<&InMemDicomObject> {
        match described
            .get(usize::from(window) - 1)?
            .get(DATA_INFORMATION)?
            .items()?
        {
            [data] => Some(data),
            _ => None,
        }
    };
    let gates = (1..=intervals)
        .flat_map(|window| {
            let data = data(window);
            let beats = data
                .and_then(|data| {
                    Some([
                        number(data, Tag(0x0018, 0x1081))?,
                        number(data, Tag(0x0018, 0x1082))?,
                    ])
                })
                .filter(|[low, high]| *low >= 0. && low < high);
            let times: &[InMemDicomObject] = data
                .and_then(|data| data.get(TIME_SLOT_INFORMATION)?.items())
                .filter(|items| items.len() == usize::from(slots))
                .unwrap_or(&[]);
            (1..=slots).map(move |slot| Gate {
                slot,
                slots,
                interval: (intervals > 1).then_some(window),
                intervals: (intervals > 1).then_some(intervals),
                beats: beats.filter(|_| intervals > 1),
                slot_time: times
                    .get(usize::from(slot) - 1)
                    .and_then(|item| number(item, TIME_SLOT_TIME))
                    .filter(|time| *time >= 0.),
            })
        })
        .collect();
    Some(Gates {
        of_frame: windows
            .iter()
            .zip(&time_slots)
            .map(|(&window, &slot)| u32::from(window - 1) * u32::from(slots) + u32::from(slot))
            .collect(),
        gates,
    })
}

/// The view a detector took, from its View Code Sequence (0054,0220), by code value.
fn view(detector: &InMemDicomObject) -> Option<&'static str> {
    let item = first(detector, Tag(0x0054, 0x0220))?;
    let code = text(item, Tag(0x0008, 0x0100));
    let scheme = text(item, Tag(0x0008, 0x0102));
    if scheme != (if code.starts_with("G-") { "SRT" } else { "SCT" }) {
        return None;
    }
    VIEWS
        .iter()
        .find(|(_, codes)| codes.contains(&code.as_str()))
        .map(|(view, _)| *view)
}

/// An energy window's name, else its range ("126–154 keV").
fn window_name(window: &InMemDicomObject) -> String {
    let name = text(window, Tag(0x0054, 0x0018));
    if !name.is_empty() {
        return name.chars().take(MAX_NAME).collect();
    }
    first(window, Tag(0x0054, 0x0013))
        .and_then(|range| {
            Some((
                number(range, Tag(0x0054, 0x0014))?,
                number(range, Tag(0x0054, 0x0015))?,
            ))
        })
        .filter(|(low, high)| low < high)
        .map(|(low, high)| format!("{low}–{high} keV"))
        .unwrap_or_default()
}

impl GammaCamera {
    pub fn read(obj: &InMemDicomObject, frames: usize) -> Self {
        let pointers = pointers(obj);
        let detectors: &[InMemDicomObject] = obj
            .get(DETECTORS)
            .and_then(|element| element.items())
            .unwrap_or(&[]);
        let windows: &[InMemDicomObject] = obj
            .get(ENERGY_WINDOWS)
            .and_then(|element| element.items())
            .unwrap_or(&[]);
        // A reconstructed SPECT's frames are the slices of one volume, a gated one's of one volume per gate. Projections
        // (TOMO, GATED TOMO) and planar frames, gated ones too, lie in no slice stack.
        let image_type = text(obj, Tag(0x0008, 0x0008)).to_ascii_uppercase();
        let value = image_type.split('\\').nth(2).map(str::trim);
        let gates = (value == Some("RECON GATED TOMO"))
            .then(|| read_gates(obj, &pointers, frames))
            .flatten();
        let volumes = gates.as_ref().map_or(1, |gates| gates.gates.len());
        // Each frame's slice, when every volume holds each of its slices once.
        let slice_numbers = (value == Some("RECON TOMO") || gates.is_some())
            .then(|| {
                let indices = vector(obj, &pointers, SLICE_VECTOR, frames)?;
                let count = obj.get(SLICES)?.to_int::<usize>().ok()?;
                if count == 0 || count.checked_mul(volumes) != Some(frames) {
                    return None;
                }
                let mut seen = vec![false; frames];
                for (frame, &slice) in indices.iter().enumerate() {
                    let volume = gates
                        .as_ref()
                        .map_or(0, |gates| gates.of_frame[frame] as usize - 1);
                    let slice = usize::from(slice) - 1;
                    if slice >= count || std::mem::replace(&mut seen[volume * count + slice], true)
                    {
                        return None;
                    }
                }
                Some(indices)
            })
            .flatten();
        let slices = slice_numbers.and_then(|indices| {
            let [detector] = detectors else {
                return None;
            };
            let orientation = numbers::<6>(detector, Tag(0x0020, 0x0037))?;
            let normal = plane_normal(orientation)?;
            let spacing = number(obj, Tag(0x0018, 0x0088)).filter(|value| *value != 0.)?;
            Some(Slices {
                first: numbers::<3>(detector, Tag(0x0020, 0x0032))?,
                orientation,
                step: normal.map(|value| value * spacing),
                numbers: indices,
            })
        });
        // Gates only as placed volumes: a gated file that cannot be placed stays one stack, as before.
        let gates = gates.filter(|_| slices.is_some());
        Self {
            detectors: vector(obj, &pointers, DETECTOR_VECTOR, frames),
            windows: vector(obj, &pointers, ENERGY_WINDOW_VECTOR, frames),
            phases: vector(obj, &pointers, PHASE_VECTOR, frames),
            views: detectors.iter().map(view).collect(),
            window_names: windows.iter().map(window_name).collect(),
            slices,
            gates,
        }
    }

    /// The gate of a gated SPECT that `frame` belongs to: its number, counted window by window as the file orders its
    /// frames, and which gate it is.
    pub fn gate(&self, frame: usize) -> Option<(u32, Gate)> {
        let gates = self.gates.as_ref()?;
        let number = *gates.of_frame.get(frame)?;
        Some((number, gates.gates[number as usize - 1]))
    }

    /// Where a reconstructed SPECT's frame lies: its slice's place from the first slice, in patient millimetres.
    pub fn position(&self, frame: usize) -> Option<[f64; 3]> {
        let slices = self.slices.as_ref()?;
        let offset = f64::from(*slices.numbers.get(frame)?) - f64::from(*slices.numbers.first()?);
        Some([0, 1, 2].map(|axis| slices.first[axis] + slices.step[axis] * offset))
    }

    /// How a reconstructed SPECT's slices face.
    pub fn orientation(&self) -> Option<[f64; 6]> {
        self.slices.as_ref().map(|slices| slices.orientation)
    }

    /// What `frame` is, or None when the file tells nothing about it.
    pub fn frame(&self, frame: usize) -> Option<NmFrame> {
        // Without a Detector Vector, every frame comes from the one detector a file describes.
        let detector = match &self.detectors {
            Some(numbers) => numbers.get(frame).copied(),
            None => (self.views.len() == 1).then_some(1),
        };
        let pick = |values: &Option<Vec<u16>>| {
            values
                .as_ref()
                .filter(|_| several(values))
                .and_then(|values| values.get(frame).copied())
        };
        let label = NmFrame {
            view: detector
                .and_then(|number| self.views.get(usize::from(number) - 1).copied().flatten()),
            detector: detector.filter(|_| several(&self.detectors)),
            energy_window: pick(&self.windows)
                .and_then(|number| self.window_names.get(usize::from(number) - 1).cloned())
                .unwrap_or_default(),
            phase: pick(&self.phases),
        };
        (label != NmFrame::default()).then_some(label)
    }
}

/// Whether an NM Image Type (value 3) names planar frames: static, dynamic, gated, whole-body images or the projections
/// of a tomographic acquisition, which lie in no slice stack. A reconstructed SPECT, gated or not, is a volume.
pub fn planar(image_type: &str) -> bool {
    image_type.split('\\').nth(2).is_some_and(|value| {
        matches!(
            value.trim().to_ascii_uppercase().as_str(),
            "STATIC" | "DYNAMIC" | "GATED" | "WHOLE BODY" | "TOMO" | "GATED TOMO"
        )
    })
}

#[derive(Debug)]
struct ActivityRange {
    first: f64,
    last: f64,
    transform: ActivityTransform,
}
#[derive(Debug)]
enum ActivityTransform {
    Linear { slope: f64, intercept: f64 },
    Table(Vec<f64>),
}

#[derive(Debug)]
pub struct ActivityMapping(Vec<ActivityRange>);

impl ActivityMapping {
    pub fn value(&self, stored: f64) -> f64 {
        let index = self.0.partition_point(|item| item.last < stored);
        let Some(item) = self.0.get(index) else {
            return f64::NAN;
        };
        if !(item.first..=item.last).contains(&stored) {
            return f64::NAN;
        }
        match &item.transform {
            ActivityTransform::Linear { slope, intercept } => stored * slope + intercept,
            ActivityTransform::Table(data) if stored.fract() == 0. => {
                data[(stored - item.first) as usize]
            }
            ActivityTransform::Table(_) => f64::NAN,
        }
    }

    pub fn heap_bytes(&self) -> usize {
        self.0.capacity() * std::mem::size_of::<ActivityRange>()
            + self
                .0
                .iter()
                .map(|item| match &item.transform {
                    ActivityTransform::Table(data) => data.capacity() * std::mem::size_of::<f64>(),
                    ActivityTransform::Linear { .. } => 0,
                })
                .sum::<usize>()
    }
}

/// A single unambiguous mapping to Bq/mL. Each item applies only within its own stored-value range.
pub fn activity(obj: &InMemDicomObject) -> Option<ActivityMapping> {
    let mut ranges = Vec::new();
    for item in obj.get(Tag(0x0040, 0x9096))?.items()? {
        let unit = first(item, Tag(0x0040, 0x08ea))?;
        if text(unit, Tag(0x0008, 0x0102)) != "UCUM"
            || !matches!(text(unit, Tag(0x0008, 0x0100)).as_str(), "Bq/ml" | "Bq/mL")
        {
            continue;
        }
        let first =
            number(item, Tag(0x0040, 0x9216)).or_else(|| number(item, Tag(0x0040, 0x9214)))?;
        let last =
            number(item, Tag(0x0040, 0x9211)).or_else(|| number(item, Tag(0x0040, 0x9213)))?;
        if first > last {
            return None;
        }
        let transform = if let Some(lut) = item.get(Tag(0x0040, 0x9212)) {
            let data = lut.to_multi_float64().ok()?;
            if first.fract() != 0.
                || last.fract() != 0.
                || (last - first + 1.) != data.len() as f64
                || data.iter().any(|v| !v.is_finite())
            {
                return None;
            }
            ActivityTransform::Table(data)
        } else {
            ActivityTransform::Linear {
                slope: number(item, Tag(0x0040, 0x9225))?,
                intercept: number(item, Tag(0x0040, 0x9224))?,
            }
        };
        ranges.push(ActivityRange {
            first,
            last,
            transform,
        });
    }
    ranges.sort_by(|a, b| a.first.total_cmp(&b.first));
    if ranges.is_empty() || ranges.windows(2).any(|pair| pair[0].last >= pair[1].first) {
        return None;
    }
    Some(ActivityMapping(ranges))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingest::import;
    use crate::model::SourceSeries;
    use dicom_core::{DataElement, Length, VR, value::DataSetSequence};
    use std::sync::Arc;

    fn sequence(tag: Tag, items: Vec<InMemDicomObject>) -> DataElement<InMemDicomObject> {
        DataElement::new(tag, VR::SQ, DataSetSequence::new(items, Length::UNDEFINED))
    }
    fn us(tag: Tag, values: &[u16]) -> DataElement<InMemDicomObject> {
        DataElement::new(tag, VR::US, PrimitiveValue::U16(values.to_vec().into()))
    }
    fn ds(tag: Tag, value: &str) -> DataElement<InMemDicomObject> {
        DataElement::new(tag, VR::DS, value)
    }
    fn code(value: &str, scheme: &str) -> InMemDicomObject {
        InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0100), VR::SH, value),
            DataElement::new(Tag(0x0008, 0x0102), VR::SH, scheme),
        ])
    }
    /// A Detector Information Sequence item: its view's code value, and where its image lies and how it faces.
    fn detector(view: Option<&str>, position: Option<&str>, orientation: &str) -> InMemDicomObject {
        let mut item = InMemDicomObject::from_element_iter([ds(Tag(0x0020, 0x0037), orientation)]);
        if let Some(view) = view {
            item.put(sequence(
                Tag(0x0054, 0x0220),
                vec![code(
                    view,
                    if view.starts_with('G') { "SRT" } else { "SCT" },
                )],
            ));
        }
        if let Some(position) = position {
            item.put(ds(Tag(0x0020, 0x0032), position));
        }
        item
    }
    /// An NM file of 2×2 frames, frame f holding f + 1 everywhere, whose Frame Increment Pointer names `pointers`.
    fn nm(image_type: &str, frames: usize, pointers: &[Tag]) -> InMemDicomObject {
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0008), VR::CS, image_type),
            DataElement::new(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.20"),
            DataElement::new(Tag(0x0008, 0x0018), VR::UI, "1.2.3.4.5"),
            DataElement::new(Tag(0x0008, 0x0060), VR::CS, "NM"),
            DataElement::new(Tag(0x0020, 0x000d), VR::UI, "1.2.3"),
            DataElement::new(Tag(0x0020, 0x000e), VR::UI, "1.2.3.4"),
            DataElement::new(Tag(0x0020, 0x0052), VR::UI, "1.2.3.99"),
            DataElement::new(Tag(0x0028, 0x0004), VR::CS, "MONOCHROME2"),
            DataElement::new(Tag(0x0028, 0x0008), VR::IS, frames.to_string()),
            DataElement::new(
                Tag(0x0028, 0x0009),
                VR::AT,
                PrimitiveValue::Tags(pointers.to_vec().into()),
            ),
            ds(Tag(0x0028, 0x0030), "4\\4"),
            ds(Tag(0x0018, 0x0050), "4"),
        ]);
        for (tag, value) in [
            (0x0010, 2),
            (0x0011, 2),
            (0x0002, 1),
            (0x0100, 16),
            (0x0101, 16),
            (0x0102, 15),
            (0x0103, 0),
        ] {
            obj.put(us(Tag(0x0028, tag), &[value]));
        }
        let pixels: Vec<u16> = (0..frames)
            .flat_map(|frame| [frame as u16 + 1; 4])
            .collect();
        obj.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OW,
            PrimitiveValue::U16(pixels.into()),
        ));
        obj
    }
    fn import_one(obj: InMemDicomObject) -> Vec<Arc<SourceSeries>> {
        import_kept(obj).0
    }
    /// The series, and the folder its file stays in for decoding.
    fn import_kept(obj: InMemDicomObject) -> (Vec<Arc<SourceSeries>>, crate::test_dir::TempDir) {
        import_files(vec![obj])
    }
    /// The series of several files in one folder, each under its own SOP Instance UID, and the folder.
    fn import_files(
        objs: Vec<InMemDicomObject>,
    ) -> (Vec<Arc<SourceSeries>>, crate::test_dir::TempDir) {
        let dir = crate::test_dir::tempdir().unwrap();
        for (index, obj) in objs.into_iter().enumerate() {
            let uid = text(&obj, Tag(0x0008, 0x0018));
            obj.with_meta(
                dicom_object::FileMetaTableBuilder::new()
                    .media_storage_sop_class_uid("1.2.840.10008.5.1.4.1.1.20")
                    .media_storage_sop_instance_uid(uid)
                    .transfer_syntax("1.2.840.10008.1.2.1"),
            )
            .unwrap()
            .write_to_file(dir.path().join(format!("nm{index}.dcm")))
            .unwrap();
        }
        (
            import(&[dir.path().to_string_lossy().into_owned()])
                .unwrap()
                .sources,
            dir,
        )
    }
    /// A reconstructed SPECT whose detector item puts the first slice at z = 50, facing like an axial CT.
    fn spect(frames: usize, spacing: Option<&str>, slices: Option<&[u16]>) -> InMemDicomObject {
        let mut obj = nm(
            "ORIGINAL\\PRIMARY\\RECON TOMO\\EMISSION",
            frames,
            &[SLICE_VECTOR],
        );
        obj.put(sequence(
            DETECTORS,
            vec![detector(None, Some("-2\\-2\\50"), "1\\0\\0\\0\\1\\0")],
        ));
        if let Some(spacing) = spacing {
            obj.put(ds(Tag(0x0018, 0x0088), spacing));
        }
        let numbers: Vec<u16> = (1..=frames as u16).collect();
        obj.put(us(SLICE_VECTOR, slices.unwrap_or(&numbers)));
        obj.put(us(Tag(0x0054, 0x0081), &[frames as u16]));
        obj
    }
    /// Where each of the file's frames lies along z, read back from the series the engine made of it.
    fn frame_heights(source: &SourceSeries) -> Vec<(u32, f64)> {
        let mut heights: Vec<_> = source
            .frames
            .iter()
            .enumerate()
            .map(|(k, frame)| {
                (
                    frame.index,
                    source.info.origin[2]
                        + source.info.direction[8] * source.info.spacing[2] * k as f64,
                )
            })
            .collect();
        heights.sort_by_key(|(index, _)| *index);
        heights
    }

    #[test]
    fn reconstructed_spect_slices_follow_the_normal_by_the_sign_of_their_spacing() {
        for (spacing, heights) in [("4", [50., 54., 58., 62.]), ("-4", [50., 46., 42., 38.])] {
            let sources = import_one(spect(4, Some(spacing), None));
            assert_eq!(sources.len(), 1);
            let info = &sources[0].info;
            assert!(info.can_reconstruct, "{spacing}: {:?}", info.warnings);
            assert!(info.orientation_known && info.spacing_known);
            assert_eq!(info.spacing, [4., 4., 4.]);
            assert_eq!(info.origin[..2], [-2., -2.]);
            let found: Vec<f64> = frame_heights(&sources[0])
                .into_iter()
                .map(|(_, z)| z)
                .collect();
            assert_eq!(found, heights, "spacing {spacing}");
            assert!(
                info.frame_metadata
                    .iter()
                    .all(|frame| frame.position_known && frame.nm.is_none())
            );
        }
    }

    #[test]
    fn the_slice_vector_places_frames_stored_out_of_order() {
        let sources = import_one(spect(4, Some("5"), Some(&[3, 1, 4, 2])));
        assert!(sources[0].info.can_reconstruct);
        assert_eq!(
            frame_heights(&sources[0]),
            [(0, 50.), (1, 40.), (2, 55.), (3, 45.)]
        );
    }

    #[test]
    fn only_a_reconstructed_spect_with_its_spacing_gets_slice_positions() {
        let mut gated = spect(4, Some("4"), None);
        gated.put_str(
            Tag(0x0008, 0x0008),
            VR::CS,
            "ORIGINAL\\PRIMARY\\RECON GATED TOMO\\EMISSION",
        );
        let mut projections = spect(4, Some("4"), None);
        projections.put_str(
            Tag(0x0008, 0x0008),
            VR::CS,
            "ORIGINAL\\PRIMARY\\TOMO\\EMISSION",
        );
        let mut undefined = spect(4, None, None);
        undefined.put(ds(Tag(0x0018, 0x0088), ""));
        for obj in [
            spect(4, None, None),
            spect(4, Some("0"), None),
            undefined,
            gated,
            projections,
        ] {
            let sources = import_one(obj);
            let info = &sources[0].info;
            assert_eq!(sources.len(), 1);
            assert_eq!(info.dimensions[2], 4, "the frames stay one stack");
            assert!(!info.can_reconstruct);
            assert!(
                info.frame_metadata
                    .iter()
                    .all(|frame| !frame.position_known)
            );
            assert_eq!(
                sources[0]
                    .frames
                    .iter()
                    .map(|frame| frame.index)
                    .collect::<Vec<_>>(),
                [0, 1, 2, 3],
                "in the file's order"
            );
        }
        // A reconstructed SPECT that cannot be placed says so; projections lie in no slice stack and need not.
        let codes = |sources: &[Arc<SourceSeries>]| {
            sources[0]
                .info
                .warnings
                .iter()
                .map(|note| note.code)
                .collect::<Vec<_>>()
        };
        assert!(codes(&import_one(spect(4, None, None))).contains(&"geometry.missingPosition"));
        let mut projections = spect(4, Some("4"), None);
        projections.put_str(
            Tag(0x0008, 0x0008),
            VR::CS,
            "ORIGINAL\\PRIMARY\\TOMO\\EMISSION",
        );
        assert!(codes(&import_one(projections)).is_empty());
    }

    /// A whole-body file: two detectors facing each other, the anterior one named in SNOMED CT and the posterior one
    /// in SNOMED RT, through one energy window.
    fn whole_body(detector_vector: &[u16], pointers: &[Tag]) -> InMemDicomObject {
        let mut obj = nm("ORIGINAL\\PRIMARY\\WHOLE BODY\\EMISSION", 2, pointers);
        obj.put(us(Tag(0x0054, 0x0021), &[2]));
        obj.put(sequence(
            DETECTORS,
            vec![
                detector(Some("399321004"), None, "1\\0\\0\\0\\0\\-1"),
                detector(Some("G-5216"), None, "-1\\0\\0\\0\\0\\-1"),
            ],
        ));
        obj.put(us(DETECTOR_VECTOR, detector_vector));
        obj.put(us(ENERGY_WINDOW_VECTOR, &[1, 1]));
        obj.put(sequence(
            ENERGY_WINDOWS,
            vec![InMemDicomObject::from_element_iter([DataElement::new(
                Tag(0x0054, 0x0018),
                VR::SH,
                "TC99M",
            )])],
        ));
        obj
    }
    fn labels(source: &SourceSeries) -> Vec<Option<NmFrame>> {
        source
            .info
            .frame_metadata
            .iter()
            .map(|frame| frame.nm.clone())
            .collect()
    }
    fn label(view: Option<&'static str>, detector: Option<u16>) -> Option<NmFrame> {
        Some(NmFrame {
            view,
            detector,
            ..NmFrame::default()
        })
    }

    #[test]
    fn whole_body_frames_name_their_detector_and_view_and_stay_one_series() {
        let sources = import_one(whole_body(
            &[1, 2],
            &[ENERGY_WINDOW_VECTOR, DETECTOR_VECTOR],
        ));
        assert_eq!(sources.len(), 1, "both views are one series");
        assert_eq!(sources[0].info.dimensions[2], 2);
        assert!(!sources[0].info.can_reconstruct && !sources[0].info.orientation_known);
        assert_eq!(
            labels(&sources[0]),
            [label(Some("ANT"), Some(1)), label(Some("POST"), Some(2))]
        );
        assert_eq!(sources[0].info.value_unit, "a.u.");
        assert!(
            sources[0].info.warnings.is_empty(),
            "planar frames have no place in the patient by nature: {:?}",
            sources[0].info.warnings
        );
        // The engine's JSON, as the interface reads it.
        let json = serde_json::to_value(&sources[0].info.frame_metadata[1]).unwrap();
        assert_eq!(
            json["nm"],
            serde_json::json!({ "view": "POST", "detector": 2 })
        );
    }

    #[test]
    fn frame_vectors_count_only_when_named_and_one_value_a_frame() {
        let short = import_one(whole_body(&[1], &[ENERGY_WINDOW_VECTOR, DETECTOR_VECTOR]));
        assert_eq!(
            labels(&short[0]),
            [None, None],
            "a Detector Vector one value short"
        );
        let unnamed = import_one(whole_body(&[1, 2], &[ENERGY_WINDOW_VECTOR]));
        assert_eq!(
            labels(&unnamed[0]),
            [None, None],
            "a Detector Vector the pointer does not name"
        );
        let zero = import_one(whole_body(
            &[0, 2],
            &[ENERGY_WINDOW_VECTOR, DETECTOR_VECTOR],
        ));
        assert_eq!(
            labels(&zero[0]),
            [None, None],
            "detector numbers start at 1"
        );
    }

    #[test]
    fn a_detector_without_a_known_view_is_named_by_its_number() {
        let mut obj = whole_body(&[1, 2], &[ENERGY_WINDOW_VECTOR, DETECTOR_VECTOR]);
        // Medial-lateral (CID 26) has no NM abbreviation, and the second detector names no view.
        obj.put(sequence(
            DETECTORS,
            vec![
                detector(Some("399012007"), None, "1\\0\\0\\0\\0\\-1"),
                detector(None, None, "-1\\0\\0\\0\\0\\-1"),
            ],
        ));
        assert_eq!(
            labels(&import_one(obj)[0]),
            [label(None, Some(1)), label(None, Some(2))]
        );
        // One detector, no Detector Vector: every frame is its view.
        let mut single = nm(
            "ORIGINAL\\PRIMARY\\STATIC\\EMISSION",
            1,
            &[ENERGY_WINDOW_VECTOR],
        );
        single.put(sequence(
            DETECTORS,
            vec![detector(Some("399001007"), None, "1\\0\\0\\0\\0\\-1")],
        ));
        single.put(us(ENERGY_WINDOW_VECTOR, &[1]));
        assert_eq!(labels(&import_one(single)[0]), [label(Some("POST"), None)]);
    }

    #[test]
    fn energy_windows_and_phases_name_frames_only_where_there_are_several() {
        let mut obj = nm(
            "ORIGINAL\\PRIMARY\\DYNAMIC\\EMISSION",
            4,
            &[ENERGY_WINDOW_VECTOR, DETECTOR_VECTOR, PHASE_VECTOR],
        );
        obj.put(us(ENERGY_WINDOW_VECTOR, &[1, 2, 1, 2]));
        obj.put(us(DETECTOR_VECTOR, &[1, 1, 1, 1]));
        obj.put(us(PHASE_VECTOR, &[1, 1, 2, 2]));
        obj.put(sequence(
            DETECTORS,
            vec![detector(Some("G-5216"), None, "1\\0\\0\\0\\0\\-1")],
        ));
        obj.put(sequence(
            ENERGY_WINDOWS,
            vec![
                InMemDicomObject::from_element_iter([DataElement::new(
                    Tag(0x0054, 0x0018),
                    VR::SH,
                    "EM1",
                )]),
                InMemDicomObject::from_element_iter([sequence(
                    Tag(0x0054, 0x0013),
                    vec![InMemDicomObject::from_element_iter([
                        ds(Tag(0x0054, 0x0014), "126"),
                        ds(Tag(0x0054, 0x0015), "154.5"),
                    ])],
                )]),
            ],
        ));
        let frame = |energy_window: &str, phase| {
            Some(NmFrame {
                view: Some("POST"),
                detector: None,
                energy_window: energy_window.into(),
                phase: Some(phase),
            })
        };
        assert_eq!(
            labels(&import_one(obj)[0]),
            [
                frame("EM1", 1),
                frame("126–154.5 keV", 1),
                frame("EM1", 2),
                frame("126–154.5 keV", 2)
            ]
        );
    }

    #[test]
    fn invalid_named_slice_vector_must_not_produce_fusible_geometry() {
        let sources = import_one(spect(4, Some("4"), Some(&[3, 1, 0, 2])));
        assert!(
            !import_one(spect(4, Some("4"), Some(&[2, 3, 4, 5])))[0]
                .info
                .can_reconstruct
        );
        assert!(
            !sources[0].info.can_reconstruct,
            "invalid slice vector produced fusible geometry"
        );
    }
    #[test]
    fn distinct_activity_ranges_apply_the_right_slope() {
        let mut mapped = spect(4, Some("4"), None);
        let mapping = |first: u16, last: u16, slope: f64| {
            InMemDicomObject::from_element_iter([
                sequence(Tag(0x0040, 0x08ea), vec![code("Bq/mL", "UCUM")]),
                us(Tag(0x0040, 0x9216), &[first]),
                us(Tag(0x0040, 0x9211), &[last]),
                DataElement::new(
                    Tag(0x0040, 0x9225),
                    VR::FD,
                    PrimitiveValue::F64(vec![slope].into()),
                ),
                DataElement::new(
                    Tag(0x0040, 0x9224),
                    VR::FD,
                    PrimitiveValue::F64(vec![0.].into()),
                ),
            ])
        };
        mapped.put(sequence(
            Tag(0x0040, 0x9096),
            vec![mapping(1, 2, 2.), mapping(3, 3, 10.)],
        ));
        let (sources, _keep) = import_kept(mapped);
        assert!(
            crate::decode::decode_frame(&sources[0], 3)
                .unwrap()
                .value(0)
                .is_nan()
        );
        let decoded = crate::decode::decode_frame(&sources[0], 2).unwrap();
        assert_eq!(decoded.value(0), 30.);
    }
    #[test]
    fn a_private_projection_code_has_no_anatomical_view() {
        let mut det = detector(None, None, "1\\\\0\\\\0\\\\0\\\\1\\\\0");
        det.put(sequence(
            Tag(0x0054, 0x0220),
            vec![code("399321004", "99LOCAL")],
        ));
        assert_eq!(view(&det), None);
    }

    #[test]
    fn a_quantitative_spect_reads_in_bq_per_ml_and_never_in_suv() {
        // Everything a PET would take SUV from: Units, weight, dose (in MBq, as NM records it), decay correction.
        let pet_like = |obj: &mut InMemDicomObject| {
            obj.put(DataElement::new(Tag(0x0054, 0x1001), VR::CS, "BQML"));
            obj.put(DataElement::new(Tag(0x0054, 0x1102), VR::CS, "ADMIN"));
            obj.put(ds(Tag(0x0010, 0x1030), "70"));
            obj.put(sequence(
                Tag(0x0054, 0x0016),
                vec![InMemDicomObject::from_element_iter([
                    ds(Tag(0x0018, 0x1074), "740"),
                    ds(Tag(0x0018, 0x1075), "21624"),
                    DataElement::new(Tag(0x0018, 0x1072), VR::TM, "080000"),
                ])],
            ));
        };
        let mut mapped = spect(4, Some("4"), None);
        let mut unit = code("Bq/ml", "UCUM");
        unit.put(DataElement::new(
            Tag(0x0008, 0x0104),
            VR::LO,
            "Becquerels/milliliter",
        ));
        mapped.put(sequence(
            Tag(0x0040, 0x9096),
            vec![InMemDicomObject::from_element_iter([
                sequence(Tag(0x0040, 0x08ea), vec![unit]),
                us(Tag(0x0040, 0x9216), &[0]),
                us(Tag(0x0040, 0x9211), &[65535]),
                DataElement::new(
                    Tag(0x0040, 0x9225),
                    VR::FD,
                    PrimitiveValue::F64(vec![0.5].into()),
                ),
                DataElement::new(
                    Tag(0x0040, 0x9224),
                    VR::FD,
                    PrimitiveValue::F64(vec![0.].into()),
                ),
            ])],
        ));
        pet_like(&mut mapped);
        let (sources, _kept) = import_kept(mapped);
        let info = &sources[0].info;
        assert_eq!(
            (info.value_unit.as_str(), info.suv_factor, info.sul_factor),
            ("Bq/ml", None, None)
        );
        assert!(info.can_reconstruct);
        let decoded = crate::decode::decode_frame(&sources[0], 0).unwrap();
        assert_eq!(
            decoded.value(0),
            0.5,
            "the first slice's stored 1, in Bq/ml"
        );

        let mut rescaled = spect(4, Some("4"), None);
        pet_like(&mut rescaled);
        rescaled.put(ds(Tag(0x0028, 0x1053), "2"));
        let sources = import_one(rescaled);
        assert_eq!(
            (
                sources[0].info.value_unit.as_str(),
                sources[0].info.suv_factor,
                sources[0].frames[0].slope
            ),
            ("Bq/ml", None, 2.)
        );

        let counts = import_one(spect(4, Some("4"), None));
        assert_eq!(counts[0].info.value_unit, "a.u.", "counts stay unnamed");
    }

    /// A gated SPECT of `windows` R-R windows of `slots` gates of `slices` slices, its frames ordered by window, gate
    /// and slice as Table C.8-8 orders them, the slices of each gate stored in `order`; frame f holds f + 1. Its
    /// detector item puts the first frame's slice at z = 50, facing like an axial CT.
    fn gated(
        slices: u16,
        slots: u16,
        windows: u16,
        spacing: &str,
        order: &[u16],
    ) -> InMemDicomObject {
        let frames = usize::from(slices * slots * windows);
        let mut obj = nm(
            "ORIGINAL\\PRIMARY\\RECON GATED TOMO\\EMISSION",
            frames,
            &[RR_INTERVAL_VECTOR, TIME_SLOT_VECTOR, SLICE_VECTOR],
        );
        obj.put(sequence(
            DETECTORS,
            vec![detector(None, Some("-2\\-2\\50"), "1\\0\\0\\0\\1\\0")],
        ));
        obj.put(ds(Tag(0x0018, 0x0088), spacing));
        let (mut intervals, mut time_slots, mut slice_numbers) = (vec![], vec![], vec![]);
        for window in 1..=windows {
            for slot in 1..=slots {
                for &slice in order {
                    intervals.push(window);
                    time_slots.push(slot);
                    slice_numbers.push(slice);
                }
            }
        }
        obj.put(us(RR_INTERVAL_VECTOR, &intervals));
        obj.put(us(RR_INTERVALS, &[windows]));
        obj.put(us(TIME_SLOT_VECTOR, &time_slots));
        obj.put(us(TIME_SLOTS, &[slots]));
        obj.put(us(SLICE_VECTOR, &slice_numbers));
        obj.put(us(SLICES, &[slices]));
        obj
    }
    /// The NM Multi-gated Acquisition Module: for each R-R window the beat lengths it accepted (ms) and, where given,
    /// each of its gates' Time Slot Time (ms).
    fn gating(windows: &[([u32; 2], Option<&[u32]>)]) -> DataElement<InMemDicomObject> {
        sequence(
            GATED_INFORMATION,
            windows
                .iter()
                .map(|([low, high], times)| {
                    let mut data = InMemDicomObject::from_element_iter([
                        ds(Tag(0x0018, 0x1063), "100"),
                        ds(Tag(0x0018, 0x1081), &low.to_string()),
                        ds(Tag(0x0018, 0x1082), &high.to_string()),
                    ]);
                    if let Some(times) = times {
                        data.put(sequence(
                            TIME_SLOT_INFORMATION,
                            times
                                .iter()
                                .map(|time| {
                                    InMemDicomObject::from_element_iter([ds(
                                        TIME_SLOT_TIME,
                                        &time.to_string(),
                                    )])
                                })
                                .collect(),
                        ));
                    }
                    InMemDicomObject::from_element_iter([sequence(DATA_INFORMATION, vec![data])])
                })
                .collect(),
        )
    }
    fn phases(sources: &[Arc<SourceSeries>]) -> Vec<(String, f64, String)> {
        sources
            .iter()
            .map(|source| {
                let phase = source.info.phase.as_ref().expect("each gate is a phase");
                (phase.kind.clone(), phase.order, phase.label.clone())
            })
            .collect()
    }
    /// The frames of the file each series holds, in its slice order.
    fn file_frames(source: &SourceSeries) -> Vec<u32> {
        source.frames.iter().map(|frame| frame.index).collect()
    }

    #[test]
    fn a_gated_spect_opens_as_one_placed_volume_per_gate_in_gate_order() {
        for slots in [8u16, 16] {
            let mut obj = gated(4, slots, 1, "4", &[1, 2, 3, 4]);
            let times: Vec<u32> = (0..u32::from(slots))
                .map(|slot| 120_000 - slot * 1_000)
                .collect();
            obj.put(gating(&[([640, 960], Some(&times))]));
            let sources = import_one(obj);
            assert_eq!(sources.len(), usize::from(slots), "{slots} gates");
            let expected: Vec<_> = (1..=slots)
                .map(|slot| {
                    let seconds = 120. - f64::from(slot - 1);
                    (
                        "timeSlot".to_string(),
                        f64::from(slot),
                        format!("Gate {slot}/{slots} · {seconds} s acquired"),
                    )
                })
                .collect();
            assert_eq!(phases(&sources), expected, "listed in gate order");
            for (gate, source) in sources.iter().enumerate() {
                let info = &source.info;
                assert!(
                    info.can_reconstruct,
                    "gate {}: {:?}",
                    gate + 1,
                    info.warnings
                );
                assert!(info.orientation_known && info.spacing_known);
                assert_eq!(info.dimensions, [2, 2, 4]);
                assert_eq!((info.origin, info.spacing), ([-2., -2., 50.], [4., 4., 4.]));
                let first = gate as u32 * 4;
                assert_eq!(
                    file_frames(source),
                    [first, first + 1, first + 2, first + 3]
                );
                assert!(info.warnings.is_empty(), "{:?}", info.warnings);
            }
            // The interface reads the gate itself, to name it in Turkish too.
            let json = serde_json::to_value(&sources[2].info).unwrap();
            assert_eq!(
                json["phase"]["gate"],
                serde_json::json!({ "slot": 3, "slots": slots, "slotTime": 118000. })
            );
            // Every gate of a series has its own id.
            let ids: std::collections::HashSet<_> = sources
                .iter()
                .map(|source| source.info.id.clone())
                .collect();
            assert_eq!(ids.len(), usize::from(slots));
        }
    }

    #[test]
    fn gated_slices_follow_the_normal_by_the_sign_of_their_spacing_and_their_slice_vector() {
        for (spacing, order, heights) in [
            ("4", [1, 2, 3, 4], [(0, 50.), (1, 54.), (2, 58.), (3, 62.)]),
            ("-4", [1, 2, 3, 4], [(0, 50.), (1, 46.), (2, 42.), (3, 38.)]),
            // Stored out of order in every gate, the first frame's slice at z = 50.
            ("5", [3, 1, 4, 2], [(0, 50.), (1, 40.), (2, 55.), (3, 45.)]),
        ] {
            let sources = import_one(gated(4, 8, 1, spacing, &order));
            assert_eq!(sources.len(), 8);
            for (gate, source) in sources.iter().enumerate() {
                assert!(source.info.can_reconstruct, "spacing {spacing}");
                let first = gate as u32 * 4;
                let found: Vec<_> = frame_heights(source)
                    .into_iter()
                    .map(|(index, z)| (index - first, z))
                    .collect();
                assert_eq!(found, heights, "spacing {spacing}, gate {}", gate + 1);
            }
        }
    }

    #[test]
    fn several_r_r_windows_are_each_a_cycle_of_gates_named_by_the_beats_they_took() {
        // Normal beats (640–960 ms) and ectopic ones (300–640 ms), four gates each, as Table C.8-8 orders them.
        let mut obj = gated(2, 4, 2, "4", &[1, 2]);
        obj.put(gating(&[
            ([640, 960], Some(&[60_000, 60_000, 59_000, 55_000])),
            ([300, 640], Some(&[4_000, 4_000, 2_500, 1_250])),
        ]));
        let sources = import_one(obj);
        assert_eq!(sources.len(), 8);
        let labels: Vec<_> = phases(&sources)
            .into_iter()
            .map(|(_, order, label)| (order, label))
            .collect();
        assert_eq!(
            labels,
            [
                (1., "R-R 1 (640–960 ms) · Gate 1/4 · 60 s acquired"),
                (2., "R-R 1 (640–960 ms) · Gate 2/4 · 60 s acquired"),
                (3., "R-R 1 (640–960 ms) · Gate 3/4 · 59 s acquired"),
                (4., "R-R 1 (640–960 ms) · Gate 4/4 · 55 s acquired"),
                (5., "R-R 2 (300–640 ms) · Gate 1/4 · 4 s acquired"),
                (6., "R-R 2 (300–640 ms) · Gate 2/4 · 4 s acquired"),
                (7., "R-R 2 (300–640 ms) · Gate 3/4 · 2.5 s acquired"),
                (8., "R-R 2 (300–640 ms) · Gate 4/4 · 1.25 s acquired"),
            ]
            .map(|(order, label)| (order, label.to_string()))
        );
        // Each gate holds its own window's frames, not the same time slot of the other window.
        assert_eq!(
            sources
                .iter()
                .map(|source| file_frames(source))
                .collect::<Vec<_>>(),
            (0..8u32)
                .map(|gate| vec![gate * 2, gate * 2 + 1])
                .collect::<Vec<_>>()
        );
        let json = serde_json::to_value(&sources[6].info.phase).unwrap();
        assert_eq!(
            json["gate"],
            serde_json::json!({ "slot": 3, "slots": 4, "interval": 2, "intervals": 2, "beats": [300., 640.], "slotTime": 2500. })
        );
        // Without the beat lengths, the window is named by its number.
        let mut bare = gated(2, 4, 2, "4", &[1, 2]);
        bare.put(us(RR_INTERVALS, &[2]));
        let labels: Vec<_> = phases(&import_one(bare))
            .into_iter()
            .map(|(_, _, label)| label)
            .collect();
        assert_eq!(labels[..2], ["R-R 1 · Gate 1/4", "R-R 1 · Gate 2/4"]);
        assert_eq!(labels[4], "R-R 2 · Gate 1/4");
    }

    #[test]
    fn gates_without_their_time_slot_times_are_named_by_number_only() {
        let without = import_one(gated(2, 8, 1, "4", &[1, 2]));
        let mut short = gated(2, 8, 1, "4", &[1, 2]);
        // Seven times for eight gates: none of them is known to belong to a gate.
        short.put(gating(&[([640, 960], Some(&[1, 2, 3, 4, 5, 6, 7]))]));
        let mut no_items = gated(2, 8, 1, "4", &[1, 2]);
        no_items.put(gating(&[([640, 960], None)]));
        for sources in [without, import_one(short), import_one(no_items)] {
            assert_eq!(sources.len(), 8);
            let labels: Vec<_> = phases(&sources)
                .into_iter()
                .map(|(_, _, label)| label)
                .collect();
            assert_eq!(
                labels,
                (1..=8)
                    .map(|slot| format!("Gate {slot}/8"))
                    .collect::<Vec<_>>()
            );
            assert!(sources.iter().all(|source| {
                source
                    .info
                    .phase
                    .as_ref()
                    .unwrap()
                    .gate
                    .unwrap()
                    .slot_time
                    .is_none()
            }));
            assert!(sources.iter().all(|source| source.info.can_reconstruct));
        }
        // The R-R Interval Vector may be left out where the file has one window.
        let mut single = gated(2, 8, 1, "4", &[1, 2]);
        single.put(DataElement::new(
            Tag(0x0028, 0x0009),
            VR::AT,
            PrimitiveValue::Tags(vec![TIME_SLOT_VECTOR, SLICE_VECTOR].into()),
        ));
        single.remove_element(RR_INTERVAL_VECTOR);
        assert_eq!(import_one(single).len(), 8);
    }

    #[test]
    fn the_gates_of_two_gated_files_in_one_series_stay_apart() {
        // An 8-gate and a 4-gate acquisition in one series, the second's slices just above the first's: gate 2 of one
        // is not gate 2 of the other, nor a volume with it.
        let eight = gated(4, 8, 1, "4", &[1, 2, 3, 4]);
        let mut four = gated(4, 4, 1, "4", &[1, 2, 3, 4]);
        four.put(DataElement::new(Tag(0x0008, 0x0018), VR::UI, "1.2.3.4.6"));
        four.put(sequence(
            DETECTORS,
            vec![detector(None, Some("-2\\-2\\66"), "1\\0\\0\\0\\1\\0")],
        ));
        let (sources, _dir) = import_files(vec![eight, four]);
        let mut gates: Vec<_> = sources
            .iter()
            .map(|source| {
                let info = &source.info;
                let phase = info.phase.as_ref().expect("each series is a gate");
                let gate = phase.gate.expect("each series is a gate");
                assert!(info.can_reconstruct, "{:?}", info.warnings);
                assert_eq!(info.dimensions[2], 4, "{}: one file's slices", phase.label);
                assert_eq!(
                    phase.order,
                    f64::from(gate.slot),
                    "numbered within its file"
                );
                (gate.slots, gate.slot, info.origin[2], phase.label.clone())
            })
            .collect();
        gates.sort_by(|a, b| (b.0, a.1).cmp(&(a.0, b.1)));
        let expected: Vec<_> = (1..=8u16)
            .map(|slot| (8, slot, 50., format!("Gate {slot}/8")))
            .chain((1..=4).map(|slot| (4, slot, 66., format!("Gate {slot}/4"))))
            .collect();
        assert_eq!(gates, expected);
    }

    #[test]
    fn gate_counts_the_frames_cannot_hold_make_no_gates() {
        // 192 frames declaring 1536 R-R windows of 1536 time slots. Every frame's window and time slot lie within those
        // counts, but they would make 2.4 million gates, so none is made: the counts are what the file says, the frames
        // what it holds.
        let order: Vec<u16> = (1..=24).collect();
        let mut obj = gated(24, 8, 1, "4", &order);
        obj.put(us(RR_INTERVALS, &[1536]));
        obj.put(us(TIME_SLOTS, &[1536]));
        assert!(read_gates(&obj, &pointers(&obj), 192).is_none());
        let sources = import_one(obj);
        assert_eq!(sources.len(), 1);
        assert!(!sources[0].info.can_reconstruct && sources[0].info.phase.is_none());
    }

    #[test]
    fn a_gated_spect_that_does_not_add_up_stays_one_unplaced_stack() {
        let unplaced = |obj: InMemDicomObject, why: &str| {
            let sources = import_one(obj);
            assert_eq!(sources.len(), 1, "{why}");
            let info = &sources[0].info;
            assert!(!info.can_reconstruct && info.phase.is_none(), "{why}");
            assert_eq!(
                file_frames(&sources[0]),
                (0..info.dimensions[2] as u32).collect::<Vec<_>>(),
                "{why}"
            );
        };
        // Two windows said, no R-R Interval Vector to tell their frames apart.
        let mut windows = gated(2, 4, 2, "4", &[1, 2]);
        windows.put(DataElement::new(
            Tag(0x0028, 0x0009),
            VR::AT,
            PrimitiveValue::Tags(vec![TIME_SLOT_VECTOR, SLICE_VECTOR].into()),
        ));
        unplaced(windows, "two windows without their vector");
        // One window said, but the R-R Interval Vector puts frames in windows 0 and 2: a vector the file holds is read,
        // never passed over for the one window a file without it has.
        let mut stray = gated(2, 8, 1, "4", &[1, 2]);
        let mut numbers = [1u16; 16];
        numbers[..3].copy_from_slice(&[0, 1, 2]);
        stray.put(us(RR_INTERVAL_VECTOR, &numbers));
        unplaced(stray, "an R-R Interval Vector outside its one window");
        let mut missing = gated(2, 8, 1, "4", &[1, 2]);
        missing.remove_element(RR_INTERVAL_VECTOR);
        unplaced(missing, "the R-R Interval Vector named but missing");
        let mut unnamed = gated(2, 8, 1, "4", &[1, 2]);
        unnamed.put(DataElement::new(
            Tag(0x0028, 0x0009),
            VR::AT,
            PrimitiveValue::Tags(vec![TIME_SLOT_VECTOR, SLICE_VECTOR].into()),
        ));
        unnamed.put(us(RR_INTERVAL_VECTOR, &numbers));
        unplaced(
            unnamed,
            "an R-R Interval Vector held, not named, outside its window",
        );
        let mut slots = gated(2, 4, 1, "4", &[1, 2]);
        slots.put(us(TIME_SLOTS, &[3]));
        unplaced(slots, "a time slot past the Number of Time Slots");
        let mut slices = gated(2, 4, 1, "4", &[1, 2]);
        slices.put(us(SLICES, &[4]));
        unplaced(
            slices,
            "slices × time slots × windows is not the frame count",
        );
        unplaced(gated(2, 4, 1, "4", &[1, 1]), "a slice twice in one gate");
        let mut no_time_slots = gated(2, 4, 1, "4", &[1, 2]);
        no_time_slots.remove_element(TIME_SLOT_VECTOR);
        unplaced(no_time_slots, "no Time Slot Vector");
        unplaced(gated(2, 4, 1, "0", &[1, 2]), "no spacing between slices");
    }

    #[test]
    fn one_time_slot_is_one_volume_without_a_gate_named() {
        let sources = import_one(gated(4, 1, 1, "4", &[1, 2, 3, 4]));
        assert_eq!(sources.len(), 1);
        assert!(sources[0].info.can_reconstruct);
        assert!(sources[0].info.phase.is_none());
    }

    #[test]
    fn the_gates_of_one_gated_spect_share_one_window() {
        // Frames hold their number + 1: the middle frame of gate 1 holds 1, of gate 2 holds 3.
        let sources = import_one(gated(2, 2, 1, "4", &[1, 2]));
        assert_eq!(sources.len(), 2);
        for source in &sources {
            let info = &source.info;
            assert!(info.window_from_pixels);
            assert_eq!(
                (info.window_center, info.window_width),
                (2., 3.),
                "from 0.5 to 3.5, both gates' own windows"
            );
        }
        // A summed SPECT keeps its own: its middle frame holds 2.
        let summed = import_one(spect(4, Some("4"), None));
        assert_eq!(
            (summed[0].info.window_center, summed[0].info.window_width),
            (2., 1.)
        );
    }

    #[test]
    fn ungated_and_planar_gated_files_are_as_before() {
        // The summed reconstruction: one volume, no phase.
        let summed = import_one(spect(4, Some("4"), None));
        assert_eq!(summed.len(), 1);
        assert!(summed[0].info.can_reconstruct && summed[0].info.phase.is_none());
        // A gated planar acquisition (MUGA): one stack of its frames in the file's order, no gate a phase, no place in
        // the patient and no geometry warning.
        for image_type in [
            "ORIGINAL\\PRIMARY\\GATED\\EMISSION",
            "ORIGINAL\\PRIMARY\\GATED TOMO\\EMISSION",
        ] {
            let mut muga = nm(
                image_type,
                8,
                &[
                    ENERGY_WINDOW_VECTOR,
                    DETECTOR_VECTOR,
                    RR_INTERVAL_VECTOR,
                    TIME_SLOT_VECTOR,
                ],
            );
            muga.put(us(ENERGY_WINDOW_VECTOR, &[1; 8]));
            muga.put(us(DETECTOR_VECTOR, &[1; 8]));
            muga.put(us(RR_INTERVAL_VECTOR, &[1; 8]));
            muga.put(us(RR_INTERVALS, &[1]));
            muga.put(us(TIME_SLOT_VECTOR, &[1, 2, 3, 4, 5, 6, 7, 8]));
            muga.put(us(TIME_SLOTS, &[8]));
            muga.put(sequence(
                DETECTORS,
                vec![detector(Some("399074003"), None, "1\\0\\0\\0\\0\\-1")],
            ));
            muga.put(gating(&[([640, 960], Some(&[9_000; 8]))]));
            let sources = import_one(muga);
            assert_eq!(sources.len(), 1, "{image_type}");
            let info = &sources[0].info;
            assert!(info.phase.is_none() && !info.can_reconstruct && !info.orientation_known);
            assert_eq!(file_frames(&sources[0]), (0..8).collect::<Vec<_>>());
            assert!(info.warnings.is_empty(), "{:?}", info.warnings);
            assert_eq!(labels(&sources[0]), vec![label(Some("LAO"), None); 8]);
        }
    }
}
