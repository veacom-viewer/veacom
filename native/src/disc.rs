//! Discs (CD, DVD) on Windows: whether a path is on one, and the room this computer has for a copy of it. Elsewhere a
//! disc is one more mounted volume, and nothing tells it from the others.

use std::{
    os::windows::ffi::OsStrExt,
    path::{Component, Path, Prefix},
};
use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW};

// GetDriveTypeW's answer for a CD or DVD drive (winbase.h).
const DRIVE_CDROM: u32 = 5;

/// The size in bytes of the disc `path` is on; None where it is not on a CD or DVD drive, or the drive is empty.
pub fn size(path: &Path) -> Option<u64> {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return None;
    };
    let (Prefix::Disk(letter) | Prefix::VerbatimDisk(letter)) = prefix.kind() else {
        return None;
    };
    let root = [u16::from(letter), u16::from(b':'), u16::from(b'\\'), 0];
    // SAFETY: the root is a NUL-terminated string that lives through the call.
    if unsafe { GetDriveTypeW(root.as_ptr()) } != DRIVE_CDROM {
        return None;
    }
    let mut total = 0;
    // SAFETY: as above; the one size asked for is written to a u64 of ours, and the others are not asked for.
    let asked = unsafe {
        GetDiskFreeSpaceExW(
            root.as_ptr(),
            std::ptr::null_mut(),
            &mut total,
            std::ptr::null_mut(),
        )
    };
    (asked != 0).then_some(total)
}

/// The bytes this user may still write where the folder `directory` is.
pub fn free(directory: &Path) -> Option<u64> {
    let name: Vec<u16> = directory.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0;
    // SAFETY: the name is a NUL-terminated string that lives through the call; the one size asked for is written to
    // a u64 of ours.
    let asked = unsafe {
        GetDiskFreeSpaceExW(
            name.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (asked != 0).then_some(free)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fixed_drive_is_no_disc_and_the_temporary_folder_has_room() {
        let temp = std::env::temp_dir();
        assert_eq!(size(&temp), None);
        assert_eq!(size(Path::new("relative\\folder")), None);
        assert_eq!(size(Path::new("\\\\server\\share\\folder")), None);
        assert!(free(&temp).is_some_and(|bytes| bytes > 0));
        assert_eq!(free(&temp.join("no such folder here")), None);
    }
}
