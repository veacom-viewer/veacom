//! Folders for extracted archive entries in a browser, where they are kept in memory (`memory_fs`) and removed when
//! the import that made them is dropped. The desktop's folders in the system temp folder (`archive_temp.rs`) need
//! owner marks and a sweep at start-up because they outlive a crash; these go with the page.

use anyhow::Result;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU32, Ordering},
};

static NEXT: AtomicU32 = AtomicU32::new(1);

pub struct ArchiveTempDir {
    directory: PathBuf,
}

impl ArchiveTempDir {
    pub fn path(&self) -> &Path {
        &self.directory
    }
}

impl Drop for ArchiveTempDir {
    fn drop(&mut self) {
        let _ = crate::vfs::remove_dir_all(&self.directory);
    }
}

pub fn create(prefix: &str) -> Result<ArchiveTempDir> {
    let directory = PathBuf::from(format!(
        "/tmp/{prefix}{}",
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    crate::vfs::create_dir_all(&directory)?;
    Ok(ArchiveTempDir { directory })
}

/// Nothing outlives the page, so nothing is left to sweep.
pub fn cleanup_stale() -> Result<usize> {
    Ok(0)
}
