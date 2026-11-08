//! Private temporary directories for tests, removed when dropped.

use std::path::{Path, PathBuf};

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A new, empty directory under the system temporary directory, readable only by this account.
pub fn tempdir() -> std::io::Result<TempDir> {
    let path = std::env::temp_dir().join(format!(
        "veacom-test-{}",
        crate::random::hex(&crate::random::bytes::<16>())
    ));
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&path)?;
    Ok(TempDir(path))
}
