use anyhow::{Context, Result, ensure};
use dicom_core::Tag;
use dicom_object::DefaultDicomObject;

pub fn check(object: &DefaultDicomObject, frame: Option<u32>) -> Result<()> {
    let number = |tag| -> Result<usize> {
        object
            .get(tag)
            .context("Missing RLE image attribute")?
            .to_int()
            .context("Invalid RLE image attribute")
    };
    let bits = number(Tag(0x0028, 0x0100))?;
    ensure!(
        matches!(bits, 1 | 8 | 16 | 32),
        "Unsupported RLE sample allocation"
    );
    // A 1-bit pixel code is padded to one byte (PS3.5 G.2), as binary segmentations use it (CP-2301).
    let segments = number(Tag(0x0028, 0x0002))?
        .checked_mul(bits.div_ceil(8))
        .context("RLE segment count overflow")?;
    ensure!((1..=15).contains(&segments), "Invalid RLE segment count");
    let pixels = number(Tag(0x0028, 0x0010))?
        .checked_mul(number(Tag(0x0028, 0x0011))?)
        .context("RLE dimensions overflow")?;
    ensure!(pixels > 0, "Invalid RLE image dimensions");
    let fragments = object
        .get(Tag(0x7fe0, 0x0010))
        .context("Missing RLE PixelData")?
        .value()
        .fragments()
        .context("RLE requires encapsulated PixelData")?;
    if let Some(index) = frame {
        check_frame(
            fragments.get(index as usize).context("Missing RLE frame")?,
            segments,
            pixels,
        )?;
    } else {
        for fragment in fragments {
            check_frame(fragment, segments, pixels)?;
        }
    }
    Ok(())
}

fn check_frame(fragment: &[u8], segments: usize, pixels: usize) -> Result<()> {
    ensure!(
        fragment.len() >= 64 && fragment.len() % 2 == 0,
        "Invalid RLE header length"
    );
    let word =
        |i: usize| u32::from_le_bytes(fragment[i * 4..i * 4 + 4].try_into().unwrap()) as usize;
    ensure!(
        word(0) == segments && (1..=15).contains(&segments),
        "RLE segment count differs from image components"
    );
    ensure!(
        word(1) == 64 && (segments + 1..16).all(|i| word(i) == 0),
        "Invalid RLE header offsets"
    );
    for index in 0..segments {
        let start = word(index + 1);
        let end = if index + 1 == segments {
            fragment.len()
        } else {
            word(index + 2)
        };
        // Bounds and order only: PS3.5 G.5 asks for even segment lengths, but encoders
        // that leave them odd are common and pydicom, GDCM and the original app read them.
        ensure!(
            start >= 64 && start < end && end <= fragment.len(),
            "Invalid RLE segment range"
        );
        let bytes = &fragment[start..end];
        let mut cursor = 0usize;
        let mut decoded = 0usize;
        while cursor < bytes.len() && decoded < pixels {
            let code = bytes[cursor] as i8;
            cursor += 1;
            let count = match code {
                0..=127 => {
                    let count = code as usize + 1;
                    ensure!(
                        cursor + count <= bytes.len(),
                        "Truncated RLE literal packet"
                    );
                    cursor += count;
                    count
                }
                -127..=-1 => {
                    ensure!(cursor < bytes.len(), "Truncated RLE repeat packet");
                    cursor += 1;
                    (1i16 - i16::from(code)) as usize
                }
                -128 => 0,
            };
            decoded = decoded
                .checked_add(count)
                .context("RLE expansion overflow")?;
            ensure!(
                decoded <= pixels,
                "RLE packet expands beyond image dimensions"
            );
        }
        ensure!(
            decoded == pixels,
            "RLE segment does not contain a complete image plane"
        );
        let remainder = &bytes[cursor..];
        let remainder = remainder.strip_suffix(&[0]).unwrap_or(remainder);
        ensure!(
            remainder.iter().all(|&n| n == 128),
            "RLE segment contains excess pixel packets"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(packets: &[&[u8]]) -> Vec<u8> {
        let mut bytes = vec![0u8; 64];
        bytes[..4].copy_from_slice(&(packets.len() as u32).to_le_bytes());
        for (index, packet) in packets.iter().enumerate() {
            let offset = bytes.len() as u32;
            bytes[index * 4 + 4..index * 4 + 8].copy_from_slice(&offset.to_le_bytes());
            bytes.extend_from_slice(packet);
            if bytes.len() % 2 != 0 {
                bytes.push(0)
            }
        }
        bytes
    }

    #[test]
    fn valid_literal_repeat_and_noop_packets_match_pydicom_encoding() {
        let color = frame(&[
            &[3, 76, 150, 29, 128],
            &[3, 85, 44, 255, 128],
            &[3, 255, 21, 107, 128],
        ]);
        check_frame(&color, 3, 4).unwrap();
        check_frame(&frame(&[&[253, 42]]), 1, 4).unwrap();
        check_frame(&frame(&[&[128, 253, 42, 128]]), 1, 4).unwrap();
    }

    #[test]
    fn odd_length_segments_are_accepted() {
        // Two 5-byte segments (a literal run of 4): the second starts at the odd offset 69.
        let mut fragment = vec![0u8; 64];
        fragment[..4].copy_from_slice(&2u32.to_le_bytes());
        fragment[4..8].copy_from_slice(&64u32.to_le_bytes());
        fragment[8..12].copy_from_slice(&69u32.to_le_bytes());
        fragment.extend_from_slice(&[3, 1, 2, 3, 4, 3, 5, 6, 7, 8]);
        check_frame(&fragment, 2, 4).unwrap();
    }

    #[test]
    fn corrupt_headers_and_packets_fail_without_output_allocation() {
        let valid = frame(&[&[3, 1, 2, 3, 4]]);
        let mut huge = valid.clone();
        huge[..4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(check_frame(&huge, 1, 4).is_err());
        for length in [0, 3, 63] {
            assert!(check_frame(&valid[..length], 1, 4).is_err())
        }
        let mut offset = valid.clone();
        offset[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(check_frame(&offset, 1, 4).is_err());
        assert!(check_frame(&frame(&[&[127, 0]]), 1, 4).is_err());
        assert!(check_frame(&frame(&[&[252, 0]]), 1, 4).is_err());
        assert!(check_frame(&frame(&[&[254, 0]]), 1, 4).is_err());
        assert!(check_frame(&frame(&[&[253, 0, 0, 1]]), 1, 4).is_err());
    }
}
