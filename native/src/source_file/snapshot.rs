use crate::{archive_temp, random};
use anyhow::Result;
use std::{
    ffi::CString,
    fs::{self, File},
    io,
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, fs::PermissionsExt},
    },
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};

static DIRECTORY: Mutex<Weak<archive_temp::ArchiveTempDir>> = Mutex::new(Weak::new());

/// APFS clones share storage until a writer changes the original. Readers reopen the private clone, so a large
/// study does not need one open descriptor per slice. The extraction directory also handles crash cleanup.
#[derive(Debug)]
pub(super) struct Snapshot {
    path: PathBuf,
    _directory: Arc<archive_temp::ArchiveTempDir>,
}

impl Snapshot {
    pub(super) fn create(source: &File) -> Result<Self> {
        let directory = {
            let mut shared = DIRECTORY.lock().unwrap_or_else(|error| error.into_inner());
            if let Some(directory) = shared.upgrade() {
                directory
            } else {
                let directory = Arc::new(archive_temp::create("veacom-import-")?);
                *shared = Arc::downgrade(&directory);
                directory
            }
        };
        let path = directory.path().join(random::uuid_v4_simple());
        let name = CString::new(path.as_os_str().as_bytes())?;
        // fclonefileat creates a new file from this open descriptor. CLONE_NOOWNERCOPY keeps our ownership.
        if unsafe { libc::fclonefileat(source.as_raw_fd(), libc::AT_FDCWD, name.as_ptr(), 0x0002) }
            != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let snapshot = Self {
            path,
            _directory: directory,
        };
        fs::set_permissions(&snapshot.path, fs::Permissions::from_mode(0o400))?;
        Ok(snapshot)
    }

    pub(super) fn open(&self) -> io::Result<File> {
        File::open(&self.path)
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
