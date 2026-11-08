//! The file system the engine reads from: the computer's own on the desktop; in a browser (WebAssembly), the files the
//! page handed over, kept by `memory_fs`. Code that opens, lists or creates files goes through here, never `std::fs`
//! directly, so the same import, decoding and export run in both.

#[cfg(not(target_arch = "wasm32"))]
pub use std::fs::{
    DirEntry, File, OpenOptions, create_dir, create_dir_all, metadata, read_dir, remove_dir_all,
    remove_file,
};
#[cfg(not(target_arch = "wasm32"))]
use std::{
    io,
    path::{Path, PathBuf},
};

#[cfg(not(target_arch = "wasm32"))]
pub fn exists(path: &Path) -> bool {
    path.exists()
}
#[cfg(not(target_arch = "wasm32"))]
pub fn is_file(path: &Path) -> bool {
    path.is_file()
}
#[cfg(not(target_arch = "wasm32"))]
pub fn canonicalize(path: &Path) -> io::Result<PathBuf> {
    path.canonicalize()
}

#[cfg(target_arch = "wasm32")]
pub use crate::memory_fs::{
    DirEntry, File, OpenOptions, canonicalize, create_dir, create_dir_all, exists, is_file,
    metadata, read_dir, remove_dir_all, remove_file,
};
