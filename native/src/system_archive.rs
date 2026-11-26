//! RAR archives, read by the system's own archive reader, on Windows.
//!
//! VEAcom has no RAR decoder of its own. bsdtar, which Windows 10 and later ship as tar.exe and keep up to date, reads
//! the archive in a process of its own and writes the archive's files to its standard output as a tar stream. This
//! module reads that stream and writes the files into the import's extraction folder.
//!
//! The reader is given the archive as its standard input and nothing else: no file name, no folder to write to, an
//! almost empty environment and no window. Every name and size in its stream is checked here before a file is made,
//! as a ZIP entry's is (ingest.rs): the reader's own checks are not relied on. The archive's own headers are walked
//! first (rar_headers.rs), and each file written is compared with the CRC-32 they give. The reader runs restricted
//! from its first instruction (archive_reader_windows.rs). macOS and Linux have no reader started that way here, and
//! refuse RAR (ingest.rs).

use crate::archive_reader_windows::Reader;
use anyhow::{Context, Result, anyhow, bail};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

/// What one extraction may write, as for a ZIP.
pub(crate) struct Limits {
    pub files: usize,
    pub file_bytes: u64,
    pub total_bytes: u64,
    /// The bytes this computer's disk can take of the archive's files and still keep its spare (see ingest.rs's
    /// `room`); None where nothing says.
    pub room: Option<u64>,
}

const BLOCK: usize = 512;
/// The longest extended header of one entry: its name and little else.
const MAX_EXTENDED: u64 = 64 << 10;
/// The folders above a file and the bytes of its whole name: a stream cannot make folders without end.
const MAX_PARTS: usize = 32;
const MAX_NAME: usize = 1024;
/// What the reader is asked: a tar archive on its standard output, of the archive on its standard input.
pub(crate) const READ: &[&str] = &["-cf", "-", "-b", "128", "@-"];

/// The system's bsdtar by its full path, or None where the system has none.
pub(crate) fn reader() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
    // The system folder as Windows names it, not as an environment variable or the search path does.
    let mut folder = [0u16; 260];
    // SAFETY: the buffer is valid for the length passed.
    let length = unsafe { GetSystemDirectoryW(folder.as_mut_ptr(), folder.len() as u32) } as usize;
    if length == 0 || length >= folder.len() {
        return None;
    }
    let program = PathBuf::from(std::ffi::OsString::from_wide(&folder[..length])).join("tar.exe");
    program.is_file().then_some(program)
}

fn no_reader() -> anyhow::Error {
    anyhow!(coded!(
        "rar.noReader",
        "RAR archives cannot be opened on this computer. Extract the archive, then open the folder."
    ))
}

/// The reader, running restricted with `archive` as its standard input; with its standard output and error.
fn start(program: &Path, archive: File) -> io::Result<(Reader, io::PipeReader, io::PipeReader)> {
    let (stream, output) = io::pipe()?;
    let (complaints, errors) = io::pipe()?;
    let reader = crate::archive_reader_windows::create(
        program,
        READ,
        archive,
        output.into(),
        errors.into(),
    )?;
    reader.start()?;
    Ok((reader, stream, complaints))
}

/// Why reading the stream stopped.
enum Stop {
    /// VEAcom refused something, could not write, or was cancelled: its own message stands.
    Refused(anyhow::Error),
    /// The stream ended early or was not a tar stream: the reader could not read the archive.
    Stream,
}
impl From<anyhow::Error> for Stop {
    fn from(error: anyhow::Error) -> Self {
        Self::Refused(error)
    }
}

/// Extracts every file of the RAR archive into `dir`, and gives the bytes written.
pub(crate) fn extract_into(archive: &Path, dir: &Path, limits: &Limits) -> Result<u64> {
    let Some(program) = reader() else {
        return Err(no_reader());
    };
    // The reader is started only for a whole RAR archive, and what it hands over is compared with the checksums
    // the archive's own headers give (rar_headers.rs).
    let mut archive = File::open(archive)?;
    let expected = crate::rar_headers::check(&mut archive, limits.files)?;
    // A reader that cannot be started with its restrictions is not started at all.
    let (reader, stream, mut complaints) = match start(&program, archive) {
        Ok(started) => started,
        Err(error) => {
            eprintln!("The archive reader could not be started restricted: {error}");
            return Err(no_reader());
        }
    };
    let over = AtomicBool::new(false);
    /// Tells the watch below that the reading is over, however it ended.
    struct Over<'a>(&'a AtomicBool);
    impl Drop for Over<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let (written, status, complaints) = std::thread::scope(|scope| {
        let _over = Over(&over);
        // What the reader says of the archive, only to tell a protected one from a damaged one. It is never shown,
        // and a reader that says nothing readable is treated as one that said nothing.
        let said = scope.spawn(move || {
            let mut text = Vec::new();
            let _ = (&mut complaints).take(4096).read_to_end(&mut text);
            let _ = io::copy(&mut complaints, &mut io::sink());
            text
        });
        // A reader that has stopped writing holds the reading below in a read no check can interrupt: a cancelled
        // import ends the reader, and with it that read.
        scope.spawn(|| {
            while !over.load(Ordering::Acquire) {
                if crate::progress::check().is_err() {
                    reader.end();
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let written = write_entries(stream, dir, limits);
        if written.is_err() {
            reader.end();
        }
        let status = reader.wait();
        (written, status, said.join().unwrap_or_default())
    });
    crate::progress::check()?;
    let protected = {
        let text = String::from_utf8_lossy(&complaints).to_ascii_lowercase();
        text.contains("encrypt") || text.contains("passphrase") || text.contains("password")
    };
    match written {
        Err(Stop::Refused(error)) => Err(error),
        _ if protected => Err(crate::rar_headers::protected()),
        Ok((written, bytes)) if status == Some(0) => {
            if written != expected {
                bail!(crate::rar_headers::damaged());
            }
            Ok(bytes)
        }
        _ => Err(crate::rar_headers::unreadable()),
    }
}

/// One entry's header in the stream.
struct Entry {
    name: String,
    size: u64,
    /// The tar type: b'0' or 0 for a file, b'5' for a folder; anything else is a link or a device.
    kind: u8,
}

/// Writes each file of the tar stream below `dir`, within `limits`: the CRC-32 of each file written, and the bytes
/// written in all.
fn write_entries(
    mut stream: impl Read,
    dir: &Path,
    limits: &Limits,
) -> Result<(Vec<u32>, u64), Stop> {
    let (mut files, mut remaining) = (Vec::new(), limits.total_bytes);
    let mut room = limits.room;
    let mut buffer = vec![0u8; 256 << 10];
    while let Some(entry) = next_entry(&mut stream)? {
        crate::progress::check()?;
        if entry.kind == b'5' {
            continue;
        }
        if !matches!(entry.kind, b'0' | 0) {
            return Err(anyhow::Error::from(coded!(
                "rar.link",
                "RAR links and special files are not accepted"
            ))
            .into());
        }
        if files.len() == limits.files {
            return Err(crate::rar_headers::too_many().into());
        }
        if entry.size > limits.file_bytes {
            return Err(anyhow::Error::from(coded!(
                "rar.entryTooLarge",
                "RAR entry exceeds the per-file limit"
            ))
            .into());
        }
        if entry.size > remaining {
            return Err(anyhow::Error::from(coded!(
                "rar.tooLarge",
                "RAR expanded data exceeds the import limit"
            ))
            .into());
        }
        if room.is_some_and(|room| entry.size > room) {
            return Err(anyhow::Error::from(coded!(
                "rar.noRoom",
                "This computer's disk does not have room for this RAR's files."
            ))
            .into());
        }
        let Some(inside) = enclosed(&entry.name) else {
            return Err(anyhow::anyhow!("RAR entry escapes its directory").into());
        };
        let target = dir.join(inside);
        if !target.starts_with(dir) || target == dir {
            return Err(anyhow::anyhow!("RAR entry escapes its directory").into());
        }
        fs::create_dir_all(target.parent().context("Invalid RAR path")?)
            .map_err(anyhow::Error::from)?;
        let mut output = File::options()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(anyhow::Error::from)?;
        let mut crc = flate2::Crc::new();
        let mut left = entry.size;
        while left > 0 {
            let want = buffer
                .len()
                .min(usize::try_from(left).unwrap_or(usize::MAX));
            // A stream that ends inside a file is the reader's failure, not VEAcom's refusal.
            stream
                .read_exact(&mut buffer[..want])
                .map_err(|_| Stop::Stream)?;
            output
                .write_all(&buffer[..want])
                .map_err(anyhow::Error::from)?;
            crc.update(&buffer[..want]);
            left -= want as u64;
            crate::progress::check()?;
        }
        output.flush().map_err(anyhow::Error::from)?;
        drop(output);
        files.push(crc.sum());
        remaining -= entry.size;
        room = room.map(|room| room - entry.size);
        skip(&mut stream, padding(entry.size))?;
    }
    Ok((files, limits.total_bytes - remaining))
}

/// The bytes after `size` bytes of data up to the next block.
fn padding(size: u64) -> u64 {
    (BLOCK as u64 - size % BLOCK as u64) % BLOCK as u64
}

fn skip(stream: &mut impl Read, bytes: u64) -> Result<(), Stop> {
    let copied = io::copy(&mut stream.take(bytes), &mut io::sink()).map_err(|_| Stop::Stream)?;
    if copied == bytes {
        Ok(())
    } else {
        Err(Stop::Stream)
    }
}

/// The next file or folder of the stream, or None at its end. bsdtar writes "restricted pax": plain tar headers, with
/// an extended header before an entry whose name or size a plain header cannot hold. Anything else ends the reading.
fn next_entry(stream: &mut impl Read) -> Result<Option<Entry>, Stop> {
    let (mut name, mut size) = (None, None);
    loop {
        let mut block = [0u8; BLOCK];
        stream.read_exact(&mut block).map_err(|_| Stop::Stream)?;
        if block.iter().all(|&byte| byte == 0) {
            // The end of the archive. What follows is more of the same, to the end of the reader's last record.
            let rest =
                io::copy(&mut stream.take(1 << 20), &mut io::sink()).map_err(|_| Stop::Stream)?;
            return if rest < 1 << 20 {
                Ok(None)
            } else {
                Err(Stop::Stream)
            };
        }
        let sum: u64 = block
            .iter()
            .enumerate()
            .map(|(at, &byte)| {
                if (148..156).contains(&at) {
                    32
                } else {
                    u64::from(byte)
                }
            })
            .sum();
        if &block[257..262] != b"ustar" || octal(&block[148..156]) != Some(sum) {
            return Err(Stop::Stream);
        }
        let stated = octal(&block[124..136]).ok_or(Stop::Stream)?;
        match block[156] {
            b'x' | b'g' => {
                if stated > MAX_EXTENDED {
                    return Err(Stop::Stream);
                }
                let mut records = vec![0u8; stated as usize];
                stream.read_exact(&mut records).map_err(|_| Stop::Stream)?;
                skip(stream, padding(stated))?;
                // A global header ('g') describes the archive, not an entry: read past it.
                if block[156] == b'x' {
                    for (key, value) in extended(&records).ok_or(Stop::Stream)? {
                        match key {
                            b"path" => {
                                name = Some(
                                    String::from_utf8(value.to_vec()).map_err(|_| Stop::Stream)?,
                                )
                            }
                            b"size" => size = Some(decimal(value).ok_or(Stop::Stream)?),
                            // The reader could not write this name as text.
                            b"hdrcharset" if value == b"BINARY" => return Err(Stop::Stream),
                            _ => {}
                        }
                    }
                }
            }
            kind => {
                let name = match name {
                    Some(name) => name,
                    None => {
                        let (prefix, last) = (text(&block[345..500]), text(&block[..100]));
                        let joined = if prefix.is_empty() {
                            last.to_vec()
                        } else {
                            [prefix, b"/", last].concat()
                        };
                        String::from_utf8(joined).map_err(|_| Stop::Stream)?
                    }
                };
                return Ok(Some(Entry {
                    name,
                    size: size.unwrap_or(stated),
                    kind,
                }));
            }
        }
    }
}

/// A header's text field up to its first NUL.
fn text(field: &[u8]) -> &[u8] {
    &field[..field
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(field.len())]
}

/// A header's number: octal digits, ended by a NUL or a space. None for anything else (a binary size, say).
fn octal(field: &[u8]) -> Option<u64> {
    let digits = field
        .iter()
        .position(|&byte| byte == 0 || byte == b' ')
        .map_or(field, |end| &field[..end]);
    if digits.is_empty()
        || !field[digits.len()..]
            .iter()
            .all(|&byte| byte == 0 || byte == b' ')
    {
        return None;
    }
    digits.iter().try_fold(0u64, |value, &digit| {
        matches!(digit, b'0'..=b'7')
            .then(|| value.checked_mul(8)?.checked_add(u64::from(digit - b'0')))?
    })
}

fn decimal(digits: &[u8]) -> Option<u64> {
    if digits.is_empty() || digits.len() > 19 {
        return None;
    }
    digits.iter().try_fold(0u64, |value, &digit| {
        digit
            .is_ascii_digit()
            .then(|| value.checked_mul(10)?.checked_add(u64::from(digit - b'0')))?
    })
}

/// The records of an extended header: each is "<length> <key>=<value>\n", the length counting the whole record.
fn extended(mut records: &[u8]) -> Option<Vec<(&[u8], &[u8])>> {
    let mut found = Vec::new();
    while !records.is_empty() {
        let space = records.iter().position(|&byte| byte == b' ')?;
        let length = usize::try_from(decimal(&records[..space])?).ok()?;
        if length <= space + 1 || length > records.len() || records[length - 1] != b'\n' {
            return None;
        }
        let record = &records[space + 1..length - 1];
        let equals = record.iter().position(|&byte| byte == b'=')?;
        found.push((&record[..equals], &record[equals + 1..]));
        records = &records[length..];
    }
    Some(found)
}

/// `name` as a path of plain parts, in this system's separators, that stays inside the folder it is joined to; None
/// for anything else: an absolute name, "..", an empty name, a name too deep or too long, and a part that Windows
/// reads specially (a colon, a device name, a trailing dot or space, a control character).
pub(crate) fn enclosed(name: &str) -> Option<PathBuf> {
    if name.len() > MAX_NAME || name.starts_with(['/', '\\']) || name.contains('\0') {
        return None;
    }
    let mut inside = PathBuf::new();
    let mut parts = 0;
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return None,
            part if !plain(part) => return None,
            part => inside.push(part),
        }
        parts += 1;
        if parts > MAX_PARTS {
            return None;
        }
    }
    (parts > 0).then_some(inside)
}

/// Whether Windows takes `part` as the plain name of a file or folder.
fn plain(part: &str) -> bool {
    // Windows reads a device's name with any extension, and with spaces after it, as the device (Naming Files,
    // Paths, and Namespaces: CON, PRN, AUX, NUL, COM1 to COM9 and LPT1 to LPT9, the last digit also as ¹, ² or ³).
    let stem = part.split('.').next().unwrap_or(part).trim_end_matches(' ');
    let mut letters = stem.chars();
    let port: String = letters.by_ref().take(3).collect();
    let numbered = (port.eq_ignore_ascii_case("COM") || port.eq_ignore_ascii_case("LPT"))
        && letters
            .next()
            .is_some_and(|last| matches!(last, '0'..='9' | '¹' | '²' | '³'))
        && letters.next().is_none();
    let device = numbered
        || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"]
            .iter()
            .any(|name| stem.eq_ignore_ascii_case(name));
    !device
        && part.encode_utf16().count() <= 255
        && !part.ends_with(['.', ' '])
        && !part
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A RAR 5 variable-length integer.
    pub(crate) fn vint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let low = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                bytes.push(low);
                return bytes;
            }
            bytes.push(low | 0x80);
        }
    }
    pub(crate) fn crc(bytes: &[u8]) -> [u8; 4] {
        let mut crc = flate2::Crc::new();
        crc.update(bytes);
        crc.sum().to_le_bytes()
    }
    /// One RAR 5 header: the CRC-32 of what follows, its size, then its type, flags and fields.
    pub(crate) fn header(kind: u64, flags: u64, fields: &[&[u8]]) -> Vec<u8> {
        let mut body = [vint(kind), vint(flags)].concat();
        for field in fields {
            body.extend_from_slice(field);
        }
        let sized = [vint(body.len() as u64), body].concat();
        [crc(&sized).to_vec(), sized].concat()
    }
    const SIGNATURE: [u8; 8] = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
    /// A RAR 5 archive whose files are stored, not compressed: headers and the files' own bytes, which needs none of
    /// RAR's compression (RAR 5.0 archive format, rarlab.com technote).
    pub(crate) fn stored_rar(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut archive = [SIGNATURE.to_vec(), header(1, 0, &[&vint(0)])].concat();
        for (name, data) in files {
            let length = vint(data.len() as u64);
            archive.extend(header(
                2,
                0x0002,
                &[
                    &length,
                    &vint(0x0004),
                    &length,
                    &vint(0x20),
                    &crc(data),
                    &vint(0),
                    &vint(0),
                    &vint(name.len() as u64),
                    name.as_bytes(),
                ],
            ));
            archive.extend_from_slice(data);
        }
        archive.extend(header(5, 0, &[&vint(0)]));
        archive
    }

    /// A plain tar header.
    fn tar_header(name: &str, size: u64, kind: u8) -> Vec<u8> {
        let mut block = vec![0u8; BLOCK];
        block[..name.len()].copy_from_slice(name.as_bytes());
        block[100..108].copy_from_slice(b"0000644\0");
        block[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());
        block[148..156].copy_from_slice(b"        ");
        block[156] = kind;
        block[257..263].copy_from_slice(b"ustar\0");
        block[263..265].copy_from_slice(b"00");
        let sum: u64 = block.iter().map(|&byte| u64::from(byte)).sum();
        block[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        block
    }
    fn tar_entry(name: &str, data: &[u8], kind: u8) -> Vec<u8> {
        let mut bytes = tar_header(name, data.len() as u64, kind);
        bytes.extend_from_slice(data);
        bytes.resize(bytes.len() + padding(data.len() as u64) as usize, 0);
        bytes
    }
    fn tar_end() -> Vec<u8> {
        vec![0u8; 2 * BLOCK]
    }
    const ROOMY: Limits = Limits {
        files: 100,
        file_bytes: 1 << 20,
        total_bytes: 4 << 20,
        room: None,
    };
    /// Every file below `dir`, sorted.
    fn files_in(dir: &Path) -> Vec<PathBuf> {
        let (mut pending, mut found) = (vec![dir.to_owned()], Vec::new());
        while let Some(next) = pending.pop() {
            for entry in std::fs::read_dir(next).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    found.push(path);
                }
            }
        }
        found.sort();
        found
    }
    fn written(stream: &[u8], dir: &Path, limits: &Limits) -> Result<Vec<PathBuf>> {
        match write_entries(stream, dir, limits) {
            Ok(_) => Ok(files_in(dir)),
            Err(Stop::Refused(error)) => Err(error),
            Err(Stop::Stream) => bail!("stream"),
        }
    }
    pub(crate) fn code(error: &anyhow::Error) -> Option<&str> {
        crate::message::coded(error).map(|note| note.code)
    }

    #[test]
    fn names_that_would_leave_the_folder_or_mean_something_to_windows_are_refused() {
        assert_eq!(enclosed("a/b.dcm"), Some(PathBuf::from("a").join("b.dcm")));
        assert_eq!(enclosed("./a//b"), Some(PathBuf::from("a").join("b")));
        assert_eq!(
            enclosed("çğıöşü/İM 1.dcm"),
            Some(PathBuf::from("çğıöşü").join("İM 1.dcm"))
        );
        let (deep, long) = ("a/".repeat(MAX_PARTS + 1), "n".repeat(MAX_NAME + 1));
        for name in [
            "", ".", "/a", "\\a", "../a", "a/../b", "a/..", "a\0b", &deep, &long,
        ] {
            assert_eq!(enclosed(name), None, "{name:?}");
        }
        for name in [
            "C:a",
            "a/C:b/c",
            "a:stream",
            "NUL",
            "nul.txt",
            "a/COM1.dcm",
            "com¹",
            "LPT9",
            "aux .txt",
            "a./b",
            "a /b",
            "a/b.",
            "a<b",
            "a|b",
            "a\tb",
        ] {
            assert_eq!(enclosed(name), None, "{name:?}");
        }
        // Not device names, whatever letters they hold.
        for name in ["COM10.dcm", "NULL", "console", "abç", "abçd", "çğı1"] {
            assert!(enclosed(name).is_some(), "{name:?}");
        }
    }

    #[test]
    fn a_tar_stream_is_written_file_by_file_with_plain_and_extended_names() {
        let dir = crate::test_dir::tempdir().unwrap();
        let long = format!("deep/{}.dcm", "n".repeat(150));
        let record = format!("path={long}\n");
        // An extended header's record states its own length, the digits of that length included.
        let record = format!("{} {record}", record.len() + 4);
        assert_eq!(
            record.len(),
            record.split(' ').next().unwrap().parse::<usize>().unwrap()
        );
        let stream = [
            tar_entry("study/", b"", b'5'),
            tar_entry("study/a.dcm", b"first", b'0'),
            tar_entry("PaxHeader/x", record.as_bytes(), b'x'),
            tar_entry("study/short-name", &[7u8; 700], b'0'),
            tar_end(),
        ]
        .concat();
        let found = written(&stream, dir.path(), &ROOMY).unwrap();
        let (plain, extended) = (
            dir.path().join("study").join("a.dcm"),
            dir.path().join(enclosed(&long).unwrap()),
        );
        // The file under the extended header took that header's name, not the short one in its own header.
        assert_eq!(found, [extended.clone(), plain.clone()]);
        assert_eq!(std::fs::read(plain).unwrap(), b"first");
        assert_eq!(std::fs::read(extended).unwrap(), [7u8; 700]);
        // Each file's CRC-32, in the stream's order, for the comparison with the archive's headers.
        let again = crate::test_dir::tempdir().unwrap();
        let sums = (write_entries(&stream[..], again.path(), &ROOMY).ok()).map(|(sums, _)| sums);
        let sum = |bytes: &[u8]| u32::from_le_bytes(crc(bytes));
        assert_eq!(sums, Some(vec![sum(b"first"), sum(&[7u8; 700])]));
    }

    #[test]
    fn a_stream_is_refused_at_a_bad_name_a_link_a_limit_or_a_damaged_header() {
        let refused = |stream: Vec<u8>, limits: &Limits| {
            let dir = crate::test_dir::tempdir().unwrap();
            let error = written(&stream, dir.path(), limits).unwrap_err();
            (code(&error).map(str::to_owned), error.to_string())
        };
        let file = |name: &str| [tar_entry(name, b"data", b'0'), tar_end()].concat();
        assert!(refused(file("../outside"), &ROOMY).1.contains("escapes"));
        assert!(
            refused(file("a/../../outside"), &ROOMY)
                .1
                .contains("escapes")
        );
        let link = |kind: u8| [tar_entry("link", b"", kind), tar_end()].concat();
        assert_eq!(refused(link(b'2'), &ROOMY).0.as_deref(), Some("rar.link"));
        assert_eq!(refused(link(b'1'), &ROOMY).0.as_deref(), Some("rar.link"));
        let two = [
            tar_entry("a", b"data", b'0'),
            tar_entry("b", b"data", b'0'),
            tar_end(),
        ]
        .concat();
        let limited = |limits: Limits| refused(two.clone(), &limits).0;
        assert_eq!(
            limited(Limits { files: 1, ..ROOMY }).as_deref(),
            Some("rar.tooManyEntries")
        );
        assert_eq!(
            limited(Limits {
                file_bytes: 3,
                ..ROOMY
            })
            .as_deref(),
            Some("rar.entryTooLarge")
        );
        assert_eq!(
            limited(Limits {
                total_bytes: 7,
                ..ROOMY
            })
            .as_deref(),
            Some("rar.tooLarge")
        );
        // The disk's room, which this import shares with what it extracts before (ingest.rs): two files of four
        // bytes have no room in seven, and are written in eight, which the writing gives back.
        assert_eq!(
            limited(Limits {
                room: Some(7),
                ..ROOMY
            })
            .as_deref(),
            Some("rar.noRoom")
        );
        let dir = crate::test_dir::tempdir().unwrap();
        let room = Limits {
            room: Some(8),
            ..ROOMY
        };
        assert!(matches!(
            write_entries(&two[..], dir.path(), &room),
            Ok((_, 8))
        ));
        // The same name twice: the second is not written over the first.
        let twice = [
            tar_entry("a", b"1", b'0'),
            tar_entry("a", b"2", b'0'),
            tar_end(),
        ]
        .concat();
        assert!(written(&twice, crate::test_dir::tempdir().unwrap().path(), &ROOMY).is_err());
        // A stream that is cut short, or whose header does not add up, is the reader's failure.
        let mut damaged = file("a");
        damaged[0] ^= 1;
        assert_eq!(refused(damaged, &ROOMY).1, "stream");
        assert_eq!(refused(file("a")[..BLOCK + 2].to_vec(), &ROOMY).1, "stream");
        assert_eq!(refused(tar_entry("a", b"data", b'0'), &ROOMY).1, "stream");
    }

    /// Runs `check` with the RAR archive on disk and a folder to extract into; None on a system without a reader.
    fn with_rar<T>(archive: &[u8], check: impl FnOnce(&Path, &Path) -> T) -> Option<T> {
        reader()?;
        let (source, dir) = (
            crate::test_dir::tempdir().unwrap(),
            crate::test_dir::tempdir().unwrap(),
        );
        let path = source.path().join("study.rar");
        std::fs::write(&path, archive).unwrap();
        Some(check(&path, dir.path()))
    }

    #[test]
    fn the_systems_reader_hands_over_a_rar_archives_files() {
        let files: [(&str, &[u8]); 3] = [
            ("study/IM1.dcm", &[1u8; 3000]),
            ("study/sub/IM2.dcm", b"two"),
            ("study/çğıöşü.txt", b"three"),
        ];
        let ran = with_rar(&stored_rar(&files), |archive, dir| {
            extract_into(archive, dir, &ROOMY).unwrap();
            let found = files_in(dir);
            for (name, data) in files {
                let target = dir.join(enclosed(name).unwrap());
                assert!(found.contains(&target), "{name}");
                assert_eq!(std::fs::read(target).unwrap(), data);
            }
            assert_eq!(found.len(), files.len());
        });
        if ran.is_none() {
            eprintln!("skipped: this system has no bsdtar");
        }
    }

    #[test]
    fn a_list_of_this_computers_files_named_rar_never_reaches_the_reader() {
        let local = crate::test_dir::tempdir().unwrap();
        let named = local.path().join("local.txt");
        std::fs::write(&named, "not in any archive").unwrap();
        // The reader's own list format: it would fetch the file named and hand it over as the archive's.
        let list = format!(
            "#mtree\n./pulled.txt type=file contents={}\n",
            named.display().to_string().replace('\\', "/")
        );
        let ran = with_rar(list.as_bytes(), |archive, dir| {
            let error = extract_into(archive, dir, &ROOMY).unwrap_err();
            assert_eq!(code(&error), Some("rar.unreadable"));
            assert_eq!(files_in(dir), Vec::<PathBuf>::new());
        });
        if ran.is_none() {
            eprintln!("skipped: this system has no bsdtar");
        }
    }

    #[test]
    fn a_rar_archive_the_reader_cannot_read_or_that_asks_too_much_is_refused_with_its_reason() {
        let refused = |archive: Vec<u8>, limits: Limits| {
            with_rar(&archive, |archive, dir| {
                let error = extract_into(archive, dir, &limits).unwrap_err();
                (code(&error).map(str::to_owned), error.to_string())
            })
        };
        let good = stored_rar(&[("a.dcm", &[1u8; 2000]), ("b.dcm", &[2u8; 2000])]);
        let end = header(5, 0, &[&vint(0)]).len();
        // Cut between its two files, which the reader takes for an archive of one.
        let one = stored_rar(&[("a.dcm", &[1u8; 2000])]);
        let Some(cut) = refused(one[..one.len() - end].to_vec(), ROOMY) else {
            eprintln!("skipped: this system has no bsdtar");
            return;
        };
        assert_eq!(cut.0.as_deref(), Some("rar.damaged"));
        let coded = |archive: Vec<u8>, limits: Limits| refused(archive, limits).unwrap().0;
        assert_eq!(
            coded(good[..good.len() / 2].to_vec(), ROOMY).as_deref(),
            Some("rar.damaged")
        );
        assert_eq!(
            coded(b"not an archive at all".to_vec(), ROOMY).as_deref(),
            Some("rar.unreadable")
        );
        // A stored file with one byte changed: the reader hands it over as it is, and its CRC-32 tells.
        let mut changed = good.clone();
        let last = good.len() - end - 1;
        assert_eq!(changed[last], 2);
        changed[last] = 3;
        assert_eq!(coded(changed, ROOMY).as_deref(), Some("rar.damaged"));
        // Whole headers around a file said to be compressed, whose bytes are nothing of the kind: the reader gives up.
        let packed = [
            SIGNATURE.to_vec(),
            header(1, 0, &[&vint(0)]),
            header(
                2,
                2,
                &[
                    &vint(64),
                    &vint(4),
                    &vint(9000),
                    &vint(0x20),
                    &crc(&[0x5a; 64]),
                    &vint(3 << 7),
                    &vint(0),
                    &vint(1),
                    b"p",
                ],
            ),
            vec![0x5a; 64],
            header(5, 0, &[&vint(0)]),
        ]
        .concat();
        assert_eq!(coded(packed, ROOMY).as_deref(), Some("rar.unreadable"));
        // What a password-protected archive starts with: an encryption header (type 4), then bytes nobody can read.
        let protected = [
            SIGNATURE.to_vec(),
            header(4, 0, &[&vint(0), &vint(0), &[15], &[7u8; 16]]),
            vec![0x5a; 64],
        ]
        .concat();
        assert_eq!(coded(protected, ROOMY).as_deref(), Some("rar.protected"));
        assert_eq!(
            coded(good.clone(), Limits { files: 1, ..ROOMY }).as_deref(),
            Some("rar.tooManyEntries")
        );
        assert_eq!(
            coded(
                good.clone(),
                Limits {
                    total_bytes: 3000,
                    ..ROOMY
                }
            )
            .as_deref(),
            Some("rar.tooLarge")
        );
        let outside = stored_rar(&[("../outside.dcm", b"x")]);
        assert!(refused(outside, ROOMY).unwrap().1.contains("escapes"));
    }
}
