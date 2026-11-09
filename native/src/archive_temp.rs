use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MARKER: &str = ".veacom-extraction-owner.json";
const FORMAT: &str = "veacom-native-extraction-v1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    format: String,
    directory: String,
    nonce: String,
}

#[derive(Debug)]
pub struct ArchiveTempDir {
    directory: Option<PathBuf>,
    owner_lock: Option<File>,
}
impl ArchiveTempDir {
    pub fn path(&self) -> &Path {
        self.directory
            .as_deref()
            .expect("live extraction directory")
    }
}
impl Drop for ArchiveTempDir {
    fn drop(&mut self) {
        // Windows must release the ownership handle before deleting its directory.
        drop(self.owner_lock.take());
        if let Some(directory) = self.directory.take() {
            let _ = fs::remove_dir_all(directory);
        }
    }
}

/// Extractions made before RAR import was removed can outlive a crash, and they hold patient files.
const LEGACY_RAR_PREFIX: &str = "veacom-rar-";

pub fn create(prefix: &str) -> Result<ArchiveTempDir> {
    create_in(&std::env::temp_dir(), prefix)
}

fn create_in(root: &Path, prefix: &str) -> Result<ArchiveTempDir> {
    ensure!(
        prefix == "veacom-import-" || (cfg!(test) && prefix == LEGACY_RAR_PREFIX),
        "Invalid extraction directory prefix"
    );
    let nonce = crate::random::uuid_v4_simple();
    let name = format!("{prefix}{nonce}");
    #[cfg_attr(not(unix), allow(unused_mut, reason = "only Unix sets the mode"))]
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    // Fails if anything, including a symlink, already has this name.
    builder.create(root.join(&name))?;
    // Dropping this removes the directory, so a failure below leaves nothing behind.
    let mut created = ArchiveTempDir {
        directory: Some(root.join(&name)),
        owner_lock: None,
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(created.path(), fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ALL_ACCESS, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        let handle = OpenOptions::new()
            .access_mode(FILE_ALL_ACCESS)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(created.path())?;
        crate::archive_owner_windows::assign_current_user(&handle)
            .context("Cannot establish private archive directory ownership")?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.access_mode(windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS);
    }
    let mut owner_lock = options.open(created.path().join(MARKER))?;
    #[cfg(windows)]
    crate::archive_owner_windows::assign_current_user(&owner_lock)
        .context("Cannot establish private archive marker ownership")?;
    owner_lock
        .try_lock()
        .context("Cannot lock the extraction ownership marker")?;
    serde_json::to_writer(
        &mut owner_lock,
        &Owner {
            format: FORMAT.into(),
            directory: name,
            nonce,
        },
    )?;
    owner_lock.flush()?;
    created.owner_lock = Some(owner_lock);
    Ok(created)
}

pub fn cleanup_stale() -> Result<usize> {
    cleanup_in(&std::env::temp_dir())
}

fn owned_nonce(name: &str) -> Option<&str> {
    let nonce = name
        .strip_prefix("veacom-import-")
        .or_else(|| name.strip_prefix(LEGACY_RAR_PREFIX))?;
    if nonce.len() != 32 || !nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(nonce)
}

fn safe_metadata(metadata: &fs::Metadata, directory: bool) -> bool {
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Only the current account's private directories/markers can be reclaimed.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return false;
        }
        if !directory && metadata.nlink() != 1 {
            return false;
        }
    }
    true
}

fn cleanup_in(root: &Path) -> Result<usize> {
    let mut removed = 0;
    let mut failed = 0;
    for entry in fs::read_dir(root)? {
        let Ok(entry) = entry else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(nonce) = owned_nonce(&name) else {
            continue;
        };
        let path = entry.path();
        let Ok(directory_meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !safe_metadata(&directory_meta, true) {
            continue;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            };
            let Ok(directory_handle) = OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)
            else {
                continue;
            };
            if !crate::archive_owner_windows::is_current_user(&directory_handle) {
                continue;
            }
        }
        let marker = path.join(MARKER);
        let Ok(marker_meta) = fs::symlink_metadata(&marker) else {
            continue;
        };
        if !safe_metadata(&marker_meta, false) || marker_meta.len() > 4096 {
            continue;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
            );
        }
        let Ok(mut file) = options.open(&marker) else {
            continue;
        };
        let Ok(open_meta) = file.metadata() else {
            continue;
        };
        if !safe_metadata(&open_meta, false) || open_meta.len() > 4096 {
            continue;
        }
        #[cfg(windows)]
        if !crate::archive_owner_windows::is_current_user(&file) {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if open_meta.ino() != marker_meta.ino() || open_meta.dev() != marker_meta.dev() {
                continue;
            }
        }
        if file.try_lock().is_err() {
            continue;
        } // A live core owns this extraction.
        let mut bytes = Vec::new();
        if (&mut file).take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
            continue;
        }
        let Ok(owner) = serde_json::from_slice::<Owner>(&bytes) else {
            continue;
        };
        if owner.format != FORMAT || owner.directory != name || owner.nonce != nonce {
            continue;
        }
        // remove_dir_all never follows nested symlinks on the supported platforms.
        let result = fs::remove_dir_all(&path);
        drop(file);
        let result = match result {
            Ok(()) => Ok(()),
            Err(_) => fs::remove_dir_all(&path),
        };
        match result {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed += 1,
        }
    }
    if failed > 0 {
        eprintln!("Could not remove {failed} stale VEAcom extraction directories");
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn abandon(mut directory: ArchiveTempDir) -> PathBuf {
        drop(directory.owner_lock.take());
        directory.directory.take().unwrap()
    }
    #[test]
    fn keeps_active_directories_and_removes_only_marked_stale_directories() {
        let root = crate::test_dir::tempdir().unwrap();
        let active = create_in(root.path(), "veacom-import-").unwrap();
        let stale = abandon(create_in(root.path(), LEGACY_RAR_PREFIX).unwrap());
        fs::write(stale.join("patient.dcm"), b"synthetic").unwrap();
        let unmarked = root
            .path()
            .join(format!("veacom-import-{}", crate::random::uuid_v4_simple()));
        fs::create_dir(&unmarked).unwrap();
        fs::write(unmarked.join("keep"), b"owned by someone else").unwrap();
        assert_eq!(cleanup_in(root.path()).unwrap(), 1);
        assert!(active.path().exists());
        assert!(!stale.exists());
        assert!(unmarked.exists());
    }
    #[test]
    fn a_new_extraction_directory_is_private_and_removed_when_dropped() {
        let root = crate::test_dir::tempdir().unwrap();
        let directory = create_in(root.path(), "veacom-import-").unwrap();
        let path = directory.path().to_owned();
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(owned_nonce(name).map(str::len), Some(32));
        assert!(path.join(MARKER).is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        fs::write(path.join("patient.dcm"), b"synthetic").unwrap();
        drop(directory);
        assert!(!path.exists());
    }
    #[test]
    fn malformed_and_mismatched_markers_are_not_deleted() {
        let root = crate::test_dir::tempdir().unwrap();
        let malformed = abandon(create_in(root.path(), "veacom-import-").unwrap());
        fs::write(malformed.join(MARKER), b"{}").unwrap();
        let mismatched = abandon(create_in(root.path(), LEGACY_RAR_PREFIX).unwrap());
        fs::write(
            mismatched.join(MARKER),
            br#"{"format":"veacom-native-extraction-v1","directory":"elsewhere","nonce":"bad"}"#,
        )
        .unwrap();
        assert_eq!(cleanup_in(root.path()).unwrap(), 0);
        assert!(malformed.exists());
        assert!(mismatched.exists());
    }
    #[cfg(unix)]
    #[test]
    fn cleanup_never_follows_directory_or_marker_symlinks() {
        use std::os::unix::fs::symlink;
        let root = crate::test_dir::tempdir().unwrap();
        let external = crate::test_dir::tempdir().unwrap();
        fs::write(external.path().join("keep"), b"synthetic").unwrap();
        symlink(
            external.path(),
            root.path()
                .join(format!("veacom-import-{}", crate::random::uuid_v4_simple())),
        )
        .unwrap();
        let malicious = abandon(create_in(root.path(), LEGACY_RAR_PREFIX).unwrap());
        fs::remove_file(malicious.join(MARKER)).unwrap();
        symlink(external.path().join("keep"), malicious.join(MARKER)).unwrap();
        assert_eq!(cleanup_in(root.path()).unwrap(), 0);
        assert!(external.path().join("keep").exists());
    }
}
