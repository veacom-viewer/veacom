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
    fn put(&mut self, id: String, value: Arc<PixelBuffer>) {
        self.remove(&id);
        let bytes = value.bytes().len();
        while self.bytes + bytes > self.limit {
            let Some((_, old)) = self.entries.pop_front() else {
                break;
            };
            self.bytes -= old.bytes().len();
        }
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
            ingest::import_session(paths, None, self.imports)?
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
    #[cfg_attr(
        not(feature = "threads"),
        allow(dead_code, reason = "only the threaded build calls it")
    )]
    pub fn has_volume(&self, id: &str) -> bool {
        self.cache.entries.iter().any(|(key, _)| key == id)
    }

    /// The whole series decoded, from the cache when it is there. `revision`: the import the request was made for.
    pub fn volume(&mut self, id: &str, revision: Option<u64>) -> Result<Arc<PixelBuffer>> {
        let series = self.source(id)?;
        check_revision(&series, revision)?;
        if let Some(volume) = self.cache.get(id) {
            return Ok(volume);
        }
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
