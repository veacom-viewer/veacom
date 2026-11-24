use anyhow::{Result, ensure};
#[cfg(target_os = "macos")]
mod snapshot;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod stamp;
use crate::vfs::{File, OpenOptions};
use sha2::{Digest, Sha256};
use std::{
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

const BLOCK: usize = 256 * 1024;
// What a reader that goes through a whole file asks the file for at a time (see ReadAhead).
const READ_AHEAD: usize = 256 * 1024;
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

/// What a source's metadata said at import: its size and modification time, and on Unix and Windows also its identity
/// and change time, which every write moves, even one that puts the modification time back (a copy over the file keeps
/// the copied file's). The browser's files have no time; the page's File objects cannot change under it (the browser
/// refuses to read one whose file on disk changed).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
    #[cfg(windows)]
    identity: (u32, u64, i64),
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
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
            #[cfg(windows)]
            identity: windows_identity(file)?,
        })
    }

    fn verify(&self, file: &File) -> io::Result<()> {
        if *self == Self::of(file)? {
            return Ok(());
        }
        Err(io::Error::new(io::ErrorKind::InvalidData, changed()))
    }
}

/// The volume, the file's index on it and its change time, which NTFS moves on every write and attribute change.
#[cfg(windows)]
fn windows_identity(file: &File) -> io::Result<(u32, u64, i64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx,
    };
    let handle = file.as_raw_handle();
    // The handle stays open for both calls, and each fills the plain structure it is given.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
    let size = size_of::<FILE_BASIC_INFO>() as u32;
    if unsafe { GetFileInformationByHandleEx(handle, FileBasicInfo, (&raw mut basic).cast(), size) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        basic.ChangeTime,
    ))
}

/// Stable local files on Linux and APFS are checked on the open descriptor as they are read (see `stamp`). Other
/// sources are checked against their import fingerprint before and after every read, and against the digest of the
/// headers import read whenever they are opened again. Nothing reads a whole file to import it: the first image does
/// not wait for the study to be read.
#[derive(Debug)]
pub struct SourceFile {
    pub path: PathBuf,
    pub len: u64,
    fingerprint: Fingerprint,
    /// SHA-256 of the file's first 8 KiB (or all of a smaller file), for sources without a fast path. A copy over the
    /// file can keep every time Windows reports, but not the patient, study and image identity in these headers.
    head: Option<[u8; 32]>,
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

    fn index_prefix(
        path: &Path,
        file: &mut File,
        keep: usize,
    ) -> Result<(Arc<Self>, Arc<Vec<u8>>)> {
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
        let snapshot = stamp
            .as_ref()
            .filter(|s| (len > BLOCK as u64 || keep < BLOCK) && s.settled())
            .and_then(|_| snapshot::Snapshot::create(file).ok());
        #[cfg(target_os = "macos")]
        let opened = snapshot.as_ref().and_then(|snap| snap.open().ok());
        #[cfg(target_os = "macos")]
        let local_reader = opened.as_ref();
        #[cfg(target_os = "linux")]
        let local_reader = stamp
            .as_ref()
            .filter(|s| s.settled() && stamp::no_existing_writer(file))
            .map(|_| &*file);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let (Some(local), Some(contents)) = (&stamp, local_reader) {
            let mut prefix = vec![0; keep.min(HEADER_PREFIX).min(len as usize)];
            let mut offset = 0;
            while offset < prefix.len() {
                let read = local.read(file, contents, &mut prefix[offset..], offset as u64)?;
                ensure!(read != 0, changed());
                offset += read;
            }
            return Ok((
                Arc::new(Self {
                    path: path.to_owned(),
                    len,
                    fingerprint,
                    head: None,
                    stamp,
                    #[cfg(target_os = "macos")]
                    snapshot,
                }),
                Arc::new(prefix),
            ));
        }
        // Only the headers are read now, as on the fast path; later reads are checked against the fingerprint, and the
        // headers' digest when the file is opened again.
        let mut prefix = vec![0; HEADER_PREFIX.min(len as usize)];
        file.read_exact(&mut prefix)?;
        ensure!(Fingerprint::of(file)? == fingerprint, changed());
        let head = Sha256::digest(&prefix).into();
        prefix.truncate(keep.min(prefix.len()));
        Ok((
            Arc::new(Self {
                path: path.to_owned(),
                len,
                fingerprint,
                head: Some(head),
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                stamp: None,
                #[cfg(target_os = "macos")]
                snapshot: None,
            }),
            Arc::new(prefix),
        ))
    }

    pub fn dicom(path: &Path) -> Result<(Arc<Self>, crate::input_guard::InputInfo, SourceReader)> {
        Self::dicom_handle(path, open_file(path)?)
    }

    pub fn dicom_handle(
        path: &Path,
        mut file: File,
    ) -> Result<(Arc<Self>, crate::input_guard::InputInfo, SourceReader)> {
        let (source, prefix) = Self::index_prefix(path, &mut file, IMPORT_PREFIX)?;
        let guard = source.reader(file.try_clone()?, prefix.clone(), false);
        let info = crate::input_guard::inspect_reader(guard, source.len)?;
        let header = source.reader(file, prefix, false);
        Ok((source, info, header))
    }

    pub fn same_contents(self: &Arc<Self>, other: &Arc<Self>) -> bool {
        if Arc::ptr_eq(self, other) {
            return true;
        }
        if self.len != other.len {
            return false;
        }
        if self.len == 0 {
            return true;
        }
        #[cfg(target_os = "linux")]
        if self.stamp.is_some() && other.stamp.is_some() {
            return self.stamp == other.stamp;
        }
        // The same file, unwritten since: on Unix every write moves the change time. NTFS may defer that update until a
        // writer closes the file, so Windows compares the bytes below.
        #[cfg(unix)]
        if self.fingerprint == other.fingerprint {
            return true;
        }
        // Two independently imported versions of the same path can have identical timestamps and different bytes.
        let (Ok(mut left), Ok(mut right)) = (self.open(), other.open()) else {
            return false;
        };
        let mut remaining = self.len as usize;
        let mut a = vec![0; remaining.min(BLOCK)];
        let mut b = vec![0; a.len()];
        while remaining > 0 {
            let n = remaining.min(BLOCK);
            if left.read_exact(&mut a[..n]).is_err()
                || right.read_exact(&mut b[..n]).is_err()
                || a[..n] != b[..n]
            {
                return false;
            }
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
        if let Some(stamp) = &self.stamp {
            stamp.verify(&file)?;
            return Ok(self.reader(file, Arc::default(), true));
        }
        self.fingerprint.verify(&file)?;
        let Some(expected) = &self.head else {
            return Ok(self.reader(file, Arc::default(), true));
        };
        // The headers are read again and served from this check, so what follows reads past them.
        let mut head = vec![0; HEADER_PREFIX.min(self.len as usize)];
        let mut file = file;
        ensure!(file.read_exact(&mut head).is_ok(), changed());
        ensure!(Sha256::digest(&head)[..] == expected[..], changed());
        Ok(self.reader(file, Arc::new(head), true))
    }

    /// A reader of the file. `whole` is for one that reads the file from end to end: it asks the file for blocks.
    fn reader(self: &Arc<Self>, file: File, prefix: Arc<Vec<u8>>, whole: bool) -> SourceReader {
        SourceReader {
            file,
            prefix,
            source: self.clone(),
            pos: 0,
            ahead: whole.then(ReadAhead::default),
            #[cfg(target_os = "macos")]
            snapshot: None,
        }
    }
}

/// The block of a file that its reader fetched last. A reader that goes through a file in small reads is served from
/// it, and goes to the file only for a place outside it: on a disc or a network drive every read of the file, and
/// each check around it that the file has not changed, is a trip to the device, whatever the read's size.
#[derive(Default)]
struct ReadAhead {
    start: u64,
    bytes: Vec<u8>,
}

impl ReadAhead {
    /// Up to `dst.len()` bytes from `pos`, of a file `len` long with `pos` inside it. `fetch(from, into)` reads the
    /// file at `from` and says how many bytes it gave.
    fn read(
        &mut self,
        pos: u64,
        len: u64,
        dst: &mut [u8],
        fetch: impl FnOnce(u64, &mut [u8]) -> io::Result<usize>,
    ) -> io::Result<usize> {
        if !(self.start..self.start + self.bytes.len() as u64).contains(&pos) {
            let want = READ_AHEAD.min(usize::try_from(len - pos).unwrap_or(usize::MAX));
            self.bytes.clear();
            self.bytes.resize(want, 0);
            let fetched = fetch(pos, &mut self.bytes);
            // A failed fetch leaves no block behind: the next read asks the file again.
            self.bytes.truncate(*fetched.as_ref().unwrap_or(&0));
            self.start = pos;
            fetched?;
        }
        let held = &self.bytes[(pos - self.start) as usize..];
        let count = dst.len().min(held.len());
        dst[..count].copy_from_slice(&held[..count]);
        Ok(count)
    }
}

pub struct SourceReader {
    file: File,
    #[cfg(target_os = "macos")]
    snapshot: Option<File>,
    prefix: Arc<Vec<u8>>,
    source: Arc<SourceFile>,
    pos: u64,
    /// For a reader that reads the file whole; import reads the headers alone and has none.
    ahead: Option<ReadAhead>,
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
                self.snapshot = Some(
                    self.source
                        .snapshot
                        .as_ref()
                        .expect("stamped APFS source has a clone")
                        .open()?,
                );
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
        let Self {
            file,
            source,
            ahead,
            pos,
            ..
        } = self;
        // One read of the file, between two checks that it is still the file that was imported.
        let mut fetch = |from: u64, into: &mut [u8]| {
            source.fingerprint.verify(file)?;
            file.seek(SeekFrom::Start(from))?;
            let read = file.read(into)?;
            source.fingerprint.verify(file)?;
            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, changed()));
            }
            Ok(read)
        };
        let read = match ahead {
            // A read as large as a block gains nothing from one.
            Some(ahead) if length < READ_AHEAD => {
                ahead.read(*pos, source.len, &mut dst[..length], fetch)?
            }
            _ => fetch(*pos, &mut dst[..length])?,
        };
        *pos += read as u64;
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
        let (source, prefix) =
            SourceFile::index_prefix(&path, &mut open_file(&path).unwrap(), IMPORT_PREFIX).unwrap();
        assert!(source.snapshot.is_none());
        assert_eq!(prefix.as_slice(), &bytes[..HEADER_PREFIX]);
        let mut reader = source.open().unwrap();
        std::fs::write(&path, vec![22; bytes.len()]).unwrap();
        // The headers come from the copy checked against their import digest when the file was opened.
        let mut first = [0; 8];
        reader.read_exact(&mut first).unwrap();
        assert_eq!(first, [7; 8]);
        reader.seek(SeekFrom::Start(HEADER_PREFIX as u64)).unwrap();
        assert!(reader.read_exact(&mut [0; 8]).is_err());
        assert!(source.open().is_err());
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
        // The whole file is within the headers checked against their import digest when it was opened.
        let mut bytes = [0; 8];
        reader.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, [11; 8]);
        assert!(original.open().is_err());
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
        if settled.stamp.is_none() {
            return;
        } // This filesystem has no fast path.
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
        assert_eq!(
            reader.read_exact(&mut byte).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
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
        let mut reader = source.reader(file, prefix, false);
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

    #[test]
    fn small_reads_through_a_file_fetch_it_in_blocks() {
        let file: Vec<u8> = (0..600 * 1024).map(|index| (index % 251) as u8).collect();
        let fetches = std::cell::Cell::new(0);
        let fetch = |from: u64, into: &mut [u8]| {
            fetches.set(fetches.get() + 1);
            let from = from as usize;
            let count = into.len().min(file.len() - from);
            into[..count].copy_from_slice(&file[from..from + count]);
            Ok(count)
        };
        let (mut ahead, mut read, mut piece) = (ReadAhead::default(), Vec::new(), [0; 1000]);
        while read.len() < file.len() {
            let count = ahead
                .read(read.len() as u64, file.len() as u64, &mut piece, fetch)
                .unwrap();
            read.extend_from_slice(&piece[..count]);
        }
        assert_eq!(read, file);
        // 600 KiB in blocks of 256 KiB, where a fetch for each read would be 615.
        assert_eq!(fetches.get(), 3);
        // A place outside the block is fetched; a place inside it is not.
        assert_eq!(
            ahead
                .read(10, file.len() as u64, &mut piece, fetch)
                .unwrap(),
            1000
        );
        assert_eq!(piece[..], file[10..1010]);
        assert_eq!(
            ahead
                .read(5000, file.len() as u64, &mut piece, fetch)
                .unwrap(),
            1000
        );
        assert_eq!(piece[..], file[5000..6000]);
        assert_eq!(fetches.get(), 4);
        // A fetch that fails leaves no block behind: the next read goes to the file again.
        let failing = |_: u64, _: &mut [u8]| Err(io::Error::other("the drive did not answer"));
        assert!(
            ahead
                .read(400_000, file.len() as u64, &mut piece, failing)
                .is_err()
        );
        assert_eq!(
            ahead
                .read(400_000, file.len() as u64, &mut piece, fetch)
                .unwrap(),
            1000
        );
        assert_eq!(piece[..], file[400_000..401_000]);
        assert_eq!(fetches.get(), 5);
    }

    #[test]
    fn a_file_opened_to_be_read_whole_gives_its_bytes_and_notices_a_change_at_the_next_block() {
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("whole.bin");
        let bytes: Vec<u8> = (0..HEADER_PREFIX + 3 * READ_AHEAD)
            .map(|index| (index % 249) as u8)
            .collect();
        std::fs::write(&path, &bytes).unwrap();
        let source = SourceFile::index(&path).unwrap();
        let mut read = Vec::new();
        source.open().unwrap().read_to_end(&mut read).unwrap();
        assert_eq!(read, bytes);
        // Read into the first block past the headers; then the file changes past it.
        let mut reader = source.open().unwrap();
        let mut piece = vec![0; HEADER_PREFIX + 1000];
        reader.read_exact(&mut piece).unwrap();
        assert_eq!(piece[..], bytes[..HEADER_PREFIX + 1000]);
        std::thread::sleep(std::time::Duration::from_millis(50));
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        writer
            .seek(SeekFrom::Start((HEADER_PREFIX + 2 * READ_AHEAD) as u64))
            .unwrap();
        writer.write_all(&[250]).unwrap();
        drop(writer);
        // What was read before the change is still given; the changed file is never read as if it were the old one.
        let mut rest = Vec::new();
        assert!(reader.read_to_end(&mut rest).is_err());
        assert!(rest.len() < 2 * READ_AHEAD);
        assert_eq!(rest[..], bytes[HEADER_PREFIX + 1000..][..rest.len()]);
    }
}
