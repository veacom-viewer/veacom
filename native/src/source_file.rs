use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
};

const BLOCK: usize = 256 * 1024;
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

/// Hash the selected file once. Later readers verify each block before handing its bytes to a
/// parser, decoder or exporter, including when a writer changes the file during a read.
#[derive(Debug)]
pub struct SourceFile {
    pub path: PathBuf,
    pub len: u64,
    hashes: Vec<[u8; 32]>,
}

impl SourceFile {
    #[cfg(test)]
    pub fn index(path: &Path) -> Result<Arc<Self>> {
        Self::index_handle(path, open_file(path)?)
    }

    pub(crate) fn index_handle(path: &Path, mut file: File) -> Result<Arc<Self>> {
        let metadata = file.metadata()?;
        let len = metadata.len();
        ensure!(
            metadata.is_file() && len <= crate::input_guard::MAX_FILE_SIZE,
            "Invalid or excessive source file"
        );
        let mut remaining = len;
        let mut buffer = vec![0; len.min(BLOCK as u64) as usize];
        let mut hashes = Vec::with_capacity(len.div_ceil(BLOCK as u64) as usize);
        while remaining != 0 {
            crate::progress::check()?;
            let n = remaining.min(BLOCK as u64) as usize;
            file.read_exact(&mut buffer[..n])?;
            hashes.push(Sha256::digest(&buffer[..n]).into());
            remaining -= n as u64;
        }
        let after = file.metadata()?;
        ensure!(
            after.len() == len && after.modified().ok() == metadata.modified().ok(),
            changed()
        );
        Ok(Arc::new(Self {
            path: path.to_owned(),
            len,
            hashes,
        }))
    }

    pub fn dicom(path: &Path) -> Result<(Arc<Self>, crate::input_guard::InputInfo)> {
        Self::dicom_handle(path, open_file(path)?)
    }

    pub fn dicom_handle(
        path: &Path,
        file: File,
    ) -> Result<(Arc<Self>, crate::input_guard::InputInfo)> {
        let file = Self::index_handle(path, file)?;
        let info = crate::input_guard::inspect_reader(file.open()?, file.len)?;
        Ok((file, info))
    }

    pub fn same_contents(&self, other: &Self) -> bool {
        self.len == other.len && (std::ptr::eq(self, other) || self.hashes == other.hashes)
    }

    pub fn retained_bytes(&self) -> usize {
        size_of::<Self>() + self.path.as_os_str().as_encoded_bytes().len() + self.hashes.len() * 32
    }

    pub fn open(self: &Arc<Self>) -> Result<SourceReader> {
        let file = open_file(&self.path)?;
        ensure!(file.metadata()?.len() == self.len, changed());
        Ok(SourceReader {
            file,
            source: self.clone(),
            pos: 0,
            loaded: None,
            bytes: Vec::new(),
        })
    }
}

pub struct SourceReader {
    file: File,
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
