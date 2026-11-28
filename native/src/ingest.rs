use crate::archive_temp::ArchiveTempDir;
use crate::source_file::SourceFile;
use crate::vfs::{self as fs, File};
use crate::{
    geometry::{self, FrameGeometry},
    model::{
        AcquisitionMetadata, Frame, FrameMetadata, Gate, PetAcquisition, PhaseHints, PhaseIdentity,
        Segment, Segmentation, Series, SourceSeries,
    },
};
use anyhow::{Context, Result, bail, ensure};
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use dicom_core::{PrimitiveValue, Tag};
use dicom_object::{InMemDicomObject, OpenFileOptions};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

pub const MAX_FILES: usize = 50_000;
/// Extracted archive entries are held in memory in WebAssembly, where everything shares 4 GB: 1 GiB in all and
/// 512 MiB per entry there, so a ZIP bomb stops long before memory runs out.
const MAX_ARCHIVE_BYTES: u64 = if cfg!(target_arch = "wasm32") {
    1024 * 1024 * 1024
} else {
    8 * 1024 * 1024 * 1024
};
const MAX_ARCHIVE_FILE_BYTES: u64 = if cfg!(target_arch = "wasm32") {
    512 * 1024 * 1024
} else {
    2 * 1024 * 1024 * 1024
};
/// The threads that read an import's files (crate::parallel names them dicom-index-1…).
fn index_readers() -> usize {
    crate::parallel::available(2).min(8)
}

/// An archive's file this large has the room looked at before it is written (see extract_zip_into).
#[cfg(windows)]
const LARGE_ZIP_ENTRY: u64 = 64 * 1024 * 1024;
/// The room the discs' private copies have to leave free on this computer.
const SPARE_BYTES: u64 = 1 << 30;

/// The disc `plan_spool` plans the reading of, and the copies earlier imports of this session made (see `DiscCopy`).
#[derive(Clone, Copy)]
struct DiscToRead<'a> {
    disc: Disc,
    earlier: &'a [DiscCopy],
}

/// A disc that an import can read once into a private copy (see `plan_spool`), as this computer reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Disc {
    /// The bytes it holds: the most its copies may take.
    pub size: u64,
    /// Its volume's serial number, which another disc put in its drive does not share. None for a folder that a test
    /// reads as a disc: no drive is asked about it then, neither for the room left nor for the disc in it.
    pub serial: Option<u32>,
}

/// The disc `path` is on, when it can be read once: one no larger than an archive may be, whose serial number is
/// known. None for anything else, which is read where it is.
#[cfg(windows)]
fn read_once(path: &Path) -> Option<Disc> {
    let size = crate::disc::size(path).filter(|&size| size <= MAX_ARCHIVE_BYTES)?;
    let serial = crate::disc::serial(path)?;
    Some(Disc {
        size,
        serial: Some(serial),
    })
}
/// Only Windows tells a disc from another volume (disc.rs).
#[cfg(not(windows))]
fn read_once(_: &Path) -> Option<Disc> {
    None
}

/// The bytes this computer's temporary folder can still take; None where nothing says (away from Windows, where no
/// disc is read once).
#[cfg(windows)]
fn room() -> Option<u64> {
    crate::disc::free(&std::env::temp_dir())
}
#[cfg(not(windows))]
fn room() -> Option<u64> {
    None
}

/// The serial number of the volume `path` is on (see `Disc::serial`).
#[cfg(windows)]
fn volume_serial(path: &Path) -> Option<u32> {
    crate::disc::serial(path)
}
#[cfg(not(windows))]
fn volume_serial(_: &Path) -> Option<u32> {
    None
}

/// How often a disc being read is found again in its drive: in less time, no disc can be taken out of it and another
/// put in its place.
const DISC_LOOK_EVERY: std::time::Duration = std::time::Duration::from_secs(1);
/// How long a drive that gives a disc's files but not its serial number is asked again for the number.
const DISC_NAMED_WITHIN: std::time::Duration = std::time::Duration::from_secs(3);

/// Whether the disc `folder` is on is the one whose serial number is `serial`, as `lookup` names it. A lookup that
/// fails names no disc: while the folder is there, `lookup` is asked again until `within` has passed, and a folder
/// that is not there is on no disc. A disc not named is not the one.
fn disc_named(
    serial: u32,
    folder: &Path,
    lookup: fn(&Path) -> Option<u32>,
    within: std::time::Duration,
) -> bool {
    let until = std::time::Instant::now() + within;
    loop {
        if let Some(now) = lookup(folder) {
            return now == serial;
        }
        if !fs::exists(folder) || std::time::Instant::now() >= until {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Which of an import's selections are read once, given the disc each is on (see `read_once`) and the room this
/// computer's temporary folder has. A disc selected more than once is read where it is, as any folder is, so that no
/// file of it is copied twice. The discs read once leave the room SPARE_BYTES to spare between them; a disc there is
/// no room for is read where it is too.
fn discs_read_once(on_disc: &[Option<Disc>], room: Option<u64>) -> Vec<Option<Disc>> {
    let mut selected: HashMap<u32, usize> = HashMap::new();
    for serial in on_disc.iter().flatten().filter_map(|disc| disc.serial) {
        *selected.entry(serial).or_default() += 1;
    }
    let mut copied = 0u64;
    let mut fits = |disc: &Disc| {
        let Some(serial) = disc.serial else {
            return true;
        };
        let needed = copied.saturating_add(disc.size).saturating_add(SPARE_BYTES);
        if selected[&serial] > 1 || room.is_none_or(|room| room < needed) {
            return false;
        }
        copied += disc.size;
        true
    };
    on_disc
        .iter()
        .map(|disc| disc.filter(|disc| fits(disc)))
        .collect()
}

/// For each Series Instance UID of a plan, whether every file its discs' indexes list under it was read whole: each
/// one finished with (read, or failing on its own; see `finish`), none left unread because its disc was taken out.
fn whole_series(plan: &Plan) -> HashMap<&str, bool> {
    let mut whole: HashMap<&str, bool> = HashMap::new();
    for (series, finished) in plan.series.iter().zip(&plan.finished) {
        let done = finished.load(std::sync::atomic::Ordering::Acquire) >= series.files;
        *whole.entry(series.uid.as_str()).or_insert(true) &= done;
    }
    whole
}

/// What stops an import whose disc was taken out of its drive, or replaced, before it was read whole.
fn disc_removed() -> anyhow::Error {
    anyhow::anyhow!(coded!(
        "import.discRemoved",
        "The disc was removed before all of it was read."
    ))
}

fn zip_no_room() -> anyhow::Error {
    anyhow::anyhow!(coded!(
        "zip.noRoom",
        "This computer's disk does not have room for this ZIP's files."
    ))
}

pub struct Imported {
    pub sources: Vec<Arc<SourceSeries>>,
    pub archives: Vec<ArchiveTempDir>,
    pub warnings: Vec<crate::message::Note>,
    /// The copies this import made of the discs it read once, which a later import of the same disc can take its
    /// files from while they are kept (see `DiscCopy`).
    pub discs: Vec<DiscCopy>,
}

/// A disc's copy that an import made in its folder (one of `Imported::archives`), and the disc it is of. A later import
/// that opens the same disc at the same folder, with the same index, reads the files copied here, as they are and
/// where they are, instead of reading them from the disc again: each one the disc still holds at the same length. A
/// disc taken out half read and put back is read on from where it stopped, and one opened again at once. The copies
/// go together, when the viewer's list is emptied (main.rs), so an earlier one outlives the series read from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscCopy {
    pub disc: Disc,
    /// The folder that was opened on it.
    pub folder: PathBuf,
    /// The SHA-256 of its index (DICOMDIR), where it has one.
    pub index: Option<[u8; 32]>,
    /// Where its files were copied to.
    pub copy: PathBuf,
}

pub fn text(obj: &InMemDicomObject, tag: Tag) -> String {
    obj.get(tag)
        .and_then(|e| e.to_str().ok())
        .map(|s| s.trim_end_matches(['\0', ' ']).to_owned())
        .unwrap_or_default()
}
pub fn number(obj: &InMemDicomObject, tag: Tag) -> Option<f64> {
    obj.get(tag)?.to_float64().ok().filter(|n| n.is_finite())
}
pub(crate) fn numbers<const N: usize>(obj: &InMemDicomObject, tag: Tag) -> Option<[f64; N]> {
    let v = obj.get(tag)?.to_multi_float64().ok()?;
    if v.len() != N || v.iter().any(|n| !n.is_finite()) {
        return None;
    }
    v.try_into().ok()
}
pub(crate) fn first(obj: &InMemDicomObject, sequence: Tag) -> Option<&InMemDicomObject> {
    obj.get(sequence)?.items()?.first()
}

fn frame_group(obj: &InMemDicomObject, frame: usize, shared: bool) -> Option<&InMemDicomObject> {
    obj.get(if shared {
        Tag(0x5200, 0x9229)
    } else {
        Tag(0x5200, 0x9230)
    })?
    .items()?
    .get(if shared { 0 } else { frame })
}

pub(crate) fn frame_value<T>(
    obj: &InMemDicomObject,
    frame: usize,
    sequence: Tag,
    read: impl Fn(&InMemDicomObject) -> Option<T>,
) -> Option<T> {
    frame_group(obj, frame, false)
        .and_then(|group| first(group, sequence))
        .and_then(&read)
        .or_else(|| {
            frame_group(obj, frame, true)
                .and_then(|group| first(group, sequence))
                .and_then(&read)
        })
        .or_else(|| read(obj))
}

fn first_number(obj: &InMemDicomObject, tag: Tag) -> Option<f64> {
    obj.get(tag)?
        .to_multi_float64()
        .ok()?
        .first()
        .copied()
        .filter(|value| value.is_finite())
}

pub(crate) fn nonempty_text(obj: &InMemDicomObject, tag: Tag) -> Option<String> {
    let value = text(obj, tag);
    (!value.is_empty()).then_some(value)
}

fn contrast_usage(obj: &InMemDicomObject, frame: usize, tag: Tag) -> String {
    let read = |place: &InMemDicomObject| {
        let mut values = place
            .get(Tag(0x0018, 0x9341))?
            .items()?
            .iter()
            .filter_map(|item| nonempty_text(item, tag))
            .map(|value| value.to_ascii_uppercase())
            .collect::<Vec<_>>();
        values.sort();
        values.dedup();
        match values.len() {
            0 => None,
            1 => values.pop(),
            _ => Some("MIXED".into()),
        }
    };
    frame_group(obj, frame, false)
        .and_then(read)
        .or_else(|| frame_group(obj, frame, true).and_then(read))
        .or_else(|| read(obj))
        .unwrap_or_default()
}

// DICOM PS3.3 C.7.3.1: a paired body part can have frame, image, or series laterality.
fn laterality_code(obj: &InMemDicomObject, tag: Tag) -> Option<String> {
    nonempty_text(obj, tag).filter(|code| matches!(code.as_str(), "L" | "R" | "B" | "U"))
}

fn acquisition_metadata(obj: &InMemDicomObject, frame: usize) -> AcquisitionMetadata {
    // PS3.3 C.8.13.5.1 (MR) and C.8.15.3.1 (CT): Enhanced multi-frame SOP classes carry per-frame FrameType.
    let mut image_type = frame_value(obj, frame, Tag(0x0018, 0x9226), |v| {
        nonempty_text(v, Tag(0x0008, 0x9007))
    })
    .or_else(|| {
        frame_value(obj, frame, Tag(0x0018, 0x9329), |v| {
            nonempty_text(v, Tag(0x0008, 0x9007))
        })
    })
    .unwrap_or_else(|| text(obj, Tag(0x0008, 0x0008)));
    image_type.make_ascii_uppercase();
    let acquisition_date_time = frame_value(obj, frame, Tag(0x0020, 0x9111), |v| {
        nonempty_text(v, Tag(0x0018, 0x9074))
    })
    .unwrap_or_else(|| text(obj, Tag(0x0008, 0x002a)));
    let acquisition_time = if acquisition_date_time
        .get(..14)
        .is_some_and(|prefix| prefix.bytes().all(|b| b.is_ascii_digit()))
    {
        acquisition_date_time[8..]
            .split(['+', '-'])
            .next()
            .unwrap_or_default()
            .to_owned()
    } else {
        text(obj, Tag(0x0008, 0x0032))
    };
    let agent = first(obj, Tag(0x0018, 0x0012));
    let contrast_bolus_agent = nonempty_text(obj, Tag(0x0018, 0x0010))
        .or_else(|| agent.and_then(|v| nonempty_text(v, Tag(0x0018, 0x0010))))
        .unwrap_or_default();
    let contrast_bolus_route = nonempty_text(obj, Tag(0x0018, 0x1040))
        .or_else(|| {
            agent
                .and_then(|v| first(v, Tag(0x0018, 0x0014)))
                .and_then(|v| nonempty_text(v, Tag(0x0008, 0x0104)))
        })
        .unwrap_or_default();
    AcquisitionMetadata {
        protocol_name: text(obj, Tag(0x0018, 0x1030)),
        sequence_name: text(obj, Tag(0x0018, 0x0024)),
        scanning_sequence: text(obj, Tag(0x0018, 0x0020)),
        sequence_variant: text(obj, Tag(0x0018, 0x0021)),
        scan_options: text(obj, Tag(0x0018, 0x0022)),
        mr_acquisition_type: text(obj, Tag(0x0018, 0x0023)),
        manufacturer: text(obj, Tag(0x0008, 0x0070)),
        image_type,
        acquisition_time,
        acquisition_date_time,
        acquisition_contrast: frame_value(obj, frame, Tag(0x0018, 0x9226), |v| {
            nonempty_text(v, Tag(0x0008, 0x9209))
        })
        .unwrap_or_default(),
        contrast_bolus_agent,
        contrast_bolus_route,
        contrast_bolus_start_time: text(obj, Tag(0x0018, 0x1042)),
        contrast_bolus_administered: contrast_usage(obj, frame, Tag(0x0018, 0x9342)),
        contrast_bolus_detected: contrast_usage(obj, frame, Tag(0x0018, 0x9343)),
        contrast_bolus_phase: contrast_usage(obj, frame, Tag(0x0018, 0x9344)),
        flip_angle: frame_value(obj, frame, Tag(0x0018, 0x9112), |v| {
            first_number(v, Tag(0x0018, 0x1314))
        }),
        patient_birth_date: text(obj, Tag(0x0010, 0x0030)),
        patient_age_text: text(obj, Tag(0x0010, 0x1010)),
        study_time: text(obj, Tag(0x0008, 0x0030)),
        study_description: text(obj, Tag(0x0008, 0x1030)),
        body_part_examined: text(obj, Tag(0x0018, 0x0015)),
        laterality: frame_value(obj, frame, Tag(0x0020, 0x9071), |group| {
            laterality_code(group, Tag(0x0020, 0x9072))
        })
        .or_else(|| laterality_code(obj, Tag(0x0020, 0x0062)))
        .or_else(|| laterality_code(obj, Tag(0x0020, 0x0060)))
        .unwrap_or_default(),
        institution_name: text(obj, Tag(0x0008, 0x0080)),
        accession_number: text(obj, Tag(0x0008, 0x0050)),
        magnetic_field_strength: number(obj, Tag(0x0018, 0x0087)).filter(|v| *v > 0.),
        slice_thickness: frame_value(obj, frame, Tag(0x0028, 0x9110), |v| {
            number(v, Tag(0x0018, 0x0050))
        })
        .filter(|v| *v > 0.),
        // Read once per file, for a PET only (`read_frames_budget`).
        pet_acquisition: None,
    }
}

/// Enhanced attributes whose dimension orders frames in time: temporal positions
/// first, then cardiac trigger delays, when one organization holds several.
const TIME_DIMENSIONS: [Tag; 7] = [
    Tag(0x0020, 0x9128), // Temporal Position Index
    Tag(0x0020, 0x0100), // Temporal Position Identifier
    Tag(0x0020, 0x930d), // Temporal Position Time Offset
    Tag(0x0020, 0x9153), // Nominal Cardiac Trigger Delay Time
    Tag(0x0020, 0x9252), // Actual Cardiac Trigger Delay Time
    Tag(0x0018, 0x1060), // Trigger Time
    Tag(0x0020, 0x9241), // Nominal Percentage of Cardiac Phase
];
/// Of those, the ones whose value is a trigger delay in milliseconds.
const TRIGGER_DIMENSIONS: [Tag; 3] = [
    Tag(0x0020, 0x9153),
    Tag(0x0020, 0x9252),
    Tag(0x0018, 0x1060),
];
const MAX_DIMENSIONS: usize = 32;
/// Phase hints keep short text only; longer values are malformed for these VRs.
const MAX_HINT_TEXT: usize = 64;

/// The Enhanced dimension that orders frames in time.
#[derive(Clone, Copy, Debug)]
struct TimeDimension {
    /// Its place in each frame's DimensionIndexValues.
    position: usize,
    /// The number of dimensions, which DimensionIndexValues must match.
    count: usize,
    /// The attribute it indexes and the functional group sequence holding that.
    pointer: Tag,
    group: Option<Tag>,
    /// Its DimensionOrganizationUID, hashed: index values are ordinals within one
    /// organization.
    organization: Option<u64>,
}

fn tag_value(obj: &InMemDicomObject, tag: Tag) -> Option<Tag> {
    // Value::to_tag indexes the first value and panics on an empty AT.
    match obj.get(tag)?.value().primitive()? {
        PrimitiveValue::Tags(tags) => tags.first().copied(),
        _ => None,
    }
}

/// Find the time dimension through the DimensionIndexSequence pointers. Scanners
/// order dimensions differently, so its place in the index values is never assumed.
fn time_dimension(obj: &InMemDicomObject) -> Option<TimeDimension> {
    let items = obj.get(Tag(0x0020, 0x9222))?.items()?;
    if items.len() > MAX_DIMENSIONS {
        return None;
    }
    items
        .iter()
        .enumerate()
        .filter_map(|(position, item)| {
            let pointer = tag_value(item, Tag(0x0020, 0x9165))?;
            let preference = TIME_DIMENSIONS.iter().position(|tag| *tag == pointer)?;
            let dimension = TimeDimension {
                position,
                count: items.len(),
                pointer,
                group: tag_value(item, Tag(0x0020, 0x9167)),
                organization: nonempty_text(item, Tag(0x0020, 0x9164)).map(|uid| {
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    std::hash::Hash::hash(uid.as_str(), &mut hasher);
                    std::hash::Hasher::finish(&hasher)
                }),
            };
            Some((preference, dimension))
        })
        .min_by_key(|(preference, _)| *preference)
        .map(|(_, dimension)| dimension)
}

fn integer(value: f64) -> Option<i64> {
    (value.fract() == 0. && value.abs() <= 9_007_199_254_740_992.).then_some(value as i64)
}

fn hint_text(value: &str) -> String {
    if value.len() <= MAX_HINT_TEXT {
        value.to_owned()
    } else {
        String::new()
    }
}

/// What can tell this frame's phase from others at the same position. Only the
/// values are read here; the phase of a series is decided once it is grouped.
fn phase_hints(
    obj: &InMemDicomObject,
    frame: usize,
    explicit_temporal: Option<f64>,
    dimension: Option<TimeDimension>,
    acquisition: &AcquisitionMetadata,
) -> PhaseHints {
    const CONTENT: Tag = Tag(0x0020, 0x9111);
    let time_index = dimension.and_then(|dimension| {
        let values = frame_value(obj, frame, CONTENT, |v| {
            v.get(Tag(0x0020, 0x9157))?.to_multi_int::<u32>().ok()
        })?;
        (values.len() == dimension.count)
            .then(|| values[dimension.position])
            .filter(|index| *index > 0)
    });
    // The value the time dimension indexes, found through its functional group.
    let indexed = dimension.and_then(|dimension| match dimension.group {
        Some(group) => frame_value(obj, frame, group, |v| number(v, dimension.pointer)),
        None => number(obj, dimension.pointer),
    });
    let dimension_trigger = dimension
        .filter(|dimension| TRIGGER_DIMENSIONS.contains(&dimension.pointer))
        .and(indexed);
    let identity = |kind: &str, value: String, order: f64| PhaseIdentity {
        kind: kind.into(),
        value,
        label: String::new(),
        order,
        sort_values: Vec::new(),
        gate: None,
    };
    PhaseHints {
        explicit: explicit_temporal
            .map(|value| identity("temporalPosition", value.to_string(), value)),
        dimensions: time_index
            .map(|index| identity("dimensionIndex", index.to_string(), index as f64)),
        trigger_time: frame_value(obj, frame, Tag(0x0018, 0x9118), |v| {
            number(v, Tag(0x0020, 0x9153))
        })
        .or_else(|| number(obj, Tag(0x0018, 0x1060)))
        .or(dimension_trigger),
        acquisition_number: number(obj, Tag(0x0020, 0x0012)).and_then(integer),
        in_stack_position: frame_value(obj, frame, CONTENT, |v| number(v, Tag(0x0020, 0x9057)))
            .and_then(integer)
            .and_then(|n| u32::try_from(n).ok()),
        stack_id: frame_value(obj, frame, CONTENT, |v| {
            nonempty_text(v, Tag(0x0020, 0x9056))
        })
        .map(|id| hint_text(&id))
        .unwrap_or_default(),
        acquisition_time: hint_text(&acquisition.acquisition_time),
        acquisition_date_time: hint_text(&acquisition.acquisition_date_time),
        description: None,
        dimension_scope: dimension.and_then(|dimension| dimension.organization),
        dimension_value: indexed,
        gate: None,
    }
}

/// What may tell the phases of a series apart, tried in this order.
#[derive(Clone, Copy, Debug)]
enum PhaseSource {
    Dimension,
    Trigger,
    AcquisitionNumber,
    AcquisitionDateTime,
    AcquisitionTime,
}
const PHASE_SOURCES: [PhaseSource; 5] = [
    PhaseSource::Dimension,
    PhaseSource::Trigger,
    PhaseSource::AcquisitionNumber,
    PhaseSource::AcquisitionDateTime,
    PhaseSource::AcquisitionTime,
];

impl PhaseSource {
    fn kind(self) -> &'static str {
        match self {
            Self::Dimension => "dimensionIndex",
            Self::Trigger => "triggerTime",
            Self::AcquisitionNumber => "acquisitionNumber",
            Self::AcquisitionDateTime | Self::AcquisitionTime => "acquisitionTime",
        }
    }
    /// The value phases are grouped by (equal values) and ordered by.
    fn key(self, hints: &PhaseHints) -> Option<f64> {
        match self {
            Self::Dimension => hints.dimensions.as_ref().map(|d| d.order),
            Self::Trigger => hints.trigger_time.map(thousandths),
            Self::AcquisitionNumber => hints.acquisition_number.map(|n| n as f64),
            Self::AcquisitionDateTime => dt_seconds(&hints.acquisition_date_time),
            Self::AcquisitionTime => seconds_of_day(&hints.acquisition_time),
        }
    }
    /// The source value, as the identity of one phase.
    fn value(self, hints: &PhaseHints) -> String {
        match self {
            Self::Dimension => hints
                .dimensions
                .as_ref()
                .map(|d| d.value.clone())
                .unwrap_or_default(),
            Self::Trigger => hints.trigger_time.map(decimal).unwrap_or_default(),
            Self::AcquisitionNumber => hints
                .acquisition_number
                .map(|n| n.to_string())
                .unwrap_or_default(),
            Self::AcquisitionDateTime => hints.acquisition_date_time.clone(),
            Self::AcquisitionTime => hints.acquisition_time.clone(),
        }
    }
    /// A short label: the scanner's own number for a dimension index, otherwise the
    /// rank, with the value that tells this phase apart.
    fn label(self, rank: usize, hints: &PhaseHints, trigger: Option<f64>) -> String {
        let rank = rank.to_string();
        match self {
            Self::Dimension => phase_label(&self.value(hints), trigger.map(milliseconds)),
            Self::Trigger => phase_label(&rank, hints.trigger_time.map(milliseconds)),
            Self::AcquisitionNumber => {
                phase_label(&rank, hints.acquisition_number.map(|n| format!("Acq {n}")))
            }
            Self::AcquisitionDateTime | Self::AcquisitionTime => {
                phase_label(&rank, seconds_of_day(&hints.acquisition_time).map(clock))
            }
        }
    }
}

fn phase_label(number: &str, detail: Option<String>) -> String {
    match detail {
        Some(detail) => format!("Phase {number} · {detail}"),
        None => format!("Phase {number}"),
    }
}

/// Rounded to a thousandth: trigger times equal to the microsecond are one phase.
fn thousandths(value: f64) -> f64 {
    let scaled = value * 1000.;
    if scaled.is_finite() {
        scaled.round() / 1000.
    } else {
        value
    }
}

/// A decimal for a label: at most three decimals, without trailing zeros.
fn decimal(value: f64) -> String {
    let rounded = thousandths(value);
    format!("{}", if rounded == 0. { 0. } else { rounded })
}

fn milliseconds(value: f64) -> String {
    format!("{} ms", decimal(value))
}

/// Seconds since midnight of a DICOM TM value (HH, HHMM, HHMMSS, optional fraction),
/// also accepting the ACR-NEMA HH:MM:SS form.
fn seconds_of_day(time: &str) -> Option<f64> {
    let (whole, fraction) = time.trim().split_once('.').unwrap_or((time.trim(), ""));
    let whole = whole.replace(':', "");
    if !matches!(whole.len(), 2 | 4 | 6)
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let field = |at: usize| {
        whole
            .get(at..at + 2)
            .map_or(0, |v| v.parse::<u32>().unwrap_or(99))
    };
    let (hours, minutes, seconds) = (field(0), field(2), field(4));
    if hours > 23 || minutes > 59 || seconds > 60 {
        return None;
    }
    let fraction = format!("0.{fraction}0").parse::<f64>().ok()?;
    Some(f64::from(hours * 3600 + minutes * 60 + seconds) + fraction)
}

fn clock(seconds: f64) -> String {
    let seconds = seconds.floor() as u32;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

/// The trigger time of each part, when every frame of a part shares one and the
/// parts' trigger times differ; otherwise no part's label shows one.
fn part_triggers<'a>(
    parts: impl Iterator<Item = impl Iterator<Item = &'a PhaseHints>>,
) -> Option<Vec<f64>> {
    let mut triggers = Vec::new();
    for hints in parts {
        let mut shared = None;
        for hints in hints {
            let trigger = thousandths(hints.trigger_time?);
            if shared.is_some_and(|shared| shared != trigger) {
                return None;
            }
            shared = Some(trigger);
        }
        triggers.push(shared?);
    }
    let mut distinct = triggers.clone();
    distinct.sort_by(f64::total_cmp);
    distinct.dedup();
    (distinct.len() == triggers.len()).then_some(triggers)
}

/// Slice positions as the original app compared them, rounded to 0.01 mm, so that
/// the phases a scanner writes at one position compare equal.
fn place(position: [f64; 3]) -> [i64; 3] {
    position.map(|v| (v * 100.).round() as i64)
}

/// Part a series whose slice positions repeat into phases, by the first source whose
/// values give at least two parts that each hold every position of the stack exactly
/// once. Returns the frame indices of each part, in phase order.
fn phase_split(frames: &[Frame]) -> Option<(PhaseSource, Vec<Vec<usize>>)> {
    let places = frames
        .iter()
        .map(|f| {
            f.geometry
                .position
                .filter(|p| p.iter().all(|v| v.is_finite()))
                .map(place)
        })
        .collect::<Option<Vec<_>>>()?;
    let mut stack = places.clone();
    stack.sort_unstable();
    stack.dedup();
    // A single plane imaged over time stays one series rather than single images.
    if stack.len() == places.len() || stack.len() < 2 {
        return None;
    }
    PHASE_SOURCES.into_iter().find_map(|source| {
        if matches!(source, PhaseSource::Dimension) && !dimensions_comparable(frames) {
            return None;
        }
        let keys = frames
            .iter()
            .map(|f| source.key(&f.phase_hints))
            .collect::<Option<Vec<_>>>()?;
        let mut order: Vec<_> = (0..frames.len()).collect();
        order.sort_by(|&a, &b| keys[a].total_cmp(&keys[b]));
        let parts: Vec<_> = order
            .chunk_by(|&a, &b| keys[a] == keys[b])
            .map(<[usize]>::to_vec)
            .collect();
        let consistent = parts.len() >= 2
            && parts.iter().all(|part| {
                let mut covered: Vec<_> = part.iter().map(|&i| places[i]).collect();
                covered.sort_unstable();
                covered == stack
            });
        consistent.then_some((source, parts))
    })
}

const MIN_RUN_IMAGES: usize = 5;
const MAX_RUNS: usize = 8;

/// VEAcom 1.x's last resort for a series that goes through all its slices once for each kind of image with nothing
/// in the headers to tell the kinds apart: the scanner's numbering, cut where it comes back to a place already
/// passed. Only when every run holds the same places, each once, at least 5 of them, in 2 to 8 runs.
fn runs_through_places(frames: &[Frame]) -> Option<Vec<Vec<usize>>> {
    let places = frames
        .iter()
        .map(|f| {
            f.geometry
                .position
                .filter(|p| p.iter().all(|v| v.is_finite()))
                .map(place)
        })
        .collect::<Option<Vec<_>>>()?;
    let mut order: Vec<usize> = (0..frames.len()).collect();
    order.sort_by_key(|&i| (frames[i].instance_number, i));
    let mut runs: Vec<Vec<usize>> = vec![Vec::new()];
    let mut seen = std::collections::BTreeSet::new();
    for i in order {
        if !seen.insert(places[i]) {
            runs.push(Vec::new());
            seen.clear();
            seen.insert(places[i]);
        }
        runs.last_mut().expect("one run at least").push(i);
    }
    if !(2..=MAX_RUNS).contains(&runs.len()) {
        return None;
    }
    let held = |run: &Vec<usize>| {
        run.iter()
            .map(|&i| places[i])
            .collect::<std::collections::BTreeSet<_>>()
    };
    let first = held(&runs[0]);
    (first.len() >= MIN_RUN_IMAGES
        && runs
            .iter()
            .all(|run| run.len() == first.len() && held(run) == first))
    .then_some(runs)
}

/// Dimension index values are ordinals within one dimension organization (PS3.3
/// C.7.6.17), so frames of different instances compare only when they share one, and
/// never where one ordinal stands for two indexed values.
fn dimensions_comparable(frames: &[Frame]) -> bool {
    let Some(first) = frames.first() else {
        return false;
    };
    let scope = first.phase_hints.dimension_scope;
    if frames.iter().any(|f| f.source.path != first.source.path)
        && (scope.is_none()
            || frames
                .iter()
                .any(|f| f.phase_hints.dimension_scope != scope))
    {
        return false;
    }
    let mut meaning = BTreeMap::new();
    frames.iter().all(|f| {
        let hints = &f.phase_hints;
        let (Some(index), Some(value)) = (&hints.dimensions, hints.dimension_value) else {
            return true;
        };
        let value = thousandths(value).to_bits();
        *meaning.entry(index.order.to_bits()).or_insert(value) == value
    })
}

/// The acquisition that starts a phase: its earliest frame by date and time where every
/// frame has one, at whatever precision it was recorded; otherwise by time of day;
/// otherwise its first frame's values as recorded.
fn phase_acquisition(frames: &[Frame]) -> (String, String) {
    let hints = || frames.iter().map(|f| &f.phase_hints);
    fn earliest(keyed: Vec<(f64, &PhaseHints)>) -> Option<&PhaseHints> {
        keyed
            .into_iter()
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, h)| h)
    }
    let chosen = hints()
        .map(|h| dt_seconds(&h.acquisition_date_time).map(|key| (key, h)))
        .collect::<Option<Vec<_>>>()
        .and_then(earliest)
        .or_else(|| {
            earliest(
                hints()
                    .filter_map(|h| seconds_of_day(&h.acquisition_time).map(|key| (key, h)))
                    .collect(),
            )
        })
        .or_else(|| hints().next());
    chosen
        .map(|h| (h.acquisition_time.clone(), h.acquisition_date_time.clone()))
        .unwrap_or_default()
}

/// Seconds of a DICOM DT value for ordering, which may stop after any component
/// (YYYY[MM[DD[HH[MM[SS[.F]]]]]], PS3.5 6.2); missing components count from their start,
/// and a UTC offset, when given, is applied.
fn dt_seconds(value: &str) -> Option<f64> {
    let value = value.trim();
    let (local, offset) = match value.find(['+', '-']) {
        Some(at) => (&value[..at], Some(&value[at..])),
        None => (value, None),
    };
    let (whole, fraction) = local.split_once('.').unwrap_or((local, ""));
    if !matches!(whole.len(), 4 | 6 | 8 | 10 | 12 | 14)
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || (!fraction.is_empty() && whole.len() != 14)
    {
        return None;
    }
    let field = |at: usize, default: u32| {
        whole
            .get(at..at + 2)
            .map_or(Some(default), |v| v.parse().ok())
    };
    let instant = NaiveDate::from_ymd_opt(whole[..4].parse().ok()?, field(4, 1)?, field(6, 1)?)?
        .and_hms_opt(field(8, 0)?, field(10, 0)?, field(12, 0)?)?;
    let mut seconds =
        instant.and_utc().timestamp() as f64 + format!("0.{fraction}0").parse::<f64>().ok()?;
    if let Some(offset) = offset {
        let digits = &offset[1..];
        if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let minutes =
            f64::from(digits[..2].parse::<u32>().ok()? * 60 + digits[2..].parse::<u32>().ok()?);
        seconds -= if offset.starts_with('-') {
            -minutes
        } else {
            minutes
        } * 60.;
    }
    Some(seconds)
}

/// What keeps frames apart as series. The explicit temporal position is held aside
/// so that the positions of one acquisition, a family, sort together; the series id
/// still comes from the single key `id_key` rebuilds.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct GroupKey {
    head: String,
    tail: String,
    temporal: String,
    /// The head without the image orientation: groups that differ only in orientation can be one series.
    stack: String,
}

impl GroupKey {
    fn whole(key: String) -> Self {
        Self {
            stack: key.clone(),
            head: key,
            tail: String::new(),
            temporal: String::new(),
        }
    }
    fn same_family(&self, other: &Self) -> bool {
        self.head == other.head && self.tail == other.tail
    }
    fn id_key(&self) -> String {
        format!("{}{}{}", self.head, self.temporal, self.tail)
    }
    fn len(&self) -> usize {
        self.head.len() + self.temporal.len() + self.tail.len()
    }
}

/// The geometry's notes that say only that a series cannot be reconstructed into a volume.
const RECONSTRUCTION_NOTES: [&str; 6] = [
    "geometry.singleImage",
    "geometry.mixedOrientation",
    "geometry.mixedSpacing",
    "geometry.irregular",
    "geometry.noDisplacement",
    "geometry.duplicatePlanes",
];

/// A series split by orientation only when each orientation is a stack of its own (VEAcom 1.x, series.py).
const MIN_STACK_IMAGES: usize = 5;
const MAX_STACKS: usize = 8;

/// A series whose images face several ways in handfuls (a localizer, a few MPR snapshots) stays one series in
/// the scanner's order, as in VEAcom 1.x: split by orientation, its images were listed as series of one or two.
/// It is split only when every orientation is a stack of its own: at least 5 images, at most 8 stacks.
/// One case more is split: a single stack with one image facing another way, the reference image a scanner
/// puts at the head of a reformatted series. Kept in the stack, it would stop the stack being reconstructed.
/// An image whose orientation differs from the stack's only in its rounding is a slice of the stack and stays
/// in it (`faces_another_way`).
fn merge_scattered_orientations(groups: &mut BTreeMap<GroupKey, (Series, Vec<Frame>)>) {
    let mut alike: BTreeMap<(String, String, String), Vec<GroupKey>> = BTreeMap::new();
    for key in groups.keys() {
        alike
            .entry((key.stack.clone(), key.temporal.clone(), key.tail.clone()))
            .or_default()
            .push(key.clone());
    }
    for keys in alike.into_values() {
        if keys.len() < 2
            || (keys.len() <= MAX_STACKS
                && keys
                    .iter()
                    .all(|key| groups[key].1.len() >= MIN_STACK_IMAGES))
        {
            continue;
        }
        if let [a, b] = keys.as_slice() {
            let (image, stack) = if groups[a].1.len() == 1 {
                (&groups[a].1, &groups[b].1)
            } else {
                (&groups[b].1, &groups[a].1)
            };
            if image.len() == 1
                && stack.len() >= MIN_STACK_IMAGES
                && faces_another_way(&image[0], stack)
            {
                continue;
            }
        }
        let mut keys = keys.into_iter();
        let first = keys.next().unwrap();
        let (info, mut frames) = groups.remove(&first).unwrap();
        for key in keys {
            frames.extend(groups.remove(&key).unwrap().1);
        }
        frames.sort_by_key(|f| (f.instance_number, f.source.path.clone(), f.index));
        groups.insert(first, (info, frames));
    }
}

/// Whether an image faces another way than a stack: both orientations are known, and the image's is none of the
/// stack's by the tolerance within which the volume geometry takes a stack's images for one orientation. The key
/// that groups images rounds each orientation, so two images of one stack can fall either side of a rounding
/// step; kept apart for that alone, a slice would leave its stack and the stack be built without it.
fn faces_another_way(image: &Frame, stack: &[Frame]) -> bool {
    let Some(own) = image
        .geometry
        .orientation
        .filter(|orientation| geometry::plane_normal(*orientation).is_some())
    else {
        return false;
    };
    let mut known = stack
        .iter()
        .filter_map(|frame| frame.geometry.orientation)
        .filter(|orientation| geometry::plane_normal(*orientation).is_some())
        .peekable();
    known.peek().is_some() && !known.any(|other| geometry::same_orientation(own, other))
}

/// The explicit temporal position shared by every frame of a group.
fn explicit_position(frames: &[Frame]) -> Option<f64> {
    let position = frames.first()?.phase_hints.explicit.as_ref()?.order;
    frames
        .iter()
        .all(|f| {
            f.phase_hints
                .explicit
                .as_ref()
                .is_some_and(|explicit| explicit.order == position)
        })
        .then_some(position)
}

/// Older saved drawings hashed the catalog ID together with every source and its geometry.
fn legacy_grid_ids(base: &str, current: &str, frames: &[Frame]) -> Vec<String> {
    if frames.len() < 2 {
        return Vec::new();
    }
    let mut keys = vec![base.to_owned()];
    if frames.len() >= MIN_RUN_IMAGES {
        keys.extend((1..=MAX_RUNS).map(|n| format!("{base}|run={n}")));
    }
    let first = &frames[0].phase_hints;
    for source in PHASE_SOURCES {
        if let Some(value) = source.key(first)
            && frames
                .iter()
                .all(|f| source.key(&f.phase_hints) == Some(value))
        {
            keys.push(format!(
                "{base}|phase={}:{}",
                source.kind(),
                source.value(first)
            ));
        }
    }
    keys.sort_unstable();
    keys.dedup();
    keys.iter()
        .filter(|key| key.as_str() != current)
        .map(|key| crate::random::uuid_v5(&crate::random::NAMESPACE_OID, key.as_bytes()))
        .collect()
}

/// Add the groups of one family to `parts`. When the family holds more than one
/// explicit temporal position, the key has already parted them and they are only
/// named here; any other group may still be parted by `split_phases`.
fn phase_family(
    family: Vec<(GroupKey, Series, Vec<Frame>)>,
    parts: &mut Vec<(String, Series, Vec<Frame>)>,
) {
    let mut family: Vec<_> = family
        .into_iter()
        .map(|(key, info, frames)| {
            let explicit = explicit_position(&frames);
            (key, info, frames, explicit)
        })
        .collect();
    let mut positions: Vec<f64> = family.iter().filter_map(|group| group.3).collect();
    positions.sort_by(f64::total_cmp);
    positions.dedup();
    let named = positions.len() > 1;
    if named {
        // Listed in phase order (the key sorts "10" before "2"), the rest after.
        family.sort_by(|a, b| match (a.3, b.3) {
            (Some(a), Some(b)) => a.total_cmp(&b),
            (a, b) => b.is_some().cmp(&a.is_some()),
        });
    }
    let triggers = named
        .then(|| {
            part_triggers(
                family
                    .iter()
                    .filter(|group| group.3.is_some())
                    .map(|(_, _, frames, _)| frames.iter().map(|f| &f.phase_hints)),
            )
        })
        .flatten();
    let mut triggers = triggers.into_iter().flatten();
    for (key, mut info, frames, explicit) in family {
        let base = key.id_key();
        let mut add = |id: String, mut info: Series, frames: Vec<Frame>| {
            info.legacy_grid_ids = legacy_grid_ids(&base, &id, &frames);
            parts.push((id, info, frames));
        };
        let Some(position) = explicit.filter(|_| named) else {
            split_phases(&base, info, frames, add);
            continue;
        };
        let value = frames[0]
            .phase_hints
            .explicit
            .as_ref()
            .map(|explicit| explicit.value.clone())
            .unwrap_or_default();
        let rank = positions
            .binary_search_by(|p| p.total_cmp(&position))
            .unwrap_or(0)
            + 1;
        let trigger = triggers.next();
        // The frames of a group share their gate, as its number is their explicit temporal position.
        let gate = frames[0].phase_hints.gate;
        info.phase = Some(PhaseIdentity {
            kind: if gate.is_some() {
                "timeSlot"
            } else {
                "temporalPosition"
            }
            .into(),
            label: match &gate {
                Some(gate) => gate_label(gate),
                None => phase_label(&value, trigger.map(milliseconds)),
            },
            value,
            order: rank as f64,
            sort_values: vec![position],
            gate,
        });
        add(base.clone(), info, frames);
    }
}

/// A gate of a gated SPECT as the interface names it in English (src/ui/seriesNames.ts): "Gate 3/8 · 118 s acquired",
/// after its R-R window where the file holds several: "R-R 2 (400–600 ms) · Gate 3/8". The time is the Time Slot Time,
/// the time the gate counted over all its beats, to three significant digits.
fn gate_label(gate: &Gate) -> String {
    let window = gate.interval.map(|interval| match gate.beats {
        Some([low, high]) => format!("R-R {interval} ({}–{} ms)", decimal(low), decimal(high)),
        None => format!("R-R {interval}"),
    });
    let time = gate
        .slot_time
        .map(|time| format!("{} s acquired", significant(time / 1000.)));
    [
        window,
        Some(format!("Gate {}/{}", gate.slot, gate.slots)),
        time,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// A number to three significant digits, as JavaScript's `toPrecision(3)` gives it, without trailing zeros.
fn significant(value: f64) -> String {
    if value == 0. || !value.is_finite() {
        return decimal(value);
    }
    let places = 2 - value.abs().log10().floor() as i32;
    let rounded = if places >= 0 {
        let scale = 10f64.powi(places);
        (value * scale).round() / scale
    } else {
        let scale = 10f64.powi(-places);
        (value / scale).round() * scale
    };
    format!("{rounded}")
}

/// The gates of one gated SPECT share one window, as NM workstations show them, so that a gate that counted more (a
/// thickening wall) looks brighter than another. It spans the windows measured from each gate's pixels. A window the
/// file stores is the same for every gate already.
fn share_gate_windows(sources: &mut [SourceSeries]) {
    let mut files: BTreeMap<(&str, &Path), Vec<usize>> = BTreeMap::new();
    for (index, source) in sources.iter().enumerate() {
        let gated = source
            .info
            .phase
            .as_ref()
            .is_some_and(|phase| phase.gate.is_some());
        if let (true, true, Some(frame)) =
            (gated, source.info.window_from_pixels, source.frames.first())
        {
            files
                .entry((&source.info.uid, &frame.source.path))
                .or_default()
                .push(index);
        }
    }
    let files: Vec<Vec<usize>> = files
        .into_values()
        .filter(|gates| gates.len() > 1)
        .collect();
    for gates in files {
        let (mut low, mut high) = (f64::INFINITY, f64::NEG_INFINITY);
        for &index in &gates {
            let info = &sources[index].info;
            low = low.min(info.window_center - info.window_width / 2.);
            high = high.max(info.window_center + info.window_width / 2.);
        }
        for index in gates {
            sources[index].info.window_center = (low + high) / 2.;
            sources[index].info.window_width = high - low;
        }
    }
}

/// Emit a group, parted into phases when its slice positions repeat and
/// one of the phase sources tells them apart; otherwise whole.
fn split_phases(
    key: &str,
    info: Series,
    frames: Vec<Frame>,
    mut add: impl FnMut(String, Series, Vec<Frame>),
) {
    let Some((source, split)) = phase_split(&frames) else {
        if let Some(runs) = runs_through_places(&frames) {
            let total = runs.len();
            let mut frames: Vec<_> = frames.into_iter().map(Some).collect();
            for (index, run) in runs.into_iter().enumerate() {
                let part: Vec<Frame> = run
                    .into_iter()
                    .map(|i| frames[i].take().expect("each frame is in one run"))
                    .collect();
                let mut info = info.clone();
                info.description = format!("{} ({}/{total})", info.description, index + 1)
                    .trim()
                    .to_string();
                add(format!("{key}|run={}", index + 1), info, part);
            }
            return;
        }
        add(key.to_owned(), info, frames);
        return;
    };
    let triggers = match source {
        PhaseSource::Dimension => part_triggers(
            split
                .iter()
                .map(|part| part.iter().map(|&i| &frames[i].phase_hints)),
        ),
        _ => None,
    };
    let mut frames: Vec<_> = frames.into_iter().map(Some).collect();
    for (index, part) in split.into_iter().enumerate() {
        let part: Vec<Frame> = part
            .into_iter()
            .map(|i| frames[i].take().expect("each frame is in one part"))
            .collect();
        let hints = &part[0].phase_hints;
        let value = source.value(hints);
        let mut info = info.clone();
        // Each phase carries its own timing, which contrast inference reads.
        (
            info.acquisition.acquisition_time,
            info.acquisition.acquisition_date_time,
        ) = phase_acquisition(&part);
        info.phase = Some(PhaseIdentity {
            kind: source.kind().into(),
            label: source.label(
                index + 1,
                hints,
                triggers.as_ref().map(|triggers| triggers[index]),
            ),
            order: (index + 1) as f64,
            sort_values: vec![source.key(hints).unwrap_or_default()],
            value: value.clone(),
            gate: None,
        });
        let key = format!("{key}|phase={}:{value}", source.kind());
        add(key, info, part);
    }
}

pub(crate) fn padding_range(
    obj: &InMemDicomObject,
    frame: usize,
    slope: f64,
    intercept: f64,
    signed: bool,
    bits: u32,
) -> Option<[f64; 2]> {
    let places = [
        frame_group(obj, frame, false),
        frame_group(obj, frame, true),
        Some(obj),
    ];
    for (value_tag, limit_tag, integer) in [
        (0x0123, 0x0125, false),
        (0x0122, 0x0124, false),
        (0x0120, 0x0121, true),
    ] {
        for place in places.into_iter().flatten() {
            if place.get(Tag(0x0028, value_tag)).is_none() {
                continue;
            }
            let value = number(place, Tag(0x0028, value_tag))?;
            let limit = if place.get(Tag(0x0028, limit_tag)).is_some() {
                number(place, Tag(0x0028, limit_tag))?
            } else {
                value
            };
            let signed_value = |n: f64| {
                if integer
                    && signed
                    && bits > 0
                    && bits <= 32
                    && n >= 2f64.powi(bits as i32 - 1)
                    && n < 2f64.powi(bits as i32)
                {
                    n - 2f64.powi(bits as i32)
                } else {
                    n
                }
            };
            let a = signed_value(value) * slope + intercept;
            let b = signed_value(limit) * slope + intercept;
            return (a.is_finite() && b.is_finite()).then_some([a.min(b), a.max(b)]);
        }
    }
    None
}

fn frame_metadata(
    geometry: &FrameGeometry,
    window_center: Option<f64>,
    window_width: Option<f64>,
    padding_range: Option<[f64; 2]>,
) -> FrameMetadata {
    let individual = geometry::assemble(std::slice::from_ref(geometry));
    FrameMetadata {
        origin: individual.origin,
        direction: individual.direction,
        spacing: individual.spacing,
        position_known: geometry
            .position
            .is_some_and(|p| p.iter().all(|n| n.is_finite())),
        orientation_known: geometry.orientation.is_some_and(valid_orientation),
        spacing_known: geometry
            .pixel_spacing
            .is_some_and(|s| s.iter().all(|n| n.is_finite() && *n > 0.)),
        instance_number: None,
        sop_instance_uid: String::new(),
        source_frame_number: None,
        window_center,
        window_width,
        padding_range,
        padding_is_nan: false,
        segment_number: None,
        referenced_sop_instance_uid: String::new(),
        referenced_frame_number: None,
        voi_lut: None,
        voi_function: None,
        nm: None,
        projection: None,
    }
}

pub fn storage_type(bits: u32, signed: bool, slope: f64, intercept: f64) -> &'static str {
    if bits == 0 || bits > 16 || slope.fract() != 0. || intercept.fract() != 0. {
        return "float32";
    }
    let (low, high) = if signed {
        (
            -(1i64 << (bits - 1)) as f64,
            ((1i64 << (bits - 1)) - 1) as f64,
        )
    } else {
        (0., ((1u64 << bits) - 1) as f64)
    };
    let a = low * slope + intercept;
    let b = high * slope + intercept;
    let min = a.min(b);
    let max = a.max(b);
    if min >= i16::MIN as f64 && max <= i16::MAX as f64 {
        "int16"
    } else if min >= 0. && max <= u16::MAX as f64 {
        "uint16"
    } else {
        "float32"
    }
}
fn valid_orientation(o: [f64; 6]) -> bool {
    let norm_a = (o[0] * o[0] + o[1] * o[1] + o[2] * o[2]).sqrt();
    let norm_b = (o[3] * o[3] + o[4] * o[4] + o[5] * o[5]).sqrt();
    (norm_a - 1.).abs() <= 1.0e-4
        && (norm_b - 1.).abs() <= 1.0e-4
        && (o[0] * o[3] + o[1] * o[4] + o[2] * o[5]).abs() <= 1.0e-4
}

fn ultrasound_spacing(obj: &InMemDicomObject, rows: usize, columns: usize) -> Option<[f64; 2]> {
    let regions = obj.get(Tag(0x0018, 0x6011))?.items()?;
    let mut spacing: Option<[f64; 2]> = None;
    for region in regions {
        if number(region, Tag(0x0018, 0x6012)).unwrap_or(1.) != 1. {
            continue;
        }
        if number(region, Tag(0x0018, 0x6024)) != Some(3.)
            || number(region, Tag(0x0018, 0x6026)) != Some(3.)
        {
            return None;
        }
        let x = number(region, Tag(0x0018, 0x602c))?.abs() * 10.;
        let y = number(region, Tag(0x0018, 0x602e))?.abs() * 10.;
        let x0 = number(region, Tag(0x0018, 0x6018))?;
        let x1 = number(region, Tag(0x0018, 0x601c))?;
        let y0 = number(region, Tag(0x0018, 0x601a))?;
        let y1 = number(region, Tag(0x0018, 0x601e))?;
        if x <= 0.
            || y <= 0.
            || x0 < 0.
            || y0 < 0.
            || x1 <= x0
            || y1 <= y0
            || x1 >= columns as f64
            || y1 >= rows as f64
        {
            return None;
        }
        let candidate = [y, x];
        if let Some(reference) = spacing {
            if (0..2).any(|axis| {
                (reference[axis] - candidate[axis]).abs() > 1e-6_f64.max(reference[axis] * 1e-4)
            }) {
                return None;
            }
        } else {
            spacing = Some(candidate);
        }
    }
    spacing
}
fn diffusion(obj: &InMemDicomObject, frame: usize) -> (Option<f64>, Option<[f64; 3]>) {
    let mut b = frame_value(obj, frame, Tag(0x0018, 0x9117), |v| {
        number(v, Tag(0x0018, 0x9087))
    });
    let gradient_from = |place: &InMemDicomObject| {
        numbers(place, Tag(0x0018, 0x9089)).or_else(|| {
            first(place, Tag(0x0018, 0x9076)).and_then(|v| numbers(v, Tag(0x0018, 0x9089)))
        })
    };
    let gradient = frame_value(obj, frame, Tag(0x0018, 0x9117), gradient_from);
    if b.is_none() {
        let manufacturer = text(obj, Tag(0x0008, 0x0070)).to_ascii_uppercase();
        for (maker, tag) in [
            ("SIEMENS", Tag(0x0019, 0x100c)),
            ("PHILIPS", Tag(0x2001, 0x1003)),
            ("GE", Tag(0x0043, 0x1039)),
        ] {
            if manufacturer.contains(maker) {
                b = (|| {
                    let bytes = obj.get(tag)?.to_bytes().ok()?;
                    std::str::from_utf8(&bytes)
                        .ok()?
                        .split('\\')
                        .next()?
                        .trim_matches([' ', '\0'])
                        .parse::<f64>()
                        .ok()
                })()
                .or_else(|| number(obj, tag))
                .filter(|v| v.is_finite() && *v >= 0.)
                .map(|v| v % 1e9);
                if b.is_some() {
                    break;
                }
            }
        }
    }
    if b.is_none() {
        // Siemens also names the b-value in the sequence ("*ep_b1000t"): an archive that strips the private
        // elements keeps it there, and b0 and b1000 then stay two series, as VEAcom 1.x showed them.
        b = sequence_b_value(&text(obj, Tag(0x0018, 0x0024)));
    }
    (b.filter(|v| *v >= 0.), gradient)
}

/// The b-value in a Siemens diffusion sequence name: "*ep_b1000t" 1000, "*ep_b0" 0; none for a combined
/// "*ep_b0_1000" (a derived ADC or trace image, not one b-value) or any other name.
fn sequence_b_value(name: &str) -> Option<f64> {
    let rest = &name[name.find("ep_b")? + 4..];
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let after = &rest[digits..];
    if after.starts_with('_') && after[1..].starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    rest[..digits].parse().ok()
}
fn age_years(value: &str) -> Option<f64> {
    let (number, unit) = value.split_at_checked(value.len().checked_sub(1)?)?;
    let n = number.parse::<f64>().ok()?;
    match unit {
        "Y" => Some(n),
        "M" => Some(n / 12.),
        "W" => Some(n / 52.1775),
        "D" => Some(n / 365.25),
        _ => None,
    }
}
const SEGMENTATION_STORAGE: &str = "1.2.840.10008.5.1.4.1.1.66.4";
const LABEL_MAP_SEGMENTATION_STORAGE: &str = "1.2.840.10008.5.1.4.1.1.66.7";
const MAX_SEGMENTS: usize = 1024;

fn is_segmentation(obj: &InMemDicomObject) -> bool {
    matches!(
        text(obj, Tag(0x0008, 0x0016)).as_str(),
        SEGMENTATION_STORAGE | LABEL_MAP_SEGMENTATION_STORAGE
    ) || text(obj, Tag(0x0008, 0x0060)) == "SEG"
}

/// The segments a SEG object defines and the image series it was drawn on.
fn segmentation(obj: &InMemDicomObject) -> Segmentation {
    let segments = obj
        .get(Tag(0x0062, 0x0002))
        .and_then(|element| element.items())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let number = number(item, Tag(0x0062, 0x0004))
                        .filter(|n| n.fract() == 0. && *n >= 1. && *n <= u16::MAX as f64)?
                        as u16;
                    let color = item
                        .get(Tag(0x0062, 0x000d))
                        .and_then(|element| element.to_multi_int::<u16>().ok())
                        .and_then(|lab| <[u16; 3]>::try_from(lab).ok())
                        .map(cielab_to_srgb);
                    Some(Segment {
                        number,
                        label: hint_text(&text(item, Tag(0x0062, 0x0005))),
                        color,
                    })
                })
                .take(MAX_SEGMENTS)
                .collect()
        })
        .unwrap_or_default();
    let mut series = None;
    let mut instances = None;
    segmentation_references(
        obj,
        &reference_uid(obj, Tag(0x0020, 0x000d)),
        &mut series,
        &mut instances,
    );
    let references: Option<Vec<_>> = series.map(|s| s.into_iter().collect());
    Segmentation {
        kind: hint_text(&text(obj, Tag(0x0062, 0x0001))),
        referenced_series_uid: references
            .as_ref()
            .and_then(|items| items.first())
            .map(|(_, uid)| uid.clone())
            .unwrap_or_default(),
        referenced_series: references,
        referenced_instances: instances.map(|s| s.into_iter().collect()),
        segments,
    }
}

fn reference_uid(obj: &InMemDicomObject, tag: Tag) -> String {
    let uid = text(obj, tag);
    if uid.len() <= 64 && uid.bytes().all(|c| c.is_ascii_digit() || c == b'.') {
        uid
    } else {
        String::new()
    }
}

// An explicit but empty or malformed reference must not turn into a geometry-only match.
fn segmentation_references(
    obj: &InMemDicomObject,
    study: &str,
    series: &mut Option<std::collections::BTreeSet<(String, String)>>,
    instances: &mut Option<std::collections::BTreeSet<(String, Option<u32>)>>,
) {
    for tag in [
        Tag(0x0008, 0x1115),
        Tag(0x0008, 0x1200),
        Tag(0x5200, 0x9229),
        Tag(0x5200, 0x9230),
        Tag(0x0008, 0x9124),
    ] {
        let Some(sequence) = obj.get(tag) else {
            continue;
        };
        if matches!(tag, Tag(0x0008, 0x1115 | 0x1200)) {
            series.get_or_insert_with(Default::default);
        }
        for item in sequence.items().into_iter().flatten() {
            if tag == Tag(0x0008, 0x1115) {
                series
                    .as_mut()
                    .unwrap()
                    .insert((study.to_owned(), reference_uid(item, Tag(0x0020, 0x000e))));
            }
            if tag == Tag(0x0008, 0x1200) {
                segmentation_references(
                    item,
                    &reference_uid(item, Tag(0x0020, 0x000d)),
                    series,
                    instances,
                );
            } else {
                segmentation_references(item, study, series, instances);
            }
        }
    }
    for tag in [
        Tag(0x0008, 0x1140),
        Tag(0x0008, 0x114a),
        Tag(0x0008, 0x2112),
    ] {
        let Some(sequence) = obj.get(tag) else {
            continue;
        };
        let references = instances.get_or_insert_with(Default::default);
        for item in sequence.items().into_iter().flatten() {
            let uid = reference_uid(item, Tag(0x0008, 0x1155));
            if let Some(element) = item.get(Tag(0x0008, 0x1160)) {
                let frames = element.to_multi_int::<u32>().unwrap_or_default();
                if frames.is_empty() {
                    references.insert((uid, Some(0)));
                } else {
                    for number in frames {
                        references.insert((uid.clone(), Some(number)));
                    }
                }
            } else {
                references.insert((uid, None));
            }
        }
    }
}

/// A window that shows a mask's own values: 0 and 1 for a binary segmentation, up to
/// the largest fraction or label otherwise.
fn segment_window(obj: &InMemDicomObject, bits: u32) -> (f64, f64) {
    let top = if bits <= 1 {
        1.
    } else {
        number(obj, Tag(0x0062, 0x000e))
            .filter(|n| *n >= 1.)
            .unwrap_or(((1u64 << bits.min(16)) - 1) as f64)
    };
    (top / 2., top)
}

/// sRGB for a DICOM CIELab triplet (PS3.3 C.10.7.1.1: L* 0..100 and a*, b* -128..127
/// scaled to 0..65535, D65 white).
fn cielab_to_srgb(lab: [u16; 3]) -> [u8; 3] {
    let l = f64::from(lab[0]) * 100. / 65535.;
    let a = f64::from(lab[1]) * 255. / 65535. - 128.;
    let b = f64::from(lab[2]) * 255. / 65535. - 128.;
    let fy = (l + 16.) / 116.;
    let inverse = |t: f64| {
        let delta = 6. / 29.;
        if t > delta {
            t * t * t
        } else {
            3. * delta * delta * (t - 4. / 29.)
        }
    };
    let x = 0.95047 * inverse(fy + a / 500.);
    let y = inverse(fy);
    let z = 1.08883 * inverse(fy - b / 200.);
    let linear = [
        3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
        -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
        0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
    ];
    linear.map(|c| {
        let c = c.clamp(0., 1.);
        let encoded = if c <= 0.0031308 {
            12.92 * c
        } else {
            1.055 * c.powf(1. / 2.4) - 0.055
        };
        (encoded * 255.).round() as u8
    })
}

/// What an import was opened from, for ordinary images (PNG, JPEG, BMP), which carry no patient or series of their
/// own (VEAcom 1.x, app/dicom/picture.py): the folder or archive opened is the patient and one study, each
/// folder in it a series named after its path there. Loose files chosen together belong to their folder.
struct ImageRoot {
    /// The folder the series' paths are taken from (an archive's extraction folder).
    dir: PathBuf,
    /// The patient's name: the folder's, or the archive's without its extension.
    name: String,
}

impl ImageRoot {
    fn new(dir: &Path, name: Option<&std::ffi::OsStr>) -> Arc<Self> {
        let name = name
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty());
        Arc::new(Self {
            dir: dir.to_owned(),
            name: name.unwrap_or_else(|| dir.display().to_string()),
        })
    }
}

/// "kesit2.png" before "kesit10.png": runs of digits compare as numbers, the rest without case.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    let digits = |chars: &mut std::iter::Peekable<std::str::Chars>| {
        let mut run = String::new();
        while let Some(c) = chars.peek().copied().filter(|c| c.is_ascii_digit()) {
            run.push(c);
            chars.next();
        }
        run
    };
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (left, right) = (digits(&mut a), digits(&mut b));
                let (l, r) = (left.trim_start_matches('0'), right.trim_start_matches('0'));
                let order = l
                    .len()
                    .cmp(&r.len())
                    .then_with(|| l.cmp(r))
                    .then_with(|| left.len().cmp(&right.len()));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                a.next();
                b.next();
            }
        }
    }
}

/// The image series of each opened folder in their folders' natural order, numbered so; a folder with
/// images of two sizes makes two series, named apart by their size.
fn number_image_series(sources: &mut [SourceSeries]) {
    let mut studies: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, source) in sources.iter().enumerate() {
        if source
            .frames
            .first()
            .is_some_and(|frame| frame.ordinary_image)
        {
            studies
                .entry(source.info.study_uid.clone())
                .or_default()
                .push(index);
        }
    }
    for mut members in studies.into_values() {
        members.sort_by(|&a, &b| {
            natural_cmp(&sources[a].info.description, &sources[b].info.description)
                .then_with(|| sources[a].info.dimensions[..2].cmp(&sources[b].info.dimensions[..2]))
        });
        let names: Vec<String> = members
            .iter()
            .map(|&index| {
                let info = &sources[index].info;
                let shared = members
                    .iter()
                    .filter(|&&other| sources[other].info.description == info.description)
                    .count()
                    > 1;
                if shared {
                    format!(
                        "{} ({}×{})",
                        info.description, info.dimensions[0], info.dimensions[1]
                    )
                } else {
                    info.description.clone()
                }
            })
            .collect();
        for (rank, (&index, name)) in members.iter().zip(names).enumerate() {
            sources[index].info.series_number = rank as i32 + 1;
            sources[index].info.description = name;
        }
    }
}

fn read_ordinary(path: &Path, root: Option<&ImageRoot>) -> Result<Vec<(GroupKey, Series, Frame)>> {
    // The size, which the desktop app's sandboxed picture decoder reads from the header alone (pictures.rs).
    let source = crate::pictures::index(path)?;
    let picture = crate::pictures::size(&source)?;
    let (width, height) = (picture.width, picture.height);
    if width == 0 || height == 0 || width > 32768 || height > 32768 {
        bail!("Invalid or excessive image dimensions");
    }
    let folder = path.parent().unwrap_or(Path::new(""));
    let own;
    let root = match root {
        Some(root) => root,
        None => {
            own = ImageRoot::new(folder, folder.file_name());
            &own
        }
    };
    // The series: the folder's path within the root ("" at its top, named after the root), and one size of
    // image (a series is one stack).
    let within = folder
        .strip_prefix(&root.dir)
        .map(|p| {
            p.components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|_| {
            folder
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let key = format!(
        "image:{}|{}|{}x{}",
        root.dir.display(),
        within,
        width,
        height
    );
    let info = Series {
        catalog_revision: 0,
        source_revision: 0,
        id: String::new(),
        uid: crate::random::uuid_v5(&crate::random::NAMESPACE_URL, key.as_bytes()),
        study_uid: crate::random::uuid_v5(
            &crate::random::NAMESPACE_URL,
            format!("image-study:{}", root.dir.display()).as_bytes(),
        ),
        patient_key: String::new(),
        previous_pet_id: None,
        legacy_grid_ids: Vec::new(),
        study_scoped_patient_key: None,
        study_scoped_pet_id: None,
        patient_id: String::new(),
        patient_name: root.name.clone(),
        study_date: String::new(),
        description: if within.is_empty() {
            root.name.clone()
        } else {
            within
        },
        modality: "OT".into(),
        series_number: 0,
        dimensions: [width as usize, height as usize, 1],
        spacing: [1.; 3],
        origin: [0.; 3],
        direction: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
        window_center: 127.5,
        window_width: 255.,
        voi_function: None,
        window_from_pixels: false,
        value_unit: "RGB".into(),
        suv_factor: None,
        sul_factor: None,
        suv_bsa_factor: None,
        can_reconstruct: false,
        reading: None,
        warnings: vec![note!(
            "series.ordinaryImage",
            "Ordinary image: physical spacing and patient geometry are unavailable",
            // Which kind of picture, for the notice that says these are not DICOM.
            format = match path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .as_deref()
            {
                Some("jpg" | "jpeg") => "JPEG",
                Some("png") => "PNG",
                Some("bmp") => "BMP",
                _ => "",
            }
        )]
        .into(),
        photometric_interpretation: "RGB".into(),
        frame_of_reference_uid: String::new(),
        components: 3,
        pixel_type: "uint8".into(),
        spacing_known: false,
        orientation_known: false,
        patient_age: None,
        patient_sex: String::new(),
        echo_time: None,
        repetition_time: None,
        inversion_time: None,
        diffusion_b_value: None,
        acquisition: AcquisitionMetadata::default(),
        frame_metadata: Vec::new(),
        cine: None,
        phase: None,
        padding_range: None,
        segmentation: None,
        voi_luts: Vec::new(),
    };
    let frame = Frame {
        source,
        index: 0,
        cine: None,
        sop_uid: String::new(),
        instance_number: 0,
        geometry: FrameGeometry {
            position: None,
            orientation: None,
            pixel_spacing: None,
            slice_thickness: None,
        },
        slope: 1.,
        intercept: 0.,
        activity: None,
        ordinary_image: true,
        jpeg_component_threads: 0,
        raw_pixels: None,
        voi_lut: None,
        segmentation: None,
        phase_hints: Default::default(),
        metadata: frame_metadata(
            &FrameGeometry {
                position: None,
                orientation: None,
                pixel_spacing: None,
                slice_thickness: None,
            },
            Some(127.5),
            Some(255.),
            None,
        ),
    };
    Ok(vec![(GroupKey::whole(key), info, frame)])
}

#[cfg(test)]
fn read_frames(path: &Path) -> Result<Vec<(GroupKey, Series, Frame)>> {
    match read_frames_budget(
        path,
        &crate::import_budget::ImportBudget::default(),
        None,
        None,
        true,
    )? {
        IndexedFile::Images(frames) => Ok(frames),
        IndexedFile::Document(..) => Ok(Vec::new()),
    }
}
/// What a picture takes of the import's budget, as read_frames_budget takes it, while its size is still to be asked for.
fn reserve_picture(budget: &crate::import_budget::ImportBudget) -> Result<IndexedFile> {
    budget.check()?;
    budget.reserve_header(1, 0)?;
    budget.reserve_index(1, 4096)?;
    Ok(IndexedFile::Images(Vec::new()))
}
fn is_ordinary_image(path: &Path) -> bool {
    path.extension().is_some_and(|s| {
        matches!(
            s.to_string_lossy().to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "bmp"
        )
    })
}
/// Reads one file's frames. `reference` is what a media index says of the file, which the file has to agree with;
/// `on_media` says the file is the one on the media, opened through the media's root, and not a copy of it. A disc's
/// copy is DICOM whatever it is called: only a file the disc's index lists is copied under a picture's name.
fn read_frames_budget(
    path: &Path,
    budget: &crate::import_budget::ImportBudget,
    root: Option<&ImageRoot>,
    reference: Option<&crate::media_directory::Reference>,
    on_media: bool,
) -> Result<IndexedFile> {
    budget.check()?;
    if reference.is_none() && on_media && is_ordinary_image(path) {
        budget.reserve_header(1, 0)?;
        let ordinary = read_ordinary(path, root)?;
        budget.reserve_index(1, 4096 + ordinary[0].2.source.retained_bytes())?;
        return Ok(IndexedFile::Images(ordinary));
    }
    let (source, input, header) = match reference {
        Some(reference) if on_media => SourceFile::dicom_handle(
            path,
            crate::media_directory::open_referenced(&reference.root, path)?,
        )?,
        _ => SourceFile::dicom(path)?,
    };
    budget.reserve_index(1, source.retained_bytes())?;
    budget.reserve_header(input.frames, input.metadata_bytes)?;
    let obj = OpenFileOptions::new()
        .read_until(Tag(0x7fe0, 0x0008))
        .from_reader(header)?;
    if let Some(reference) = reference {
        ensure!(
            text(&obj, Tag(0x0008, 0x0016)) == reference.class
                && text(&obj, Tag(0x0008, 0x0018)) == reference.instance,
            "DICOMDIR reference does not match the source instance"
        );
    }
    let rows = number(&obj, Tag(0x0028, 0x0010)).unwrap_or(0.) as usize;
    let columns = number(&obj, Tag(0x0028, 0x0011)).unwrap_or(0.) as usize;
    let class = text(&obj, Tag(0x0008, 0x0016));
    if obj.meta().media_storage_sop_class_uid()
        == dicom_dictionary_std::uids::MEDIA_STORAGE_DIRECTORY_STORAGE
    {
        return Ok(IndexedFile::Images(Vec::new()));
    }
    if crate::export::document_record_type(&class).is_some() {
        let info = Series {
            uid: text(&obj, Tag(0x0020, 0x000e)),
            study_uid: text(&obj, Tag(0x0020, 0x000d)),
            patient_key: crate::patient::patient_key(&obj).digest(),
            patient_id: text(&obj, Tag(0x0010, 0x0020)),
            patient_name: text(&obj, Tag(0x0010, 0x0010)),
            study_date: text(&obj, Tag(0x0008, 0x0020)),
            series_number: number(&obj, Tag(0x0020, 0x0011)).unwrap_or_default() as i32,
            description: text(&obj, Tag(0x0008, 0x103e)),
            modality: text(&obj, Tag(0x0008, 0x0060)),
            ..Series::default()
        };
        if info.study_uid.is_empty() || info.uid.is_empty() {
            bail!(coded!(
                "file.missingUids",
                "Missing StudyInstanceUID or SeriesInstanceUID"
            ));
        }
        budget.reserve_index(
            1,
            2 * crate::import_budget::serialized_size(&info)?
                + path.as_os_str().as_encoded_bytes().len(),
        )?;
        return Ok(IndexedFile::Document(Box::new(info), source));
    }
    if rows == 0 || columns == 0 {
        bail!(coded!(
            "file.unsupportedObject",
            "DICOM object has no supported image or document (SOP Class {uid})",
            uid = class
        ));
    }

    if rows > 32768 || columns > 32768 {
        bail!(coded!(
            "file.dimensionsLimit",
            "Image dimensions exceed the supported limit"
        ));
    }
    let samples = number(&obj, Tag(0x0028, 0x0002)).unwrap_or(1.);
    if samples != 1. && samples != 3. {
        bail!(coded!(
            "file.unsupportedColor",
            "Only monochrome and three-component color DICOM are supported"
        ));
    }
    let bits = number(&obj, Tag(0x0028, 0x0101))
        .or_else(|| number(&obj, Tag(0x0028, 0x0100)))
        .unwrap_or(16.) as u32;
    let signed = number(&obj, Tag(0x0028, 0x0103)).unwrap_or(0.) == 1.;
    let frames = number(&obj, Tag(0x0028, 0x0008)).unwrap_or(1.) as usize;
    if frames == 0 || frames > MAX_FILES {
        bail!("Invalid or excessive NumberOfFrames");
    }
    let cine = crate::cine::FileCine::read(&obj, frames).map(Arc::new);
    if let Some(timing) = &cine {
        budget.reserve_index(1, timing.retained_bytes())?;
    }
    let modality = text(&obj, Tag(0x0008, 0x0060));
    let uid = text(&obj, Tag(0x0020, 0x000e));
    let study_uid = text(&obj, Tag(0x0020, 0x000d));
    if uid.is_empty() || study_uid.is_empty() {
        bail!(coded!(
            "file.missingUids",
            "Missing StudyInstanceUID or SeriesInstanceUID"
        ));
    }
    let patient_id = text(&obj, Tag(0x0010, 0x0020));
    let (patient, study_scoped) = crate::patient::patient_keys(&obj);
    let (patient_key, study_scoped_patient_key) =
        (patient.digest(), study_scoped.map(|key| key.digest()));
    let echo = text(&obj, Tag(0x0018, 0x0086));
    let (suv, pet_warnings) = if modality == "PT" {
        suv_factor(&obj)
    } else {
        (None, Vec::new())
    };
    let suv_factor = suv.map(|factors| factors.bw);
    let pet = (modality == "PT").then(|| pet_acquisition(&obj));
    let raw_unit = text(&obj, Tag(0x0028, 0x1054));
    // A gamma camera file: what each frame is, and where a reconstructed SPECT's slices lie. A quantitative SPECT
    // gives Bq/ml through a Real World Value Mapping (the NM Image Module's way) or, as some makers write it, PET's
    // Units. NM never has an SUV here: it records the dose in MBq, and nothing says what its values are decay-corrected
    // to.
    let camera = (modality == "NM").then(|| crate::gamma_camera::GammaCamera::read(&obj, frames));
    let activity = camera
        .is_some()
        .then(|| crate::gamma_camera::activity(&obj))
        .flatten()
        .map(Arc::new);
    let has_mapping = camera.is_some() && obj.get(Tag(0x0040, 0x9096)).is_some();
    let pet_units = text(&obj, Tag(0x0054, 0x1001));
    let value_unit = if modality == "PT" {
        pet_value_unit(&obj)
    } else if camera.is_some()
        && (activity.is_some() || (!has_mapping && text(&obj, Tag(0x0054, 0x1001)) == "BQML"))
    {
        "Bq/ml".into()
    } else if has_mapping {
        "a.u.".into()
    } else if !raw_unit.is_empty() {
        raw_unit
    } else if modality == "CT" {
        "HU".into()
    } else {
        "a.u.".into()
    };
    let segmentation = is_segmentation(&obj).then(|| Arc::new(segmentation(&obj)));
    if segmentation.is_some() && samples != 1. {
        bail!("A segmentation must have one sample per pixel");
    }
    let default_window = match (&segmentation, modality.as_str()) {
        (Some(_), _) => segment_window(&obj, bits),
        (None, "CT") => (40., 400.),
        (None, "PT") => suv_factor
            .filter(|v| *v > 0.)
            .map(|v| (5. / v, 10. / v))
            .unwrap_or((1000., 2000.)),
        _ => (500., 1000.),
    };
    // A VOI LUT shared by all frames (top level or shared functional group) is read once.
    let syntax = obj.meta().transfer_syntax();
    let little_endian = syntax != "1.2.840.10008.1.2.2";
    let jpeg_component_threads = match syntax {
        dicom_dictionary_std::uids::JPEG_BASELINE8_BIT
        | dicom_dictionary_std::uids::JPEG_EXTENDED12_BIT => samples as u8,
        _ => 0,
    };
    let frame_vois = obj
        .get(Tag(0x5200, 0x9230))
        .and_then(|element| element.items())
        .is_some_and(|groups| {
            groups.iter().any(|group| {
                group
                    .get(Tag(0x0028, 0x9132))
                    .and_then(|element| element.items())
                    .is_some_and(|items| {
                        items
                            .iter()
                            .any(|item| item.get(Tag(0x0028, 0x3010)).is_some())
                    })
            })
        });
    let shared_voi = if segmentation.is_none() && !frame_vois {
        crate::modality_lut::voi_lut(&obj, 0, little_endian).map(Arc::new)
    } else {
        None
    };
    let time_dimension = time_dimension(&obj);
    let mut result = Vec::new();
    let mut reserved_per_frame = 0usize;
    for index in 0..frames {
        budget.check()?;
        let position = [
            frame_group(&obj, index, false),
            frame_group(&obj, index, true),
        ]
        .into_iter()
        .flatten()
        .find_map(|group| {
            first(group, Tag(0x0020, 0x9113)).and_then(|v| numbers(v, Tag(0x0020, 0x0032)))
        })
        .or_else(|| {
            if frames == 1 {
                numbers(&obj, Tag(0x0020, 0x0032))
            } else {
                None
            }
        })
        .or_else(|| camera.as_ref().and_then(|camera| camera.position(index)));
        let orientation = frame_value(&obj, index, Tag(0x0020, 0x9116), |v| {
            numbers(v, Tag(0x0020, 0x0037))
        })
        .or_else(|| camera.as_ref().and_then(|camera| camera.orientation()));
        let pixel_spacing = frame_value(&obj, index, Tag(0x0028, 0x9110), |v| {
            numbers(v, Tag(0x0028, 0x0030))
        })
        .or_else(|| {
            if modality == "US" {
                ultrasound_spacing(&obj, rows, columns)
            } else {
                None
            }
        });
        // A projection radiograph measures with the spacing the DICOM rules give (projection.rs), named with it. A frame
        // placed in the patient by Image Orientation is a cross-section, even of a projection modality (a breast
        // tomosynthesis or XA 3D slice), and keeps its Pixel Spacing as before.
        let projection = if orientation.is_some_and(valid_orientation) {
            None
        } else {
            crate::projection::read(&obj, index, &modality)
        };
        let pixel_spacing = match &projection {
            Some(projection) => projection.spacing,
            None => pixel_spacing,
        };
        let slice_thickness = frame_value(&obj, index, Tag(0x0028, 0x9110), |v| {
            number(v, Tag(0x0018, 0x0050))
        });
        let rescale = |tag: Tag| frame_value(&obj, index, Tag(0x0028, 0x9145), |v| number(v, tag));
        let (slope_read, intercept_read) =
            (rescale(Tag(0x0028, 0x1053)), rescale(Tag(0x0028, 0x1052)));
        // A rescale the file holds that gives no number is not taken for 1 and 0, DICOM's values where there is none:
        // the values would look right and be wrong. Such an image keeps no unit (below), and the series says so. An
        // empty value is no rescale, as before.
        let held = |tag: Tag| {
            frame_value(&obj, index, Tag(0x0028, 0x9145), |v| nonempty_text(v, tag)).is_some()
        };
        let rescale_unread = (slope_read.is_none() && held(Tag(0x0028, 0x1053)))
            || (intercept_read.is_none() && held(Tag(0x0028, 0x1052)));
        let slope = slope_read.unwrap_or(1.);
        let intercept = intercept_read.unwrap_or(0.);
        let lut = if activity.is_some() {
            None
        } else {
            crate::modality_lut::descriptor(&obj, index)?
        };
        if lut.is_some()
            && (samples != 1.
                || !matches!(
                    text(&obj, Tag(0x0028, 0x0004)).as_str(),
                    "MONOCHROME1" | "MONOCHROME2"
                ))
        {
            bail!("Modality LUT requires a monochrome scalar image");
        }
        if activity.is_none() && lut.is_none() && slope == 0. {
            bail!("RescaleSlope is zero");
        }
        // A Modality LUT or a gamma camera's activity, not the rescale, gives these values.
        let rescale_unread = rescale_unread && activity.is_none() && lut.is_none();
        // A stored window is in the rescaled values: not for values whose rescale could not be read, which take a
        // window measured from their pixels (see `needs_pixel_window`).
        let window_center = frame_value(&obj, index, Tag(0x0028, 0x9132), |v| {
            first_number(v, Tag(0x0028, 0x1050))
        })
        .filter(|_| !rescale_unread);
        let window_width = frame_value(&obj, index, Tag(0x0028, 0x9132), |v| {
            first_number(v, Tag(0x0028, 0x1051))
        })
        .filter(|n| *n > 0. && !rescale_unread);
        // A stored window's own curve; LINEAR, absent or unknown values keep the linear window.
        let voi_function = window_width
            .and_then(|_| {
                frame_value(&obj, index, Tag(0x0028, 0x9132), |v| {
                    nonempty_text(v, Tag(0x0028, 0x1056))
                })
            })
            .and_then(|function| match function.to_ascii_uppercase().as_str() {
                "SIGMOID" => Some("SIGMOID"),
                "LINEAR_EXACT" => Some("LINEAR_EXACT"),
                _ => None,
            });
        // PS3.3 C.11.2.1.2-3 allows widths below one for SIGMOID and LINEAR_EXACT.
        let window_width = window_width.filter(|width| *width >= 1. || voi_function.is_some());
        let padding_is_nan = activity.is_some()
            || lut.is_some()
                && padding_range(
                    &obj,
                    index,
                    1.,
                    0.,
                    signed,
                    number(&obj, Tag(0x0028, 0x0100)).unwrap_or(bits as f64) as u32,
                )
                .is_some();
        let padding = if activity.is_some() || lut.is_some() {
            None
        } else {
            padding_range(
                &obj,
                index,
                slope,
                intercept,
                signed,
                number(&obj, Tag(0x0028, 0x0100)).unwrap_or(bits as f64) as u32,
            )
        };
        let value_unit = lut
            .as_ref()
            .map(|v| {
                if v.unit == "OD" {
                    "mOD".into()
                } else {
                    v.unit.clone()
                }
            })
            .unwrap_or_else(|| value_unit.clone());
        // Neither HU nor SUV for values whose rescale could not be read; their images make a series of their own (the
        // series key says so, whatever the unit was).
        let value_unit = if rescale_unread {
            "a.u.".into()
        } else {
            value_unit
        };
        let lut_suv_compatible = lut.as_ref().is_none_or(|v| v.unit == pet_units);
        let suv_usable = lut_suv_compatible && !rescale_unread;
        let mut warnings = crate::message::Notes::from(pet_warnings.clone());
        if rescale_unread {
            warnings.push(note!(
                "series.rescaleUnread",
                "The rescale values of these images cannot be read: the values shown are not HU or SUV"
            ));
        }
        if modality == "PT" && !lut_suv_compatible && suv_factor.is_some() {
            warnings.push(note!("series.suvLutUnits", "SUV conversion is unavailable because Modality LUT output units differ from the PET calibration units"));
        }
        if let Some(value) = projection
            .as_ref()
            .and_then(|projection| projection.ignored_magnification.clone())
        {
            warnings.push(note!(
                "projection.badMagnification",
                "Estimated Radiographic Magnification Factor {value} is not a magnification and was left out",
                value = value
            ));
        }
        // A gated SPECT's gate is its frame's time: each gate becomes a phase of its own, in the file's order.
        let gate = camera.as_ref().and_then(|camera| camera.gate(index));
        let explicit_temporal = gate
            .map(|(number, _)| f64::from(number))
            .or_else(|| {
                frame_value(&obj, index, Tag(0x0020, 0x9111), |i| {
                    number(i, Tag(0x0020, 0x9128))
                })
            })
            .or_else(|| number(&obj, Tag(0x0020, 0x0100)));
        let temporal = explicit_temporal.unwrap_or(0.);
        let (diffusion_b_value, gradient) = diffusion(&obj, index);
        let diffusion_key = diffusion_b_value.map(|b| {
            (
                (b * 100.).round() as i64,
                if b > 0. {
                    gradient.map(|v| v.map(|x| (x * 10000.).round() as i64))
                } else {
                    None
                },
            )
        });
        let echo_time = frame_value(&obj, index, Tag(0x0018, 0x9114), |v| {
            number(v, Tag(0x0018, 0x9082))
        })
        .or_else(|| number(&obj, Tag(0x0018, 0x0081)));
        let repetition_time = frame_value(&obj, index, Tag(0x0018, 0x9112), |v| {
            number(v, Tag(0x0018, 0x0080))
        });
        let inversion_time = frame_value(&obj, index, Tag(0x0018, 0x9115), |v| {
            first_number(v, Tag(0x0018, 0x9079))
        })
        .or_else(|| number(&obj, Tag(0x0018, 0x0082)));
        let acquisition = AcquisitionMetadata {
            pet_acquisition: pet.clone(),
            ..acquisition_metadata(&obj, index)
        };
        // A segmentation's frames repeat positions once per segment; they are not phases.
        let hints = if segmentation.is_some() {
            PhaseHints::default()
        } else {
            PhaseHints {
                gate: gate.map(|(_, gate)| gate),
                ..phase_hints(&obj, index, explicit_temporal, time_dimension, &acquisition)
            }
        };
        let image_type = &acquisition.image_type;
        // Images whose rescale could not be read are never in a series with those whose rescale could, whatever their
        // unit: their series alone says so.
        let unread = if rescale_unread {
            "|rescale=unread"
        } else {
            ""
        };
        // The gates of a gated SPECT are phases of the one acquisition its file holds: another file's gates, in the
        // same series or gated otherwise, are another family, never part of these volumes.
        let gated_file = gate
            .map(|_| {
                let instance = text(&obj, Tag(0x0008, 0x0018));
                let file = if instance.is_empty() {
                    path.display().to_string()
                } else {
                    instance
                };
                format!("|gated={file}")
            })
            .unwrap_or_default();
        let orientation_key = orientation.map(|v| v.map(|x| (x * 10000.).round() as i64));
        let reference = text(&obj, Tag(0x0020, 0x0052));
        let photometric = text(&obj, Tag(0x0028, 0x0004));
        let segmentation_instance = segmentation
            .as_ref()
            .map(|_| format!("SEG|{}", text(&obj, Tag(0x0008, 0x0018))))
            .unwrap_or_default();
        let key = GroupKey {
            head: format!(
                "{patient_key}|{study_uid}|{uid}|{rows}|{columns}|{orientation_key:?}|{}",
                segmentation_instance
            ),
            stack: format!(
                "{patient_key}|{study_uid}|{uid}|{rows}|{columns}|{}",
                segmentation_instance
            ),
            temporal: temporal.to_string(),
            tail: format!(
                "|{echo}|{echo_time:?}|{image_type}|{reference}|{samples}|{photometric}|{diffusion_key:?}|{repetition_time:?}|{inversion_time:?}|{}|{}|{}|{}|{:?}|unit={value_unit}{unread}{gated_file}",
                acquisition.acquisition_contrast,
                acquisition.contrast_bolus_phase,
                acquisition.contrast_bolus_administered,
                acquisition.contrast_bolus_detected,
                acquisition.flip_angle
            ),
        };
        // Keep the original grouping key. Only GML establishes a stored unit of g/ml.
        let value_unit = match (modality.as_str(), value_unit.as_str()) {
            ("PT", "GML") if lut_suv_compatible => pet_value_unit(&obj),
            ("PT", "GML") => "g/ml".into(),
            ("PT", unit)
                if crate::model::is_suv_unit(unit)
                    && (pet_units != "GML" || !lut_suv_compatible) =>
            {
                "a.u.".into()
            }
            _ => value_unit,
        };
        let info = Series {
            catalog_revision: 0,
            source_revision: 0,
            id: String::new(),
            uid: uid.clone(),
            study_uid: study_uid.clone(),
            patient_key: patient_key.clone(),
            previous_pet_id: None,
            legacy_grid_ids: Vec::new(),
            study_scoped_patient_key: study_scoped_patient_key.clone(),
            study_scoped_pet_id: None,
            patient_id: patient_id.clone(),
            patient_name: text(&obj, Tag(0x0010, 0x0010)),
            study_date: text(&obj, Tag(0x0008, 0x0020)),
            description: text(&obj, Tag(0x0008, 0x103e)),
            modality: modality.clone(),
            series_number: number(&obj, Tag(0x0020, 0x0011)).unwrap_or(0.) as i32,
            dimensions: [columns, rows, 1],
            spacing: [1., 1., 1.],
            origin: [0.; 3],
            direction: [1., 0., 0., 0., 1., 0., 0., 0., 1.],
            window_center: window_center.unwrap_or(default_window.0),
            window_width: window_width.unwrap_or(default_window.1),
            voi_function: window_width.and(voi_function),
            value_unit,
            suv_factor: if suv_usable { suv_factor } else { None },
            sul_factor: suv.and_then(|factors| factors.lbm).filter(|_| suv_usable),
            suv_bsa_factor: suv.and_then(|factors| factors.bsa).filter(|_| suv_usable),
            can_reconstruct: false,
            reading: None,
            warnings,
            photometric_interpretation: text(&obj, Tag(0x0028, 0x0004)),
            frame_of_reference_uid: text(&obj, Tag(0x0020, 0x0052)),
            components: if photometric == "PALETTE COLOR" && segmentation.is_none() {
                3
            } else {
                samples as u8
            },
            pixel_type: if segmentation.is_some() {
                // Masks, fractions or segment numbers: never rescaled.
                if bits <= 8 { "uint8" } else { "uint16" }.into()
            } else if samples == 3. || photometric == "PALETTE COLOR" {
                "uint8".into()
            } else if activity.is_some() {
                "float32".into()
            } else if lut.is_some() {
                if padding_is_nan {
                    "float32".into()
                } else {
                    "uint16".into()
                }
            } else {
                storage_type(bits, signed, slope, intercept).into()
            },
            spacing_known: pixel_spacing.is_some_and(|s| s.iter().all(|v| *v > 0.)),
            orientation_known: orientation.is_some_and(valid_orientation),
            patient_age: age_years(&text(&obj, Tag(0x0010, 0x1010))),
            patient_sex: text(&obj, Tag(0x0010, 0x0040)),
            echo_time,
            repetition_time,
            inversion_time,
            diffusion_b_value,
            acquisition,
            frame_metadata: Vec::new(),
            cine: None,
            phase: None,
            padding_range: padding,
            window_from_pixels: false,
            // Moved here from the frames once the series is grouped (see `import`), so
            // one copy is held per series rather than per frame.
            segmentation: None,
            voi_luts: Vec::new(),
        };
        let mut metadata = frame_metadata(
            &FrameGeometry {
                position,
                orientation,
                pixel_spacing,
                slice_thickness,
            },
            window_center,
            window_width,
            padding,
        );
        metadata.instance_number = number(&obj, Tag(0x0020, 0x0013))
            .filter(|n| n.fract() == 0. && *n >= i32::MIN as f64 && *n <= i32::MAX as f64)
            .map(|n| n as i32);
        metadata.padding_is_nan = padding_is_nan;
        metadata.voi_function = voi_function;
        metadata.nm = camera.as_ref().and_then(|camera| camera.frame(index));
        metadata.projection = projection;
        metadata.sop_instance_uid = text(&obj, Tag(0x0008, 0x0018));
        metadata.source_frame_number = (frames > 1).then_some(index as u32 + 1);
        if segmentation.is_some() {
            metadata.segment_number = frame_value(&obj, index, Tag(0x0062, 0x000a), |v| {
                number(v, Tag(0x0062, 0x000b))
            })
            .filter(|n| n.fract() == 0. && *n >= 1. && *n <= u16::MAX as f64)
            .map(|n| n as u16);
            if let Some((uid, frame)) = frame_value(&obj, index, Tag(0x0008, 0x9124), |v| {
                first(v, Tag(0x0008, 0x2112)).map(|source| {
                    (
                        text(source, Tag(0x0008, 0x1155)),
                        number(source, Tag(0x0008, 0x1160)),
                    )
                })
            }) {
                metadata.referenced_sop_instance_uid = hint_text(&uid);
                metadata.referenced_frame_number = frame
                    .filter(|n| n.fract() == 0. && *n >= 1. && *n <= u32::MAX as f64)
                    .map(|n| n as u32);
            }
        }
        let voi_lut = if frame_vois && segmentation.is_none() {
            crate::modality_lut::voi_lut(&obj, index, little_endian).map(Arc::new)
        } else {
            shared_voi.clone()
        };
        let raw_pixels = input.raw_pixels.and_then(|raw| {
            let label_map =
                segmentation.is_some() && info.photometric_interpretation == "PALETTE COLOR";
            let scalar_photo = label_map
                || matches!(
                    info.photometric_interpretation.as_str(),
                    "MONOCHROME1" | "MONOCHROME2"
                );
            if !scalar_photo
                || activity.is_some()
                || lut.is_some()
                || padding_is_nan
                || raw.samples != 1
                || raw.rows as usize != rows
                || raw.columns as usize != columns
                || raw.frames as usize != frames
                || (raw.big_endian && raw.bits_allocated == 16 && !raw.word_vr)
            {
                return None;
            }
            let bytes_per_sample = usize::from(raw.bits_allocated / 8);
            let frame_bytes = rows.checked_mul(columns)?.checked_mul(bytes_per_sample)?;
            let frame_rel = (index as u64).checked_mul(frame_bytes as u64)?;
            let frame_end_rel = frame_rel.checked_add(frame_bytes as u64)?;
            if frame_end_rel > raw.length {
                return None;
            }
            let offset = raw.offset.checked_add(frame_rel)?;
            if offset.checked_add(frame_bytes as u64)? > source.len {
                return None;
            }
            Some(crate::model::RawPixelLayout {
                offset,
                byte_len: frame_bytes,
                bits_allocated: raw.bits_allocated as u8,
                bits_stored: raw.bits_stored as u8,
                high_bit: raw.high_bit as u8,
                signed: raw.signed,
                big_endian: raw.big_endian,
            })
        });
        let frame = Frame {
            source: source.clone(),
            index: index as u32,
            cine: cine.clone(),
            sop_uid: text(&obj, Tag(0x0008, 0x0018)),
            instance_number: number(&obj, Tag(0x0020, 0x0013)).unwrap_or(0.) as i32,
            geometry: FrameGeometry {
                position,
                orientation,
                pixel_spacing,
                slice_thickness,
            },
            slope,
            intercept,
            activity: activity.clone(),
            ordinary_image: false,
            jpeg_component_threads,
            raw_pixels,
            phase_hints: hints,
            voi_lut,
            segmentation: segmentation.clone(),
            metadata,
        };
        let retained = crate::import_budget::serialized_size(&info)?
            .checked_add(crate::import_budget::serialized_size(&frame.metadata)?)
            .and_then(|n| n.checked_mul(2))
            .and_then(|n| {
                n.checked_add(
                    std::mem::size_of::<(GroupKey, Series, Frame)>()
                        + key.len()
                        + path.as_os_str().as_encoded_bytes().len()
                        + frame.sop_uid.len()
                        + frame.phase_hints.heap_bytes()
                        + if frame_vois {
                            frame.voi_lut.as_ref().map_or(0, |lut| lut.data.len() * 12)
                        } else {
                            0
                        },
                )
            })
            .context("Frame metadata size overflow")?;
        if index == 0 {
            if let Some(mapping) = &activity {
                budget.reserve_index(1, mapping.heap_bytes())?;
            }
            if let Some(lut) = &shared_voi {
                // Shared by every frame of the file and kept once per series.
                budget.reserve_index(
                    1,
                    crate::import_budget::serialized_size(&**lut)?.saturating_mul(2),
                )?;
            }
            if let Some(segmentation) = &segmentation {
                // Shared by every frame of the file and kept once per series.
                budget.reserve_index(
                    1,
                    crate::import_budget::serialized_size(&**segmentation)?.saturating_mul(2),
                )?;
            }
            budget.reserve_index(frames, retained)?;
            result
                .try_reserve_exact(frames)
                .context("Cannot reserve bounded frame metadata")?;
            reserved_per_frame = retained;
        } else if retained > reserved_per_frame {
            budget.reserve_index(1, retained - reserved_per_frame)?;
        }
        result.push((key, info, frame));
    }
    Ok(IndexedFile::Images(result))
}

/// A series gets a window measured from its pixels only when none of its frames
/// stores one, no VOI LUT applies, and its modality has no calibrated default
/// (CT in Hounsfield units, PET with an SUV factor). A CT whose rescale could not be
/// read has no Hounsfield units, so it is measured too.
fn needs_pixel_window(source: &SourceSeries) -> bool {
    let info = &source.info;
    let unread = (info.warnings.iter()).any(|note| note.code == "series.rescaleUnread");
    info.segmentation.is_none()
        && info.components == 1
        && matches!(
            info.photometric_interpretation.as_str(),
            "MONOCHROME1" | "MONOCHROME2"
        )
        && (info.modality != "CT" || unread)
        && !(info.modality == "PT" && info.suv_factor.is_some_and(|v| v > 0.))
        && !source.frames.is_empty()
        && source.frames.iter().all(|f| !f.ordinary_image)
        && info
            .frame_metadata
            .iter()
            .all(|f| f.voi_lut.is_none() && f.window_width.is_none())
}

/// The window of the middle frame's pixels (see `display_window`). A frame that cannot
/// be decoded keeps the modality default; opening it reports the error.
fn pixel_window(source: &SourceSeries, index: usize) -> Option<(f64, f64)> {
    let pixels = crate::decode::decode_frame(source, index).ok()?;
    let metadata = &source.frames[index].metadata;
    let padding = metadata.padding_range;
    let padding_is_nan = metadata.padding_is_nan;
    display_window((0..pixels.len()).map(|i| pixels.value(i)).filter(|value| {
        !(padding_is_nan && value.is_nan())
            && !padding.is_some_and(|[low, high]| *value >= low && *value <= high)
    }))
}

/// A display window for pixels that come with none: the 1st to 99th percentile of the
/// values, leaving out the lowest value (background, as VEAcom 1.x's auto window does)
/// and the highest (burned-in labels and saturation; a digitized mammogram holds 2% of
/// its pixels at 65535) while enough values remain. Returns (center, width).
pub fn display_window(values: impl Iterator<Item = f64> + Clone) -> Option<(f64, f64)> {
    const BINS: usize = 65536;
    let (mut low, mut high, mut count) = (f64::INFINITY, f64::NEG_INFINITY, 0usize);
    for value in values.clone().filter(|v| v.is_finite()) {
        low = low.min(value);
        high = high.max(value);
        count += 1;
    }
    if count == 0 {
        return None;
    }
    if high <= low {
        return Some((low, 1.));
    }
    // Integer data within 65536 values fall one value to a bin; wider or fractional
    // data fall into equal bins across the range.
    let integral =
        high - low < BINS as f64 && values.clone().all(|v| !v.is_finite() || v.fract() == 0.);
    let step = if integral {
        1.
    } else {
        (high - low) / (BINS - 1) as f64
    };
    let mut histogram = vec![0usize; BINS];
    for value in values.filter(|v| v.is_finite()) {
        histogram[(((value - low) / step) as usize).min(BINS - 1)] += 1;
    }
    let last = (((high - low) / step) as usize).min(BINS - 1);
    let inner = count - histogram[0] - histogram[last];
    let (first, end, kept) = if inner >= 16 {
        (1, last, inner)
    } else {
        (0, last + 1, count)
    };
    let percentile = |fraction: f64| {
        let target = ((kept - 1) as f64 * fraction).round() as usize;
        let mut seen = 0;
        for (bin, count) in histogram.iter().enumerate().take(end).skip(first) {
            seen += count;
            if seen > target {
                return low + bin as f64 * step;
            }
        }
        low + (end - 1) as f64 * step
    };
    let (bottom, top) = (percentile(0.01), percentile(0.99));
    Some(((bottom + top) / 2., (top - bottom).max(1.)))
}

/// `import_session` without early series, at source revision 0: for the tests, the desktop transport's among them
/// (which build this library without `cfg(test)`).
pub fn import(paths: &[String]) -> Result<Imported> {
    import_session(paths, None, 0, &[])
}

/// What an import hands over before it ends (see `import_with`).
pub enum HandOver {
    /// Series it can show while it reads the rest.
    Series(Vec<Arc<SourceSeries>>),
    /// The series that the DICOMDIRs of the discs it reads once list, before their images are read.
    Plan(Arc<Plan>),
    /// A picture for a series of the plan, before the series is read whole: the series as made from its middle file
    /// alone, which is copied ahead of the others (see `plan_spool`). Its id is its own, and nothing but its card
    /// shows it.
    Preview {
        /// The series' place in the plan.
        planned: usize,
        series: Arc<SourceSeries>,
    },
}

/// Where an import hands over what it can show before it ends (see `import_with`).
pub type EarlySink<'a> = &'a (dyn Fn(HandOver) + Sync);

/// The series that the DICOMDIRs of the discs an import reads once list (see `plan_spool`), known before any of their
/// images is read, and how far the import is with each one's files. The index only says what is coming: every series
/// the import gives is made from its own files.
pub struct Plan {
    series: Vec<crate::model::PlannedSeries>,
    finished: Vec<std::sync::atomic::AtomicUsize>,
    /// The series the viewer asked for (see `want`), the last one asked for first.
    wanted: std::sync::Mutex<Vec<usize>>,
}

impl Plan {
    pub fn new(series: Vec<crate::model::PlannedSeries>) -> Self {
        let finished = series.iter().map(|_| Default::default()).collect();
        let wanted = Default::default();
        Self {
            series,
            finished,
            wanted,
        }
    }
    /// Has the files of the plan's series `series` read next, before every other file the import has still to read,
    /// and the series handed over as far as it is read, again as it grows (see PlanWatch): the series the viewer
    /// opened. The series asked for last goes first. False when the plan has no such series.
    pub fn want(&self, series: usize) -> bool {
        if series >= self.series.len() {
            return false;
        }
        let mut wanted = self.wanted.lock().unwrap();
        wanted.retain(|&other| other != series);
        wanted.insert(0, series);
        true
    }
    fn wanted(&self) -> Vec<usize> {
        self.wanted.lock().unwrap().clone()
    }
    /// The series as they stand.
    pub fn series(&self) -> Vec<crate::model::PlannedSeries> {
        let stand = |(series, finished): (
            &crate::model::PlannedSeries,
            &std::sync::atomic::AtomicUsize,
        )| {
            crate::model::PlannedSeries {
                finished: finished.load(std::sync::atomic::Ordering::Relaxed),
                ..series.clone()
            }
        };
        self.series.iter().zip(&self.finished).map(stand).collect()
    }
    /// How many files of each series are finished with, in the plan's order: what changes as the import goes on.
    pub fn finished(&self) -> Vec<usize> {
        let count = |finished: &std::sync::atomic::AtomicUsize| {
            finished.load(std::sync::atomic::Ordering::Relaxed)
        };
        self.finished.iter().map(count).collect()
    }
}

/// Imports `paths` as `import` does. An archive's entries are read while the archive is still being extracted, each
/// once it is written whole, rather than after the last one; the extraction checks every entry as it did.
///
/// With `early`, series are also handed over while the import is still reading: a series goes once every folder that
/// holds its files has been read whole and no file read elsewhere belongs to it, so the viewer can open the first
/// series of a large study before the last folder is read. Such a series is provisional (one whose files are spread
/// over folders read far apart could still grow): the catalogue returned is built from every file exactly as without
/// `early`, and it is the final word. Pictures (PNG, JPEG, BMP) and segmentations are never handed over early: whether
/// pictures count depends on the whole import, and a segmentation is drawn over its image series. A disc that is read
/// once hands over the series its DICOMDIR lists first, before any of their images is read (see `Plan`).
#[cfg(test)]
pub fn import_with(paths: &[String], early: Option<EarlySink>) -> Result<Imported> {
    import_session(paths, early, 0, &[])
}

/// A ZIP import extracts a file with a .zip extension.
pub fn is_zip_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
        && fs::is_file(path)
}

/// `earlier` are the copies earlier imports of this session made of their discs, kept still (see `DiscCopy`).
pub fn import_session(
    paths: &[String],
    early: Option<EarlySink>,
    revision: u64,
    earlier: &[DiscCopy],
) -> Result<Imported> {
    import_session_from(paths, early, revision, &read_once, earlier)
}

/// `import_session`, with `read_once` saying which disc a selection is on, if it is on one that can be read once into
/// a private copy: a disc's, for the engine (see `read_once`); a test's own choice.
pub fn import_session_from(
    paths: &[String],
    early: Option<EarlySink>,
    revision: u64,
    read_once: &dyn Fn(&Path) -> Option<Disc>,
    earlier: &[DiscCopy],
) -> Result<Imported> {
    if paths.is_empty() {
        bail!(coded!(
            "import.chooseFiles",
            "Choose DICOM files, a folder, or a ZIP archive"
        ));
    }
    // The disc each selection is read once from, if any: a folder, or a DICOMDIR's folder (see plan_spool). Every
    // selection on a disc but an archive counts for discs_read_once, a loose file among them.
    let on_disc: Vec<Option<Disc>> = paths
        .iter()
        .map(|raw| {
            Some(Path::new(raw))
                .filter(|path| !is_zip_file(path))
                .and_then(read_once)
        })
        .collect();
    let room_then = room();
    let discs = discs_read_once(&on_disc, room_then);
    // What the import's discs and archives take of that room, as each is planned: an archive is planned on what the
    // ones before it leave.
    let mut taken: u64 = (discs.iter().flatten())
        .filter(|disc| disc.serial.is_some())
        .map(|disc| disc.size)
        .sum();
    let mut files = Vec::new();
    let mut media_files = HashMap::new();
    let mut archives = Vec::new();
    // Each archive still to extract: its file, its extraction folder, and the entries of it that are read.
    let mut extractions: Vec<(PathBuf, PathBuf, Vec<PathBuf>)> = Vec::new();
    // The discs that are read once, what planning them found to say, and the series their DICOMDIRs list.
    let mut spools: Vec<Spool> = Vec::new();
    let mut noted = Vec::new();
    let mut planned = Vec::new();
    // Which opened folder or archive each ordinary image came from (see ImageRoot).
    let mut roots: HashMap<PathBuf, Arc<ImageRoot>> = HashMap::new();
    for (raw, disc) in paths.iter().zip(discs) {
        crate::progress::check()?;
        let path = Path::new(raw);
        if !fs::exists(path) {
            bail!(coded!(
                "import.pathMissing",
                "Selected path does not exist: {path}",
                path = path.display().to_string()
            ));
        }
        let before = files.len();
        let root = if is_zip_file(path) {
            let room = room_then.map(|room| room.saturating_sub(taken));
            let (dir, entries, listed) = plan_zip_within(path, available_archive_bytes(), room)?;
            taken = taken.saturating_add(listed);
            files.extend(entries.iter().cloned());
            let root = ImageRoot::new(dir.path(), path.file_stem());
            extractions.push((path.to_owned(), dir.path().to_owned(), entries));
            archives.push(dir);
            root
        } else if path
            .extension()
            .is_some_and(|x| x.eq_ignore_ascii_case("rar"))
        {
            bail!(coded!(
                "rar.unsupported",
                "RAR archives cannot be opened. Extract the archive, then open the folder."
            ));
        } else if fs::is_file(path)
            && path
                .file_name()
                .is_some_and(|x| x.eq_ignore_ascii_case("DICOMDIR"))
        {
            let parent = path.parent().context("DICOMDIR has no parent directory")?;
            if let Some(disc) = disc {
                let (dir, spool) = plan_spool(
                    parent,
                    Some(path),
                    DiscToRead { disc, earlier },
                    &mut files,
                    &mut media_files,
                    &mut planned,
                    &mut noted,
                )?;
                archives.push(dir);
                spools.push(spool);
            } else {
                let root = fs::canonicalize(parent)?;
                for (path, reference) in crate::media_directory::references(path, &root)? {
                    if let Some(previous) = media_files.get(&path) {
                        ensure!(
                            reference.agrees_with(previous),
                            "Conflicting DICOMDIR references to the same file"
                        );
                    }
                    media_files.insert(path.clone(), reference);
                    files.push(path);
                    ensure!(files.len() <= MAX_FILES, "Too many referenced DICOM files");
                }
            }
            ImageRoot::new(parent, parent.file_name())
        } else if fs::is_file(path) {
            collect_files(path, &mut files)?;
            // A loose file belongs to its folder (collect_files keeps it canonical).
            let folder = files
                .last()
                .and_then(|file| file.parent())
                .unwrap_or(Path::new(""))
                .to_owned();
            ImageRoot::new(&folder, folder.file_name())
        } else {
            if let Some(disc) = disc {
                let (dir, spool) = plan_spool(
                    path,
                    None,
                    DiscToRead { disc, earlier },
                    &mut files,
                    &mut media_files,
                    &mut planned,
                    &mut noted,
                )?;
                archives.push(dir);
                spools.push(spool);
            } else {
                collect_files(path, &mut files)?;
            }
            ImageRoot::new(path, path.file_name())
        };
        for file in files[before..]
            .iter()
            .filter(|file| is_ordinary_image(file))
        {
            roots.entry(file.clone()).or_insert_with(|| root.clone());
        }
    }
    // The discs' series go to the viewer before any of their images is read.
    let plan = (!planned.is_empty()).then(|| Arc::new(Plan::new(planned)));
    if let (Some(sink), Some(plan)) = (early, &plan) {
        sink(HandOver::Plan(plan.clone()));
    }
    files.sort();
    files.dedup();
    crate::progress::set_stage("indexing", files.len());
    let budget = crate::import_budget::ImportBudget::default();
    let slot_of: HashMap<&Path, usize> = files
        .iter()
        .enumerate()
        .map(|(index, file)| (file.as_path(), index))
        .collect();
    let spooled = || spools.iter().flat_map(|spool| &spool.files);
    // An archive's sidecar files are told apart once written, as a folder's are while it is listed (collect_files).
    let archived: HashSet<usize> = extractions
        .iter()
        .flat_map(|(_, _, entries)| entries.iter())
        .chain(spooled().map(|file| &file.to))
        .map(|entry| slot_of[entry.as_path()])
        .collect();
    // A disc's copies are opened as files of this computer, not through the disc's media root.
    let copied: HashSet<&Path> = spooled().map(|file| file.to.as_path()).collect();
    // Each file's series in the plan, by its place among `files`; a file that is finished with counts in its series.
    let mut planned_of = vec![None; files.len()];
    for file in spooled() {
        planned_of[slot_of[file.to.as_path()]] = file.series;
    }
    // After the file's slot is set: a count read with Acquire says the slots of that many files are (see PlanWatch).
    let finish = |index: usize| {
        if let (Some(plan), Some(series)) = (&plan, planned_of[index]) {
            plan.finished[series].fetch_add(1, std::sync::atomic::Ordering::Release);
        }
    };
    // The plan's series that have a middle file copied ahead, with that file's place among `files` (see PreviewWatch).
    let middles: Vec<(usize, usize)> = spooled()
        .filter(|file| file.first)
        .filter_map(|file| Some((file.series?, slot_of[file.to.as_path()])))
        .collect();
    // Each series of the plan with its files' places among `files` (see PlanWatch).
    let mut plan_files = vec![Vec::new(); plan.as_ref().map_or(0, |plan| plan.series.len())];
    for file in spooled() {
        if let Some(series) = file.series {
            plan_files[series].push(slot_of[file.to.as_path()]);
        }
    }
    // A picture only takes its share of the budget here: its size is asked for below, once it is known that no file
    // held DICOM (beside DICOM, pictures are not series: see catalogue).
    // A disc's copy is DICOM whatever it is called: only files its index lists are copied under a picture's name (a
    // listed IM1.JPG); the disc's other pictures are read where they are (see `plan_spool`).
    let read_one = |path: &Path| {
        if is_ordinary_image(path) && !media_files.contains_key(path) && !copied.contains(path) {
            return crate::progress::check().and_then(|_| reserve_picture(&budget));
        }
        let result = crate::progress::check().and_then(|_| {
            read_frames_budget(
                path,
                &budget,
                roots.get(path).map(|root| root.as_ref()),
                media_files.get(path),
                !copied.contains(path),
            )
        });
        let step = crate::progress::step();
        step.and(result)
    };
    let slots: Vec<Slot> = files.iter().map(|_| OnceLock::new()).collect();
    let read_slot = |index: usize| {
        let path = files[index].as_path();
        // What an index lists is read whatever it is called.
        let listed = media_files.contains_key(path);
        let result = if archived.contains(&index) && !listed && !is_candidate(path) {
            let _ = crate::progress::step();
            None
        } else {
            Some(read_one(path))
        };
        let _ = slots[index].set(result);
        finish(index);
    };
    // Entries that landed where the plan did not expect them (a name the central directory spells differently):
    // read once the extraction ends, as every extracted file was before.
    let unplanned = std::sync::Mutex::new(Vec::new());
    let (send, receive) = std::sync::mpsc::channel::<usize>();
    // A folder's files are ready now; an archive's as each is extracted, in the archive's own order.
    for index in (0..files.len()).filter(|index| !archived.contains(index)) {
        let _ = send.send(index);
    }
    let (extractions_ref, slot_of_ref, unplanned_ref) = (&extractions, &slot_of, &unplanned);
    // The DICOM files that a disc's index does not list and that were copied all the same.
    let unlisted = std::sync::atomic::AtomicUsize::new(0);
    let (spools_ref, slots_ref, unlisted_ref, finish_ref) = (&spools, &slots, &unlisted, &finish);
    // The discs taken out of their drives (or replaced) before they were read whole.
    let removed: Vec<std::sync::atomic::AtomicBool> =
        spools.iter().map(|_| Default::default()).collect();
    let (plan_ref, removed_ref) = (&plan, &removed);
    let extract = move || -> Result<()> {
        for (archive, dir, _) in extractions_ref {
            extract_zip_into(archive, dir, available_archive_bytes(), &mut |target| {
                match slot_of_ref.get(target) {
                    Some(&index) => {
                        let _ = send.send(index);
                    }
                    None if !hidden_entry(dir, target) => {
                        unplanned_ref.lock().unwrap().push(target.to_owned())
                    }
                    None => {}
                }
            })?;
        }
        // The discs, after the archives: one reader on a disc, each file once, in the order planned but for the series
        // the viewer asks for (SpoolQueue).
        let mut block = vec![0; 1 << 20];
        for (spool, removed) in spools_ref.iter().zip(removed_ref) {
            // The copies take no more than the disc says it holds.
            let mut allowance = spool.disc.size;
            let mut queue = SpoolQueue::new(&spool.files);
            // A disc taken out (or replaced) before it is read whole is read no further. With an index, the series it
            // lists that were read whole stay (see `whole_series`); without one there is no telling which those are,
            // and the import stops.
            let gone = || -> Result<()> {
                if !spool.planned() {
                    return Err(disc_removed());
                }
                removed.store(true, std::sync::atomic::Ordering::Relaxed);
                Ok(())
            };
            // The disc in the drive is the one planned before anything is taken from it: another may have been put in
            // its place while the import read something else (an archive, another disc).
            if !spool.same_disc() {
                gone()?;
                continue;
            }
            // When the disc was last found in its drive. A file opened less than DISC_LOOK_EVERY after that is the
            // disc's own: no other disc can be in the drive yet.
            let mut looked = std::time::Instant::now();
            while let Some(at) = queue.next(plan_ref.as_deref()) {
                let file = &spool.files[at];
                crate::progress::check()?;
                // Every second, the disc in the drive is still the one being read: another put in its place could
                // give files of the same names.
                if looked.elapsed() >= DISC_LOOK_EVERY {
                    if !spool.same_disc() {
                        gone()?;
                        break;
                    }
                    looked = std::time::Instant::now();
                }
                // The copies leave this computer room: if something else fills its disk meanwhile, the import stops.
                if spool.disc.serial.is_some() && room().is_some_and(|room| room < SPARE_BYTES / 2)
                {
                    bail!(coded!(
                        "import.noRoom",
                        "This computer's disk is nearly full, so the disc was not read whole."
                    ));
                }
                let index = slot_of_ref[file.to.as_path()];
                let most = crate::input_guard::MAX_FILE_SIZE;
                match copy_from_disc(file, most, &mut allowance, &mut block)? {
                    Copied::Whole => {
                        // A copy that took the disc's turn to be looked for is taken only once the disc is found
                        // still in the drive: one put in its place while the copy was made could have given it.
                        if looked.elapsed() >= DISC_LOOK_EVERY {
                            if !keep_copy(file, || spool.same_disc())? {
                                gone()?;
                                break;
                            }
                            looked = std::time::Instant::now();
                        }
                        let unlisted =
                            matches!(file.take, Take::IfDicom | Take::Kept { unlisted: true });
                        if spool.indexed && unlisted {
                            unlisted_ref.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        }
                        let _ = send.send(index);
                    }
                    Copied::NotDicom => {
                        let _ = slots_ref[index].set(None);
                        finish_ref(index);
                        let _ = crate::progress::step();
                    }
                    // A file the disc does not give fails alone, as an unreadable file of a folder does, and counts
                    // as read. With the disc gone (or another in its place) there is no more to wait for: this file is
                    // not counted, and its series is not read whole.
                    Copied::Unreadable(error) => {
                        if !fs::exists(&spool.folder) || !spool.same_disc() {
                            gone()?;
                            break;
                        }
                        let _ = slots_ref[index].set(Some(Err(error)));
                        finish_ref(index);
                        let _ = crate::progress::step();
                    }
                }
            }
        }
        Ok(())
    };
    let read_all = move || {
        crate::parallel::for_each(
            "dicom-index",
            index_readers(),
            receive.into_iter(),
            read_slot,
        )
    };
    // WebAssembly cannot start a thread of its own: there the archives are extracted first and the files read after
    // (on the threads the page lends, parallel.rs), and no series is published early.
    let extracted = if cfg!(target_arch = "wasm32") {
        extract()?;
        // The sender goes with the extraction, so the reading ends after the last file.
        drop(extract);
        read_all();
        Ok(())
    } else {
        std::thread::scope(|scope| -> Result<()> {
            let extraction = scope.spawn(extract);
            // Says when the reading is over (or has failed: the sender goes with the thread), so the watch below stops at
            // once rather than at the end of its next pause, which would hold up the catalogue.
            let (over, reading_over) = std::sync::mpsc::channel::<()>();
            let reading = scope.spawn(move || {
                let _over = over;
                read_all();
            });
            if let Some(sink) = early {
                let mut watch = EarlyWatch::new(&files);
                // The plan's series go by their files (PlanWatch), not by their folders, and their pictures before them.
                let mut planned = plan.as_ref().map(|plan| {
                    let previews = PreviewWatch::new(middles, plan.series.len());
                    (plan, previews, PlanWatch::new(plan_files))
                });
                if let Some((plan, _, _)) = &planned {
                    watch.planned = plan
                        .series
                        .iter()
                        .map(|series| series.uid.clone())
                        .collect();
                }
                let mut look = |watch: &mut EarlyWatch| {
                    if let Some((plan, previews, series)) = &mut planned {
                        previews.publish(plan, &files, &slots, sink, revision);
                        series.publish(plan, &previews.windows, &files, &slots, sink, revision);
                    }
                    watch.publish(&files, &slots, sink, revision);
                };
                while let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                    reading_over.recv_timeout(std::time::Duration::from_millis(20))
                {
                    look(&mut watch);
                }
                // Tests read small studies before the first look: one more, so they see the hand-over too.
                #[cfg(test)]
                look(&mut watch);
            }
            let reading = reading.join();
            let extracted = extraction.join().unwrap_or_else(|_| {
                Err(anyhow::anyhow!("Archive extraction stopped unexpectedly"))
            });
            if let Err(panic) = reading {
                std::panic::resume_unwind(panic);
            }
            extracted
        })
    };
    extracted?;
    crate::progress::check()?;
    let unlisted = unlisted.into_inner();
    if unlisted > 0 {
        noted.push(note!(
            "import.discUnlisted",
            "{count} files that the disc's DICOMDIR does not list were read as well.",
            count = unlisted.to_string()
        ));
    }
    // Files that are another instance than the disc's index says, or in another series than it puts them in.
    let differing = spooled()
        .filter(|file| {
            let Some(Some(Ok(IndexedFile::Images(frames)))) =
                slots[slot_of[file.to.as_path()]].get()
            else {
                return false;
            };
            let series = (file.series)
                .zip(plan.as_ref())
                .map(|(series, plan)| plan.series[series].uid.as_str());
            frames.iter().any(|(_, info, frame)| {
                file.listed
                    .as_ref()
                    .is_some_and(|instance| frame.sop_uid != *instance)
                    || series.is_some_and(|uid| info.uid != uid)
            })
        })
        .count();
    if differing > 0 {
        noted.push(note!(
            "import.discIndexDiffers",
            "The disc's DICOMDIR describes {count} files wrongly; the files themselves were read.",
            count = differing.to_string()
        ));
    }
    // The series the index gets wrong, by Series Instance UID: one it lists a file under that is of another series, and
    // that other series. Whether such a series was read whole cannot be told from the index (see `taken_out`).
    let mut misfiled: HashSet<String> = HashSet::new();
    for file in spooled() {
        let (Some(series), Some(plan)) = (file.series, plan.as_ref()) else {
            continue;
        };
        let Some(Some(Ok(IndexedFile::Images(frames)))) = slots[slot_of[file.to.as_path()]].get()
        else {
            continue;
        };
        let listed = plan.series[series].uid.as_str();
        for (_, info, _) in frames.iter().filter(|(_, info, _)| info.uid != listed) {
            misfiled.insert(listed.to_owned());
            misfiled.insert(info.uid.clone());
        }
    }
    let mut read: Vec<(&Path, Result<IndexedFile>)> = files
        .iter()
        .zip(slots)
        // A slot left empty is an archive entry the extraction never wrote under its planned name.
        .filter_map(|(file, slot)| {
            slot.into_inner()
                .flatten()
                .map(|result| (file.as_path(), result))
        })
        .collect();
    // Of a disc taken out before it was read whole, only the series its index lists that were read whole stay, each with
    // every file of it; the rest of what it gave is left out.
    let taken_out: Vec<&Spool> = (spools.iter().zip(&removed))
        .filter(|(_, removed)| removed.load(std::sync::atomic::Ordering::Relaxed))
        .map(|(spool, _)| spool)
        .collect();
    let whole = plan.as_deref().map(whole_series).unwrap_or_default();
    // Read whole by what its index lists, and listed right: none of its files under another series, nor another's
    // under it.
    let kept_whole = |uid: &str| whole.get(uid) == Some(&true) && !misfiled.contains(uid);
    let is_whole = |series: Option<usize>| {
        let uid = series
            .zip(plan.as_deref())
            .map(|(series, plan)| plan.series[series].uid.as_str());
        uid.is_some_and(kept_whole)
    };
    let taken_files: HashSet<&Path> = (taken_out.iter().flat_map(|spool| &spool.files))
        .map(|file| file.to.as_path())
        .collect();
    let left: HashSet<&Path> = (taken_out.iter().flat_map(|spool| &spool.files))
        .filter(|file| !is_whole(file.series))
        .map(|file| file.to.as_path())
        .collect();
    read.retain(|(path, _)| !left.contains(path));
    let unplanned = unplanned.into_inner().unwrap();
    for path in unplanned.iter().filter(|path| is_candidate(path)) {
        read.push((path.as_path(), read_one(path)));
    }
    if !unplanned.is_empty() {
        read.sort_by(|a, b| a.0.cmp(b.0));
        read.dedup_by(|a, b| a.0 == b.0);
    }
    let has_dicom = read
        .iter()
        .any(|(_, result)| result.as_ref().is_ok_and(IndexedFile::contains_dicom));
    let pictures: Vec<_> = read
        .iter_mut()
        .filter(|(path, result)| {
            is_ordinary_image(path)
                && !media_files.contains_key(*path)
                && !copied.contains(*path)
                && result.is_ok()
        })
        .collect();
    if has_dicom {
        for _ in pictures {
            crate::progress::step()?;
        }
    } else {
        // Only pictures: count each file when its size request finishes.
        let workers = index_readers().min(pictures.len());
        crate::parallel::for_each(
            "picture-size",
            workers,
            pictures.into_iter(),
            |(path, entry)| {
                let path = *path;
                let result = crate::progress::check().and_then(|_| {
                    let frames = read_ordinary(path, roots.get(path).map(|root| root.as_ref()))?;
                    budget.reserve_index(1, frames[0].2.source.retained_bytes())?;
                    Ok(IndexedFile::Images(frames))
                });
                *entry = crate::progress::step().and(result);
            },
        );
        crate::progress::check()?;
    }
    budget.check()?;
    if read.len() > MAX_FILES {
        bail!(coded!(
            "import.tooManyFiles",
            "Import contains more than {count} files; choose a narrower folder",
            count = MAX_FILES.to_string()
        ));
    }
    let Catalogue {
        mut sources,
        mut warnings,
        unreadable,
    } = catalogue(read, true, revision)?;
    if !taken_out.is_empty() {
        // A series made of a kept file that the index lists under another series than its own goes too.
        let from_disc = |source: &Arc<SourceSeries>| {
            let file = |path: &Path| taken_files.contains(path);
            source.frames.iter().any(|frame| file(&frame.source.path))
                || source.documents.iter().any(|document| file(&document.path))
        };
        sources.retain(|source| !from_disc(source) || kept_whole(source.info.uid.as_str()));
        if sources.is_empty() {
            return Err(disc_removed());
        }
        // The series the taken-out discs list, by Series Instance UID, and those of them open: read whole and made into
        // a series (one whose every file failed is none).
        let listed: HashSet<&str> = (taken_out.iter().flat_map(|spool| &spool.files))
            .filter_map(|file| Some(plan.as_deref()?.series[file.series?].uid.as_str()))
            .collect();
        let open: HashSet<&str> = (sources.iter())
            .filter(|source| from_disc(source))
            .map(|source| source.info.uid.as_str())
            .collect();
        let kept = listed.iter().filter(|uid| open.contains(**uid)).count();
        noted.push(note!(
            "import.discRemovedPart",
            "The disc was removed before all of it was read: {kept} of its {listed} series were read whole and are open.",
            kept = kept.to_string(),
            listed = listed.len().to_string()
        ));
    }
    warnings.extend(noted);
    if sources.is_empty() {
        bail!(coded!(
            "import.noImages",
            "No supported images were found. {details}",
            details = Vec::from_iter(unreadable)
        ));
    }
    let discs = spools.iter().map(|spool| spool.copy.clone()).collect();
    Ok(Imported {
        sources,
        archives,
        warnings,
        discs,
    })
}

/// The frames read from one file, each with the series it belongs to.
type Frames = Vec<(GroupKey, Series, Frame)>;

#[derive(Clone)]
enum IndexedFile {
    Images(Frames),
    Document(Box<Series>, Arc<SourceFile>),
}

impl IndexedFile {
    fn contains_dicom(&self) -> bool {
        match self {
            Self::Document(..) => true,
            Self::Images(frames) => frames.iter().any(|(_, _, frame)| !frame.ordinary_image),
        }
    }
}
/// A file's frames once read; None for an archive entry that is not a candidate (see is_candidate).
type Slot = OnceLock<Option<Result<IndexedFile>>>;

/// What `catalogue` makes of the files read.
struct Catalogue {
    sources: Vec<Arc<SourceSeries>>,
    warnings: Vec<crate::message::Note>,
    /// Why files could not be read, in one sentence, for an import that opens nothing.
    unreadable: Option<crate::message::Note>,
}

/// The catalogue made from the files read: frames grouped into series, phases told apart, and each series' geometry,
/// window and warnings. `pooled` measures the windows of series that store none on the import's reading threads; the
/// series handed over early are measured on the calling thread instead, which leaves those threads to the reading.
fn catalogue(
    read: Vec<(&Path, Result<IndexedFile>)>,
    pooled: bool,
    revision: u64,
) -> Result<Catalogue> {
    let mut groups: BTreeMap<GroupKey, (Series, Vec<Frame>)> = BTreeMap::new();
    let mut warnings = Vec::new();
    let mut rejected = 0usize;
    // The reason every unreadable file so far gave, while they all gave the same one.
    let mut shared_reason = None;
    let mut documents = BTreeMap::new();
    // Ordinary images only when nothing opened held DICOM (VEAcom 1.x): beside a study they are a desktop's
    // or a disc viewer's own icons and photos, not series.
    let any_dicom = read
        .iter()
        .any(|(_, result)| result.as_ref().is_ok_and(IndexedFile::contains_dicom));
    for (path, result) in read {
        match result {
            Ok(IndexedFile::Document(mut info, source)) => {
                let key = format!(
                    "document|{}|{}|{}",
                    info.patient_key, info.study_uid, info.uid
                );
                let entry = documents.entry(key.clone()).or_insert_with(|| {
                    info.id = crate::random::uuid_v5(&crate::random::NAMESPACE_URL, key.as_bytes());
                    info.source_revision = revision;
                    SourceSeries {
                        info: *info,
                        frames: Vec::new(),
                        geometry: geometry::assemble(&[]),
                        documents: Vec::new(),
                    }
                });
                entry.documents.push(source);
            }
            Ok(IndexedFile::Images(frames)) => {
                for (key, info, frame) in frames {
                    if any_dicom && frame.ordinary_image {
                        continue;
                    }
                    let (group, frames) = groups
                        .entry(key)
                        .or_insert_with(|| (info.clone(), Vec::new()));
                    if group.pixel_type != info.pixel_type {
                        group.pixel_type = "float32".into();
                    }
                    merge_calibration(group, &info);
                    merge_pet_acquisition(group, &info);
                    merge_anatomy_value(
                        &mut group.acquisition.body_part_examined,
                        &info.acquisition.body_part_examined,
                    );
                    merge_anatomy_value(
                        &mut group.acquisition.laterality,
                        &info.acquisition.laterality,
                    );
                    frames.push(frame);
                }
            }
            Err(error) => {
                rejected += 1;
                let reason = crate::message::Param::error(&error);
                if rejected == 1 {
                    shared_reason = Some(reason.clone());
                } else if shared_reason.as_ref() != Some(&reason) {
                    shared_reason = None;
                }
                if warnings.len() < 30 {
                    warnings.push(note!(
                        "import.fileUnreadable",
                        "{file}: {reason}",
                        file = path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                        reason = reason,
                    ));
                }
            }
        }
    }
    let unreadable = match (rejected, shared_reason) {
        (0, _) => None,
        (1, _) => warnings.first().cloned(),
        (count, Some(reason)) => Some(note!(
            "import.unreadableAlike",
            "{count} files could not be read: {reason}",
            count = count.to_string(),
            reason = reason,
        )),
        (count, None) => Some(note!(
            "import.unreadableMany",
            "{count} files could not be read as supported images",
            count = count.to_string(),
        )),
    };
    if rejected > 30 {
        warnings.push(note!(
            "import.moreUnreadable",
            "{count} additional files could not be read as supported DICOM images",
            count = (rejected - 30).to_string(),
        ));
    }
    merge_scattered_orientations(&mut groups);
    let mut parts = Vec::new();
    let mut family: Vec<(GroupKey, Series, Vec<Frame>)> = Vec::new();
    for (key, (info, mut frames)) in groups {
        frames.sort_by_key(|f| (f.instance_number, f.source.path.clone(), f.index));
        if frames.first().is_some_and(|f| f.ordinary_image) {
            // Images in their names' order: "kesit2" before "kesit10".
            frames.sort_by(|a, b| {
                natural_cmp(
                    &a.source.path.to_string_lossy(),
                    &b.source.path.to_string_lossy(),
                )
            });
        }
        let mut seen = HashSet::new();
        frames.retain(|f| {
            seen.insert((
                if f.sop_uid.is_empty() {
                    f.source.path.to_string_lossy().into_owned()
                } else {
                    f.sop_uid.clone()
                },
                f.index,
            ))
        });
        if frames.first().is_some_and(|f| f.segmentation.is_some()) {
            // A segmentation's frames repeat positions once per segment; no phases.
            parts.push((key.id_key(), info, frames));
            continue;
        }
        // Keys sort by family first, so the groups of one family are adjacent.
        if family
            .last()
            .is_some_and(|(last, ..)| !last.same_family(&key))
        {
            phase_family(std::mem::take(&mut family), &mut parts);
        }
        family.push((key, info, frames));
    }
    phase_family(family, &mut parts);
    let mut sources = Vec::new();
    for (key, mut info, mut frames) in parts {
        // The phase is decided; the catalog keeps no per-frame evidence.
        for frame in &mut frames {
            std::mem::take(&mut frame.phase_hints);
            if let Some(segmentation) = frame.segmentation.take() {
                info.segmentation
                    .get_or_insert_with(|| (*segmentation).clone());
            }
        }
        let geom = geometry::assemble(
            &frames
                .iter()
                .map(|f| f.geometry.clone())
                .collect::<Vec<_>>(),
        );
        let mut ordered = geom
            .order
            .iter()
            .map(|&i| frames[i].clone())
            .collect::<Vec<_>>();
        info.id = crate::random::uuid_v5(&crate::random::NAMESPACE_OID, key.as_bytes());
        // Older PET records used the reconstruction ID made with the local patient ID in this prefix, and those of an
        // ID without an issuer that is now joined across studies, the one made with the key scoped to the study.
        if info.modality == "PT"
            && info.segmentation.is_none()
            && let Some(suffix) = key
                .strip_prefix(&info.patient_key)
                .filter(|s| s.starts_with('|'))
        {
            let old_key = format!("{}{suffix}", info.patient_id);
            info.previous_pet_id = Some(crate::random::uuid_v5(
                &crate::random::NAMESPACE_OID,
                old_key.as_bytes(),
            ));
            info.study_scoped_pet_id = info.study_scoped_patient_key.as_ref().map(|scoped| {
                crate::random::uuid_v5(
                    &crate::random::NAMESPACE_OID,
                    format!("{scoped}{suffix}").as_bytes(),
                )
            });
        }
        info.dimensions[2] = ordered.len();
        info.spacing = geom.spacing;
        info.origin = geom.origin;
        info.direction = geom.direction;
        info.cine = crate::cine::for_series(&ordered);
        for frame in &mut ordered {
            frame.cine = None;
        }
        info.frame_metadata = ordered.iter().map(|frame| frame.metadata.clone()).collect();
        // VOI LUTs, once each, for the frames that store no window (a window takes precedence).
        let mut luts: Vec<Arc<crate::model::VoiLut>> = Vec::new();
        for (frame, metadata) in ordered.iter_mut().zip(info.frame_metadata.iter_mut()) {
            let Some(lut) = frame.voi_lut.take() else {
                continue;
            };
            if metadata.window_width.is_some() {
                continue;
            }
            let index = luts
                .iter()
                .position(|known| Arc::ptr_eq(known, &lut) || **known == *lut)
                .unwrap_or_else(|| {
                    luts.push(lut);
                    luts.len() - 1
                });
            metadata.voi_lut = Some(index as u32);
        }
        if luts.len() > 16 {
            luts.clear();
            info.frame_metadata
                .iter_mut()
                .for_each(|metadata| metadata.voi_lut = None);
            info.warnings.push(note!(
                "series.tooManyVoiLuts",
                "VOI LUTs not applied: the frames carry more than 16 different tables"
            ));
        }
        info.voi_luts = luts.iter().map(|lut| (**lut).clone()).collect();
        let first_lut = info
            .frame_metadata
            .iter()
            .find_map(|metadata| metadata.voi_lut);
        if let (Some(index), true) = (
            first_lut,
            info.frame_metadata
                .iter()
                .all(|metadata| metadata.window_width.is_none()),
        ) {
            // Manual window changes start from the LUT's own range rather than a modality default.
            (info.window_center, info.window_width) =
                crate::modality_lut::voi_window(&info.voi_luts[index as usize]);
            info.voi_function = None;
        }
        if let Some(first) = info.frame_metadata.first() {
            info.window_center = first.window_center.unwrap_or(info.window_center);
            if let Some(width) = first.window_width {
                info.window_width = width;
                info.voi_function = first.voi_function;
            } else {
                info.voi_function = None;
            }
            info.padding_range = first.padding_range.filter(|range| {
                info.frame_metadata
                    .iter()
                    .all(|frame| frame.padding_range == Some(*range))
            });
        }
        let segmentation = info.segmentation.is_some();
        // CT localizers are projections even when several have parallel planes (PS3.3 C.8.2.1.1.1).
        let ct_localizer = info.modality == "CT"
            && info
                .acquisition
                .image_type
                .split('\\')
                .nth(2)
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("LOCALIZER"));
        // Masks are drawn over the image series they reference.
        info.can_reconstruct =
            geom.can_reconstruct && info.components == 1 && !segmentation && !ct_localizer;
        if !info.can_reconstruct {
            info.legacy_grid_ids.clear();
        }
        // An ordinary image's own note says it has no geometry; the stack's missing positions, orientation and
        // spacing would only repeat it. A gamma camera's planar frames have no place in the patient by nature.
        let pictures = frames.first().is_some_and(|f| f.ordinary_image);
        let planar =
            info.modality == "NM" && crate::gamma_camera::planar(&info.acquisition.image_type);
        if !segmentation && !pictures && !planar {
            info.warnings.extend(
                (geom.warnings.iter())
                    .filter(|note| !(ct_localizer && RECONSTRUCTION_NOTES.contains(&note.code)))
                    .cloned(),
            );
        }
        let reference_spacing = frames.first().and_then(|f| f.geometry.pixel_spacing);
        info.spacing_known = reference_spacing.is_some_and(|reference| {
            frames.iter().all(|f| {
                f.geometry.pixel_spacing.is_some_and(|s| {
                    s.iter().all(|v| *v > 0.)
                        && (0..2).all(|axis| {
                            (s[axis] - reference[axis]).abs()
                                <= 1.0e-6_f64.max(reference[axis] * 1.0e-4)
                        })
                })
            })
        });
        info.orientation_known = geom.has_physical_geometry
            && frames
                .iter()
                .all(|f| f.geometry.orientation.is_some_and(valid_orientation));
        if !segmentation && !pictures && frames.iter().any(|f| f.geometry.pixel_spacing.is_none()) {
            info.warnings.push(note!(
                "series.noPixelSpacing",
                "Physical measurements unavailable: pixel spacing is missing"
            ));
        }
        // Decide the displayed unit after all frames have agreed on calibration.
        let stored_unit = info.stored_unit();
        if stored_unit != info.value_unit {
            info.value_unit = stored_unit.to_owned();
        }
        info.source_revision = revision;
        sources.push(SourceSeries {
            info,
            frames: ordered,
            geometry: geom,
            documents: Vec::new(),
        });
    }
    sources.extend(documents.into_values());
    number_image_series(&mut sources);
    crate::progress::check()?;
    let windows: Vec<_> = sources
        .iter_mut()
        .filter(|source| needs_pixel_window(source))
        .map(|source| {
            let middle = (source.frames.len() - 1) / 2;
            (source, middle)
        })
        .collect();
    let threads = if pooled {
        index_readers().min(windows.len())
    } else {
        1
    };
    let workers = crate::decode::frame_workers(
        threads,
        windows
            .iter()
            .map(|(source, middle)| source.frames[*middle].jpeg_component_threads),
    );
    crate::parallel::for_each(
        "dicom-index",
        workers,
        windows.into_iter(),
        |(source, middle)| {
            if let Some((center, width)) = pixel_window(source, middle) {
                source.info.window_center = center;
                source.info.window_width = width;
                source.info.voi_function = None;
                source.info.window_from_pixels = true;
            }
        },
    );
    share_gate_windows(&mut sources);
    crate::progress::check()?;
    let mut sources: Vec<_> = sources.into_iter().map(Arc::new).collect();
    sources.sort_by(|a, b| {
        a.info
            .study_date
            .cmp(&b.info.study_date)
            .then(a.info.series_number.cmp(&b.info.series_number))
            .then(a.info.description.cmp(&b.info.description))
    });
    Ok(Catalogue {
        sources,
        warnings,
        unreadable,
    })
}

/// How long a series the viewer asked for stays as it was handed over before it is handed over again, grown.
const GROWTH_PAUSE: std::time::Duration = std::time::Duration::from_millis(750);

/// Hands over each series of a disc's plan once every file its DICOMDIR lists for it is read, whatever folder they are
/// in; and a series the viewer asked for (Plan::want) as far as it is read, and again as it grows. Such a series is
/// marked as still being read (`Series::reading`) and is not reconstructed: the viewer shows its images one by one,
/// as many as are read. Only series of the UID and the patient the plan gives go: a file the index puts in the wrong
/// series waits for the catalogue the import ends with, which is built from every file, as without this.
struct PlanWatch {
    /// Each series' files, as places among the import's files.
    files: Vec<Vec<usize>>,
    /// How many of its files each series had read when it was last handed over, and when.
    shown: Vec<Option<(usize, std::time::Instant)>>,
    /// The series handed over whole.
    whole: Vec<bool>,
}

impl PlanWatch {
    fn new(files: Vec<Vec<usize>>) -> Self {
        let count = files.len();
        Self {
            files,
            shown: vec![None; count],
            whole: vec![false; count],
        }
    }

    /// `windows` are the windows the series' pictures were measured with (see PreviewWatch).
    fn publish(
        &mut self,
        plan: &Plan,
        windows: &[Option<(f64, f64)>],
        files: &[PathBuf],
        slots: &[Slot],
        sink: EarlySink,
        revision: u64,
    ) {
        let wanted = plan.wanted();
        for (series, places) in self.files.iter().enumerate() {
            if self.whole[series] {
                continue;
            }
            // The files finished with and the images among them, from one look at the slots: a count taken apart from
            // the images could say fewer files read than the series handed over holds.
            let mut done = 0;
            let mut images = Vec::new();
            for &index in places {
                let Some(slot) = slots[index].get() else {
                    continue;
                };
                done += 1;
                if let Some(Ok(file @ IndexedFile::Images(_))) = slot {
                    images.push((files[index].as_path(), file));
                }
            }
            let whole = done == places.len();
            let grown = |(shown, at): (usize, std::time::Instant)| {
                done > shown && at.elapsed() >= GROWTH_PAUSE
            };
            let growing = wanted.contains(&series) && self.shown[series].is_none_or(grown);
            if !whole && !growing {
                continue;
            }
            let read: Vec<_> = (images.into_iter())
                .map(|(path, file)| (path, Ok(file.clone())))
                .collect();
            // What cannot be made into a series now is not handed over early; the import's own catalogue says why.
            let made = catalogue(read, false, revision).map(|made| made.sources);
            // Of the UID the plan gives, and of its patient where both name one, as a series' picture (PreviewWatch).
            let listed = &plan.series[series];
            let patient =
                |id: &str| id.is_empty() || listed.patient_id.is_empty() || id == listed.patient_id;
            let usable = |source: &Arc<SourceSeries>| {
                source.info.uid == listed.uid
                    && patient(&source.info.patient_id)
                    && source.info.segmentation.is_none()
                    && source
                        .frames
                        .first()
                        .is_some_and(|frame| !frame.ordinary_image)
            };
            let mut ready: Vec<_> = made
                .unwrap_or_default()
                .into_iter()
                .filter(usable)
                .collect();
            if !whole {
                for source in &mut ready {
                    let info = &mut Arc::make_mut(source).info;
                    info.can_reconstruct = false;
                    info.reading = Some(crate::model::Reading {
                        read: done,
                        files: places.len(),
                    });
                    // A window measured from the pixels of the series as far as it is read would change as it grows:
                    // the one its picture was measured with stands until it is read whole.
                    if let (true, Some((center, width))) =
                        (info.window_from_pixels, windows[series])
                    {
                        info.window_center = center;
                        info.window_width = width;
                    }
                }
            }
            self.shown[series] = Some((done, std::time::Instant::now()));
            self.whole[series] = whole;
            if !ready.is_empty() {
                sink(HandOver::Series(ready));
            }
        }
    }
}

/// The order a disc's files are copied in: as planned (the series' middle files first, for their cards' pictures),
/// but for a series the viewer asks for (Plan::want). Its middle file goes next, so that it opens at once; the other
/// middle files still go before the rest of it, as they are few and every card waits for one; then the rest of it,
/// before every other file. The series asked for last goes first.
struct SpoolQueue {
    next: usize,
    copied: Vec<bool>,
    /// How many files at the start are middle files (see `SpoolFile::first`).
    middles: usize,
    middle_of: HashMap<usize, usize>,
    of_series: HashMap<usize, std::collections::VecDeque<usize>>,
}

impl SpoolQueue {
    fn new(files: &[SpoolFile]) -> Self {
        let mut of_series: HashMap<usize, std::collections::VecDeque<usize>> = HashMap::new();
        let mut middle_of = HashMap::new();
        for (at, file) in files.iter().enumerate() {
            if let Some(series) = file.series {
                of_series.entry(series).or_default().push_back(at);
                if file.first {
                    middle_of.insert(series, at);
                }
            }
        }
        Self {
            next: 0,
            copied: vec![false; files.len()],
            middles: files.iter().take_while(|file| file.first).count(),
            middle_of,
            of_series,
        }
    }

    /// Marks the file at `at` copied; whether it was not yet.
    fn take(&mut self, at: usize) -> bool {
        !std::mem::replace(&mut self.copied[at], true)
    }

    /// The place of the file to copy next, among the disc's files.
    fn next(&mut self, plan: Option<&Plan>) -> Option<usize> {
        let wanted = plan.map(Plan::wanted).unwrap_or_default();
        for series in &wanted {
            if let Some(&at) = self.middle_of.get(series)
                && self.take(at)
            {
                return Some(at);
            }
        }
        while self.next < self.middles {
            let at = self.next;
            self.next += 1;
            if self.take(at) {
                return Some(at);
            }
        }
        for series in wanted {
            while let Some(at) = self
                .of_series
                .get_mut(&series)
                .and_then(|waiting| waiting.pop_front())
            {
                if self.take(at) {
                    return Some(at);
                }
            }
        }
        while self.next < self.copied.len() {
            let at = self.next;
            self.next += 1;
            if self.take(at) {
                return Some(at);
            }
        }
        None
    }
}

/// Hands over a picture of each series of a disc's plan once its middle file is read (see `HandOver::Preview`): only
/// a picture of that series, of the UID and the patient the plan gives it.
struct PreviewWatch {
    /// The plan's series still without a picture, each with its middle file's place among the import's files.
    waiting: Vec<(usize, usize)>,
    /// For each series of the plan, the window its picture was measured with from its pixels, where the file stores
    /// none (see PlanWatch).
    windows: Vec<Option<(f64, f64)>>,
}

impl PreviewWatch {
    fn new(waiting: Vec<(usize, usize)>, planned: usize) -> Self {
        Self {
            waiting,
            windows: vec![None; planned],
        }
    }

    fn publish(
        &mut self,
        plan: &Plan,
        files: &[PathBuf],
        slots: &[Slot],
        sink: EarlySink,
        revision: u64,
    ) {
        let windows = &mut self.windows;
        self.waiting.retain(|&(planned, index)| {
            let Some(read) = slots[index].get() else {
                return true;
            };
            // A middle file that is no image, or could not be read, gives no picture: the card shows its series'
            // own once the series is read whole.
            let Some(Ok(file @ IndexedFile::Images(_))) = read else {
                return false;
            };
            let made = catalogue(
                vec![(files[index].as_path(), Ok(file.clone()))],
                false,
                revision,
            );
            // A middle file that is not of the series the plan says, or not of its patient, gives no picture either: a
            // card shows nothing rather than another series' image. A patient ID is compared where both name one: an
            // index names one (as UNKNOWN, say) for files that name none.
            let listed = &plan.series[planned];
            let patient =
                |id: &str| id.is_empty() || listed.patient_id.is_empty() || id == listed.patient_id;
            let picture = made.ok().and_then(|made| {
                made.sources.into_iter().find(|source| {
                    source.info.uid == listed.uid
                        && patient(&source.info.patient_id)
                        && source.info.segmentation.is_none()
                        && source
                            .frames
                            .first()
                            .is_some_and(|frame| !frame.ordinary_image)
                })
            });
            if let Some(mut series) = picture {
                let info = &mut Arc::make_mut(&mut series).info;
                if info.window_from_pixels {
                    windows[planned] = Some((info.window_center, info.window_width));
                }
                info.id = format!("preview:{}", info.id);
                sink(HandOver::Preview { planned, series });
            }
            false
        });
    }
}

/// Follows an import's reading for series that can be shown before it ends (see `import_with`).
struct EarlyWatch {
    /// Each file's folder, as an index into `unread`.
    folder: Vec<usize>,
    /// How many files of each folder are still to be read.
    unread: Vec<usize>,
    /// The files already counted.
    counted: Vec<bool>,
    /// Folders read whole since the last look for series.
    finished: Vec<usize>,
    /// Every folder read whole so far.
    done: HashSet<usize>,
    /// The folders each series (by Series Instance UID) has files in, among the files read so far.
    folders_of: HashMap<String, HashSet<usize>>,
    /// The series handed over already, by id.
    handed: HashSet<String>,
    /// The Series Instance UIDs of a disc's plan, whose series go by their files instead (PlanWatch).
    planned: HashSet<String>,
}

impl EarlyWatch {
    fn new(files: &[PathBuf]) -> Self {
        let mut folders: HashMap<&Path, usize> = HashMap::new();
        let folder: Vec<usize> = files
            .iter()
            .map(|file| {
                let next = folders.len();
                *folders
                    .entry(file.parent().unwrap_or(Path::new("")))
                    .or_insert(next)
            })
            .collect();
        let mut unread = vec![0; folders.len()];
        for &index in &folder {
            unread[index] += 1;
        }
        Self {
            counted: vec![false; files.len()],
            folder,
            unread,
            finished: Vec::new(),
            done: HashSet::new(),
            folders_of: HashMap::new(),
            handed: HashSet::new(),
            planned: HashSet::new(),
        }
    }

    /// Counts the files read since the last look; when that finishes folders, builds their series as the final
    /// catalogue would, with the folders finished earlier that hold files of the same series, and hands over each
    /// series whose folders are all read whole.
    fn publish(&mut self, files: &[PathBuf], slots: &[Slot], sink: EarlySink, revision: u64) {
        for (index, slot) in slots.iter().enumerate() {
            if self.counted[index] {
                continue;
            }
            let Some(result) = slot.get() else { continue };
            self.counted[index] = true;
            let folder = self.folder[index];
            if let Some(Ok(IndexedFile::Images(frames))) = result {
                for (_, info, _) in frames {
                    self.folders_of
                        .entry(info.uid.clone())
                        .or_default()
                        .insert(folder);
                }
            }
            self.unread[folder] -= 1;
            if self.unread[folder] == 0 {
                self.finished.push(folder);
            }
        }
        if self.finished.is_empty() {
            return;
        }
        let fresh: HashSet<usize> = self.finished.drain(..).collect();
        self.done.extend(&fresh);
        let mut folders = fresh.clone();
        for spread in self
            .folders_of
            .values()
            .filter(|spread| !spread.is_disjoint(&fresh))
        {
            folders.extend(spread.intersection(&self.done));
        }
        let read = slots
            .iter()
            .enumerate()
            .filter(|(index, _)| folders.contains(&self.folder[*index]))
            .filter_map(|(index, slot)| match slot.get() {
                Some(Some(Ok(file @ IndexedFile::Images(_)))) => {
                    Some((files[index].as_path(), Ok(file.clone())))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        let Ok(Catalogue { sources, .. }) = catalogue(read, false, revision) else {
            return;
        };
        let ready: Vec<_> = sources
            .into_iter()
            .filter(|source| {
                !source
                    .frames
                    .first()
                    .is_some_and(|frame| frame.ordinary_image)
                    && source.info.segmentation.is_none()
                    && !self.handed.contains(&source.info.id)
                    && !self.planned.contains(&source.info.uid)
                    && self
                        .folders_of
                        .get(&source.info.uid)
                        .is_some_and(|spread| spread.is_subset(&self.done))
            })
            .collect();
        self.handed
            .extend(ready.iter().map(|source| source.info.id.clone()));
        if !ready.is_empty() {
            sink(HandOver::Series(ready));
        }
    }
}

fn collect_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    collect_files_if(path, files, &is_candidate)
}

/// `collect_files`, with `wanted` saying which of a folder's files are kept.
fn collect_files_if(
    path: &Path,
    files: &mut Vec<PathBuf>,
    wanted: &dyn Fn(&Path) -> bool,
) -> Result<()> {
    if fs::is_file(path) {
        files.push(fs::canonicalize(path)?);
        if files.len() > MAX_FILES {
            bail!(coded!("import.tooManySelected", "Too many selected files"));
        }
        return Ok(());
    }
    // The selected folder itself may be a link; nothing inside it is followed. Hidden entries are
    // skipped and hidden folders never entered. Each folder is listed whole before its first
    // entry is visited, so a deeply nested tree doesn't hold one open handle per level.
    if !fs::metadata(path)
        .map_err(|error| walk_error(path, error))?
        .is_dir()
    {
        return Ok(());
    }
    let mut pending = vec![list_folder(path)?];
    while let Some(folder) = pending.last_mut() {
        let Some(entry) = folder.next() else {
            pending.pop();
            continue;
        };
        crate::progress::check()?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let entry_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| walk_error(&entry_path, error))?;
        if file_type.is_dir() {
            pending.push(list_folder(&entry_path)?);
        } else if file_type.is_file() && wanted(&entry_path) {
            files.push(entry_path);
        }
        if files.len() > MAX_FILES {
            bail!(coded!(
                "import.tooManyFiles",
                "Import contains more than {count} files; choose a narrower folder",
                count = MAX_FILES.to_string()
            ));
        }
    }
    Ok(())
}

fn list_folder(path: &Path) -> Result<std::vec::IntoIter<fs::DirEntry>> {
    let entries = fs::read_dir(path)
        .and_then(|entries| entries.collect::<std::io::Result<Vec<_>>>())
        .map_err(|error| walk_error(path, error))?;
    Ok(entries.into_iter())
}

fn walk_error(path: &Path, error: std::io::Error) -> anyhow::Error {
    anyhow::anyhow!("IO error for operation on {}: {error}", path.display())
}

fn is_candidate(path: &Path) -> bool {
    if path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
    {
        return false;
    }
    let sidecar = path.extension().is_some_and(|extension| {
        matches!(
            extension.to_string_lossy().to_ascii_lowercase().as_str(),
            "json"
                | "txt"
                | "md"
                | "pdf"
                | "xml"
                | "html"
                | "htm"
                | "css"
                | "js"
                | "exe"
                | "dll"
                | "bat"
                | "cmd"
                | "ini"
                | "inf"
                | "log"
                | "csv"
                | "yaml"
                | "yml"
                | "rtf"
                | "doc"
                | "docx"
                | "xls"
                | "xlsx"
                | "ico"
                | "db"
                | "zip"
                | "rar"
        )
    });
    if !sidecar {
        return true;
    }
    let mut prefix = [0u8; 132];
    File::open(path)
        .and_then(|mut f| f.read_exact(&mut prefix))
        .is_ok()
        && &prefix[128..] == b"DICM"
}

/// A disc that is read once (see `plan_spool`).
struct Spool {
    /// The folder that was opened.
    folder: PathBuf,
    /// Its files, in the order they are copied.
    files: Vec<SpoolFile>,
    /// Whether the disc's index says which files are its images: a DICOM file found beside them is then one the
    /// index does not list.
    indexed: bool,
    /// The disc, as it was when the import began.
    disc: Disc,
    /// What the import copies the disc to, for a later import of the same disc (see `DiscCopy`).
    copy: DiscCopy,
}

impl Spool {
    /// Whether the disc's index lists series of the import's plan (see `Plan`).
    fn planned(&self) -> bool {
        self.files.iter().any(|file| file.series.is_some())
    }

    /// Whether the disc in the drive is no other than the one the import began with (see `Disc::serial`), as the drive
    /// names it: a drive that names no disc soon (see `disc_named`) holds none that files are taken from.
    fn same_disc(&self) -> bool {
        self.disc
            .serial
            .is_none_or(|serial| disc_named(serial, &self.folder, volume_serial, DISC_NAMED_WITHIN))
    }
}

/// One file of a disc that is read once: where it is, where its copy goes, and how it is taken.
struct SpoolFile {
    from: PathBuf,
    to: PathBuf,
    take: Take,
    /// The instance that the disc's index says a file found on the disc holds. The file is read whatever it holds;
    /// a difference is said.
    listed: Option<String>,
    /// Where the disc's index puts the file in the import's plan (see `Plan`).
    series: Option<usize>,
    /// Whether the file is copied ahead of the others: its series' middle file, which the series' picture is made from.
    first: bool,
}

/// How a disc's file is taken.
enum Take {
    /// Whole: a file the index lists.
    Whole,
    /// Whole, and opened through the media's root: a file that only the index says is there.
    Listed(Arc<crate::media_directory::MediaRoot>),
    /// Only if it starts as a DICOM file does.
    IfDicom,
    /// Not at all: this computer cannot keep a file of its name (see `keeps_name`).
    Unkept,
    /// Not at all: an earlier import of this session copied it from the same disc, and its copy there, untouched, is
    /// read (see `DiscCopy`). `unlisted` is whether the disc's index leaves the file out.
    Kept { unlisted: bool },
}

/// What became of a disc's file.
enum Copied {
    Whole,
    /// Left on the disc: it is no DICOM file.
    NotDicom,
    /// The disc did not give it, and why.
    Unreadable(anyhow::Error),
}

/// Plans the single reading of the disc at `folder`: makes its private folder, and lists the files to copy into it
/// (the spool) and, in `files`, the copies they will be. `index` is the disc's index file when that is what was
/// opened, and not the folder.
///
/// A disc drive reads one place at a time, and each file it is sent to costs it about a tenth of a second. Reading
/// the files' headers for the series list and their images afterwards goes through the disc twice. Here one reader
/// copies every image file whole and once, and everything else reads the copies, as it reads an archive's files.
///
/// Which files a disc holds, and what they hold, is the disc's folders' and files' to say, as for any folder that is
/// opened. An index (DICOMDIR) at its top only orders the work: the folders of the files it lists are copied first.
/// A file that is not the instance the index says is read all the same, and the difference is said; a file that the
/// index alone says is there is read on its word, and has to be that instance. Any other file is taken if it starts
/// as a DICOM file does, so a disc's own viewer costs one look at each of its files, and those looks come last. An
/// index that cannot be read is said, and the disc is read as a folder is. An index that was itself opened is the
/// whole of what is read, as it is from any other place. Pictures stay on the disc: they are read only when nothing
/// opened held DICOM, as from any folder. The series the index describes go to `planned`, the import's plan (see
/// `Plan`), with the files of theirs this disc gives.
fn plan_spool(
    folder: &Path,
    index: Option<&Path>,
    reading: DiscToRead<'_>,
    files: &mut Vec<PathBuf>,
    media_files: &mut HashMap<PathBuf, crate::media_directory::Reference>,
    planned: &mut Vec<crate::model::PlannedSeries>,
    noted: &mut Vec<crate::message::Note>,
) -> Result<(ArchiveTempDir, Spool)> {
    let DiscToRead { disc, earlier } = reading;
    let dir = crate::archive_temp::create("veacom-import-")?;
    let is_index = |file: &Path| {
        file.file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("DICOMDIR"))
    };
    // A disc's file system does not tell a name's case apart, and an index need not spell a name as the disc does.
    let key = |inside: &Path| inside.to_string_lossy().to_lowercase();
    let mut found = Vec::new();
    if index.is_none() {
        collect_files_if(folder, &mut found, &|_| true)?;
    }
    let index_file = index.or_else(|| {
        let at_top = |file: &&PathBuf| file.parent() == Some(folder) && is_index(file);
        found.iter().find(at_top).map(PathBuf::as_path)
    });
    let read = match index_file.and_then(Path::file_name) {
        None => None,
        Some(name) => match disc_index(dir.path(), &fs::canonicalize(folder)?, name) {
            Ok(read) => Some(read),
            // An index that was itself opened is all there is to read.
            Err(error) if index.is_some() => return Err(error),
            Err(error) => {
                noted.push(note!(
                    "import.discIndexUnreadable",
                    "The disc's DICOMDIR could not be read ({reason}), so every file on the disc was read.",
                    reason = crate::message::Param::error(&error),
                ));
                None
            }
        },
    };
    let indexed = read.is_some();
    let DiscIndex {
        files: mut listed,
        series,
        hash: index_hash,
    } = read.unwrap_or_default();
    // What this import copies the disc to; and the copies earlier imports of this session made of the same disc, opened
    // at the same folder with the same index, the latest first, whose files are read instead of the disc's (see
    // `DiscCopy`).
    let copied = DiscCopy {
        disc,
        folder: folder.to_owned(),
        index: index_hash,
        copy: dir.path().to_owned(),
    };
    let same = |earlier: &&DiscCopy| {
        (earlier.disc, &earlier.folder, earlier.index)
            == (copied.disc, &copied.folder, copied.index)
    };
    let earlier: Vec<&DiscCopy> = earlier.iter().rev().filter(same).collect();
    // Each listed file's series in the plan, and each series' middle file. A file that the index puts in two series
    // counts in the first.
    let (mut series_of, mut middles) = (HashMap::new(), HashSet::new());
    for (mut info, places, middle) in series {
        let at = planned.len();
        info.files = 0;
        for (position, place) in places.into_iter().enumerate() {
            if series_of.contains_key(&place) {
                continue;
            }
            if position == middle {
                middles.insert(place.clone());
            }
            series_of.insert(place, at);
            info.files += 1;
        }
        if info.files > 0 {
            planned.push(info);
        }
    }
    let folders: HashSet<String> = listed
        .values()
        .filter_map(|(inside, _)| inside.parent())
        .map(key)
        .collect();
    let mut spool = Vec::new();
    let mut copy = |from: PathBuf, inside: &Path, take: Take, reference| {
        // A file an earlier import of this session copied from this same disc, which the disc still holds at that
        // copy's length, is read from that copy as it is, and not copied again (see `DiscCopy`).
        let on_disc = (!earlier.is_empty()).then(|| file_length(&from)).flatten();
        let kept = on_disc.and_then(|on_disc| {
            (earlier.iter())
                .map(|earlier| earlier.copy.join(inside))
                .find(|kept| file_length(kept) == Some(on_disc))
        });
        let to = kept.clone().unwrap_or_else(|| dir.path().join(inside));
        let listed = match (&take, reference) {
            (Take::Listed(_), Some(reference)) => {
                media_files.insert(to.clone(), reference);
                None
            }
            (_, reference) => {
                reference.map(|reference: crate::media_directory::Reference| reference.instance)
            }
        };
        files.push(to.clone());
        let unlisted = matches!(take, Take::IfDicom);
        let take = if kept.is_some() {
            Take::Kept { unlisted }
        } else if keeps_name(inside) {
            take
        } else {
            Take::Unkept
        };
        let series = series_of.get(&key(inside)).copied();
        let first = middles.contains(&key(inside));
        spool.push(SpoolFile {
            from,
            to,
            take,
            listed,
            series,
            first,
        });
    };
    let (mut pictures, mut rest) = (Vec::new(), Vec::new());
    for from in found {
        // An index is no image, wherever it lies.
        if is_index(&from) {
            continue;
        }
        let inside = from
            .strip_prefix(folder)
            .context("A disc's file lies outside the disc")?
            .to_owned();
        if let Some((_, reference)) = listed.remove(&key(&inside)) {
            copy(from, &inside, Take::Whole, Some(reference));
        } else if is_ordinary_image(&from) {
            pictures.push(from);
        } else if !indexed
            || inside
                .parent()
                .is_some_and(|parent| folders.contains(&key(parent)))
        {
            copy(from, &inside, Take::IfDicom, None);
        } else {
            rest.push((from, inside));
        }
    }
    // What only the index says is there (a hidden file, or one the disc does not hold): through the media's root, as
    // when the index itself is opened.
    let mut unseen: Vec<_> = listed.into_values().collect();
    unseen.sort_by(|a, b| a.0.cmp(&b.0));
    for (inside, reference) in unseen {
        let root = reference.root.clone();
        copy(
            root.path().join(&inside),
            &inside,
            Take::Listed(root),
            Some(reference),
        );
    }
    for (from, inside) in rest {
        copy(from, &inside, Take::IfDicom, None);
    }
    files.extend(pictures);
    if files.len() > MAX_FILES {
        bail!(coded!(
            "import.tooManyFiles",
            "Import contains more than {count} files; choose a narrower folder",
            count = MAX_FILES.to_string()
        ));
    }
    // Each series' middle file first, in the disc's order, so that every card has its picture long before the series
    // are read whole; then the rest, in the disc's order.
    let (mut ordered, rest): (Vec<_>, Vec<_>) = spool.into_iter().partition(|file| file.first);
    // The middle files in the order the series list shows the cards they are for: by study (where it comes first in
    // the plan), then series number.
    let mut study_at: HashMap<&str, usize> = HashMap::new();
    for (at, series) in planned.iter().enumerate() {
        study_at.entry(series.study_uid.as_str()).or_insert(at);
    }
    ordered.sort_by_key(|file| {
        let series = file.series.map(|series| &planned[series]);
        series.map(|series| {
            let study = study_at[series.study_uid.as_str()];
            (study, series.series_number.unwrap_or(0))
        })
    });
    ordered.extend(rest);
    let spool = Spool {
        folder: folder.to_owned(),
        files: ordered,
        indexed,
        disc,
        copy: copied,
    };
    Ok((dir, spool))
}

/// What a disc's index lists (see `disc_index`).
#[derive(Default)]
struct DiscIndex {
    /// Each file's place below the disc's top as the index spells it, and what the index says of the file, by that
    /// place in small letters.
    files: HashMap<String, (PathBuf, crate::media_directory::Reference)>,
    /// The series the index describes, each with its files' places in small letters and which of them is its middle
    /// image (see `ListedSeries`).
    series: Vec<(crate::model::PlannedSeries, Vec<String>, usize)>,
    /// The SHA-256 of the index, which tells its disc from another (see `DiscCopy`).
    hash: Option<[u8; 32]>,
}

/// The most bytes a disc's index may hold: as much as any DICOM file's own information may take (input_guard), with its
/// preamble and file meta, and nothing of an image. A larger one is not copied, nor read.
const MAX_INDEX_BYTES: u64 = crate::input_guard::MAX_META + crate::input_guard::MAX_FILE_META + 132;

/// What a disc's index lists. `name` is the index's own name at the top of `media`. The index is copied into the
/// import's folder `dir` and read there, so the disc gives it once and in one piece; the copy does not stay.
fn disc_index(dir: &Path, media: &Path, name: &std::ffi::OsStr) -> Result<DiscIndex> {
    let root = crate::media_directory::MediaRoot::open(media)?;
    let copy = SpoolFile {
        from: root.path().join(name),
        to: dir.join("DICOMDIR"),
        take: Take::Listed(root.clone()),
        listed: None,
        series: None,
        first: false,
    };
    let read = (|| {
        let (mut allowance, mut block) = (MAX_INDEX_BYTES, vec![0; 1 << 20]);
        let copied = copy_from_disc(&copy, MAX_INDEX_BYTES, &mut allowance, &mut block)?;
        if let Copied::Unreadable(error) = copied {
            return Err(error);
        }
        let mut bytes = Vec::new();
        File::open(&copy.to)?.read_to_end(&mut bytes)?;
        let hash: [u8; 32] = <sha2::Sha256 as sha2::Digest>::digest(&bytes).into();
        let listing =
            crate::media_directory::listing_in(&root, &copy.to, File::open(&copy.to)?, &bytes);
        listing.map(|listing| (listing, hash))
    })();
    let _ = fs::remove_file(&copy.to);
    let (listing, hash) = read?;
    let place = |path: &Path| -> Result<String> {
        Ok(path
            .strip_prefix(root.path())?
            .to_string_lossy()
            .to_lowercase())
    };
    let mut series = Vec::new();
    for listed in listing.series.unwrap_or_default() {
        let places = listed
            .files
            .iter()
            .map(|file| place(file))
            .collect::<Result<_>>()?;
        series.push((listed.info, places, listed.middle));
    }
    let mut listed = HashMap::new();
    for (path, reference) in listing.files {
        let inside = path.strip_prefix(root.path())?.to_owned();
        match listed.entry(inside.to_string_lossy().to_lowercase()) {
            std::collections::hash_map::Entry::Occupied(previous) => {
                let (_, previous): &(PathBuf, crate::media_directory::Reference) = previous.get();
                ensure!(
                    reference.agrees_with(previous),
                    "Conflicting DICOMDIR references to the same file"
                );
            }
            std::collections::hash_map::Entry::Vacant(place) => {
                place.insert((inside, reference));
            }
        }
    }
    Ok(DiscIndex {
        files: listed,
        series,
        hash: Some(hash),
    })
}

/// Whether this computer keeps a file under the name a disc gives it: every part of its place below the disc's top
/// is a plain name that Windows neither changes (one ending in a dot or a space) nor reads as a device (CON, NUL,
/// COM1 and the like, in any folder and with any extension).
fn keeps_name(inside: &Path) -> bool {
    inside.components().all(|part| {
        let std::path::Component::Normal(part) = part else {
            return false;
        };
        let Some(name) = part.to_str() else {
            return false;
        };
        let stem = name.split('.').next().unwrap_or("").trim_end();
        let device = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
            .iter()
            .any(|device| stem.eq_ignore_ascii_case(device))
            || (stem.chars().count() == 4
                && ["COM", "LPT"].iter().any(|port| {
                    stem.get(..3)
                        .is_some_and(|start| start.eq_ignore_ascii_case(port))
                })
                && stem
                    .chars()
                    .last()
                    .is_some_and(|number| number.is_ascii_digit() || "¹²³".contains(number)));
        !device
            && !name.ends_with(['.', ' '])
            && !name.contains(|c: char| c.is_control() || "<>:\"/\\|?*".contains(c))
    })
}

/// The length of the file at `path` itself, not of what a link there leads to; None for anything but a file.
fn file_length(path: &Path) -> Option<u64> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
}

/// Copies one file of a disc into the import's folder: opened once and read through once, a block at a time. A file
/// larger than `most` bytes is not copied. `allowance` is what the disc's copies may still take. An error is one that
/// ends the import: the copy cannot be written, or the import was cancelled. A file the disc does not give is no error
/// here (see `Copied`), and nor is one whose copy cannot be made where its name puts it.
fn copy_from_disc(
    file: &SpoolFile,
    most: u64,
    allowance: &mut u64,
    block: &mut [u8],
) -> Result<Copied> {
    // Where a DICOM file's marker ends, after its preamble.
    const START: usize = 132;
    let opened = match &file.take {
        // An earlier import's copy, read where it is.
        Take::Kept { .. } => return Ok(Copied::Whole),
        Take::Unkept => Err(anyhow::anyhow!(coded!(
            "file.nameUnusable",
            "This computer cannot hold a file of this name"
        ))),
        Take::Listed(root) => crate::media_directory::open_referenced(root, &file.from),
        Take::Whole | Take::IfDicom => File::open(&file.from).map_err(Into::into),
    };
    let mut source = match opened {
        Ok(source) => source,
        Err(error) => return Ok(Copied::Unreadable(error)),
    };
    let mut read = 0;
    while read < START {
        match source.read(&mut block[read..START]) {
            Ok(0) => break,
            Ok(count) => read += count,
            Err(error) => return Ok(Copied::Unreadable(error.into())),
        }
    }
    // The marker, where the reader looks for it (input_guard): at the file's start, or after the preamble.
    let dicom = block[..read].starts_with(b"DICM") || block[..read].get(128..) == Some(b"DICM");
    // A file named as DICOM is copied without one all the same, so that the import says why it cannot be opened, as
    // it does for a folder's; any other is no DICOM file (a disc's viewer and its parts).
    let named_dicom = (file.from.extension()).is_some_and(|extension| {
        extension.eq_ignore_ascii_case("dcm") || extension.eq_ignore_ascii_case("dicom")
    });
    if matches!(file.take, Take::IfDicom) && !dicom && !named_dicom {
        return Ok(Copied::NotDicom);
    }
    // Two of the disc's names that this computer takes for one, or a name the import's folder keeps for itself, leave a
    // copy nowhere to go: that file fails alone, as one the disc does not give.
    let folder = file.to.parent().context("Invalid disc path")?;
    let made = fs::create_dir_all(folder)
        .and_then(|()| File::options().write(true).create_new(true).open(&file.to));
    let mut output = match made {
        Ok(output) => output,
        Err(error) => return Ok(Copied::Unreadable(error.into())),
    };
    let mut size = 0;
    let failed = loop {
        if read == 0 {
            break None;
        }
        crate::progress::check()?;
        size += read as u64;
        if size > most {
            break Some(anyhow::anyhow!(coded!(
                "file.tooLarge",
                "DICOM source exceeds the input size limit"
            )));
        }
        ensure!(
            read as u64 <= *allowance,
            "A disc holds more than its size says"
        );
        *allowance -= read as u64;
        output.write_all(&block[..read])?;
        read = match source.read(block) {
            Ok(count) => count,
            Err(error) => break Some(error.into()),
        };
    };
    if let Some(error) = failed {
        drop(output);
        let _ = fs::remove_file(&file.to);
        return Ok(Copied::Unreadable(error));
    }
    output.flush()?;
    Ok(Copied::Whole)
}

/// Whether a disc's file, copied while another disc may have been put in the drive, is taken: when `same` finds the
/// disc still there. Otherwise the copy made now is removed, so that no later import of the disc reads it as the
/// disc's (see `DiscCopy`); an earlier import's copy, which was read from this disc, stays. A copy that cannot be
/// removed ends the import, whose folder then goes whole.
fn keep_copy(file: &SpoolFile, same: impl FnOnce() -> bool) -> Result<bool> {
    if same() {
        return Ok(true);
    }
    if !matches!(file.take, Take::Kept { .. }) {
        match fs::remove_file(&file.to) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error).context("A copy of a disc's file could not be removed");
            }
            _ => {}
        }
    }
    Ok(false)
}

/// `plan_zip_within` with the import's limit and this computer's room, as the tests plan an archive.
#[cfg(test)]
fn plan_zip(path: &Path) -> Result<(ArchiveTempDir, Vec<PathBuf>)> {
    plan_zip_within(path, available_archive_bytes(), room()).map(|(dir, entries, _)| (dir, entries))
}

/// An archive's extraction folder, made, and the files that will be read from it once extracted, for an import that
/// may extract `most` bytes on a computer whose temporary folder can take `room` more (None where nothing says), with
/// the bytes the archive lists for its files. Planned from the central directory alone, so a slow disc is not read
/// twice: where each entry really goes is the extraction's to decide, and it checks every entry again, with what each
/// really holds (see extract_zip_into). Hidden entries and those in hidden folders are extracted but not read, as a
/// folder's are never listed. The listed sizes are checked against `most` and `room` before anything is written: a ZIP
/// too large for the import, or for the room less half of SPARE_BYTES, is refused at once.
fn plan_zip_within(
    path: &Path,
    most: u64,
    room: Option<u64>,
) -> Result<(ArchiveTempDir, Vec<PathBuf>, u64)> {
    let archive = zip::ZipArchive::new(File::open(path)?)?;
    if archive.len() > MAX_FILES {
        bail!(coded!(
            "zip.tooManyEntries",
            "ZIP contains too many entries"
        ));
    }
    let listing = archive.metadata();
    let mut listed = 0u64;
    for index in 0..listing.len() {
        let entry = listing.entry(index)?;
        if !entry.is_dir() {
            listed = listed.saturating_add(entry.size());
        }
    }
    if listed > most {
        bail!(coded!(
            "zip.tooLarge",
            "ZIP expanded data exceeds the import limit"
        ));
    }
    if room.is_some_and(|room| listed.saturating_add(SPARE_BYTES / 2) > room) {
        bail!(zip_no_room());
    }
    let dir = crate::archive_temp::create("veacom-import-")?;
    let entries = (0..archive.len())
        .filter_map(|index| planned_target(dir.path(), &archive.name_for_index(index)?.ok()?))
        .filter(|target| !hidden_entry(dir.path(), target))
        .collect();
    Ok((dir, entries, listed))
}

/// Where an entry called `name` is expected to land under `dir` ("Seri1/IM1" as dir/Seri1/IM1, in this system's
/// separators, as a folder listing gives it); None for a folder entry or a name that does not plainly stay inside.
/// Only for planning the reading: the extraction decides, with its own checks, where an entry goes.
fn planned_target(dir: &Path, name: &str) -> Option<PathBuf> {
    if name.ends_with(['/', '\\']) || name.contains('\0') {
        return None;
    }
    let mut parts = Vec::new();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part if part.contains(':') => return None,
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return None;
    }
    let mut target = dir.to_path_buf();
    target.extend(parts);
    Some(target)
}

/// Whether an extracted file is hidden, or inside a hidden folder, below the extraction folder.
fn hidden_entry(dir: &Path, target: &Path) -> bool {
    target.strip_prefix(dir).is_ok_and(|inside| {
        inside
            .components()
            .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    })
}

/// Where an entry is extracted to under `dir`; None for a folder entry. A name that would leave `dir`, a symbolic
/// link, or an entry over the per-file limit is an error. The path is rebuilt from plain names only, in this system's
/// separators, as a folder listing gives it.
fn zip_target(
    dir: &Path,
    name: Option<PathBuf>,
    unix_mode: Option<u32>,
    is_dir: bool,
    size: u64,
) -> Result<Option<PathBuf>> {
    let name = name.context("ZIP entry escapes its directory")?;
    if unix_mode.is_some_and(|m| m & 0o170000 == 0o120000) {
        bail!(coded!(
            "zip.symbolicLink",
            "ZIP symbolic links are not accepted"
        ));
    }
    if is_dir {
        return Ok(None);
    }
    if size > MAX_ARCHIVE_FILE_BYTES {
        bail!(coded!(
            "zip.entryTooLarge",
            "ZIP entry exceeds the per-file limit"
        ));
    }
    let mut target = dir.to_path_buf();
    for part in name.components() {
        match part {
            std::path::Component::Normal(part) => target.push(part),
            std::path::Component::CurDir => {}
            _ => bail!("ZIP entry escapes its directory"),
        }
    }
    if target == dir {
        bail!("ZIP entry escapes its directory");
    }
    Ok(Some(target))
}

fn available_archive_bytes() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        MAX_ARCHIVE_BYTES.saturating_sub(crate::memory_fs::memory_bytes())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        MAX_ARCHIVE_BYTES
    }
}

/// Extracts every entry of the archive into `dir` (made by plan_zip), handing `extracted` each file's path once it is
/// written whole. Each entry is checked as it is written: a name that would leave `dir`, a symbolic link, a local
/// header that disagrees with the central directory, or an entry or the archive over its size limit stops the
/// extraction with an error.
fn extract_zip_into(
    path: &Path,
    dir: &Path,
    mut remaining: u64,
    extracted: &mut dyn FnMut(&Path),
) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(path)?)?;
    if archive.len() > MAX_FILES {
        bail!(coded!(
            "zip.tooManyEntries",
            "ZIP contains too many entries"
        ));
    }
    // The room is looked at before the first file, then once a second, and before any file large enough to take it.
    // Only Windows tells it (see `room`).
    #[cfg(windows)]
    let mut looked: Option<std::time::Instant> = None;
    for index in 0..archive.len() {
        crate::progress::check()?;
        let mut entry = archive.by_index_with_options(
            index,
            zip::ZipReadOptions::new().enforce_header_consistency(true),
        )?;
        let Some(target) = zip_target(
            dir,
            entry.enclosed_name(),
            entry.unix_mode(),
            entry.is_dir(),
            entry.size(),
        )?
        else {
            continue;
        };
        if entry.size() > remaining {
            bail!(coded!(
                "zip.tooLarge",
                "ZIP expanded data exceeds the import limit"
            ));
        }
        // The files leave this computer room: if something else fills its disk meanwhile, the extraction stops. Looked
        // at once a second at most, so that an archive of many small files is not slowed down, but before every large
        // file, which could take the room by itself.
        #[cfg(windows)]
        if entry.size() >= LARGE_ZIP_ENTRY
            || looked.is_none_or(|at| at.elapsed() >= std::time::Duration::from_secs(1))
        {
            looked = Some(std::time::Instant::now());
            if room().is_some_and(|room| room < entry.size().saturating_add(SPARE_BYTES / 2)) {
                bail!(zip_no_room());
            }
        }
        fs::create_dir_all(target.parent().context("Invalid ZIP path")?)?;
        let mut output = File::options().write(true).create_new(true).open(&target)?;
        let limit = remaining.min(MAX_ARCHIVE_FILE_BYTES);
        let copied = std::io::copy(&mut entry.by_ref().take(limit), &mut output)?;
        if copied == limit && entry.read(&mut [0])? != 0 {
            bail!(coded!(
                "zip.tooLarge",
                "ZIP expanded data exceeds the import limit"
            ));
        }
        remaining -= copied;
        output.flush()?;
        drop(output);
        extracted(&target);
    }
    Ok(())
}

/// The whole extraction at once, as the checks' tests use it.
#[cfg(test)]
fn extract_zip(path: &Path) -> Result<ArchiveTempDir> {
    let (dir, _) = plan_zip(path)?;
    extract_zip_into(path, dir.path(), available_archive_bytes(), &mut |_| {})?;
    Ok(dir)
}

fn parse_dt(value: &str) -> Option<NaiveDateTime> {
    if value.contains(['+', '-']) {
        return chrono::DateTime::parse_from_str(value, "%Y%m%d%H%M%S%.f%z")
            .ok()
            .map(|v| v.naive_utc());
    }
    let digits: String = value
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if digits.len() < 14 {
        return None;
    }
    NaiveDateTime::parse_from_str(&digits, "%Y%m%d%H%M%S%.f").ok()
}
fn parse_time(date: &str, time: &str) -> Option<NaiveDateTime> {
    let date = NaiveDate::parse_from_str(date, "%Y%m%d").ok()?;
    let mut time = time.to_owned();
    while time.len() < 6 {
        time.push('0');
    }
    Some(date.and_time(NaiveTime::parse_from_str(&time, "%H%M%S%.f").ok()?))
}
/// How a PET's stored values become SUV. `bw` gives SUVbw from Bq/ml (1 for values already in SUV); `lbm` and `bsa`
/// give SUL (lean body mass) and SUVbsa (body surface area) where the patient's height, and for SUL sex, allow.
#[derive(Clone, Copy, Debug, PartialEq)]
struct SuvFactors {
    bw: f64,
    lbm: Option<f64>,
    bsa: Option<f64>,
}

/// The unit of a PET's stored values. GML is an SUV already: by body weight unless SUV Type (0054,1006) names
/// another normalisation.
fn pet_value_unit(obj: &InMemDicomObject) -> String {
    match text(obj, Tag(0x0054, 0x1001)).as_str() {
        "GML" => match text(obj, Tag(0x0054, 0x1006)).to_ascii_uppercase().as_str() {
            "" | "BW" => "SUVbw",
            "LBM" => "SUVlbm",
            "BSA" => "SUVbsa",
            "IBW" => "SUVibw",
            _ => "SUV",
        }
        .into(),
        "BQML" => "Bq/ml".into(),
        u => u.into(),
    }
}

/// Two frames' SUV factors agree to within 0.1%. A scan start worked back from a frame's timing lands within about
/// a second of Series Time, which for F-18 or Ga-68 moves SUV by under 0.02%.
fn same_calibration(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => (a - b).abs() <= 1e-3 * a.abs().max(b.abs()),
        (a, b) => a.is_none() && b.is_none(),
    }
}

/// A frame joins `group`: SUV only while every frame agrees on it. SUL and SUVbsa go quietly when only they differ
/// (the patient's height or sex recorded differently).
fn merge_calibration(group: &mut Series, info: &Series) {
    if group.suv_factor.is_some() && !same_calibration(group.suv_factor, info.suv_factor) {
        group.suv_factor = None;
        group.warnings.push(note!(
            "series.suvDiffers",
            "SUV unavailable: calibration differs between source frames"
        ));
    }
    if group.suv_factor.is_none() || !same_calibration(group.sul_factor, info.sul_factor) {
        group.sul_factor = None;
    }
    if group.suv_factor.is_none() || !same_calibration(group.suv_bsa_factor, info.suv_bsa_factor) {
        group.suv_bsa_factor = None;
    }
}

/// SUVbw to SUL and to SUVbsa: lean body mass over weight (Janmahasatian et al. 2005, recommended for SUL by Tahari
/// et al. 2014) and body surface area in cm² over weight in g (Du Bois and Du Bois 1916). None without a weight and a
/// height in metres (Patient's Size; a value outside 0.3–2.5 m is not guessed to be centimetres), and for SUL also
/// without a recorded male or female sex.
fn body_size_ratios(obj: &InMemDicomObject) -> (Option<f64>, Option<f64>) {
    let weight = number(obj, Tag(0x0010, 0x1030)).filter(|v| *v > 0.);
    let height = number(obj, Tag(0x0010, 0x1020)).filter(|v| (0.3..=2.5).contains(v));
    let (Some(weight), Some(height)) = (weight, height) else {
        return (None, None);
    };
    let bmi = weight / (height * height);
    let lbm = match text(obj, Tag(0x0010, 0x0040)).to_ascii_uppercase().as_str() {
        "M" => Some(9270. * weight / (6680. + 216. * bmi)),
        "F" => Some(9270. * weight / (8780. + 244. * bmi)),
        _ => None,
    };
    let bsa = 0.007184 * weight.powf(0.425) * (height * 100.).powf(0.725);
    let ratio = |value: f64| Some(value).filter(|v| v.is_finite() && *v > 0.);
    (
        lbm.and_then(|lbm| ratio(lbm / weight)),
        ratio(bsa * 10. / weight),
    )
}

/// A private element's text, found through its private creator in any block of `group`, and read from its bytes:
/// implicit-VR files give private elements as UN.
fn private_text(obj: &InMemDicomObject, group: u16, creator: &str, element: u16) -> Option<String> {
    let ascii = |tag: Tag| -> Option<String> {
        let bytes = obj.get(tag)?.to_bytes().ok()?;
        let value = std::str::from_utf8(&bytes)
            .ok()?
            .trim_matches([' ', '\0'])
            .to_owned();
        (!value.is_empty()).then_some(value)
    };
    let block = (0x10..=0xffu16).find(|block| {
        ascii(Tag(group, *block)).is_some_and(|name| name.eq_ignore_ascii_case(creator))
    })?;
    ascii(Tag(group, (block << 8) | element))
}

/// GE's own names in Manufacturer ("GE MEDICAL SYSTEMS", "GE Healthcare").
fn is_ge(manufacturer: &str) -> bool {
    let name = manufacturer.trim().to_ascii_uppercase();
    name == "GE"
        || name.starts_with("GE ")
        || name.starts_with("GEMS")
        || name.contains("GENERAL ELECTRIC")
}

/// A date and time on the scanner's clock. An empty time is not taken for midnight.
fn wall_clock(date: &str, time: &str) -> Option<NaiveDateTime> {
    if time.trim().is_empty() {
        return None;
    }
    parse_time(date.trim(), time.trim())
}

/// A scanner-clock time in the file's own base: UTC when it gives Timezone Offset From UTC, else as stored.
fn in_file_base(at: NaiveDateTime, offset: &str) -> Option<NaiveDateTime> {
    if offset.is_empty() {
        Some(at)
    } else {
        parse_dt(&format!("{}{offset}", at.format("%Y%m%d%H%M%S%.f")))
    }
}

/// When this file's frame (its bed position) began, on the scanner's clock, and that day (YYYYMMDD): Acquisition
/// DateTime, else Acquisition Date (or the Series Date) and Acquisition Time.
fn acquisition_start(obj: &InMemDicomObject, series_date: &str) -> Option<(NaiveDateTime, String)> {
    let date_time = text(obj, Tag(0x0008, 0x002a));
    let (date, time) =
        if date_time.len() >= 14 && date_time.as_bytes()[..14].iter().all(u8::is_ascii_digit) {
            // Any offset it carries is the scanner's own; the clock reading is what Series Time is compared with.
            let clock = date_time.split(['+', '-']).next().unwrap_or_default();
            (clock[..8].to_owned(), clock[8..].to_owned())
        } else {
            let date = text(obj, Tag(0x0008, 0x0022));
            (
                if date.is_empty() {
                    series_date.to_owned()
                } else {
                    date
                },
                text(obj, Tag(0x0008, 0x0032)),
            )
        };
    Some((wall_clock(&date, &time)?, date))
}

/// The scan start that START-corrected values are decay-corrected to, on the scanner's clock, after QIBA's
/// vendor-neutral SUV pseudo-code (2018): Series Date and Time, unless they are after the acquisition, as in a
/// series reconstructed or processed later. Then GE's private scan date-time, else the start worked back from
/// this frame's timing. None when neither is there.
fn scan_start(
    obj: &InMemDicomObject,
    series: NaiveDateTime,
    series_date: &str,
    half_life: f64,
) -> Option<NaiveDateTime> {
    let Some((acquired, acquired_date)) = acquisition_start(obj, series_date) else {
        return Some(series);
    };
    if series <= acquired {
        return Some(series);
    }
    if let Some(value) = private_text(obj, 0x0009, "GEMS_PETD_01", 0x0d) {
        // Its time of day only, on the acquisition's day: archives were found to shift this element's date apart
        // from the others (arXiv 2410.13348).
        let digits = value.split(['+', '-']).next().unwrap_or_default();
        if digits.len() >= 12 && digits.as_bytes()[..12].iter().all(u8::is_ascii_digit) {
            let at = wall_clock(&acquired_date, &digits[8..])?;
            return if at > acquired {
                at.checked_sub_signed(chrono::TimeDelta::days(1))
            } else {
                Some(at)
            };
        }
    }
    // Acquisition Date and Time start this frame. Frame Reference Time (ms) runs from the scan start to the frame's
    // average count-rate time; GE's runs to the frame's start instead (arXiv 2410.13348, eqs. 3 and 6).
    let reference = number(obj, Tag(0x0054, 0x1300)).filter(|v| *v >= 0.)? / 1000.;
    let back = if is_ge(&text(obj, Tag(0x0008, 0x0070))) {
        reference
    } else {
        let duration = number(obj, Tag(0x0018, 0x1242)).filter(|v| *v > 0.)? / 1000.;
        if reference <= 0. {
            return None;
        }
        let lambda = std::f64::consts::LN_2 / half_life;
        let decay = lambda * duration;
        reference - (decay / (1. - (-decay).exp())).ln() / lambda
    };
    if !back.is_finite() || back.abs() > 86_400. {
        return None;
    }
    acquired.checked_sub_signed(chrono::TimeDelta::try_milliseconds(
        (back * 1000.).round() as i64
    )?)
}

/// Seconds from the injection to `scan` (in the file's base). A start time without a date is taken on the scan's
/// day, or the day before when that puts it over 12 hours after the scan (an injection before midnight).
fn injection_elapsed(
    drug: &InMemDicomObject,
    scan: NaiveDateTime,
    scan_day: &str,
    offset: &str,
) -> Option<f64> {
    elapsed_from_injection(
        &text(drug, Tag(0x0018, 0x1078)),
        &text(drug, Tag(0x0018, 0x1072)),
        scan,
        scan_day,
        offset,
        !offset.is_empty(),
    )
}

fn elapsed_from_injection(
    injection_dt: &str,
    injection_time: &str,
    scan: NaiveDateTime,
    scan_day: &str,
    offset: &str,
    scan_zoned: bool,
) -> Option<f64> {
    let injection_zoned = injection_dt.contains(['+', '-']) || !offset.is_empty();
    if injection_zoned != scan_zoned {
        return None;
    }
    let explicit_date = !injection_dt.is_empty();
    let injection = if explicit_date {
        if injection_dt.contains(['+', '-']) {
            parse_dt(injection_dt)?
        } else {
            parse_dt(&format!("{injection_dt}{offset}"))?
        }
    } else {
        in_file_base(wall_clock(scan_day, injection_time)?, offset)?
    };
    let mut seconds = (scan - injection).num_milliseconds() as f64 / 1000.;
    if seconds < 0. && !explicit_date && seconds <= -43200. {
        seconds += 86400.;
    }
    (seconds >= 0.).then_some(seconds)
}

fn suv_factor(obj: &InMemDicomObject) -> (Option<SuvFactors>, Vec<crate::message::Note>) {
    // QIBA: SUV only from images corrected for attenuation and decay. An empty Corrected Image is not held against a
    // file; one that lists its corrections without ATTN or DECY (a non-attenuation-corrected series) gets none.
    let corrections = text(obj, Tag(0x0028, 0x0051)).to_ascii_uppercase();
    if !corrections.is_empty() {
        let listed: Vec<&str> = corrections.split('\\').map(str::trim).collect();
        if !listed.contains(&"ATTN") || !listed.contains(&"DECY") {
            return (
                None,
                vec![note!(
                    "series.suvNotCorrected",
                    "SUV unavailable: the image is not corrected for attenuation and decay"
                )],
            );
        }
    }
    let with_body = |bw: f64| {
        let (lbm, bsa) = body_size_ratios(obj);
        SuvFactors {
            bw,
            lbm: lbm.map(|ratio| bw * ratio),
            bsa: bsa.map(|ratio| bw * ratio),
        }
    };
    let units = text(obj, Tag(0x0054, 0x1001));
    if units == "GML" {
        // Already SUV. Only an SUV by body weight converts to SUL or SUVbsa.
        let by_weight = matches!(
            text(obj, Tag(0x0054, 0x1006)).to_ascii_uppercase().as_str(),
            "" | "BW"
        );
        let factors = if by_weight {
            with_body(1.)
        } else {
            SuvFactors {
                bw: 1.,
                lbm: None,
                bsa: None,
            }
        };
        return (Some(factors), Vec::new());
    }
    if matches!(units.as_str(), "CNTS" | "BQML")
        && let Some(factor) = number(obj, Tag(0x7053, 0x1000)).filter(|v| *v > 0.)
    {
        return (Some(with_body(factor)), Vec::new());
    }
    if units != "BQML" {
        return (
            None,
            vec![note!(
                "series.suvNotCalibrated",
                "SUV unavailable: PET values are not calibrated Bq/ml or SUV"
            )],
        );
    }
    let incomplete = || {
        (
            None,
            vec![note!(
                "series.suvIncomplete",
                "SUV unavailable: incomplete or inconsistent weight, dose, decay correction, or injection timing"
            )],
        )
    };
    let weight = number(obj, Tag(0x0010, 0x1030)).filter(|v| *v > 0.);
    let drug = single_administration(obj);
    let dose = drug
        .and_then(|drug| number(drug, Tag(0x0018, 0x1074)))
        .filter(|v| *v > 0.);
    let half_life = drug
        .and_then(|drug| number(drug, Tag(0x0018, 0x1075)))
        .filter(|v| *v > 0.);
    let (Some(weight), Some(drug), Some(dose), Some(half_life)) = (weight, drug, dose, half_life)
    else {
        return incomplete();
    };
    let elapsed = match text(obj, Tag(0x0054, 0x1102)).as_str() {
        "ADMIN" => 0.,
        "START" => {
            let offset = text(obj, Tag(0x0008, 0x0201));
            let series_date = text(obj, Tag(0x0008, 0x0021));
            let Some(series) = wall_clock(&series_date, &text(obj, Tag(0x0008, 0x0031))) else {
                return incomplete();
            };
            let Some(scan) = scan_start(obj, series, &series_date, half_life) else {
                return (
                    None,
                    vec![note!(
                        "series.suvScanStart",
                        "SUV unavailable: Series Time is after the acquisition and the scan start cannot be worked out"
                    )],
                );
            };
            let day = scan.format("%Y%m%d").to_string();
            match in_file_base(scan, &offset)
                .and_then(|at| injection_elapsed(drug, at, &day, &offset))
            {
                Some(seconds) => seconds,
                None => return incomplete(),
            }
        }
        _ => return incomplete(),
    };
    let factor = weight * 1000. / (dose * 2f64.powf(-elapsed / half_life));
    if factor.is_finite() {
        (Some(with_body(factor)), Vec::new())
    } else {
        incomplete()
    }
}

/// A code item's value: Code Value, else Long Code Value.
fn code_value(item: &InMemDicomObject) -> String {
    nonempty_text(item, Tag(0x0008, 0x0100))
        .or_else(|| nonempty_text(item, Tag(0x0008, 0x0119)))
        .unwrap_or_default()
}

/// LOINC's codes for blood glucose: in serum or plasma and in blood, by amount (mmol/l) and by mass (mg/dl).
const GLUCOSE_CODES: [&str; 4] = ["14749-6", "15074-8", "2345-7", "2339-0"];
/// mg/dl in one mmol/l of glucose (CP-1229).
const GLUCOSE_MG_PER_MMOL: f64 = 18.0182;

/// Blood glucose in mmol/l, where CP-1229 records it: a numeric item of the Acquisition Context (0040,0555) named
/// (14749-6, LN, "Glucose") in mmol/l. A value in mg/dl is converted; one in any other unit is not guessed.
fn glucose(obj: &InMemDicomObject) -> Option<f64> {
    let mut values = obj
        .get(Tag(0x0040, 0x0555))?
        .items()?
        .iter()
        .filter_map(|item| {
            let concept = first(item, Tag(0x0040, 0xa043))?;
            if text(concept, Tag(0x0008, 0x0102)) != "LN"
                || !GLUCOSE_CODES.contains(&code_value(concept).as_str())
            {
                return None;
            }
            // Numeric Value and its unit sit in the item itself, or in a Measured Value Sequence as in a report.
            let measured = first(item, Tag(0x0040, 0xa300)).unwrap_or(item);
            let value = number(measured, Tag(0x0040, 0xa30a))?;
            let unit = first(measured, Tag(0x0040, 0x08ea))?;
            if text(unit, Tag(0x0008, 0x0102)) != "UCUM" {
                return None;
            }
            let mmol = match code_value(unit).as_str() {
                "mmol/L" | "mmol/l" => value,
                "mg/dL" | "mg/dl" => value / GLUCOSE_MG_PER_MMOL,
                _ => return None,
            };
            (mmol.is_finite() && mmol > 0.).then_some(mmol)
        });
    let first = values.next()?;
    values.all(|v| (v - first).abs() < 1e-6).then_some(first)
}

fn administrations(obj: &InMemDicomObject) -> &[InMemDicomObject] {
    obj.get(Tag(0x0054, 0x0016))
        .and_then(|element| element.items())
        .unwrap_or_default()
}

fn single_administration(obj: &InMemDicomObject) -> Option<&InMemDicomObject> {
    match administrations(obj) {
        [one] => Some(one),
        _ => None,
    }
}

fn pet_tracer(obj: &InMemDicomObject) -> PetAcquisition {
    let drug = single_administration(obj);
    let code = drug.and_then(|item| first(item, Tag(0x0054, 0x0304)));
    PetAcquisition {
        multiple_administrations: administrations(obj).len() > 1,
        tracer: drug
            .map(|item| text(item, Tag(0x0018, 0x0031)))
            .unwrap_or_default(),
        tracer_code: code.map(code_value).unwrap_or_default(),
        tracer_code_scheme: code
            .map(|item| text(item, Tag(0x0008, 0x0102)))
            .unwrap_or_default(),
        tracer_code_meaning: code
            .map(|item| text(item, Tag(0x0008, 0x0104)))
            .unwrap_or_default(),
        ..PetAcquisition::default()
    }
}

impl PetAcquisition {
    fn merge_tracer(&mut self, other: &Self) {
        self.multiple_administrations |= other.multiple_administrations
            || (!self.tracer_code.is_empty()
                && !other.tracer_code.is_empty()
                && self.tracer_code != other.tracer_code)
            || (!self.tracer_code_scheme.is_empty()
                && !other.tracer_code_scheme.is_empty()
                && self.tracer_code_scheme != other.tracer_code_scheme)
            || ((self.tracer_code.is_empty() || other.tracer_code.is_empty())
                && !self.tracer.is_empty()
                && !other.tracer.is_empty()
                && !self.tracer.eq_ignore_ascii_case(&other.tracer));
        if self.multiple_administrations {
            self.tracer.clear();
            self.tracer_code.clear();
            self.tracer_code_scheme.clear();
            self.tracer_code_meaning.clear();
            return;
        }
        for (mine, theirs) in [
            (&mut self.tracer, &other.tracer),
            (&mut self.tracer_code, &other.tracer_code),
            (&mut self.tracer_code_scheme, &other.tracer_code_scheme),
            (&mut self.tracer_code_meaning, &other.tracer_code_meaning),
        ] {
            if mine.is_empty() {
                mine.clone_from(theirs);
            }
        }
    }
}

fn pet_scan_start(obj: &InMemDicomObject) -> String {
    let offset = text(obj, Tag(0x0008, 0x0201));
    let with_offset = |mut stamp: String| {
        if !stamp.contains(['+', '-']) {
            stamp.push_str(&offset);
        }
        Some((parse_dt(&stamp)?, stamp))
    };
    let top = with_offset(text(obj, Tag(0x0008, 0x002a))).or_else(|| {
        let at = wall_clock(
            &text(obj, Tag(0x0008, 0x0022)),
            &text(obj, Tag(0x0008, 0x0032)),
        )?;
        with_offset(at.format("%Y%m%d%H%M%S%.f").to_string())
    });
    // Enhanced PET may give the acquisition time only in Frame Content functional groups.
    let frame_times = [Tag(0x5200, 0x9229), Tag(0x5200, 0x9230)]
        .into_iter()
        .flat_map(|tag| {
            obj.get(tag)
                .and_then(|element| element.items())
                .unwrap_or_default()
        })
        .filter_map(|group| {
            with_offset(text(
                first(group, Tag(0x0020, 0x9111))?,
                Tag(0x0018, 0x9074),
            ))
        });
    top.into_iter()
        .chain(frame_times)
        .min_by_key(|(at, _)| *at)
        .map(|(_, stamp)| stamp)
        .unwrap_or_default()
}

fn pet_acquisition(obj: &InMemDicomObject) -> PetAcquisition {
    let drug = single_administration(obj);
    let drug_text = |tag: Tag| drug.map(|drug| text(drug, tag)).unwrap_or_default();
    let drug_number = |tag: Tag| {
        drug.and_then(|drug| number(drug, tag))
            .filter(|value| *value > 0.)
    };
    let half_life = drug_number(Tag(0x0018, 0x1075));
    let mut pet = PetAcquisition {
        radionuclide: drug
            .and_then(|drug| first(drug, Tag(0x0054, 0x0300)))
            .map(|code| text(code, Tag(0x0008, 0x0104)))
            .unwrap_or_default(),
        injected_activity: drug_number(Tag(0x0018, 0x1074)),
        half_life,
        injection_date_time: drug_text(Tag(0x0018, 0x1078)),
        injection_time: drug_text(Tag(0x0018, 0x1072)),
        injection_offset: if drug.is_some() {
            text(obj, Tag(0x0008, 0x0201))
        } else {
            String::new()
        },
        scan_start: pet_scan_start(obj),
        uptake_seconds: None,
        weight: number(obj, Tag(0x0010, 0x1030)).filter(|value| *value > 0.),
        height: number(obj, Tag(0x0010, 0x1020)).filter(|value| *value > 0.),
        glucose: glucose(obj),
        decay_correction: text(obj, Tag(0x0054, 0x1102)),
        scanner_model: text(obj, Tag(0x0008, 0x1090)),
        reconstruction: text(obj, Tag(0x0054, 0x1103)),
        ..pet_tracer(obj)
    };
    pet.uptake_seconds = pet.uptake();
    pet
}

impl PetAcquisition {
    fn uptake(&self) -> Option<f64> {
        let at = parse_dt(&self.scan_start)?;
        // For a time without a date, use the acquisition day on the injection clock.
        let day = if self.injection_date_time.is_empty() && !self.injection_offset.is_empty() {
            let epoch = "20000101000000";
            let shift = parse_dt(epoch)? - parse_dt(&format!("{epoch}{}", self.injection_offset))?;
            at.checked_add_signed(shift)?.format("%Y%m%d").to_string()
        } else {
            self.scan_start[..8].to_owned()
        };
        elapsed_from_injection(
            &self.injection_date_time,
            &self.injection_time,
            at,
            &day,
            &self.injection_offset,
            self.scan_start.contains(['+', '-']),
        )
    }

    fn merge(&mut self, other: &Self) {
        fn fill(mine: &mut String, theirs: &str) {
            if mine.is_empty() {
                mine.push_str(theirs);
            }
        }
        fn differs(a: &str, b: &str) -> bool {
            !a.is_empty() && !b.is_empty() && a != b
        }
        self.weight = self.weight.or(other.weight);
        self.height = self.height.or(other.height);
        self.glucose = self.glucose.or(other.glucose);
        fill(&mut self.decay_correction, &other.decay_correction);
        fill(&mut self.scanner_model, &other.scanner_model);
        fill(&mut self.reconstruction, &other.reconstruction);
        if let Some(theirs) = parse_dt(&other.scan_start)
            && parse_dt(&self.scan_start).is_none_or(|mine| theirs < mine)
        {
            self.scan_start.clone_from(&other.scan_start);
        }
        self.multiple_administrations |= other.multiple_administrations
            || differs(&self.injection_date_time, &other.injection_date_time)
            || differs(&self.injection_time, &other.injection_time)
            || self
                .injected_activity
                .zip(other.injected_activity)
                .is_some_and(|(a, b)| a != b);
        self.merge_tracer(other);
        if self.multiple_administrations {
            self.radionuclide.clear();
            self.injection_date_time.clear();
            self.injection_time.clear();
            self.injection_offset.clear();
            self.injected_activity = None;
            self.half_life = None;
            self.uptake_seconds = None;
            return;
        }
        fill(&mut self.radionuclide, &other.radionuclide);
        fill(&mut self.injection_date_time, &other.injection_date_time);
        fill(&mut self.injection_time, &other.injection_time);
        fill(&mut self.injection_offset, &other.injection_offset);
        self.injected_activity = self.injected_activity.or(other.injected_activity);
        self.half_life = self.half_life.or(other.half_life);
        self.uptake_seconds = self.uptake();
    }
}

/// The most parts of the body one series is let name, and the longest name kept (CS holds 16 characters).
const MAX_BODY_PARTS: usize = 8;
const MAX_BODY_PART_TEXT: usize = 64;

/// A file joins a series: a Body Part Examined it records that the series does not name yet is added. A series whose
/// first file lacks the value still has it, and one whose files name several parts names them all, as a
/// multi-valued attribute would (`HEAD\NECK`): a comparison then never takes it for a series of no known part.
fn merge_anatomy_value(series: &mut String, file: &str) {
    let part = file.trim();
    if part.is_empty() || part.len() > MAX_BODY_PART_TEXT {
        return;
    }
    let named = || series.split('\\').filter(|name| !name.is_empty());
    let known = named().any(|name| name.eq_ignore_ascii_case(part));
    if known || named().count() >= MAX_BODY_PARTS {
        return;
    }
    if !series.is_empty() {
        series.push('\\');
    }
    series.push_str(part);
}

/// A file joins `group`: the PET details it records that the series' first file lacks are added.
fn merge_pet_acquisition(group: &mut Series, info: &Series) {
    if let Some(theirs) = &info.acquisition.pet_acquisition {
        match &mut group.acquisition.pet_acquisition {
            Some(mine) => mine.merge(theirs),
            None => group.acquisition.pet_acquisition = Some(theirs.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The tests write real files on the desktop's own file system.
    use dicom_core::{DataElement, VR};
    use std::fs;
    /// A test's folder read as a disc: no drive is asked about it, and its copies may take any room.
    const ANY_DISC: Disc = Disc {
        size: u64::MAX,
        serial: None,
    };
    #[test]
    fn folder_walk_skips_hidden_entries_and_never_follows_links_inside() {
        let root = crate::test_dir::tempdir().unwrap();
        let outside = crate::test_dir::tempdir().unwrap();
        let write = |path: &Path| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"synthetic").unwrap();
        };
        for name in [
            "a.dcm",
            "sub/b.dcm",
            "sub/deeper/c",
            "sub/notes.txt",
            ".hidden.dcm",
            ".cache/d.dcm",
            "sub/.e.dcm",
        ] {
            write(&root.path().join(name));
        }
        write(&outside.path().join("f.dcm"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("linked-folder")).unwrap();
            std::os::unix::fs::symlink(
                outside.path().join("f.dcm"),
                root.path().join("linked.dcm"),
            )
            .unwrap();
        }
        let relative = |files: &[PathBuf], base: &Path| {
            let mut names = files
                .iter()
                .map(|file| {
                    file.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect::<Vec<_>>();
            names.sort();
            names
        };
        let mut files = Vec::new();
        collect_files(root.path(), &mut files).unwrap();
        assert_eq!(
            relative(&files, root.path()),
            ["a.dcm", "sub/b.dcm", "sub/deeper/c"]
        );
        // The selected folder itself is followed when it is a link.
        #[cfg(unix)]
        {
            let link = outside.path().join("selected");
            std::os::unix::fs::symlink(root.path().join("sub"), &link).unwrap();
            let mut files = Vec::new();
            collect_files(&link, &mut files).unwrap();
            assert_eq!(relative(&files, &link), ["b.dcm", "deeper/c"]);
        }
        // A missing folder is an error, as it was before.
        let mut files = Vec::new();
        collect_files(&root.path().join("missing"), &mut files).unwrap_err();
        assert!(files.is_empty());
    }
    fn sequence(tag: Tag, items: Vec<InMemDicomObject>) -> DataElement<InMemDicomObject> {
        DataElement::new(
            tag,
            VR::SQ,
            dicom_core::value::DataSetSequence::new(items, dicom_core::Length::UNDEFINED),
        )
    }
    fn metadata_object(frame_count: usize) -> InMemDicomObject {
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.4.1"),
            DataElement::new(Tag(0x0008, 0x0018), VR::UI, "1.2.3.4.5"),
            DataElement::new(Tag(0x0008, 0x0060), VR::CS, "MR"),
            DataElement::new(Tag(0x0020, 0x000d), VR::UI, "1.2.3"),
            DataElement::new(Tag(0x0020, 0x000e), VR::UI, "1.2.3.4"),
            DataElement::new(Tag(0x0020, 0x0052), VR::UI, "1.2.3.99"),
            DataElement::new(Tag(0x0028, 0x0004), VR::CS, "MONOCHROME2"),
            DataElement::new(Tag(0x0028, 0x0008), VR::IS, frame_count.to_string()),
            DataElement::new(Tag(0x0028, 0x0030), VR::DS, "1\\1"),
            DataElement::new(Tag(0x0020, 0x0037), VR::DS, "1\\0\\0\\0\\1\\0"),
            DataElement::new(Tag(0x0018, 0x0050), VR::DS, "2"),
        ]);
        for (tag, value) in [
            (Tag(0x0028, 0x0010), 2u16),
            (Tag(0x0028, 0x0011), 2),
            (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), 16),
            (Tag(0x0028, 0x0101), 16),
            (Tag(0x0028, 0x0102), 15),
            (Tag(0x0028, 0x0103), 1),
        ] {
            obj.put(DataElement::new(
                tag,
                VR::US,
                dicom_core::PrimitiveValue::from(value),
            ));
        }
        obj.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OW,
            dicom_core::PrimitiveValue::U16(vec![1000; 4 * frame_count].into()),
        ));
        obj
    }
    fn write_metadata(obj: InMemDicomObject, path: &Path) {
        let class = text(&obj, Tag(0x0008, 0x0016));
        let instance = text(&obj, Tag(0x0008, 0x0018));
        obj.with_meta(
            dicom_object::FileMetaTableBuilder::new()
                .media_storage_sop_class_uid(class)
                .media_storage_sop_instance_uid(instance)
                .transfer_syntax("1.2.840.10008.1.2.1"),
        )
        .unwrap()
        .write_to_file(path)
        .unwrap();
    }
    fn ds(tag: Tag, value: &str) -> DataElement<InMemDicomObject> {
        DataElement::new(tag, VR::DS, value)
    }
    #[test]
    fn cine_catalog_keeps_source_order_and_gates_mixed_instances() {
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("clip.dcm");
        let mut obj = metadata_object(4);
        obj.put(DataElement::new(
            Tag(0x0028, 0x0009),
            VR::AT,
            PrimitiveValue::from(Tag(0x0018, 0x1065)),
        ));
        obj.put(DataElement::new(
            Tag(0x0018, 0x1065),
            VR::DS,
            "0\\25\\75\\45",
        ));
        obj.put(DataElement::new(Tag(0x0008, 0x2142), VR::IS, "2"));
        obj.put(DataElement::new(Tag(0x0008, 0x2143), VR::IS, "4"));
        obj.put(DataElement::new(
            Tag(0x0018, 0x1244),
            VR::US,
            PrimitiveValue::from(1u16),
        ));
        let positions = ["0\\0\\6", "0\\0\\4", "0\\0\\2", "0\\0\\0"].map(|value| {
            InMemDicomObject::from_element_iter([sequence(
                Tag(0x0020, 0x9113),
                vec![InMemDicomObject::from_element_iter([DataElement::new(
                    Tag(0x0020, 0x0032),
                    VR::DS,
                    value,
                )])],
            )])
        });
        obj.put(sequence(Tag(0x5200, 0x9230), positions.into()));
        write_metadata(obj.clone(), &path);
        let result = import(&[path.to_string_lossy().into_owned()]).unwrap();
        let timing = result.sources[0].info.cine.as_ref().unwrap();
        assert_eq!(timing.slices, [2, 1, 0]);
        assert_eq!(timing.intervals_ms, [75., 45.]);
        assert!(timing.sweeping);
        obj.put(DataElement::new(Tag(0x0008, 0x0018), VR::UI, "1.2.3.4.6"));
        write_metadata(obj, &temp.path().join("second.dcm"));
        let both = import(&[temp.path().to_string_lossy().into_owned()]).unwrap();
        assert!(both.sources.iter().all(|source| source.info.cine.is_none()));
    }

    #[test]
    fn metadata_preserves_frame_overrides_shared_fallback_and_decoded_order() {
        let mut obj = metadata_object(2);
        obj.put(ds(Tag(0x0028, 0x1050), "500"));
        obj.put(ds(Tag(0x0028, 0x1051), "1000"));
        obj.put_str(Tag(0x0020, 0x0013), VR::IS, "101");
        obj.put(DataElement::new(
            Tag(0x0028, 0x0120),
            VR::SS,
            dicom_core::PrimitiveValue::from(-100i16),
        ));
        obj.put(DataElement::new(
            Tag(0x0028, 0x0121),
            VR::SS,
            dicom_core::PrimitiveValue::from(-50i16),
        ));
        obj.put(sequence(
            Tag(0x5200, 0x9229),
            vec![InMemDicomObject::from_element_iter([
                sequence(
                    Tag(0x0028, 0x9110),
                    vec![InMemDicomObject::from_element_iter([
                        ds(Tag(0x0028, 0x0030), "0.8\\0.6"),
                        ds(Tag(0x0018, 0x0050), "3"),
                    ])],
                ),
                sequence(
                    Tag(0x0028, 0x9132),
                    vec![InMemDicomObject::from_element_iter([
                        ds(Tag(0x0028, 0x1050), "70\\90"),
                        ds(Tag(0x0028, 0x1051), "140\\180"),
                    ])],
                ),
                sequence(
                    Tag(0x0028, 0x9145),
                    vec![InMemDicomObject::from_element_iter([
                        ds(Tag(0x0028, 0x1053), "2"),
                        ds(Tag(0x0028, 0x1052), "-10"),
                    ])],
                ),
            ])],
        ));
        let first = InMemDicomObject::from_element_iter([
            sequence(
                Tag(0x0020, 0x9113),
                vec![InMemDicomObject::from_element_iter([ds(
                    Tag(0x0020, 0x0032),
                    "0\\0\\8",
                )])],
            ),
            sequence(
                Tag(0x0028, 0x9110),
                vec![InMemDicomObject::from_element_iter([ds(
                    Tag(0x0018, 0x0050),
                    "4",
                )])],
            ),
            sequence(
                Tag(0x0028, 0x9132),
                vec![InMemDicomObject::from_element_iter([ds(
                    Tag(0x0028, 0x1050),
                    "30",
                )])],
            ),
        ]);
        let second = InMemDicomObject::from_element_iter([
            sequence(
                Tag(0x0020, 0x9113),
                vec![InMemDicomObject::from_element_iter([ds(
                    Tag(0x0020, 0x0032),
                    "0\\0\\2",
                )])],
            ),
            sequence(
                Tag(0x0028, 0x9145),
                vec![InMemDicomObject::from_element_iter([ds(
                    Tag(0x0028, 0x1053),
                    "-2",
                )])],
            ),
        ]);
        obj.put(sequence(Tag(0x5200, 0x9230), vec![first, second]));
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("enhanced.dcm");
        write_metadata(obj, &path);
        let imported = import(&[path.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(imported.sources.len(), 1);
        let source = &imported.sources[0];
        let frames = &source.info.frame_metadata;
        assert_eq!(
            source.frames.iter().map(|f| f.index).collect::<Vec<_>>(),
            vec![1, 0]
        );
        assert_eq!(frames[0].origin, [0., 0., 2.]);
        assert_eq!(frames[1].origin, [0., 0., 8.]);
        assert_eq!(frames[0].window_center, Some(70.));
        assert_eq!(frames[1].window_center, Some(30.));
        assert_eq!(frames[1].window_width, Some(140.));
        assert_eq!(frames[1].spacing, [0.6, 0.8, 4.]);
        assert_eq!(frames[0].padding_range, Some([90., 190.]));
        assert_eq!(frames[1].padding_range, Some([-210., -110.]));
        assert_eq!(source.info.padding_range, None);
        assert_eq!(frames[0].instance_number, Some(101));
        assert_eq!(frames[0].source_frame_number, Some(2));
        assert_eq!(frames[0].sop_instance_uid, "1.2.3.4.5");
        assert_eq!(source.info.window_center, 70.);
    }
    #[test]
    fn enhanced_contrast_usage_is_frame_specific_and_pre_post_do_not_merge() {
        let mut obj = metadata_object(2);
        obj.put_str(
            Tag(0x0018, 0x0010),
            VR::LO,
            "Gadobutrol copied across study",
        );
        obj.put_str(Tag(0x0018, 0x1040), VR::LO, "IV");
        obj.put_str(Tag(0x0018, 0x1030), VR::LO, "T1 neck");
        obj.put_str(Tag(0x0018, 0x0024), VR::SH, "*tse2d");
        obj.put_str(Tag(0x0018, 0x0020), VR::CS, "SE");
        obj.put(ds(Tag(0x0018, 0x0080), "500"));
        obj.put(ds(Tag(0x0018, 0x0081), "10"));
        let groups = ["PRE_CONTRAST", "POST_CONTRAST"]
            .iter()
            .enumerate()
            .map(|(i, phase)| {
                InMemDicomObject::from_element_iter([
                    sequence(
                        Tag(0x0020, 0x9113),
                        vec![InMemDicomObject::from_element_iter([ds(
                            Tag(0x0020, 0x0032),
                            &format!("0\\0\\{}", i * 2),
                        )])],
                    ),
                    sequence(
                        Tag(0x0018, 0x9341),
                        vec![InMemDicomObject::from_element_iter([
                            DataElement::new(Tag(0x0018, 0x9344), VR::CS, *phase),
                            DataElement::new(
                                Tag(0x0018, 0x9342),
                                VR::CS,
                                if i == 0 { "NO" } else { "YES" },
                            ),
                        ])],
                    ),
                    sequence(
                        Tag(0x0018, 0x9226),
                        vec![InMemDicomObject::from_element_iter([
                            DataElement::new(Tag(0x0008, 0x9007), VR::CS, "ORIGINAL\\PRIMARY\\M"),
                            DataElement::new(Tag(0x0008, 0x9209), VR::CS, "T1"),
                        ])],
                    ),
                ])
            })
            .collect();
        obj.put(sequence(Tag(0x5200, 0x9230), groups));
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("contrast.dcm");
        write_metadata(obj, &path);
        let rows = read_frames(&path).unwrap();
        assert_ne!(rows[0].0, rows[1].0);
        assert_eq!(rows[0].1.acquisition.contrast_bolus_phase, "PRE_CONTRAST");
        assert_eq!(rows[0].1.acquisition.contrast_bolus_administered, "NO");
        assert_eq!(rows[1].1.acquisition.contrast_bolus_administered, "YES");
        assert_eq!(
            rows[0].1.acquisition.contrast_bolus_agent,
            "Gadobutrol copied across study"
        );
        assert_eq!(rows[0].1.acquisition.acquisition_contrast, "T1");
        assert_eq!(
            import(&[path.to_string_lossy().into_owned()])
                .unwrap()
                .sources
                .len(),
            2
        );
    }
    #[test]
    fn contrast_usage_aggregates_all_agents_and_shared_timing_is_retained() {
        let mut obj = metadata_object(1);
        obj.put(sequence(
            Tag(0x5200, 0x9229),
            vec![InMemDicomObject::from_element_iter([
                sequence(
                    Tag(0x0018, 0x9112),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0018, 0x1314),
                        "20",
                    )])],
                ),
                sequence(
                    Tag(0x0018, 0x9341),
                    vec![
                        InMemDicomObject::from_element_iter([DataElement::new(
                            Tag(0x0018, 0x9344),
                            VR::CS,
                            "PRE_CONTRAST",
                        )]),
                        InMemDicomObject::from_element_iter([DataElement::new(
                            Tag(0x0018, 0x9344),
                            VR::CS,
                            "POST_CONTRAST",
                        )]),
                    ],
                ),
            ])],
        ));
        obj.put_str(Tag(0x0008, 0x002a), VR::DT, "20261103101112.5+0100");
        let meta = acquisition_metadata(&obj, 0);
        assert_eq!(meta.contrast_bolus_phase, "MIXED");
        assert_eq!(meta.flip_angle, Some(20.));
        assert_eq!(meta.acquisition_time, "101112.5");
        assert_eq!(meta.acquisition_date_time, "20261103101112.5+0100");
    }
    #[test]
    fn frame_and_image_laterality_take_precedence_over_series_laterality() {
        let mut obj = metadata_object(2);
        obj.put_str(Tag(0x0020, 0x0060), VR::CS, "R");
        assert_eq!(acquisition_metadata(&obj, 0).laterality, "R");
        obj.put_str(Tag(0x0020, 0x0062), VR::CS, "B");
        let anatomy = InMemDicomObject::from_element_iter([DataElement::new(
            Tag(0x0020, 0x9072),
            VR::CS,
            "L",
        )]);
        obj.put(sequence(
            Tag(0x5200, 0x9230),
            vec![
                InMemDicomObject::from_element_iter([sequence(Tag(0x0020, 0x9071), vec![anatomy])]),
                InMemDicomObject::new_empty(),
            ],
        ));
        assert_eq!(acquisition_metadata(&obj, 0).laterality, "L");
        assert_eq!(acquisition_metadata(&obj, 1).laterality, "B");
    }
    #[test]
    fn corner_text_fields_are_read_and_the_frame_thickness_wins() {
        let mut obj = metadata_object(2);
        obj.put_str(Tag(0x0010, 0x0030), VR::DA, "19800102");
        obj.put_str(Tag(0x0010, 0x1010), VR::AS, "045Y");
        obj.put_str(Tag(0x0008, 0x0030), VR::TM, "101530");
        obj.put_str(Tag(0x0008, 0x1030), VR::LO, "Beyin MR");
        obj.put_str(Tag(0x0018, 0x0015), VR::CS, "BRAIN");
        obj.put_str(Tag(0x0008, 0x0080), VR::LO, "Deneme Hastanesi");
        obj.put_str(Tag(0x0008, 0x0050), VR::SH, "LHK000000001");
        obj.put(ds(Tag(0x0018, 0x0087), "1.5"));
        obj.put(ds(Tag(0x0018, 0x0050), "5"));
        let shared = acquisition_metadata(&obj, 0);
        assert_eq!(shared.patient_birth_date, "19800102");
        assert_eq!(shared.patient_age_text, "045Y");
        assert_eq!(shared.study_time, "101530");
        assert_eq!(shared.study_description, "Beyin MR");
        assert_eq!(shared.body_part_examined, "BRAIN");
        assert_eq!(shared.institution_name, "Deneme Hastanesi");
        assert_eq!(shared.accession_number, "LHK000000001");
        assert_eq!(shared.magnetic_field_strength, Some(1.5));
        assert_eq!(shared.slice_thickness, Some(5.));
        obj.put(sequence(
            Tag(0x5200, 0x9230),
            vec![
                InMemDicomObject::from_element_iter([sequence(
                    Tag(0x0028, 0x9110),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0018, 0x0050),
                        "3",
                    )])],
                )]),
                InMemDicomObject::from_element_iter([sequence(
                    Tag(0x0028, 0x9110),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0018, 0x0050),
                        "0",
                    )])],
                )]),
            ],
        ));
        assert_eq!(acquisition_metadata(&obj, 0).slice_thickness, Some(3.));
        assert_eq!(acquisition_metadata(&obj, 1).slice_thickness, None);
    }
    #[test]
    fn finite_float_padding_is_transformed_and_missing_geometry_stays_unknown() {
        let mut obj = metadata_object(1);
        obj.put(DataElement::new(
            Tag(0x0028, 0x0123),
            VR::FD,
            dicom_core::PrimitiveValue::from(-500.5f64),
        ));
        obj.put(DataElement::new(
            Tag(0x0028, 0x0125),
            VR::FD,
            dicom_core::PrimitiveValue::from(-450.5f64),
        ));
        assert_eq!(
            padding_range(&obj, 0, -2., 10., false, 64),
            Some([911., 1011.])
        );
        let metadata = frame_metadata(
            &FrameGeometry {
                position: None,
                orientation: Some([1., 0., 0., 0., 1., 0.]),
                pixel_spacing: Some([0.5, 0.8]),
                slice_thickness: None,
            },
            None,
            None,
            None,
        );
        assert!(!metadata.position_known);
        assert!(metadata.orientation_known);
        assert!(metadata.spacing_known);
        assert_eq!(metadata.spacing, [0.8, 0.5, 1.]);
    }
    fn us_region(x: f64, y: f64, units: u16, format: u16) -> InMemDicomObject {
        let mut region = InMemDicomObject::new_empty();
        for (tag, value) in [
            (Tag(0x0018, 0x6012), format),
            (Tag(0x0018, 0x6024), units),
            (Tag(0x0018, 0x6026), units),
        ] {
            region.put(DataElement::new(
                tag,
                VR::US,
                dicom_core::PrimitiveValue::from(value),
            ));
        }
        for (tag, value) in [
            (Tag(0x0018, 0x6018), 0u32),
            (Tag(0x0018, 0x601a), 0),
            (Tag(0x0018, 0x601c), 63),
            (Tag(0x0018, 0x601e), 31),
        ] {
            region.put(DataElement::new(
                tag,
                VR::UL,
                dicom_core::PrimitiveValue::from(value),
            ));
        }
        region.put(DataElement::new(
            Tag(0x0018, 0x602c),
            VR::FD,
            dicom_core::PrimitiveValue::from(x),
        ));
        region.put(DataElement::new(
            Tag(0x0018, 0x602e),
            VR::FD,
            dicom_core::PrimitiveValue::from(y),
        ));
        region
    }
    #[test]
    fn ultrasound_regions_convert_cm_to_mm_and_dicom_spacing_order() {
        let obj = InMemDicomObject::from_element_iter([sequence(
            Tag(0x0018, 0x6011),
            vec![us_region(-0.02, 0.03, 3, 1)],
        )]);
        assert_eq!(ultrasound_spacing(&obj, 32, 64), Some([0.3, 0.2]));
    }
    #[test]
    fn ultrasound_rejects_conflicting_units_spacing_and_region_geometry() {
        for regions in [
            vec![us_region(0.02, 0.03, 3, 1), us_region(0.03, 0.03, 3, 1)],
            vec![us_region(0.02, 0.03, 4, 1)],
            vec![us_region(0., 0.03, 3, 1)],
        ] {
            let obj = InMemDicomObject::from_element_iter([sequence(Tag(0x0018, 0x6011), regions)]);
            assert_eq!(ultrasound_spacing(&obj, 32, 64), None);
        }
        let obj = InMemDicomObject::from_element_iter([sequence(
            Tag(0x0018, 0x6011),
            vec![us_region(0.02, 0.03, 3, 1)],
        )]);
        assert_eq!(ultrasound_spacing(&obj, 16, 64), None);
    }
    #[test]
    fn ultrasound_ignores_spectral_regions_and_requires_tissue_calibration() {
        let obj = InMemDicomObject::from_element_iter([sequence(
            Tag(0x0018, 0x6011),
            vec![us_region(0.02, 0.03, 3, 1), us_region(10., 20., 4, 3)],
        )]);
        assert_eq!(ultrasound_spacing(&obj, 32, 64), Some([0.3, 0.2]));
        let obj = InMemDicomObject::from_element_iter([sequence(
            Tag(0x0018, 0x6011),
            vec![us_region(10., 20., 4, 3)],
        )]);
        assert_eq!(ultrasound_spacing(&obj, 32, 64), None);
    }
    #[test]
    fn enhanced_diffusion_uses_each_frame_and_nested_gradients() {
        let mut frames = Vec::new();
        for (b, direction) in [
            (0., [0., 0., 0.]),
            (1000., [1., 0., 0.]),
            (1000., [0., 1., 0.]),
        ] {
            let gradient = InMemDicomObject::from_element_iter([DataElement::new(
                Tag(0x0018, 0x9089),
                VR::FD,
                dicom_core::PrimitiveValue::F64(direction.to_vec().into()),
            )]);
            let diffusion = InMemDicomObject::from_element_iter([
                DataElement::new(
                    Tag(0x0018, 0x9087),
                    VR::FD,
                    dicom_core::PrimitiveValue::from(b),
                ),
                sequence(Tag(0x0018, 0x9076), vec![gradient]),
            ]);
            frames.push(InMemDicomObject::from_element_iter([sequence(
                Tag(0x0018, 0x9117),
                vec![diffusion],
            )]));
        }
        let obj = InMemDicomObject::from_element_iter([sequence(Tag(0x5200, 0x9230), frames)]);
        assert_eq!(diffusion(&obj, 0), (Some(0.), Some([0., 0., 0.])));
        assert_eq!(diffusion(&obj, 1), (Some(1000.), Some([1., 0., 0.])));
        assert_eq!(diffusion(&obj, 2), (Some(1000.), Some([0., 1., 0.])));
    }
    #[test]
    fn enhanced_diffusion_keeps_shared_b_value_when_frame_only_overrides_direction() {
        let shared = InMemDicomObject::from_element_iter([sequence(
            Tag(0x0018, 0x9117),
            vec![InMemDicomObject::from_element_iter([DataElement::new(
                Tag(0x0018, 0x9087),
                VR::FD,
                dicom_core::PrimitiveValue::from(800f64),
            )])],
        )]);
        let frame = InMemDicomObject::from_element_iter([sequence(
            Tag(0x0018, 0x9117),
            vec![InMemDicomObject::from_element_iter([DataElement::new(
                Tag(0x0018, 0x9089),
                VR::FD,
                dicom_core::PrimitiveValue::F64(vec![1., 0., 0.].into()),
            )])],
        )]);
        let obj = InMemDicomObject::from_element_iter([
            sequence(Tag(0x5200, 0x9229), vec![shared]),
            sequence(Tag(0x5200, 0x9230), vec![frame]),
        ]);
        assert_eq!(diffusion(&obj, 0), (Some(800.), Some([1., 0., 0.])));
    }
    #[test]
    fn siemens_sequence_name_gives_the_b_value_when_the_private_element_is_gone() {
        assert_eq!(sequence_b_value("*ep_b1000t"), Some(1000.));
        assert_eq!(sequence_b_value("*ep_b0"), Some(0.));
        assert_eq!(sequence_b_value("ep_b800#1"), Some(800.));
        assert_eq!(sequence_b_value("*ep_b0_1000"), None);
        assert_eq!(sequence_b_value("*tse2d1_17"), None);
        assert_eq!(sequence_b_value("*ep_bx"), None);
    }
    #[test]
    fn private_diffusion_is_vendor_scoped_and_reads_ascii_bytes() {
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0070), VR::LO, "GE MEDICAL SYSTEMS"),
            DataElement::new(
                Tag(0x0043, 0x1039),
                VR::OB,
                dicom_core::PrimitiveValue::from(b"1000001000\\0\\0\\0".to_vec()),
            ),
        ]);
        assert_eq!(diffusion(&obj, 0).0, Some(1000.));
        obj.put_str(Tag(0x0008, 0x0070), VR::LO, "UNKNOWN");
        assert_eq!(diffusion(&obj, 0).0, None);
    }
    #[test]
    fn pet_suv_uses_decay_reference_and_explicit_timezone() {
        let drug = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0018, 0x1074), VR::DS, "100000000"),
            DataElement::new(Tag(0x0018, 0x1075), VR::DS, "3600"),
            DataElement::new(Tag(0x0018, 0x1078), VR::DT, "20240101110000+0100"),
        ]);
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0054, 0x1001), VR::CS, "BQML"),
            DataElement::new(Tag(0x0054, 0x1102), VR::CS, "START"),
            DataElement::new(Tag(0x0010, 0x1030), VR::DS, "70"),
            DataElement::new(Tag(0x0008, 0x0021), VR::DA, "20240101"),
            DataElement::new(Tag(0x0008, 0x0031), VR::TM, "130000"),
            DataElement::new(Tag(0x0008, 0x0201), VR::SH, "+0200"),
            sequence(Tag(0x0054, 0x0016), vec![drug]),
        ]);
        assert!((suv_factor(&obj).0.unwrap().bw - 0.0014).abs() < 1e-12);
        obj.put_str(Tag(0x0054, 0x1102), VR::CS, "ADMIN");
        assert!((suv_factor(&obj).0.unwrap().bw - 0.0007).abs() < 1e-12);
        obj.put_str(Tag(0x0054, 0x1102), VR::CS, "NONE");
        assert!(suv_factor(&obj).0.is_none());
    }
    /// A START-corrected PET whose series was made days after the scan: injected at 10:00 (time only), scanned
    /// from 11:00, this bed acquired at 11:10 on 1 January, Series Date and Time 5 January 13:00. Its SUV factor is
    /// 0.0014 when the scan start is found (one half-life after the injection).
    fn reprocessed_pet(manufacturer: &str) -> InMemDicomObject {
        let drug = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0018, 0x1074), VR::DS, "100000000"),
            DataElement::new(Tag(0x0018, 0x1075), VR::DS, "3600"),
            DataElement::new(Tag(0x0018, 0x1072), VR::TM, "100000"),
        ]);
        InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0070), VR::LO, manufacturer),
            DataElement::new(Tag(0x0054, 0x1001), VR::CS, "BQML"),
            DataElement::new(Tag(0x0054, 0x1102), VR::CS, "START"),
            DataElement::new(Tag(0x0028, 0x0051), VR::CS, "NORM\\DTIM\\ATTN\\SCAT\\DECY"),
            DataElement::new(Tag(0x0010, 0x1030), VR::DS, "70"),
            DataElement::new(Tag(0x0008, 0x0021), VR::DA, "20240105"),
            DataElement::new(Tag(0x0008, 0x0031), VR::TM, "130000"),
            DataElement::new(Tag(0x0008, 0x0022), VR::DA, "20240101"),
            DataElement::new(Tag(0x0008, 0x0032), VR::TM, "111000"),
            sequence(Tag(0x0054, 0x0016), vec![drug]),
        ])
    }
    fn suv_bw(obj: &InMemDicomObject) -> Option<f64> {
        suv_factor(obj).0.map(|factors| factors.bw)
    }
    #[test]
    fn pet_suv_keeps_series_time_unless_it_is_after_the_acquisition() {
        let mut obj = reprocessed_pet("SIEMENS");
        obj.put_str(Tag(0x0008, 0x0021), VR::DA, "20240101");
        obj.put_str(Tag(0x0008, 0x0031), VR::TM, "110000");
        assert!((suv_bw(&obj).unwrap() - 0.0014).abs() < 1e-12);
        // Without an acquisition time there is nothing to compare: Series Time stands.
        obj.remove_element(Tag(0x0008, 0x0032));
        assert!((suv_bw(&obj).unwrap() - 0.0014).abs() < 1e-12);
    }
    #[test]
    fn pet_suv_works_the_scan_start_back_from_the_frame_after_qiba() {
        // Siemens and Philips: Frame Reference Time runs to the frame's average count-rate time.
        let lambda = std::f64::consts::LN_2 / 3600.;
        let decay = lambda * 120.;
        let average = (decay / (1. - (-decay).exp())).ln() / lambda;
        let mut obj = reprocessed_pet("SIEMENS");
        obj.put_str(
            Tag(0x0054, 0x1300),
            VR::DS,
            format!("{:.4}", 600_000. + average * 1000.),
        );
        obj.put_str(Tag(0x0018, 0x1242), VR::IS, "120000");
        assert!((suv_bw(&obj).unwrap() - 0.0014).abs() < 1e-9);
        // GE's runs to the frame's start.
        let mut obj = reprocessed_pet("GE MEDICAL SYSTEMS");
        obj.put_str(Tag(0x0054, 0x1300), VR::DS, "600000");
        assert!((suv_bw(&obj).unwrap() - 0.0014).abs() < 1e-12);
        // Series Time alone would have given a negative uptake time: no SUV, and no wrong one.
        let mut obj = reprocessed_pet("SIEMENS");
        let (factors, notes) = suv_factor(&obj);
        assert!(factors.is_none());
        assert_eq!(notes[0].code, "series.suvScanStart");
        obj.put_str(Tag(0x0054, 0x1300), VR::DS, "600000");
        assert!(
            suv_bw(&obj).is_none(),
            "a frame duration is needed for the average count-rate time"
        );
    }
    #[test]
    fn pet_suv_takes_the_ge_scan_time_by_its_private_creator_and_time_of_day() {
        // The private date is shifted, as archives were found to do; its time of day is the scan start.
        for block in [0x10u16, 0x11] {
            let mut obj = reprocessed_pet("GE MEDICAL SYSTEMS");
            obj.put_str(Tag(0x0009, block), VR::LO, "GEMS_PETD_01");
            obj.put(DataElement::new(
                Tag(0x0009, (block << 8) | 0x0d),
                VR::UN,
                dicom_core::PrimitiveValue::from(b"19991231110000.00 ".to_vec()),
            ));
            assert!(
                (suv_bw(&obj).unwrap() - 0.0014).abs() < 1e-12,
                "block {block:#x}"
            );
        }
        // Another maker's element at the same place is not GE's scan time.
        let mut obj = reprocessed_pet("GE MEDICAL SYSTEMS");
        obj.put_str(Tag(0x0009, 0x0010), VR::LO, "OTHER_CREATOR");
        obj.put_str(Tag(0x0009, 0x100d), VR::DT, "20240101110000");
        assert!(suv_bw(&obj).is_none());
        // A scan started before midnight, this bed acquired after it.
        let mut obj = reprocessed_pet("GE MEDICAL SYSTEMS");
        obj.put_str(Tag(0x0008, 0x0022), VR::DA, "20240102");
        obj.put_str(Tag(0x0008, 0x0032), VR::TM, "000500");
        obj.put_str(Tag(0x0009, 0x0010), VR::LO, "GEMS_PETD_01");
        obj.put_str(Tag(0x0009, 0x100d), VR::DT, "20240101235500");
        let drug = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0018, 0x1074), VR::DS, "100000000"),
            DataElement::new(Tag(0x0018, 0x1075), VR::DS, "3600"),
            DataElement::new(Tag(0x0018, 0x1072), VR::TM, "225500"),
        ]);
        obj.put(sequence(Tag(0x0054, 0x0016), vec![drug]));
        assert!((suv_bw(&obj).unwrap() - 0.0014).abs() < 1e-12);
    }
    #[test]
    fn pet_suv_needs_attenuation_and_decay_correction_when_the_file_lists_its_corrections() {
        let mut obj = reprocessed_pet("GE MEDICAL SYSTEMS");
        obj.put_str(Tag(0x0054, 0x1300), VR::DS, "600000");
        obj.put_str(Tag(0x0028, 0x0051), VR::CS, "NORM\\DTIM\\DECY");
        let (factors, notes) = suv_factor(&obj);
        assert!(factors.is_none());
        assert_eq!(notes[0].code, "series.suvNotCorrected");
        obj.put_str(Tag(0x0054, 0x1001), VR::CS, "GML");
        assert!(suv_bw(&obj).is_none());
        obj.put_str(Tag(0x0028, 0x0051), VR::CS, "attn\\decy");
        assert_eq!(suv_bw(&obj), Some(1.));
        obj.remove_element(Tag(0x0028, 0x0051));
        assert_eq!(suv_bw(&obj), Some(1.));
    }
    #[test]
    fn gml_catalogue_only_reports_suv_if_every_slice_is_calibrated() {
        for (dicom_units, corrections, factor, unit) in [
            ("GML", ["ATTN\\DECY", "ATTN\\DECY"], Some(1.), "SUVbw"),
            ("GML", ["DECY", "DECY"], None, "g/ml"),
            ("GML", ["ATTN\\DECY", "DECY"], None, "g/ml"),
            ("GML", ["DECY", "ATTN\\DECY"], None, "g/ml"),
            ("SUV", ["ATTN\\DECY", "ATTN\\DECY"], None, "a.u."),
        ] {
            let slices = corrections
                .into_iter()
                .enumerate()
                .map(|(i, corrected)| {
                    let mut obj = classic_slice(i + 1, 2. * i as f64);
                    obj.put_str(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.128");
                    obj.put_str(Tag(0x0008, 0x0060), VR::CS, "PT");
                    obj.put_str(Tag(0x0054, 0x1001), VR::CS, dicom_units);
                    obj.put_str(Tag(0x0028, 0x0051), VR::CS, corrected);
                    obj
                })
                .collect();
            let imported = import_dir(&write_slices(slices));
            assert_eq!(imported.sources.len(), 1);
            let source = &imported.sources[0];
            assert_eq!(source.frames.len(), 2);
            assert_eq!(source.info.suv_factor, factor);
            assert_eq!(source.info.value_unit, unit);
            assert_eq!(
                crate::sampling::Normalization::Bw.quantity(source),
                (1., unit)
            );
        }
    }
    #[test]
    fn pet_sul_and_suv_bsa_follow_height_and_sex() {
        let mut obj = reprocessed_pet("GE MEDICAL SYSTEMS");
        obj.put_str(Tag(0x0054, 0x1300), VR::DS, "600000");
        obj.put_str(Tag(0x0010, 0x1020), VR::DS, "1.75");
        obj.put_str(Tag(0x0010, 0x0040), VR::CS, "M");
        let bmi = 70. / (1.75 * 1.75);
        let bsa = 0.007184 * 70f64.powf(0.425) * 175f64.powf(0.725) * 10_000. / 70_000.;
        let factors = suv_factor(&obj).0.unwrap();
        assert!((factors.lbm.unwrap() - 0.0014 * 9270. / (6680. + 216. * bmi)).abs() < 1e-12);
        assert!((factors.bsa.unwrap() - 0.0014 * bsa).abs() < 1e-12);
        // A 70 kg, 1.75 m man: lean body mass 55.9 kg, body surface area 1.85 m².
        assert!((factors.lbm.unwrap() / factors.bw * 70. - 55.86).abs() < 0.01);
        assert!((factors.bsa.unwrap() / factors.bw * 7. - 1.848).abs() < 0.001);
        obj.put_str(Tag(0x0010, 0x0040), VR::CS, "F");
        let female = suv_factor(&obj).0.unwrap();
        assert!((female.lbm.unwrap() - 0.0014 * 9270. / (8780. + 244. * bmi)).abs() < 1e-12);
        obj.put_str(Tag(0x0010, 0x0040), VR::CS, "O");
        let other = suv_factor(&obj).0.unwrap();
        assert!(other.lbm.is_none() && other.bsa.is_some());
        // Centimetres in Patient's Size are not guessed at, and no height gives neither.
        obj.put_str(Tag(0x0010, 0x1020), VR::DS, "175");
        assert_eq!(
            suv_factor(&obj).0.map(|f| (f.lbm, f.bsa)),
            Some((None, None))
        );
        obj.remove_element(Tag(0x0010, 0x1020));
        assert_eq!(
            suv_factor(&obj).0.map(|f| (f.lbm, f.bsa)),
            Some((None, None))
        );
    }
    fn code(value: &str, scheme: &str, meaning: &str) -> InMemDicomObject {
        InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0100), VR::SH, value),
            DataElement::new(Tag(0x0008, 0x0102), VR::SH, scheme),
            DataElement::new(Tag(0x0008, 0x0104), VR::LO, meaning),
        ])
    }
    /// An Acquisition Context item as CP-1229 records blood glucose.
    fn glucose_item(concept: &str, value: &str, unit: &str) -> InMemDicomObject {
        InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0040, 0xa040), VR::CS, "NUMERIC"),
            sequence(Tag(0x0040, 0xa043), vec![code(concept, "LN", "Glucose")]),
            DataElement::new(Tag(0x0040, 0xa30a), VR::DS, value),
            sequence(Tag(0x0040, 0x08ea), vec![code(unit, "UCUM", unit)]),
        ])
    }
    #[test]
    fn pet_acquisition_reads_the_tracer_injection_patient_and_glucose() {
        let drug = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0018, 0x0031), VR::LO, "Fludeoxyglucose F^18^"),
            DataElement::new(Tag(0x0018, 0x1074), VR::DS, "200000000"),
            DataElement::new(Tag(0x0018, 0x1075), VR::DS, "6586.2"),
            DataElement::new(Tag(0x0018, 0x1072), VR::TM, "110500"),
            DataElement::new(Tag(0x0018, 0x1078), VR::DT, "20000101110500"),
            sequence(
                Tag(0x0054, 0x0300),
                vec![code("C-111A1", "SRT", "^18^Fluorine")],
            ),
            sequence(
                Tag(0x0054, 0x0304),
                vec![code("C-B1031", "SRT", "Fluorodeoxyglucose F^18^")],
            ),
        ]);
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0054, 0x1001), VR::CS, "BQML"),
            DataElement::new(Tag(0x0054, 0x1102), VR::CS, "ADMIN"),
            DataElement::new(Tag(0x0054, 0x1103), VR::LO, "OSEM3D 4i8s"),
            DataElement::new(Tag(0x0008, 0x1090), VR::LO, "Synthetic PET/CT"),
            DataElement::new(Tag(0x0010, 0x1030), VR::DS, "70"),
            DataElement::new(Tag(0x0010, 0x1020), VR::DS, "1.75"),
            DataElement::new(Tag(0x0008, 0x0021), VR::DA, "20000101"),
            DataElement::new(Tag(0x0008, 0x0031), VR::TM, "120000"),
            DataElement::new(Tag(0x0008, 0x0022), VR::DA, "20000101"),
            DataElement::new(Tag(0x0008, 0x0032), VR::TM, "120000"),
            sequence(Tag(0x0054, 0x0016), vec![drug]),
            sequence(
                Tag(0x0040, 0x0555),
                vec![glucose_item("14749-6", "5.4", "mmol/l")],
            ),
        ]);
        let pet = pet_acquisition(&obj);
        assert_eq!(pet.tracer, "Fludeoxyglucose F^18^");
        assert_eq!(
            (pet.tracer_code.as_str(), pet.tracer_code_meaning.as_str()),
            ("C-B1031", "Fluorodeoxyglucose F^18^")
        );
        assert_eq!(pet.radionuclide, "^18^Fluorine");
        assert_eq!(pet.injected_activity, Some(200e6));
        assert_eq!(pet.half_life, Some(6586.2));
        assert_eq!(
            (
                pet.injection_time.as_str(),
                pet.injection_date_time.as_str()
            ),
            ("110500", "20000101110500")
        );
        // ADMIN-corrected all the same: the uptake runs to the scan start.
        assert_eq!(pet.scan_start, "20000101120000");
        assert_eq!(pet.uptake_seconds, Some(3300.));
        assert_eq!((pet.weight, pet.height), (Some(70.), Some(1.75)));
        assert_eq!(pet.glucose, Some(5.4));
        assert_eq!(pet.decay_correction, "ADMIN");
        assert_eq!(
            (pet.scanner_model.as_str(), pet.reconstruction.as_str()),
            ("Synthetic PET/CT", "OSEM3D 4i8s")
        );
        let json = serde_json::to_value(AcquisitionMetadata {
            pet_acquisition: Some(pet),
            ..AcquisitionMetadata::default()
        })
        .unwrap();
        assert_eq!(json["petAcquisition"]["uptakeSeconds"], 3300.);
        assert_eq!(json["petAcquisition"]["injectedActivity"], 200e6);
        assert_eq!(json["petAcquisition"]["scannerModel"], "Synthetic PET/CT");
        assert_eq!(json["petAcquisition"]["reconstruction"], "OSEM3D 4i8s");
        // Without the drug's item: nothing about the tracer, and no uptake time.
        obj.remove_element(Tag(0x0054, 0x0016));
        let bare = pet_acquisition(&obj);
        assert!(bare.tracer.is_empty() && bare.injected_activity.is_none());
        assert_eq!(bare.scan_start, "20000101120000");
        assert_eq!(bare.uptake_seconds, None);
        assert_eq!(bare.weight, Some(70.));
    }
    #[test]
    fn pet_uptake_uses_recorded_acquisition_independently_of_decay_correction() {
        let mut obj = reprocessed_pet("SIEMENS");
        obj.put_str(Tag(0x0008, 0x0021), VR::DA, "20240101");
        obj.put_str(Tag(0x0008, 0x0031), VR::TM, "103000");
        obj.put_str(Tag(0x0008, 0x0032), VR::TM, "110000");
        for correction in ["START", "ADMIN"] {
            obj.put_str(Tag(0x0054, 0x1102), VR::CS, correction);
            let pet = pet_acquisition(&obj);
            assert_eq!(pet.scan_start, "20240101110000");
            assert_eq!(pet.uptake_seconds, Some(3600.));
        }
        obj.remove_element(Tag(0x0008, 0x0032));
        assert!(pet_acquisition(&obj).scan_start.is_empty());
        obj.put_str(Tag(0x0008, 0x002a), VR::DT, "20240101120000+0100");
        let mut drug = single_administration(&obj).unwrap().clone();
        drug.put_str(Tag(0x0018, 0x1078), VR::DT, "20240101100000+0000");
        obj.put(sequence(Tag(0x0054, 0x0016), vec![drug]));
        assert_eq!(pet_acquisition(&obj).uptake_seconds, Some(3600.));
    }
    #[test]
    fn enhanced_pet_starts_with_the_earliest_recorded_frame() {
        let frame = |at: &str| {
            InMemDicomObject::from_element_iter([sequence(
                Tag(0x0020, 0x9111),
                vec![InMemDicomObject::from_element_iter([DataElement::new(
                    Tag(0x0018, 0x9074),
                    VR::DT,
                    at,
                )])],
            )])
        };
        let mut obj = reprocessed_pet("SIEMENS");
        obj.remove_element(Tag(0x0008, 0x0032));
        obj.put_str(Tag(0x0008, 0x0201), VR::SH, "+0100");
        obj.put(sequence(
            Tag(0x5200, 0x9230),
            vec![frame("20240101111500"), frame("20240101110000")],
        ));
        let pet = pet_acquisition(&obj);
        assert_eq!(pet.scan_start, "20240101110000+0100");
        assert_eq!(pet.uptake_seconds, Some(3600.));
    }
    #[test]
    fn multiple_administrations_do_not_select_a_dose_or_uptake_by_item_order() {
        let mut obj = reprocessed_pet("SIEMENS");
        obj.put_str(Tag(0x0054, 0x1102), VR::CS, "ADMIN");
        let drug = single_administration(&obj).unwrap().clone();
        let mut extra = drug.clone();
        extra.put_str(Tag(0x0018, 0x1072), VR::TM, "104000");
        extra.put_str(Tag(0x0018, 0x1074), VR::DS, "50000000");
        for items in [vec![drug.clone(), extra.clone()], vec![extra, drug]] {
            obj.put(sequence(Tag(0x0054, 0x0016), items));
            let pet = pet_acquisition(&obj);
            assert!(pet.multiple_administrations);
            assert_eq!((pet.injected_activity, pet.uptake_seconds), (None, None));
            assert!(suv_factor(&obj).0.is_none());
        }
    }
    #[test]
    fn glucose_in_mg_per_dl_is_converted_and_other_units_are_not_guessed() {
        let with = |items: Vec<InMemDicomObject>| {
            glucose(&InMemDicomObject::from_element_iter([sequence(
                Tag(0x0040, 0x0555),
                items,
            )]))
        };
        assert!(
            (with(vec![glucose_item("2345-7", "99", "mg/dL")]).unwrap() - 99. / 18.0182).abs()
                < 1e-12
        );
        let blood = glucose_item("14749-6", "5", "mmol/L");
        assert_eq!(
            with(vec![glucose_item("2350-7", "270", "mg/dL"), blood.clone()]),
            Some(5.)
        );
        let mut private = blood.clone();
        private.put(sequence(
            Tag(0x0040, 0xa043),
            vec![code("14749-6", "99LOCAL", "Glucose")],
        ));
        assert_eq!(with(vec![private]), None);
        assert_eq!(
            with(vec![glucose_item("14749-6", "9", "mmol/L"), blood]),
            None
        );
        assert_eq!(with(vec![glucose_item("14749-6", "5.4", "%")]), None);
        assert_eq!(with(vec![glucose_item("14749-6", "0", "mmol/l")]), None);
        // Another numeric item first (a cardiac state, say), and the value in a Measured Value Sequence.
        let other = InMemDicomObject::from_element_iter([
            sequence(
                Tag(0x0040, 0xa043),
                vec![code("8867-4", "LN", "Heart rate")],
            ),
            DataElement::new(Tag(0x0040, 0xa30a), VR::DS, "72"),
        ]);
        let measured = InMemDicomObject::from_element_iter([
            sequence(Tag(0x0040, 0xa043), vec![code("14749-6", "LN", "Glucose")]),
            sequence(
                Tag(0x0040, 0xa300),
                vec![InMemDicomObject::from_element_iter([
                    DataElement::new(Tag(0x0040, 0xa30a), VR::DS, "6.1"),
                    sequence(Tag(0x0040, 0x08ea), vec![code("mmol/L", "UCUM", "mmol/L")]),
                ])],
            ),
        ]);
        assert_eq!(with(vec![other, measured]), Some(6.1));
        assert_eq!(glucose(&InMemDicomObject::new_empty()), None);
    }
    #[test]
    fn pet_acquisition_merges_what_the_first_file_lacks_and_keeps_the_earliest_start() {
        let mut first = PetAcquisition {
            tracer: "FDG".into(),
            scan_start: "20240101110001".into(),
            injection_time: "100000".into(),
            uptake_seconds: Some(3601.),
            ..PetAcquisition::default()
        };
        first.merge(&PetAcquisition {
            weight: Some(70.),
            glucose: Some(5.),
            scanner_model: "Model A".into(),
            reconstruction: "OSEM".into(),
            scan_start: "20240101110000".into(),
            uptake_seconds: Some(3600.),
            ..PetAcquisition::default()
        });
        assert_eq!(first.tracer, "FDG");
        assert_eq!((first.weight, first.glucose), (Some(70.), Some(5.)));
        assert_eq!(
            (first.scanner_model.as_str(), first.reconstruction.as_str()),
            ("Model A", "OSEM")
        );
        assert_eq!(
            (first.scan_start.as_str(), first.uptake_seconds),
            ("20240101110000", Some(3600.))
        );
        first.merge(&PetAcquisition {
            scan_start: "20240101120000".into(),
            uptake_seconds: Some(7200.),
            ..PetAcquisition::default()
        });
        assert_eq!(first.uptake_seconds, Some(3600.));
        first.merge(&PetAcquisition {
            tracer: "Ga-68 PSMA".into(),
            scanner_model: "Model B".into(),
            ..PetAcquisition::default()
        });
        assert!(first.multiple_administrations && first.tracer.is_empty());
        // The first file's scanner stays, whatever the administrations.
        assert_eq!(first.scanner_model, "Model A");
        assert_eq!(first.uptake_seconds, None);
    }
    #[test]
    fn a_series_keeps_the_body_part_its_first_file_lacks_and_names_every_part_its_files_record() {
        let mut series = String::new();
        merge_anatomy_value(&mut series, "");
        assert_eq!(series, "");
        merge_anatomy_value(&mut series, "BRAIN");
        merge_anatomy_value(&mut series, "");
        merge_anatomy_value(&mut series, " brain ");
        assert_eq!(series, "BRAIN");
        // Two parts in one series are both kept: neither is dropped, and the series is not left without one.
        merge_anatomy_value(&mut series, "NECK");
        assert_eq!(series, "BRAIN\\NECK");
        merge_anatomy_value(&mut series, "NECK");
        assert_eq!(series, "BRAIN\\NECK");
        // A file cannot make the list grow without bound.
        merge_anatomy_value(&mut series, &"X".repeat(MAX_BODY_PART_TEXT + 1));
        for index in 0..20 {
            merge_anatomy_value(&mut series, &format!("PART{index}"));
        }
        assert_eq!(series.split('\\').count(), MAX_BODY_PARTS);
        assert!(series.starts_with("BRAIN\\NECK\\PART0"));
    }
    #[test]
    fn values_already_in_suv_convert_only_from_body_weight() {
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0054, 0x1001), VR::CS, "GML"),
            DataElement::new(Tag(0x0010, 0x1030), VR::DS, "70"),
            DataElement::new(Tag(0x0010, 0x1020), VR::DS, "1.75"),
            DataElement::new(Tag(0x0010, 0x0040), VR::CS, "M"),
        ]);
        assert_eq!(pet_value_unit(&obj), "SUVbw");
        let bmi = 70. / (1.75 * 1.75);
        let factors = suv_factor(&obj).0.unwrap();
        assert_eq!(factors.bw, 1.);
        assert!((factors.lbm.unwrap() - 9270. / (6680. + 216. * bmi)).abs() < 1e-12);
        obj.put_str(Tag(0x0054, 0x1006), VR::CS, "LBM");
        assert_eq!(pet_value_unit(&obj), "SUVlbm");
        assert_eq!(
            suv_factor(&obj).0,
            Some(SuvFactors {
                bw: 1.,
                lbm: None,
                bsa: None
            })
        );
        obj.put_str(Tag(0x0054, 0x1001), VR::CS, "BQML");
        assert_eq!(pet_value_unit(&obj), "Bq/ml");
    }
    #[test]
    fn frames_share_an_suv_factor_within_a_tenth_of_a_percent() {
        assert!(same_calibration(Some(0.0014), Some(0.0014 * 1.0005)));
        assert!(!same_calibration(Some(0.0014), Some(0.0014 * 1.002)));
        assert!(same_calibration(None, None));
        assert!(!same_calibration(Some(0.0014), None));
    }
    #[test]
    fn pet_beds_keep_one_suv_when_one_bed_works_its_scan_start_back() {
        // Bed 1 began half a second before Series Time, so its scan start is worked back from its frame timing;
        // bed 2 began after it and keeps Series Time. Their factors differ by 0.01%: the series keeps its SUV.
        let lambda = std::f64::consts::LN_2 / 3600.;
        let decay = lambda * 120.;
        let average = (decay / (1. - (-decay).exp())).ln() / lambda * 1000.;
        let bed = |instance: usize, z: f64, acquired: &str, reference: f64| {
            let mut obj = classic_slice(instance, z);
            obj.put_str(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.128");
            obj.put_str(Tag(0x0008, 0x0060), VR::CS, "PT");
            obj.put_str(Tag(0x0008, 0x0070), VR::LO, "SIEMENS");
            obj.put_str(Tag(0x0054, 0x1001), VR::CS, "BQML");
            obj.put_str(Tag(0x0054, 0x1102), VR::CS, "START");
            obj.put_str(Tag(0x0028, 0x0051), VR::CS, "ATTN\\DECY");
            obj.put_str(Tag(0x0010, 0x1030), VR::DS, "70");
            obj.put_str(Tag(0x0010, 0x1020), VR::DS, "1.75");
            obj.put_str(Tag(0x0010, 0x0040), VR::CS, "M");
            obj.put_str(Tag(0x0008, 0x0021), VR::DA, "20240101");
            obj.put_str(Tag(0x0008, 0x0031), VR::TM, "110000.5");
            obj.put_str(Tag(0x0008, 0x0022), VR::DA, "20240101");
            obj.put_str(Tag(0x0008, 0x0032), VR::TM, acquired);
            obj.put_str(Tag(0x0054, 0x1300), VR::DS, format!("{reference:.4}"));
            obj.put_str(Tag(0x0018, 0x1242), VR::IS, "120000");
            let drug = InMemDicomObject::from_element_iter([
                DataElement::new(Tag(0x0018, 0x1074), VR::DS, "100000000"),
                DataElement::new(Tag(0x0018, 0x1075), VR::DS, "3600"),
                DataElement::new(Tag(0x0018, 0x1072), VR::TM, "100000"),
            ]);
            obj.put(sequence(Tag(0x0054, 0x0016), vec![drug]));
            obj
        };
        let dir = write_slices(vec![
            bed(1, 0., "110000", average),
            bed(2, 2., "110200", 120_000. + average),
        ]);
        let imported = import_dir(&dir);
        assert_eq!(imported.sources.len(), 1);
        let info = &imported.sources[0].info;
        assert!(
            (info.suv_factor.unwrap() / 0.0014 - 1.).abs() < 2e-4,
            "{:?}",
            info.suv_factor
        );
        assert!(info.sul_factor.is_some() && info.suv_bsa_factor.is_some());
        assert!(
            info.warnings
                .0
                .iter()
                .all(|note| note.code != "series.suvDiffers")
        );
    }
    #[test]
    fn folder_scan_skips_sidecars_but_preserves_dicom_magic_and_extensionless() {
        let dir = crate::test_dir::tempdir().unwrap();
        let sidecar = dir.path().join("manifest.json");
        fs::write(&sidecar, b"{}").unwrap();
        assert!(!is_candidate(&sidecar));
        assert!(!is_candidate(&dir.path().join(".bench-study")));
        assert!(is_candidate(&dir.path().join("IM000001")));
        assert!(is_candidate(&dir.path().join("damaged.dcm")));
        let mut bytes = vec![0; 128];
        bytes.extend_from_slice(b"DICM");
        fs::write(&sidecar, bytes).unwrap();
        assert!(is_candidate(&sidecar));
    }
    #[test]
    fn monochrome_unit_values_are_not_presentation_values() {
        let obj = InMemDicomObject::from_element_iter([DataElement::new(
            Tag(0x0054, 0x1001),
            VR::CS,
            "GML",
        )]);
        assert_eq!(suv_factor(&obj).0.map(|f| f.bw), Some(1.));
    }
    #[test]
    fn rar_archives_are_refused_with_a_message() {
        let temp = crate::test_dir::tempdir().unwrap();
        let file = temp.path().join("study.rar");
        fs::write(&file, b"Rar!\x1a\x07\x00").unwrap();
        let error = import(&[file.to_string_lossy().into_owned()])
            .err()
            .unwrap();
        assert_eq!(
            crate::message::coded(&error).map(|note| note.code),
            Some("rar.unsupported")
        );
    }
    #[test]
    fn an_import_that_opens_nothing_says_why_in_one_sentence() {
        let temp = crate::test_dir::tempdir().unwrap();
        let file = |name: &str, bytes: &[u8]| {
            let path = temp.path().join(name);
            fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        };
        let message = |paths: &[String]| {
            let error = import(paths).err().unwrap();
            crate::message::coded(&error).unwrap().text.clone()
        };
        let text: Vec<_> = (1..=40)
            .map(|index| file(&format!("{index}.txt"), &[b't'; 200]))
            .collect();
        assert_eq!(
            message(&text[..1]),
            "No supported images were found. 1.txt: Missing DICOM file meta marker"
        );
        assert_eq!(
            message(&text),
            "No supported images were found. 40 files could not be read: Missing DICOM file meta marker"
        );
        let mut mixed = text.clone();
        // Too short to hold a DICOM preamble: another reason.
        mixed.push(file("short.txt", b"short"));
        assert_eq!(
            message(&mixed),
            "No supported images were found. 41 files could not be read as supported images"
        );
    }
    /// Writes a media index at `path` that lists `files`: each by its file ID and the instance it holds.
    fn write_index(path: &Path, files: &[(&str, &str)]) {
        let records = files
            .iter()
            .map(|(id, instance)| {
                InMemDicomObject::from_element_iter([
                    DataElement::new(Tag(0x0004, 0x1430), VR::CS, "IMAGE"),
                    DataElement::new(Tag(0x0004, 0x1500), VR::CS, *id),
                    DataElement::new(Tag(0x0004, 0x1510), VR::UI, "1.2.840.10008.5.1.4.1.1.4.1"),
                    DataElement::new(Tag(0x0004, 0x1511), VR::UI, *instance),
                ])
            })
            .collect();
        InMemDicomObject::from_element_iter([sequence(Tag(0x0004, 0x1220), records)])
            .with_meta(
                dicom_object::FileMetaTableBuilder::new()
                    .media_storage_sop_class_uid("1.2.840.10008.1.3.10")
                    .media_storage_sop_instance_uid("1.2.3.4.99")
                    .transfer_syntax("1.2.840.10008.1.2.1"),
            )
            .unwrap()
            .write_to_file(path)
            .unwrap();
    }

    #[test]
    fn a_disc_is_planned_with_the_folders_its_index_lists_first_and_its_pictures_left_in_place() {
        let disc = crate::test_dir::tempdir().unwrap();
        let slice = |inside: &str, instance: &str| {
            let mut obj = metadata_object(1);
            obj.put_str(Tag(0x0008, 0x0018), VR::UI, instance);
            let path = disc.path().join(inside);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            write_metadata(obj, &path);
        };
        // A viewer's folder comes before the images' folder by name. It holds a sample image, a program and a picture.
        slice("AVIEWER/demo", "1.2.3.4.14");
        fs::write(disc.path().join("AVIEWER/viewer.bin"), [7; 300]).unwrap();
        fs::write(disc.path().join("AVIEWER/logo.png"), b"a picture").unwrap();
        // And a file named as DICOM that is none, as a damaged one would be.
        fs::write(disc.path().join("AVIEWER/broken.dcm"), [7; 300]).unwrap();
        slice("DICOM/IM1", "1.2.3.4.11");
        slice("DICOM/IM2", "1.2.3.4.12");
        slice("DICOM/EXTRA", "1.2.3.4.13");
        fs::write(disc.path().join("README.TXT"), b"read me").unwrap();
        // The index spells one name in other letters than the disc does, and lists a file the disc does not hold.
        write_index(
            &disc.path().join("DICOMDIR"),
            &[
                ("DICOM\\im1", "1.2.3.4.11"),
                ("DICOM\\IM2", "1.2.3.4.12"),
                ("DICOM\\GONE", "1.2.3.4.15"),
            ],
        );
        let (mut files, mut media_files, mut listed_series, mut noted) =
            (Vec::new(), HashMap::new(), Vec::new(), Vec::new());
        let (dir, spool) = plan_spool(
            disc.path(),
            None,
            DiscToRead {
                disc: ANY_DISC,
                earlier: &[],
            },
            &mut files,
            &mut media_files,
            &mut listed_series,
            &mut noted,
        )
        .unwrap();
        let planned = |file: &SpoolFile| {
            let inside = file.to.strip_prefix(dir.path()).unwrap();
            let take = match file.take {
                Take::Whole => "whole",
                Take::Listed(_) => "through the index",
                Take::IfDicom => "if DICOM",
                Take::Unkept => "not at all",
                Take::Kept { .. } => "from an earlier copy",
            };
            format!("{}: {take}", inside.to_string_lossy().replace('\\', "/"))
        };
        let mut plan: Vec<_> = spool.files.iter().map(planned).collect();
        // A folder's own order is the disc's to give, and a test's file system gives it in any order.
        plan[..3].sort();
        plan[4..].sort();
        assert_eq!(
            plan,
            [
                "DICOM/EXTRA: if DICOM",
                "DICOM/IM1: whole",
                "DICOM/IM2: whole",
                "DICOM/GONE: through the index",
                "AVIEWER/broken.dcm: if DICOM",
                "AVIEWER/demo: if DICOM",
                "AVIEWER/viewer.bin: if DICOM",
                "README.TXT: if DICOM",
            ]
        );
        // An index without the links between its records (as this one is written) lists its files and no series.
        assert!(spool.indexed && noted.is_empty() && listed_series.is_empty());
        // Only the file that the index alone names is held to the index's word; of the others it is kept for telling.
        assert_eq!(media_files.len(), 1);
        let said = |file: &&SpoolFile| file.listed.is_some();
        assert_eq!(spool.files.iter().filter(said).count(), 2);
        // The picture is among the files to read, where it lies; the index's own copy has not stayed.
        assert!(files.contains(&disc.path().join("AVIEWER").join("logo.png")));
        assert!(!dir.path().join("DICOMDIR").exists());
        // Only a file that starts as a DICOM file does is copied on its own word.
        let copy = |inside: &str| {
            let file = spool
                .files
                .iter()
                .find(|file| file.to == dir.path().join(inside))
                .unwrap();
            let most = crate::input_guard::MAX_FILE_SIZE;
            copy_from_disc(file, most, &mut u64::MAX.clone(), &mut vec![0; 1 << 20]).unwrap()
        };
        assert!(matches!(copy("AVIEWER/viewer.bin"), Copied::NotDicom));
        assert!(matches!(copy("README.TXT"), Copied::NotDicom));
        // One named as DICOM is copied all the same, so that the import says why it cannot be opened.
        assert!(matches!(copy("AVIEWER/broken.dcm"), Copied::Whole));
        assert!(matches!(copy("DICOM/GONE"), Copied::Unreadable(_)));
        assert!(matches!(copy("AVIEWER/demo"), Copied::Whole));
        assert_eq!(
            fs::read(dir.path().join("AVIEWER/demo")).unwrap(),
            fs::read(disc.path().join("AVIEWER/demo")).unwrap()
        );
        assert!(!dir.path().join("README.TXT").exists());
        // A disc that gives more than its allowance ends the import.
        let image = &spool.files[0];
        let most = crate::input_guard::MAX_FILE_SIZE;
        assert!(copy_from_disc(image, most, &mut 100, &mut vec![0; 1 << 20]).is_err());
        // A file larger than its own limit fails alone, and leaves no copy (as a disc's index over its limit does).
        let other = &spool.files[1];
        let copied = copy_from_disc(other, 100, &mut u64::MAX.clone(), &mut vec![0; 1 << 20]);
        let Ok(Copied::Unreadable(error)) = copied else {
            panic!("a file over its limit is not copied");
        };
        assert_eq!(crate::message::coded(&error).unwrap().code, "file.tooLarge");
        assert!(!other.to.exists());
        // A copy with nowhere to go (its place taken already, as by a name this computer does not tell from another)
        // fails alone too, and the copy there stays as it was.
        let twin = SpoolFile {
            from: other.from.clone(),
            to: dir.path().join("AVIEWER/demo"),
            take: Take::Whole,
            listed: None,
            series: None,
            first: false,
        };
        let copied = copy_from_disc(&twin, most, &mut u64::MAX.clone(), &mut vec![0; 1 << 20]);
        assert!(matches!(copied, Ok(Copied::Unreadable(_))));
        assert_eq!(
            fs::read(dir.path().join("AVIEWER/demo")).unwrap(),
            fs::read(disc.path().join("AVIEWER/demo")).unwrap()
        );
    }

    #[test]
    fn a_disc_is_read_once_only_where_it_is_selected_once_and_there_is_room_for_it() {
        let disc = |serial: u32, size: u64| {
            Some(Disc {
                size,
                serial: Some(serial),
            })
        };
        let gib = 1 << 30;
        // Two selections on one disc are read where they are; a test's folder always goes.
        let test = Some(ANY_DISC);
        let found = discs_read_once(&[disc(7, gib), None, disc(7, gib), test], Some(u64::MAX));
        assert_eq!(found, [None, None, None, test]);
        // Two discs share the room, with SPARE_BYTES to spare: the second does not fit beside the first.
        let room = Some(3 * gib + SPARE_BYTES - 1);
        let found = discs_read_once(&[disc(1, 2 * gib), disc(2, gib), disc(3, gib / 2)], room);
        assert_eq!(found, [disc(1, 2 * gib), None, disc(3, gib / 2)]);
        // Where the room is not known, no disc is copied.
        assert_eq!(discs_read_once(&[disc(1, 1)], None), [None]);
    }

    #[test]
    fn a_disc_file_is_copied_only_under_a_name_this_computer_keeps() {
        for kept in [
            "DICOM/IM000001",
            "Hasta Adı (1)/IM 1.dcm",
            "a.b/c.d.e",
            "COM/LPT/CONSOLE",
            "COM10",
            "NULL",
        ] {
            assert!(keeps_name(Path::new(kept)), "{kept}");
        }
        for unkept in [
            "DICOM/NUL",
            "aux.dcm",
            "x/COM1",
            "x/lpt9.txt",
            "Con",
            "COM¹",
            "CONIN$",
            "a/nul .txt",
            "a./b",
            "a/b ",
            "a/b.",
            "../a",
            "a/b:c",
            "a/b?",
        ] {
            assert!(!keeps_name(Path::new(unkept)), "{unkept}");
        }
    }

    #[test]
    fn zip_traversal_is_rejected() {
        let temp = crate::test_dir::tempdir().unwrap();
        let file = temp.path().join("bad.zip");
        let mut zip = zip::ZipWriter::new(File::create(&file).unwrap());
        zip.start_file("../outside", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();
        assert!(extract_zip(&file).is_err());
        assert!(!temp.path().join("outside").exists());
    }

    #[test]
    fn zip_entries_share_the_bytes_left_for_extraction() {
        let temp = crate::test_dir::tempdir().unwrap();
        let file = temp.path().join("study.zip");
        let mut zip = zip::ZipWriter::new(File::create(&file).unwrap());
        for name in ["first", "second"] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"1234").unwrap();
        }
        drop(zip.finish().unwrap());
        let (short, _) = plan_zip(&file).unwrap();
        let error = extract_zip_into(&file, short.path(), 7, &mut |_| {}).unwrap_err();
        assert_eq!(crate::message::coded(&error).unwrap().code, "zip.tooLarge");
        assert!(!short.path().join("second").exists());
        let (exact, _) = plan_zip(&file).unwrap();
        extract_zip_into(&file, exact.path(), 8, &mut |_| {}).unwrap();
        assert_eq!(fs::read(exact.path().join("second")).unwrap(), b"1234");
    }

    #[test]
    fn a_zip_too_large_for_the_import_or_for_this_computers_room_is_refused_before_anything_is_written()
     {
        let temp = crate::test_dir::tempdir().unwrap();
        let file = temp.path().join("study.zip");
        let mut zip = zip::ZipWriter::new(File::create(&file).unwrap());
        zip.add_directory("Seri1/", zip::write::SimpleFileOptions::default())
            .unwrap();
        for name in ["Seri1/first", "Seri1/second"] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"1234").unwrap();
        }
        drop(zip.finish().unwrap());
        let code = |result: Result<(ArchiveTempDir, Vec<PathBuf>, u64)>| {
            crate::message::coded(&result.err().unwrap()).map(|note| note.code)
        };
        // The files list 8 bytes in all: more than the import may take, or than the room leaves beside its spare.
        assert_eq!(code(plan_zip_within(&file, 7, None)), Some("zip.tooLarge"));
        let room = 8 + SPARE_BYTES / 2 - 1;
        assert_eq!(
            code(plan_zip_within(&file, 8, Some(room))),
            Some("zip.noRoom")
        );
        // Just enough of both, or a computer that says nothing of its room: planned, and extracted whole.
        let (dir, planned, listed) = plan_zip_within(&file, 8, Some(room + 1)).unwrap();
        assert_eq!((planned.len(), listed), (2, 8));
        drop(dir);
        // A second archive of the import is planned on the room the first leaves: no room for it.
        let left = Some(room + 1 - listed);
        assert_eq!(code(plan_zip_within(&file, 8, left)), Some("zip.noRoom"));
        let (dir, _, _) = plan_zip_within(&file, 8, None).unwrap();
        extract_zip_into(&file, dir.path(), 8, &mut |_| {}).unwrap();
        assert_eq!(
            fs::read(dir.path().join("Seri1").join("second")).unwrap(),
            b"1234"
        );
    }

    #[test]
    fn zip_import_rejects_conflicting_entry_names() {
        let temp = crate::test_dir::tempdir().unwrap();
        let file = temp.path().join("study.zip");
        let mut zip = zip::ZipWriter::new(File::create(&file).unwrap());
        zip.start_file("scan.dcm", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"synthetic slice").unwrap();
        drop(zip.finish().unwrap());
        let imported = extract_zip(&file).unwrap();
        assert_eq!(
            fs::read(imported.path().join("scan.dcm")).unwrap(),
            b"synthetic slice"
        );

        // Change only the local header name; the central directory still says scan.dcm.
        let mut bytes = fs::read(&file).unwrap();
        assert_eq!(&bytes[0..4], b"PK\x03\x04");
        assert_eq!(&bytes[30..38], b"scan.dcm");
        bytes[30..38].copy_from_slice(b"mask.dcm");
        fs::write(&file, bytes).unwrap();
        assert!(extract_zip(&file).is_err());
    }

    /// Two series in folders of their own, and what a folder listing leaves out: a hidden folder, a hidden file and a
    /// sidecar text file.
    fn two_series_study() -> crate::test_dir::TempDir {
        let study = crate::test_dir::tempdir().unwrap();
        for (folder, series) in [("Seri1", "1.2.3.4.1"), ("Seri2", "1.2.3.4.2")] {
            fs::create_dir_all(study.path().join(folder)).unwrap();
            for index in 0..4 {
                let mut obj = classic_slice(index + 1, index as f64 * 2.);
                obj.put_str(Tag(0x0020, 0x000e), VR::UI, series);
                obj.put_str(Tag(0x0008, 0x0018), VR::UI, format!("{series}.{index}"));
                write_metadata(obj, &study.path().join(folder).join(format!("IM{index}")));
            }
        }
        fs::create_dir_all(study.path().join(".thumbs")).unwrap();
        fs::copy(
            study.path().join("Seri1/IM0"),
            study.path().join(".thumbs/IM0"),
        )
        .unwrap();
        fs::copy(
            study.path().join("Seri1/IM0"),
            study.path().join("Seri2/.IM9"),
        )
        .unwrap();
        fs::write(study.path().join("Seri1/notes.txt"), b"not an image").unwrap();
        study
    }
    /// The two-series study, written as a disc with a DICOMDIR by the engine's own export, in `out`.
    fn indexed_two_series(out: &Path) -> PathBuf {
        let study = two_series_study();
        let mut files = Vec::new();
        collect_files(study.path(), &mut files).unwrap();
        // The export writes the index's records in the order it is given the files, and a folder lists its files in
        // the file system's order (by name on Windows, not on Linux): in one order everywhere, Seri1's series first.
        files.sort();
        let opts = serde_json::from_value(serde_json::json!({"directory": out, "dicomdir": true}));
        let media = crate::export::export_series(&files, &opts.unwrap()).unwrap();
        PathBuf::from(media.directory)
    }

    #[test]
    fn a_disc_with_an_index_is_planned_with_each_series_middle_file_first() {
        let out = crate::test_dir::tempdir().unwrap();
        let disc = indexed_two_series(out.path());
        let (mut files, mut media_files, mut planned, mut noted) =
            (Vec::new(), HashMap::new(), Vec::new(), Vec::new());
        let (_dir, spool) = plan_spool(
            &disc,
            None,
            DiscToRead {
                disc: ANY_DISC,
                earlier: &[],
            },
            &mut files,
            &mut media_files,
            &mut planned,
            &mut noted,
        )
        .unwrap();
        let listed: Vec<_> = planned.iter().map(|s| (s.uid.as_str(), s.files)).collect();
        assert_eq!(listed, [("1.2.3.4.1", 4), ("1.2.3.4.2", 4)]);
        assert!(noted.is_empty());
        // One middle file of each series, then the other six.
        let series = |file: &SpoolFile| (file.first, file.series);
        let mut order: Vec<_> = spool.files.iter().map(series).collect();
        order[..2].sort();
        assert_eq!(order[..2], [(true, Some(0)), (true, Some(1))]);
        assert!(order[2..].iter().all(|(first, _)| !first));
        assert_eq!(order.len(), 8);
    }

    #[test]
    fn a_series_the_viewer_asks_for_is_copied_next_and_the_rest_as_planned() {
        let file = |series: Option<usize>| SpoolFile {
            from: PathBuf::new(),
            to: PathBuf::new(),
            take: Take::IfDicom,
            listed: None,
            series,
            first: false,
        };
        let files = [Some(0), Some(1), Some(0), Some(1), None, Some(1)].map(file);
        let plan = Plan::new(vec![crate::model::PlannedSeries::default(); 2]);
        let mut queue = SpoolQueue::new(&files);
        let mut order = vec![queue.next(Some(&plan)).unwrap()];
        assert!(plan.want(1) && !plan.want(2));
        order.extend(std::iter::from_fn(|| queue.next(Some(&plan))));
        // The first file was on its way; then the series asked for, then the rest, each file once.
        assert_eq!(order, [0, 1, 3, 5, 2, 4]);
        // With middle files at the start (the cards' pictures): the middle file of the series asked for first, the
        // other middle files next, then the rest of that series, then the rest.
        let middle = |series: usize| SpoolFile {
            first: true,
            ..file(Some(series))
        };
        let files = [
            middle(0),
            middle(1),
            middle(2),
            file(Some(0)),
            file(Some(2)),
            file(Some(2)),
            file(None),
        ];
        let plan = Plan::new(vec![crate::model::PlannedSeries::default(); 3]);
        let mut queue = SpoolQueue::new(&files);
        plan.want(2);
        let order: Vec<_> = std::iter::from_fn(|| queue.next(Some(&plan))).collect();
        assert_eq!(order, [2, 0, 1, 4, 5, 3, 6]);
    }

    #[test]
    fn a_series_the_viewer_asks_for_is_handed_over_as_far_as_it_is_read_and_whole_once_read() {
        let study = two_series_study();
        let mut files = Vec::new();
        collect_files(study.path(), &mut files).unwrap();
        files.sort();
        let slots: Vec<Slot> = files.iter().map(|_| OnceLock::new()).collect();
        let of = |uid: &str| -> Vec<usize> {
            (0..files.len())
                .filter(|&index| files[index].to_string_lossy().contains(uid))
                .collect()
        };
        // The study's files are named by folder: Seri1 holds the first series, Seri2 the second.
        let (first, second) = (of("Seri1"), of("Seri2"));
        assert_eq!((first.len(), second.len()), (4, 4));
        let listed = |uid: &str| crate::model::PlannedSeries {
            uid: uid.to_owned(),
            ..Default::default()
        };
        let plan = Plan::new(vec![listed("1.2.3.4.1"), listed("1.2.3.4.2")]);
        // A file is read as the import reads it: its slot set, then counted in its series.
        let read = |series: usize, index: usize| {
            let _ = slots[index].set(Some(read_frames_budget(
                &files[index],
                &crate::import_budget::ImportBudget::default(),
                None,
                None,
                true,
            )));
            plan.finished[series].fetch_add(1, std::sync::atomic::Ordering::Release);
        };
        let mut watch = PlanWatch::new(vec![first.clone(), second.clone()]);
        let handed = std::sync::Mutex::new(Vec::new());
        let sink = |handed_over: HandOver| {
            if let HandOver::Series(found) = handed_over {
                handed.lock().unwrap().extend(found);
            }
        };
        let take = || std::mem::take(&mut *handed.lock().unwrap());
        // The window the second series' picture was measured with; the slices store none.
        let windows = [None, Some((12., 34.))];
        // Two files of the second series read, and it is asked for: it goes as far as it is read.
        read(1, second[0]);
        read(1, second[1]);
        watch.publish(&plan, &windows, &files, &slots, &sink, 0);
        assert!(
            take().is_empty(),
            "nothing goes in part unless it is asked for"
        );
        plan.want(1);
        watch.publish(&plan, &windows, &files, &slots, &sink, 0);
        let part = take();
        assert_eq!(part.len(), 1);
        assert_eq!(part[0].frames.len(), 2);
        let reading = Some(crate::model::Reading { read: 2, files: 4 });
        assert_eq!(part[0].info.reading, reading);
        assert!(!part[0].info.can_reconstruct);
        // Its window is its picture's while it is read, not one measured from what is read of it.
        let window =
            |series: &Arc<SourceSeries>| (series.info.window_center, series.info.window_width);
        assert!(part[0].info.window_from_pixels);
        assert_eq!(window(&part[0]), (12., 34.));
        // Not again until it has grown and a pause has passed.
        read(1, second[2]);
        watch.publish(&plan, &windows, &files, &slots, &sink, 0);
        assert!(take().is_empty());
        // Read whole, it goes at once, whole, and never again: with the window measured from the whole of it.
        read(1, second[3]);
        watch.publish(&plan, &windows, &files, &slots, &sink, 0);
        let whole = take();
        assert_eq!(
            (whole.len(), whole[0].frames.len(), whole[0].info.reading),
            (1, 4, None)
        );
        assert_eq!(whole[0].info.id, part[0].info.id);
        assert_eq!(window(&whole[0]), (1000., 1.));
        watch.publish(&plan, &windows, &files, &slots, &sink, 0);
        assert!(take().is_empty());
        // A series nobody asked for goes once it is read whole.
        for &index in &first {
            read(0, index);
        }
        watch.publish(&plan, &windows, &files, &slots, &sink, 0);
        let other = take();
        assert_eq!(
            (
                other.len(),
                other[0].frames.len(),
                other[0].info.uid.as_str()
            ),
            (1, 4, "1.2.3.4.1")
        );
        // Files the index puts in a series of another UID than theirs make no series of that plan's.
        let plan = Plan::new(vec![listed("1.2.3.4.9")]);
        plan.finished[0].store(4, std::sync::atomic::Ordering::Release);
        PlanWatch::new(vec![first.clone()]).publish(&plan, &[None], &files, &slots, &sink, 0);
        assert!(take().is_empty());
    }

    #[test]
    fn a_series_picture_comes_only_from_a_file_of_the_series_and_patient_the_plan_gives() {
        let study = two_series_study();
        // A file of the second series that names a patient.
        let mut named = classic_slice(9, 16.);
        named.put_str(Tag(0x0020, 0x000e), VR::UI, "1.2.3.4.2");
        named.put_str(Tag(0x0008, 0x0018), VR::UI, "1.2.3.4.2.9");
        named.put_str(Tag(0x0010, 0x0020), VR::LO, "P1");
        write_metadata(named, &study.path().join("Seri2/NAMED"));
        let mut files = Vec::new();
        collect_files(study.path(), &mut files).unwrap();
        files.sort();
        let slots: Vec<Slot> = files.iter().map(|_| OnceLock::new()).collect();
        for (slot, file) in slots.iter().zip(&files) {
            let budget = crate::import_budget::ImportBudget::default();
            let _ = slot.set(Some(read_frames_budget(file, &budget, None, None, true)));
        }
        let of = |folder: &str| -> Vec<usize> {
            (0..files.len())
                .filter(|&index| files[index].to_string_lossy().contains(folder))
                .collect()
        };
        let (first, named) = (of("Seri1"), of("NAMED")[0]);
        let listed = |uid: &str, patient: &str| crate::model::PlannedSeries {
            uid: uid.to_owned(),
            patient_id: patient.to_owned(),
            ..Default::default()
        };
        // The first series' slices name no patient, and the index names one for them (as UNKNOWN). The second series
        // is given a file of the first as its middle one; the third, a file of its series under another patient.
        let plan = Plan::new(vec![
            listed("1.2.3.4.1", "UNKNOWN"),
            listed("1.2.3.4.2", ""),
            listed("1.2.3.4.2", "P2"),
        ]);
        let mut watch = PreviewWatch::new(vec![(0, first[1]), (1, first[2]), (2, named)], 3);
        let pictures = std::sync::Mutex::new(Vec::new());
        let sink = |handed_over: HandOver| {
            if let HandOver::Preview { planned, series } = handed_over {
                pictures.lock().unwrap().push((planned, series));
            }
        };
        watch.publish(&plan, &files, &slots, &sink, 0);
        let pictures = pictures.into_inner().unwrap();
        assert_eq!(pictures.len(), 1);
        assert_eq!(
            (pictures[0].0, pictures[0].1.info.uid.as_str()),
            (0, "1.2.3.4.1")
        );
        assert!(watch.waiting.is_empty());
        // The window the picture was measured with, from its pixels, holds for its series while that is read.
        assert_eq!(watch.windows, [Some((1000., 1.)), None, None]);
        // A series of the plan is handed over only with the patient the plan gives it, too, where both name one.
        let mut watch = PlanWatch::new(vec![first, vec![named], vec![named]]);
        let handed = std::sync::Mutex::new(Vec::new());
        let sink = |handed_over: HandOver| {
            if let HandOver::Series(made) = handed_over {
                let patients = made.iter().map(|source| source.info.patient_id.clone());
                handed.lock().unwrap().extend(patients);
            }
        };
        watch.publish(&plan, &[None; 3], &files, &slots, &sink, 0);
        assert_eq!(handed.into_inner().unwrap(), ["", "P1"]);
    }

    #[test]
    fn a_file_a_discs_index_lists_is_read_as_dicom_whatever_it_is_called() {
        let disc = crate::test_dir::tempdir().unwrap();
        let listed = [("DICOM/IM1.JPG", "1.2.3.4.21"), ("DICOM/IM2", "1.2.3.4.22")];
        for (index, (inside, instance)) in listed.iter().enumerate() {
            let mut obj = classic_slice(index + 1, index as f64 * 2.);
            obj.put_str(Tag(0x0008, 0x0018), VR::UI, *instance);
            let path = disc.path().join(inside);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            write_metadata(obj, &path);
        }
        let ids = listed.map(|(inside, instance)| (inside.replace('/', "\\"), instance));
        let ids: Vec<(&str, &str)> = ids
            .iter()
            .map(|(id, instance)| (id.as_str(), *instance))
            .collect();
        write_index(&disc.path().join("DICOMDIR"), &ids);
        let paths = [disc.path().to_string_lossy().into_owned()];
        let imported = import_session_from(&paths, None, 0, &|_| Some(ANY_DISC), &[]).unwrap();
        // Both images, the one named as a picture among them: the index lists it, so it is a DICOM file.
        let images: usize = imported
            .sources
            .iter()
            .map(|source| source.frames.len())
            .sum();
        assert_eq!(images, 2);
    }

    #[test]
    fn a_disc_with_an_index_hands_over_a_picture_of_each_series_from_its_middle_file() {
        let out = crate::test_dir::tempdir().unwrap();
        let disc = indexed_two_series(out.path());
        let pictures = std::sync::Mutex::new(Vec::new());
        let sink = |handed_over: HandOver| {
            if let HandOver::Preview { planned, series } = handed_over {
                pictures.lock().unwrap().push((planned, series));
            }
        };
        let paths = [disc.to_string_lossy().into_owned()];
        let imported =
            import_session_from(&paths, Some(&sink), 0, &|_| Some(ANY_DISC), &[]).unwrap();
        let mut pictures = pictures.into_inner().unwrap();
        pictures.sort_by_key(|(planned, _)| *planned);
        assert_eq!(pictures.len(), 2);
        for (planned, picture) in pictures {
            assert_eq!(picture.info.uid, ["1.2.3.4.1", "1.2.3.4.2"][planned]);
            let whole = imported
                .sources
                .iter()
                .find(|s| s.info.uid == picture.info.uid);
            let whole = whole.unwrap();
            // The picture is the series' middle image, under an id of its own.
            assert_eq!(picture.frames.len(), 1);
            let middle = &whole.frames[(whole.frames.len() - 1) / 2];
            assert_eq!(picture.frames[0].sop_uid, middle.sop_uid);
            assert_eq!(picture.info.id, format!("preview:{}", whole.info.id));
        }
    }

    /// The drive of this computer's temporary folder taken for a disc's: its serial number is a real one, and it has
    /// room.
    #[cfg(windows)]
    #[test]
    fn a_disc_replaced_in_its_drive_stops_the_import_and_one_selected_twice_is_read_where_it_is() {
        let out = crate::test_dir::tempdir().unwrap();
        let disc = indexed_two_series(out.path());
        let serial = crate::disc::serial(&disc).unwrap();
        let on = |serial: u32| {
            move |_: &Path| {
                Some(Disc {
                    size: 1 << 20,
                    serial: Some(serial),
                })
            }
        };
        let frames = |imported: &Imported| -> usize {
            imported
                .sources
                .iter()
                .map(|source| source.frames.len())
                .sum()
        };
        // Two selections on one disc: read where they are, as from any folder, each image once.
        let both = [disc.clone(), disc.join("DICOMDIR")];
        let paths = both.map(|path| path.to_string_lossy().into_owned());
        let twice = import_session_from(&paths, None, 0, &on(serial), &[]).unwrap();
        assert!(twice.archives.is_empty());
        assert_eq!(frames(&twice), 8);
        // Another disc in the drive before anything is taken from it: nothing is read, however soon the disc would be
        // read whole (this one in well under the second between two looks).
        let paths = [disc.to_string_lossy().into_owned()];
        let error = import_session_from(&paths, None, 0, &on(serial ^ 1), &[])
            .err()
            .unwrap();
        assert_eq!(
            crate::message::coded(&error).map(|note| note.code),
            Some("import.discRemoved")
        );
        // A file the disc does not give, with another disc in the drive by then: the import reads no further. Here the
        // first one it asks for (none of the disc's images is left), so no series was read whole.
        let mut listed = Vec::new();
        collect_files(&disc.join("DICOM"), &mut listed).unwrap();
        for file in &listed {
            fs::remove_file(file).unwrap();
        }
        let paths = [disc.to_string_lossy().into_owned()];
        let error = import_session_from(&paths, None, 0, &on(serial ^ 1), &[])
            .err()
            .unwrap();
        assert_eq!(
            crate::message::coded(&error).map(|note| note.code),
            Some("import.discRemoved")
        );
        // With the same disc in the drive, a file it does not give fails alone.
        let out = crate::test_dir::tempdir().unwrap();
        let disc = indexed_two_series(out.path());
        let mut listed = Vec::new();
        collect_files(&disc.join("DICOM"), &mut listed).unwrap();
        fs::remove_file(&listed[0]).unwrap();
        let paths = [disc.to_string_lossy().into_owned()];
        let read = import_session_from(&paths, None, 0, &on(serial), &[]).unwrap();
        assert_eq!((read.archives.len(), frames(&read)), (1, 7));
    }

    #[test]
    fn a_disc_whose_drive_does_not_name_it_is_not_taken_for_the_one_being_read_though_its_files_can_be_read()
     {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // A folder whose file can be read, as a disc's can while its drive gives no serial number.
        let out = crate::test_dir::tempdir().unwrap();
        fs::write(out.path().join("IM1"), b"synthetic").unwrap();
        let within = std::time::Duration::from_millis(300);
        fn named(_: &Path) -> Option<u32> {
            Some(7)
        }
        fn unnamed(_: &Path) -> Option<u32> {
            None
        }
        assert!(disc_named(7, out.path(), named, within));
        assert!(!disc_named(8, out.path(), named, within));
        // Asked again for the while given, and taken for no disc.
        let started = std::time::Instant::now();
        assert!(!disc_named(7, out.path(), unnamed, within));
        assert!(started.elapsed() >= within);
        // Named after two failed lookups, as a drive does once its disc turns: taken.
        static LOOKUPS: AtomicUsize = AtomicUsize::new(0);
        fn late(_: &Path) -> Option<u32> {
            (LOOKUPS.fetch_add(1, Ordering::SeqCst) >= 2).then_some(7)
        }
        assert!(disc_named(
            7,
            out.path(),
            late,
            std::time::Duration::from_secs(5)
        ));
        assert_eq!(LOOKUPS.load(Ordering::SeqCst), 3);
        // A folder that is not there is on no disc, with no wait.
        let started = std::time::Instant::now();
        let gone = out.path().join("gone");
        assert!(!disc_named(
            7,
            &gone,
            unnamed,
            std::time::Duration::from_secs(5)
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn a_disc_taken_out_keeps_the_series_its_index_lists_that_were_read_whole() {
        // Two discs with an index each, read one after the other: the second goes once their series are listed,
        // before any of their files is copied, so the first is read whole and the second not at all.
        let out = crate::test_dir::tempdir().unwrap();
        let first = indexed_two_series(out.path());
        let study = crate::test_dir::tempdir().unwrap();
        for index in 0..3 {
            let mut obj = classic_slice(index + 1, index as f64 * 2.);
            obj.put_str(Tag(0x0020, 0x000e), VR::UI, "1.2.3.9.1");
            obj.put_str(Tag(0x0008, 0x0018), VR::UI, format!("1.2.3.9.1.{index}"));
            write_metadata(obj, &study.path().join(format!("IM{index}")));
        }
        let mut files = Vec::new();
        collect_files(study.path(), &mut files).unwrap();
        let other = crate::test_dir::tempdir().unwrap();
        let opts = serde_json::json!({"directory": other.path(), "dicomdir": true});
        let media = crate::export::export_series(&files, &serde_json::from_value(opts).unwrap());
        let second = PathBuf::from(media.unwrap().directory);
        let sink = |handed: HandOver| {
            if matches!(handed, HandOver::Plan(_)) {
                fs::remove_dir_all(&second).unwrap();
            }
        };
        let paths = [&first, &second].map(|disc| disc.to_string_lossy().into_owned());
        let imported =
            import_session_from(&paths, Some(&sink), 0, &|_| Some(ANY_DISC), &[]).unwrap();
        // The first disc's two series, every image of each, and nothing of the second; and what happened is said.
        let mut series: Vec<_> = (imported.sources.iter())
            .map(|source| (source.info.uid.as_str(), source.frames.len()))
            .collect();
        series.sort();
        assert_eq!(series, [("1.2.3.4.1", 4), ("1.2.3.4.2", 4)]);
        let said = imported
            .warnings
            .iter()
            .find(|note| note.code == "import.discRemovedPart");
        assert!(
            said.is_some_and(|note| note.text.contains("0 of its 1 series")),
            "{:?}",
            imported.warnings
        );
        // A disc taken out before any of its series was read whole gives nothing, and the import stops: see
        // a_disc_taken_out_before_it_is_read_whole_stops_the_import_and_says_so (main.rs).
    }

    #[test]
    fn a_disc_opened_again_takes_the_files_an_earlier_import_copied_of_it() {
        let out = crate::test_dir::tempdir().unwrap();
        let disc = indexed_two_series(out.path());
        let paths = [disc.to_string_lossy().into_owned()];
        let first = import_session_from(&paths, None, 0, &|_| Some(ANY_DISC), &[]).unwrap();
        assert_eq!(first.discs.len(), 1);
        // A file of the disc changes after it was copied, keeping its length: another image's UID of the same length.
        let mut listed = Vec::new();
        collect_files(&disc.join("DICOM"), &mut listed).unwrap();
        let (old, new) = (b"1.2.3.4.1.0", b"1.2.3.4.1.9");
        let changed = (listed.iter())
            .find(|file| {
                fs::read(file)
                    .unwrap()
                    .windows(old.len())
                    .any(|bytes| bytes == old)
            })
            .unwrap();
        let mut bytes = fs::read(changed).unwrap();
        for at in 0..=bytes.len() - old.len() {
            if &bytes[at..at + old.len()] == old {
                bytes[at..at + old.len()].copy_from_slice(new);
            }
        }
        fs::write(changed, bytes).unwrap();
        let images = |imported: &Imported| -> Vec<String> {
            let mut all: Vec<_> = (imported.sources.iter().flat_map(|source| &source.frames))
                .map(|frame| frame.sop_uid.clone())
                .collect();
            all.sort();
            all
        };
        // Opened again, the disc's files come from the earlier copy: the image as it was copied.
        let again =
            import_session_from(&paths, None, 0, &|_| Some(ANY_DISC), &first.discs).unwrap();
        let taken = images(&again);
        assert_eq!(taken.len(), 8);
        assert!(
            taken.contains(&"1.2.3.4.1.0".to_owned()) && !taken.contains(&"1.2.3.4.1.9".to_owned())
        );
        // Another disc (here, of another size) at the same place is read from the disc.
        let another = Disc {
            size: u64::MAX - 1,
            serial: None,
        };
        let read = import_session_from(&paths, None, 0, &|_| Some(another), &first.discs).unwrap();
        assert!(images(&read).contains(&"1.2.3.4.1.9".to_owned()));
        // The earlier copy is read as it is, and its own import's images read on, unchanged for it.
        for source in first.sources.iter().chain(&again.sources) {
            crate::decode::decode_frame(source, 0).unwrap();
        }
    }

    #[test]
    fn a_copy_made_while_the_disc_was_not_found_again_goes_and_the_disc_opened_again_gives_that_file_anew()
     {
        let out = crate::test_dir::tempdir().unwrap();
        let disc = indexed_two_series(out.path());
        let paths = [disc.to_string_lossy().into_owned()];
        let first = import_session_from(&paths, None, 0, &|_| Some(ANY_DISC), &[]).unwrap();
        // One file as the disc now gives it, of the same length: what another disc of the same names could hold.
        let mut listed = Vec::new();
        collect_files(&disc.join("DICOM"), &mut listed).unwrap();
        let (old, new) = (b"1.2.3.4.1.0", b"1.2.3.4.1.9");
        let changed = (listed.iter())
            .find(|file| {
                fs::read(file)
                    .unwrap()
                    .windows(old.len())
                    .any(|bytes| bytes == old)
            })
            .unwrap();
        let mut bytes = fs::read(changed).unwrap();
        for at in 0..=bytes.len() - old.len() {
            if &bytes[at..at + old.len()] == old {
                bytes[at..at + old.len()].copy_from_slice(new);
            }
        }
        fs::write(changed, bytes).unwrap();
        // Its copy, as if made while the disc was looked for and not found: it goes. An earlier import's copy stays.
        let copy = |file: &Path| first.discs[0].copy.join(file.strip_prefix(&disc).unwrap());
        let spooled = |file: &Path, take: Take| SpoolFile {
            from: file.to_owned(),
            to: copy(file),
            take,
            listed: None,
            series: None,
            first: false,
        };
        let made = spooled(changed, Take::Whole);
        // Held open by another program meanwhile, it cannot be removed: that ends the import (Windows only lets a
        // file held so be kept from removal).
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let held = fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&made.to)
                .unwrap();
            assert!(keep_copy(&made, || false).is_err());
            drop(held);
        }
        assert!(keep_copy(&made, || true).unwrap() && made.to.exists());
        assert!(!keep_copy(&made, || false).unwrap() && !made.to.exists());
        let other = listed.iter().find(|file| *file != changed).unwrap();
        let kept = spooled(other, Take::Kept { unlisted: false });
        assert!(!keep_copy(&kept, || false).unwrap() && kept.to.exists());
        // Opened again, the disc gives that file anew; the others come from their copies.
        let again =
            import_session_from(&paths, None, 0, &|_| Some(ANY_DISC), &first.discs).unwrap();
        let mut images: Vec<_> = (again.sources.iter().flat_map(|source| &source.frames))
            .map(|frame| frame.sop_uid.clone())
            .collect();
        images.sort();
        assert_eq!(images.len(), 8);
        assert!(
            images.contains(&"1.2.3.4.1.9".to_owned())
                && !images.contains(&"1.2.3.4.1.0".to_owned())
        );
    }

    #[test]
    fn a_file_that_names_no_instance_is_read_and_its_image_goes_to_the_viewer_with_none() {
        // A synthetic file without a SOP Instance UID: read, as any file is; the viewer then has nothing to tell its
        // image apart by (src/ui/earlySeries.ts).
        let out = crate::test_dir::tempdir().unwrap();
        let mut unnamed = classic_slice(1, 0.);
        assert!(unnamed.remove_element(Tag(0x0008, 0x0018)));
        write_metadata(unnamed, &out.path().join("IM1"));
        let named = classic_slice(2, 2.);
        let instance = text(&named, Tag(0x0008, 0x0018));
        assert!(!instance.is_empty());
        write_metadata(named, &out.path().join("IM2"));
        let paths = [out.path().to_string_lossy().into_owned()];
        let read = import_session_from(&paths, None, 0, &|_| None, &[]).unwrap();
        let frames: Vec<_> = (read.sources.iter())
            .flat_map(|source| &source.frames)
            .collect();
        assert_eq!(frames.len(), 2);
        let sent = |uid: &str| {
            let frame = frames.iter().find(|frame| frame.sop_uid == uid).unwrap();
            serde_json::to_value(&frame.metadata).unwrap()
        };
        assert_eq!(sent(&instance)["sopInstanceUid"], instance.as_str());
        assert!(sent("").get("sopInstanceUid").is_none());
    }

    #[test]
    fn an_image_whose_rescale_cannot_be_read_keeps_no_unit_and_its_series_says_so() {
        // Synthetic slices of one series, one rescale value each (None: the element is not there), read as a folder:
        // each series as (unit, slices, said), and whether its window is measured from its pixels.
        let read = |modality: &str, class: &str, slopes: [Option<&str>; 3], intercept: &str| {
            let out = crate::test_dir::tempdir().unwrap();
            for (index, slope) in slopes.into_iter().enumerate() {
                let mut obj = classic_slice(index + 1, index as f64 * 2.);
                obj.put_str(Tag(0x0008, 0x0016), VR::UI, class);
                obj.put_str(Tag(0x0008, 0x0060), VR::CS, modality);
                if let Some(slope) = slope {
                    obj.put(ds(Tag(0x0028, 0x1053), slope));
                }
                obj.put(ds(Tag(0x0028, 0x1052), intercept));
                // A stored window, in the rescaled values.
                obj.put(ds(Tag(0x0028, 0x1050), "40"));
                obj.put(ds(Tag(0x0028, 0x1051), "400"));
                write_metadata(obj, &out.path().join(format!("IM{index}")));
            }
            let paths = [out.path().to_string_lossy().into_owned()];
            let imported = import_session_from(&paths, None, 0, &|_| None, &[]).unwrap();
            let mut found: Vec<_> = (imported.sources.iter())
                .map(|source| {
                    let said = (source.info.warnings.iter())
                        .any(|note| note.code == "series.rescaleUnread");
                    let info = &source.info;
                    (
                        info.value_unit.clone(),
                        source.frames.len(),
                        said,
                        needs_pixel_window(source),
                    )
                })
                .collect();
            found.sort();
            found
        };
        const CT: &str = "1.2.840.10008.5.1.4.1.1.2";
        const MR: &str = "1.2.840.10008.5.1.4.1.1.4";
        // A CT: the readable slices in HU, as before; the other in a series of its own, in a.u., said, and with a window
        // of its pixels rather than its stored one.
        assert_eq!(
            read("CT", CT, [Some("1"), Some("1"), Some("one")], "-1024"),
            [
                ("HU".to_owned(), 2, false, false),
                ("a.u.".to_owned(), 1, true, true)
            ]
        );
        // An MR, whose unit is a.u. either way: the slice is in a series of its own all the same, and said.
        let mr = read("MR", MR, [Some("2"), Some("2"), Some("x")], "0");
        assert_eq!(
            mr.iter()
                .map(|(_, slices, said, _)| (*slices, *said))
                .collect::<Vec<_>>(),
            [(1, true), (2, false)]
        );
        // An empty value is no rescale, as before: one series, nothing said.
        let empty = read("CT", CT, [Some("1"), Some("1"), Some("")], "-1024");
        assert_eq!(
            empty
                .iter()
                .map(|(_, slices, said, _)| (*slices, *said))
                .collect::<Vec<_>>(),
            [(3, false)]
        );
        let none = read("CT", CT, [None, None, None], "-1024");
        assert_eq!(
            none.iter()
                .map(|(_, slices, said, _)| (*slices, *said))
                .collect::<Vec<_>>(),
            [(3, false)]
        );
    }

    /// The folder zipped as an archiver writes it: a folder entry, then its files, names with forward slashes.
    fn zip_folder(folder: &Path, file: &Path) {
        fn walk(folder: &Path, files: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(folder).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, files)
                } else {
                    files.push(path)
                }
            }
        }
        let mut files = Vec::new();
        walk(folder, &mut files);
        files.sort();
        let options = zip::write::SimpleFileOptions::default();
        let mut zip = zip::ZipWriter::new(File::create(file).unwrap());
        zip.add_directory("Seri1/", options).unwrap();
        for path in files {
            let name = path
                .strip_prefix(folder)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            zip.start_file(name, options).unwrap();
            zip.write_all(&fs::read(&path).unwrap()).unwrap();
        }
        zip.finish().unwrap();
    }
    /// Each series as JSON with its frames' paths below `root`, and the import's warnings.
    fn summary(
        imported: &Imported,
        root: &Path,
    ) -> (Vec<(serde_json::Value, Vec<PathBuf>)>, serde_json::Value) {
        let series = imported
            .sources
            .iter()
            .map(|source| {
                let frames = source
                    .frames
                    .iter()
                    .map(|frame| frame.source.path.strip_prefix(root).unwrap().to_owned())
                    .collect();
                (serde_json::to_value(&source.info).unwrap(), frames)
            })
            .collect();
        (series, serde_json::to_value(&imported.warnings).unwrap())
    }
    fn archive_root(imported: &Imported) -> PathBuf {
        imported.archives[0].path().to_owned()
    }

    #[test]
    fn an_archive_read_while_it_is_extracted_gives_its_folder_catalogue() {
        let study = two_series_study();
        let archive = crate::test_dir::tempdir().unwrap();
        let file = archive.path().join("study.zip");
        zip_folder(study.path(), &file);
        let from_folder = import(&[study.path().to_string_lossy().into_owned()]).unwrap();
        let from_archive = import(&[file.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(from_folder.sources.len(), 2);
        assert_eq!(
            summary(&from_archive, &archive_root(&from_archive)),
            summary(&from_folder, study.path())
        );
        // Hidden entries are extracted but not read, as a folder listing never shows them.
        assert!(archive_root(&from_archive).join(".thumbs/IM0").is_file());
    }

    #[test]
    fn series_handed_over_early_are_the_ones_the_import_ends_with() {
        let study = two_series_study();
        let archive = crate::test_dir::tempdir().unwrap();
        let file = archive.path().join("study.zip");
        zip_folder(study.path(), &file);
        for path in [study.path().to_owned(), file] {
            let handed = std::sync::Mutex::new(Vec::new());
            let sink = |handed_over: HandOver| {
                if let HandOver::Series(found) = handed_over {
                    handed.lock().unwrap().extend(found);
                }
            };
            let paths = [path.to_string_lossy().into_owned()];
            let imported = import_with(&paths, Some(&sink)).unwrap();
            let handed = handed.into_inner().unwrap();
            assert_eq!(handed.len(), 2, "{path:?}");
            for early in &handed {
                let last = imported
                    .sources
                    .iter()
                    .find(|source| source.info.id == early.info.id)
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(&early.info).unwrap(),
                    serde_json::to_value(&last.info).unwrap()
                );
                assert_eq!(
                    early
                        .frames
                        .iter()
                        .map(|frame| &frame.source.path)
                        .collect::<Vec<_>>(),
                    last.frames
                        .iter()
                        .map(|frame| &frame.source.path)
                        .collect::<Vec<_>>()
                );
            }
            // The catalogue is the one an import without a hand-over makes.
            let plain = import(&paths).unwrap();
            let root = |imported: &Imported| {
                if imported.archives.is_empty() {
                    path.clone()
                } else {
                    archive_root(imported)
                }
            };
            assert_eq!(
                summary(&imported, &root(&imported)),
                summary(&plain, &root(&plain))
            );
        }
    }

    #[test]
    fn a_series_spread_over_folders_waits_for_all_of_them() {
        // Slices 0-1 of one series in A, slices 2-3 of it in B, with a second series.
        let study = crate::test_dir::tempdir().unwrap();
        let mut files = Vec::new();
        for (folder, series, index) in [
            ("A", "1.2.3.4.1", 0),
            ("A", "1.2.3.4.1", 1),
            ("B", "1.2.3.4.1", 2),
            ("B", "1.2.3.4.1", 3),
            ("B", "1.2.3.4.2", 0),
        ] {
            fs::create_dir_all(study.path().join(folder)).unwrap();
            let mut obj = classic_slice(index + 1, index as f64 * 2.);
            obj.put_str(Tag(0x0020, 0x000e), VR::UI, series);
            obj.put_str(Tag(0x0008, 0x0018), VR::UI, format!("{series}.{index}"));
            let path = study.path().join(folder).join(format!("{series}-{index}"));
            write_metadata(obj, &path);
            files.push(path);
        }
        files.sort();
        let budget = crate::import_budget::ImportBudget::default();
        let slots: Vec<Slot> = files.iter().map(|_| OnceLock::new()).collect();
        let read = |index: usize| {
            let _ = slots[index].set(Some(read_frames_budget(
                &files[index],
                &budget,
                None,
                None,
                true,
            )));
        };
        let handed = std::sync::Mutex::new(Vec::new());
        let sink = |handed_over: HandOver| {
            if let HandOver::Series(found) = handed_over {
                handed.lock().unwrap().extend(found);
            }
        };
        let mut watch = EarlyWatch::new(&files);
        // A is read whole, and one file of B that belongs to the same series: it is not whole yet.
        let in_b = files
            .iter()
            .position(|file| file.ends_with("1.2.3.4.1-2"))
            .unwrap();
        for index in (0..files.len())
            .filter(|&index| files[index].parent().unwrap().ends_with("A") || index == in_b)
        {
            read(index);
        }
        watch.publish(&files, &slots, &sink, 0);
        assert!(handed.lock().unwrap().is_empty());
        for index in 0..files.len() {
            read(index);
        }
        watch.publish(&files, &slots, &sink, 0);
        let handed = handed.into_inner().unwrap();
        let mut counts = handed
            .iter()
            .map(|source| (source.info.uid.clone(), source.frames.len()))
            .collect::<Vec<_>>();
        counts.sort();
        assert_eq!(
            counts,
            [("1.2.3.4.1".to_owned(), 4), ("1.2.3.4.2".to_owned(), 1)]
        );
    }

    #[test]
    fn an_archive_that_breaks_while_it_is_extracted_fails_the_import() {
        let study = two_series_study();
        let archive = crate::test_dir::tempdir().unwrap();
        let file = archive.path().join("study.zip");
        zip_folder(study.path(), &file);
        // The last entry's local header names another file than the central directory does.
        let mut bytes = fs::read(&file).unwrap();
        let name = b"Seri2/IM3";
        let at = bytes
            .windows(name.len())
            .position(|window| window == name)
            .unwrap();
        bytes[at + 8] = b'9';
        fs::write(&file, bytes).unwrap();
        let handed = std::sync::Mutex::new(Vec::new());
        let sink = |handed_over: HandOver| {
            if let HandOver::Series(found) = handed_over {
                handed.lock().unwrap().extend(found);
            }
        };
        assert!(import_with(&[file.to_string_lossy().into_owned()], Some(&sink)).is_err());
    }

    use crate::model::PhaseIdentity;
    use dicom_core::PrimitiveValue;
    use std::collections::BTreeSet;

    fn classic_slice(instance: usize, z: f64) -> InMemDicomObject {
        let mut obj = metadata_object(1);
        obj.put_str(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.4");
        obj.put_str(Tag(0x0008, 0x0018), VR::UI, format!("1.2.3.4.5.{instance}"));
        obj.put_str(Tag(0x0020, 0x0013), VR::IS, instance.to_string());
        obj.put(ds(Tag(0x0020, 0x0032), &format!("0\\0\\{z}")));
        obj
    }
    /// Classic slices of one series, every phase at every position, numbered position
    /// by position. Each SOP Instance UID ends in `.{phase}.{position}`.
    fn multiphase(
        phases: usize,
        positions: usize,
        tag: impl Fn(&mut InMemDicomObject, usize),
    ) -> Vec<InMemDicomObject> {
        let mut slices = Vec::new();
        for position in 0..positions {
            for phase in 0..phases {
                let mut obj = classic_slice(position * phases + phase + 1, position as f64 * 2.);
                obj.put_str(
                    Tag(0x0008, 0x0018),
                    VR::UI,
                    format!("1.2.3.4.5.{phase}.{position}"),
                );
                tag(&mut obj, phase);
                slices.push(obj);
            }
        }
        slices
    }
    fn write_slices(slices: Vec<InMemDicomObject>) -> crate::test_dir::TempDir {
        let temp = crate::test_dir::tempdir().unwrap();
        for (index, obj) in slices.into_iter().enumerate() {
            write_metadata(obj, &temp.path().join(format!("slice{index:03}.dcm")));
        }
        temp
    }
    fn import_dir(dir: &crate::test_dir::TempDir) -> Imported {
        import(&[dir.path().to_string_lossy().into_owned()]).unwrap()
    }
    /// A one-frame DX of its own series, with these spacing and orientation tags (text values).
    fn radiograph(series: u32, tags: &[(Tag, VR, &str)]) -> InMemDicomObject {
        let mut obj = metadata_object(1);
        for tag in [
            Tag(0x0028, 0x0030),
            Tag(0x0020, 0x0037),
            Tag(0x0018, 0x0050),
            Tag(0x0028, 0x0008),
        ] {
            obj.remove_element(tag);
        }
        obj.put(DataElement::new(
            Tag(0x0008, 0x0016),
            VR::UI,
            "1.2.840.10008.5.1.4.1.1.1.1",
        ));
        obj.put(DataElement::new(
            Tag(0x0008, 0x0018),
            VR::UI,
            format!("2.25.7710.{series}"),
        ));
        obj.put(DataElement::new(Tag(0x0008, 0x0060), VR::CS, "DX"));
        obj.put(DataElement::new(
            Tag(0x0020, 0x000e),
            VR::UI,
            format!("2.25.7711.{series}"),
        ));
        obj.put(DataElement::new(
            Tag(0x0020, 0x0011),
            VR::IS,
            series.to_string(),
        ));
        for (tag, vr, value) in tags {
            obj.put(DataElement::new(*tag, *vr, *value));
        }
        obj
    }
    #[test]
    fn a_radiograph_measures_with_the_spacing_the_dicom_rules_give_and_names_it() {
        let ips = (Tag(0x0018, 0x1164), VR::DS, "0.33\\0.33");
        let dir = write_slices(vec![
            radiograph(
                1,
                &[
                    ips,
                    (Tag(0x0020, 0x0020), VR::CS, "L\\F"),
                    (Tag(0x0020, 0x0062), VR::CS, "B"),
                ],
            ),
            radiograph(2, &[ips, (Tag(0x0018, 0x1114), VR::DS, "1.1")]),
            radiograph(3, &[ips, (Tag(0x0018, 0x1114), VR::DS, "0.5")]),
            radiograph(
                4,
                &[
                    (Tag(0x0028, 0x0030), VR::DS, "0.3\\0.3"),
                    ips,
                    (Tag(0x0028, 0x0a02), VR::CS, "FIDUCIAL"),
                ],
            ),
            radiograph(5, &[]),
        ]);
        let imported = import_dir(&dir);
        let mut sources: Vec<_> = imported.sources.iter().map(|source| &source.info).collect();
        sources.sort_by_key(|info| info.series_number);
        let codes = |info: &Series| {
            info.warnings
                .iter()
                .map(|note| note.code)
                .collect::<Vec<_>>()
        };
        let basis = |info: &Series| info.frame_metadata[0].projection.as_ref().map(|p| p.basis);
        let detector = sources[0];
        assert!(detector.spacing_known);
        assert_eq!(&detector.spacing[..2], &[0.33, 0.33]);
        assert_eq!(basis(detector), Some(crate::projection::Basis::Detector));
        let projection = detector.frame_metadata[0].projection.as_ref().unwrap();
        assert_eq!(
            (
                projection.patient_orientation.clone(),
                projection.laterality.as_str()
            ),
            (vec!["L".to_owned(), "F".to_owned()], "B")
        );
        assert!(!codes(detector).contains(&"series.noPixelSpacing"));
        let corrected = sources[1];
        assert_eq!(
            basis(corrected),
            Some(crate::projection::Basis::Magnification)
        );
        assert!(
            (corrected.spacing[0] - 0.3).abs() < 1e-12
                && (corrected.spacing[1] - 0.3).abs() < 1e-12
        );
        // A factor below one is no magnification: left out, and said.
        let ignored = sources[2];
        assert_eq!(basis(ignored), Some(crate::projection::Basis::Detector));
        assert!(
            codes(ignored).contains(&"projection.badMagnification"),
            "{:?}",
            codes(ignored)
        );
        assert_eq!(
            basis(sources[3]),
            Some(crate::projection::Basis::Calibrated)
        );
        assert_eq!(&sources[3].spacing[..2], &[0.3, 0.3]);
        let pixels = sources[4];
        assert!(!pixels.spacing_known);
        assert_eq!(basis(pixels), Some(crate::projection::Basis::None));
        assert!(codes(pixels).contains(&"series.noPixelSpacing"));
    }
    #[test]
    fn a_slice_placed_in_the_patient_is_no_projection_whatever_its_modality() {
        // A breast tomosynthesis slice: MG, with Image Orientation and Position, Pixel Spacing alone.
        let mut slice = radiograph(6, &[(Tag(0x0028, 0x0030), VR::DS, "0.1\\0.1")]);
        slice.put(DataElement::new(Tag(0x0008, 0x0060), VR::CS, "MG"));
        slice.put(DataElement::new(
            Tag(0x0020, 0x0037),
            VR::DS,
            "1\\0\\0\\0\\1\\0",
        ));
        slice.put(DataElement::new(Tag(0x0020, 0x0032), VR::DS, "0\\0\\0"));
        let imported = import_dir(&write_slices(vec![slice]));
        let info = &imported.sources[0].info;
        assert!(info.frame_metadata[0].projection.is_none());
        assert_eq!(&info.spacing[..2], &[0.1, 0.1]);
    }
    fn phase(source: &SourceSeries) -> &PhaseIdentity {
        source.info.phase.as_ref().expect("series has no phase")
    }
    /// Every series of the import, each of which must be a phase, in phase order. The
    /// import itself lists them in that order (the series menu shows that order).
    fn phase_order(imported: &Imported) -> Vec<&SourceSeries> {
        let sources: Vec<_> = imported.sources.iter().map(|s| s.as_ref()).collect();
        for source in &sources {
            assert!(source.info.phase.is_some(), "{:?}", source.info.warnings);
        }
        let orders: Vec<_> = sources.iter().map(|s| phase(s).order).collect();
        assert!(orders.is_sorted(), "listed out of phase order: {orders:?}");
        sources
    }
    fn labels<'a>(sources: &[&'a SourceSeries]) -> Vec<&'a str> {
        sources.iter().map(|s| phase(s).label.as_str()).collect()
    }
    /// The phases `multiphase` wrote into the SOP Instance UIDs of a series' frames.
    fn written_phases(source: &SourceSeries) -> BTreeSet<usize> {
        source
            .frames
            .iter()
            .map(|f| f.sop_uid.rsplit('.').nth(1).unwrap().parse().unwrap())
            .collect()
    }
    fn at(tag: Tag, value: Tag) -> DataElement<InMemDicomObject> {
        DataElement::new(tag, VR::AT, PrimitiveValue::Tags(vec![value].into()))
    }
    fn ul(tag: Tag, values: &[u32]) -> DataElement<InMemDicomObject> {
        DataElement::new(tag, VR::UL, PrimitiveValue::U32(values.to_vec().into()))
    }
    /// A DimensionIndexSequence item: the attribute and the functional group holding it.
    fn dimension(pointer: Tag, group: Tag) -> InMemDicomObject {
        InMemDicomObject::from_element_iter([
            at(Tag(0x0020, 0x9165), pointer),
            at(Tag(0x0020, 0x9167), group),
        ])
    }
    /// One Enhanced MR file with every phase at every position, its frames stored in a
    /// shuffled order. Returns each frame's (phase, position).
    fn enhanced_phases(
        path: &Path,
        phases: u32,
        positions: u32,
        dimensions: Vec<InMemDicomObject>,
        frame: impl Fn(u32, u32) -> Vec<DataElement<InMemDicomObject>>,
    ) -> Vec<(u32, u32)> {
        let count = phases * positions;
        let order: Vec<_> = (0..count)
            .map(|f| f * 7 % count)
            .map(|pair| (pair % phases, pair / phases))
            .collect();
        assert_eq!(order.iter().collect::<BTreeSet<_>>().len(), order.len());
        let mut obj = metadata_object(count as usize);
        if !dimensions.is_empty() {
            obj.put(sequence(Tag(0x0020, 0x9222), dimensions));
        }
        let groups = order
            .iter()
            .map(|&(phase, position)| {
                let mut elements = frame(phase, position);
                elements.push(sequence(
                    Tag(0x0020, 0x9113),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0020, 0x0032),
                        &format!("0\\0\\{}", position * 2),
                    )])],
                ));
                InMemDicomObject::from_element_iter(elements)
            })
            .collect();
        obj.put(sequence(Tag(0x5200, 0x9230), groups));
        write_metadata(obj, path);
        order
    }
    /// The frames of a file at which `order` holds the given phase.
    fn frames_of(order: &[(u32, u32)], phase: u32) -> BTreeSet<u32> {
        (0..order.len() as u32)
            .filter(|&f| order[f as usize].0 == phase)
            .collect()
    }
    fn source_frames(source: &SourceSeries) -> BTreeSet<u32> {
        source.frames.iter().map(|f| f.index).collect()
    }

    #[test]
    fn reconstruction_ids_follow_the_same_sources_into_and_out_of_phases() {
        for numbered in [false, true] {
            let slices: Vec<_> = (0..12)
                .map(|i| {
                    let mut obj = classic_slice(i + 1, (i % 6) as f64 * 2.);
                    if numbered {
                        obj.put_str(Tag(0x0020, 0x0012), VR::IS, (i / 6 + 1).to_string());
                    }
                    obj
                })
                .collect();
            let alone = write_slices(slices[..6].to_vec());
            let combined = write_slices(slices);
            let alone = import_dir(&alone);
            let combined = import_dir(&combined);
            assert_eq!(alone.sources.len(), 1);
            assert_eq!(combined.sources.len(), 2);
            let first = &alone.sources[0].info;
            let regrouped = combined
                .sources
                .iter()
                .map(|s| &s.info)
                .find(|info| {
                    info.frame_metadata[0].sop_instance_uid
                        == first.frame_metadata[0].sop_instance_uid
                })
                .unwrap();
            assert!(first.can_reconstruct && regrouped.can_reconstruct);
            assert_ne!(first.id, regrouped.id);
            assert!(regrouped.legacy_grid_ids.contains(&first.id));
            assert!(first.legacy_grid_ids.contains(&regrouped.id));
        }
    }

    #[test]
    fn ordinary_stack_with_changing_acquisition_numbers_stays_one_series() {
        let dir = write_slices(
            (0..20)
                .map(|i| {
                    let mut obj = classic_slice(i + 1, i as f64 * 2.);
                    obj.put_str(Tag(0x0020, 0x0012), VR::IS, (i + 1).to_string());
                    obj.put_str(Tag(0x0008, 0x0032), VR::TM, format!("1011{i:02}"));
                    obj
                })
                .collect(),
        );
        let imported = import_dir(&dir);
        assert_eq!(imported.sources.len(), 1);
        let source = &imported.sources[0];
        assert!(source.info.phase.is_none());
        assert_eq!(source.frames.len(), 20);
        assert!(source.info.can_reconstruct, "{:?}", source.info.warnings);
        let rows = read_frames(&dir.path().join("slice003.dcm")).unwrap();
        let hints = &rows[0].2.phase_hints;
        assert_eq!(hints.acquisition_number, Some(4));
        assert_eq!(hints.acquisition_time, "101103");
        assert_eq!(hints.trigger_time, None);
    }

    #[test]
    fn trigger_times_part_repeated_positions_in_trigger_order() {
        let triggers = ["800", "0", "400"];
        let dir = write_slices(multiphase(3, 20, |obj, phase| {
            obj.put(ds(Tag(0x0018, 0x1060), triggers[phase]));
        }));
        let imported = import_dir(&dir);
        let sources = phase_order(&imported);
        assert_eq!(
            labels(&sources),
            ["Phase 1 · 0 ms", "Phase 2 · 400 ms", "Phase 3 · 800 ms"]
        );
        for (rank, (source, written)) in sources.iter().zip([1, 2, 0]).enumerate() {
            assert_eq!(phase(source).kind, "triggerTime");
            assert_eq!(phase(source).value, triggers[written]);
            assert_eq!(phase(source).order, rank as f64 + 1.);
            assert_eq!(written_phases(source), BTreeSet::from([written]));
            assert_eq!(source.frames.len(), 20);
            assert_eq!(source.info.uid, "1.2.3.4");
            assert!(source.info.can_reconstruct, "{:?}", source.info.warnings);
        }
        assert_eq!(
            sources
                .iter()
                .map(|s| &s.info.id)
                .collect::<BTreeSet<_>>()
                .len(),
            3
        );
        let rows = read_frames(&dir.path().join("slice000.dcm")).unwrap();
        assert_eq!(rows[0].2.phase_hints.trigger_time, Some(800.));
    }

    #[test]
    fn acquisition_numbers_part_repeated_positions_when_trigger_times_do_not() {
        let numbers = ["7", "3", "5"];
        let dir = write_slices(multiphase(3, 20, |obj, phase| {
            obj.put_str(Tag(0x0020, 0x0012), VR::IS, numbers[phase]);
            obj.put(ds(Tag(0x0018, 0x1060), "0"));
        }));
        let imported = import_dir(&dir);
        let sources = phase_order(&imported);
        assert_eq!(
            labels(&sources),
            ["Phase 1 · Acq 3", "Phase 2 · Acq 5", "Phase 3 · Acq 7"]
        );
        for (source, written) in sources.iter().zip([1, 2, 0]) {
            assert_eq!(phase(source).kind, "acquisitionNumber");
            assert_eq!(phase(source).value, numbers[written]);
            assert_eq!(written_phases(source), BTreeSet::from([written]));
            assert_eq!(source.frames.len(), 20);
            assert!(source.info.can_reconstruct, "{:?}", source.info.warnings);
        }
    }

    #[test]
    fn acquisition_times_part_repeated_positions_last() {
        let times = ["101530", "101000", "101245.5"];
        let dir = write_slices(multiphase(2, 6, |obj, phase| {
            obj.put_str(Tag(0x0008, 0x0032), VR::TM, times[phase]);
        }));
        let imported = import_dir(&dir);
        let sources = phase_order(&imported);
        assert_eq!(
            labels(&sources),
            ["Phase 1 · 10:10:00", "Phase 2 · 10:15:30"]
        );
        assert_eq!(phase(sources[0]).kind, "acquisitionTime");
        assert_eq!(written_phases(sources[0]), BTreeSet::from([1]));
        assert_eq!(written_phases(sources[1]), BTreeSet::from([0]));
        // Each phase reports its own acquisition, not the first phase's.
        let times: Vec<_> = sources
            .iter()
            .map(|s| s.info.acquisition.acquisition_time.as_str())
            .collect();
        assert_eq!(times, ["101000", "101530"]);
    }

    #[test]
    fn minute_precision_acquisition_date_times_stay_with_their_phase() {
        // Phases parted by acquisition number, and phases parted by the date-times
        // themselves: minute precision is a valid DT (PS3.5 6.2).
        for numbered in [true, false] {
            let dir = write_slices(multiphase(2, 3, |obj, phase| {
                if numbered {
                    obj.put_str(Tag(0x0020, 0x0012), VR::IS, (phase + 1).to_string());
                }
                obj.put_str(
                    Tag(0x0008, 0x002a),
                    VR::DT,
                    ["202611041010", "202611041015"][phase],
                );
            }));
            let imported = import_dir(&dir);
            let sources = phase_order(&imported);
            assert_eq!(
                phase(sources[0]).kind,
                if numbered {
                    "acquisitionNumber"
                } else {
                    "acquisitionTime"
                }
            );
            let times: Vec<_> = sources
                .iter()
                .map(|s| s.info.acquisition.acquisition_date_time.as_str())
                .collect();
            assert_eq!(
                times,
                ["202611041010", "202611041015"],
                "numbered: {numbered}"
            );
        }
    }

    #[test]
    fn date_times_order_at_any_precision_and_apply_their_offset() {
        let at = |value| dt_seconds(value).unwrap();
        assert!(at("2026") < at("202611") && at("202611") < at("20261104"));
        assert_eq!(at("202611041010") + 330., at("20261104101530"));
        assert_eq!(at("20261104101530.25"), at("20261104101530") + 0.25);
        assert_eq!(at("20261104101530+0100"), at("20261104091530"));
        assert_eq!(at("20261104101530-0030"), at("20261104104530"));
        for invalid in [
            "",
            "20261",
            "2026110410103",
            "20261304",
            "202611041010.5",
            "2026+01",
            "x2026",
        ] {
            assert!(dt_seconds(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn phases_parted_otherwise_start_at_their_earliest_acquisition() {
        // Acquisition numbers part the phases; within each, times run backwards through
        // the slices, so the earliest frame is not the first.
        let dir = write_slices(multiphase(2, 6, |obj, phase| {
            let slice = (obj
                .get(Tag(0x0020, 0x0013))
                .unwrap()
                .to_int::<u32>()
                .unwrap()
                - 1)
                / 2;
            obj.put_str(Tag(0x0020, 0x0012), VR::IS, (phase + 1).to_string());
            let time = format!("{}{:02}", ["1015", "1010"][phase], 50 - slice);
            obj.put_str(Tag(0x0008, 0x002a), VR::DT, format!("20261104{time}"));
        }));
        let imported = import_dir(&dir);
        let sources = phase_order(&imported);
        assert_eq!(phase(sources[0]).kind, "acquisitionNumber");
        let times: Vec<_> = sources
            .iter()
            .map(|s| {
                (
                    s.info.acquisition.acquisition_time.as_str(),
                    s.info.acquisition.acquisition_date_time.as_str(),
                )
            })
            .collect();
        assert_eq!(
            times,
            [("101545", "20261104101545"), ("101045", "20261104101045")]
        );
    }

    /// One Enhanced MR slab: two dimension ordinals at each of two positions, the
    /// ordinals indexing the given cardiac trigger delays. Returns each frame's delay.
    fn trigger_slab(
        path: &Path,
        instance: &str,
        organization: &str,
        positions: [u32; 2],
        delays: [f64; 2],
    ) -> Vec<f64> {
        const CONTENT: Tag = Tag(0x0020, 0x9111);
        const CARDIAC: Tag = Tag(0x0018, 0x9118);
        let mut obj = metadata_object(4);
        obj.put(DataElement::new(Tag(0x0008, 0x0018), VR::UI, instance));
        let mut item = dimension(Tag(0x0020, 0x9153), CARDIAC);
        item.put(DataElement::new(Tag(0x0020, 0x9164), VR::UI, organization));
        obj.put(sequence(Tag(0x0020, 0x9222), vec![item]));
        let mut frames = Vec::new();
        let groups = (0..2u32)
            .flat_map(|ordinal| positions.map(move |z| (ordinal, z)))
            .map(|(ordinal, z)| {
                frames.push(delays[ordinal as usize]);
                InMemDicomObject::from_element_iter([
                    sequence(
                        CONTENT,
                        vec![InMemDicomObject::from_element_iter([ul(
                            Tag(0x0020, 0x9157),
                            &[ordinal + 1],
                        )])],
                    ),
                    sequence(
                        CARDIAC,
                        vec![InMemDicomObject::from_element_iter([DataElement::new(
                            Tag(0x0020, 0x9153),
                            VR::FD,
                            PrimitiveValue::F64(vec![delays[ordinal as usize]].into()),
                        )])],
                    ),
                    sequence(
                        Tag(0x0020, 0x9113),
                        vec![InMemDicomObject::from_element_iter([ds(
                            Tag(0x0020, 0x0032),
                            &format!("0\\0\\{}", z * 2),
                        )])],
                    ),
                ])
            })
            .collect();
        obj.put(sequence(Tag(0x5200, 0x9230), groups));
        write_metadata(obj, path);
        frames
    }

    #[test]
    fn dimension_ordinals_of_separate_instances_compare_only_within_one_organization() {
        let temp = crate::test_dir::tempdir().unwrap();
        // (organizations, slab 1 delays): ordinals that mean opposite delays in separate
        // organizations, or in one organization; and one organization used consistently.
        for (organizations, second, kind) in [
            (["2.25.71", "2.25.72"], [200., 100.], "triggerTime"),
            (["2.25.73", "2.25.73"], [200., 100.], "triggerTime"),
            (["2.25.74", "2.25.74"], [100., 200.], "dimensionIndex"),
        ] {
            let a = temp.path().join(format!("{}-a.dcm", organizations[0]));
            let b = temp.path().join(format!("{}-b.dcm", organizations[1]));
            let delays = [
                trigger_slab(&a, "2.25.81", organizations[0], [0, 1], [100., 200.]),
                trigger_slab(&b, "2.25.82", organizations[1], [2, 3], second),
            ];
            let imported = import(&[
                a.to_string_lossy().into_owned(),
                b.to_string_lossy().into_owned(),
            ])
            .unwrap();
            let sources = phase_order(&imported);
            assert_eq!(sources.len(), 2, "{organizations:?}");
            for (source, expected) in sources.iter().zip([100., 200.]) {
                assert_eq!(phase(source).kind, kind, "{organizations:?}");
                assert_eq!(source.frames.len(), 4);
                for frame in &source.frames {
                    let file = usize::from(frame.source.path.file_name() == b.file_name());
                    assert_eq!(
                        delays[file][frame.index as usize], expected,
                        "{organizations:?}"
                    );
                }
                assert!(source.info.can_reconstruct, "{:?}", source.info.warnings);
            }
        }
    }

    #[test]
    fn enhanced_dimension_index_values_part_phases_through_their_pointers() {
        const CONTENT: Tag = Tag(0x0020, 0x9111);
        const CARDIAC: Tag = Tag(0x0018, 0x9118);
        let temp = crate::test_dir::tempdir().unwrap();
        // The temporal index is the second of three dimensions, after the in-stack
        // position and before the stack. No frame carries TemporalPositionIndex
        // itself: only the pointers say which index value is the phase.
        let path = temp.path().join("temporal.dcm");
        let order = enhanced_phases(
            &path,
            3,
            4,
            vec![
                dimension(Tag(0x0020, 0x9057), CONTENT),
                dimension(Tag(0x0020, 0x9128), CONTENT),
                dimension(Tag(0x0020, 0x9056), CONTENT),
            ],
            |phase, position| {
                vec![sequence(
                    CONTENT,
                    vec![InMemDicomObject::from_element_iter([
                        ul(Tag(0x0020, 0x9157), &[position + 1, phase + 1, 1]),
                        ul(Tag(0x0020, 0x9057), &[position + 1]),
                        DataElement::new(Tag(0x0020, 0x9056), VR::SH, "1"),
                    ])],
                )]
            },
        );
        let rows = read_frames(&path).unwrap();
        for ((_, _, frame), &(phase, position)) in rows.iter().zip(&order) {
            let hints = &frame.phase_hints;
            assert_eq!(
                hints.dimensions.as_ref().map(|d| d.value.clone()),
                Some((phase + 1).to_string())
            );
            assert_eq!(hints.in_stack_position, Some(position + 1));
            assert_eq!(hints.stack_id, "1");
            assert!(hints.explicit.is_none());
        }
        let imported = import(&[path.to_string_lossy().into_owned()]).unwrap();
        let sources = phase_order(&imported);
        assert_eq!(labels(&sources), ["Phase 1", "Phase 2", "Phase 3"]);
        for (index, source) in sources.iter().enumerate() {
            assert_eq!(phase(source).kind, "dimensionIndex");
            assert_eq!(phase(source).value, (index + 1).to_string());
            assert_eq!(source_frames(source), frames_of(&order, index as u32));
            assert!(source.info.can_reconstruct, "{:?}", source.info.warnings);
        }
        // A cardiac trigger delay dimension, between the stack and the in-stack
        // position, whose values live in another functional group.
        let path = temp.path().join("trigger.dcm");
        let order = enhanced_phases(
            &path,
            2,
            3,
            vec![
                dimension(Tag(0x0020, 0x9056), CONTENT),
                dimension(Tag(0x0020, 0x9153), CARDIAC),
                dimension(Tag(0x0020, 0x9057), CONTENT),
            ],
            |phase, position| {
                vec![
                    sequence(
                        CONTENT,
                        vec![InMemDicomObject::from_element_iter([ul(
                            Tag(0x0020, 0x9157),
                            &[1, phase + 1, position + 1],
                        )])],
                    ),
                    sequence(
                        CARDIAC,
                        vec![InMemDicomObject::from_element_iter([DataElement::new(
                            Tag(0x0020, 0x9153),
                            VR::FD,
                            PrimitiveValue::from([50f64, 350.][phase as usize]),
                        )])],
                    ),
                ]
            },
        );
        let imported = import(&[path.to_string_lossy().into_owned()]).unwrap();
        let sources = phase_order(&imported);
        assert_eq!(labels(&sources), ["Phase 1 · 50 ms", "Phase 2 · 350 ms"]);
        for (index, source) in sources.iter().enumerate() {
            assert_eq!(phase(source).kind, "dimensionIndex");
            assert_eq!(source_frames(source), frames_of(&order, index as u32));
        }
    }

    #[test]
    fn explicit_temporal_positions_stay_split_and_are_labelled_in_numeric_order() {
        let positions = ["10", "2", "1"];
        let dir = write_slices(multiphase(3, 5, |obj, phase| {
            obj.put_str(Tag(0x0020, 0x0100), VR::IS, positions[phase]);
        }));
        let imported = import_dir(&dir);
        let sources = phase_order(&imported);
        assert_eq!(labels(&sources), ["Phase 1", "Phase 2", "Phase 10"]);
        for (rank, (source, written)) in sources.iter().zip([2, 1, 0]).enumerate() {
            assert_eq!(phase(source).kind, "temporalPosition");
            assert_eq!(phase(source).value, positions[written]);
            assert_eq!(phase(source).order, rank as f64 + 1.);
            assert_eq!(written_phases(source), BTreeSet::from([written]));
            assert!(source.info.can_reconstruct, "{:?}", source.info.warnings);
        }
        let rows = read_frames(&dir.path().join("slice000.dcm")).unwrap();
        let explicit = rows[0].2.phase_hints.explicit.as_ref().unwrap();
        assert_eq!(explicit.value, "10");
        // Enhanced TemporalPositionIndex in each frame's content.
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("enhanced.dcm");
        let order = enhanced_phases(&path, 2, 3, Vec::new(), |phase, _| {
            vec![sequence(
                Tag(0x0020, 0x9111),
                vec![InMemDicomObject::from_element_iter([ul(
                    Tag(0x0020, 0x9128),
                    &[phase + 1],
                )])],
            )]
        });
        let imported = import(&[path.to_string_lossy().into_owned()]).unwrap();
        let sources = phase_order(&imported);
        assert_eq!(labels(&sources), ["Phase 1", "Phase 2"]);
        for (index, source) in sources.iter().enumerate() {
            assert_eq!(phase(source).kind, "temporalPosition");
            assert_eq!(source_frames(source), frames_of(&order, index as u32));
        }
        // One temporal position is not a multi-phase acquisition.
        let dir = write_slices(multiphase(1, 5, |obj, _| {
            obj.put_str(Tag(0x0020, 0x0100), VR::IS, "1");
        }));
        let imported = import_dir(&dir);
        assert_eq!(imported.sources.len(), 1);
        assert!(imported.sources[0].info.phase.is_none());
    }

    #[test]
    fn repeated_positions_without_consistent_coverage_stay_one_series_with_warning() {
        let trigger = |obj: &mut InMemDicomObject, phase: usize| {
            obj.put(ds(Tag(0x0018, 0x1060), ["0", "500"][phase]));
        };
        // The second phase misses the last position.
        let mut missing = multiphase(2, 10, trigger);
        missing.pop();
        // The second phase covers every position, one of them twice.
        let mut doubled = multiphase(2, 10, trigger);
        let mut extra = classic_slice(99, 6.);
        extra.put_str(Tag(0x0008, 0x0018), VR::UI, "1.2.3.4.5.1.99");
        trigger(&mut extra, 1);
        doubled.push(extra);
        for (slices, count) in [(missing, 19), (doubled, 21)] {
            let imported = import_dir(&write_slices(slices));
            assert_eq!(imported.sources.len(), 1);
            let source = &imported.sources[0];
            assert!(source.info.phase.is_none());
            assert_eq!(source.frames.len(), count);
            assert!(!source.info.can_reconstruct);
            assert!(
                source
                    .info
                    .warnings
                    .iter()
                    .any(|w| w.text.contains("Duplicate")),
                "{:?}",
                source.info.warnings
            );
        }
    }

    #[test]
    fn single_plane_time_series_is_not_split_into_single_images() {
        let dir = write_slices(
            (0..6)
                .map(|i| {
                    let mut obj = classic_slice(i + 1, 0.);
                    obj.put(ds(Tag(0x0018, 0x1060), &(i * 100).to_string()));
                    obj
                })
                .collect(),
        );
        let imported = import_dir(&dir);
        assert_eq!(imported.sources.len(), 1);
        assert!(imported.sources[0].info.phase.is_none());
        assert_eq!(imported.sources[0].frames.len(), 6);
    }

    #[test]
    fn diffusion_and_echo_series_stay_split_by_key_without_phases() {
        // b0, then b1000 along x and along y. Each kind also has its own acquisition
        // number and trigger time; those must not turn the kinds into phases.
        let dir = write_slices(multiphase(3, 5, |obj, kind| {
            obj.put(DataElement::new(
                Tag(0x0018, 0x9087),
                VR::FD,
                PrimitiveValue::from([0f64, 1000., 1000.][kind]),
            ));
            if kind > 0 {
                let mut direction = vec![0f64; 3];
                direction[kind - 1] = 1.;
                obj.put(DataElement::new(
                    Tag(0x0018, 0x9089),
                    VR::FD,
                    PrimitiveValue::F64(direction.into()),
                ));
            }
            obj.put_str(Tag(0x0020, 0x0012), VR::IS, (kind + 1).to_string());
            obj.put(ds(Tag(0x0018, 0x1060), &(kind * 100).to_string()));
        }));
        let imported = import_dir(&dir);
        assert_eq!(imported.sources.len(), 3);
        let mut kinds = BTreeSet::new();
        for source in &imported.sources {
            assert!(source.info.phase.is_none());
            assert_eq!(source.frames.len(), 5);
            assert!(source.info.can_reconstruct, "{:?}", source.info.warnings);
            let written = written_phases(source);
            assert_eq!(written.len(), 1);
            let kind = *written.first().unwrap();
            assert_eq!(
                source.info.diffusion_b_value,
                Some(if kind == 0 { 0. } else { 1000. })
            );
            kinds.insert(kind);
        }
        assert_eq!(kinds, BTreeSet::from([0, 1, 2]));
        let dir = write_slices(multiphase(2, 5, |obj, echo| {
            obj.put_str(Tag(0x0018, 0x0086), VR::IS, (echo + 1).to_string());
            obj.put(ds(Tag(0x0018, 0x0081), ["10", "20"][echo]));
            obj.put_str(Tag(0x0020, 0x0012), VR::IS, (echo + 1).to_string());
        }));
        let imported = import_dir(&dir);
        assert_eq!(imported.sources.len(), 2);
        for source in &imported.sources {
            assert!(source.info.phase.is_none());
            assert_eq!(source.frames.len(), 5);
            assert!(source.info.can_reconstruct, "{:?}", source.info.warnings);
            let echo = *written_phases(source).first().unwrap();
            assert_eq!(source.info.echo_time, Some([10., 20.][echo]));
        }
    }

    fn scalar_image(modality: &str, columns: u16, rows: u16, pixels: Vec<u16>) -> InMemDicomObject {
        assert_eq!(pixels.len(), usize::from(columns) * usize::from(rows));
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.1.2"),
            DataElement::new(Tag(0x0008, 0x0018), VR::UI, "2.25.71"),
            DataElement::new(Tag(0x0008, 0x0060), VR::CS, modality),
            DataElement::new(Tag(0x0020, 0x000d), VR::UI, "2.25.72"),
            DataElement::new(Tag(0x0020, 0x000e), VR::UI, "2.25.73"),
            DataElement::new(Tag(0x0028, 0x0004), VR::CS, "MONOCHROME2"),
        ]);
        for (tag, value) in [
            (Tag(0x0028, 0x0010), rows),
            (Tag(0x0028, 0x0011), columns),
            (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), 16),
            (Tag(0x0028, 0x0101), 16),
            (Tag(0x0028, 0x0102), 15),
            (Tag(0x0028, 0x0103), 0),
        ] {
            obj.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
        }
        obj.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OW,
            PrimitiveValue::U16(pixels.into()),
        ));
        obj
    }

    /// A digitized mammogram in miniature: half background at 0, a burned-in label at
    /// the 16-bit maximum, and tissue between.
    fn mammogram_pixels() -> Vec<u16> {
        let mut pixels = vec![0u16; 480];
        pixels.extend((0..500).map(|i| 1000 + 100 * i as u16));
        pixels.extend([u16::MAX; 20]);
        pixels
    }

    /// The imported series, and the folder its file stays in while it is decoded.
    fn import_object(obj: InMemDicomObject) -> (Arc<SourceSeries>, crate::test_dir::TempDir) {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("image.dcm");
        write_metadata(obj, &path);
        let mut imported = import(&[path.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(imported.sources.len(), 1);
        (imported.sources.remove(0), dir)
    }

    #[test]
    fn images_without_a_window_get_one_from_their_pixels_without_background_or_labels() {
        let (source, _dir) = import_object(scalar_image("MG", 100, 10, mammogram_pixels()));
        assert!(source.info.window_from_pixels);
        assert_eq!(source.info.frame_metadata[0].window_center, None);
        // The 1st and 99th percentiles of the tissue ramp alone: 1500 and 50400.
        assert_eq!(
            (source.info.window_center, source.info.window_width),
            (25950., 48900.)
        );
        let json = serde_json::to_value(&source.info).unwrap();
        assert_eq!(json["windowFromPixels"], true);
    }

    #[test]
    fn stored_windows_voi_luts_and_calibrated_defaults_are_kept() {
        let mut stored = scalar_image("MG", 100, 10, mammogram_pixels());
        stored.put(ds(Tag(0x0028, 0x1050), "2000"));
        stored.put(ds(Tag(0x0028, 0x1051), "4000"));
        let (source, _dir) = import_object(stored);
        assert!(!source.info.window_from_pixels);
        assert_eq!(
            (source.info.window_center, source.info.window_width),
            (2000., 4000.)
        );
        assert!(
            serde_json::to_value(&source.info)
                .unwrap()
                .get("windowFromPixels")
                .is_none()
        );

        let mut voi = scalar_image("MG", 100, 10, mammogram_pixels());
        let mut lut = InMemDicomObject::new_empty();
        lut.put(DataElement::new(
            Tag(0x0028, 0x3002),
            VR::US,
            PrimitiveValue::U16(vec![2, 0, 16].into()),
        ));
        lut.put(DataElement::new(
            Tag(0x0028, 0x3006),
            VR::US,
            PrimitiveValue::U16(vec![0, 65535].into()),
        ));
        voi.put(sequence(Tag(0x0028, 0x3010), vec![lut]));
        let (source, _dir) = import_object(voi);
        assert!(!source.info.window_from_pixels);
        // The file's VOI LUT is shown; manual changes start from the window equal to it, a step at 1.
        assert_eq!(source.info.frame_metadata[0].voi_lut, Some(0));
        assert_eq!(
            source.info.voi_luts,
            [crate::model::VoiLut {
                first: 0,
                bits: 16,
                data: vec![0, 65535],
                explanation: String::new()
            }]
        );
        assert_eq!(
            (source.info.window_center, source.info.window_width),
            (1.5, 1.)
        );

        let (source, _dir) = import_object(scalar_image("CT", 100, 10, mammogram_pixels()));
        assert!(!source.info.window_from_pixels);
        assert_eq!(
            (source.info.window_center, source.info.window_width),
            (40., 400.)
        );
    }

    #[test]
    fn display_window_handles_flat_two_level_and_fractional_pixels() {
        assert_eq!(display_window([7., 7., 7.].into_iter()), Some((7., 1.)));
        assert_eq!(display_window([f64::NAN].into_iter()), None);
        // Nothing lies between the extremes, so they are kept.
        let two_levels = (0..100).map(|i| if i < 50 { 0. } else { 10. });
        assert_eq!(display_window(two_levels), Some((5., 10.)));
        // 0.0 to 100.0 in tenths: the 1st and 99th percentiles of 0.1..99.9 are 1.1 and
        // 98.9, to within one of the 65536 bins across the range.
        let fractional = (0..=1000).map(|i| f64::from(i) / 10.);
        let (center, width) = display_window(fractional).unwrap();
        assert!(
            (center - 50.).abs() < 0.01 && (width - 97.8).abs() < 0.01,
            "{center} {width}"
        );
        // The viewer draws no window narrower than one unit.
        assert_eq!(
            display_window((0..=10).map(|i| f64::from(i) / 100.))
                .unwrap()
                .1,
            1.
        );
    }

    fn pack_bits(masks: &[[u8; 9]]) -> Vec<u8> {
        let bits: Vec<u8> = masks.iter().flatten().copied().collect();
        let mut bytes = vec![0u8; bits.len().div_ceil(8).next_multiple_of(2)];
        for (index, bit) in bits.iter().enumerate() {
            bytes[index / 8] |= bit << (index % 8);
        }
        bytes
    }

    #[test]
    fn binary_segmentations_list_their_segments_and_decode_unaligned_masks() {
        // Two segments over the same two planes: 4 frames of 3x3, so frames start
        // mid-byte (bits 9, 18 and 27).
        let masks = [
            [1, 0, 0, 0, 1, 0, 0, 0, 1],
            [0, 1, 1, 1, 0, 0, 0, 1, 0],
            [1, 1, 1, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 1, 0, 1],
        ];
        let frames = [(1u16, 0u32), (1, 2), (2, 0), (2, 2)];
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0016), VR::UI, SEGMENTATION_STORAGE),
            DataElement::new(Tag(0x0008, 0x0018), VR::UI, "2.25.81"),
            DataElement::new(Tag(0x0008, 0x0060), VR::CS, "SEG"),
            DataElement::new(Tag(0x0008, 0x103e), VR::LO, "Nodule masks"),
            DataElement::new(Tag(0x0020, 0x000d), VR::UI, "2.25.82"),
            DataElement::new(Tag(0x0020, 0x000e), VR::UI, "2.25.83"),
            DataElement::new(Tag(0x0020, 0x0052), VR::UI, "2.25.84"),
            DataElement::new(Tag(0x0028, 0x0004), VR::CS, "MONOCHROME2"),
            DataElement::new(Tag(0x0028, 0x0008), VR::IS, "4"),
            DataElement::new(Tag(0x0062, 0x0001), VR::CS, "BINARY"),
        ]);
        for (tag, value) in [
            (Tag(0x0028, 0x0010), 3u16),
            (Tag(0x0028, 0x0011), 3),
            (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), 1),
            (Tag(0x0028, 0x0101), 1),
            (Tag(0x0028, 0x0102), 0),
            (Tag(0x0028, 0x0103), 0),
        ] {
            obj.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
        }
        let segment = |number: u16, label: &str| {
            let mut item = InMemDicomObject::from_element_iter([DataElement::new(
                Tag(0x0062, 0x0005),
                VR::LO,
                label,
            )]);
            item.put(DataElement::new(
                Tag(0x0062, 0x0004),
                VR::US,
                PrimitiveValue::from(number),
            ));
            item.put(DataElement::new(
                Tag(0x0062, 0x000d),
                VR::US,
                PrimitiveValue::U16(vec![65535, 32896, 32896].into()),
            ));
            item
        };
        obj.put(sequence(
            Tag(0x0062, 0x0002),
            vec![segment(1, "Nodule"), segment(2, "Vessel")],
        ));
        obj.put(sequence(
            Tag(0x0008, 0x1115),
            vec![InMemDicomObject::from_element_iter([DataElement::new(
                Tag(0x0020, 0x000e),
                VR::UI,
                "2.25.90",
            )])],
        ));
        obj.put(sequence(
            Tag(0x5200, 0x9229),
            vec![InMemDicomObject::from_element_iter([
                sequence(
                    Tag(0x0020, 0x9116),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0020, 0x0037),
                        "1\\0\\0\\0\\1\\0",
                    )])],
                ),
                sequence(
                    Tag(0x0028, 0x9110),
                    vec![InMemDicomObject::from_element_iter([
                        ds(Tag(0x0028, 0x0030), "0.5\\0.5"),
                        ds(Tag(0x0018, 0x0050), "2"),
                    ])],
                ),
            ])],
        ));
        let per_frame = frames
            .iter()
            .map(|&(number, z)| {
                let mut identification = InMemDicomObject::new_empty();
                identification.put(DataElement::new(
                    Tag(0x0062, 0x000b),
                    VR::US,
                    PrimitiveValue::from(number),
                ));
                InMemDicomObject::from_element_iter([
                    sequence(
                        Tag(0x0020, 0x9113),
                        vec![InMemDicomObject::from_element_iter([ds(
                            Tag(0x0020, 0x0032),
                            &format!("0\\0\\{z}"),
                        )])],
                    ),
                    sequence(Tag(0x0062, 0x000a), vec![identification]),
                    sequence(
                        Tag(0x0008, 0x9124),
                        vec![InMemDicomObject::from_element_iter([sequence(
                            Tag(0x0008, 0x2112),
                            vec![InMemDicomObject::from_element_iter([DataElement::new(
                                Tag(0x0008, 0x1155),
                                VR::UI,
                                format!("2.25.9{z}"),
                            )])],
                        )])],
                    ),
                ])
            })
            .collect();
        obj.put(sequence(Tag(0x5200, 0x9230), per_frame));
        obj.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OB,
            PrimitiveValue::U8(pack_bits(&masks).into()),
        ));
        let (source, _dir) = import_object(obj);
        let info = &source.info;
        assert_eq!(info.modality, "SEG");
        assert_eq!(
            info.dimensions,
            [3, 3, 4],
            "repeated planes stay one series"
        );
        assert!(!info.can_reconstruct);
        assert!(info.warnings.is_empty(), "{:?}", info.warnings);
        assert_eq!(info.pixel_type, "uint8");
        assert!(!info.window_from_pixels);
        assert_eq!((info.window_center, info.window_width), (0.5, 1.));
        let segmentation = info.segmentation.as_ref().unwrap();
        assert_eq!(segmentation.kind, "BINARY");
        assert_eq!(segmentation.referenced_series_uid, "2.25.90");
        assert_eq!(
            segmentation.referenced_series.as_deref().unwrap(),
            [(info.study_uid.clone(), "2.25.90".to_owned())]
        );
        assert_eq!(
            segmentation.referenced_instances.as_deref().unwrap(),
            [("2.25.90".to_owned(), None), ("2.25.92".to_owned(), None)]
        );
        assert_eq!(
            segmentation
                .segments
                .iter()
                .map(|s| (s.number, s.label.as_str(), s.color))
                .collect::<Vec<_>>(),
            [
                (1, "Nodule", Some([255, 255, 255])),
                (2, "Vessel", Some([255, 255, 255]))
            ]
        );
        assert!(source.frames.iter().all(|f| f.segmentation.is_none()));
        let volume = crate::decode::decode_volume(&source).unwrap();
        assert_eq!(volume.type_name(), "uint8");
        for (position, frame) in source.frames.iter().enumerate() {
            let (number, z) = frames[frame.index as usize];
            let metadata = &info.frame_metadata[position];
            assert_eq!(metadata.segment_number, Some(number));
            assert_eq!(metadata.referenced_sop_instance_uid, format!("2.25.9{z}"));
            let expected = masks[frame.index as usize].map(f64::from);
            let decoded = crate::decode::decode_frame(&source, position).unwrap();
            assert_eq!(
                (0..9).map(|i| decoded.value(i)).collect::<Vec<_>>(),
                expected
            );
            assert_eq!(
                (0..9)
                    .map(|i| volume.value(position * 9 + i))
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }

    #[test]
    fn cielab_white_black_and_a_dcmqi_colour_convert_to_srgb() {
        assert_eq!(cielab_to_srgb([65535, 32896, 32896]), [255, 255, 255]);
        assert_eq!(cielab_to_srgb([0, 32896, 32896]), [0, 0, 0]);
        // 3D Slicer's "tissue" green, as the autoPET segmentation recommends it.
        assert_eq!(cielab_to_srgb([43803, 26565, 37722]), [128, 174, 128]);
    }

    /// A SEG object with two segments on 2 mm planes, its frames given as (segment, z), and the
    /// pixel data element as given.
    fn segmentation_object(
        class: &str,
        kind: &str,
        size: u16,
        bits: u16,
        photometric: &str,
        frames: &[(Option<u16>, u32)],
        pixels: DataElement<InMemDicomObject>,
    ) -> InMemDicomObject {
        let mut obj = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0016), VR::UI, class),
            DataElement::new(Tag(0x0008, 0x0018), VR::UI, "2.25.181"),
            DataElement::new(Tag(0x0008, 0x0060), VR::CS, "SEG"),
            DataElement::new(Tag(0x0020, 0x000d), VR::UI, "2.25.182"),
            DataElement::new(Tag(0x0020, 0x000e), VR::UI, "2.25.183"),
            DataElement::new(Tag(0x0020, 0x0052), VR::UI, "2.25.184"),
            DataElement::new(Tag(0x0028, 0x0004), VR::CS, photometric),
            DataElement::new(Tag(0x0028, 0x0008), VR::IS, frames.len().to_string()),
            DataElement::new(Tag(0x0062, 0x0001), VR::CS, kind),
        ]);
        let stored = if bits == 1 { 1 } else { bits };
        for (tag, value) in [
            (Tag(0x0028, 0x0010), size),
            (Tag(0x0028, 0x0011), size),
            (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), bits),
            (Tag(0x0028, 0x0101), stored),
            (Tag(0x0028, 0x0102), stored - 1),
            (Tag(0x0028, 0x0103), 0),
        ] {
            obj.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
        }
        let segments = [(1u16, "Nodule"), (2, "Vessel")].map(|(number, label)| {
            let mut item = InMemDicomObject::from_element_iter([DataElement::new(
                Tag(0x0062, 0x0005),
                VR::LO,
                label,
            )]);
            item.put(DataElement::new(
                Tag(0x0062, 0x0004),
                VR::US,
                PrimitiveValue::from(number),
            ));
            item
        });
        obj.put(sequence(Tag(0x0062, 0x0002), segments.to_vec()));
        obj.put(sequence(
            Tag(0x5200, 0x9229),
            vec![InMemDicomObject::from_element_iter([
                sequence(
                    Tag(0x0020, 0x9116),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0020, 0x0037),
                        "1\\0\\0\\0\\1\\0",
                    )])],
                ),
                sequence(
                    Tag(0x0028, 0x9110),
                    vec![InMemDicomObject::from_element_iter([
                        ds(Tag(0x0028, 0x0030), "0.5\\0.5"),
                        ds(Tag(0x0018, 0x0050), "2"),
                    ])],
                ),
            ])],
        ));
        let per_frame = frames
            .iter()
            .map(|&(segment, z)| {
                let mut group = InMemDicomObject::from_element_iter([sequence(
                    Tag(0x0020, 0x9113),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0020, 0x0032),
                        &format!("0\\0\\{z}"),
                    )])],
                )]);
                if let Some(number) = segment {
                    let mut identification = InMemDicomObject::new_empty();
                    identification.put(DataElement::new(
                        Tag(0x0062, 0x000b),
                        VR::US,
                        PrimitiveValue::from(number),
                    ));
                    group.put(sequence(Tag(0x0062, 0x000a), vec![identification]));
                }
                group
            })
            .collect();
        obj.put(sequence(Tag(0x5200, 0x9230), per_frame));
        obj.put(pixels);
        obj
    }

    fn write_with_syntax(obj: InMemDicomObject, path: &Path, syntax: &str) {
        let class = text(&obj, Tag(0x0008, 0x0016));
        obj.with_meta(
            dicom_object::FileMetaTableBuilder::new()
                .media_storage_sop_class_uid(class)
                .media_storage_sop_instance_uid("2.25.181")
                .transfer_syntax(syntax),
        )
        .unwrap()
        .write_to_file(path)
        .unwrap();
    }

    fn encapsulated(fragments: Vec<Vec<u8>>) -> DataElement<InMemDicomObject> {
        DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OB,
            dicom_core::value::Value::PixelSequence(dicom_core::value::PixelFragmentSequence::new(
                Vec::<u32>::new(),
                fragments,
            )),
        )
    }

    /// Decoded values of every frame, keyed by the frame's index in its file.
    fn decoded_frames(source: &SourceSeries) -> BTreeMap<u32, Vec<f64>> {
        source
            .frames
            .iter()
            .enumerate()
            .map(|(position, frame)| {
                let pixels = crate::decode::decode_frame(source, position).unwrap();
                (
                    frame.index,
                    (0..pixels.len()).map(|i| pixels.value(i)).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn rle_and_jpeg2000_binary_segmentations_decode_like_native_masks() {
        // RLE (CP-2301): each 1-bit pixel code padded to a byte (PS3.5 G.2), one segment, rows as literal runs.
        let masks: [[u8; 9]; 2] = [[1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 1, 1, 0, 0, 0, 1, 0]];
        let fragments = masks
            .iter()
            .map(|mask| {
                let mut fragment = [1u32, 64]
                    .iter()
                    .chain([0u32; 14].iter())
                    .flat_map(|word| word.to_le_bytes())
                    .collect::<Vec<u8>>();
                for row in mask.chunks(3) {
                    fragment.push(2);
                    fragment.extend_from_slice(row);
                }
                fragment
            })
            .collect();
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("rle.dcm");
        let frames = [(Some(1), 0), (Some(1), 2)];
        write_with_syntax(
            segmentation_object(
                SEGMENTATION_STORAGE,
                "BINARY",
                3,
                1,
                "MONOCHROME2",
                &frames,
                encapsulated(fragments),
            ),
            &path,
            "1.2.840.10008.1.2.5",
        );
        let imported = import(&[path.to_string_lossy().into_owned()]).unwrap();
        let source = &imported.sources[0];
        assert_eq!(source.info.pixel_type, "uint8");
        assert_eq!(
            decoded_frames(source),
            BTreeMap::from([
                (0, masks[0].map(f64::from).to_vec()),
                (1, masks[1].map(f64::from).to_vec())
            ])
        );
        assert_eq!(
            (0..18)
                .map(|i| crate::decode::decode_volume(source).unwrap().value(i))
                .collect::<Vec<_>>(),
            masks
                .iter()
                .flatten()
                .map(|v| f64::from(*v))
                .collect::<Vec<_>>()
        );

        // JPEG 2000 lossless (CP-2301), 32x32 codestreams of precision 1 made by OpenJPEG.
        let hex = |text: &str| {
            (0..text.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
                .collect::<Vec<u8>>()
        };
        let fragments = ["ff4fff510029000000000020000000200000000000000000000000200000002000000000000000000001000101ff52000c00000001000504040001ff5c00134008101018101018101018101018101018ff640025000143726561746564206279204f70656e4a5045472076657273696f6e20322e352e32ff90000a00000000003a0001ff9380c86433a08007070380dd0a453a1014bf150f155fc8e4511010e85f0fed0f05c9245110145f0e6714e71581ffd9", "ff4fff510029000000000020000000200000000000000000000000200000002000000000000000000001000101ff52000c00000001000504040001ff5c00134008101018101018101018101018101018ff640025000143726561746564206279204f70656e4a5045472076657273696f6e20322e352e32ff90000a00000000001e0001ff93d08007808080a4402dcba48085bf44b5ffd9"]
            .map(|code| {
                let mut bytes = hex(code);
                if bytes.len() % 2 == 1 {
                    bytes.push(0);
                }
                bytes
            })
            .to_vec();
        let path = dir.path().join("j2k.dcm");
        write_with_syntax(
            segmentation_object(
                SEGMENTATION_STORAGE,
                "BINARY",
                32,
                1,
                "MONOCHROME2",
                &frames,
                encapsulated(fragments),
            ),
            &path,
            "1.2.840.10008.1.2.4.90",
        );
        let imported = import(&[path.to_string_lossy().into_owned()]).unwrap();
        let set = |values: &Vec<f64>| {
            values
                .iter()
                .enumerate()
                .filter(|(_, v)| **v == 1.)
                .map(|(i, _)| (i / 32, i % 32))
                .collect::<Vec<_>>()
        };
        let decoded = decoded_frames(&imported.sources[0]);
        assert!(decoded.values().flatten().all(|v| *v == 0. || *v == 1.));
        let mut first = vec![(1, 1)];
        first.extend((2..5).flat_map(|row| (3..6).map(move |column| (row, column))));
        assert_eq!(set(&decoded[&0]), first);
        let mut second: Vec<_> = (10..12)
            .flat_map(|row| (20..25).map(move |column| (row, column)))
            .collect();
        second.push((31, 0));
        assert_eq!(set(&decoded[&1]), second);
    }

    #[test]
    fn label_map_segmentations_keep_segment_numbers_even_with_a_palette() {
        let labels: [[u8; 9]; 2] = [[1, 1, 0, 2, 2, 0, 0, 0, 0], [0, 0, 0, 0, 2, 0, 0, 0, 1]];
        for photometric in ["MONOCHROME2", "PALETTE COLOR"] {
            let pixels = DataElement::new(
                Tag(0x7fe0, 0x0010),
                VR::OB,
                PrimitiveValue::U8(labels.iter().flatten().copied().collect::<Vec<_>>().into()),
            );
            let mut obj = segmentation_object(
                LABEL_MAP_SEGMENTATION_STORAGE,
                "LABELMAP",
                3,
                8,
                photometric,
                &[(None, 0), (None, 2)],
                pixels,
            );
            if photometric == "PALETTE COLOR" {
                for (descriptor, data, level) in [
                    (0x1101, 0x1201, [0u16, 65535, 0]),
                    (0x1102, 0x1202, [0, 0, 0]),
                    (0x1103, 0x1203, [0, 0, 65535]),
                ] {
                    obj.put(DataElement::new(
                        Tag(0x0028, descriptor),
                        VR::US,
                        PrimitiveValue::U16(vec![3, 0, 16].into()),
                    ));
                    obj.put(DataElement::new(
                        Tag(0x0028, data),
                        VR::OW,
                        PrimitiveValue::U16(level.to_vec().into()),
                    ));
                }
            }
            let (source, _dir) = import_object(obj);
            assert_eq!(source.info.components, 1, "{photometric}");
            assert_eq!(source.info.pixel_type, "uint8");
            assert_eq!(source.info.segmentation.as_ref().unwrap().kind, "LABELMAP");
            assert!(
                source
                    .info
                    .frame_metadata
                    .iter()
                    .all(|frame| frame.segment_number.is_none())
            );
            assert_eq!(
                decoded_frames(&source),
                BTreeMap::from([
                    (0, labels[0].map(f64::from).to_vec()),
                    (1, labels[1].map(f64::from).to_vec())
                ]),
                "{photometric}"
            );
        }
    }

    fn voi_item(
        descriptor: [u16; 3],
        vr: VR,
        data: PrimitiveValue,
        explanation: &str,
    ) -> InMemDicomObject {
        let mut item = InMemDicomObject::from_element_iter([DataElement::new(
            Tag(0x0028, 0x3003),
            VR::LO,
            explanation,
        )]);
        let first = if vr == VR::SS {
            PrimitiveValue::I16(descriptor.map(|v| v as i16).to_vec().into())
        } else {
            PrimitiveValue::U16(descriptor.to_vec().into())
        };
        item.put(DataElement::new(Tag(0x0028, 0x3002), vr, first));
        item.put(DataElement::new(Tag(0x0028, 0x3006), VR::OW, data));
        item
    }

    #[test]
    fn frame_voi_luts_are_read_once_each_and_a_window_takes_precedence() {
        // Three frames: two share a signed 8-bit table packed two entries per word, the third
        // carries its own table and the last also a window, which wins.
        let mut obj = metadata_object(3);
        obj.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OW,
            PrimitiveValue::U16(vec![1000; 12].into()),
        ));
        let shared = voi_item(
            [4, (-2i16) as u16, 8],
            VR::SS,
            PrimitiveValue::U16(vec![0x4000, 0xff80].into()),
            "SOFT",
        );
        let own = voi_item(
            [2, 100, 16],
            VR::US,
            PrimitiveValue::U16(vec![0, 4095].into()),
            "",
        );
        let group = |z: &str, voi: Option<&InMemDicomObject>, window: bool| {
            let mut group = InMemDicomObject::from_element_iter([sequence(
                Tag(0x0020, 0x9113),
                vec![InMemDicomObject::from_element_iter([ds(
                    Tag(0x0020, 0x0032),
                    z,
                )])],
            )]);
            let mut frame_voi = InMemDicomObject::new_empty();
            if let Some(voi) = voi {
                frame_voi.put(sequence(Tag(0x0028, 0x3010), vec![voi.clone()]));
            }
            if window {
                frame_voi.put(ds(Tag(0x0028, 0x1050), "40"));
                frame_voi.put(ds(Tag(0x0028, 0x1051), "80"));
            }
            group.put(sequence(Tag(0x0028, 0x9132), vec![frame_voi]));
            group
        };
        obj.put(sequence(
            Tag(0x5200, 0x9230),
            vec![
                group("0\\0\\0", Some(&shared), false),
                group("0\\0\\2", Some(&shared), false),
                group("0\\0\\4", Some(&own), true),
            ],
        ));
        let (source, _dir) = import_object(obj);
        let info = &source.info;
        assert_eq!(info.voi_luts.len(), 1);
        assert_eq!(
            info.voi_luts[0],
            crate::model::VoiLut {
                first: -2,
                bits: 8,
                data: vec![0, 64, 128, 255],
                explanation: "SOFT".into()
            }
        );
        assert_eq!(
            info.frame_metadata
                .iter()
                .map(|frame| frame.voi_lut)
                .collect::<Vec<_>>(),
            [Some(0), Some(0), None]
        );
        assert_eq!(info.frame_metadata[2].window_center, Some(40.));
        assert!(!info.window_from_pixels);
    }

    #[test]
    fn voi_window_spans_where_the_table_rises() {
        let ramp = |data: Vec<u16>| crate::model::VoiLut {
            first: 1000,
            bits: 12,
            data,
            explanation: String::new(),
        };
        // Flat at both ends, rising over inputs 1010..1019.
        let mut data = vec![0u16; 10];
        data.extend((1..=10).map(|n| n * 400));
        data.extend([4000; 10]);
        assert_eq!(crate::modality_lut::voi_window(&ramp(data)), (1015., 10.));
        // A falling or flat table falls back to its whole input range.
        assert_eq!(
            crate::modality_lut::voi_window(&ramp(vec![4095, 0])),
            (1001., 2.)
        );
        assert_eq!(
            crate::modality_lut::voi_window(&ramp(vec![7; 4])),
            (1002., 4.)
        );
        // A step is a one-unit window at the step.
        assert_eq!(
            crate::modality_lut::voi_window(&ramp(vec![0, 0, 4095, 4095])),
            (1002.5, 1.)
        );
    }

    #[test]
    fn fractional_window_widths_follow_the_stored_curve() {
        for (curve, width, expected) in [
            ("LINEAR_EXACT", "0.125", Some(0.125)),
            ("SIGMOID", "0.005", Some(0.005)),
            ("LINEAR", "0.125", None),
            ("UNKNOWN", "0.125", None),
            ("SIGMOID", "0", None),
            ("LINEAR_EXACT", "-0.25", None),
        ] {
            let mut obj = scalar_image("MG", 100, 10, mammogram_pixels());
            obj.put(ds(Tag(0x0028, 0x1050), "0.5"));
            obj.put(ds(Tag(0x0028, 0x1051), width));
            obj.put_str(Tag(0x0028, 0x1056), VR::CS, curve);
            let (source, _dir) = import_object(obj);
            let frame = &source.info.frame_metadata[0];
            assert_eq!(frame.window_width, expected);
            assert_eq!(frame.voi_function, expected.map(|_| curve));
        }
    }

    #[test]
    fn a_stored_window_keeps_its_voi_lut_function() {
        // Top level: SIGMOID applies to the stored window.
        let mut obj = scalar_image("MG", 100, 10, mammogram_pixels());
        obj.put(ds(Tag(0x0028, 0x1050), "20000"));
        obj.put(ds(Tag(0x0028, 0x1051), "30000"));
        obj.put_str(Tag(0x0028, 0x1056), VR::CS, "SIGMOID");
        let (source, _dir) = import_object(obj);
        assert_eq!(source.info.frame_metadata[0].voi_function, Some("SIGMOID"));
        assert_eq!(
            serde_json::to_value(&source.info.frame_metadata[0]).unwrap()["voiFunction"],
            "SIGMOID"
        );
        // Per frame in Frame VOI LUT functional groups: LINEAR_EXACT on one frame, LINEAR on the other,
        // and none without a window.
        let mut obj = metadata_object(3);
        let group = |z: &str, function: &str, window: bool| {
            let mut frame_voi = InMemDicomObject::new_empty();
            if window {
                frame_voi.put(ds(Tag(0x0028, 0x1050), "40"));
                frame_voi.put(ds(Tag(0x0028, 0x1051), "80"));
            }
            frame_voi.put_str(Tag(0x0028, 0x1056), VR::CS, function);
            InMemDicomObject::from_element_iter([
                sequence(
                    Tag(0x0020, 0x9113),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0020, 0x0032),
                        z,
                    )])],
                ),
                sequence(Tag(0x0028, 0x9132), vec![frame_voi]),
            ])
        };
        obj.put(sequence(
            Tag(0x5200, 0x9230),
            vec![
                group("0\\0\\0", "LINEAR_EXACT", true),
                group("0\\0\\2", "LINEAR", true),
                group("0\\0\\4", "SIGMOID", false),
            ],
        ));
        let (source, _dir) = import_object(obj);
        assert_eq!(
            source
                .info
                .frame_metadata
                .iter()
                .map(|frame| frame.voi_function)
                .collect::<Vec<_>>(),
            [Some("LINEAR_EXACT"), None, None]
        );
    }

    fn facing(instance: usize, orientation: &str, z: f64) -> InMemDicomObject {
        let mut obj = classic_slice(instance, z);
        obj.put(ds(Tag(0x0020, 0x0037), orientation));
        obj
    }
    const AXIAL: &str = r"1\0\0\0\1\0";
    const CORONAL: &str = r"1\0\0\0\0\-1";
    const SAGITTAL: &str = r"0\1\0\0\0\-1";

    #[test]
    fn a_localizer_is_not_said_to_lack_a_stack_to_reconstruct_and_other_images_still_are() {
        // Synthetic CT images of one series each, with this Image Type: the codes of their series' notes.
        let notes = |slices: Vec<InMemDicomObject>, image_type: &str| {
            let slices = slices
                .into_iter()
                .map(|mut slice| {
                    slice.put_str(Tag(0x0008, 0x0060), VR::CS, "CT");
                    slice.put_str(Tag(0x0008, 0x0008), VR::CS, image_type);
                    slice
                })
                .collect();
            let imported = import_dir(&write_slices(slices));
            assert_eq!(imported.sources.len(), 1);
            (imported.sources[0].info.warnings.iter())
                .map(|note| note.code)
                .collect::<Vec<_>>()
        };
        const LOCALIZER: &str = r"ORIGINAL\PRIMARY\LOCALIZER";
        const AXIAL_TYPE: &str = r"ORIGINAL\PRIMARY\AXIAL";
        // One localizer, and a localizer facing three ways: nothing said of a volume it was never to make.
        assert!(!notes(vec![facing(1, CORONAL, 0.)], LOCALIZER).contains(&"geometry.singleImage"));
        let three = vec![
            facing(1, SAGITTAL, 0.),
            facing(2, CORONAL, 0.),
            facing(3, AXIAL, 0.),
        ];
        assert!(!notes(three, LOCALIZER).contains(&"geometry.mixedOrientation"));
        // An image of another kind is still told.
        assert!(notes(vec![facing(1, AXIAL, 0.)], AXIAL_TYPE).contains(&"geometry.singleImage"));
        let three = vec![
            facing(1, SAGITTAL, 0.),
            facing(2, CORONAL, 0.),
            facing(3, AXIAL, 0.),
        ];
        assert!(notes(three, AXIAL_TYPE).contains(&"geometry.mixedOrientation"));
        // A localizer with no position is still said to have none.
        let mut placeless = facing(1, CORONAL, 0.);
        placeless.remove_element(Tag(0x0020, 0x0032));
        assert!(notes(vec![placeless], LOCALIZER).contains(&"geometry.missingPosition"));
    }

    #[test]
    fn parallel_ct_localizer_projections_do_not_make_a_reconstructable_stack() {
        let scan = |kind: &str| {
            let slices = (1..=3)
                .map(|index| {
                    let mut image = facing(index, AXIAL, index as f64 * 2.0);
                    image.put_str(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.2");
                    image.put_str(Tag(0x0008, 0x0060), VR::CS, "CT");
                    image.put_str(Tag(0x0008, 0x0008), VR::CS, kind);
                    image
                })
                .collect();
            let imported = import_dir(&write_slices(slices));
            assert_eq!(imported.sources.len(), 1);
            imported.sources[0].info.clone()
        };
        let scout = scan(r"ORIGINAL\PRIMARY\LOCALIZER");
        assert_eq!(scout.dimensions[2], 3);
        assert!(scout.spacing_known && scout.orientation_known);
        assert!(!scout.can_reconstruct);
        assert!(scan(r"ORIGINAL\PRIMARY\AXIAL").can_reconstruct);
    }

    #[test]
    fn a_localizer_facing_three_ways_stays_one_series_in_the_scanners_order() {
        let temp = write_slices(vec![
            facing(1, SAGITTAL, 0.),
            facing(2, CORONAL, 0.),
            facing(3, AXIAL, 0.),
        ]);
        let imported = import_dir(&temp);
        assert_eq!(imported.sources.len(), 1);
        let numbers: Vec<_> = imported.sources[0]
            .frames
            .iter()
            .map(|f| f.instance_number)
            .collect();
        assert_eq!(numbers, [1, 2, 3]);
    }

    #[test]
    fn a_stack_with_a_few_stray_images_facing_other_ways_stays_one_series() {
        let mut slices: Vec<_> = (1..=6).map(|n| facing(n, AXIAL, n as f64)).collect();
        slices.push(facing(7, CORONAL, 0.));
        slices.push(facing(8, SAGITTAL, 0.));
        let imported = import_dir(&write_slices(slices));
        assert_eq!(imported.sources.len(), 1);
        assert_eq!(imported.sources[0].frames.len(), 8);
    }

    #[test]
    fn a_stack_with_one_reference_image_facing_another_way_is_the_stack_and_the_image() {
        let mut slices = vec![facing(1, SAGITTAL, 0.)];
        slices.extend((2..=7).map(|n| facing(n, AXIAL, n as f64)));
        let imported = import_dir(&write_slices(slices));
        let mut sizes: Vec<_> = imported.sources.iter().map(|s| s.frames.len()).collect();
        sizes.sort();
        assert_eq!(sizes, [1, 6]);
        let stack = imported
            .sources
            .iter()
            .find(|s| s.frames.len() == 6)
            .unwrap();
        assert!(stack.info.can_reconstruct, "{:?}", stack.info.warnings);
        // Four images and one facing another way are no stack: they stay one series.
        let mut few = vec![facing(1, SAGITTAL, 0.)];
        few.extend((2..=5).map(|n| facing(n, AXIAL, n as f64)));
        assert_eq!(import_dir(&write_slices(few)).sources.len(), 1);
    }

    #[test]
    fn a_slice_whose_orientation_differs_only_in_its_rounding_stays_in_its_stack() {
        // 0.00006 in one component crosses a rounding step of the key that groups images, yet is one orientation
        // to the volume geometry: the slice is no reference image, and the stack is built with it.
        let mut slices: Vec<_> = (1..=5).map(|n| facing(n, AXIAL, n as f64)).collect();
        slices.push(facing(6, r"1\0.00006\0\0\1\0", 6.));
        let imported = import_dir(&write_slices(slices));
        assert_eq!(imported.sources.len(), 1);
        let stack = &imported.sources[0];
        assert_eq!(stack.frames.len(), 6);
        assert!(stack.info.can_reconstruct, "{:?}", stack.info.warnings);
    }

    #[test]
    fn an_image_of_no_known_orientation_is_not_taken_for_a_reference_image() {
        let mut slices: Vec<_> = (1..=5).map(|n| facing(n, AXIAL, n as f64)).collect();
        let mut unplaced = classic_slice(6, 6.);
        unplaced.remove_element(Tag(0x0020, 0x0037));
        slices.push(unplaced);
        let imported = import_dir(&write_slices(slices));
        assert_eq!(imported.sources.len(), 1);
        assert_eq!(imported.sources[0].frames.len(), 6);
    }

    #[test]
    fn a_series_of_three_stacks_facing_three_ways_is_three_series() {
        let mut slices = Vec::new();
        for (block, orientation) in [AXIAL, CORONAL, SAGITTAL].into_iter().enumerate() {
            for n in 0..5 {
                slices.push(facing(block * 5 + n + 1, orientation, n as f64));
            }
        }
        let imported = import_dir(&write_slices(slices));
        let mut sizes: Vec<_> = imported.sources.iter().map(|s| s.frames.len()).collect();
        sizes.sort();
        assert_eq!(sizes, [5, 5, 5]);
    }

    /// A grey picture as the tests' picture decoder reads it (pictures::testing), which this starts.
    fn picture(path: &Path, width: u32, height: u32) {
        crate::pictures::testing::serve();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let grey = vec![128; width as usize * height as usize * 3];
        fs::write(
            path,
            crate::pictures::testing::picture(crate::pictures::testing::PNG, width, height, &grey),
        )
        .unwrap();
    }
    fn image_series(imported: &Imported) -> Vec<(String, String, i32, Vec<String>)> {
        let mut series: Vec<_> = imported
            .sources
            .iter()
            .filter(|s| s.frames[0].ordinary_image)
            .map(|s| {
                (
                    s.info.patient_name.clone(),
                    s.info.description.clone(),
                    s.info.series_number,
                    s.frames
                        .iter()
                        .map(|f| {
                            f.source
                                .path
                                .file_name()
                                .unwrap()
                                .to_string_lossy()
                                .into_owned()
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        series.sort_by_key(|s| s.2);
        series
    }

    #[test]
    fn pictures_open_as_the_folders_patient_with_a_series_per_folder_in_natural_order() {
        let temp = crate::test_dir::tempdir().unwrap();
        let root = temp.path().join("Ahmet Yilmaz");
        for name in ["img10.png", "img2.png", "img1.png"] {
            picture(&root.join("Seri 10").join(name), 8, 8);
        }
        picture(&root.join("Seri 2").join("a.png"), 8, 8);
        picture(&root.join("Seri 2").join("b.png"), 16, 16);
        picture(&root.join("kapak.png"), 8, 8);
        let imported = import(&[root.to_string_lossy().into_owned()]).unwrap();
        let series = image_series(&imported);
        let named = |name: &str, number, files: &[&str]| {
            (
                "Ahmet Yilmaz".to_string(),
                name.to_string(),
                number,
                files.iter().map(|f| f.to_string()).collect::<Vec<_>>(),
            )
        };
        assert_eq!(
            series,
            [
                named("Ahmet Yilmaz", 1, &["kapak.png"]),
                named("Seri 2 (8×8)", 2, &["a.png"]),
                named("Seri 2 (16×16)", 3, &["b.png"]),
                named("Seri 10", 4, &["img1.png", "img2.png", "img10.png"]),
            ]
        );
        // Each says once that it is a picture; no geometry warnings repeat it.
        for source in &imported.sources {
            assert_eq!(
                source
                    .info
                    .warnings
                    .iter()
                    .map(|w| w.code)
                    .collect::<Vec<_>>(),
                ["series.ordinaryImage"]
            );
            assert_eq!(
                serde_json::to_value(&source.info.warnings[0]).unwrap()["params"]["format"],
                "PNG"
            );
        }
        // One study for the folder: the list shows one patient, not one per picture.
        let studies: HashSet<_> = imported
            .sources
            .iter()
            .map(|s| s.info.study_uid.clone())
            .collect();
        assert_eq!(studies.len(), 1);
        assert!(!studies.iter().next().unwrap().is_empty());
    }

    #[test]
    fn pictures_from_two_folders_are_two_patients_and_loose_files_belong_to_their_folder() {
        let temp = crate::test_dir::tempdir().unwrap();
        picture(&temp.path().join("Ayse").join("1.png"), 8, 8);
        picture(&temp.path().join("Mehmet").join("1.png"), 8, 8);
        let both = import(&[
            temp.path().join("Ayse").to_string_lossy().into_owned(),
            temp.path().join("Mehmet").to_string_lossy().into_owned(),
        ])
        .unwrap();
        let mut patients: Vec<_> = both
            .sources
            .iter()
            .map(|s| s.info.patient_name.clone())
            .collect();
        patients.sort();
        assert_eq!(patients, ["Ayse", "Mehmet"]);
        let loose = import(&[temp
            .path()
            .join("Ayse")
            .join("1.png")
            .to_string_lossy()
            .into_owned()])
        .unwrap();
        assert_eq!(image_series(&loose)[0].0, "Ayse");
        assert_eq!(image_series(&loose)[0].1, "Ayse");
    }

    #[test]
    fn pictures_beside_dicom_are_a_viewers_own_and_are_not_series() {
        let temp = crate::test_dir::tempdir().unwrap();
        fs::create_dir(temp.path().join("DICOM")).unwrap();
        write_metadata(
            classic_slice(1, 0.),
            &temp.path().join("DICOM").join("slice001.dcm"),
        );
        // A size no other test uses, to tell this icon apart among the pictures the tests' decoder has had.
        let icon = temp.path().join("viewer").join("icon.png");
        picture(&icon, 61, 67);
        let imported = import_dir(&temp);
        assert_eq!(imported.sources.len(), 1);
        assert!(!imported.sources[0].frames[0].ordinary_image);
        // Its size was never asked for: a DICOM import does not wait for the picture decoder.
        let bytes = fs::read(&icon).unwrap();
        assert!(
            !crate::pictures::testing::decoded()
                .lock()
                .unwrap()
                .contains(&bytes)
        );
    }

    #[test]
    fn a_zip_of_pictures_is_named_after_the_archive() {
        let temp = crate::test_dir::tempdir().unwrap();
        let file = temp.path().join("Zeynep Kaya.zip");
        let mut zip = zip::ZipWriter::new(File::create(&file).unwrap());
        crate::pictures::testing::serve();
        for name in ["Seri 1/2.png", "Seri 1/10.png"] {
            let bytes = crate::pictures::testing::picture(
                crate::pictures::testing::PNG,
                8,
                8,
                &[90; 8 * 8 * 3],
            );
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();
        let imported = import(&[file.to_string_lossy().into_owned()]).unwrap();
        let series = image_series(&imported);
        assert_eq!(series.len(), 1);
        assert_eq!(
            (series[0].0.as_str(), series[0].1.as_str()),
            ("Zeynep Kaya", "Seri 1")
        );
        assert_eq!(series[0].3, ["2.png", "10.png"]);
    }

    #[test]
    fn natural_order_compares_digit_runs_as_numbers() {
        let mut names = vec!["img10", "img2", "IMG1", "img02", "a", "img"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["a", "img", "IMG1", "img2", "img02", "img10"]);
    }

    #[test]
    fn enhanced_ct_frame_type_sequence_detects_localizer_and_series_keeps_voi_function() {
        // Three parallel Enhanced CT localizer frames via CTImageFrameTypeSequence (0018,9329):
        // must not become a reconstructable stack, and frame 0's VOI function propagates to Series.
        let mut obj = metadata_object(3);
        obj.put_str(Tag(0x0008, 0x0060), VR::CS, "CT");
        let per_frame = |z: &str, with_voi: bool| {
            let mut ct_frame_type = InMemDicomObject::new_empty();
            ct_frame_type.put_str(Tag(0x0008, 0x9007), VR::CS, "ORIGINAL\\PRIMARY\\LOCALIZER");
            let mut item = InMemDicomObject::from_element_iter([
                sequence(
                    Tag(0x0020, 0x9113),
                    vec![InMemDicomObject::from_element_iter([ds(
                        Tag(0x0020, 0x0032),
                        z,
                    )])],
                ),
                sequence(Tag(0x0018, 0x9329), vec![ct_frame_type]),
            ]);
            if with_voi {
                let mut frame_voi = InMemDicomObject::new_empty();
                frame_voi.put(ds(Tag(0x0028, 0x1050), "0.5"));
                frame_voi.put(ds(Tag(0x0028, 0x1051), "0.25"));
                frame_voi.put_str(Tag(0x0028, 0x1056), VR::CS, "LINEAR_EXACT");
                item.put(sequence(Tag(0x0028, 0x9132), vec![frame_voi]));
            }
            item
        };
        obj.put(sequence(
            Tag(0x5200, 0x9230),
            vec![
                per_frame("0\\0\\0", true),
                per_frame("0\\0\\2", false),
                per_frame("0\\0\\4", false),
            ],
        ));
        let (source, _dir) = import_object(obj);
        assert!(!source.info.can_reconstruct);
        assert_eq!(source.info.voi_function, Some("LINEAR_EXACT"));
        assert_eq!(source.info.window_width, 0.25);
        assert_eq!(
            serde_json::to_value(&source.info).unwrap()["voiFunction"],
            "LINEAR_EXACT"
        );
    }

    #[test]
    fn split_phases_clears_voi_function_when_phase_uses_pixel_window() {
        // Phase 0 stores a SIGMOID window; phase 1 stores no window and falls back to a pixel-derived window.
        // split_phases clones the Series struct from the base group, so phase 1 must clear voi_function.
        let slices = multiphase(2, 2, |obj, phase| {
            obj.put_str(Tag(0x0020, 0x0100), VR::IS, (phase + 1).to_string());
            if phase == 0 {
                obj.put(ds(Tag(0x0028, 0x1050), "100"));
                obj.put(ds(Tag(0x0028, 0x1051), "200"));
                obj.put_str(Tag(0x0028, 0x1056), VR::CS, "SIGMOID");
            } else {
                obj.put(DataElement::new(
                    Tag(0x7fe0, 0x0010),
                    VR::OW,
                    PrimitiveValue::U16(vec![100, 300, 500, 900].into()),
                ));
            }
        });
        let dir = write_slices(slices);
        let imported = import_dir(&dir);
        let ordered = phase_order(&imported);
        assert_eq!(ordered.len(), 2);
        assert_eq!(ordered[0].info.voi_function, Some("SIGMOID"));
        assert_eq!(ordered[0].info.window_center, 100.0);
        assert_eq!(ordered[0].info.window_width, 200.0);
        assert!(ordered[1].info.window_from_pixels);
        assert_eq!(ordered[1].info.voi_function, None);
    }
}
