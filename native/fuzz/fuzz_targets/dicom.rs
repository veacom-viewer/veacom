#![no_main]
#![allow(dead_code)]
#[macro_use]
#[path = "../../src/message.rs"]
mod message;
#[path = "../../src/progress.rs"]
mod progress;
#[path = "../../src/rle_guard.rs"]
mod rle_guard;
#[path = "../../src/codec_guard.rs"]
mod codec_guard;
#[path = "../../src/input_guard.rs"]
mod input_guard;

use libfuzzer_sys::fuzz_target;
#[path = "../../src/random.rs"]
mod random;
#[path = "../../src/test_dir.rs"]
mod test_dir;
use std::fs;

fuzz_target!(|bytes: &[u8]| {
    if bytes.len() > 1024 * 1024 { return; }
    let dir = test_dir::tempdir().unwrap();
    let path = dir.path().join("input");
    fs::write(&path, bytes).unwrap();
    if let Ok((_, source)) = input_guard::open_checked(&path)
        && let Ok(object) = dicom_object::OpenFileOptions::new().from_reader(source)
    {
        let _ = codec_guard::check(&object, None);
    }
});
