use crate::vfs::{File, OpenOptions};
use crate::{
    ingest::{MAX_FILES, number, text},
    model::PlannedSeries,
    source_file::SourceFile,
};
use anyhow::{Context, Result, bail, ensure};
use dicom_core::Tag;
use dicom_object::{DefaultDicomObject, InMemDicomObject};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

pub struct MediaRoot {
    path: PathBuf,
    #[cfg(not(target_arch = "wasm32"))]
    directory: File,
}

impl MediaRoot {
    /// In a browser the files are the ones the page handed over (memory_fs): no links, junctions or devices, so a
    /// directory is all a media root has to be.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn open(path: &Path) -> Result<Arc<Self>> {
        ensure!(
            crate::vfs::metadata(path)?.is_dir(),
            "DICOMDIR root is not a directory"
        );
        Ok(Arc::new(Self {
            path: path.to_owned(),
        }))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn open(path: &Path) -> Result<Arc<Self>> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            };
            options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let directory = options.open(path)?;
        ensure!(
            directory.metadata()?.is_dir(),
            "DICOMDIR root is not a directory"
        );
        Ok(Arc::new(Self {
            path: path.to_owned(),
            directory,
        }))
    }

    /// Where the media is.
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

pub struct Reference {
    pub root: Arc<MediaRoot>,
    pub class: String,
    pub instance: String,
}

impl Reference {
    pub fn agrees_with(&self, other: &Self) -> bool {
        self.class == other.class
            && self.instance == other.instance
            && self.root.path == other.root.path
    }
}

pub fn references(index: &Path, root: &Path) -> Result<BTreeMap<PathBuf, Reference>> {
    let root = MediaRoot::open(root)?;
    let index = root
        .path
        .join(index.file_name().context("Missing DICOMDIR name")?);
    let file = open_referenced(&root, &index)?;
    Ok(read_index(&root, &index, file)?.1)
}

/// A series that a DICOMDIR's records describe: what they say of it, and the places of its files under the media
/// root, in the order the records link them.
pub(crate) struct ListedSeries {
    pub info: PlannedSeries,
    pub files: Vec<PathBuf>,
}

/// What a DICOMDIR lists: every file it references, as `references` gives them, and the series its records describe
/// when the records link into one tree (None when they do not; see `series_tree`).
pub(crate) struct Listing {
    pub files: BTreeMap<PathBuf, Reference>,
    pub series: Option<Vec<ListedSeries>>,
}

/// What the index open as `file` lists, as places under `root`. `index` is the path `file` was opened at: the index
/// on the media, or a copy of it. `bytes` are the index's own bytes, which say where its records start.
pub(crate) fn listing_in(
    root: &Arc<MediaRoot>,
    index: &Path,
    file: File,
    bytes: &[u8],
) -> Result<Listing> {
    let (obj, files) = read_index(root, index, file)?;
    let series = record_offsets(bytes)
        .ok()
        .and_then(|offsets| series_tree(&obj, &offsets, root));
    Ok(Listing { files, series })
}

/// The index open as `file`, read through the checks every DICOM file has, and the files it lists as their places
/// under `root`.
fn read_index(
    root: &Arc<MediaRoot>,
    index: &Path,
    file: File,
) -> Result<(DefaultDicomObject, BTreeMap<PathBuf, Reference>)> {
    let (_, _, header) = SourceFile::dicom_handle(index, file)?;
    let obj = dicom_object::OpenFileOptions::new().from_reader(header)?;
    ensure!(
        obj.meta().media_storage_sop_class_uid()
            == dicom_dictionary_std::uids::MEDIA_STORAGE_DIRECTORY_STORAGE,
        "The selected DICOMDIR is not a DICOM media directory."
    );
    let records = obj
        .element(Tag(0x0004, 0x1220))?
        .value()
        .items()
        .context("Invalid DICOMDIR record sequence")?;
    let mut files = BTreeMap::new();
    for record in records.iter().filter(|record| active(record)) {
        let Some(id) = record.get(Tag(0x0004, 0x1500)) else {
            continue;
        };
        let path = referenced_path(&root.path, &id.to_str()?)?;
        let class = record.element(Tag(0x0004, 0x1510))?.to_str()?;
        let instance = record.element(Tag(0x0004, 0x1511))?.to_str()?;
        let reference = Reference {
            root: root.clone(),
            class: class.trim_end_matches([' ', '\0']).to_owned(),
            instance: instance.trim_end_matches([' ', '\0']).to_owned(),
        };
        ensure!(
            !reference.class.is_empty() && !reference.instance.is_empty(),
            "Missing referenced SOP identity in DICOMDIR"
        );
        if let Some(previous) = files.get(&path) {
            ensure!(
                reference.agrees_with(previous),
                "Conflicting DICOMDIR references to the same file"
            );
        }
        files.insert(path, reference);
        ensure!(files.len() <= MAX_FILES, "Too many referenced DICOM files");
    }
    Ok((obj, files))
}

/// The place under `root` of the file that a Referenced File ID names.
fn referenced_path(root: &Path, id: &str) -> Result<PathBuf> {
    let mut path = root.to_owned();
    for (i, part) in id.trim_end_matches(' ').split('\\').enumerate() {
        // Accept ordinary filename extensions on nonstandard media, but no absolute,
        // parent, stream, device or alternate path syntax on either platform.
        ensure!(
            i < 8
                && !part.is_empty()
                && !part.ends_with('.')
                && part.len() <= 255
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)),
            "Invalid referenced file ID in DICOMDIR"
        );
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        ensure!(
            !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                && !(stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.as_bytes()[3].is_ascii_digit()),
            "Invalid device name in DICOMDIR"
        );
        path.push(part);
    }
    Ok(path)
}

/// Whether a record is in use. One marked inactive (Record In-use Flag 0, retired) is left as if it were not there.
fn active(record: &InMemDicomObject) -> bool {
    record
        .get(Tag(0x0004, 0x1410))
        .and_then(|e| e.to_int::<u16>().ok())
        != Some(0)
}

/// The offset a record's link holds: Offset of the Next Directory Record (0004,1400), Offset of Referenced
/// Lower-Level Directory Entity (0004,1420), or the root's first record (0004,1200). 0 links to nothing.
fn link(record: &InMemDicomObject, tag: Tag) -> Option<u32> {
    record.get(tag)?.to_int::<u32>().ok()
}
const NEXT: Tag = Tag(0x0004, 0x1400);
const LOWER: Tag = Tag(0x0004, 0x1420);

/// The series a DICOMDIR's records describe, from each patient down. The records are followed along their links,
/// which are the offsets they start at (PS3.3 F.3), and not in the order they are written in, which the standard
/// leaves free. None when the links do not make one tree: a link that leads to no record or to a record reached
/// before, or a record without its links. Records marked inactive are left out with what lies under them, and so are
/// series without a Series Instance UID or without files.
fn series_tree(
    obj: &DefaultDicomObject,
    offsets: &[u64],
    root: &MediaRoot,
) -> Option<Vec<ListedSeries>> {
    let records = obj.element(Tag(0x0004, 0x1220)).ok()?.value().items()?;
    if records.len() != offsets.len() {
        return None;
    }
    let mut tree = Tree {
        records,
        at: offsets
            .iter()
            .enumerate()
            .map(|(index, offset)| (*offset, index))
            .collect(),
        seen: HashSet::new(),
    };
    let entity = |record: &InMemDicomObject, kind: &str| {
        active(record) && text(record, Tag(0x0004, 0x1430)) == kind
    };
    let mut series = Vec::new();
    for patient in tree.chain(link(obj, Tag(0x0004, 0x1200))?)? {
        if !entity(patient, "PATIENT") {
            continue;
        }
        for study in tree.chain(link(patient, LOWER)?)? {
            if !entity(study, "STUDY") {
                continue;
            }
            for record in tree.chain(link(study, LOWER)?)? {
                if !entity(record, "SERIES") {
                    continue;
                }
                let mut files = Vec::new();
                for leaf in tree.chain(link(record, LOWER)?)? {
                    if let (true, Some(id)) = (active(leaf), leaf.get(Tag(0x0004, 0x1500))) {
                        files.push(referenced_path(&root.path, &id.to_str().ok()?).ok()?);
                    }
                }
                let uid = text(record, Tag(0x0020, 0x000e));
                if files.is_empty() || uid.is_empty() {
                    continue;
                }
                let info = PlannedSeries {
                    uid,
                    study_uid: text(study, Tag(0x0020, 0x000d)),
                    patient_id: text(patient, Tag(0x0010, 0x0020)),
                    patient_name: text(patient, Tag(0x0010, 0x0010)),
                    study_date: text(study, Tag(0x0008, 0x0020)),
                    description: text(record, Tag(0x0008, 0x103e)),
                    modality: text(record, Tag(0x0008, 0x0060)),
                    series_number: number(record, Tag(0x0020, 0x0011)).map(|n| n as i32),
                    files: files.len(),
                    finished: 0,
                };
                series.push(ListedSeries { info, files });
            }
        }
    }
    Some(series)
}

/// A DICOMDIR's records, followed along their links (see `series_tree`).
struct Tree<'a> {
    records: &'a [InMemDicomObject],
    /// Each record's place among `records`, by the offset it starts at.
    at: HashMap<u64, usize>,
    /// The records reached so far.
    seen: HashSet<usize>,
}

impl<'a> Tree<'a> {
    /// The records of one directory entity: the one at `first`, and those its links to the next lead to. None when a
    /// link leads to no record, or to one reached before.
    fn chain(&mut self, first: u32) -> Option<Vec<&'a InMemDicomObject>> {
        let records = self.records;
        let mut found = Vec::new();
        let mut offset = first;
        while offset != 0 {
            let index = *self.at.get(&u64::from(offset))?;
            if !self.seen.insert(index) {
                return None;
            }
            found.push(&records[index]);
            offset = link(&records[index], NEXT)?;
        }
        Some(found)
    }
}

const ITEM: Tag = Tag(0xfffe, 0xe000);
const ITEM_END: Tag = Tag(0xfffe, 0xe00d);
const SEQUENCE_END: Tag = Tag(0xfffe, 0xe0dd);
const UNDEFINED: u32 = u32::MAX;
/// How deep sequences may nest in a record, as in any file (input_guard).
const MAX_DEPTH: usize = 32;

/// Where each record of a DICOMDIR's Directory Record Sequence (0004,1220) starts, in bytes from the start of the file
/// (PS3.3 F.3), in the order the records are written. A DICOMDIR is written in Explicit VR Little Endian (PS3.10).
fn record_offsets(bytes: &[u8]) -> Result<Vec<u64>> {
    ensure!(
        bytes.get(128..132) == Some(b"DICM".as_slice()),
        "Missing DICOM file meta marker"
    );
    let mut walk = Walk { bytes, at: 132 };
    while walk.at < bytes.len() {
        let (tag, vr, length) = walk.header(true)?;
        if tag != Tag(0x0004, 0x1220) {
            walk.skip_value(vr, length, true, 0)?;
            continue;
        }
        let end = if length == UNDEFINED {
            None
        } else {
            let end = walk.at.checked_add(length as usize);
            Some(
                end.filter(|end| *end <= bytes.len())
                    .context("DICOMDIR ends inside an element")?,
            )
        };
        let mut offsets = Vec::new();
        while end.is_none_or(|end| walk.at < end) {
            let at = walk.at as u64;
            match walk.header(true)? {
                (ITEM, _, length) => {
                    offsets.push(at);
                    walk.skip_item(length, true, 1)?;
                }
                (SEQUENCE_END, _, _) if end.is_none() => break,
                _ => bail!("Invalid DICOMDIR record sequence"),
            }
        }
        ensure!(
            end.is_none_or(|end| walk.at == end),
            "Invalid DICOMDIR record sequence"
        );
        return Ok(offsets);
    }
    bail!("The DICOMDIR has no directory records")
}

/// A reading place in a file's bytes, for `record_offsets`.
struct Walk<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Walk<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .context("DICOMDIR ends inside an element")?;
        let taken = &self.bytes[self.at..end];
        self.at = end;
        Ok(taken)
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }
    /// An element's tag, its VR where the encoding states one, and the length of its value (PS3.5 7.1). Items and
    /// delimiters state none.
    fn header(&mut self, explicit: bool) -> Result<(Tag, Option<[u8; 2]>, u32)> {
        let tag = Tag(self.u16()?, self.u16()?);
        if tag.0 == 0xfffe || !explicit {
            return Ok((tag, None, self.u32()?));
        }
        let vr: [u8; 2] = self.take(2)?.try_into()?;
        let length = match &vr {
            b"OB" | b"OD" | b"OF" | b"OL" | b"OV" | b"OW" | b"SQ" | b"SV" | b"UC" | b"UN"
            | b"UR" | b"UT" | b"UV" => {
                self.take(2)?;
                self.u32()?
            }
            _ => u32::from(self.u16()?),
        };
        Ok((tag, Some(vr), length))
    }
    /// Past an element's value. One of undefined length is a sequence or encapsulated pixel data: items, to the end
    /// of the sequence (PS3.5 7.5). Under UN, such a sequence is in Implicit VR Little Endian (PS3.5 6.2.2).
    fn skip_value(
        &mut self,
        vr: Option<[u8; 2]>,
        length: u32,
        explicit: bool,
        depth: usize,
    ) -> Result<()> {
        if length != UNDEFINED {
            self.take(length as usize)?;
            return Ok(());
        }
        ensure!(depth < MAX_DEPTH, "DICOMDIR sequences nest too deeply");
        let explicit = explicit && vr != Some(*b"UN");
        loop {
            match self.header(explicit)? {
                (ITEM, _, length) => self.skip_item(length, explicit, depth + 1)?,
                (SEQUENCE_END, _, _) => return Ok(()),
                _ => bail!("Invalid DICOMDIR sequence"),
            }
        }
    }
    /// Past an item's contents: `length` bytes, or the elements up to its end.
    fn skip_item(&mut self, length: u32, explicit: bool, depth: usize) -> Result<()> {
        if length != UNDEFINED {
            self.take(length as usize)?;
            return Ok(());
        }
        loop {
            let (tag, vr, length) = self.header(explicit)?;
            if tag == ITEM_END {
                return Ok(());
            }
            ensure!(tag.0 != 0xfffe, "Invalid DICOMDIR item");
            self.skip_value(vr, length, explicit, depth)?;
        }
    }
}

/// In a browser: memory_fs paths are normal (no `..`) and hold no links, so a reference stays in its media root by its
/// path alone.
#[cfg(target_arch = "wasm32")]
pub fn open_referenced(root: &MediaRoot, path: &Path) -> Result<File> {
    ensure!(
        path.starts_with(&root.path)
            && path.components().all(|part| !matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )),
        "DICOMDIR reference escaped the media root"
    );
    let file = OpenOptions::new().read(true).open(path)?;
    ensure!(
        file.metadata()?.is_file(),
        "DICOMDIR reference is not a regular file"
    );
    Ok(file)
}

#[cfg(unix)]
pub fn open_referenced(root: &MediaRoot, path: &Path) -> Result<File> {
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
        os::unix::ffi::OsStrExt,
    };
    let mut dir = root.directory.try_clone()?;
    let mut parts = path.strip_prefix(&root.path)?.iter().peekable();
    while let Some(part) = parts.next() {
        let name = CString::new(part.as_bytes())?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if parts.peek().is_some() {
                libc::O_DIRECTORY
            } else {
                0
            };
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // A successful openat returns an owned descriptor.
        dir = unsafe { File::from_raw_fd(fd) };
    }
    ensure!(
        dir.metadata()?.is_file(),
        "DICOMDIR reference is not a regular file"
    );
    Ok(dir)
}

#[cfg(windows)]
fn final_path(file: &File) -> Result<PathBuf> {
    use std::{
        ffi::OsString,
        os::windows::{ffi::OsStringExt, io::AsRawHandle},
    };
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut name = vec![0u16; 32768];
    let n = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            name.as_mut_ptr(),
            name.len() as u32,
            0,
        )
    } as usize;
    ensure!(
        n > 0 && n < name.len(),
        "Cannot resolve the opened DICOMDIR path"
    );
    Ok(PathBuf::from(OsString::from_wide(&name[..n])))
}

#[cfg(windows)]
pub fn open_referenced(root: &MediaRoot, path: &Path) -> Result<File> {
    use std::{
        fs,
        os::windows::fs::{MetadataExt, OpenOptionsExt},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    let mut current = root.path.clone();
    for component in path.strip_prefix(&root.path)?.iter() {
        current.push(component);
        ensure!(
            fs::symlink_metadata(&current)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "DICOMDIR references cannot follow links or junctions"
        );
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file()
            && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0
            && final_path(&file)?.starts_with(final_path(&root.directory)?),
        "DICOMDIR reference escaped the media root"
    );
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An element in Explicit VR Little Endian.
    fn element(bytes: &mut Vec<u8>, tag: Tag, vr: &[u8; 2], value: &[u8]) {
        bytes.extend(tag.0.to_le_bytes());
        bytes.extend(tag.1.to_le_bytes());
        bytes.extend(vr);
        if matches!(vr, b"OB" | b"SQ") {
            bytes.extend([0, 0]);
            bytes.extend(u32::try_from(value.len()).unwrap().to_le_bytes());
        } else {
            bytes.extend(u16::try_from(value.len()).unwrap().to_le_bytes());
        }
        bytes.extend(value);
    }
    /// A text value, padded to an even length.
    fn padded(text: &str, pad: u8) -> Vec<u8> {
        let mut value = text.as_bytes().to_vec();
        if value.len() % 2 == 1 {
            value.push(pad);
        }
        value
    }

    /// A directory record as these tests write it: its type, its other elements in tag order, and the records it
    /// links to by their places in the list of records.
    struct Record {
        kind: &'static str,
        fields: Vec<(Tag, &'static [u8; 2], &'static str)>,
        next: Option<usize>,
        lower: Option<usize>,
        inactive: bool,
        /// Written with an undefined length, and holding a sequence of undefined length.
        open: bool,
    }
    /// A link to a place where no record starts.
    const NOWHERE: usize = usize::MAX;

    fn record(kind: &'static str, fields: Vec<(Tag, &'static [u8; 2], &'static str)>) -> Record {
        Record {
            kind,
            fields,
            next: None,
            lower: None,
            inactive: false,
            open: false,
        }
    }

    fn encode(record: &Record, next: u32, lower: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        let in_use: u16 = if record.inactive { 0 } else { 0xffff };
        element(&mut bytes, NEXT, b"UL", &next.to_le_bytes());
        element(
            &mut bytes,
            Tag(0x0004, 0x1410),
            b"US",
            &in_use.to_le_bytes(),
        );
        element(&mut bytes, LOWER, b"UL", &lower.to_le_bytes());
        element(
            &mut bytes,
            Tag(0x0004, 0x1430),
            b"CS",
            &padded(record.kind, b' '),
        );
        for (tag, vr, text) in &record.fields {
            let pad = if **vr == *b"UI" { 0 } else { b' ' };
            element(&mut bytes, *tag, vr, &padded(text, pad));
        }
        if record.open {
            // Request Attributes Sequence (0040,0275): an item of undefined length in a sequence of undefined length.
            bytes.extend([0x40, 0x00, 0x75, 0x02]);
            bytes.extend(b"SQ\0\0");
            bytes.extend(UNDEFINED.to_le_bytes());
            bytes.extend([0xfe, 0xff, 0x00, 0xe0]);
            bytes.extend(UNDEFINED.to_le_bytes());
            element(&mut bytes, Tag(0x0040, 0x1001), b"SH", &padded("R1", b' '));
            bytes.extend([0xfe, 0xff, 0x0d, 0xe0, 0, 0, 0, 0]);
            bytes.extend([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
        }
        bytes
    }

    fn item(content: Vec<u8>, open: bool) -> Vec<u8> {
        let mut bytes = vec![0xfe, 0xff, 0x00, 0xe0];
        if open {
            bytes.extend(UNDEFINED.to_le_bytes());
            bytes.extend(content);
            bytes.extend([0xfe, 0xff, 0x0d, 0xe0, 0, 0, 0, 0]);
        } else {
            bytes.extend(u32::try_from(content.len()).unwrap().to_le_bytes());
            bytes.extend(content);
        }
        bytes
    }

    /// A DICOMDIR of `records`, written in the order given; the first is the root's first record. Its record sequence
    /// has an undefined length.
    fn dicomdir(records: &[Record]) -> Vec<u8> {
        let mut meta = Vec::new();
        element(&mut meta, Tag(0x0002, 0x0001), b"OB", &[0, 1]);
        element(
            &mut meta,
            Tag(0x0002, 0x0002),
            b"UI",
            &padded("1.2.840.10008.1.3.10", 0),
        );
        element(&mut meta, Tag(0x0002, 0x0003), b"UI", &padded("1.2.3.4", 0));
        element(
            &mut meta,
            Tag(0x0002, 0x0010),
            b"UI",
            &padded("1.2.840.10008.1.2.1", 0),
        );
        element(&mut meta, Tag(0x0002, 0x0012), b"UI", &padded("1.2.3.5", 0));
        let mut bytes = vec![0; 128];
        bytes.extend(b"DICM");
        let length = u32::try_from(meta.len()).unwrap();
        element(
            &mut bytes,
            Tag(0x0002, 0x0000),
            b"UL",
            &length.to_le_bytes(),
        );
        bytes.extend(meta);
        element(
            &mut bytes,
            Tag(0x0004, 0x1130),
            b"CS",
            &padded("TEST", b' '),
        );
        let root_at = bytes.len() + 8;
        element(&mut bytes, Tag(0x0004, 0x1200), b"UL", &[0; 4]);
        element(&mut bytes, Tag(0x0004, 0x1202), b"UL", &[0; 4]);
        element(&mut bytes, Tag(0x0004, 0x1212), b"US", &[0, 0]);
        bytes.extend([0x04, 0x00, 0x20, 0x12]);
        bytes.extend(b"SQ\0\0");
        bytes.extend(UNDEFINED.to_le_bytes());
        let mut offsets = Vec::new();
        let mut at = bytes.len();
        for record in records {
            offsets.push(u32::try_from(at).unwrap());
            at += item(encode(record, 0, 0), record.open).len();
        }
        let place = |link: Option<usize>| match link {
            None => 0,
            Some(NOWHERE) => offsets[0] + 1,
            Some(index) => offsets[index],
        };
        for record in records {
            let content = encode(record, place(record.next), place(record.lower));
            bytes.extend(item(content, record.open));
        }
        bytes.extend([0xfe, 0xff, 0xdd, 0xe0, 0, 0, 0, 0]);
        bytes[root_at..root_at + 4].copy_from_slice(&offsets[0].to_le_bytes());
        bytes
    }

    /// A patient, a study and two series, written out of order: the second image of the first series comes last,
    /// after the second series. The study and that image are written with undefined lengths.
    fn study() -> Vec<Record> {
        let image = |file: &'static str, instance: &'static str| {
            record(
                "IMAGE",
                vec![
                    (Tag(0x0004, 0x1500), b"CS", file),
                    (Tag(0x0004, 0x1510), b"UI", "1.2.840.10008.5.1.4.1.1.2"),
                    (Tag(0x0004, 0x1511), b"UI", instance),
                ],
            )
        };
        let series = |uid: &'static str, number: &'static str, description: &'static str| {
            record(
                "SERIES",
                vec![
                    (Tag(0x0008, 0x0060), b"CS", "CT"),
                    (Tag(0x0008, 0x103e), b"LO", description),
                    (Tag(0x0020, 0x000e), b"UI", uid),
                    (Tag(0x0020, 0x0011), b"IS", number),
                ],
            )
        };
        let patient = vec![
            (Tag(0x0010, 0x0010), b"PN", "TEST^PATIENT"),
            (Tag(0x0010, 0x0020), b"LO", "ID1"),
        ];
        let study = vec![
            (Tag(0x0008, 0x0020), b"DA", "20260101"),
            (Tag(0x0020, 0x000d), b"UI", "1.2.3.1"),
        ];
        let mut records = vec![
            record("PATIENT", patient),
            record("STUDY", study),
            series("1.2.3.1.1", "3", "Chest"),
            image("DICOM\\IM1A", "1.2.3.1.1.1"),
            series("1.2.3.1.2", "4", "Abdomen"),
            image("DICOM\\IM2A", "1.2.3.1.2.1"),
            image("DICOM\\IM1B", "1.2.3.1.1.2"),
        ];
        records[0].lower = Some(1);
        records[1].lower = Some(2);
        records[1].open = true;
        records[2].next = Some(4);
        records[2].lower = Some(3);
        records[3].next = Some(6);
        records[4].lower = Some(5);
        records[6].open = true;
        records
    }

    /// What `listing_in` makes of a DICOMDIR of `records` written at the top of `media`.
    fn listing(media: &Path, records: &[Record]) -> Listing {
        let path = media.join("DICOMDIR");
        let bytes = dicomdir(records);
        std::fs::write(&path, &bytes).unwrap();
        let root = MediaRoot::open(media).unwrap();
        listing_in(&root, &path, File::open(&path).unwrap(), &bytes).unwrap()
    }

    fn places(series: &ListedSeries, media: &Path) -> Vec<String> {
        let place = |file: &PathBuf| {
            file.strip_prefix(media)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        };
        series.files.iter().map(place).collect()
    }

    #[test]
    fn a_dicomdirs_series_are_found_along_its_links_in_whatever_order_its_records_are_written() {
        let media = crate::test_dir::tempdir().unwrap();
        let listing = listing(media.path(), &study());
        assert_eq!(listing.files.len(), 3);
        let series = listing.series.unwrap();
        assert_eq!(series.len(), 2);
        assert_eq!(
            places(&series[0], media.path()),
            ["DICOM/IM1A", "DICOM/IM1B"]
        );
        assert_eq!(places(&series[1], media.path()), ["DICOM/IM2A"]);
        let first = &series[0].info;
        assert_eq!(
            (
                first.uid.as_str(),
                first.study_uid.as_str(),
                first.patient_name.as_str(),
                first.patient_id.as_str(),
                first.study_date.as_str(),
                first.modality.as_str(),
                first.series_number,
                first.description.as_str(),
                first.files,
            ),
            (
                "1.2.3.1.1",
                "1.2.3.1",
                "TEST^PATIENT",
                "ID1",
                "20260101",
                "CT",
                Some(3),
                "Chest",
                2
            )
        );
        assert_eq!(series[1].info.description, "Abdomen");
    }

    #[test]
    fn a_dicomdir_whose_links_make_no_tree_lists_its_files_and_no_series() {
        let mut looped = study();
        looped[6].next = Some(3);
        let mut nowhere = study();
        nowhere[4].lower = Some(NOWHERE);
        for records in [looped, nowhere] {
            let media = crate::test_dir::tempdir().unwrap();
            let listing = listing(media.path(), &records);
            assert_eq!(listing.files.len(), 3);
            assert!(listing.series.is_none());
        }
    }

    #[test]
    fn an_inactive_record_is_left_out_of_the_series_with_what_lies_under_it() {
        let mut records = study();
        records[4].inactive = true;
        records[6].inactive = true;
        let media = crate::test_dir::tempdir().unwrap();
        let listing = listing(media.path(), &records);
        let series = listing.series.unwrap();
        assert_eq!(series.len(), 1);
        assert_eq!(places(&series[0], media.path()), ["DICOM/IM1A"]);
        assert_eq!(series[0].info.files, 1);
    }

    #[test]
    fn a_damaged_dicomdir_gives_no_record_places() {
        let bytes = dicomdir(&study());
        let first = record_offsets(&bytes).unwrap()[0] as usize;
        assert_eq!(&bytes[first..first + 4], &[0xfe, 0xff, 0x00, 0xe0]);
        for cut in [0, 131, first + 3, bytes.len() - 9] {
            assert!(record_offsets(&bytes[..cut]).is_err(), "cut at {cut}");
        }
        let mut wrong = bytes.clone();
        wrong[first + 2] = 0x0d;
        assert!(record_offsets(&wrong).is_err());
    }
}
