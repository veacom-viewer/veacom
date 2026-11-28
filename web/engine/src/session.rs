//! The open study in a browser: the catalog of imported series, their extracted archives and a cache of decoded
//! volumes, with the same limits and checks as the desktop server's session (native/src/main.rs). Calls arrive one at
//! a time from the Worker, so nothing here is shared or locked.

use anyhow::{Context, Result};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};
use veacom_core::{
    archive_temp::ArchiveTempDir,
    catalog, coded, decode,
    export::{self, ExportOptions, ExportResult},
    ingest,
    message::Coded,
    model::{FrameMetadata, ImportResult, PixelBuffer, SourceSeries},
    progress,
    source_file::SourceFile,
    tags, vfs,
};

const MAX_OPEN_ARCHIVES: usize = 24;

/// A file the export wrote, by its path inside the export and its bytes.
type NamedFile = (String, Vec<u8>);

/// Decoded volumes kept for repeated requests, least recently used first out.
struct Cache {
    entries: VecDeque<(String, Arc<PixelBuffer>)>,
    bytes: usize,
    limit: usize,
}
impl Cache {
    fn get(&mut self, id: &str) -> Option<Arc<PixelBuffer>> {
        let at = self.entries.iter().position(|(key, _)| key == id)?;
        let item = self.entries.remove(at)?;
        let value = item.1.clone();
        self.entries.push_back(item);
        Some(value)
    }
    fn remove(&mut self, id: &str) {
        if let Some(at) = self.entries.iter().position(|(key, _)| key == id)
            && let Some((_, value)) = self.entries.remove(at)
        {
            self.bytes -= value.bytes().len();
        }
    }
    /// Drops the least recently used volumes until `bytes` more fit, or none is left.
    fn make_room(&mut self, bytes: usize) {
        while self.bytes + bytes > self.limit {
            let Some((_, old)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.bytes().len();
        }
    }
    fn put(&mut self, id: String, value: Arc<PixelBuffer>) {
        self.remove(&id);
        let bytes = value.bytes().len();
        self.make_room(bytes);
        if bytes <= self.limit {
            self.bytes += bytes;
            self.entries.push_back((id, value));
        }
    }
}

/// One frame's pixels and where they came from, for the viewer's checks that the frame is the one it asked for.
pub struct FramePixels {
    pub pixels: PixelBuffer,
    pub components: u8,
    pub metadata: FrameMetadata,
}

/// Metadata a browser Worker needs to assemble a single-file-per-frame series chunk by chunk.
#[cfg_attr(
    not(target_arch = "wasm32"),
    allow(dead_code, reason = "only serialized in wasm32 api.rs")
)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumePlan {
    pub cached: bool,
    pub frames: usize,
    pub frame_samples: usize,
    pub components: u8,
    pub widening: Vec<&'static str>,
    pub chunkable: bool,
    pub max_bytes: usize,
    pub cache_limit: usize,
}

pub struct Session {
    sources: BTreeMap<String, Arc<SourceSeries>>,
    catalog_bytes: BTreeMap<String, usize>,
    archives: Vec<ArchiveTempDir>,
    cache: Cache,
    /// The ids of the last import, in its order (for the measurement page, which names series by position).
    pub last_import: Vec<String>,
    /// Imports so far: each import's series carry its number as their source revision, which a measurement names so
    /// that it is never sampled from a series imported again since.
    imports: u64,
    /// The catalog revision the next new series gets: a series imported again is a new one to every request that named
    /// the old (`check_revision`).
    revisions: u64,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            sources: BTreeMap::new(),
            catalog_bytes: BTreeMap::new(),
            archives: Vec::new(),
            // As the desktop's default (VEACOM_CACHE_MIB): 256 MiB of decoded volumes.
            cache: Cache {
                entries: VecDeque::new(),
                bytes: 0,
                limit: 256 * 1024 * 1024,
            },
            last_import: Vec::new(),
            imports: 0,
            revisions: 0,
        }
    }
}

/// Refuses a request made for an earlier import of the series (the desktop engine's check).
fn check_revision(series: &SourceSeries, expected: Option<u64>) -> Result<()> {
    anyhow::ensure!(
        expected.is_none_or(|revision| revision == series.info.catalog_revision),
        coded!(
            "series.replaced",
            "This series was replaced. Open the current series again."
        )
    );
    Ok(())
}

fn not_found() -> anyhow::Error {
    coded!("series.notFound", "Series not found; import it first").into()
}

/// Ends the progress record when the work ends, also by an error.
struct FinishProgress;
impl Drop for FinishProgress {
    fn drop(&mut self) {
        progress::finish();
    }
}

impl Session {
    pub fn source(&self, id: &str) -> Result<Arc<SourceSeries>> {
        self.sources.get(id).cloned().ok_or_else(not_found)
    }

    pub fn list(&self) -> ImportResult {
        ImportResult {
            series: self
                .sources
                .values()
                .map(|source| source.info.clone())
                .collect(),
            warnings: Default::default(),
        }
    }

    /// Imports files, folders or ZIPs by path and adds their series to the catalog, within the limits and with the
    /// patient check the desktop's session applies (`veacom_core::catalog`).
    pub fn import(&mut self, paths: &[String]) -> Result<ImportResult> {
        anyhow::ensure!(
            paths.len() <= ingest::MAX_FILES,
            coded!(
                "import.tooManyPaths",
                "Select at most 50,000 paths per import"
            )
        );
        let incoming_archives = paths
            .iter()
            .filter(|path| ingest::is_zip_file(Path::new(path)))
            .count();
        anyhow::ensure!(
            incoming_archives <= MAX_OPEN_ARCHIVES.saturating_sub(self.archives.len()),
            coded!(
                "import.browserArchiveLimit",
                "A session can hold at most {limit} ZIP archives at once. Select fewer ZIPs or close all series from an open archive.",
                limit = MAX_OPEN_ARCHIVES.to_string()
            )
        );
        progress::check()?;
        progress::begin("import", 0);
        self.imports += 1;
        let mut imported = {
            let _finish = FinishProgress;
            // A browser reads no disc once, so it keeps no disc's copy for a later import (ingest::DiscCopy).
            ingest::import_session(paths, None, self.imports, &[])?
        };
        for incoming in &mut imported.sources {
            self.revisions += 1;
            Arc::make_mut(incoming).info.catalog_revision = self.revisions;
        }
        let costs = catalog::costs(&imported.sources)?;
        let mut result = ImportResult {
            series: imported
                .sources
                .iter()
                .map(|source| source.info.clone())
                .collect(),
            warnings: imported.warnings.into(),
        };
        if catalog::patient_conflict(&imported.sources, self.sources.values()) {
            result.warnings.push(catalog::conflict_note());
        }
        anyhow::ensure!(
            catalog::fits(
                &self.sources,
                &self.catalog_bytes,
                &imported.sources,
                &costs
            ),
            Coded(catalog::full_note())
        );
        self.last_import = imported
            .sources
            .iter()
            .map(|source| source.info.id.clone())
            .collect();
        for source in imported.sources {
            self.cache.remove(&source.info.id);
            self.catalog_bytes
                .insert(source.info.id.clone(), costs[&source.info.id]);
            self.sources.insert(source.info.id.clone(), source);
        }
        self.archives.extend(imported.archives);
        Ok(result)
    }

    /// Drops archive directories as soon as their last series goes. The remaining paths also own the page's Blob files.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        allow(dead_code, reason = "only the page calls it")
    )]
    pub fn prune_archives(&mut self) -> HashSet<PathBuf> {
        let paths: HashSet<_> = self
            .sources
            .values()
            .flat_map(|source| {
                let frames = source.frames.iter().map(|frame| frame.source.path.clone());
                frames.chain(source.documents.iter().map(|file| file.path.clone()))
            })
            .collect();
        self.archives
            .retain(|archive| paths.iter().any(|path| path.starts_with(archive.path())));
        paths
    }

    /// Takes series off the catalog; once it is empty, the extracted archives go too.
    pub fn remove(&mut self, ids: &[String]) -> (usize, usize) {
        let mut removed = 0;
        for id in ids {
            if self.sources.remove(id).is_some() {
                removed += 1;
            }
            self.catalog_bytes.remove(id);
            self.cache.remove(id);
        }
        if self.sources.is_empty() {
            self.archives.clear();
        }
        (removed, self.sources.len())
    }

    /// Whether the series' decoded volume is in the cache.
    pub fn has_volume(&self, id: &str) -> bool {
        self.cache.entries.iter().any(|(key, _)| key == id)
    }

    /// Describes how a browser Worker can decode a volume chunk by chunk without a full-volume WASM allocation.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        allow(dead_code, reason = "only the browser Worker calls volumePlan")
    )]
    pub fn volume_plan(&self, id: &str, revision: Option<u64>) -> Result<VolumePlan> {
        let series = self.source(id)?;
        check_revision(&series, revision)?;
        Ok(VolumePlan {
            cached: self.has_volume(id),
            frames: series.frames.len(),
            frame_samples: decode::frame_sample_count(&series)?,
            components: series.info.components,
            widening: decode::volume_widening_order(&series).to_vec(),
            chunkable: decode::is_single_file_per_frame(&series),
            max_bytes: decode::MAX_DECODED_VOLUME_BYTES,
            cache_limit: self.cache.limit,
        })
    }

    /// Validates series existence and catalog revision before decoding a frame chunk.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        allow(dead_code, reason = "only the browser Worker calls volumeChunk")
    )]
    pub fn volume_chunk_source(
        &self,
        id: &str,
        revision: Option<u64>,
    ) -> Result<Arc<SourceSeries>> {
        let series = self.source(id)?;
        check_revision(&series, revision)?;
        Ok(series)
    }

    /// Populates `Session::cache` from a chunk-assembled volume when it fits the cache budget, so whole-volume
    /// sampling and repeat volume requests reuse the decoded pixels without decoding a second time.
    #[cfg_attr(
        not(target_arch = "wasm32"),
        allow(dead_code, reason = "only the browser Worker calls cacheVolume")
    )]
    pub fn cache_volume_with(
        &mut self,
        id: &str,
        revision: Option<u64>,
        pixel_type: &str,
        byte_len: usize,
        fill: impl FnOnce(&mut [u8]) -> Result<()>,
    ) -> Result<bool> {
        let series = self.source(id)?;
        check_revision(&series, revision)?;
        let frame_samples = decode::frame_sample_count(&series)?;
        let total_samples = frame_samples
            .checked_mul(series.frames.len())
            .context("Volume dimensions overflow")?;
        let sample_bytes = match pixel_type {
            "uint8" => 1usize,
            "int16" | "uint16" => 2,
            "float32" => 4,
            "float64" => 8,
            _ => anyhow::bail!("Unsupported cached pixel type {pixel_type}"),
        };
        let expected_bytes = total_samples
            .checked_mul(sample_bytes)
            .context("Volume byte size overflow")?;
        anyhow::ensure!(
            byte_len == expected_bytes,
            "Cached volume byte length ({byte_len}) does not match expected size ({expected_bytes})"
        );
        if expected_bytes > self.cache.limit {
            return Ok(false);
        }
        // Evict older cached volumes before allocating so WASM linear memory does not hold both at once.
        self.cache.remove(id);
        self.cache.make_room(expected_bytes);
        let mut buffer = PixelBuffer::zeroed(pixel_type, total_samples)
            .context("Unsupported cached pixel type")?;
        fill(buffer.bytes_mut())?;
        self.cache.put(id.to_owned(), Arc::new(buffer));
        Ok(true)
    }

    /// The whole series decoded, from the cache when it is there. `revision`: the import the request was made for.
    pub fn volume(&mut self, id: &str, revision: Option<u64>) -> Result<Arc<PixelBuffer>> {
        let series = self.source(id)?;
        check_revision(&series, revision)?;
        if let Some(volume) = self.cache.get(id) {
            return Ok(volume);
        }
        // The volumes that this one will push out of the cache go before it is decoded, not after: this module's memory
        // never shrinks, so a moment with both in it would keep the page that much bigger. Room is made for the least
        // the volume can take, so no volume goes that would not have gone once it is in. If the decode fails or is
        // cancelled, they have gone all the same, and are decoded again when asked for.
        self.cache
            .make_room(decode::least_volume_bytes(&series).unwrap_or(0));
        progress::check()?;
        progress::begin("decode", series.frames.len());
        let volume = {
            let _finish = FinishProgress;
            Arc::new(decode::decode_volume(&series)?)
        };
        self.cache.put(id.to_owned(), volume.clone());
        Ok(volume)
    }

    pub fn frame(&self, id: &str, index: usize, revision: Option<u64>) -> Result<FramePixels> {
        let series = self.source(id)?;
        check_revision(&series, revision)?;
        let frame = series
            .frames
            .get(index)
            .context("Frame index is out of bounds")?;
        let metadata = frame.metadata.clone();
        Ok(FramePixels {
            pixels: decode::decode_frame(&series, index)?,
            components: series.info.components,
            metadata,
        })
    }

    /// The tags of the file holding frame `frame` (the slice shown), or of the series' first frame.
    /// A series that is a document (an encapsulated PDF, a report) shows its document's tags.
    pub fn tags(
        &self,
        id: &str,
        frame: Option<usize>,
        revision: Option<u64>,
    ) -> Result<serde_json::Value> {
        let series = self.source(id)?;
        check_revision(&series, revision)?;
        if let Some(file) = series.documents.first() {
            return Ok(serde_json::to_value(tags::read_source_tags(
                file.open()?,
                &file.path,
            )?)?);
        }
        let frame = &series.frames[frame
            .filter(|index| *index < series.frames.len())
            .unwrap_or(0)];
        if frame.ordinary_image {
            return Ok(serde_json::json!([]));
        }
        Ok(serde_json::to_value(tags::read_source_tags(
            frame.source.open()?,
            &frame.source.path,
        )?)?)
    }

    /// Exports series (or one frame of one series) as the desktop does, into memory instead of a folder, and returns the
    /// written files by their path inside the export (`VEACOM_…/DICOM/IM000001`, `VEACOM_…/DICOMDIR`), for the page to
    /// pack into one download. `options` are the desktop's export options (anonymize, full, dicomdir, decompress); a
    /// folder of its own (`root`) and ZIP re-encoding are desktop-only. `cancelled` stops the export between files.
    /// A full cleanup needs, for every series, the catalog revision whose pixels the reader reviewed (`reviewed`), as
    /// on the desktop.
    pub fn export(
        &self,
        ids: &[String],
        frame: Option<usize>,
        options: serde_json::Value,
        reviewed: &BTreeMap<String, u64>,
        cancelled: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(ExportResult, Vec<NamedFile>)> {
        let mut ids = ids.to_vec();
        ids.sort();
        ids.dedup();
        anyhow::ensure!(
            !ids.is_empty(),
            coded!("export.noSeries", "Select at least one series to export")
        );
        anyhow::ensure!(
            frame.is_none() || ids.len() == 1,
            "Select exactly one series for current-slice export."
        );
        let full_cleanup = options["anonymize"].as_bool().unwrap_or(false)
            && options["full"].as_bool().unwrap_or(false);
        let mut files: Vec<Arc<SourceFile>> = Vec::new();
        for id in &ids {
            let series = self.source(id)?;
            if full_cleanup {
                let revision = reviewed.get(id).ok_or_else(|| {
                    coded!("export.pixelReview", "Review the selected images for identifying text before a full cleanup export.")
                })?;
                check_revision(&series, Some(*revision))?;
            }
            anyhow::ensure!(
                series.frames.iter().all(|frame| !frame.ordinary_image),
                coded!(
                    "export.ordinaryImages",
                    "Ordinary images cannot be exported as original DICOM"
                )
            );
            match frame {
                Some(index) => {
                    let frame = series.frames.get(index).ok_or_else(|| {
                        coded!(
                            "export.sourceFrame",
                            "No acquired DICOM frame at this index"
                        )
                    })?;
                    anyhow::ensure!(
                        frame.metadata.source_frame_number.is_none(),
                        coded!(
                            "export.multiframeSlice",
                            "This slice belongs to a multiframe DICOM. Choose the whole series or export this slice as an image."
                        )
                    );
                    files.push(frame.source.clone());
                }
                None => {
                    files.extend(series.frames.iter().map(|frame| frame.source.clone()));
                    files.extend(series.documents.iter().cloned());
                }
            }
        }
        anyhow::ensure!(
            !files.is_empty(),
            coded!("export.noSeries", "Select at least one series to export")
        );
        files.sort_by(|a, b| a.path.cmp(&b.path));
        files.dedup_by(|a, b| a.path == b.path && a.same_contents(b));
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let base = format!(
            "/out/{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let mut options: ExportOptions = serde_json::from_value(serde_json::json!({
            "directory": base,
            "anonymize": options["anonymize"].as_bool().unwrap_or(false),
            "full": options["full"].as_bool().unwrap_or(false),
            "dicomdir": options["dicomdir"].as_bool().unwrap_or(false),
            "decompress": options["decompress"].as_bool().unwrap_or(false),
        }))?;
        options.cancelled = Some(cancelled);
        let result = export::export_indexed(&files, &options);
        // Whatever happened, the copy in memory goes once it is read.
        let written = result
            .as_ref()
            .ok()
            .map(|_| read_tree(Path::new(&base)))
            .transpose();
        let _ = vfs::remove_dir_all(&base);
        Ok((result?, written?.unwrap_or_default()))
    }
}

/// Every file under `root`, by its path below `root`.
fn read_tree(root: &Path) -> Result<Vec<NamedFile>> {
    let mut out = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in vfs::read_dir(&folder)? {
            let path = entry?.path();
            if vfs::metadata(&path)?.is_dir() {
                pending.push(path);
                continue;
            }
            let mut bytes = Vec::new();
            vfs::File::open(&path)?.read_to_end(&mut bytes)?;
            let name = path
                .strip_prefix(root)?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push((name, bytes));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::Session;
    use std::sync::Arc;
    use veacom_core::{
        geometry::{self, FrameGeometry},
        model::{Frame, FrameMetadata, PhaseHints, Series, SourceSeries},
        source_file::SourceFile,
        window::{self, Window},
    };

    fn synthetic_series(id: &str, revision: u64) -> Arc<SourceSeries> {
        let info = Series {
            id: id.to_owned(),
            catalog_revision: revision,
            source_revision: revision,
            uid: format!("1.2.3.{id}"),
            study_uid: "1.2.3".to_owned(),
            patient_name: "Synthetic^Cache".to_owned(),
            patient_id: "SYNTH".to_owned(),
            study_date: "20260101".to_owned(),
            description: "Synthetic CT".to_owned(),
            modality: "CT".to_owned(),
            series_number: 1,
            dimensions: [2, 2, 2],
            spacing: [1.0, 1.0, 1.0],
            origin: [0.0, 0.0, 0.0],
            direction: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            window_center: 40.0,
            window_width: 400.0,
            value_unit: "HU".to_owned(),
            can_reconstruct: true,
            spacing_known: true,
            orientation_known: true,
            pixel_type: "int16".to_owned(),
            components: 1,
            photometric_interpretation: "MONOCHROME2".to_owned(),
            ..Default::default()
        };
        let path =
            std::env::temp_dir().join(format!("veacom-cache-test-{}-{id}.dcm", std::process::id()));
        // Minimal Part 10 DICOM header (preamble + DICM + Group Length + Transfer Syntax UID 1.2.840.10008.1.2.1).
        let mut header = vec![0u8; 128];
        header.extend_from_slice(b"DICM");
        header.extend_from_slice(&[0x02, 0x00, 0x00, 0x00, b'U', b'L', 4, 0, 28, 0, 0, 0]);
        header.extend_from_slice(&[0x02, 0x00, 0x10, 0x00, b'U', b'I', 20, 0]);
        header.extend_from_slice(b"1.2.840.10008.1.2.1\0");
        std::fs::write(&path, &header).expect("write temp header");
        let (missing, _, _) = SourceFile::dicom(&path).expect("index temp header");
        let _ = std::fs::remove_file(&path);
        let frame = |z: usize| Frame {
            source: missing.clone(),
            index: 0,
            cine: None,
            sop_uid: format!("1.2.3.{id}.{z}"),
            instance_number: (z + 1) as i32,
            geometry: FrameGeometry {
                position: Some([0.0, 0.0, z as f64]),
                orientation: Some([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
                pixel_spacing: Some([1.0, 1.0]),
                slice_thickness: Some(1.0),
            },
            slope: 1.0,
            intercept: 0.0,
            activity: None,
            ordinary_image: false,
            jpeg_component_threads: 0,
            raw_pixels: None,
            voi_lut: None,
            segmentation: None,
            metadata: FrameMetadata {
                origin: [0.0, 0.0, z as f64],
                direction: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
                spacing: [1.0, 1.0, 1.0],
                position_known: true,
                orientation_known: true,
                spacing_known: true,
                instance_number: Some((z + 1) as i32),
                sop_instance_uid: format!("1.2.3.{id}.{z}"),
                source_frame_number: None,
                window_center: None,
                window_width: None,
                padding_range: None,
                padding_is_nan: false,
                segment_number: None,
                referenced_sop_instance_uid: String::new(),
                referenced_frame_number: None,
                voi_lut: None,
                voi_function: None,
                nm: None,
                projection: None,
            },
            phase_hints: PhaseHints::default(),
        };
        Arc::new(SourceSeries {
            info,
            frames: vec![frame(0), frame(1)],
            geometry: geometry::assemble(&[]),
            documents: Vec::new(),
        })
    }

    #[test]
    fn cache_volume_with_populates_session_cache_and_prevents_second_decode() {
        let mut session = Session::default();
        let series = synthetic_series("ct-cached", 3);
        session
            .sources
            .insert("ct-cached".to_owned(), series.clone());

        let plan = session.volume_plan("ct-cached", Some(3)).expect("plan");
        assert!(!plan.cached);
        assert_eq!(plan.cache_limit, 256 * 1024 * 1024);

        let samples: [i16; 8] = [-100, -50, 0, 50, 100, 150, 200, 250];
        let raw: Vec<u8> = samples.iter().flat_map(|v| v.to_le_bytes()).collect();

        // Wrong revision and wrong length must be rejected.
        assert!(
            session
                .cache_volume_with("ct-cached", Some(2), "int16", raw.len(), |_| Ok(()))
                .is_err()
        );
        assert!(
            session
                .cache_volume_with("ct-cached", Some(3), "int16", raw.len() - 2, |_| Ok(()))
                .is_err()
        );

        // Valid chunk-assembled buffer enters Session::cache.
        let cached = session
            .cache_volume_with("ct-cached", Some(3), "int16", raw.len(), |dst| {
                dst.copy_from_slice(&raw);
                Ok(())
            })
            .expect("cache volume");
        assert!(cached);
        assert!(session.has_volume("ct-cached"));
        assert!(
            session
                .volume_plan("ct-cached", Some(3))
                .expect("plan2")
                .cached
        );

        // Subsequent volume() and whole-volume window sample succeed from Session::cache without touching disk.
        let pixels = session.volume("ct-cached", Some(3)).expect("cached volume");
        let pixels2 = session
            .volume("ct-cached", Some(3))
            .expect("cached volume 2");
        assert!(Arc::ptr_eq(&pixels, &pixels2));
        let win = window::calculate(
            &series,
            &pixels,
            &Window {
                frame: None,
                plane: None,
                automatic: false,
            },
        )
        .expect("whole-volume window");
        assert_eq!(win["windowCenter"], 75.0);
        assert_eq!(win["windowWidth"], 350.0);

        // Oversized volume returns Ok(false) without caching.
        session.cache.limit = 8;
        let skipped = session
            .cache_volume_with("ct-cached", Some(3), "int16", raw.len(), |_| {
                panic!("fill must not run when exceeding cache limit")
            })
            .expect("skip oversize");
        assert!(!skipped);
    }
}
