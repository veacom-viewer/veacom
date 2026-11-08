use anyhow::{Result, ensure};
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod stamp;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
};

const BLOCK: usize = 256 * 1024;
// Two MiB covers an ordinary CT slice. This prefix lives only while a file is being indexed.
const IMPORT_PREFIX: usize = 2 * 1024 * 1024;
pub fn changed() -> crate::message::Coded {
    coded!(
        "file.sourceChanged",
        "Source file changed after import. Reimport the study."
    )
}

pub fn is_changed(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let coded = cause.downcast_ref::<crate::message::Coded>().or_else(|| {
            cause
                .downcast_ref::<io::Error>()?
                .get_ref()?
                .downcast_ref::<crate::message::Coded>()
        });
        coded.is_some_and(|error| error.0.code == "file.sourceChanged")
    })
}

pub(crate) fn open_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY);
    }
    let file = options.open(path)?;
    ensure!(file.metadata()?.is_file(), "Expected a regular source file");
    Ok(file)
}

/// Stable local files are checked on the open descriptor as they are read. Other sources use a digest per block.
#[derive(Debug)]
pub struct SourceFile {
    pub path: PathBuf,
    pub len: u64,
    hashes: Vec<[u8; 32]>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    stamp: Option<stamp::Stamp>,
}

impl SourceFile {
    #[cfg(test)]
    pub fn index(path: &Path) -> Result<Arc<Self>> {
        Self::index_handle(path, open_file(path)?)
    }

    pub(crate) fn index_handle(path: &Path, mut file: File) -> Result<Arc<Self>> {
        Ok(Self::index_prefix(path, &mut file, 0)?.0)
    }

    fn index_prefix(path: &Path, file: &mut File, keep: usize) -> Result<(Arc<Self>, Arc<Vec<u8>>)> {
        let metadata = file.metadata()?;
        let len = metadata.len();
        ensure!(
            metadata.is_file() && len <= crate::input_guard::MAX_FILE_SIZE,
            "Invalid or excessive source file"
        );
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let stamp = stamp::Stamp::capture(file, &metadata);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if stamp.as_ref().is_some_and(stamp::Stamp::settled) {
            return Ok((Arc::new(Self { path: path.to_owned(), len, hashes: Vec::new(), stamp }), Arc::default()));
        }
        let mut remaining = len;
        let mut buffer = Vec::new();
        let mut hashes = Vec::with_capacity(len.div_ceil(BLOCK as u64) as usize);
        let mut prefix = vec![0; (keep / BLOCK * BLOCK).min(len as usize)];
        while remaining != 0 {
            crate::progress::check()?;
            let n = remaining.min(BLOCK as u64) as usize;
            let offset = (len - remaining) as usize;
            let block = if let Some(slice) = prefix.get_mut(offset..offset + n) {
                slice
            } else {
                buffer.resize(n, 0);
                &mut buffer[..]
            };
            file.read_exact(block)?;
            hashes.push(Sha256::digest(block).into());
            remaining -= n as u64;
        }
        let after = file.metadata()?;
        ensure!(
            after.len() == len && after.modified().ok() == metadata.modified().ok(),
            changed()
        );
        Ok((Arc::new(Self {
            path: path.to_owned(),
            len,
            hashes,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            stamp,
        }), Arc::new(prefix)))
    }

    pub fn dicom(path: &Path) -> Result<(Arc<Self>, crate::input_guard::InputInfo, SourceReader)> {
        Self::dicom_handle(path, open_file(path)?)
    }

    pub fn dicom_handle(
        path: &Path,
        mut file: File,
    ) -> Result<(Arc<Self>, crate::input_guard::InputInfo, SourceReader)> {
        let (source, prefix) = Self::index_prefix(path, &mut file, IMPORT_PREFIX)?;
        let guard = source.reader(file.try_clone()?, prefix.clone());
        let info = crate::input_guard::inspect_reader(guard, source.len)?;
        let header = source.reader(file, prefix);
        Ok((source, info, header))
    }

    pub fn same_contents(&self, other: &Self) -> bool {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if self.len != 0 && (self.hashes.is_empty() || other.hashes.is_empty()) {
            return self.stamp.is_some() && self.stamp == other.stamp;
        }
        self.len == other.len && (std::ptr::eq(self, other) || self.hashes == other.hashes)
    }

    pub fn retained_bytes(&self) -> usize {
        size_of::<Self>() + self.path.as_os_str().as_encoded_bytes().len() + self.hashes.len() * 32
    }

    pub fn open(self: &Arc<Self>) -> Result<SourceReader> {
        let file = open_file(&self.path)?;
        ensure!(file.metadata()?.len() == self.len, changed());
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if self.hashes.is_empty() && let Some(stamp) = &self.stamp { stamp.verify(&file)?; }
        Ok(self.reader(file, Arc::default()))
    }

    fn reader(self: &Arc<Self>, file: File, prefix: Arc<Vec<u8>>) -> SourceReader {
        SourceReader {
            file,
            prefix,
            source: self.clone(),
            pos: 0,
            loaded: None,
            bytes: Vec::new(),
        }
    }
}

pub struct SourceReader {
    file: File,
    prefix: Arc<Vec<u8>>,
    source: Arc<SourceFile>,
    pos: u64,
    loaded: Option<usize>,
    bytes: Vec<u8>,
}

impl Read for SourceReader {
    fn read(&mut self, dst: &mut [u8]) -> io::Result<usize> {
        if dst.is_empty() || self.pos >= self.source.len {
            return Ok(0);
        }
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if self.source.hashes.is_empty() && let Some(stamp) = &self.source.stamp {
            let length = dst.len().min((self.source.len - self.pos) as usize);
            let read = stamp.read(&self.file, &mut dst[..length], self.pos)?;
            self.pos += read as u64;
            return Ok(read);
        }
        if self.pos < self.prefix.len() as u64 {
            let bytes = &self.prefix[self.pos as usize..];
            let n = dst.len().min(bytes.len());
            dst[..n].copy_from_slice(&bytes[..n]);
            self.pos += n as u64;
            return Ok(n);
        }
        let index = (self.pos / BLOCK as u64) as usize;
        if self.loaded != Some(index) {
            self.loaded = None;
            let start = index as u64 * BLOCK as u64;
            self.bytes
                .resize((self.source.len - start).min(BLOCK as u64) as usize, 0);
            self.file.seek(SeekFrom::Start(start))?;
            self.file
                .read_exact(&mut self.bytes)
                .map_err(|e| match e.kind() {
                    io::ErrorKind::UnexpectedEof => {
                        io::Error::new(io::ErrorKind::InvalidData, changed())
                    }
                    _ => e,
                })?;
            if Sha256::digest(&self.bytes)[..] != self.source.hashes[index] {
                return Err(io::Error::new(io::ErrorKind::InvalidData, changed()));
            }
            self.loaded = Some(index);
        }
        let offset = (self.pos % BLOCK as u64) as usize;
        let count = dst.len().min(self.bytes.len() - offset);
        dst[..count].copy_from_slice(&self.bytes[offset..offset + count]);
        self.pos += count as u64;
        Ok(count)
    }
}

impl Seek for SourceReader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.pos = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::Current(n) => self.pos.checked_add_signed(n),
            SeekFrom::End(n) => self.source.len.checked_add_signed(n),
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid source offset"))?;
        Ok(self.pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn settled_local_source_checks_identity_and_rejects_changes_during_a_read() {
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("settled.bin");
        std::fs::write(&path, vec![7; BLOCK + 8]).unwrap();
        let fresh = SourceFile::index(&path).unwrap();
        if fresh.stamp.is_none() { return; } // This filesystem uses the hash-based reader.
        assert!(!fresh.hashes.is_empty());
        std::thread::sleep(std::time::Duration::from_millis(3100));
        let settled = SourceFile::index(&path).unwrap();
        assert!(settled.hashes.is_empty());
        assert!(settled.same_contents(&fresh));
        let mut reader = settled.open().unwrap();
        let mut byte = [0];
        reader.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [7]);
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        let mtime = writer.metadata().unwrap().modified().unwrap();
        writer.seek(SeekFrom::Start(BLOCK as u64)).unwrap();
        writer.write_all(&[9]).unwrap();
        writer.set_modified(mtime).unwrap();
        reader.seek(SeekFrom::Start(BLOCK as u64)).unwrap();
        assert_eq!(reader.read_exact(&mut byte).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert_eq!(byte, [7]);
        std::fs::rename(&path, temp.path().join("original")).unwrap();
        std::fs::write(&path, vec![7; BLOCK + 8]).unwrap();
        assert!(settled.open().is_err());
    }

    #[test]
    fn import_uses_the_hashed_prefix_and_checks_bytes_outside_it() {
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("prefix.bin");
        std::fs::write(&path, vec![11; IMPORT_PREFIX + BLOCK]).unwrap();
        let mut file = open_file(&path).unwrap();
        let (source, prefix) = SourceFile::index_prefix(&path, &mut file, IMPORT_PREFIX).unwrap();
        let mut reader = source.reader(file, prefix);
        let mut writer = OpenOptions::new().write(true).open(&path).unwrap();
        writer.write_all(&[99]).unwrap();
        writer.seek(SeekFrom::Start(IMPORT_PREFIX as u64)).unwrap();
        writer.write_all(&[88]).unwrap();
        let mut byte = [0];
        reader.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [11]);
        reader.seek(SeekFrom::Start(IMPORT_PREFIX as u64)).unwrap();
        assert!(reader.read_exact(&mut byte).is_err());
        assert!(source.open().unwrap().read_exact(&mut byte).is_err());
    }

    #[test]
    fn verifies_later_blocks_as_they_are_read_even_if_size_and_mtime_are_restored() {
        let temp = crate::test_dir::tempdir().unwrap();
        let path = temp.path().join("synthetic.bin");
        std::fs::write(&path, vec![11; BLOCK + 8]).unwrap();
        let indexed = SourceFile::index(&path).unwrap();
        let mut reader = indexed.open().unwrap();
        let mut prefix = [0; 4];
        reader.read_exact(&mut prefix).unwrap();
        assert_eq!(prefix, [11; 4]);

        let mut writer = OpenOptions::new().write(true).open(path).unwrap();
        let mtime = writer.metadata().unwrap().modified().unwrap();
        writer.seek(SeekFrom::Start(BLOCK as u64)).unwrap();
        writer.write_all(&[22; 8]).unwrap();
        writer.set_modified(mtime).unwrap();
        reader.seek(SeekFrom::Start(BLOCK as u64)).unwrap();
        let mut output = [0; 8];
        assert_eq!(
            reader.read_exact(&mut output).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(output, [0; 8]);
    }
}
