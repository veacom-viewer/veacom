use crate::confidentiality::{self, Action};
use crate::patient::{PatientKey, patient_key};
use crate::source_file::SourceFile;
use anyhow::{Context, Result, ensure};
use dicom_core::{DataElement, PrimitiveValue, Tag, VR, header::{HasLength, Header}};
use dicom_object::{DefaultDicomObject, InMemDicomObject, OpenFileOptions};
use dicom_pixeldata::PixelDecoder;
use serde::{Deserialize, Serialize};
use crate::vfs::{self as fs, OpenOptions};
use std::{
    collections::{HashMap, HashSet},
    io::{Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};
use std::path::PathBuf;

#[path = "export_zip.rs"]
mod export_zip;
pub use export_zip::estimate_indexed;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub directory: String,
    #[serde(default)]
    pub anonymize: bool,
    #[serde(default)]
    pub dicomdir: bool,
    #[serde(default)]
    pub decompress: bool,
    /// Media with a DICOMDIR written straight into `directory` (the root of a USB stick: some
    /// neuronavigation systems look for DICOMDIR only there). Refused, with nothing written, if
    /// a DICOMDIR or a DICOM folder is there already.
    #[serde(default)]
    pub root: bool,
    /// Full anonymisation: besides the partial cleanup's identifiers, dates and times (set to 1900-01-01 00:00, as
    /// DICOMDIR records need them), age, weight and height, overlays and graphic annotations go.
    #[serde(default)]
    pub full: bool,
    /// One ZIP per patient in `directory` instead of a folder, images re-encoded without loss (export_zip.rs).
    #[serde(default)]
    pub zip: bool,
    /// With `zip`: images already held in another lossless compression are re-encoded too (slower, smaller).
    #[serde(default)]
    pub smallest: bool,
    /// The id the caller gave this export, so it can be cancelled (`/export/cancel`).
    #[serde(default)]
    pub operation: Option<String>,
    /// Set when the caller cancels; checked before each file, like the engine's shutdown.
    #[serde(skip)]
    pub cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl ExportOptions {
    /// Stops the export between files when the engine shuts down or the caller cancels it; the failure paths then
    /// remove what this export wrote.
    pub fn check(&self) -> Result<()> {
        ensure!(!crate::progress::is_stopping(), coded!("core.stopping", "Native core is shutting down"));
        ensure!(
            !self.cancelled.as_ref().is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire)),
            coded!("export.cancelled", "Export cancelled; nothing was kept")
        );
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub directory: String,
    pub files: usize,
    /// The ZIP files written, one per patient (ZIP exports only).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub archives: Vec<String>,
    #[serde(flatten)]
    pub warnings: crate::message::Notes,
}

/// Exports files by path, indexing them first: for the tests, the desktop transport's among them (which build this
/// library without `cfg(test)`).
#[doc(hidden)]
pub fn export_series(files: &[PathBuf], opts: &ExportOptions) -> Result<ExportResult> {
    opts.check()?;
    export_indexed(&index_test_files(files)?, opts)
}

fn index_test_files(files: &[PathBuf]) -> Result<Vec<Arc<SourceFile>>> {
    files.iter().map(|p| SourceFile::dicom(p).map(|(source, _, _)| source)).collect()
}

/// Writes each export to a new directory without replacing existing files.
pub fn export_indexed(files: &[Arc<SourceFile>], opts: &ExportOptions) -> Result<ExportResult> {
    ensure!(!files.is_empty(), coded!("export.noSources", "The series has no source DICOM files"));
    ensure!(
        !opts.directory.trim().is_empty(),
        coded!("export.chooseDirectory", "Choose an export directory")
    );
    let mut seen = HashMap::new();
    let mut sources = Vec::new();
    for file in files {
        opts.check()?;
        let path = fs::canonicalize(&file.path)?;
        if let Some(previous) = seen.insert(path, file) {
            ensure!(file.same_contents(previous), "Selected series refer to different versions of the same file. Reimport the study.");
        } else {
            sources.push(file.clone());
        }
    }
    ensure!(
        sources.len() <= 999_999,
        "Too many files for this media export"
    );
    let destination = Path::new(&opts.directory);
    fs::create_dir_all(destination).context("Cannot create destination directory")?;
    let destination = fs::canonicalize(destination)?;
    for source in &sources {
        if let Some(parent) = fs::canonicalize(&source.path)?.parent() {
            ensure!(
                !destination.starts_with(parent),
                coded!("export.insideSource", "Choose a destination outside the source DICOM directory")
            );
        }
    }
    if opts.zip {
        ensure!(!opts.dicomdir && !opts.root && !opts.decompress, "A ZIP export holds plain DICOM files only");
        return export_zip::write(&sources, opts, &destination);
    }
    if opts.root {
        ensure!(opts.dicomdir, "Only media with a DICOMDIR is written at the destination's root");
        ensure!(
            !fs::exists(&destination.join("DICOMDIR")) && !fs::exists(&destination.join("DICOM")),
            coded!("export.rootOccupied", "The destination already has a DICOMDIR or a DICOM folder; nothing was overwritten")
        );
        // On failure only what this export made there goes: its DICOM folder and DICOMDIR.
        return write_export(&sources, opts, &destination);
    }
    let output = destination.join(format!("VEACOM_{}", crate::random::uuid_v4_simple()));
    fs::create_dir(&output).context("Cannot create a new export directory")?;
    let result = write_export(&sources, opts, &output);
    if result.is_err() {
        // Only this invocation's newly created directory can be removed here.
        let _ = fs::remove_dir_all(&output);
    }
    result
}

fn write_export(sources: &[Arc<SourceFile>], opts: &ExportOptions, output: &Path) -> Result<ExportResult> {
    let image_dir = output.join("DICOM");
    // Made here, so it is this export's own: removed again if the export fails.
    fs::create_dir(&image_dir)?;
    let result = write_media(sources, opts, output, &image_dir);
    if result.is_err() {
        let _ = fs::remove_dir_all(&image_dir);
    }
    result
}

fn write_media(sources: &[Arc<SourceFile>], opts: &ExportOptions, output: &Path, image_dir: &Path) -> Result<ExportResult> {
    let mut warnings = Vec::new();
    if opts.anonymize && opts.full {
        warnings.push(note!("export.fullCleanup", "Anonymised: identifiers, dates and times, age, weight, height, private tags, overlays and graphic annotations are removed. Pixels are retained: text burned into the image is not removed. Review exported files before sharing."));
    } else if opts.anonymize {
        warnings.push(note!("export.partialCleanup", "Partial metadata cleanup, not anonymous: selected identifiers, identifying comments, and private tags are removed. Acquisition dates and times, age, sex, weight, height, other clinical text, and pixels are retained. PatientIdentityRemoved is NO. Review exported files before sharing."));
    }
    let mut identity = IdentityMap::default();
    let mut records = Vec::new();
    let mut sop_instances = HashSet::new();
    let mut key_bytes = 0u64;
    for (i, source) in sources.iter().enumerate() {
        opts.check()?;
        // One handle for validating, parsing and copying: the file checked is the file
        // exported, even if something replaces it meanwhile.
        let mut handle = source.open()?;
        let mut obj = OpenFileOptions::new()
            .from_reader(&mut handle)
            .with_context(|| format!("Cannot parse DICOM {}", source.path.display()))?;
        let name = format!("IM{:06}", i + 1);
        let destination = image_dir.join(&name);
        if opts.anonymize {
            clean_instance(&mut obj, opts, &mut identity, &mut warnings, &name)?;
        }
        let decompress = opts.decompress && document_record_type(&value(&obj, Tag(0x0008, 0x0016))).is_none();
        if decompress {
            decompress_instance(&mut obj)
                .with_context(|| format!("Cannot decompress {}", source.path.display()))?;
            if value(&obj, Tag(0x0028, 0x2110)) == "01" {
                warnings.push(note!("export.lossy", "{name}: the source was lossy-compressed; decompression cannot restore lost image information", name = name.clone()));
            }
        }
        if opts.anonymize || decompress {
            let file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&destination)?;
            obj.write_all(file).context("Cannot write exported DICOM")?;
        } else {
            handle.seek(SeekFrom::Start(0))?;
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&destination)?;
            std::io::copy(&mut handle, &mut output)?;
        }
        if opts.dicomdir {
            let record =
                InstanceRecord::from_object(&obj, format!("DICOM\\{name}"), &mut warnings)?;
            ensure!(
                sop_instances.insert(record.sop_uid.clone()),
                coded!("export.duplicateSop", "Duplicate SOPInstanceUID in different source files; media export cancelled")
            );
            key_bytes += record.keys.len() as u64;
            ensure!(key_bytes <= crate::input_guard::MAX_META, "DICOMDIR exceeds the supported metadata size");
            records.push(record);
        }
    }
    if opts.dicomdir {
        let bytes = build_dicomdir(&records)?;
        let path = output.join("DICOMDIR");
        let mut file = OpenOptions::new().create_new(true).write(true).open(&path)?;
        let written = file.write_all(&bytes).and_then(|_| file.flush());
        drop(file);
        if let Err(error) = written.map_err(anyhow::Error::from).and_then(|_| verify_dicomdir(&path, &records)) {
            // Created a moment ago by this export: a half-written DICOMDIR does not stay.
            let _ = fs::remove_file(&path);
            return Err(error);
        }
    }
    warnings.sort_by(|a, b| a.text.cmp(&b.text));
    warnings.dedup();
    Ok(ExportResult {
        directory: reported(&output),
        files: sources.len(),
        archives: Vec::new(),
        warnings: warnings.into(),
    })
}

/// The identity cleanup of one instance, as asked (partial, or full), shared by folder and ZIP exports; `name` is
/// the file's name in the export, for its warnings.
fn clean_instance(
    obj: &mut DefaultDicomObject,
    opts: &ExportOptions,
    identity: &mut IdentityMap,
    warnings: &mut Vec<crate::message::Note>,
    name: &str,
) -> Result<()> {
    if value(obj, Tag(0x0028, 0x0301)).eq_ignore_ascii_case("YES") {
        ensure!(!opts.full, coded!("export.burnedReview", "This source declares burned-in text. Redact and review its pixels before a full cleanup export."));
        warnings.push(note!(
            "export.burnedIn",
            "{name}: source declares burned-in annotation; pixel text was not removed",
            name = name.to_owned(),
        ));
    }
    ensure!(
        !uses_private_pet_calibration(obj),
        coded!("export.privatePetCalibration", "Selected-identifier cleanup cannot preserve this instance's private PET SUV calibration. Export without metadata cleanup or use a validated de-identification workflow.")
    );
    ensure!(!(opts.full && document_record_type(&value(obj, Tag(0x0008, 0x0016))).is_some()),
        coded!("export.documentCleanup", "Full cleanup cannot remove identifying text from reports or presentation states. Export the originals or use a validated document de-identification workflow."));
    if opts.full {
        ensure!(!obj.tags().any(|tag| (0x6000..=0x60ff).contains(&tag.0) && tag.1 == 0x0102 && obj.get(Tag(tag.0, 0x3000)).is_none()),
            coded!("export.embeddedOverlay", "This source may contain an overlay embedded in its pixels. Review and redact the pixels before a full cleanup export."));
    }
    identity.anonymize(obj, opts.full);
    if opts.full {
        full_cleanup(obj)?;
    }
    let sop_uid = value(obj, Tag(0x0008, 0x0018));
    ensure!(
        !sop_uid.is_empty(),
        coded!("export.noSopUid", "Cannot anonymize an instance without SOPInstanceUID")
    );
    obj.update_meta(|meta| {
        meta.media_storage_sop_instance_uid = sop_uid;
        meta.source_application_entity_title = None;
        meta.sending_application_entity_title = None;
        meta.receiving_application_entity_title = None;
        meta.private_information_creator_uid = None;
        meta.private_information = None;
    });
    Ok(())
}

fn decompress_instance(obj: &mut DefaultDicomObject) -> Result<()> {
    let encapsulated = obj
        .element(Tag(0x7fe0, 0x0010))
        .ok()
        .is_some_and(|element| element.value().fragments().is_some());
    if encapsulated {
        let attr = |tag: Tag, fallback: u64| -> Result<u64> {
            Ok(obj
                .element(tag)
                .ok()
                .map(|e| e.to_int::<u64>())
                .transpose()?
                .unwrap_or(fallback))
        };
        let bits = attr(Tag(0x0028, 0x0100), 0)?;
        ensure!(
            matches!(bits, 8 | 16),
            coded!("export.decompressBits", "Decompression export supports 8-bit or 16-bit stored samples")
        );
        let mut expected = 1u64;
        for value in [
            attr(Tag(0x0028, 0x0010), 0)?,
            attr(Tag(0x0028, 0x0011), 0)?,
            attr(Tag(0x0028, 0x0002), 1)?,
            attr(Tag(0x0028, 0x0008), 1)?,
            bits / 8,
        ] {
            expected = expected
                .checked_mul(value)
                .context("Decoded image size overflow")?;
        }
        ensure!(
            expected > 0 && expected <= 2 * 1024 * 1024 * 1024,
            "Decoded instance exceeds the 2 GiB export limit"
        );
        crate::codec_guard::check(obj, None)?;
        let decoded = obj
            .decode_pixel_data()
            .context("Unsupported or damaged compressed transfer syntax")?;
        ensure!(
            decoded.data().len() as u64 == expected,
            "Decoded sample length differs from the stored dimensions"
        );
        let photometric = crate::color::decoded_photometric(obj, &decoded);
        let components = decoded.samples_per_pixel();
        let (data, planar) = crate::color::export_data(obj, decoded)?;
        // Decoders expose little-endian bytes on the core's supported targets.
        let pixels = DataElement::new(
            Tag(0x7fe0, 0x0010),
            if bits == 16 { VR::OW } else { VR::OB },
            PrimitiveValue::U8(data.into()),
        );
        obj.put(pixels);
        obj.put_str(Tag(0x0028, 0x0004), VR::CS, photometric);
        if components > 1 {
            obj.put(DataElement::new(
                Tag(0x0028, 0x0006),
                VR::US,
                PrimitiveValue::from(planar),
            ));
        }
        obj.remove_element(Tag(0x7fe0, 0x0001));
        obj.remove_element(Tag(0x7fe0, 0x0002));
    } else if obj.meta().transfer_syntax().trim_end_matches('\0') == "1.2.840.10008.1.2.2" {
        reorder_big_endian_pixels(obj)?;
    }
    obj.update_meta(|meta| meta.transfer_syntax = "1.2.840.10008.1.2.1".into());
    Ok(())
}

/// Native pixel data from an Explicit VR Big Endian file, made right for little endian.
/// Typed OW words are values; written little endian in the same order they give the standard
/// encoding, since a 32-bit cell continues from its low bits in one word into the next
/// (PS3.5 8.2). Raw OW bytes, if the parser kept them as such, hold big-endian words and turn
/// round word by word. OB is unaffected by byte order, and float and double pixel data are
/// typed values already.
fn reorder_big_endian_pixels(obj: &mut DefaultDicomObject) -> Result<()> {
    let Ok(element) = obj.element(Tag(0x7fe0, 0x0010)) else {
        return Ok(());
    };
    if element.vr() != VR::OW {
        return Ok(());
    }
    let Some(PrimitiveValue::U8(bytes)) = element.value().primitive() else {
        return Ok(());
    };
    ensure!(bytes.len() % 2 == 0, "OW pixel data has an odd number of bytes");
    let words = bytes.chunks_exact(2).flat_map(|w| [w[1], w[0]]).collect();
    obj.put(DataElement::new(Tag(0x7fe0, 0x0010), VR::OW, PrimitiveValue::U8(words)));
    Ok(())
}

/// Canonical Windows paths carry the verbatim prefix (\\?\C:\..., \\?\UNC\...); the folder is
/// reported in its ordinary form, as Explorer and the desktop app expect it.
fn reported(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{share}")
    } else if let Some(local) = text
        .strip_prefix(r"\\?\")
        .filter(|rest| rest.as_bytes().get(1) == Some(&b':'))
    {
        local.to_owned()
    } else {
        text.into_owned()
    }
}

fn value(obj: &InMemDicomObject, tag: Tag) -> String {
    obj.get(tag)
        .and_then(|e| e.to_str().ok())
        .map(|s| s.trim_end_matches([' ', '\0']).to_owned())
        .unwrap_or_default()
}

fn uses_private_pet_calibration(obj: &InMemDicomObject) -> bool {
    value(obj, Tag(0x0008, 0x0060)) == "PT"
        && matches!(value(obj, Tag(0x0054, 0x1001)).as_str(), "CNTS" | "BQML")
        && obj
            .get(Tag(0x7053, 0x1000))
            .and_then(|element| element.to_float64().ok())
            .is_some_and(|factor| factor > 0.)
}

#[derive(Default)]
struct IdentityMap {
    uids: HashMap<String, String>,
    patients: HashMap<PatientKey, String>,
}

impl IdentityMap {
    fn anonymize(&mut self, obj: &mut InMemDicomObject, full: bool) {
        let patient = self
            .patients
            .entry(patient_key(obj))
            .or_insert_with(|| format!("ANON-{}", &crate::random::uuid_v4_simple()[..12]))
            .clone();
        self.clean_dataset(obj, full);
        obj.put_str(Tag(0x0010, 0x0010), VR::PN, "ANON");
        obj.put_str(Tag(0x0010, 0x0020), VR::LO, patient);
        // We neither review burned-in text nor remove all identifying metadata.
        obj.put_str(Tag(0x0012, 0x0062), VR::CS, "NO");
        obj.put_str(
            Tag(0x0012, 0x0063),
            VR::LO,
            "VEAcom partial metadata cleanup; dates and pixels retained",
        );
    }

    fn clean_dataset(&mut self, obj: &mut InMemDicomObject, full: bool) {
        obj.retain(|e| e.tag().0 % 2 == 0 && !remove_identity_container(e.tag()));
        if obj.get(Tag(0x0012, 0x0062)).is_some() {
            obj.put_str(Tag(0x0012, 0x0062), VR::CS, "NO");
        }
        let tags: Vec<_> = obj.tags().collect();
        for tag in tags {
            let vr = obj.get(tag).map(|e| e.vr()).unwrap_or(VR::UN);
            if direct_identifier(tag) || vr == VR::PN {
                if vr == VR::SQ {
                    obj.remove_element(tag);
                } else {
                    obj.put_str(tag, vr, "");
                }
                continue;
            }
            if remap_uid(tag) || (full && vr == VR::UI && matches!(confidentiality::action(tag), Some(Action::Uid | Action::Dummy))) {
                let original = value(obj, tag);
                if !original.is_empty() {
                    let mapped: Vec<_> = original
                        .split('\\')
                        .map(|uid| {
                            self.uids
                                .entry(uid.to_string())
                                .or_insert_with(new_uid)
                                .clone()
                        })
                        .collect();
                    obj.put_str(tag, VR::UI, mapped.join("\\"));
                }
            }
            obj.update_value(tag, |v| {
                if let Some(items) = v.items_mut() {
                    for item in items {
                        self.clean_dataset(item, full);
                    }
                }
            });
        }
    }
}

fn remap_uid(tag: Tag) -> bool {
    matches!(
        tag,
        Tag(0x0008, 0x0018 | 0x1155 | 0x3010)
            | Tag(0x0020, 0x000D | 0x000E | 0x0052 | 0x0200 | 0x9161 | 0x9164)
    )
}

/// The full anonymisation's further cleanup, after `IdentityMap::anonymize`.
fn full_cleanup(obj: &mut InMemDicomObject) -> Result<()> {
    clean_attributes(obj, true)?;
    obj.put_str(Tag(0x0012, 0x0063), VR::LO, "VEAcom full metadata cleanup; pixels retained");
    Ok(())
}

fn clean_attributes(obj: &mut InMemDicomObject, root: bool) -> Result<()> {
    let tags: Vec<_> = obj.tags().collect();
    for tag in tags {
        // The root patient name and ID were already replaced with this export's pseudonym.
        if root && matches!(tag, Tag(0x0010, 0x0010 | 0x0020)) { continue; }
        let vr = obj.element(tag)?.vr();
        let action = confidentiality::action(tag);
        if action == Some(Action::Remove) || tag == Tag(0x0070, 0x0001) {
            obj.remove_element(tag);
            continue;
        }
        if let Some(value) = match vr {
            VR::DA => Some("19000101"), VR::TM => Some("000000"), VR::DT => Some("19000101000000"), _ => None,
        } {
            obj.put_str(tag, vr, value);
            continue;
        }
        match action {
            Some(Action::Uid) if vr != VR::UI => anyhow::bail!(coded!("export.unsupportedCleanup", "Full cleanup cannot safely replace DICOM attribute {tag}.", tag = tag.to_string())),
            Some(Action::Empty) => { obj.put(DataElement::empty(tag, vr)); }
            Some(Action::Dummy) if vr != VR::UI => {
                let dummy = match vr {
                    VR::AE | VR::CS | VR::LO | VR::LT | VR::PN | VR::SH | VR::ST | VR::UC | VR::UT => "REMOVED",
                    VR::UR => "https://example.invalid",
                    VR::IS | VR::DS => "0",
                    _ => anyhow::bail!(coded!("export.unsupportedCleanup", "Full cleanup cannot safely replace DICOM attribute {tag}.", tag = tag.to_string())),
                };
                obj.put_str(tag, vr, dummy);
            }
            None if matches!(vr, VR::ST | VR::LT | VR::UT | VR::UC | VR::UN) => { obj.put(DataElement::empty(tag, vr)); }
            _ if vr == VR::SQ => {
                let mut result = Ok(());
                obj.update_value(tag, |value| {
                    if let Some(items) = value.items_mut() {
                        result = items.iter_mut().try_for_each(|item| clean_attributes(item, false));
                    }
                });
                result?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn direct_identifier(tag: Tag) -> bool {
    matches!(
        tag,
        Tag(
            0x0008,
            0x0014
                | 0x0050
                | 0x0051
                | 0x0080
                | 0x0081
                | 0x0082
                | 0x0092
                | 0x0094
                | 0x0096
                | 0x1010
                | 0x1040
                | 0x1041
                | 0x1049
                | 0x1052
                | 0x1062
                | 0x1072
                | 0x1110
                | 0x1111
                | 0x1120
        ) | Tag(
            0x0010,
            0x0020
                | 0x0021
                | 0x0022
                | 0x0024
                | 0x0030
                | 0x0032
                | 0x0033
                | 0x0034
                | 0x0050
                | 0x1000
                | 0x1001
                | 0x1002
                | 0x1005
                | 0x1040
                | 0x1060
                | 0x1080
                | 0x1081
                | 0x1090
                | 0x1100
                | 0x2150
                | 0x2152
                | 0x2154
                | 0x2160
                | 0x2161
                | 0x2162
                | 0x2180
                | 0x21B0
                | 0x4000
        ) | Tag(
            0x0018,
            0x1000 | 0x1002 | 0x1004 | 0x1005 | 0x1007 | 0x1008 | 0x1009 | 0x4000
        ) | Tag(0x0020, 0x0010 | 0x4000)
            | Tag(0x0028, 0x4000)
            | Tag(0x0032, 0x1032 | 0x1033 | 0x1060 | 0x1070 | 0x4000)
            | Tag(0x0038, 0x0010 | 0x0011 | 0x0300 | 0x0400 | 0x0500 | 0x4000)
            | Tag(
                0x0040,
                0x0009
                    | 0x0241
                    | 0x0242
                    | 0x0243
                    | 0x0253
                    | 0x0275
                    | 0x0280
                    | 0x1001
                    | 0x1004
                    | 0x1400
            )
            | Tag(0x4000, 0x0010 | 0x4000)
    )
}

fn remove_identity_container(tag: Tag) -> bool {
    matches!(
        tag,
        // Previous cleanup claims do not describe this partial export.
        Tag(0x0012, 0x0063 | 0x0064)
        // Historical or encrypted copies can retain identifiers we cannot inspect.
        | Tag(0x0400, 0x0500 | 0x0550 | 0x0561)
        // Signatures and their parameters are invalid after rewriting the dataset.
        | Tag(0x4FFE, 0x0001) | Tag(0xFFFA, 0xFFFA)
    )
}

fn new_uid() -> String {
    format!("2.25.{}", u128::from_be_bytes(crate::random::uuid_v4()))
}

/// Directory record types for the non-image objects retained with a study (PS3.3 F.5).
pub fn document_record_type(class: &str) -> Option<&'static str> {
    if class == dicom_dictionary_std::uids::KEY_OBJECT_SELECTION_DOCUMENT_STORAGE {
        Some("KEY OBJECT DOC")
    } else if class.starts_with("1.2.840.10008.5.1.4.1.1.88.") {
        Some("SR DOCUMENT")
    } else if class.starts_with("1.2.840.10008.5.1.4.1.1.11.") || class == dicom_dictionary_std::uids::BASIC_STRUCTURED_DISPLAY_STORAGE {
        Some("PRESENTATION")
    } else {
        None
    }
}

/// Encode only the leaf record keys. Sequence items keep their DICOM value types.
fn directory_keys(obj: &DefaultDicomObject, kind: &str, number: String) -> Result<Vec<u8>> {
    use dicom_dictionary_std::tags::*;
    use dicom_encoding::text::SpecificCharacterSet;
    use dicom_core::value::DataSetSequence;
    use dicom_encoding::transfer_syntax::TransferSyntaxIndex;
    use dicom_transfer_syntax_registry::TransferSyntaxRegistry;

    let mut keys = InMemDicomObject::new_empty();
    keys.put(DataElement::new(INSTANCE_NUMBER, VR::IS, number));
    let required = if kind == "PRESENTATION" {
        &[PRESENTATION_CREATION_DATE, PRESENTATION_CREATION_TIME, CONTENT_LABEL][..]
    } else if kind == "SR DOCUMENT" {
        &[CONTENT_DATE, CONTENT_TIME, COMPLETION_FLAG, VERIFICATION_FLAG, CONCEPT_NAME_CODE_SEQUENCE][..]
    } else if kind == "KEY OBJECT DOC" {
        &[CONTENT_DATE, CONTENT_TIME, CONCEPT_NAME_CODE_SEQUENCE][..]
    } else { &[][..] };
    for &tag in required {
        let element = obj.get(tag).filter(|e| !e.is_empty())
            .with_context(|| format!("DICOMDIR {kind} requires {tag}"))?;
        keys.put(element.clone());
    }
    if kind == "PRESENTATION" {
        for (tag, vr) in [(CONTENT_DESCRIPTION, VR::LO), (CONTENT_CREATOR_NAME, VR::PN)] {
            keys.put(DataElement::new(tag, vr, value(obj, tag)));
        }
        for tag in [REFERENCED_SERIES_SEQUENCE, BLENDING_SEQUENCE, ALTERNATE_CONTENT_DESCRIPTION_SEQUENCE, CONTENT_CREATOR_IDENTIFICATION_CODE_SEQUENCE] {
            if let Some(element) = obj.get(tag) { keys.put(element.clone()); }
        }
    } else if matches!(kind, "SR DOCUMENT" | "KEY OBJECT DOC") {
        if let Some(items) = obj.get(CONTENT_SEQUENCE).and_then(|e| e.value().items()) {
            let modifiers: Vec<_> = items.iter().filter(|i| value(i, RELATIONSHIP_TYPE) == "HAS CONCEPT MOD").cloned().collect();
            if !modifiers.is_empty() {
                keys.put(DataElement::new(CONTENT_SEQUENCE, VR::SQ, DataSetSequence::new(modifiers, dicom_core::Length::UNDEFINED)));
            }
        }
        if kind == "SR DOCUMENT" && value(obj, VERIFICATION_FLAG) == "VERIFIED" {
            let date = obj.get(VERIFYING_OBSERVER_SEQUENCE).and_then(|e| e.value().items())
                .into_iter().flatten().map(|i| value(i, VERIFICATION_DATE_TIME)).filter(|s| !s.is_empty()).max()
                .context("Verified SR has no verification date and time")?;
            keys.put(DataElement::new(VERIFICATION_DATE_TIME, VR::DT, date));
        }
    }
    let mut bytes = Vec::new();
    let ts = TransferSyntaxRegistry.get(dicom_dictionary_std::uids::EXPLICIT_VR_LITTLE_ENDIAN).unwrap();
    keys.write_dataset_with_ts_cs(&mut bytes, ts, SpecificCharacterSet::ISO_IR_192)?;
    Ok(bytes)
}

struct InstanceRecord {
    patient_id: String,
    patient_name: String,
    study_uid: String,
    study_id: String,
    study_date: String,
    study_time: String,
    study_description: String,
    accession: String,
    series_uid: String,
    series_number: String,
    modality: String,
    kind: &'static str,
    keys: Vec<u8>,
    sop_uid: String,
    sop_class: String,
    transfer_syntax: String,
    file_id: String,
}

impl InstanceRecord {
    fn from_object(
        obj: &DefaultDicomObject,
        file_id: String,
        warnings: &mut Vec<crate::message::Note>,
    ) -> Result<Self> {
        let class = value(obj, Tag(0x0008, 0x0016));
        let kind = document_record_type(&class).unwrap_or("IMAGE");
        ensure!(kind != "IMAGE" || [Tag(0x7fe0, 0x0010), Tag(0x7fe0, 0x0008), Tag(0x7fe0, 0x0009)]
            .iter().any(|&tag| obj.get(tag).is_some()), "Unsupported DICOMDIR SOP Class {class}");
        let required = |tag: Tag, name: &str| -> Result<String> {
            let v = value(obj, tag);
            ensure!(!v.is_empty(), coded!("export.dicomdirRequires", "DICOMDIR requires {name}", name = name.to_string()));
            Ok(v)
        };
        let mut fallback = |tag, default: &str, label: &str| {
            let v = value(obj, tag);
            if v.is_empty() {
                warnings.push(note!("export.dicomdirDefault", "DICOMDIR uses {default} for missing {label}; source image bytes are preserved when de-identification is off", default = default.to_string(), label = label.to_string()));
                default.into()
            } else {
                v
            }
        };
        Ok(Self {
            patient_id: fallback(Tag(0x0010, 0x0020), "UNKNOWN", "PatientID"),
            patient_name: value(obj, Tag(0x0010, 0x0010)),
            study_uid: required(Tag(0x0020, 0x000D), "StudyInstanceUID")?,
            study_id: fallback(Tag(0x0020, 0x0010), "1", "StudyID"),
            study_date: fallback(Tag(0x0008, 0x0020), "19000101", "StudyDate"),
            study_time: fallback(Tag(0x0008, 0x0030), "000000", "StudyTime"),
            study_description: value(obj, Tag(0x0008, 0x1030)),
            accession: value(obj, Tag(0x0008, 0x0050)),
            series_uid: required(Tag(0x0020, 0x000E), "SeriesInstanceUID")?,
            series_number: fallback(Tag(0x0020, 0x0011), "1", "SeriesNumber"),
            modality: required(Tag(0x0008, 0x0060), "Modality")?,
            kind,
            keys: directory_keys(obj, kind, fallback(Tag(0x0020, 0x0013), "1", "InstanceNumber"))?,
            sop_uid: required(Tag(0x0008, 0x0018), "SOPInstanceUID")?,
            sop_class: required(Tag(0x0008, 0x0016), "SOPClassUID")?,
            transfer_syntax: obj.meta().transfer_syntax().to_string(),
            file_id,
        })
    }
}

struct DirectoryNode<'a> {
    kind: &'static str,
    fields: Vec<(Tag, &'static str, String)>,
    children: Vec<usize>,
    keys: &'a [u8],
}
impl DirectoryNode<'_> {
    fn new(kind: &'static str, fields: Vec<(Tag, &'static str, String)>) -> Self {
        Self {
            kind,
            fields,
            children: Vec::new(),
            keys: &[],
        }
    }
    fn encode(&self, next: u32, child: u32) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        element(&mut bytes, Tag(0x0004, 0x1400), "UL", &next.to_le_bytes())?;
        element(
            &mut bytes,
            Tag(0x0004, 0x1410),
            "US",
            &0xFFFFu16.to_le_bytes(),
        )?;
        element(&mut bytes, Tag(0x0004, 0x1420), "UL", &child.to_le_bytes())?;
        text_element(&mut bytes, Tag(0x0004, 0x1430), "CS", self.kind)?;
        let mut fields = self.fields.clone();
        fields.push((Tag(0x0008, 0x0005), "CS", "ISO_IR 192".into()));
        fields.sort_by_key(|field| field.0);
        for (tag, vr, value) in fields {
            text_element(&mut bytes, tag, vr, &value)?;
        }
        Ok(bytes)
    }
}

/// PS3.3 F.3: directory offsets are absolute, including the preamble and file meta.
fn build_dicomdir(instances: &[InstanceRecord]) -> Result<Vec<u8>> {
    ensure!(!instances.is_empty(), "Cannot create an empty DICOMDIR");
    let mut nodes: Vec<DirectoryNode> = Vec::new();
    let mut roots = Vec::new();
    let mut patients = HashMap::new();
    let mut studies = HashMap::new();
    let mut series = HashMap::new();
    for item in instances {
        let patient_key = (item.patient_id.clone(), item.patient_name.clone());
        let patient = *patients.entry(patient_key).or_insert_with(|| {
            let id = nodes.len();
            roots.push(id);
            nodes.push(DirectoryNode::new(
                "PATIENT",
                vec![
                    (Tag(0x0010, 0x0010), "PN", item.patient_name.clone()),
                    (Tag(0x0010, 0x0020), "LO", item.patient_id.clone()),
                ],
            ));
            id
        });
        let (study, owner) = *studies.entry(item.study_uid.clone()).or_insert_with(|| {
            let id = nodes.len();
            nodes[patient].children.push(id);
            nodes.push(DirectoryNode::new(
                "STUDY",
                vec![
                    (Tag(0x0008, 0x0020), "DA", item.study_date.clone()),
                    (Tag(0x0008, 0x0030), "TM", item.study_time.clone()),
                    (Tag(0x0008, 0x0050), "SH", item.accession.clone()),
                    (Tag(0x0008, 0x1030), "LO", item.study_description.clone()),
                    (Tag(0x0020, 0x000D), "UI", item.study_uid.clone()),
                    (Tag(0x0020, 0x0010), "SH", item.study_id.clone()),
                ],
            ));
            (id, patient)
        });
        ensure!(
            owner == patient,
            "Conflicting patient identity for the same StudyInstanceUID"
        );
        let (series_id, owner) = *series.entry(item.series_uid.clone()).or_insert_with(|| {
            let id = nodes.len();
            nodes[study].children.push(id);
            nodes.push(DirectoryNode::new(
                "SERIES",
                vec![
                    (Tag(0x0008, 0x0060), "CS", item.modality.clone()),
                    (Tag(0x0020, 0x000E), "UI", item.series_uid.clone()),
                    (Tag(0x0020, 0x0011), "IS", item.series_number.clone()),
                ],
            ));
            (id, study)
        });
        ensure!(
            owner == study,
            "Conflicting study for the same SeriesInstanceUID"
        );
        let id = nodes.len();
        nodes[series_id].children.push(id);
        let mut leaf = DirectoryNode::new(
            item.kind,
            vec![
                (Tag(0x0004, 0x1500), "CS", item.file_id.clone()),
                (Tag(0x0004, 0x1510), "UI", item.sop_class.clone()),
                (Tag(0x0004, 0x1511), "UI", item.sop_uid.clone()),
                (Tag(0x0004, 0x1512), "UI", item.transfer_syntax.clone()),
            ],
        );
        leaf.keys = &item.keys;
        nodes.push(leaf);
    }
    let mut meta = Vec::new();
    element(&mut meta, Tag(0x0002, 0x0001), "OB", &[0, 1])?;
    text_element(&mut meta, Tag(0x0002, 0x0002), "UI", "1.2.840.10008.1.3.10")?;
    text_element(&mut meta, Tag(0x0002, 0x0003), "UI", &new_uid())?;
    text_element(&mut meta, Tag(0x0002, 0x0010), "UI", "1.2.840.10008.1.2.1")?;
    text_element(
        &mut meta,
        Tag(0x0002, 0x0012),
        "UI",
        "2.25.192817402892490838045946208864248775881",
    )?;
    text_element(&mut meta, Tag(0x0002, 0x0013), "SH", "VEACOM_RUST_1")?;
    let mut bytes = vec![0; 128];
    bytes.extend_from_slice(b"DICM");
    element(
        &mut bytes,
        Tag(0x0002, 0x0000),
        "UL",
        &u32::try_from(meta.len())?.to_le_bytes(),
    )?;
    bytes.extend(meta);
    text_element(&mut bytes, Tag(0x0004, 0x1130), "CS", "VEACOM")?;
    let first_offset_at = bytes.len() + 8;
    element(&mut bytes, Tag(0x0004, 0x1200), "UL", &[0; 4])?;
    let last_offset_at = bytes.len() + 8;
    element(&mut bytes, Tag(0x0004, 0x1202), "UL", &[0; 4])?;
    element(&mut bytes, Tag(0x0004, 0x1212), "US", &0u16.to_le_bytes())?;
    let mut offsets = Vec::with_capacity(nodes.len());
    let mut cursor = bytes.len() + 12;
    for node in &nodes {
        offsets.push(u32::try_from(cursor).context("DICOMDIR exceeds the 4 GiB offset limit")?);
        cursor = cursor
            .checked_add(8 + node.encode(0, 0)?.len() + node.keys.len())
            .context("DICOMDIR size overflow")?;
    }
    ensure!((cursor as u64) <= crate::input_guard::MAX_META, "DICOMDIR exceeds the supported metadata size");
    let mut siblings = vec![None; nodes.len()];
    for children in std::iter::once(&roots).chain(nodes.iter().map(|n| &n.children)) {
        for pair in children.windows(2) {
            siblings[pair[0]] = Some(pair[1]);
        }
    }
    let mut sequence = Vec::new();
    for (i, node) in nodes.iter().enumerate() {
        let record = node.encode(
            siblings[i].map(|i| offsets[i]).unwrap_or(0),
            node.children.first().map(|i| offsets[*i]).unwrap_or(0),
        )?;
        sequence.extend_from_slice(&[0xFE, 0xFF, 0x00, 0xE0]);
        sequence.extend_from_slice(&u32::try_from(record.len() + node.keys.len())?.to_le_bytes());
        sequence.extend(record);
        sequence.extend_from_slice(node.keys);
    }
    bytes[first_offset_at..first_offset_at + 4].copy_from_slice(&offsets[roots[0]].to_le_bytes());
    bytes[last_offset_at..last_offset_at + 4]
        .copy_from_slice(&offsets[*roots.last().unwrap()].to_le_bytes());
    element(&mut bytes, Tag(0x0004, 0x1220), "SQ", &sequence)?;
    Ok(bytes)
}

fn text_element(bytes: &mut Vec<u8>, tag: Tag, vr: &str, text: &str) -> Result<()> {
    let mut value = text.as_bytes().to_vec();
    if value.len() % 2 != 0 {
        value.push(if vr == "UI" { 0 } else { b' ' });
    }
    element(bytes, tag, vr, &value)
}

/// Reopen the finished index before reporting a successful media export.
fn verify_dicomdir(path: &Path, records: &[InstanceRecord]) -> Result<()> {
    use dicom_dictionary_std::tags::*;
    let (_, file) = crate::input_guard::open_metadata_checked(path)?;
    let index = OpenFileOptions::new().from_reader(file)?;
    let items = index.element(DIRECTORY_RECORD_SEQUENCE)?.value().items().context("Missing directory records")?;
    let mut expected: HashMap<_, _> = records.iter().map(|r| (r.file_id.as_str(), r)).collect();
    for item in items {
        let Some(id) = item.get(REFERENCED_FILE_ID) else { continue };
        let id = id.to_str()?;
        let record = expected.remove(id.trim_end()).context("Unexpected file ID in saved DICOMDIR")?;
        ensure!(value(item, DIRECTORY_RECORD_TYPE) == record.kind
            && value(item, REFERENCED_SOP_CLASS_UID_IN_FILE) == record.sop_class
            && value(item, REFERENCED_SOP_INSTANCE_UID_IN_FILE) == record.sop_uid
            && value(item, REFERENCED_TRANSFER_SYNTAX_UID_IN_FILE) == record.transfer_syntax,
            "Saved DICOMDIR references a different instance");
    }
    ensure!(expected.is_empty(), "Missing file references in saved DICOMDIR");
    Ok(())
}

fn element(bytes: &mut Vec<u8>, tag: Tag, vr: &str, value: &[u8]) -> Result<()> {
    bytes.extend_from_slice(&tag.0.to_le_bytes());
    bytes.extend_from_slice(&tag.1.to_le_bytes());
    bytes.extend_from_slice(vr.as_bytes());
    if matches!(
        vr,
        "OB" | "OW" | "SQ" | "UN" | "UT" | "UC" | "UR" | "OD" | "OF" | "OL" | "OV"
    ) {
        bytes.extend_from_slice(&[0, 0]);
        bytes.extend_from_slice(&u32::try_from(value.len())?.to_le_bytes());
    } else {
        ensure!(
            value.len() <= u16::MAX as usize,
            "DICOMDIR field exceeds its VR length limit"
        );
        bytes.extend_from_slice(&(value.len() as u16).to_le_bytes());
    }
    bytes.extend_from_slice(value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // The tests read and write real files on the desktop's own file system.
    use std::fs;
    use dicom_object::open_file;
    use dicom_core::{DataElement, PrimitiveValue};

    #[test]
    fn full_cleanup_replaces_dates_and_drops_age_and_overlays() {
        let mut obj = InMemDicomObject::new_empty();
        obj.put_str(Tag(0x0008, 0x0020), VR::DA, "20260101");
        obj.put_str(Tag(0x0008, 0x0030), VR::TM, "101010");
        obj.put_str(Tag(0x0008, 0x002A), VR::DT, "20260101101010");
        obj.put_str(Tag(0x0010, 0x1010), VR::AS, "045Y");
        obj.put_str(Tag(0x0010, 0x0040), VR::CS, "F");
        obj.put_str(Tag(0x6000, 0x0022), VR::LO, "overlay");
        full_cleanup(&mut obj).unwrap();
        assert_eq!(value(&obj, Tag(0x0008, 0x0020)), "19000101");
        assert_eq!(value(&obj, Tag(0x0008, 0x0030)), "000000");
        assert_eq!(value(&obj, Tag(0x0008, 0x002A)), "19000101000000");
        assert!(obj.get(Tag(0x0010, 0x1010)).is_none());
        assert!(obj.get(Tag(0x6000, 0x0022)).is_none());
        assert!(value(&obj, Tag(0x0010, 0x0040)).is_empty());
    }

    #[test]
    fn full_cleanup_replaces_dates_inside_sequences() {
        use dicom_core::{Length, value::DataSetSequence};
        let sequence = |tag, items| DataElement::new(tag, VR::SQ, DataSetSequence::new(items, Length::UNDEFINED));
        let mut code = InMemDicomObject::new_empty();
        code.put_str(Tag(0x0008, 0x0100), VR::SH, "C-B1031");
        code.put_str(Tag(0x0040, 0xA121), VR::DA, "20241028");
        let mut radiopharm = InMemDicomObject::new_empty();
        radiopharm.put_str(Tag(0x0018, 0x1072), VR::TM, "235500.123");
        radiopharm.put_str(Tag(0x0018, 0x1078), VR::DT, "20241028235500.123+0000");
        radiopharm.put_str(Tag(0x0018, 0x1074), VR::DS, "250000000");
        radiopharm.put_str(Tag(0x0010, 0x1030), VR::DS, "70");
        radiopharm.put(sequence(Tag(0x0054, 0x0304), vec![code]));
        let mut obj = InMemDicomObject::new_empty();
        obj.put_str(Tag(0x0008, 0x0020), VR::DA, "20241029");
        obj.put(sequence(Tag(0x0054, 0x0016), vec![radiopharm]));
        full_cleanup(&mut obj).unwrap();
        let radiopharm = &obj.get(Tag(0x0054, 0x0016)).unwrap().items().unwrap()[0];
        assert!(radiopharm.get(Tag(0x0018, 0x1072)).is_none());
        assert!(radiopharm.get(Tag(0x0018, 0x1078)).is_none());
        assert_eq!(value(radiopharm, Tag(0x0018, 0x1074)), "250000000");
        assert!(radiopharm.get(Tag(0x0010, 0x1030)).is_none());
        let code = &radiopharm.get(Tag(0x0054, 0x0304)).unwrap().items().unwrap()[0];
        assert_eq!(value(code, Tag(0x0040, 0xA121)), "19000101");
        assert_eq!(value(code, Tag(0x0008, 0x0100)), "C-B1031");
        assert_eq!(value(&obj, Tag(0x0008, 0x0020)), "19000101");
        // The cleanup's own record is written once, on the instance, not in its items.
        assert!(radiopharm.get(Tag(0x0012, 0x0063)).is_none());
        assert!(obj.get(Tag(0x0012, 0x0063)).is_some());
    }
    use dicom_object::FileMetaTableBuilder;

    fn fixture(path: &Path, sop: &str) {
        let mut obj = InMemDicomObject::new_empty();
        for (tag, vr, v) in [
            (Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.2"),
            (Tag(0x0008, 0x0018), VR::UI, sop),
            (Tag(0x0008, 0x0020), VR::DA, "20240101"),
            (Tag(0x0008, 0x0030), VR::TM, "120000"),
            (Tag(0x0008, 0x0060), VR::CS, "CT"),
            (Tag(0x0010, 0x0010), VR::PN, "PRIVATE^PERSON"),
            (Tag(0x0010, 0x0020), VR::LO, "PATIENT42"),
            (Tag(0x0010, 0x1030), VR::DS, "70"),
            (Tag(0x0020, 0x000D), VR::UI, "2.25.10"),
            (Tag(0x0020, 0x000E), VR::UI, "2.25.11"),
            (Tag(0x0020, 0x0010), VR::SH, "ONE"),
            (Tag(0x0020, 0x0011), VR::IS, "1"),
            (Tag(0x0020, 0x0013), VR::IS, "1"),
            (Tag(0x0028, 0x0030), VR::DS, "0.5\\0.5"),
            (Tag(0x0028, 0x1052), VR::DS, "-1024"),
            (Tag(0x0028, 0x1053), VR::DS, "1"),
            (Tag(0x0028, 0x0004), VR::CS, "MONOCHROME2"),
            (Tag(0x0011, 0x0010), VR::LO, "PRIVATE DATA"),
        ] {
            obj.put_str(tag, vr, v);
        }
        for (tag, number) in [
            (Tag(0x0028, 0x0010), 2u16),
            (Tag(0x0028, 0x0011), 2),
            (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), 16),
            (Tag(0x0028, 0x0101), 16),
            (Tag(0x0028, 0x0102), 15),
            (Tag(0x0028, 0x0103), 0),
        ] {
            obj.put(DataElement::new(tag, VR::US, PrimitiveValue::from(number)));
        }
        obj.put(DataElement::new(
            Tag(0x7FE0, 0x0010),
            VR::OW,
            PrimitiveValue::U16(vec![0, 1, 4095, 65535].into()),
        ));
        let obj = obj
            .with_meta(FileMetaTableBuilder::new().transfer_syntax("1.2.840.10008.1.2.1"))
            .unwrap();
        obj.write_to_file(path).unwrap();
    }

    #[test]
    fn big_endian_ow_keeps_cell_values_when_written_little_endian() {
        let dir = crate::test_dir::tempdir().unwrap();
        for (pixels, expected) in [
            // 0x01020304 and 0xaabbccdd as read from big-endian OW: low word first (PS3.5 8.2).
            (PrimitiveValue::U16(vec![0x0304, 0x0102, 0xccdd, 0xaabb].into()), [4, 3, 2, 1, 0xdd, 0xcc, 0xbb, 0xaa]),
            // The same cells if the parser kept the file's raw bytes.
            (PrimitiveValue::U8(vec![3, 4, 1, 2, 0xcc, 0xdd, 0xaa, 0xbb].into()), [4, 3, 2, 1, 0xdd, 0xcc, 0xbb, 0xaa]),
        ] {
            let mut obj = InMemDicomObject::new_empty();
            obj.put(DataElement::new(Tag(0x0028, 0x0100), VR::US, PrimitiveValue::from(32_u16)));
            obj.put(DataElement::new(Tag(0x7fe0, 0x0010), VR::OW, pixels));
            let mut file = obj
                .with_meta(FileMetaTableBuilder::new()
                    .transfer_syntax("1.2.840.10008.1.2.2")
                    .media_storage_sop_class_uid("1.2.840.10008.5.1.4.1.1.7")
                    .media_storage_sop_instance_uid("2.25.1"))
                .unwrap();
            decompress_instance(&mut file).unwrap();
            assert_eq!(file.meta().transfer_syntax().trim_end_matches('\0'), "1.2.840.10008.1.2.1");
            let path = dir.path().join("le.dcm");
            file.write_to_file(&path).unwrap();
            let bytes = fs::read(&path).unwrap();
            assert_eq!(bytes[bytes.len() - 8..], expected);
        }
    }

    #[test]
    fn reported_folders_drop_the_windows_verbatim_prefix() {
        assert_eq!(reported(Path::new(r"\\?\C:\Users\a\export")), r"C:\Users\a\export");
        assert_eq!(reported(Path::new(r"\\?\UNC\server\share\export")), r"\\server\share\export");
        assert_eq!(reported(Path::new(r"\\?\Volume{1}\export")), r"\\?\Volume{1}\export");
        assert_eq!(reported(Path::new("/tmp/export")), "/tmp/export");
    }

    #[test]
    fn copy_preserves_bytes_deduplicates_paths_and_never_overwrites() {
        let dir = crate::test_dir::tempdir().unwrap();
        let source_dir = dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();
        let source = source_dir.join("one.dcm");
        fixture(&source, "2.25.101");
        let opts = ExportOptions { operation: None, cancelled: None,
            directory: dir.path().join("exports").to_string_lossy().into_owned(),
            anonymize: false,
            dicomdir: true,
            decompress: false,
            root: false,
            full: false,
            zip: false,
            smallest: false,
        };
        let first = export_series(&[source.clone(), source.clone()], &opts).unwrap();
        let second = export_series(std::slice::from_ref(&source), &opts).unwrap();
        assert_eq!(first.files, 1);
        assert_ne!(first.directory, second.directory);
        assert_eq!(
            fs::read(&source).unwrap(),
            fs::read(Path::new(&first.directory).join("DICOM/IM000001")).unwrap()
        );
        assert!(Path::new(&first.directory).join("DICOMDIR").is_file());
        assert!(
            export_series(
                &[source],
                &ExportOptions { operation: None, cancelled: None,
                    directory: source_dir.to_string_lossy().into_owned(),
                    anonymize: false,
                    dicomdir: false,
                    decompress: false,
                    root: false,
                    full: false,
                    zip: false,
                    smallest: false,
                }
            )
            .is_err()
        );
    }

    #[test]
    fn decimal_strings_longer_than_sixteen_characters_export_and_read_back() {
        // Some scanners write DS values longer than the standard's 16 characters; VEAcom Next once failed
        // to export them. They are copied as stored, with or without anonymization and a DICOMDIR.
        let dir = crate::test_dir::tempdir().unwrap();
        let source_dir = dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();
        let source = source_dir.join("long.dcm");
        fixture(&source, "2.25.401");
        let mut obj = open_file(&source).unwrap();
        let long = [
            (Tag(0x0020, 0x0032), r"-123.456789012345678\-98.7654321098765432\12.3456789012345678"),
            (Tag(0x0020, 0x0037), r"1.00000000000000000\0.000000000000000001\0\0\1.00000000000000000\0"),
            (Tag(0x0028, 0x0030), r"0.488281250000000001\0.488281250000000001"),
            (Tag(0x0018, 0x0050), "2.50000000000000001"),
            (Tag(0x0028, 0x1053), "1.00000000000000001"),
        ];
        for (tag, text) in long {
            obj.put_str(tag, VR::DS, text);
        }
        obj.write_to_file(&source).unwrap();
        for anonymize in [false, true] {
            let result = export_series(
                &[source.clone()],
                &ExportOptions { operation: None, cancelled: None,
                    directory: dir.path().join(format!("out-{anonymize}")).to_string_lossy().into_owned(),
                    anonymize,
                    dicomdir: true,
                    decompress: false,
                    root: false,
                    full: false,
                    zip: false,
                    smallest: false,
                },
            )
            .unwrap();
            let exported = open_file(Path::new(&result.directory).join("DICOM/IM000001")).unwrap();
            for (tag, text) in long {
                assert_eq!(value(&exported, tag), text, "{tag:?}");
            }
            let imported = crate::ingest::import(&[result.directory.clone()]).unwrap();
            assert_eq!(imported.sources.len(), 1);
            assert!((imported.sources[0].info.spacing[0] - 0.48828125).abs() < 1e-9);
        }
    }

    #[test]
    fn root_media_goes_to_the_destination_root_and_never_over_existing_media() {
        let dir = crate::test_dir::tempdir().unwrap();
        let source_dir = dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();
        let source = source_dir.join("one.dcm");
        fixture(&source, "2.25.102");
        let stick = dir.path().join("stick");
        fs::create_dir(&stick).unwrap();
        fs::write(stick.join("notes.txt"), b"left alone").unwrap();
        let opts = |directory: &Path, dicomdir: bool| ExportOptions { operation: None, cancelled: None,
            directory: directory.to_string_lossy().into_owned(),
            anonymize: false,
            dicomdir,
            decompress: false,
            root: true,
            full: false,
            zip: false,
            smallest: false,
        };
        let written = export_series(std::slice::from_ref(&source), &opts(&stick, true)).unwrap();
        assert_eq!(written.directory, reported(&stick.canonicalize().unwrap()));
        assert_eq!(fs::read(&source).unwrap(), fs::read(stick.join("DICOM/IM000001")).unwrap());
        let dicomdir = fs::read(stick.join("DICOMDIR")).unwrap();

        // A second copy is refused at the root: nothing there changes.
        let refused = export_series(std::slice::from_ref(&source), &opts(&stick, true)).unwrap_err();
        assert!(refused.to_string().contains("already has a DICOMDIR"));
        assert_eq!(fs::read(stick.join("DICOMDIR")).unwrap(), dicomdir);
        let mut names: Vec<_> = fs::read_dir(&stick).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, ["DICOM", "DICOMDIR", "notes.txt"]);
        assert_eq!(fs::read_dir(stick.join("DICOM")).unwrap().count(), 1);

        // Only media with a DICOMDIR goes to a root.
        let plain = dir.path().join("plain");
        fs::create_dir(&plain).unwrap();
        assert!(export_series(std::slice::from_ref(&source), &opts(&plain, false)).is_err());
        assert_eq!(fs::read_dir(&plain).unwrap().count(), 0);

        // A failed export takes away only what it made at the root.
        let broken = source_dir.join("broken.dcm");
        fs::write(&broken, b"not a DICOM file").unwrap();
        let other = dir.path().join("other");
        fs::create_dir(&other).unwrap();
        fs::write(other.join("notes.txt"), b"left alone").unwrap();
        assert!(export_series(&[source, broken], &opts(&other, true)).is_err());
        let left: Vec<_> = fs::read_dir(&other).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, ["notes.txt"]);
    }

    #[test]
    fn anonymization_preserves_pixels_and_quantitation_and_maps_related_uids() {
        let dir = crate::test_dir::tempdir().unwrap();
        let source_dir = dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();
        let a = source_dir.join("a.dcm");
        let b = source_dir.join("b.dcm");
        fixture(&a, "2.25.101");
        fixture(&b, "2.25.102");
        let result = export_series(
            &[a.clone(), b],
            &ExportOptions { operation: None, cancelled: None,
                directory: dir.path().join("out").to_string_lossy().into_owned(),
                anonymize: true,
                dicomdir: true,
                decompress: false,
                root: false,
                full: false,
                zip: false,
                smallest: false,
            },
        )
        .unwrap();
        let original = open_file(a).unwrap();
        let first = open_file(Path::new(&result.directory).join("DICOM/IM000001")).unwrap();
        let second = open_file(Path::new(&result.directory).join("DICOM/IM000002")).unwrap();
        assert_eq!(
            original
                .element(Tag(0x7FE0, 0x0010))
                .unwrap()
                .to_bytes()
                .unwrap(),
            first
                .element(Tag(0x7FE0, 0x0010))
                .unwrap()
                .to_bytes()
                .unwrap()
        );
        for tag in [
            Tag(0x0010, 0x1030),
            Tag(0x0028, 0x0030),
            Tag(0x0028, 0x1052),
        ] {
            assert_eq!(value(&original, tag), value(&first, tag));
        }
        assert_eq!(value(&first, Tag(0x0010, 0x0010)), "ANON");
        assert!(first.element(Tag(0x0011, 0x0010)).is_err());
        assert_ne!(
            value(&original, Tag(0x0020, 0x000E)),
            value(&first, Tag(0x0020, 0x000E))
        );
        assert_eq!(
            value(&first, Tag(0x0020, 0x000E)),
            value(&second, Tag(0x0020, 0x000E))
        );
        assert_eq!(
            value(&first, Tag(0x0010, 0x0020)),
            value(&second, Tag(0x0010, 0x0020))
        );
        assert_eq!(
            first.meta().media_storage_sop_instance_uid(),
            value(&first, Tag(0x0008, 0x0018))
        );
        assert!(!result.warnings.is_empty());
    }

    #[test]
    fn partial_cleanup_removes_identifying_comments_codes_and_inherited_claims() {
        use dicom_core::{Length, value::DataSetSequence};

        let dir = crate::test_dir::tempdir().unwrap();
        let source_dir = dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();
        let source = source_dir.join("identifying.dcm");
        fixture(&source, "2.25.301");
        let mut obj = open_file(&source).unwrap();
        let identifying_text = [
            (Tag(0x0020, 0x4000), VR::LT, "SECRET_IMAGE_COMMENT"),
            (Tag(0x0040, 0x0280), VR::ST, "SECRET_PROCEDURE_COMMENT"),
            (Tag(0x0040, 0x1400), VR::LT, "SECRET_REQUEST_COMMENT"),
            (Tag(0x0010, 0x1081), VR::LO, "SECRET_BRANCH_OF_SERVICE"),
            (Tag(0x0010, 0x0033), VR::LO, "SECRET_ALTERNATE_BIRTH_DATE"),
            (Tag(0x0018, 0x4000), VR::LT, "SECRET_ACQUISITION_COMMENT"),
            (Tag(0x0028, 0x4000), VR::LT, "SECRET_PRESENTATION_COMMENT"),
        ];
        for (tag, vr, text) in identifying_text {
            obj.put_str(tag, vr, text);
        }
        let mut identifying_code = InMemDicomObject::new_empty();
        identifying_code.put_str(Tag(0x0008, 0x0100), VR::SH, "SECRET_SITE");
        identifying_code.put_str(Tag(0x0008, 0x0102), VR::SH, "99PRIVATE");
        identifying_code.put_str(Tag(0x0008, 0x0104), VR::LO, "SECRET_HOSPITAL");
        let removed_sequences = [
            Tag(0x0008, 0x0082), // Institution Code Sequence
            Tag(0x0008, 0x1041), // Institutional Department Type Code Sequence
            Tag(0x0008, 0x0051), // Issuer of Accession Number Sequence
            Tag(0x0008, 0x1110), // Referenced Study Sequence
            Tag(0x0008, 0x1111), // Referenced Performed Procedure Step Sequence
            Tag(0x0008, 0x1120), // Referenced Patient Sequence
            Tag(0x0400, 0x0500), // Encrypted Attributes Sequence
            Tag(0x0400, 0x0561), // Original Attributes Sequence
            Tag(0x0012, 0x0064), // Inherited confidentiality profile claim
        ];
        for tag in removed_sequences {
            obj.put(DataElement::new(
                tag,
                VR::SQ,
                DataSetSequence::new(vec![identifying_code.clone()], Length::UNDEFINED),
            ));
        }
        obj.put_str(Tag(0x0012, 0x0062), VR::CS, "YES");
        obj.put_str(Tag(0x0012, 0x0063), VR::LO, "SECRET_OLD_CERTIFICATION");
        obj.put_str(Tag(0x0028, 0x0301), VR::CS, "YES");
        let mut nested = InMemDicomObject::new_empty();
        nested.put_str(Tag(0x0008, 0x1155), VR::UI, "2.25.301");
        nested.put_str(Tag(0x0010, 0x0010), VR::PN, "SECRET^PERSON");
        nested.put_str(Tag(0x0020, 0x4000), VR::LT, "SECRET_NESTED_COMMENT");
        nested.put_str(Tag(0x0011, 0x0010), VR::LO, "SECRET_NESTED_PRIVATE");
        nested.put_str(Tag(0x0012, 0x0062), VR::CS, "YES");
        obj.put(DataElement::new(
            Tag(0x0008, 0x2112),
            VR::SQ,
            DataSetSequence::new(vec![nested], Length::UNDEFINED),
        ));
        obj.write_to_file(&source).unwrap();

        let result = export_series(
            &[source],
            &ExportOptions { operation: None, cancelled: None,
                directory: dir.path().join("out").to_string_lossy().into_owned(),
                anonymize: true,
                dicomdir: true,
                decompress: false,
                root: false,
                full: false,
                zip: false,
                smallest: false,
            },
        )
        .unwrap();
        let image = Path::new(&result.directory).join("DICOM/IM000001");
        let exported = open_file(&image).unwrap();
        for (tag, _, _) in identifying_text {
            assert_eq!(value(&exported, tag), "", "identifier remains at {tag}");
        }
        for tag in removed_sequences {
            assert!(
                exported.get(tag).is_none(),
                "identifying sequence remains at {tag}"
            );
        }
        assert_eq!(value(&exported, Tag(0x0012, 0x0062)), "NO");
        assert_eq!(
            value(&exported, Tag(0x0012, 0x0063)),
            "VEAcom partial metadata cleanup; dates and pixels retained"
        );
        assert_eq!(value(&exported, Tag(0x0028, 0x0301)), "YES");
        let nested = &exported.get(Tag(0x0008, 0x2112)).unwrap().items().unwrap()[0];
        assert_eq!(value(nested, Tag(0x0012, 0x0062)), "NO");
        assert_eq!(
            value(nested, Tag(0x0008, 0x1155)),
            value(&exported, Tag(0x0008, 0x0018))
        );
        for path in [image, Path::new(&result.directory).join("DICOMDIR")] {
            let bytes = fs::read(path).unwrap();
            assert!(!bytes.windows(7).any(|window| window == b"SECRET_"));
            assert!(!bytes.windows(7).any(|window| window == b"SECRET^"));
        }
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.text.contains("burned-in"))
        );
    }

    #[test]
    fn partial_cleanup_preserves_pet_timing_and_quantitative_metadata() {
        use dicom_core::{Length, value::DataSetSequence};

        let mut obj = InMemDicomObject::new_empty();
        let retained = [
            (Tag(0x0008, 0x0020), VR::DA, "20241028"),
            (Tag(0x0008, 0x0022), VR::DA, "20241029"),
            (Tag(0x0008, 0x002A), VR::DT, "20241029001500.123+0000"),
            (Tag(0x0008, 0x0032), VR::TM, "001500.123"),
            (Tag(0x0008, 0x0201), VR::SH, "+0000"),
            (Tag(0x0010, 0x1010), VR::AS, "045Y"),
            (Tag(0x0010, 0x0040), VR::CS, "F"),
            (Tag(0x0010, 0x1020), VR::DS, "1.7"),
            (Tag(0x0010, 0x1030), VR::DS, "70"),
            (Tag(0x0028, 0x1052), VR::DS, "0"),
            (Tag(0x0028, 0x1053), VR::DS, "2.5"),
            (Tag(0x0054, 0x1001), VR::CS, "BQML"),
            (Tag(0x0054, 0x1102), VR::CS, "START"),
        ];
        for (tag, vr, text) in retained {
            obj.put_str(tag, vr, text);
        }
        let mut radiopharm = InMemDicomObject::new_empty();
        let injection = [
            (Tag(0x0018, 0x1072), VR::TM, "235500.123"),
            (Tag(0x0018, 0x1074), VR::DS, "250000000"),
            (Tag(0x0018, 0x1075), VR::DS, "6586.2"),
            (Tag(0x0018, 0x1078), VR::DT, "20241028235500.123+0000"),
        ];
        for (tag, vr, text) in injection {
            radiopharm.put_str(tag, vr, text);
        }
        obj.put(DataElement::new(
            Tag(0x0054, 0x0016),
            VR::SQ,
            DataSetSequence::new(vec![radiopharm], Length::UNDEFINED),
        ));
        IdentityMap::default().anonymize(&mut obj, false);
        for (tag, _, text) in retained {
            assert_eq!(value(&obj, tag), text);
        }
        let radiopharm = &obj.get(Tag(0x0054, 0x0016)).unwrap().items().unwrap()[0];
        for (tag, _, text) in injection {
            assert_eq!(value(radiopharm, tag), text);
        }
        assert_eq!(value(&obj, Tag(0x0012, 0x0062)), "NO");
    }

    #[test]
    fn partial_cleanup_blocks_private_pet_calibration_instead_of_changing_suv() {
        let dir = crate::test_dir::tempdir().unwrap();
        let source_dir = dir.path().join("source");
        fs::create_dir(&source_dir).unwrap();
        let source = source_dir.join("private-pet.dcm");
        fixture(&source, "2.25.401");
        let mut obj = open_file(&source).unwrap();
        obj.put_str(Tag(0x0008, 0x0060), VR::CS, "PT");
        obj.put_str(Tag(0x0054, 0x1001), VR::CS, "BQML");
        obj.put_str(Tag(0x7053, 0x0010), VR::LO, "Philips PET Private Group");
        obj.put_str(Tag(0x7053, 0x1000), VR::DS, "0.0025");
        obj.write_to_file(&source).unwrap();
        let output = dir.path().join("out");
        let mut opts = ExportOptions { operation: None, cancelled: None,
            directory: output.to_string_lossy().into_owned(),
            anonymize: true,
            dicomdir: false,
            decompress: false,
            root: false,
            full: false,
            zip: false,
            smallest: false,
        };
        let error = export_series(std::slice::from_ref(&source), &opts).unwrap_err();
        assert!(error.to_string().contains("private PET SUV calibration"));
        assert!(fs::read_dir(&output).unwrap().next().is_none());
        opts.anonymize = false;
        let result = export_series(std::slice::from_ref(&source), &opts).unwrap();
        assert_eq!(
            fs::read(&source).unwrap(),
            fs::read(Path::new(&result.directory).join("DICOM/IM000001")).unwrap()
        );
    }

    #[test]
    fn rle_decompression_preserves_stored_pixels_and_identity() {
        let dir = crate::test_dir::tempdir().unwrap();
        let sources = dir.path().join("source");
        fs::create_dir(&sources).unwrap();
        let source = sources.join("rle.dcm");
        fixture(&source, "2.25.202");
        let mut obj = open_file(&source).unwrap();
        let mut rle = vec![0u8; 64];
        rle[0..4].copy_from_slice(&2u32.to_le_bytes());
        rle[4..8].copy_from_slice(&64u32.to_le_bytes());
        rle[8..12].copy_from_slice(&70u32.to_le_bytes());
        rle.extend_from_slice(&[3, 0, 0, 15, 255, 128]);
        rle.extend_from_slice(&[3, 0, 1, 255, 255, 128]);
        obj.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OB,
            dicom_core::value::Value::PixelSequence(dicom_core::value::PixelFragmentSequence::new(
                vec![0],
                vec![rle],
            )),
        ));
        obj.update_meta(|meta| meta.transfer_syntax = "1.2.840.10008.1.2.5".into());
        obj.write_to_file(&source).unwrap();
        let result = export_series(
            &[source],
            &ExportOptions { operation: None, cancelled: None,
                directory: dir.path().join("out").to_string_lossy().into_owned(),
                anonymize: false,
                dicomdir: true,
                decompress: true,
                root: false,
                full: false,
                zip: false,
                smallest: false,
            },
        )
        .unwrap();
        let exported = open_file(Path::new(&result.directory).join("DICOM/IM000001")).unwrap();
        assert_eq!(exported.meta().transfer_syntax(), "1.2.840.10008.1.2.1");
        assert_eq!(value(&exported, Tag(0x0008, 0x0018)), "2.25.202");
        assert_eq!(value(&exported, Tag(0x0028, 0x1052)), "-1024");
        assert_eq!(value(&exported, Tag(0x0028, 0x0030)), "0.5\\0.5");
        assert_eq!(
            exported.decode_pixel_data().unwrap().data_ow(),
            vec![0, 1, 4095, 65535]
        );
        assert!(
            exported
                .element(Tag(0x7fe0, 0x0010))
                .unwrap()
                .value()
                .fragments()
                .is_none()
        );
        let dicomdir = open_file(Path::new(&result.directory).join("DICOMDIR")).unwrap();
        let records = dicomdir
            .element(Tag(0x0004, 0x1220))
            .unwrap()
            .items()
            .unwrap();
        let image = records
            .iter()
            .find(|item| value(item, Tag(0x0004, 0x1430)) == "IMAGE")
            .unwrap();
        assert_eq!(value(image, Tag(0x0004, 0x1512)), "1.2.840.10008.1.2.1");
    }

    #[test]
    fn directory_offsets_resolve_to_items_and_valid_record_tree() {
        let dir = crate::test_dir::tempdir().unwrap();
        let input = dir.path().join("one.dcm");
        fixture(&input, "2.25.101");
        let obj = open_file(input).unwrap();
        let record =
            InstanceRecord::from_object(&obj, "DICOM\\IM000001".into(), &mut Vec::new()).unwrap();
        let bytes = build_dicomdir(&[record]).unwrap();
        let file = dir.path().join("DICOMDIR");
        fs::write(&file, &bytes).unwrap();
        let directory = open_file(file).unwrap();
        let root: u32 = directory
            .element(Tag(0x0004, 0x1200))
            .unwrap()
            .to_int()
            .unwrap();
        let mut offset = root as usize;
        for kind in ["PATIENT", "STUDY", "SERIES", "IMAGE"] {
            assert_eq!(&bytes[offset..offset + 4], &[0xFE, 0xFF, 0x00, 0xE0]);
            let body = offset + 8;
            assert_eq!(&bytes[body + 34..body + 38], &[4, 0, 0x30, 0x14]);
            assert_eq!(&bytes[body + 42..body + 42 + kind.len()], kind.as_bytes());
            offset = u32::from_le_bytes(bytes[body + 30..body + 34].try_into().unwrap()) as usize;
        }
        assert_eq!(offset, 0);
        let sequence = directory
            .element(Tag(0x0004, 0x1220))
            .unwrap()
            .items()
            .unwrap();
        assert_eq!(sequence.len(), 4);
    }
}
