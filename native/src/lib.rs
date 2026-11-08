//! VEAcom's engine: reads DICOM folders, discs and archives into series, decodes their pixels, reads tags, measures
//! and exports. It has no transport of its own: the desktop app reaches it over pipes (`main.rs`), the browser calls it
//! from a Web Worker (`web/engine`).
//!
//! Files are read through `vfs`: the computer's own file system on the desktop, the files a page was given in a
//! browser.

// First, so `note!` and `coded!` are available to every module below.
#[macro_use]
pub mod message;
#[cfg(test)]
mod codec_tests;
#[cfg(not(target_arch = "wasm32"))]
pub mod archive_temp;
// In a browser an extracted archive lives in memory, with the rest of its files.
#[cfg(target_arch = "wasm32")]
#[path = "archive_temp_memory.rs"]
pub mod archive_temp;
#[cfg(windows)]
mod archive_owner_windows;
pub mod codec_guard;
pub mod color;
pub mod confidentiality;
pub mod decode;
pub mod export;
pub mod gamma_camera;
pub mod geometry;
pub mod import_budget;
pub mod ingest;
pub mod input_guard;
pub mod media_directory;
pub mod measure;
pub mod memory_fs;
pub mod modality_lut;
pub mod model;
pub mod palette;
pub mod parallel;
pub mod patient;
pub mod pictures;
pub mod progress;
pub mod random;
pub mod rle_guard;
pub mod sampling;
pub mod source_file;
pub mod tags;
/// Private temporary folders, for the engine's tests and the desktop transport's.
#[doc(hidden)]
pub mod test_dir;
pub mod vfs;
pub mod window;

#[cfg(not(target_endian = "little"))]
compile_error!("VEAcom binary transport currently requires a little-endian target");
