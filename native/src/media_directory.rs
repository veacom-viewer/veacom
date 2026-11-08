use crate::{ingest::MAX_FILES, source_file::SourceFile};
use anyhow::{Context, Result, ensure};
use dicom_core::Tag;
use crate::vfs::{File, OpenOptions};
use std::{
    collections::BTreeMap,
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
    fn open(path: &Path) -> Result<Arc<Self>> {
        ensure!(crate::vfs::metadata(path)?.is_dir(), "DICOMDIR root is not a directory");
        Ok(Arc::new(Self { path: path.to_owned() }))
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn open(path: &Path) -> Result<Arc<Self>> {
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
    let (_, _, header) = SourceFile::dicom_handle(&index, open_referenced(&root, &index)?)?;
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
    for record in records {
        if record
            .get(Tag(0x0004, 0x1410))
            .and_then(|e| e.to_int::<u16>().ok())
            == Some(0)
        {
            continue;
        }
        let Some(id) = record.get(Tag(0x0004, 0x1500)) else {
            continue;
        };
        let id = id.to_str()?;
        let mut path = root.path.clone();
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
    Ok(files)
}

/// In a browser: memory_fs paths are normal (no `..`) and hold no links, so a reference stays in its media root by its
/// path alone.
#[cfg(target_arch = "wasm32")]
pub fn open_referenced(root: &MediaRoot, path: &Path) -> Result<File> {
    ensure!(
        path.starts_with(&root.path)
            && path
                .components()
                .all(|part| !matches!(part, std::path::Component::ParentDir | std::path::Component::CurDir)),
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
