use anyhow::{Result, ensure};
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod stamp;
#[cfg(target_os = "macos")]
mod snapshot;
use crate::vfs::{File, OpenOptions};
use std::{
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

const BLOCK: usize = 256 * 1024;
// What import may keep of a file while indexing it.
const IMPORT_PREFIX: usize = 2 * 1024 * 1024;
// Both DICOM header passes repeatedly seek inside their initial 8 KiB buffer: import reads no more than that.
const HEADER_PREFIX: usize = 8192;
pub fn changed() -> crate::message::Coded {
    coded!(
        "file.sourceChanged",
        "Source file changed after import. Reimport the study."
    )
}

pub fn is_changed(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let coded = cause.downcast_ref::<crate::message::Coded>().or_else(|| {
            cause
                .downcast_ref::<io::Error>()?
                .get_ref()?
                .downcast_ref::<crate::message::Coded>()
        });
        coded.is_some_and(|error| error.0.code == "file.sourceChanged")
    })
}

pub(crate) fn open_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let file = options.open(path)?;
    ensure!(file.metadata()?.is_file(), "Expected a regular source file");
    Ok(file)
}

/// What a source's metadata said at import: its size and modification time, and on Unix also its identity and change
/// time, which every ordinary write moves. The browser's files have no time; the page's File objects cannot change
/// under it (the browser refuses to read one whose file on disk changed).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl Fingerprint {
    fn of(file: &File) -> io::Result<Self> {
        let metadata = file.metadata()?;
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (metadata.dev(), metadata.ino(), metadata.ctime(), metadata.ctime_nsec())
            },
        })
    }

    fn verify(&self, file: &File) -> io::Result<()> {
        if *self == Self::of(file)? { return Ok(()); }
        Err(io::Error::new(io::ErrorKind::InvalidData, changed()))
    }
}

/// Stable local files on Linux and APFS are checked on the open descriptor as they are read (see `stamp`). Other
/// sources are checked against their import fingerprint before and after every read. Nothing reads a whole file to
/// import it: the first image does not wait for the study to be read.
#[derive(Debug)]
pub struct SourceFile {
    pub path: PathBuf,
    pub len: u64,
    fingerprint: Fingerprint,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    stamp: Option<stamp::Stamp>,
    #[cfg(target_os = "macos")]
    snapshot: Option<snapshot::Snapshot>,
}

impl SourceFile {
    #[cfg(test)]
    pub fn index(path: &Path) -> Result<Arc<Self>> {
        Self::index_handle(path, open_file(path)?)
    }

    pub(crate) fn index_handle(path: &Path, mut file: File) -> Result<Arc<Self>> {
        Ok(Self::index_prefix(path, &mut file, 0)?.0)
    }

    fn index_prefix(path: &Path, file: &mut File, keep: usize) -> Result<(Arc<Self>, Arc<Vec<u8>>)> {
        let metadata = file.metadata()?;
        let len = metadata.len();
        let fingerprint = Fingerprint::of(file)?;
        ensure!(
            metadata.is_file() && len <= crate::input_guard::MAX_FILE_SIZE,
            "Invalid or excessive source file"
        );
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let stamp = stamp::Stamp::capture(file, &metadata);
        #[cfg(target_os = "macos")]
        // A file of one block or less skips the clone: its fingerprint is checked instead, which costs less than a clone per slice.
        let snapshot = stamp.as_ref().filter(|s| (len > BLOCK as u64 || keep < BLOCK) && s.settled())
            .and_then(|_| snapshot::Snapshot::create(file).ok());
        #[cfg(target_os = "macos")]
        let local_reader = snapshot.as_ref().and_then(|snap| snap.open().ok());
        #[cfg(target_os = "linux")]
        let local_reader = stamp.as_ref().filter(|s| s.settled() && stamp::no_existing_writer(file)).map(|_| &*file);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let (Some(local), Some(contents)) = (&stamp, local_reader) {
            let mut prefix = vec![0; keep.min(HEADER_PREFIX).min(len as usize)];
            let mut offset = 0;
            while offset < prefix.len() {
                let read = local.read(file, &contents, &mut prefix[offset..], offset as u64)?;
                ensure!(read != 0, changed());
                offset += read;
            }
            return Ok((Arc::new(Self { path: path.to_owned(), len, fingerprint, stamp,
                #[cfg(target_os = "macos")] snapshot,
            }), Arc::new(prefix)));
        }
        // Only the headers' prefix is read now, as on the fast path; later reads are checked against the fingerprint.
        let mut prefix = vec![0; keep.min(HEADER_PREFIX).min(len as usize)];
        file.read_exact(&mut prefix)?;
        ensure!(Fingerprint::of(file)? == fingerprint, changed());
        Ok((Arc::new(Self {
            path: path.to_owned(),
            len,
            fingerprint,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            stamp: None,
            #[cfg(target_os = "macos")]
            snapshot: None,
        }), Arc::new(prefix)))
    }

    pub fn dicom(path: &Path) -> Result<(Arc<Self>, crate::input_guard::InputInfo, SourceReader)> {
        Self::dicom_handle(path, open_file(path)?)
    }

    pub fn dicom_handle(
        path: &Path,
        mut file: File,
    ) -> Result<(Arc<Self>, crate::input_guard::InputInfo, SourceReader)> {
        let (source, prefix) = Self::index_prefix(path, &mut file, IMPORT_PREFIX)?;
        let guard = source.reader(file.try_clone()?, prefix.clone());
        let info = crate::input_guard::inspect_reader(guard, source.len)?;
        let header = source.reader(file, prefix);
        Ok((source, info, header))
    }

    pub fn same_contents(self: &Arc<Self>, other: &Arc<Self>) -> bool {
        if Arc::ptr_eq(self, other) { return true; }
        if self.len != other.len { return false; }
        if self.len == 0 { return true; }
        #[cfg(target_os = "linux")]
        if self.stamp.is_some() && other.stamp.is_some() { return self.stamp == other.stamp; }
        // The same file, unwritten since: on Unix every write moves the change time.
        #[cfg(unix)]
        if self.fingerprint == other.fingerprint { return true; }
        // Two independently imported versions of the same path can have identical timestamps and different bytes.
        let (Ok(mut left), Ok(mut right)) = (self.open(), other.open()) else { return false };
        let mut remaining = self.len as usize;
        let mut a = vec![0; remaining.min(BLOCK)];
        let mut b = vec![0; a.len()];
        while remaining > 0 {
            let n = remaining.min(BLOCK);
            if left.read_exact(&mut a[..n]).is_err() || right.read_exact(&mut b[..n]).is_err() || a[..n] != b[..n] { return false; }
            remaining -= n;
        }
        true
    }

    pub fn retained_bytes(&self) -> usize {
        size_of::<Self>() + self.path.as_os_str().as_encoded_bytes().len()
    }

    pub fn open(self: &Arc<Self>) -> Result<SourceReader> {
        let file = open_file(&self.path)?;
        ensure!(file.metadata()?.len() == self.len, changed());
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(stamp) = &self.stamp { stamp.verify(&file)?; return Ok(self.reader(file, Arc::default())); }
        self.fingerprint.verify(&file)?;
        Ok(self.reader(file, Arc::default()))
    }

    fn reader(self: &Arc<Self>, file: File, prefix: Arc<Vec<u8>>) -> SourceReader {
        SourceReader {
            file,
            prefix,
            source: self.clone(),
            pos: 0,
            #[cfg(target_os = "macos")]
            snapshot: None,
        }
    }
}

pub struct SourceReader {
    file: File,
    #[cfg(target_os = "macos")]
    snapshot: Option<File>,
    prefix: Arc<Vec<u8>>,
    source: Arc<SourceFile>,
    pos: u64,
}

impl Read for SourceReader {
    fn read(&mut self, dst: &mut [u8]) -> io::Result<usize> {
        if dst.is_empty() || self.pos >= self.source.len {
            return Ok(0);
        }
        if self.pos < self.prefix.len() as u64 {
            let bytes = &self.prefix[self.pos as usize..];
            let n = dst.len().min(bytes.len());
            dst[..n].copy_from_slice(&bytes[..n]);
            self.pos += n as u64;
            return Ok(n);
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(stamp) = &self.source.stamp {
            let length = dst.len().min((self.source.len - self.pos) as usize);
            #[cfg(target_os = "macos")]
            if self.snapshot.is_none() {
                self.snapshot = Some(self.source.snapshot.as_ref().expect("stamped APFS source has a clone").open()?);
            }
            #[cfg(target_os = "macos")]
            let contents = self.snapshot.as_ref().unwrap();
            #[cfg(target_os = "linux")]
            let contents = &self.file;
            let read = stamp.read(&self.file, contents, &mut dst[..length], self.pos)?;
            self.pos += read as u64;
            return Ok(read);
        }
        let length = dst.len().min((self.source.len - self.pos) as usize);
        self.source.fingerprint.verify(&self.file)?;
        self.file.seek(SeekFrom::Start(self.pos))?;
        let read = self.file.read(&mut dst[..length])?;
        self.source.fingerprint.verify(&self.file)?;
        if read == 0 { return Err(io::Error::new(io::ErrorKind::InvalidData, changed())); }
        self.pos += read as u64;
        Ok(read)
    }
}

impl Seek for SourceReader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.pos = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::Current(n) => self.pos.checked_add_signed(n),
            SeekFrom::End(n) => self.source.len.checked_add_signed(n),
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid source offset"))?;
        Ok(self.pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[cfg(target_os = "macos")]
    #[test]
    fn small_dicom_slices_skip_the_apfs_clone_and_are_still_checked() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("slice.dcm");
        let bytes = vec![7; 32 * 1024];
        std::fs::write(&path, &bytes).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3100));
        let (source, prefix) = SourceFile::index_prefix(&path, &mut open_file(&path).unwrap(), IMPORT_PREFIX).unwrap();
        assert!(source.snapshot.is_none());
        assert_eq!(prefix.as_slice(), &bytes[..HEADER_PREFIX]);
        let mut reader = source.open().unwrap();
        std::fs::write(&path, vec![22; bytes.len()]).unwrap();
        assert!(reader.read_exact(&mut [0; 8]).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tmpfs_sources_are_checked_by_their_fingerprint() {
        use std::os::fd::{AsRawFd, FromRawFd};
        // An anonymous memory file uses tmpfs without depending on the runner's /tmp mount.
        let fd = unsafe { libc::memfd_create(c"veacom-source-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(fd >= 0);
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(&[11; 8]).unwrap();
        let path = PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()));
        let original = SourceFile::index(&path).unwrap();
        assert!(original.stamp.is_none());
        let mut reader = original.open().unwrap();
        // The kernel's file times tick a few milliseconds apart; a later write moves them.
        std::thread::sleep(std::time::Duration::from_millis(50));
        file.rewind().unwrap();
        file.write_all(&[22; 8]).unwrap();
        assert!(reader.read_exact(&mut [0; 8]).is_err());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn settled_local_source_checks_identity_and_rejects_changes_during_a_read() {
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("settled.bin");
        std::fs::write(&path, vec![7; BLOCK + 8]).unwrap();
        let fresh = SourceFile::index(&path).unwrap();
        assert!(fresh.stamp.is_none()); // Just written: checked by its fingerprint.
        std::thread::sleep(std::time::Duration::from_millis(3100));
        let settled = SourceFile::index(&path).unwrap();
        if settled.stamp.is_none() { return; } // This filesystem has no fast path.
        assert!(settled.same_contents(&fresh));
        let mut reader = settled.open().unwrap();
        let mut byte = [0];
        reader.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [7]);
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        let mtime = writer.metadata().unwrap().modified().unwrap();
        writer.seek(SeekFrom::Start(BLOCK as u64)).unwrap();
        writer.write_all(&[9]).unwrap();
        writer.set_modified(mtime).unwrap();
        reader.seek(SeekFrom::Start(BLOCK as u64)).unwrap();
        assert_eq!(reader.read_exact(&mut byte).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(byte, [7]);
        std::fs::rename(&path, temp.path().join("original")).unwrap();
        std::fs::write(&path, vec![7; BLOCK + 8]).unwrap();
        assert!(settled.open().is_err());
    }

    #[test]
    fn import_keeps_only_the_header_prefix_and_checks_bytes_outside_it() {
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("prefix.bin");
        std::fs::write(&path, vec![11; IMPORT_PREFIX + BLOCK]).unwrap();
        let mut file = open_file(&path).unwrap();
        let (source, prefix) = SourceFile::index_prefix(&path, &mut file, IMPORT_PREFIX).unwrap();
        assert_eq!(prefix.len(), HEADER_PREFIX);
        let mut reader = source.reader(file, prefix);
        std::thread::sleep(std::time::Duration::from_millis(50));
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        writer.write_all(&[99]).unwrap();
        writer.seek(SeekFrom::Start(IMPORT_PREFIX as u64)).unwrap();
        writer.write_all(&[88]).unwrap();
        let mut byte = [0];
        reader.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [11]);
        reader.seek(SeekFrom::Start(IMPORT_PREFIX as u64)).unwrap();
        assert!(reader.read_exact(&mut byte).is_err());
        // Opening it again is refused outright.
        assert!(source.open().is_err());
    }
}
