//! The user's files as the engine's byte sources: a `File` (a Blob) is listed in the engine's in-memory file system
//! (`veacom_core::memory_fs`) and read on request with `Blob.slice()` through `FileReaderSync`, so nothing is copied
//! up front and only the bytes the engine asks for are read.
//!
//! Each read from a Blob costs about a millisecond whatever its size, so reads are served from pieces: 64 KiB, one read
//! for a whole DICOM header however the parser walks it; 1 MiB for large files (ZIPs, read from start to end).
//! Requests of a piece or more (pixel data) go to the Blob directly. The page may also hand over a file's first piece,
//! read in parallel beforehand.
//!
//! Blob objects belong to the thread (Worker) that received them, so they are kept per thread and the sources the
//! engine holds refer to them by number. Work on other threads (the threads build's parallel decoding) reads a file
//! only once it is held whole in the module's shared memory (`hold`), and the memory is given back after (`release`).
//!
//! A file stays listed only while a series reads from it: after each import and each removal, `retain` forgets the
//! rest (a failed import's files, a ZIP once extracted, a closed series' files), and `drop_heads` the first pieces read
//! ahead for the import.

use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    io,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
};
use veacom_core::memory_fs::{self, Source};
use wasm_bindgen::JsCast;

const PIECE: u64 = 64 * 1024;
const LARGE_PIECE: u64 = 1024 * 1024;
const LARGE_FILE: u64 = 16 * 1024 * 1024;
const KEPT_PIECES: usize = 64;

/// A piece read lately: the file's id, the piece's index in it and its bytes.
type Piece = (u32, u64, Rc<Vec<u8>>);

fn piece_size(length: u64) -> u64 {
    if length > LARGE_FILE {
        LARGE_PIECE
    } else {
        PIECE
    }
}

static NEXT: AtomicU32 = AtomicU32::new(1);

#[derive(Default)]
struct Stats {
    reads: u64,
    bytes: u64,
    ms: f64,
}

thread_local! {
    static BLOBS: RefCell<HashMap<u32, web_sys::Blob>> = RefCell::new(HashMap::new());
    static PIECES: RefCell<VecDeque<Piece>> = const { RefCell::new(VecDeque::new()) };
    static STATS: RefCell<Stats> = RefCell::new(Stats::default());
    static READER: web_sys::FileReaderSync = web_sys::FileReaderSync::new().expect("FileReaderSync is only available in a Worker");
    static CLOCK: web_sys::Performance = js_sys::global().unchecked_into::<web_sys::WorkerGlobalScope>().performance().expect("A Worker needs a performance clock");
}

pub(crate) fn now() -> f64 {
    CLOCK.with(|clock| clock.time_origin() + clock.now())
}

struct BlobSource {
    id: u32,
    length: u64,
    /// The file's first piece, when the page has already read it, until the import that wanted it ends.
    head: Mutex<Option<Arc<Vec<u8>>>>,
    /// The whole file, while a parallel decode needs it on every thread.
    whole: Mutex<Option<Arc<Vec<u8>>>>,
    /// Set once every helper has the Blob (`add_here`, `mark_on_helpers`): then any thread reads it.
    on_helpers: std::sync::atomic::AtomicBool,
}

struct Sources {
    by_path: BTreeMap<PathBuf, Arc<BlobSource>>,
    by_id: BTreeMap<u32, Arc<BlobSource>>,
}

static SOURCES: Mutex<Sources> = Mutex::new(Sources {
    by_path: BTreeMap::new(),
    by_id: BTreeMap::new(),
});

fn sources() -> std::sync::MutexGuard<'static, Sources> {
    SOURCES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Lists a dropped or chosen file at `path` (such as `/in/Study/1.dcm`). `head`: its first 64 KiB, if read already.
/// Returns the number the file is known by, for `unheld` and `hold_read`.
pub fn add(path: &str, blob: web_sys::Blob, head: Option<Vec<u8>>) -> u32 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let length = blob.size() as u64;
    // Kept only when it is exactly the file's first piece.
    let head = head
        .filter(|head| head.len() as u64 == length.min(piece_size(length)))
        .map(Arc::new);
    BLOBS.with_borrow_mut(|blobs| blobs.insert(id, blob));
    let source = Arc::new(BlobSource {
        id,
        length,
        head: Mutex::new(head),
        whole: Mutex::new(None),
        on_helpers: std::sync::atomic::AtomicBool::new(false),
    });
    memory_fs::add(path, source.clone());
    // Under the path the engine's series name it by (`.` and `..` resolved), so `retain` and `hold` find it.
    let key = memory_fs::canonicalize(Path::new(path)).unwrap_or_else(|_| PathBuf::from(path));
    let mut sources = sources();
    sources.by_id.insert(id, source.clone());
    if let Some(replaced) = sources.by_path.insert(key, source) {
        sources.by_id.remove(&replaced.id);
        forget(&HashSet::from([replaced.id]));
    }
    id
}

/// Gives this thread (a helper) Blob `id`, a file the engine Worker listed, so that a parallel run can read it here.
#[cfg_attr(
    not(feature = "threads"),
    allow(dead_code, reason = "only the threaded build calls it")
)]
pub fn add_here(id: u32, blob: web_sys::Blob) {
    BLOBS.with_borrow_mut(|blobs| blobs.insert(id, blob));
}

/// Lets go of these Blobs on this thread (a helper), as `retain` does on the engine Worker.
#[cfg_attr(
    not(feature = "threads"),
    allow(dead_code, reason = "only the threaded build calls it")
)]
pub fn forget_here(ids: &[u32]) {
    forget(&ids.iter().copied().collect());
}

/// Records that every helper now has these files, once each has said so.
#[cfg_attr(
    not(feature = "threads"),
    allow(dead_code, reason = "only the threaded build calls it")
)]
pub fn mark_on_helpers(ids: &[u32]) {
    let sources = sources();
    for source in ids.iter().filter_map(|id| sources.by_id.get(id)) {
        source.on_helpers.store(true, Ordering::Release);
    }
}

/// Whether every thread can read the files at these paths: each is on every helper, or is not a page file at all (a
/// ZIP entry, held in memory).
#[cfg_attr(
    not(feature = "threads"),
    allow(dead_code, reason = "only the threaded build calls it")
)]
pub fn on_helpers(paths: &[&Path]) -> bool {
    let sources = sources();
    paths.iter().all(|path| {
        sources
            .by_path
            .get(*path)
            .is_none_or(|source| source.on_helpers.load(Ordering::Acquire))
    })
}

/// The numbers of the files listed now.
pub fn listed() -> Vec<u32> {
    sources().by_id.keys().copied().collect()
}

/// The page files at these paths that are not held whole yet, by number, for the Worker to read itself, several at a
/// time, and hand over with `hold_read`. None when they all come to more than `limit` bytes: `hold` would not hold
/// them either.
#[cfg_attr(
    not(feature = "threads"),
    allow(dead_code, reason = "only the threaded build calls it")
)]
pub fn unheld(paths: &[&Path], limit: u64) -> Vec<u32> {
    let sources = sources();
    let wanted: Vec<&Arc<BlobSource>> = paths
        .iter()
        .filter_map(|path| sources.by_path.get(*path))
        .collect();
    if wanted.iter().map(|source| source.length).sum::<u64>() > limit {
        return Vec::new();
    }
    wanted
        .into_iter()
        .filter(|source| {
            source
                .whole
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none()
        })
        .map(|source| source.id)
        .collect()
}

/// Holds file `id` whole from bytes the Worker read itself. False, holding nothing, when no listed file has that number
/// or the bytes are not its length; `hold` then reads it here.
#[cfg_attr(
    not(feature = "threads"),
    allow(dead_code, reason = "only the threaded build calls it")
)]
pub fn hold_read(id: u32, bytes: Vec<u8>) -> bool {
    let Some(source) = sources().by_id.get(&id).cloned() else {
        return false;
    };
    if bytes.len() as u64 != source.length {
        return false;
    }
    *source
        .whole
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::new(bytes));
    true
}

/// Forgets the first pieces the page read ahead: the import that parsed its headers from them has ended, and later
/// reads go through the pieces kept below. Each file's head would otherwise stay for as long as its series is open.
pub fn drop_heads() {
    for source in sources().by_id.values() {
        *source
            .head
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

/// Forgets every page file a path in `keep` does not name: its listing, its Blob and its pieces. Files the engine wrote
/// (extracted ZIP entries) are not the page's and stay with their import.
pub fn retain(keep: &HashSet<PathBuf>) {
    let gone: Vec<(PathBuf, u32)> = {
        let mut sources = sources();
        let gone: Vec<_> = sources
            .by_path
            .iter()
            .filter(|(path, _)| !keep.contains(*path))
            .map(|(path, source)| (path.clone(), source.id))
            .collect();
        for (path, id) in &gone {
            sources.by_path.remove(path);
            sources.by_id.remove(id);
        }
        gone
    };
    for (path, _) in &gone {
        let _ = memory_fs::remove_file(path);
    }
    forget(&gone.into_iter().map(|(_, id)| id).collect());
}

/// Lets go of these Blobs and their pieces.
fn forget(ids: &HashSet<u32>) {
    if ids.is_empty() {
        return;
    }
    BLOBS.with_borrow_mut(|blobs| blobs.retain(|id, _| !ids.contains(id)));
    PIECES.with_borrow_mut(|pieces| pieces.retain(|(id, _, _)| !ids.contains(id)));
}

/// Forgets every file, piece and count.
pub fn clear() {
    memory_fs::clear();
    {
        let mut sources = sources();
        sources.by_path.clear();
        sources.by_id.clear();
    }
    BLOBS.with_borrow_mut(HashMap::clear);
    PIECES.with_borrow_mut(VecDeque::clear);
    STATS.with_borrow_mut(|stats| *stats = Stats::default());
}

/// Reads these files whole into shared memory, so that any thread can read them; files that are not the page's (ZIP
/// entries, already in memory) need nothing. Holds nothing and returns false when they come to more than `limit`
/// bytes or memory runs short. Called on the thread that has the Blobs; `release` gives the memory back.
#[cfg_attr(
    not(feature = "threads"),
    allow(dead_code, reason = "only the threaded build calls it")
)]
pub fn hold(paths: &[&Path], limit: u64) -> anyhow::Result<bool> {
    let wanted: Vec<Arc<BlobSource>> = {
        let sources = sources();
        paths
            .iter()
            .filter_map(|path| sources.by_path.get(*path).cloned())
            .collect()
    };
    if wanted.iter().map(|source| source.length).sum::<u64>() > limit {
        return Ok(false);
    }
    for source in wanted {
        if crate::api::request_cancelled() {
            anyhow::bail!(veacom_core::coded!("job.cancelled", "Operation cancelled"));
        }
        let mut whole = source
            .whole
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if whole.is_some() {
            continue;
        }
        let mut bytes = Vec::new();
        let read = if bytes.try_reserve_exact(source.length as usize).is_err() {
            Ok(false)
        } else {
            bytes.resize(source.length as usize, 0);
            if source.length > 0 {
                read_blob(source.id, 0, &mut bytes).map(|()| true)
            } else {
                Ok(true)
            }
        };
        if !matches!(read, Ok(true)) {
            drop(whole);
            release();
            return Ok(read?);
        }
        *whole = Some(Arc::new(bytes));
    }
    Ok(true)
}

/// Gives back the memory of every file held whole.
#[cfg_attr(
    not(feature = "threads"),
    allow(dead_code, reason = "only the threaded build calls it")
)]
pub fn release() {
    for source in sources().by_id.values() {
        *source
            .whole
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

/// Reads made from the Blobs since `clear`: how many, the bytes they returned, the milliseconds they took.
pub fn stats() -> (u64, u64, f64) {
    STATS.with_borrow(|stats| (stats.reads, stats.bytes, stats.ms))
}

fn js_error(error: wasm_bindgen::JsValue) -> io::Error {
    io::Error::other(format!("browser file read failed: {error:?}"))
}

/// Bytes from `start` of Blob `id`, into `output`.
fn read_blob(id: u32, start: u64, output: &mut [u8]) -> io::Result<()> {
    let began = now();
    let part = BLOBS
        .with_borrow(|blobs| {
            blobs.get(&id).map(|blob| {
                blob.slice_with_f64_and_f64(start as f64, (start + output.len() as u64) as f64)
            })
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "this file is not available to this Worker",
            )
        })?
        .map_err(js_error)?;
    let buffer = READER
        .with(|reader| reader.read_as_array_buffer(&part))
        .map_err(js_error)?;
    let bytes = js_sys::Uint8Array::new(&buffer);
    if bytes.length() as usize != output.len() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the file changed while it was read",
        ));
    }
    bytes.copy_to(output);
    STATS.with_borrow_mut(|stats| {
        stats.reads += 1;
        stats.bytes += output.len() as u64;
        stats.ms += now() - began;
    });
    Ok(())
}

impl BlobSource {
    fn piece(&self, index: u64) -> io::Result<Rc<Vec<u8>>> {
        if let Some(found) = PIECES.with_borrow(|pieces| {
            pieces
                .iter()
                .find(|(id, n, _)| *id == self.id && *n == index)
                .map(|(_, _, piece)| piece.clone())
        }) {
            return Ok(found);
        }
        let size = piece_size(self.length);
        let start = index * size;
        let mut bytes = vec![0; (self.length.min(start + size) - start) as usize];
        read_blob(self.id, start, &mut bytes)?;
        let bytes = Rc::new(bytes);
        PIECES.with_borrow_mut(|pieces| {
            if pieces.len() >= KEPT_PIECES {
                pieces.pop_front();
            }
            pieces.push_back((self.id, index, bytes.clone()));
        });
        Ok(bytes)
    }
}

impl Source for BlobSource {
    fn len(&self) -> u64 {
        self.length
    }
    fn read_at(&self, offset: u64, output: &mut [u8]) -> io::Result<()> {
        if let Some(whole) = self
            .whole
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let start = offset as usize;
            output.copy_from_slice(&whole[start..start + output.len()]);
            return Ok(());
        }
        let size = piece_size(self.length);
        if output.len() as u64 >= size {
            return read_blob(self.id, offset, output);
        }
        let head = self
            .head
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let mut done = 0;
        while done < output.len() {
            let position = offset + done as u64;
            if let (0, Some(head)) = (position / size, &head) {
                let start = position as usize;
                let count = (output.len() - done).min(head.len() - start);
                output[done..done + count].copy_from_slice(&head[start..start + count]);
                done += count;
                continue;
            }
            let piece = self.piece(position / size)?;
            let start = (position % size) as usize;
            let count = (output.len() - done).min(piece.len() - start);
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "read past the end of the file",
                ));
            }
            output[done..done + count].copy_from_slice(&piece[start..start + count]);
            done += count;
        }
        Ok(())
    }
}
