//! DICOM exported as one ZIP per patient, smaller with nothing lost (VEAcom 1.2.1's "Sıkıştır (ZIP)").
//!
//! Images stored uncompressed are re-encoded as lossless JPEG-LS; with `smallest`, images held in another lossless
//! compression are too (never lossy ones). Every re-encoded file is decoded again and compared sample for sample with
//! what it came from: on any difference, an encoder error, or if it does not come out smaller, the file goes exactly
//! as it was. JPEG-LS rather than JPEG 2000: VEAcom 1 measured the two near equal in size and JPEG-LS several times
//! faster, and it is the lossless encoder this engine has.
//!
//! Nothing is written outside the archives: files are prepared in memory a batch at a time (re-encoded on every core)
//! and streamed into their patient's ZIP. A ZIP is named as VEAcom 1 named it ("SURNAME NAME - MR - 13.06.2022",
//! "ANONIM - ..." when anonymised, without the date when fully anonymised) and holds a folder per series.

use super::{ExportOptions, ExportResult, IdentityMap, SourceFile, patient_key, clean_instance, reported, value};
use anyhow::{Context, Result};
use dicom_core::Tag;
use dicom_encoding::TransferSyntaxIndex;
use dicom_object::{DefaultDicomObject, OpenFileOptions};
use dicom_pixeldata::{PixelDecoder, Transcode};
use dicom_transfer_syntax_registry::TransferSyntaxRegistry;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Cursor, ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, mpsc},
    time::{Duration, Instant},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const JPEG_LS_LOSSLESS: &str = "1.2.840.10008.1.2.4.80";
/// Uncompressed little-endian pixel data: re-encoded always.
const NATIVE: [&str; 2] = ["1.2.840.10008.1.2", "1.2.840.10008.1.2.1"];
/// Lossless compressions, re-encoded only for the smallest size: JPEG Lossless (process 14 and SV1), JPEG 2000
/// lossless, RLE.
const LOSSLESS: [&str; 4] = [
    "1.2.840.10008.1.2.4.57",
    "1.2.840.10008.1.2.4.70",
    "1.2.840.10008.1.2.4.90",
    "1.2.840.10008.1.2.5",
];
/// Files held in memory at once between reading and writing: bounds memory, keeps every core busy.
const BATCH: usize = 16;
static ENCODERS: OnceLock<crate::parallel::Pool> = OnceLock::new();
/// The ZIP's own compression over files left as they were: 6 packs nearly as tight as 9, much faster.
const DEFLATE_LEVEL: i64 = 6;
/// Files really compressed for an estimate, spread over the export.
const SAMPLE: usize = 12;

/// How big a ZIP export comes out and how long it takes, from a few of its files.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub files: usize,
    pub before: u64,
    pub after: u64,
    pub seconds: f64,
}

/// One source file on its way into an archive.
struct Prepared {
    archive: usize,
    entry: String,
    /// The file as it goes if it is not re-encoded: the source's own bytes, or cleaned when anonymised.
    original: Vec<u8>,
    /// Parsed, when its images may be re-encoded.
    object: Option<DefaultDicomObject>,
    /// Its images are already compressed: a ZIP's compression gains little on them.
    encapsulated: bool,
}

/// What goes into an archive: its entry, its bytes, and whether they are stored as they are.
struct Packed {
    archive: usize,
    entry: String,
    bytes: Vec<u8>,
    stored: bool,
}

enum Encoding {
    Ready(Packed),
    Pending(mpsc::Receiver<(Packed, Duration)>),
}

impl Encoding {
    fn start(file: Prepared, smallest: bool) -> Self {
        if file.object.is_none() {
            return Self::Ready(finish(file, smallest));
        }
        let pool = ENCODERS.get_or_init(|| {
            crate::parallel::Pool::new("export-pack", crate::parallel::available(1).min(BATCH))
        });
        Self::Pending(pool.submit(move || {
            let started = Instant::now();
            let packed = finish(file, smallest);
            (packed, started.elapsed())
        }))
    }

    fn wait(self) -> Result<(Packed, Duration)> {
        match self {
            Self::Ready(file) => Ok((file, Duration::ZERO)),
            Self::Pending(result) => result.recv().context("ZIP encoder stopped unexpectedly"),
        }
    }
}

pub(super) fn write(sources: &[Arc<SourceFile>], opts: &ExportOptions, destination: &Path) -> Result<ExportResult> {
    let (names, places) = plan(sources, opts)?;
    let mut archives: Vec<Option<(PathBuf, ZipWriter<File>)>> = (0..names.len()).map(|_| None).collect();
    let packed = pack(sources, opts, destination, &names, &places, &mut archives);
    let mut written = Vec::new();
    let mut failure = packed.as_ref().err().map(|error| format!("{error:#}"));
    for (path, writer) in archives.into_iter().flatten() {
        if failure.is_none()
            && let Err(error) = writer.finish()
        {
            failure = Some(format!("Cannot finish {}: {error}", path.display()));
        }
        written.push(path);
    }
    if let Some(failure) = failure {
        // Only this export's own archives go, made by it a moment ago.
        for path in &written {
            let _ = fs::remove_file(path);
        }
        return Err(packed.err().unwrap_or_else(|| anyhow::anyhow!(failure)));
    }
    let warnings = packed?;
    Ok(ExportResult {
        directory: match written.as_slice() {
            [only] => reported(only),
            _ => reported(destination),
        },
        files: sources.len(),
        archives: written.iter().map(|path| reported(path)).collect(),
        warnings: warnings.into(),
    })
}

fn pack(
    sources: &[Arc<SourceFile>],
    opts: &ExportOptions,
    destination: &Path,
    names: &[String],
    places: &[(usize, String)],
    archives: &mut [Option<(PathBuf, ZipWriter<File>)>],
) -> Result<Vec<crate::message::Note>> {
    let mut identity = IdentityMap::default();
    let mut warnings = Vec::new();
    let mut numbers: HashMap<(usize, &str), usize> = HashMap::new();
    for (batch, files) in sources.chunks(BATCH).enumerate() {
        // Read and cleaned in order: the identity map renames the same UID alike in every file.
        let mut jobs = Vec::with_capacity(files.len());
        let prepared = files.iter().enumerate().try_for_each(|(offset, source)| -> Result<()> {
            opts.check()?;
            let (archive, folder) = &places[batch * BATCH + offset];
            let number = numbers.entry((*archive, folder.as_str())).or_insert(0);
            *number += 1;
            let entry = format!("{folder}/IM{number:04}.dcm");
            let (original, object, encapsulated) = prepare(source, opts, &mut identity, &mut warnings, &entry)?;
            let file = Prepared { archive: *archive, entry, original, object, encapsulated };
            jobs.push(Encoding::start(file, opts.smallest));
            Ok(())
        });
        // Wait for submitted jobs even if a later source failed validation or the user cancelled.
        let packed: Vec<_> = jobs.into_iter().map(Encoding::wait).collect();
        prepared?;
        opts.check()?;
        for file in packed {
            let (file, _) = file?;
            let slot = &mut archives[file.archive];
            if slot.is_none() {
                *slot = Some(create(destination, &names[file.archive])?);
            }
            let (path, writer) = slot.as_mut().unwrap();
            let options = if file.stored {
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored)
            } else {
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .compression_level(Some(DEFLATE_LEVEL))
            }
            .large_file(file.bytes.len() as u64 >= u64::from(u32::MAX));
            writer
                .start_file(file.entry.as_str(), options)
                .and_then(|()| writer.write_all(&file.bytes).map_err(Into::into))
                .with_context(|| format!("Cannot write {}", path.display()))?;
        }
    }
    warnings.sort_by(|a, b| a.text.cmp(&b.text));
    warnings.dedup();
    Ok(warnings)
}

/// A source read whole (checked unchanged meanwhile), parsed and, if asked, cleaned of identity.
fn prepare(
    source: &Arc<SourceFile>,
    opts: &ExportOptions,
    identity: &mut IdentityMap,
    warnings: &mut Vec<crate::message::Note>,
    name: &str,
) -> Result<(Vec<u8>, Option<DefaultDicomObject>, bool)> {
    let mut handle = source.open()?;
    let mut raw = Vec::with_capacity(source.len as usize);
    handle.read_to_end(&mut raw)?;
    let mut obj = OpenFileOptions::new()
        .from_reader(Cursor::new(&raw))
        .with_context(|| format!("Cannot parse DICOM {}", source.path.display()))?;
    if opts.anonymize {
        clean_instance(&mut obj, opts, identity, warnings, name)?;
    }
    let syntax = obj.meta().transfer_syntax().trim_end_matches('\0').to_owned();
    let original = if opts.anonymize {
        let mut bytes = Vec::with_capacity(raw.len());
        obj.write_all(&mut bytes).context("Cannot write exported DICOM")?;
        bytes
    } else {
        raw
    };
    let encapsulated = !NATIVE.contains(&syntax.as_str());
    let object = reencodable(&obj, &syntax, opts.smallest).then_some(obj);
    Ok((original, object, encapsulated))
}

/// Single-component greyscale of 8 or 16 bits, uncompressed (or losslessly compressed, for the smallest size): what
/// lossless JPEG-LS is sure to hold. Colour and the rest go as they are.
fn reencodable(obj: &DefaultDicomObject, syntax: &str, smallest: bool) -> bool {
    let number = |tag: Tag| obj.element(tag).ok().and_then(|element| element.to_int::<u32>().ok());
    let allocated = number(Tag(0x0028, 0x0100));
    (NATIVE.contains(&syntax) || (smallest && LOSSLESS.contains(&syntax)))
        && obj.element(Tag(0x7fe0, 0x0010)).is_ok()
        && number(Tag(0x0028, 0x0002)) == Some(1)
        && matches!(allocated, Some(8 | 16))
        && number(Tag(0x0028, 0x0101)).is_some_and(|stored| (2..=16).contains(&stored) && Some(stored) <= allocated)
        && matches!(value(obj, Tag(0x0028, 0x0004)).as_str(), "MONOCHROME1" | "MONOCHROME2")
}

fn finish(file: Prepared, smallest: bool) -> Packed {
    let Prepared { archive, entry, original, object, encapsulated } = file;
    if let Some(bytes) = object.and_then(|obj| jpeg_ls(obj, original.len())) {
        return Packed { archive, entry, bytes, stored: true };
    }
    Packed { archive, entry, bytes: original, stored: encapsulated && !smallest }
}

/// The file with its images as lossless JPEG-LS, if they decode back to exactly the same samples and the file comes
/// out smaller than `limit` bytes.
fn jpeg_ls(mut obj: DefaultDicomObject, limit: usize) -> Option<Vec<u8>> {
    let syntax = TransferSyntaxRegistry.get(JPEG_LS_LOSSLESS)?;
    let encapsulated = obj.element(Tag(0x7fe0, 0x0010)).ok()?.value().fragments().is_some();
    if encapsulated {
        crate::codec_guard::check(&obj, None).ok()?;
    }
    let samples = obj.decode_pixel_data().ok()?.into_data();
    let had_frames = obj.element(Tag(0x0028, 0x0008)).is_ok();
    obj.transcode(syntax).ok()?;
    // Encapsulated Pixel Data Value Total Length is UV, newer than many readers; a single frame needs no count.
    obj.remove_element(Tag(0x7fe0, 0x0003));
    if !had_frames {
        obj.remove_element(Tag(0x0028, 0x0008));
    }
    if obj.decode_pixel_data().ok()?.data() != samples.as_slice() {
        return None;
    }
    let mut bytes = Vec::with_capacity(limit);
    obj.write_all(&mut bytes).ok()?;
    (bytes.len() < limit).then_some(bytes)
}

/// The archives' names, and each source's archive (by index into the names) and folder there.
type Plan = (Vec<String>, Vec<(usize, String)>);

/// Each source's archive and folder there, from the files' headers; the archives' names.
fn plan(sources: &[Arc<SourceFile>], opts: &ExportOptions) -> Result<Plan> {
    struct Patient {
        name: String,
        id: String,
        modalities: Vec<String>,
        date: String,
        folders: HashMap<String, String>,
        taken: HashSet<String>,
    }
    let mut patients: Vec<Patient> = Vec::new();
    let mut known = HashMap::new();
    let mut places = Vec::with_capacity(sources.len());
    for source in sources {
        opts.check()?;
        let handle = source.open()?;
        let obj = OpenFileOptions::new()
            .read_until(Tag(0x7fe0, 0x0000))
            .from_reader(handle)
            .with_context(|| format!("Cannot parse DICOM {}", source.path.display()))?;
        let (name, id) = (value(&obj, Tag(0x0010, 0x0010)), value(&obj, Tag(0x0010, 0x0020)));
        let at = *known.entry(patient_key(&obj)).or_insert_with(|| {
            patients.push(Patient { name, id, modalities: Vec::new(), date: String::new(), folders: HashMap::new(), taken: HashSet::new() });
            patients.len() - 1
        });
        let patient = &mut patients[at];
        let modality = value(&obj, Tag(0x0008, 0x0060));
        if !modality.is_empty() && !patient.modalities.contains(&modality) {
            patient.modalities.push(modality);
        }
        if patient.date.is_empty() {
            patient.date = value(&obj, Tag(0x0008, 0x0020));
        }
        let series = value(&obj, Tag(0x0020, 0x000e));
        let folder = match patient.folders.get(&series) {
            Some(folder) => folder.clone(),
            None => {
                let base = if opts.anonymize && opts.full {
                    format!("Series-{}", patient.folders.len() + 1)
                } else {
                    folder_name(&value(&obj, Tag(0x0020, 0x0011)), &value(&obj, Tag(0x0008, 0x103e)))
                };
                let folder = unique(&base, &patient.taken);
                patient.taken.insert(folder.to_lowercase());
                patient.folders.insert(series, folder.clone());
                folder
            }
        };
        places.push((at, folder));
    }
    // Two patients never share an archive: both exported anonymised on one day would have one name.
    let mut taken = HashSet::new();
    let names = patients
        .iter()
        .map(|patient| {
            let name = unique(&archive_name(&patient.name, &patient.id, &patient.modalities, &patient.date, opts), &taken);
            taken.insert(name.to_lowercase());
            name
        })
        .collect();
    Ok((names, places))
}

/// "SURNAME NAME - MR-CT - 13.06.2022"; "ANONIM - MR - 13.06.2022" anonymised; no date when fully anonymised.
fn archive_name(name: &str, id: &str, modalities: &[String], date: &str, opts: &ExportOptions) -> String {
    let person = name.replace('^', " ").split_whitespace().collect::<Vec<_>>().join(" ");
    let who = if opts.anonymize {
        "ANONIM".to_owned()
    } else if !person.is_empty() {
        person
    } else if !id.is_empty() {
        id.to_owned()
    } else {
        "Hasta".to_owned()
    };
    let date = if opts.anonymize && opts.full {
        String::new()
    } else if date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()) {
        format!("{}.{}.{}", &date[6..8], &date[4..6], &date[..4])
    } else {
        String::new()
    };
    let text = [who, modalities.join("-"), date].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" - ");
    let clean: String = text.chars().map(|c| if c.is_control() || r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).take(120).collect();
    let clean = clean.trim_matches([' ', '.']).to_owned();
    if clean.is_empty() { "Hasta".to_owned() } else { clean }
}

/// A series' folder in its archive: "3_T2 Aksiyel", as VEAcom 1.x named it.
fn folder_name(number: &str, description: &str) -> String {
    let text = format!("{number}_{description}");
    let clean: String = text
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_') { c } else { '_' })
        .take(64)
        .collect();
    let clean = clean.trim_matches([' ', '_']).to_owned();
    if clean.is_empty() { "seri".to_owned() } else { clean }
}

/// `base`, or "base (2)" and on, whichever is not taken (compared without case, as Windows does).
fn unique(base: &str, taken: &HashSet<String>) -> String {
    (1..)
        .map(|n| if n == 1 { base.to_owned() } else { format!("{base} ({n})") })
        .find(|name| !taken.contains(&name.to_lowercase()))
        .unwrap()
}

/// A new ZIP named `name` in `directory`, "name (2).zip" and on if one is there already; never an existing file.
fn create(directory: &Path, name: &str) -> Result<(PathBuf, ZipWriter<File>)> {
    for n in 1..10_000 {
        let path = directory.join(if n == 1 { format!("{name}.zip") } else { format!("{name} ({n}).zip") });
        match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(file) => return Ok((path, ZipWriter::new(file))),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).with_context(|| format!("Cannot create {}", path.display())),
        }
    }
    anyhow::bail!("No free name for {name}.zip")
}

/// The export's size before and after, and its time, from a few files really prepared, re-encoded and packed.
pub fn estimate_indexed(files: &[Arc<SourceFile>], opts: &ExportOptions) -> Result<Estimate> {
    let sizes: Vec<u64> = files.iter().map(|path| path.len).collect();
    let total: u64 = sizes.iter().sum();
    if files.is_empty() || total == 0 {
        return Ok(Estimate { files: files.len(), before: total, after: total, seconds: 0. });
    }
    let mut identity = IdentityMap::default();
    let mut warnings = Vec::new();
    let (mut before, mut after) = (0u64, 0u64);
    let (mut reading, mut encoding, mut packing) = (0f64, 0f64, 0f64);
    // From the middle of each of SAMPLE equal stretches: a fixed stride can fall on every other file only, and
    // studies that alternate (compressed and not, one series' files beside another's) came out far too small.
    let picks = SAMPLE.min(files.len());
    for index in (0..picks).map(|k| ((2 * k + 1) * files.len() / (2 * picks)).min(files.len() - 1)) {
        let started = Instant::now();
        let (original, object, encapsulated) = prepare(&files[index], opts, &mut identity, &mut warnings, "IM")?;
        reading += started.elapsed().as_secs_f64();
        let file = Prepared { archive: 0, entry: String::new(), original, object, encapsulated };
        let (packed, elapsed) = Encoding::start(file, opts.smallest).wait()?;
        encoding += elapsed.as_secs_f64();
        let started = Instant::now();
        after += if packed.stored { packed.bytes.len() as u64 } else { deflated(&packed.bytes) };
        packing += started.elapsed().as_secs_f64();
        before += sizes[index];
    }
    let scale = total as f64 / before.max(1) as f64;
    let cores = ENCODERS.get().map_or(1, |pool| pool.threads()).min(files.len()) as f64;
    Ok(Estimate {
        files: files.len(),
        before: total,
        after: (after as f64 * scale) as u64,
        seconds: (reading + encoding / cores + packing) * scale,
    })
}

fn deflated(bytes: &[u8]) -> u64 {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(DEFLATE_LEVEL as u32));
    match encoder.write_all(bytes).and_then(|()| encoder.finish()) {
        Ok(out) => out.len() as u64,
        Err(_) => bytes.len() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{DataElement, PrimitiveValue, VR};
    use dicom_object::{FileMetaTableBuilder, InMemDicomObject};

    /// A 64×64 greyscale slice of `bits` stored bits holding `pixels`, in patient `name`'s series `series`.
    fn slice(path: &Path, name: &str, series: &str, number: &str, sop: &str, bits: u16, pixels: Vec<u16>) {
        let mut obj = InMemDicomObject::new_empty();
        for (tag, vr, v) in [
            (Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.4"),
            (Tag(0x0008, 0x0018), VR::UI, sop),
            (Tag(0x0008, 0x0020), VR::DA, "20240201"),
            (Tag(0x0008, 0x0060), VR::CS, "MR"),
            (Tag(0x0008, 0x103e), VR::LO, "T2 aks/1"),
            (Tag(0x0010, 0x0010), VR::PN, name),
            (Tag(0x0010, 0x0020), VR::LO, "ID1"),
            (Tag(0x0020, 0x000d), VR::UI, "2.25.10"),
            (Tag(0x0020, 0x000e), VR::UI, series),
            (Tag(0x0020, 0x0011), VR::IS, number),
            (Tag(0x0028, 0x0004), VR::CS, "MONOCHROME2"),
        ] {
            obj.put_str(tag, vr, v);
        }
        for (tag, value) in [
            (Tag(0x0028, 0x0010), 64u16),
            (Tag(0x0028, 0x0011), 64),
            (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), 16),
            (Tag(0x0028, 0x0101), bits),
            (Tag(0x0028, 0x0102), bits - 1),
            (Tag(0x0028, 0x0103), 0),
        ] {
            obj.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
        }
        obj.put(DataElement::new(Tag(0x7fe0, 0x0010), VR::OW, PrimitiveValue::U16(pixels.into())));
        obj.with_meta(FileMetaTableBuilder::new().transfer_syntax("1.2.840.10008.1.2.1"))
            .unwrap()
            .write_to_file(path)
            .unwrap();
    }

    fn smooth(seed: u16) -> Vec<u16> {
        (0..64u16 * 64).map(|i| (i % 64) * 20 + (i / 64) * 10 + seed).collect()
    }

    fn options(directory: &Path) -> ExportOptions {
        ExportOptions { operation: None, cancelled: None,
            directory: directory.to_string_lossy().into_owned(),
            anonymize: false,
            dicomdir: false,
            decompress: false,
            root: false,
            full: false,
            zip: true,
            smallest: false,
        }
    }

    fn entries(path: &str) -> Vec<(String, DefaultDicomObject)> {
        let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|i| {
                let mut file = archive.by_index(i).unwrap();
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).unwrap();
                (file.name().unwrap().into_owned(), OpenFileOptions::new().from_reader(Cursor::new(bytes)).unwrap())
            })
            .collect()
    }

    #[test]
    fn a_patient_goes_in_one_zip_with_its_images_jpeg_ls_and_every_sample_kept() {
        let sources = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        let mut files = Vec::new();
        for (i, (series, number)) in [("2.25.11", "3"), ("2.25.11", "3"), ("2.25.12", "5")].into_iter().enumerate() {
            let path = sources.path().join(format!("{i}.dcm"));
            slice(&path, "DENEME^HASTA", series, number, &format!("2.25.{}", 100 + i), 12, smooth(i as u16));
            files.push(path);
        }
        let result = super::super::export_series(&files, &options(out.path())).unwrap();
        assert_eq!(result.archives.len(), 1);
        assert!(result.directory.ends_with("DENEME HASTA - MR - 01.02.2024.zip"), "{}", result.directory);
        let inside = entries(&result.archives[0]);
        let names: Vec<_> = inside.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["3_T2 aks_1/IM0001.dcm", "3_T2 aks_1/IM0002.dcm", "5_T2 aks_1/IM0001.dcm"]);
        for (i, (_, obj)) in inside.iter().enumerate() {
            assert_eq!(obj.meta().transfer_syntax().trim_end_matches('\0'), JPEG_LS_LOSSLESS);
            assert!(obj.element(Tag(0x7fe0, 0x0003)).is_err() && obj.element(Tag(0x0028, 0x0008)).is_err());
            let samples: Vec<u16> = obj.decode_pixel_data().unwrap().data().chunks(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
            assert_eq!(samples, smooth(i as u16));
        }
        let size = fs::metadata(&result.archives[0]).unwrap().len();
        let sources_size: u64 = files.iter().map(|f| fs::metadata(f).unwrap().len()).sum();
        assert!(size < sources_size / 2, "{size} of {sources_size}");
    }

    #[test]
    fn a_bad_source_in_a_later_batch_removes_the_partial_zip() {
        let sources = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        let opts = options(out.path());
        let files: Vec<_> = (0..BATCH + 2).map(|i| {
            let path = sources.path().join(format!("{i:02}.dcm"));
            slice(&path, "SYNTHETIC", "2.25.11", "3", &format!("2.25.{}", 500 + i), 12, smooth(i as u16));
            path
        }).collect();
        let last = OpenOptions::new().write(true).open(files.last().unwrap()).unwrap();
        last.set_len(last.metadata().unwrap().len() - 2).unwrap();
        drop(last);

        let files: Vec<_> = files.iter().map(|path| SourceFile::index(path).unwrap()).collect();
        // Headers still plan successfully. The final file fails after its batch has started encoding.
        plan(&files, &opts).unwrap();
        assert!(write(&files, &opts, out.path()).is_err());
        assert_eq!(fs::read_dir(out.path()).unwrap().count(), 0);
        let retried = write(&files[..files.len() - 1], &opts, out.path()).unwrap();
        assert_eq!(entries(&retried.archives[0]).len(), BATCH + 1);
    }

    #[test]
    fn samples_jpeg_ls_would_change_go_as_they_were() {
        let sources = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        // 12 bits stored, but the high bits carry something (an overlay, a sign): JPEG-LS at 12 bits cannot keep it.
        let mut pixels = smooth(0);
        pixels[5] = 0xf123;
        let path = sources.path().join("a.dcm");
        slice(&path, "DENEME^HASTA", "2.25.11", "3", "2.25.100", 12, pixels.clone());
        let result = super::super::export_series(std::slice::from_ref(&path), &options(out.path())).unwrap();
        let inside = entries(&result.archives[0]);
        assert_eq!(inside[0].1.meta().transfer_syntax().trim_end_matches('\0'), "1.2.840.10008.1.2.1");
        let mut zipped = zip::ZipArchive::new(File::open(&result.archives[0]).unwrap()).unwrap();
        let mut bytes = Vec::new();
        zipped.by_index(0).unwrap().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, fs::read(&path).unwrap(), "byte for byte the source");
    }

    #[test]
    fn anonymised_archives_say_anonim_two_patients_never_share_one_and_existing_files_stay() {
        let sources = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        let mut files = Vec::new();
        for (i, name) in ["BIR^HASTA", "IKI^HASTA"].into_iter().enumerate() {
            let path = sources.path().join(format!("{i}.dcm"));
            slice(&path, name, &format!("2.25.{}", 20 + i), "3", &format!("2.25.{}", 200 + i), 12, smooth(0));
            files.push(path);
        }
        fs::write(out.path().join("ANONIM - MR.zip"), b"not ours").unwrap();
        let opts = ExportOptions { anonymize: true, full: true, ..options(out.path()) };
        let result = super::super::export_series(&files, &opts).unwrap();
        let names: Vec<_> = result.archives.iter().map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["ANONIM - MR (2).zip", "ANONIM - MR (2) (2).zip"]);
        assert_eq!(fs::read(out.path().join("ANONIM - MR.zip")).unwrap(), b"not ours");
        for archive in &result.archives {
            let (_, obj) = &entries(archive)[0];
            assert_ne!(value(obj, Tag(0x0010, 0x0010)), "BIR^HASTA");
            assert_eq!(value(obj, Tag(0x0008, 0x0020)), "19000101");
        }
    }

    #[test]
    fn zip_membership_uses_issuer_and_splits_unscoped_ids_by_study() {
        let source = crate::test_dir::tempdir().unwrap();
        for (first_id, first_issuer, second_issuer, expected) in [
            ("ID1", "SITE_A", "SITE_B", 2), ("ID1", "", "", 2),
            ("", "", "", 2), ("ID1", "SITE_A", "SITE_A", 1),
        ] {
            let out = crate::test_dir::tempdir().unwrap();
            let mut files = Vec::new();
            for (i, issuer) in [first_issuer, second_issuer].iter().enumerate() {
                let path = source.path().join(format!("patient{i}.dcm"));
                slice(&path, "SYNTHETIC^PATIENT", &format!("2.25.2{i}"), "1",
                    &format!("2.25.3{i}"), 12, smooth(i as u16));
                let mut obj = dicom_object::open_file(&path).unwrap();
                obj.put_str(Tag(0x0010, 0x0020), VR::LO, first_id);
                obj.put_str(Tag(0x0010, 0x0021), VR::LO, *issuer);
                obj.put_str(Tag(0x0020, 0x000d), VR::UI, format!("2.25.1{i}"));
                obj.write_to_file(&path).unwrap();
                files.push(path);
            }
            let result = super::super::export_series(&files, &options(out.path())).unwrap();
            assert_eq!(result.archives.len(), expected);
            let membership: Vec<Vec<String>> = result.archives.iter().map(|zip|
                entries(zip).iter().map(|(_,obj)| value(obj, Tag(0x0008, 0x0018))).collect()).collect();
            if expected == 2 {
                assert_eq!(membership, [vec!["2.25.30"], vec!["2.25.31"]]);
            } else {
                assert_eq!(membership, [vec!["2.25.30", "2.25.31"]]);
            }
        }
    }

    #[test]
    fn full_cleanup_removes_free_text_from_dicom_dicomdir_and_zip_names() {
        const MARKER: &str = "CASE42";
        let source = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        let path = source.path().join("source.dcm");
        slice(&path, "SYNTHETIC^PATIENT", "2.25.11", "3", "2.25.100", 12, smooth(0));
        let mut obj = dicom_object::open_file(&path).unwrap();
        obj.put_str(Tag(0x0010, 0x0020), VR::LO, MARKER);
        obj.put_str(Tag(0x0008, 0x1030), VR::LO, format!("Prior {MARKER}"));
        obj.put_str(Tag(0x0008, 0x103e), VR::LO, format!("Followup {MARKER}"));
        obj.put_str(Tag(0x0008, 0x2111), VR::ST, format!("Derived for {MARKER}"));
        let mut nested = InMemDicomObject::new_empty();
        nested.put_str(Tag(0x0008, 0x2111), VR::ST, format!("Nested derivation {MARKER}"));
        nested.put_str(Tag(0x0008, 0x103e), VR::LO, format!("Nested {MARKER}"));
        obj.put(DataElement::new(Tag(0x0008, 0x1115), VR::SQ,
            dicom_core::value::DataSetSequence::new(vec![nested], dicom_core::Length::UNDEFINED)));
        obj.write_to_file(&path).unwrap();
        let mut opts = ExportOptions { full: true, anonymize: true, ..options(out.path()) };
        let result = super::super::export_series(std::slice::from_ref(&path), &opts).unwrap();
        let (entry, obj) = entries(&result.archives[0]).pop().unwrap();
        assert_eq!(entry, "Series-1/IM0001.dcm");
        for tag in [Tag(0x0008, 0x1030), Tag(0x0008, 0x103e), Tag(0x0010, 0x0020)] {
            assert!(!value(&obj, tag).contains(MARKER));
        }
        let nested = &obj.element(Tag(0x0008, 0x1115)).unwrap().value().items().unwrap()[0];
        assert!(nested.get(Tag(0x0008, 0x103e)).is_none());
        assert!(nested.get(Tag(0x0008, 0x2111)).is_none());
        assert!(obj.get(Tag(0x0008, 0x2111)).is_none());
        opts.zip = false;
        opts.dicomdir = true;
        let result = super::super::export_series(&[path], &opts).unwrap();
        for name in ["DICOMDIR","DICOM/IM000001"] {
            let bytes = fs::read(Path::new(&result.directory).join(name)).unwrap();
            assert!(!bytes.windows(MARKER.len()).any(|s| s == MARKER.as_bytes()), "{name}");
        }
    }

    #[test]
    fn the_estimate_reads_a_few_files_and_comes_out_smaller() {
        let sources = crate::test_dir::tempdir().unwrap();
        let files: Vec<_> = (0..20)
            .map(|i| {
                let path = sources.path().join(format!("{i}.dcm"));
                slice(&path, "DENEME^HASTA", "2.25.11", "3", &format!("2.25.{}", 300 + i), 12, smooth(i));
                path
            })
            .collect();
        let estimate = estimate_indexed(&super::super::index_test_files(&files).unwrap(), &options(sources.path())).unwrap();
        assert_eq!(estimate.files, 20);
        assert!(estimate.after < estimate.before / 2 && estimate.seconds >= 0., "{estimate:?}");
    }

    #[test]
    fn the_estimate_holds_when_files_that_shrink_and_files_that_do_not_alternate() {
        let sources = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        // Every other file noise that hardly packs: a fixed stride picked only the smooth ones.
        let mut state = 12345u32;
        let files: Vec<_> = (0..30u16)
            .map(|i| {
                let path = sources.path().join(format!("{i:02}.dcm"));
                let pixels = if i % 2 == 0 {
                    smooth(i)
                } else {
                    (0..64 * 64).map(|_| { state = state.wrapping_mul(1_103_515_245).wrapping_add(12345); ((state >> 16) & 0x0fff) as u16 }).collect()
                };
                slice(&path, "DENEME^HASTA", "2.25.11", "3", &format!("2.25.{}", 400 + i), 12, pixels);
                path
            })
            .collect();
        let estimate = estimate_indexed(&super::super::index_test_files(&files).unwrap(), &options(out.path())).unwrap();
        let result = super::super::export_series(&files, &options(out.path())).unwrap();
        let actual = fs::metadata(&result.archives[0]).unwrap().len() as f64;
        let ratio = estimate.after as f64 / actual;
        assert!((0.7..1.4).contains(&ratio), "estimated {} for {actual}", estimate.after);
    }
}
