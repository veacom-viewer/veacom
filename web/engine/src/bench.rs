//! The same import and decoding run natively, from disk, to compare with the WebAssembly build.

use crate::session::Session;
use std::time::Instant;
use veacom_core::model::PixelBuffer;

/// A 64-bit FNV-1a hash of decoded pixels with their value type: the same series decoded here and in the browser, or
/// from lossless copies in other transfer syntaxes, must give the same value. Not a cryptographic hash; the
/// measurement page takes SHA-1 of the browser's pixels itself.
fn checksum(pixels: &PixelBuffer) -> String {
    let hash = pixels
        .bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325u64, |hash, &byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        });
    format!("{}:{hash:016x}", pixels.type_name())
}

/// Imports `path`, decodes the middle frame of the first series and that series' volume, and every series' checksum.
/// Returns one JSON line with the cumulative times in milliseconds.
pub fn run(path: &str) -> anyhow::Result<String> {
    let start = Instant::now();
    let since = |t: Instant| (t.duration_since(start).as_secs_f64() * 1000.).round();
    let mut session = Session::default();
    let result = session.import(&[path.to_owned()])?;
    let listed = Instant::now();
    let first = &result.series[0];
    session.frame(&first.id, (first.dimensions[2] - 1) / 2, None)?;
    let frame = Instant::now();
    session.volume(&first.id, None)?;
    let volume = Instant::now();
    let checksums = result
        .series
        .iter()
        .map(|series| Ok(checksum(&*session.volume(&series.id, None)?)))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(serde_json::json!({
        "path": path,
        "series": result.series.len(),
        "images": result.series.iter().map(|series| series.dimensions[2]).sum::<usize>(),
        "first": format!("{}·{}", first.description, first.dimensions[2]),
        "listed": since(listed),
        "frame": since(frame),
        "volume": since(volume),
        "checksums": checksums,
    })
    .to_string())
}
