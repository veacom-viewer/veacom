use super::changed;
use std::{
    fs::{File, Metadata},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{FileExt, MetadataExt},
    },
    time::{SystemTime, UNIX_EPOCH},
};

/// Ordinary writes change ctime even when a writer restores mtime. A previously writable mapping needs a separate guard.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Stamp {
    device: u64,
    inode: u64,
    len: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}

impl Stamp {
    fn from(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            len: metadata.len(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }

    pub(super) fn capture(file: &File, metadata: &Metadata) -> Option<Self> {
        let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // fstatfs writes one statfs value on success. The descriptor stays open for the call.
        if unsafe { libc::fstatfs(file.as_raw_fd(), info.as_mut_ptr()) } != 0 {
            return None;
        }
        let info = unsafe { info.assume_init() };
        #[cfg(target_os = "linux")]
        let local = matches!(
            info.f_type,
            libc::EXT4_SUPER_MAGIC | libc::BTRFS_SUPER_MAGIC | 0x58465342 /* XFS */
        );
        #[cfg(target_os = "macos")]
        let local = info
            .f_fstypename
            .starts_with(&[b'a' as _, b'p' as _, b'f' as _, b's' as _, 0]);
        (local && metadata.ino() != 0).then(|| Self::from(metadata))
    }

    pub(super) fn settled(&self) -> bool {
        // A write in the same filesystem clock tick could keep the same ctime. Recently written files use block hashes.
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .is_ok_and(|now| now.as_secs() as i64 - self.changed.0 > 2)
    }

    pub(super) fn verify(&self, file: &File) -> io::Result<()> {
        if *self == Self::from(&file.metadata()?) {
            return Ok(());
        }
        Err(io::Error::new(io::ErrorKind::InvalidData, changed()))
    }

    pub(super) fn read(
        &self,
        original: &File,
        contents: &File,
        dst: &mut [u8],
        offset: u64,
    ) -> io::Result<usize> {
        self.verify(original)?;
        let n = contents.read_at(dst, offset)?;
        self.verify(original)?;
        Ok(n)
    }
}

/// A Linux read lease cannot be acquired over an existing writable open or shared writable mapping.
/// Release it immediately. A writer that starts afterwards must change the already settled ctime on its first write.
#[cfg(target_os = "linux")]
pub(super) fn no_existing_writer(file: &File) -> bool {
    let fd = file.as_raw_fd();
    // Linux F_SETSIG is 10 on the supported x86 and ARM targets. SIGURG is ignored by default, so a racing
    // lease-break notification cannot terminate the engine. Both operations affect only this open descriptor.
    unsafe {
        libc::fcntl(fd, 10, libc::SIGURG) != -1
            && libc::fcntl(fd, libc::F_SETLEASE, libc::F_RDLCK) != -1
            && libc::fcntl(fd, libc::F_SETLEASE, libc::F_UNLCK) != -1
    }
}
