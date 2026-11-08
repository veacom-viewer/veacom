//! A file system in memory, with the part of `std::fs`'s interface the engine uses.
//!
//! In a browser there is no file system: the page hands the engine the user's files (dropped or chosen), and each is
//! listed here under a path as a `Source` the browser reads on request, so nothing is copied up front. Files the engine
//! writes itself (entries extracted from a ZIP) are kept in memory. `vfs` uses this in WebAssembly; on the desktop it
//! is compiled for its tests only.

use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::SystemTime,
};

static READ_HOOK: OnceLock<fn()> = OnceLock::new();

/// Has `hook` called before every read. Imports and decodes read all along, so a browser's engine, which cannot
/// answer messages while it works, reports progress and notices a cancellation from here.
pub fn on_read(hook: fn()) {
    let _ = READ_HOOK.set(hook);
}

/// A file's bytes, read on request (in a browser, a `File` read through `Blob.slice`).
pub trait Source: Send + Sync {
    fn len(&self) -> u64;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Fills `output` with the bytes from `offset`; the engine asks only for bytes within `len`.
    fn read_at(&self, offset: u64, output: &mut [u8]) -> io::Result<()>;
}

#[derive(Clone)]
enum Data {
    Source(Arc<dyn Source>),
    Memory(Arc<Mutex<Vec<u8>>>),
}
enum Node {
    Folder,
    File(Data),
}

static TREE: Mutex<BTreeMap<PathBuf, Node>> = Mutex::new(BTreeMap::new());

fn tree() -> MutexGuard<'static, BTreeMap<PathBuf, Node>> {
    TREE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// An absolute path with `.` and `..` resolved; the root is "/".
fn normal(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                out.pop();
            }
            _ => {}
        }
    }
    out
}

fn not_found(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        format!("{} does not exist", path.display()),
    )
}

fn add_folders(nodes: &mut BTreeMap<PathBuf, Node>, path: &Path) {
    let mut folder = path.parent();
    while let Some(current) = folder {
        nodes.entry(current.to_owned()).or_insert(Node::Folder);
        folder = current.parent();
    }
}

fn length(data: &Data) -> u64 {
    match data {
        Data::Source(source) => source.len(),
        Data::Memory(bytes) => bytes.lock().unwrap().len() as u64,
    }
}

/// Lists a file at `path`, with the folders above it.
pub fn add(path: impl AsRef<Path>, source: Arc<dyn Source>) {
    let path = normal(path.as_ref());
    let mut nodes = tree();
    add_folders(&mut nodes, &path);
    nodes.insert(path, Node::File(Data::Source(source)));
}

/// Forgets every file and folder.
pub fn clear() {
    tree().clear();
}

/// Bytes held in memory by files the engine wrote (extracted ZIP entries).
pub fn memory_bytes() -> u64 {
    tree()
        .values()
        .map(|node| match node {
            Node::File(data @ Data::Memory(_)) => length(data),
            _ => 0,
        })
        .sum()
}

pub fn exists(path: &Path) -> bool {
    tree().contains_key(&normal(path))
}

pub fn is_file(path: &Path) -> bool {
    matches!(tree().get(&normal(path)), Some(Node::File(_)))
}

pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    let path = normal(path);
    if exists(&path) {
        Ok(path)
    } else {
        Err(not_found(&path))
    }
}

pub fn create_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let path = normal(path.as_ref());
    let mut nodes = tree();
    if matches!(nodes.get(&path), Some(Node::File(_))) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "a file has this name",
        ));
    }
    add_folders(&mut nodes, &path);
    nodes.insert(path, Node::Folder);
    Ok(())
}

/// A new folder inside an existing one; an error if the name is taken.
pub fn create_dir(path: impl AsRef<Path>) -> io::Result<()> {
    let path = normal(path.as_ref());
    let mut nodes = tree();
    if nodes.contains_key(&path) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "already exists",
        ));
    }
    if !path
        .parent()
        .is_some_and(|parent| matches!(nodes.get(parent), Some(Node::Folder)))
    {
        return Err(not_found(&path));
    }
    nodes.insert(path, Node::Folder);
    Ok(())
}

pub fn remove_file(path: impl AsRef<Path>) -> io::Result<()> {
    let path = normal(path.as_ref());
    let mut nodes = tree();
    match nodes.get(&path) {
        Some(Node::File(_)) => {
            nodes.remove(&path);
            Ok(())
        }
        Some(Node::Folder) => Err(io::Error::new(io::ErrorKind::IsADirectory, "is a folder")),
        None => Err(not_found(&path)),
    }
}

pub fn remove_dir_all(path: impl AsRef<Path>) -> io::Result<()> {
    let path = normal(path.as_ref());
    let mut nodes = tree();
    let inside: Vec<PathBuf> = nodes
        .range(path.clone()..)
        .map(|(key, _)| key)
        .take_while(|key| key.starts_with(&path))
        .cloned()
        .collect();
    for key in inside {
        nodes.remove(&key);
    }
    Ok(())
}

#[derive(Debug)]
pub struct Metadata {
    folder: bool,
    length: u64,
}
impl Metadata {
    pub fn is_dir(&self) -> bool {
        self.folder
    }
    pub fn is_file(&self) -> bool {
        !self.folder
    }
    pub fn len(&self) -> u64 {
        self.length
    }
    pub fn is_empty(&self) -> bool {
        self.length == 0
    }
    /// Files handed over by a page cannot change while they are listed here, so no time is kept: both readings of a
    /// file's time (see `input_guard`) find none.
    pub fn modified(&self) -> io::Result<SystemTime> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "no modification time",
        ))
    }
}

pub fn metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    let path = normal(path.as_ref());
    match tree().get(&path) {
        Some(Node::Folder) => Ok(Metadata {
            folder: true,
            length: 0,
        }),
        Some(Node::File(data)) => Ok(Metadata {
            folder: false,
            length: length(data),
        }),
        None => Err(not_found(&path)),
    }
}

#[derive(Clone, Copy, Debug)]
pub struct FileType {
    folder: bool,
}
impl FileType {
    pub fn is_dir(&self) -> bool {
        self.folder
    }
    pub fn is_file(&self) -> bool {
        !self.folder
    }
}

#[derive(Debug)]
pub struct DirEntry {
    path: PathBuf,
    folder: bool,
}
impl DirEntry {
    pub fn path(&self) -> PathBuf {
        self.path.clone()
    }
    pub fn file_name(&self) -> OsString {
        self.path.file_name().unwrap_or_default().to_owned()
    }
    pub fn file_type(&self) -> io::Result<FileType> {
        Ok(FileType {
            folder: self.folder,
        })
    }
}

pub fn read_dir(path: impl AsRef<Path>) -> io::Result<std::vec::IntoIter<io::Result<DirEntry>>> {
    let path = normal(path.as_ref());
    let nodes = tree();
    match nodes.get(&path) {
        Some(Node::Folder) => {}
        Some(_) => return Err(io::Error::new(io::ErrorKind::NotADirectory, "not a folder")),
        None => return Err(not_found(&path)),
    }
    let entries: Vec<_> = nodes
        .range(path.clone()..)
        .skip(1)
        .take_while(|(key, _)| key.starts_with(&path))
        .filter(|(key, _)| key.parent() == Some(path.as_path()))
        .map(|(key, node)| {
            Ok(DirEntry {
                path: key.clone(),
                folder: matches!(node, Node::Folder),
            })
        })
        .collect();
    Ok(entries.into_iter())
}

struct Handle {
    data: Data,
    position: u64,
    writable: bool,
}

/// An open file. Clones share one cursor, as duplicated operating-system handles do.
pub struct File(Arc<Mutex<Handle>>);

impl std::fmt::Debug for File {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("File")
            .field("position", &self.handle().position)
            .finish_non_exhaustive()
    }
}

impl File {
    pub fn open(path: impl AsRef<Path>) -> io::Result<File> {
        let path = normal(path.as_ref());
        match tree().get(&path) {
            Some(Node::File(data)) => Ok(File(Arc::new(Mutex::new(Handle {
                data: data.clone(),
                position: 0,
                writable: false,
            })))),
            Some(Node::Folder) => Err(io::Error::new(io::ErrorKind::IsADirectory, "is a folder")),
            None => Err(not_found(&path)),
        }
    }
    pub fn options() -> OpenOptions {
        OpenOptions::default()
    }
    pub fn metadata(&self) -> io::Result<Metadata> {
        Ok(Metadata {
            folder: false,
            length: length(&self.handle().data),
        })
    }
    pub fn try_clone(&self) -> io::Result<File> {
        Ok(File(self.0.clone()))
    }
    fn handle(&self) -> MutexGuard<'_, Handle> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Default)]
pub struct OpenOptions {
    write: bool,
    create_new: bool,
}
impl OpenOptions {
    pub fn new() -> Self {
        Self::default()
    }
    /// Every file here can be read; reading needs no option.
    pub fn read(&mut self, _read: bool) -> &mut Self {
        self
    }
    pub fn write(&mut self, write: bool) -> &mut Self {
        self.write = write;
        self
    }
    pub fn create_new(&mut self, create_new: bool) -> &mut Self {
        self.create_new = create_new;
        self
    }
    /// Opens for reading, or creates a new, empty file in memory (`write` and `create_new`).
    pub fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
        let path = normal(path.as_ref());
        if !(self.write && self.create_new) {
            return File::open(path);
        }
        let mut nodes = tree();
        if nodes.contains_key(&path) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "already exists",
            ));
        }
        if !path
            .parent()
            .is_some_and(|parent| matches!(nodes.get(parent), Some(Node::Folder)))
        {
            return Err(not_found(&path));
        }
        let data = Data::Memory(Arc::new(Mutex::new(Vec::new())));
        nodes.insert(path, Node::File(data.clone()));
        Ok(File(Arc::new(Mutex::new(Handle {
            data,
            position: 0,
            writable: true,
        }))))
    }
}

impl Read for File {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if let Some(hook) = READ_HOOK.get() {
            hook();
        }
        let mut handle = self.handle();
        let position = handle.position;
        let count = match &handle.data {
            Data::Memory(bytes) => {
                let bytes = bytes.lock().unwrap();
                let start = usize::try_from(position)
                    .unwrap_or(usize::MAX)
                    .min(bytes.len());
                let count = output.len().min(bytes.len() - start);
                output[..count].copy_from_slice(&bytes[start..start + count]);
                count
            }
            Data::Source(source) => {
                let count = output.len().min(
                    usize::try_from(source.len().saturating_sub(position)).unwrap_or(usize::MAX),
                );
                if count > 0 {
                    source.read_at(position, &mut output[..count])?;
                }
                count
            }
        };
        handle.position += count as u64;
        Ok(count)
    }
}

impl Seek for File {
    fn seek(&mut self, request: SeekFrom) -> io::Result<u64> {
        let mut handle = self.handle();
        let target = match request {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::Current(delta) => handle.position.checked_add_signed(delta),
            SeekFrom::End(delta) => length(&handle.data).checked_add_signed(delta),
        }
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before the start of the file",
            )
        })?;
        handle.position = target;
        Ok(target)
    }
}

impl Write for File {
    fn write(&mut self, input: &[u8]) -> io::Result<usize> {
        let mut handle = self.handle();
        let bytes = match (&handle.data, handle.writable) {
            (Data::Memory(bytes), true) => bytes.clone(),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "opened for reading",
                ));
            }
        };
        let mut bytes = bytes.lock().unwrap();
        let start = usize::try_from(handle.position)
            .map_err(|_| io::Error::new(io::ErrorKind::OutOfMemory, "file too large"))?;
        let end = start
            .checked_add(input.len())
            .ok_or_else(|| io::Error::new(io::ErrorKind::OutOfMemory, "file too large"))?;
        let length = bytes.len();
        if length < end {
            // A failed allocation is an error the import reports, not an abort.
            bytes
                .try_reserve(end - length)
                .map_err(|_| io::Error::new(io::ErrorKind::OutOfMemory, "out of memory"))?;
            bytes.resize(end, 0);
        }
        bytes[start..end].copy_from_slice(input);
        handle.position = end as u64;
        Ok(input.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Bytes(Vec<u8>);
    impl Source for Bytes {
        fn len(&self) -> u64 {
            self.0.len() as u64
        }
        fn read_at(&self, offset: u64, output: &mut [u8]) -> io::Result<()> {
            let start = offset as usize;
            output.copy_from_slice(&self.0[start..start + output.len()]);
            Ok(())
        }
    }

    fn names(folder: &str) -> Vec<String> {
        read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn listed_files_are_found_read_and_sought_through_their_folders() {
        add("/listed/Study/a.dcm", Arc::new(Bytes((0..=255).collect())));
        add("/listed/Study/Sub/b.dcm", Arc::new(Bytes(vec![7; 3])));
        assert!(exists(Path::new("/listed/Study")) && is_file(Path::new("/listed/Study/a.dcm")));
        assert!(metadata("/listed/Study/Sub").unwrap().is_dir());
        assert_eq!(names("/listed/Study"), ["Sub", "a.dcm"]);
        assert_eq!(
            canonicalize(Path::new("/listed/Study/Sub/../a.dcm")).unwrap(),
            PathBuf::from("/listed/Study/a.dcm")
        );
        let mut file = File::open("/listed/Study/a.dcm").unwrap();
        let mut start = [0; 4];
        file.read_exact(&mut start).unwrap();
        assert_eq!(start, [0, 1, 2, 3]);
        // A clone shares the cursor.
        let mut clone = file.try_clone().unwrap();
        assert_eq!(clone.seek(SeekFrom::End(-2)).unwrap(), 254);
        let mut rest = Vec::new();
        file.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, [254, 255]);
        assert!(file.write(b"x").is_err());
        assert_eq!(
            read_dir("/listed/Study/a.dcm").unwrap_err().kind(),
            io::ErrorKind::NotADirectory
        );
        assert_eq!(
            File::open("/listed/missing").err().unwrap().kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn written_files_live_in_memory_until_their_folder_is_removed() {
        create_dir_all("/written/tmp/x").unwrap();
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open("/written/tmp/x/out.dcm")
            .unwrap();
        file.write_all(b"hello").unwrap();
        assert_eq!(
            File::options()
                .write(true)
                .create_new(true)
                .open("/written/tmp/x/out.dcm")
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(
            File::options()
                .write(true)
                .create_new(true)
                .open("/written/none/out.dcm")
                .err()
                .unwrap()
                .kind(),
            io::ErrorKind::NotFound
        );
        let mut text = String::new();
        File::open("/written/tmp/x/out.dcm")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "hello");
        assert!(memory_bytes() >= 5);
        remove_dir_all("/written/tmp").unwrap();
        assert!(!exists(Path::new("/written/tmp/x/out.dcm")) && exists(Path::new("/written")));
    }
}
