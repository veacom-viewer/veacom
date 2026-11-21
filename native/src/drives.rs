//! The PC's drives, for the import window's list of places (electron/file-browser.cjs). Windows only.

use serde::Serialize;
use windows_sys::Win32::Storage::FileSystem::{
    GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
};
use windows_sys::Win32::System::Diagnostics::Debug::{SEM_FAILCRITICALERRORS, SetThreadErrorMode};

// GetDriveTypeW's answers (winbase.h).
const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_REMOTE: u32 = 4;
const DRIVE_CDROM: u32 = 5;
/// MAX_PATH + 1 UTF-16 units, the longest volume name GetVolumeInformationW gives.
const NAME_UNITS: usize = 261;

#[derive(Serialize)]
pub struct Drive {
    letter: char,
    /// `removable`, `fixed`, `network` or `disc`.
    kind: &'static str,
    /// The volume's name; empty where it has none or was not asked for it.
    label: String,
}

/// Every drive letter in use, with its kind. Windows keeps the kind itself and asks no drive for it, so a disc drive
/// is listed with no disc in it, and a network drive with its server gone.
///
/// A volume's name is read from the volume, and that waits on a drive that does not answer. It is read only for the
/// letters in `answering`, which the caller has just reached; the others are listed without one.
pub fn list(answering: &[char]) -> Vec<Drive> {
    // SAFETY: the call takes no arguments.
    let present = unsafe { GetLogicalDrives() };
    ('A'..='Z')
        .enumerate()
        .filter(|(bit, _)| present & (1 << bit) != 0)
        .map(|(_, letter)| Drive {
            letter,
            kind: kind(letter),
            label: if answering.contains(&letter) {
                label(letter)
            } else {
                String::new()
            },
        })
        .collect()
}

/// `X:\`, NUL-terminated, for a letter A to Z.
fn root(letter: char) -> [u16; 4] {
    [letter as u16, u16::from(b':'), u16::from(b'\\'), 0]
}

fn kind(letter: char) -> &'static str {
    // SAFETY: the root is a NUL-terminated string that lives through the call.
    match unsafe { GetDriveTypeW(root(letter).as_ptr()) } {
        DRIVE_REMOVABLE => "removable",
        DRIVE_REMOTE => "network",
        DRIVE_CDROM => "disc",
        // A RAM disk, and a kind Windows does not know, are places to open files from like a fixed drive.
        _ => "fixed",
    }
}

/// `read`, with Windows' critical-error message off for this thread while it runs, and the thread's mode as it was
/// after. Asked for the name of a drive whose disc was just taken out, Windows would otherwise ask in a window of its
/// own for a disc to be put in, and the call would wait for that window to be answered.
fn without_disc_prompt<T>(read: impl FnOnce() -> T) -> T {
    let mut before = 0;
    // SAFETY: the old mode is written to a local that lives through the call.
    let set = unsafe { SetThreadErrorMode(SEM_FAILCRITICALERRORS, &mut before) } != 0;
    let result = read();
    if set {
        // SAFETY: a null pointer asks for no old mode, which the call accepts.
        unsafe { SetThreadErrorMode(before, std::ptr::null_mut()) };
    }
    result
}

fn label(letter: char) -> String {
    let mut name = [0u16; NAME_UNITS];
    // SAFETY: the root is NUL-terminated, the name's buffer is passed with its length in units, and each fact that
    // is not asked for is a null pointer, which the call accepts.
    let read = without_disc_prompt(|| unsafe {
        GetVolumeInformationW(
            root(letter).as_ptr(),
            name.as_mut_ptr(),
            NAME_UNITS as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    });
    if read == 0 {
        // No disc or card in the drive, or a volume that cannot be read: it has no name to show.
        return String::new();
    }
    let end = name
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(NAME_UNITS);
    String::from_utf16_lossy(&name[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_letter() -> char {
        let drive = std::env::var("SystemDrive").expect("Windows sets SystemDrive");
        drive.chars().next().unwrap().to_ascii_uppercase()
    }

    #[test]
    fn the_system_drive_is_a_fixed_drive_and_is_named_only_when_asked() {
        let system = system_letter();
        let unasked = list(&[]);
        assert!(
            unasked
                .windows(2)
                .all(|pair| pair[0].letter < pair[1].letter)
        );
        assert!(unasked.iter().all(|drive| drive.label.is_empty()));
        let found = unasked.iter().find(|drive| drive.letter == system);
        assert_eq!(found.map(|drive| drive.kind), Some("fixed"));

        // The name itself is this PC's own: what can be checked is that asking changes nothing else.
        let asked = list(&[system]);
        assert_eq!(asked.len(), unasked.len());
        for (with, without) in asked.iter().zip(&unasked) {
            assert_eq!((with.letter, with.kind), (without.letter, without.kind));
            assert!(with.letter == system || with.label.is_empty());
        }
    }

    #[test]
    fn a_letter_without_a_drive_is_not_listed_and_has_no_name() {
        let present = list(&[]);
        let free = ('A'..='Z').find(|letter| present.iter().all(|drive| drive.letter != *letter));
        // Every letter can be in use; then there is nothing to ask.
        let Some(free) = free else { return };
        assert!(list(&[free]).iter().all(|drive| drive.letter != free));
        assert_eq!(label(free), "");
    }

    #[test]
    fn a_name_is_read_with_the_disc_prompt_off_and_the_threads_mode_as_it_was_after() {
        use windows_sys::Win32::System::Diagnostics::Debug::GetThreadErrorMode;
        // SAFETY: the call takes no arguments.
        let mode = || unsafe { GetThreadErrorMode() };
        let before = mode();
        let during = without_disc_prompt(mode);
        assert_eq!(during & SEM_FAILCRITICALERRORS, SEM_FAILCRITICALERRORS);
        assert_eq!(mode(), before);
    }
}
