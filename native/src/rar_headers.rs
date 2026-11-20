//! A RAR archive's own headers, walked before the system's reader is given the archive (system_archive.rs).
//!
//! VEAcom decodes nothing of RAR. An archive's headers are plain, and rarlab.com's technical notes describe them for
//! the RAR 4 and RAR 5 formats. Walking them tells what the reader's stream cannot:
//!
//! - that the file is a RAR archive. The reader takes every format it knows, among them a list of this computer's
//!   files for it to read.
//! - that the archive is whole: it reaches its end header, and is not one part of a set. The reader takes an archive
//!   cut between two files for a shorter one.
//! - the CRC-32 of every file in it. The reader hands over a stored file whose bytes have changed without a word
//!   (libarchive 3.8), so what it hands over is compared with these.

use anyhow::{Result, anyhow, bail};
use std::{
    fs::File,
    io::{BufReader, Read, Seek},
};

const RAR4: &[u8] = b"Rar!\x1a\x07\x00";
/// What a RAR 5 archive starts with, before one more byte: 0.
const RAR5: &[u8] = b"Rar!\x1a\x07\x01";

pub(crate) fn unreadable() -> anyhow::Error {
    anyhow!(coded!(
        "rar.unreadable",
        "This RAR archive could not be read. Extract it, then open the folder."
    ))
}
pub(crate) fn protected() -> anyhow::Error {
    anyhow!(coded!(
        "rar.protected",
        "Password-protected RAR archives cannot be opened. Extract the archive, then open the folder."
    ))
}
pub(crate) fn damaged() -> anyhow::Error {
    anyhow!(coded!(
        "rar.damaged",
        "This RAR archive is incomplete or damaged. Get it again, or extract it and open the folder."
    ))
}
pub(crate) fn too_many() -> anyhow::Error {
    anyhow!(coded!(
        "rar.tooManyEntries",
        "RAR contains too many entries"
    ))
}
fn part() -> anyhow::Error {
    anyhow!(coded!(
        "rar.part",
        "This RAR archive is one part of several. Extract them, then open the folder."
    ))
}

/// The archive read forward, and how much of it is left.
struct Walk<'a> {
    file: BufReader<&'a mut File>,
    left: u64,
    /// The CRC-32 of each file met so far, and how many there may be.
    files: Vec<u32>,
    most: usize,
}
impl Walk<'_> {
    /// The next `count` bytes; `None` where the archive ends before them.
    fn take(&mut self, count: usize) -> Result<Option<Vec<u8>>> {
        if count as u64 > self.left {
            return Ok(None);
        }
        let mut bytes = vec![0; count];
        self.file.read_exact(&mut bytes)?;
        self.left -= count as u64;
        Ok(Some(bytes))
    }

    /// Passes over the next `count` bytes; false where the archive ends before them.
    fn skip(&mut self, count: u64) -> Result<bool> {
        let Some(step) = i64::try_from(count).ok().filter(|_| count <= self.left) else {
            return Ok(false);
        };
        self.file.seek_relative(step)?;
        self.left -= count;
        Ok(true)
    }

    fn list(&mut self, crc: u32) -> Result<()> {
        if self.files.len() == self.most {
            bail!(too_many());
        }
        self.files.push(crc);
        Ok(())
    }
}

/// The CRC-32 of each file in `archive`, in its order, folders left out. Fails with the reason unless `archive` is a
/// RAR archive that reaches its end header, is no part of a set, hides no headers and holds at most `most` files,
/// each with a CRC-32. An archive that passes is left at its start, for the reader.
pub(crate) fn check(archive: &mut File, most: usize) -> Result<Vec<u32>> {
    archive.rewind()?;
    let mut walk = Walk {
        left: archive.metadata()?.len(),
        file: BufReader::new(&mut *archive),
        files: Vec::new(),
        most,
    };
    match walk.take(RAR4.len())? {
        Some(start) if start == RAR4 => rar4(&mut walk)?,
        Some(start) if start == RAR5 && walk.take(1)?.is_some_and(|rest| rest == [0]) => {
            rar5(&mut walk)?
        }
        _ => bail!(unreadable()),
    }
    let files = walk.files;
    archive.rewind()?;
    Ok(files)
}

/// A RAR 5 variable-length integer at the start of `bytes`, which it is taken from: seven bits a byte, lowest first,
/// the high bit set on every byte but the last. Nine bytes at most.
fn vint(bytes: &mut &[u8]) -> Option<u64> {
    let mut value = 0;
    for shift in (0..63).step_by(7) {
        let (&byte, rest) = bytes.split_first()?;
        *bytes = rest;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

/// RAR 5: headers up to the end header. A header is a CRC-32, a size and that many bytes; its flags say whether a
/// data area follows it, and how long.
fn rar5(walk: &mut Walk) -> Result<()> {
    const MAIN: u64 = 1;
    const FILE: u64 = 2;
    const ENCRYPTION: u64 = 4;
    const END: u64 = 5;
    loop {
        crate::progress::check()?;
        let Some(crc) = walk.take(4)? else {
            bail!(damaged())
        };
        // The size is one to three bytes. The CRC-32 covers them and the header they count.
        let mut covered = flate2::Crc::new();
        let mut size = 0;
        for shift in [0, 7, 14] {
            let Some(byte) = walk.take(1)? else {
                bail!(damaged())
            };
            covered.update(&byte);
            size |= usize::from(byte[0] & 0x7f) << shift;
            if byte[0] & 0x80 == 0 {
                break;
            }
            if shift == 14 {
                bail!(damaged());
            }
        }
        let Some(header) = walk.take(size)? else {
            bail!(damaged())
        };
        covered.update(&header);
        if covered.sum().to_le_bytes() != crc[..] {
            bail!(damaged());
        }
        let mut fields = &header[..];
        let (Some(kind), Some(flags)) = (vint(&mut fields), vint(&mut fields)) else {
            bail!(damaged())
        };
        // Header flags 1 and 2: the sizes of an extra area, which is not read here, and of the data area.
        let mut size_if = |flag| {
            if flags & flag == 0 {
                Some(0)
            } else {
                vint(&mut fields)
            }
        };
        let (Some(_extra), Some(data)) = (size_if(1), size_if(2)) else {
            bail!(damaged())
        };
        match kind {
            // The header of an archive whose other headers are encrypted.
            ENCRYPTION => bail!(protected()),
            // A main header's and an end header's first field is its own flags: 1 says the archive is one part of a
            // set, or that another part follows.
            MAIN | END => match vint(&mut fields) {
                Some(own) if own & 1 != 0 => bail!(part()),
                Some(_) if kind == END => return Ok(()),
                Some(_) => {}
                None => bail!(damaged()),
            },
            FILE => match file5(fields) {
                Some(Entry::Folder) => {}
                Some(Entry::File(Some(crc))) => walk.list(crc)?,
                // A file with another checksum than CRC-32: there is nothing here to compare it by.
                Some(Entry::File(None)) => bail!(unreadable()),
                None => bail!(damaged()),
            },
            _ => {}
        }
        if !walk.skip(data)? {
            bail!(damaged());
        }
    }
}

enum Entry {
    Folder,
    /// A file and the CRC-32 its header gives, if it gives one.
    File(Option<u32>),
}

/// A RAR 5 file header from its file flags on. `None` where it is cut short.
fn file5(mut fields: &[u8]) -> Option<Entry> {
    let flags = vint(&mut fields)?;
    let (_unpacked, _attributes) = (vint(&mut fields)?, vint(&mut fields)?);
    // File flags 1, 2 and 4: a folder; a modification time; a CRC-32 of the file. The last two are four bytes each.
    if flags & 1 != 0 {
        return Some(Entry::Folder);
    }
    if flags & 2 != 0 {
        fields = fields.get(4..)?;
    }
    if flags & 4 == 0 {
        return Some(Entry::File(None));
    }
    let crc = fields.first_chunk::<4>()?;
    Some(Entry::File(Some(u32::from_le_bytes(*crc))))
}

/// RAR 4: blocks up to the end block. A block is a CRC-16, a type, flags and its size; flag 0x8000 says data follows
/// it, whose size is the block's next field.
fn rar4(walk: &mut Walk) -> Result<()> {
    const MAIN: u8 = 0x73;
    const FILE: u8 = 0x74;
    const SERVICE: u8 = 0x7a;
    const END: u8 = 0x7b;
    loop {
        crate::progress::check()?;
        let Some(head) = walk.take(7)? else {
            bail!(damaged())
        };
        let (kind, flags) = (head[2], u16::from_le_bytes([head[3], head[4]]));
        let Some(rest) = usize::from(u16::from_le_bytes([head[5], head[6]])).checked_sub(7) else {
            bail!(damaged())
        };
        let Some(rest) = walk.take(rest)? else {
            bail!(damaged())
        };
        match kind {
            // Main flags 0x80 and 1: the headers after this one are encrypted; the archive is one part of a set.
            MAIN if flags & 0x80 != 0 => bail!(protected()),
            // End flag 1: another part follows.
            MAIN | END if flags & 1 != 0 => bail!(part()),
            END => return Ok(()),
            _ => {}
        }
        let field = |at: usize| Some(u32::from_le_bytes(*rest.get(at..)?.first_chunk::<4>()?));
        let mut data = 0;
        if flags & 0x8000 != 0 {
            let Some(low) = field(0) else {
                bail!(damaged())
            };
            data = u64::from(low);
            // File flag 0x100: the size's upper half is the field after the file's attributes.
            if matches!(kind, FILE | SERVICE) && flags & 0x100 != 0 {
                let Some(high) = field(25) else {
                    bail!(damaged())
                };
                data |= u64::from(high) << 32;
            }
        }
        // File flags 0xe0, all three set: a folder. The CRC-32 is the field after the two sizes and the system.
        if kind == FILE && flags & 0xe0 != 0xe0 {
            let Some(crc) = field(9) else {
                bail!(damaged())
            };
            walk.list(crc)?;
        }
        if !walk.skip(data)? {
            bail!(damaged());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system_archive::tests::{code, crc, header, stored_rar, vint as written};
    use std::io::Write;

    const SIGNATURE: &[u8] = b"Rar!\x1a\x07\x01\x00";

    /// One file that every archive of a test is written to in turn.
    struct Scratch {
        file: File,
        _directory: crate::test_dir::TempDir,
    }
    impl Scratch {
        fn new() -> Self {
            let directory = crate::test_dir::tempdir().unwrap();
            let path = directory.path().join("archive.rar");
            let file = File::options()
                .read(true)
                .write(true)
                .create_new(true)
                .open(path)
                .unwrap();
            Self {
                file,
                _directory: directory,
            }
        }
        /// What `check` says of a file holding `bytes`: its files' CRC-32s, or the code of its refusal.
        fn read(&mut self, bytes: &[u8]) -> Result<Vec<u32>, String> {
            self.file.set_len(0).unwrap();
            self.file.rewind().unwrap();
            self.file.write_all(bytes).unwrap();
            let result = check(&mut self.file, 3);
            if result.is_ok() {
                assert_eq!(self.file.stream_position().unwrap(), 0, "left at its start");
            }
            result.map_err(|error| code(&error).expect("a refusal with a code").to_owned())
        }
        fn refusal(&mut self, bytes: &[u8]) -> Option<String> {
            self.read(bytes).err()
        }
    }
    fn three() -> Vec<u8> {
        stored_rar(&[
            ("a.dcm", &[1u8; 300]),
            ("study/b.dcm", &[2u8; 700]),
            ("c.dcm", b""),
        ])
    }
    fn sum(bytes: &[u8]) -> u32 {
        u32::from_le_bytes(crc(bytes))
    }

    #[test]
    fn a_whole_archive_gives_its_files_checksums_and_one_cut_anywhere_does_not() {
        let mut scratch = Scratch::new();
        let whole = three();
        let files = vec![sum(&[1u8; 300]), sum(&[2u8; 700]), 0];
        assert_eq!(scratch.read(&whole), Ok(files.clone()));
        // Bytes after the end header are not the archive's.
        let appended = [whole.clone(), b"appended".to_vec()].concat();
        assert_eq!(scratch.read(&appended), Ok(files));
        for length in 0..whole.len() {
            let expected = if length < SIGNATURE.len() {
                "rar.unreadable"
            } else {
                "rar.damaged"
            };
            assert_eq!(
                scratch.refusal(&whole[..length]).as_deref(),
                Some(expected),
                "{length} bytes"
            );
        }
    }

    #[test]
    fn a_changed_byte_in_any_header_is_damage_and_one_in_a_file_is_left_to_its_checksum() {
        let mut scratch = Scratch::new();
        let entries = [file(4, &[1u8; 300]), file(4, &[2u8; 700])];
        let whole = archive(0, &entries, 0);
        let files = scratch.read(&whole).unwrap();
        // Where each file's own bytes lie: after its header, up to the next one.
        let mut next = whole.len() - header(5, 0, &[&written(0)]).len();
        let mut data = Vec::new();
        for (entry, length) in entries.iter().zip([300, 700]).rev() {
            data.push(next - length..next);
            next -= entry.len();
        }
        for at in SIGNATURE.len()..whole.len() {
            let mut changed = whole.clone();
            changed[at] ^= 0x40;
            let read = scratch.read(&changed);
            if data.iter().any(|range| range.contains(&at)) {
                assert_eq!(read, Ok(files.clone()), "byte {at} of a file");
            } else {
                assert!(read.is_err(), "byte {at} of a header");
            }
        }
    }

    /// A file header and its data: `flags` are the file's, and a CRC-32 field follows them when they say so.
    fn file(flags: u64, data: &[u8]) -> Vec<u8> {
        let length = written(data.len() as u64);
        let checksum = if flags & 4 == 0 {
            Vec::new()
        } else {
            crc(data).to_vec()
        };
        let fields: [&[u8]; 9] = [
            &length,
            &written(flags),
            &length,
            &written(0x20),
            &checksum,
            &written(0),
            &written(0),
            &written(1),
            b"x",
        ];
        [header(2, 2, &fields), data.to_vec()].concat()
    }
    fn archive(main: u64, entries: &[Vec<u8>], end: u64) -> Vec<u8> {
        [
            &[SIGNATURE.to_vec(), header(1, 0, &[&written(main)])][..],
            entries,
            &[header(5, 0, &[&written(end)])],
        ]
        .concat()
        .concat()
    }

    #[test]
    fn folders_are_left_out_and_a_file_without_a_crc_or_one_too_many_is_refused() {
        let mut scratch = Scratch::new();
        let of = |entries: &[Vec<u8>]| archive(0, entries, 0);
        let listed = scratch.read(&of(&[file(4, b"one"), file(1, b""), file(4, b"two")]));
        assert_eq!(listed, Ok(vec![sum(b"one"), sum(b"two")]));
        let plain = file(0, b"pixels");
        assert_eq!(
            scratch.refusal(&of(&[plain])).as_deref(),
            Some("rar.unreadable")
        );
        let four = [file(4, b"1"), file(4, b"2"), file(4, b"3"), file(4, b"4")];
        assert_eq!(
            scratch.refusal(&of(&four)).as_deref(),
            Some("rar.tooManyEntries")
        );
        assert!(scratch.read(&of(&four[..3])).is_ok());
    }

    #[test]
    fn a_part_of_a_set_and_hidden_headers_are_named() {
        let mut scratch = Scratch::new();
        let entry = [file(4, b"one")];
        assert_eq!(
            scratch.refusal(&archive(1, &entry, 0)).as_deref(),
            Some("rar.part")
        );
        assert_eq!(
            scratch.refusal(&archive(0, &entry, 1)).as_deref(),
            Some("rar.part")
        );
        let hidden = [
            SIGNATURE.to_vec(),
            header(4, 0, &[&written(0), &written(0), &[15], &[7u8; 16]]),
            vec![0x5a; 64],
        ]
        .concat();
        assert_eq!(scratch.refusal(&hidden).as_deref(), Some("rar.protected"));
    }

    /// A RAR 4 block: a CRC-16 that is not checked here, its type, flags, size and fields.
    fn block(kind: u8, flags: u16, fields: &[u8]) -> Vec<u8> {
        let size = (7 + fields.len()) as u16;
        [
            &[0, 0, kind][..],
            &flags.to_le_bytes(),
            &size.to_le_bytes(),
            fields,
        ]
        .concat()
    }
    /// A RAR 4 file block and its data: both sizes, the system, the CRC-32, twelve bytes of other fields and a name.
    fn file4(flags: u16, data: &[u8]) -> Vec<u8> {
        let size = (data.len() as u32).to_le_bytes();
        let fields = [&size[..], &size, &[2], &crc(data), &[0; 12], b"x"].concat();
        [block(0x74, 0x8000 | flags, &fields), data.to_vec()].concat()
    }

    #[test]
    fn a_rar_4_archive_is_walked_to_its_end_block() {
        let mut scratch = Scratch::new();
        let main = |flags| block(0x73, flags, &[0; 6]);
        let end = |flags: u16| block(0x7b, 0x4000 | flags, &[]);
        let of = |blocks: &[Vec<u8>]| [&[RAR4.to_vec()][..], blocks].concat().concat();
        let whole = of(&[
            main(0),
            file4(0, b"first"),
            file4(0xe0, b""),
            file4(0, b"second file"),
            end(0),
        ]);
        assert_eq!(
            scratch.read(&whole),
            Ok(vec![sum(b"first"), sum(b"second file")])
        );
        for length in RAR4.len()..whole.len() {
            assert_eq!(
                scratch.refusal(&whole[..length]).as_deref(),
                Some("rar.damaged"),
                "{length} bytes"
            );
        }
        let entry = file4(0, b"first");
        assert_eq!(
            scratch.refusal(&of(&[main(1), end(0)])).as_deref(),
            Some("rar.part")
        );
        assert_eq!(
            scratch
                .refusal(&of(&[main(0), entry.clone(), end(1)]))
                .as_deref(),
            Some("rar.part")
        );
        assert_eq!(
            scratch
                .refusal(&of(&[main(0x80), vec![0x5a; 64]]))
                .as_deref(),
            Some("rar.protected")
        );
        // A size above 4 GiB has its upper half in a field of its own; no such data follows here.
        let mut large = entry;
        large[3..5].copy_from_slice(&(0x8000u16 | 0x100).to_le_bytes());
        large.splice(7 + 25..7 + 25, 1u32.to_le_bytes());
        large[5..7].copy_from_slice(&((7 + 25 + 4 + 1) as u16).to_le_bytes());
        assert_eq!(
            scratch.refusal(&of(&[main(0), large, end(0)])).as_deref(),
            Some("rar.damaged")
        );
    }

    #[test]
    fn what_is_not_a_rar_archive_never_passes() {
        let mut scratch = Scratch::new();
        // A list of files for the reader to fetch, a ZIP archive's start, a RAR format not yet made.
        let others: [&[u8]; 5] = [
            b"#mtree\n./pulled.txt type=file contents=C:/Users/Public/notes.txt\n",
            b"PK\x03\x04\x14\x00\x00\x00\x08\x00",
            b"Rar!\x1a\x07\x02\x00",
            b"Rar!",
            b"",
        ];
        for bytes in others {
            assert_eq!(scratch.refusal(bytes).as_deref(), Some("rar.unreadable"));
        }
    }
}
