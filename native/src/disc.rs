//! Discs (CD, DVD) on Windows: whether a path is on one, which disc it is, and the room this computer has for a copy
//! of it. Elsewhere a disc is one more mounted volume, and nothing tells it from the others.

use std::{
    os::windows::ffi::OsStrExt,
    path::{Component, Path, Prefix},
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetVolumeInformationW,
};

// GetDriveTypeW's answer for a CD or DVD drive (winbase.h).
const DRIVE_CDROM: u32 = 5;

/// The root of the drive `path` is on (as "F:\", NUL-terminated); None for a path that names no drive letter.
fn root(path: &Path) -> Option<[u16; 4]> {
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return None;
    };
    let (Prefix::Disk(letter) | Prefix::VerbatimDisk(letter)) = prefix.kind() else {
        return None;
    };
    Some([u16::from(letter), u16::from(b':'), u16::from(b'\\'), 0])
}

/// The size in bytes of the disc `path` is on; None where it is not on a CD or DVD drive, or the drive is empty.
pub fn size(path: &Path) -> Option<u64> {
    let root = root(path)?;
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

/// The serial number of the volume `path` is on: another disc put in the drive has another one. None where the drive
/// is empty or names no letter.
pub fn serial(path: &Path) -> Option<u32> {
    let root = root(path)?;
    let mut serial = 0;
    // SAFETY: the root is a NUL-terminated string that lives through the call; the serial number is written to a u32
    // of ours, and nothing else is asked for (null buffers of length 0).
    let asked = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    (asked != 0).then_some(serial)
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

    #[test]
    fn a_volume_keeps_its_serial_number_and_a_path_without_a_drive_has_none() {
        let temp = std::env::temp_dir();
        let volume = serial(&temp);
        assert!(volume.is_some());
        assert_eq!(serial(&temp.join("no such folder here")), volume);
        assert_eq!(serial(Path::new("relative\\folder")), None);
        assert_eq!(serial(Path::new("\\\\server\\share\\folder")), None);
    }
}
