use anyhow::{Context, Result, bail, ensure};
use dicom_core::Tag;
use dicom_object::DefaultDicomObject;
use std::ops::Range;

const MAX_HEADER_BYTES: usize = 1024 * 1024;
const MAX_TILES: u64 = 65_536;

struct Expected {
    width: u32,
    height: u32,
    components: u16,
    precision: u16,
    allocated: u16,
    signed: bool,
    photometric: String,
}

pub fn check(object: &DefaultDicomObject, frame: Option<u32>) -> Result<()> {
    let syntax = object.meta().transfer_syntax();
    if syntax == "1.2.840.10008.1.2.5" {
        return crate::rle_guard::check(object, frame);
    }
    let jpeg_ls = matches!(syntax, "1.2.840.10008.1.2.4.80" | "1.2.840.10008.1.2.4.81");
    let jpeg2000 = matches!(
        syntax,
        "1.2.840.10008.1.2.4.90"
            | "1.2.840.10008.1.2.4.91"
            | "1.2.840.10008.1.2.4.92"
            | "1.2.840.10008.1.2.4.93"
            | "1.2.840.10008.1.2.4.201"
            | "1.2.840.10008.1.2.4.202"
            | "1.2.840.10008.1.2.4.203"
    );
    let jpeg = syntax
        .strip_prefix("1.2.840.10008.1.2.4.")
        .and_then(|suffix| suffix.parse::<u16>().ok())
        .is_some_and(|value| (50..=70).contains(&value));
    if !(jpeg || jpeg_ls || jpeg2000) {
        return Ok(());
    }
    let number = |tag| -> Result<u32> {
        object
            .get(tag)
            .context("Missing compressed image attribute")?
            .to_int()
            .context("Invalid compressed image attribute")
    };
    let expected = Expected {
        width: number(Tag(0x0028, 0x0011))?,
        height: number(Tag(0x0028, 0x0010))?,
        components: u16::try_from(number(Tag(0x0028, 0x0002))?)?,
        precision: u16::try_from(number(Tag(0x0028, 0x0101))?)?,
        allocated: u16::try_from(number(Tag(0x0028, 0x0100))?)?,
        signed: number(Tag(0x0028, 0x0103))? == 1,
        photometric: object
            .get(Tag(0x0028, 0x0004))
            .context("Missing PhotometricInterpretation")?
            .to_str()?
            .trim_end_matches([' ', '\0'])
            .to_owned(),
    };
    let frames = object
        .get(Tag(0x0028, 0x0008))
        .map(|e| e.to_int::<usize>())
        .transpose()?
        .unwrap_or(1);
    ensure!(
        (1..=50_000).contains(&frames),
        "Invalid compressed frame count"
    );
    let pixels = object
        .get(Tag(0x7fe0, 0x0010))
        .context("Missing encapsulated PixelData")?
        .value();
    let fragments = pixels
        .fragments()
        .context("Compressed PixelData must be encapsulated")?;
    let offsets = pixels
        .offset_table()
        .context("Missing basic offset table")?;
    let ranges = frame_ranges(fragments, offsets, frames)?;
    let selected = if let Some(frame) = frame {
        ensure!(
            (frame as usize) < frames,
            "Compressed frame index is out of range"
        );
        frame as usize..frame as usize + 1
    } else {
        0..frames
    };
    for index in selected {
        let mut reader = Cursor::new(&fragments[ranges[index].clone()])?;
        if jpeg2000 {
            check_jpeg2000(&mut reader, &expected)
        } else {
            check_jpeg(&mut reader, &expected, jpeg_ls)
        }
        .with_context(|| format!("Compressed frame {index} failed header validation"))?;
    }
    Ok(())
}

fn frame_ranges(
    fragments: &[Vec<u8>],
    offsets: &[u32],
    frames: usize,
) -> Result<Vec<Range<usize>>> {
    ensure!(
        fragments.len() >= frames,
        "Missing compressed frame fragments"
    );
    if offsets.is_empty() {
        if frames == 1 {
            return Ok(vec![0..fragments.len()]);
        }
        ensure!(
            fragments.len() == frames,
            "Multi-fragment multiframe images require a basic offset table for this decoder"
        );
        return Ok((0..frames).map(|i| i..i + 1).collect());
    }
    ensure!(
        offsets.len() == frames && offsets[0] == 0,
        "Invalid basic offset table frame count"
    );
    ensure!(
        offsets.windows(2).all(|pair| pair[0] < pair[1]),
        "Basic frame offsets must increase"
    );
    let mut boundaries = Vec::with_capacity(frames + 1);
    let mut offset = 0u64;
    for (index, fragment) in fragments.iter().enumerate() {
        if boundaries.len() < frames && offset == u64::from(offsets[boundaries.len()]) {
            boundaries.push(index);
        }
        offset = offset
            .checked_add(fragment.len() as u64 + 8)
            .context("Compressed offset overflow")?;
    }
    ensure!(
        boundaries.len() == frames,
        "Basic frame offset is not a fragment boundary"
    );
    boundaries.push(fragments.len());
    let ranges: Vec<_> = boundaries.windows(2).map(|pair| pair[0]..pair[1]).collect();
    if fragments.len() == frames {
        ensure!(
            ranges.iter().all(|range| range.len() == 1),
            "Basic offsets disagree with decoder frame boundaries"
        );
    }
    Ok(ranges)
}

// Reads marker headers across fragment boundaries without copying frame payloads.
struct Cursor<'a> {
    pieces: &'a [Vec<u8>],
    piece: usize,
    offset: usize,
    position: usize,
    total: usize,
    header_bytes: usize,
}
impl<'a> Cursor<'a> {
    fn new(pieces: &'a [Vec<u8>]) -> Result<Self> {
        let total = pieces
            .iter()
            .try_fold(0usize, |n, p| n.checked_add(p.len()))
            .context("Compressed length overflow")?;
        Ok(Self {
            pieces,
            piece: 0,
            offset: 0,
            position: 0,
            total,
            header_bytes: 0,
        })
    }
    fn take(&mut self, length: usize) -> Result<Vec<u8>> {
        self.header_bytes = self
            .header_bytes
            .checked_add(length)
            .context("Codec header length overflow")?;
        ensure!(
            self.header_bytes <= MAX_HEADER_BYTES,
            "Compressed frame headers exceed 1 MiB"
        );
        ensure!(
            length <= self.total.saturating_sub(self.position),
            "Truncated compressed header"
        );
        let mut output = Vec::with_capacity(length);
        self.advance(length, Some(&mut output))?;
        Ok(output)
    }
    fn byte(&mut self) -> Result<u8> {
        ensure!(
            self.header_bytes < MAX_HEADER_BYTES,
            "Compressed frame headers exceed 1 MiB"
        );
        ensure!(self.position < self.total, "Truncated compressed header");
        while self.offset == self.pieces[self.piece].len() {
            self.piece += 1;
            self.offset = 0;
        }
        let value = self.pieces[self.piece][self.offset];
        self.offset += 1;
        self.position += 1;
        self.header_bytes += 1;
        Ok(value)
    }
    fn advance(&mut self, mut length: usize, mut output: Option<&mut Vec<u8>>) -> Result<()> {
        ensure!(
            length <= self.total.saturating_sub(self.position),
            "Compressed tile length exceeds frame"
        );
        while length > 0 {
            let piece = self
                .pieces
                .get(self.piece)
                .context("Truncated compressed fragments")?;
            let count = length.min(piece.len() - self.offset);
            if let Some(out) = &mut output {
                out.extend_from_slice(&piece[self.offset..self.offset + count]);
            }
            self.offset += count;
            self.position += count;
            length -= count;
            if self.offset == piece.len() {
                self.piece += 1;
                self.offset = 0;
            }
        }
        Ok(())
    }
    fn marker(&mut self) -> Result<u8> {
        ensure!(self.byte()? == 0xff, "Invalid compressed marker prefix");
        loop {
            let code = self.byte()?;
            if code != 0xff {
                return Ok(code);
            }
        }
    }
    fn segment(&mut self) -> Result<Vec<u8>> {
        let size = self.take(2)?;
        let size = u16::from_be_bytes([size[0], size[1]]) as usize;
        ensure!(size >= 2, "Invalid compressed marker length");
        self.take(size - 2)
    }
}

fn dimensions(expected: &Expected, width: u32, height: u32, components: u16) -> Result<()> {
    ensure!(
        width > 0 && height > 0 && width == expected.width && height == expected.height,
        "Encoded dimensions {width}x{height} differ from DICOM {}x{}",
        expected.width,
        expected.height
    );
    ensure!(
        components == expected.components,
        "Encoded component count differs from DICOM SamplesPerPixel"
    );
    Ok(())
}

/// Whether a codestream's samples come out as wide as BitsAllocated: 8 bits up to 8-bit precision, 16 above (what the
/// decoders write, and what the pixel buffer is made for). The precision itself may differ from BitsStored: some
/// scanners encode a 12-bit CT with 16-bit precision. The stored bits are then taken from each sample as they are
/// from uncompressed pixels (decode::scalar_values), so the same values come out as from the original image.
fn sample_width(expected: &Expected, precision: u16) -> bool {
    (1..=16).contains(&precision) && expected.allocated == if precision <= 8 { 8 } else { 16 }
}

fn check_jpeg(reader: &mut Cursor<'_>, expected: &Expected, jpeg_ls: bool) -> Result<()> {
    ensure!(reader.marker()? == 0xd8, "Missing JPEG start marker");
    let mut seen_frame = false;
    loop {
        let marker = reader.marker()?;
        if marker == 0xda {
            ensure!(seen_frame, "JPEG scan starts before frame dimensions");
            return Ok(());
        }
        ensure!(
            !matches!(marker, 0xd8 | 0xd9 | 0xd0..=0xd7 | 0x01 | 0x00),
            "Invalid JPEG header marker"
        );
        let payload = reader.segment()?;
        let is_frame =
            matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf | 0xf7);
        if !is_frame {
            continue;
        }
        ensure!(!seen_frame, "Multiple JPEG frame headers are unsupported");
        ensure!(
            (marker == 0xf7) == jpeg_ls,
            "JPEG frame process differs from transfer syntax"
        );
        ensure!(payload.len() >= 6, "Truncated JPEG frame header");
        let components = u16::from(payload[5]);
        ensure!(
            payload.len() == 6 + components as usize * 3,
            "Invalid JPEG frame component table"
        );
        dimensions(
            expected,
            u32::from(u16::from_be_bytes([payload[3], payload[4]])),
            u32::from(u16::from_be_bytes([payload[1], payload[2]])),
            components,
        )?;
        let precision = u16::from(payload[0]);
        ensure!(
            sample_width(expected, precision),
            "JPEG decoded sample width ({precision}-bit precision) differs from DICOM BitsAllocated {} (BitsStored {})",
            expected.allocated,
            expected.precision
        );
        let mut identifiers = [false; 256];
        for component in payload[6..].chunks_exact(3) {
            ensure!(
                !identifiers[component[0] as usize],
                "Duplicate JPEG component identifier"
            );
            identifiers[component[0] as usize] = true;
            let (h, v) = (component[1] >> 4, component[1] & 15);
            if jpeg_ls {
                ensure!(h == 1 && v == 1, "JPEG-LS subsampling is unsupported");
            } else {
                ensure!(
                    (1..=4).contains(&h) && (1..=4).contains(&v),
                    "Invalid JPEG sampling factor"
                );
            }
        }
        seen_frame = true;
    }
}

fn word(payload: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(payload[at..at + 4].try_into().unwrap())
}

fn check_jpeg2000(reader: &mut Cursor<'_>, expected: &Expected) -> Result<()> {
    ensure!(
        reader.marker()? == 0x4f,
        "JPEG 2000 must contain a raw codestream"
    );
    ensure!(
        reader.marker()? == 0x51,
        "JPEG 2000 size header must follow its start marker"
    );
    let siz = reader.segment()?;
    ensure!(siz.len() >= 36, "Truncated JPEG 2000 size header");
    let count = u16::from_be_bytes([siz[34], siz[35]]);
    ensure!(
        siz.len() == 36 + count as usize * 3,
        "Invalid JPEG 2000 component table"
    );
    let (x, y, x0, y0) = (word(&siz, 2), word(&siz, 6), word(&siz, 10), word(&siz, 14));
    let width = x
        .checked_sub(x0)
        .context("Invalid JPEG 2000 image origin")?;
    let height = y
        .checked_sub(y0)
        .context("Invalid JPEG 2000 image origin")?;
    dimensions(expected, width, height, count)?;
    for component in siz[36..].chunks_exact(3) {
        let precision = u16::from(component[0] & 127) + 1;
        ensure!(
            precision == expected.precision || sample_width(expected, precision),
            "JPEG 2000 precision {precision} differs from DICOM BitsStored {} and does not fit BitsAllocated {}",
            expected.precision,
            expected.allocated
        );
        ensure!(
            (component[0] & 128 != 0) == expected.signed,
            "JPEG 2000 signedness differs from DICOM PixelRepresentation"
        );
        ensure!(
            component[1] == 1 && component[2] == 1,
            "Subsampled JPEG 2000 components require an unsupported upsampling step"
        );
    }
    let (tile_x, tile_y, tile_x0, tile_y0) = (
        word(&siz, 18),
        word(&siz, 22),
        word(&siz, 26),
        word(&siz, 30),
    );
    ensure!(
        tile_x > 0
            && tile_y > 0
            && tile_x0 <= x0
            && tile_y0 <= y0
            && u64::from(tile_x0) + u64::from(tile_x) > u64::from(x0)
            && u64::from(tile_y0) + u64::from(tile_y) > u64::from(y0),
        "Invalid JPEG 2000 tile geometry"
    );
    let tiles = u64::from(x - tile_x0).div_ceil(u64::from(tile_x))
        * u64::from(y - tile_y0).div_ceil(u64::from(tile_y));
    ensure!(
        tiles <= MAX_TILES,
        "JPEG 2000 tile grid exceeds supported limit"
    );
    let mut seen_cod = false;
    let mut in_tile = false;
    let mut seen_tile = false;
    let mut tile_end = None;
    loop {
        let marker = reader.marker()?;
        let marker_start = reader.position - 2;
        match marker {
            0xd9 => {
                ensure!(seen_cod && seen_tile, "Incomplete JPEG 2000 headers");
                return Ok(());
            }
            0x93 => {
                ensure!(
                    seen_cod && in_tile,
                    "JPEG 2000 data starts before coding/tile headers"
                );
                if let Some(end) = tile_end {
                    ensure!(end >= reader.position, "Invalid JPEG 2000 tile part length");
                    reader.advance(end - reader.position, None)?;
                    in_tile = false;
                } else {
                    return Ok(());
                }
            }
            0x4f | 0x51 => bail!("Duplicate JPEG 2000 image headers"),
            0x74 | 0x75 | 0x77 | 0x78 => {
                bail!("Custom JPEG 2000 component transforms are unsupported")
            }
            _ => {
                let payload = reader.segment()?;
                match marker {
                    0x52 => {
                        ensure!(payload.len() >= 10, "Truncated JPEG 2000 coding header");
                        let mct = payload[4];
                        let transformed =
                            matches!(expected.photometric.as_str(), "YBR_RCT" | "YBR_ICT");
                        ensure!(
                            mct <= 1 && (mct == 1) == transformed,
                            "JPEG 2000 color transform disagrees with PhotometricInterpretation"
                        );
                        ensure!(
                            mct == 0 || expected.components == 3,
                            "JPEG 2000 color transform requires three components"
                        );
                        if transformed {
                            ensure!(
                                (payload[9] == 1) == (expected.photometric == "YBR_RCT"),
                                "JPEG 2000 reversible transform disagrees with PhotometricInterpretation"
                            );
                        }
                        seen_cod = true;
                    }
                    0x90 => {
                        ensure!(
                            seen_cod && !in_tile && payload.len() == 8,
                            "Invalid JPEG 2000 tile part header"
                        );
                        let length = word(&payload, 2) as usize;
                        ensure!(
                            length == 0 || length >= 14,
                            "Invalid JPEG 2000 tile part length"
                        );
                        tile_end = if length == 0 {
                            None
                        } else {
                            Some(
                                marker_start
                                    .checked_add(length)
                                    .context("Tile offset overflow")?,
                            )
                        };
                        ensure!(
                            tile_end.is_none_or(|end| end <= reader.total),
                            "JPEG 2000 tile extends beyond frame"
                        );
                        in_tile = true;
                        seen_tile = true;
                    }
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{
        DataElement, PrimitiveValue, VR,
        value::{PixelFragmentSequence, Value},
    };
    use dicom_object::{FileMetaTableBuilder, InMemDicomObject};

    fn expected() -> Expected {
        Expected {
            width: 1,
            height: 1,
            components: 3,
            precision: 8,
            allocated: 8,
            signed: false,
            photometric: "RGB".into(),
        }
    }
    fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0xff, marker];
        bytes.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }
    fn jpeg(width: u16, height: u16, precision: u8, ls: bool, sampling: u8) -> Vec<u8> {
        let mut payload = vec![precision];
        payload.extend_from_slice(&height.to_be_bytes());
        payload.extend_from_slice(&width.to_be_bytes());
        payload.extend([3, 1, sampling, 0, 2, 0x11, 0, 3, 0x11, 0]);
        let mut bytes = vec![0xff, 0xd8];
        bytes.extend(segment(if ls { 0xf7 } else { 0xc0 }, &payload));
        bytes.extend(segment(
            0xda,
            &[3, 1, 0, 2, 0, 3, 0, 0, if ls { 2 } else { 63 }, 0],
        ));
        bytes
    }
    fn siz(width: u32, height: u32, precision: u8, components: u16, subsample: u8) -> Vec<u8> {
        let mut payload = vec![0, 0];
        for n in [width, height, 0, 0, width, height, 0, 0] {
            payload.extend(n.to_be_bytes());
        }
        payload.extend(components.to_be_bytes());
        for _ in 0..components {
            payload.extend([precision - 1, subsample, 1]);
        }
        segment(0x51, &payload)
    }
    fn cod(mct: u8, transform: u8) -> Vec<u8> {
        segment(0x52, &[0, 0, 0, 1, mct, 0, 4, 4, 0, transform])
    }
    fn j2k(width: u32, height: u32, precision: u8, mct: u8) -> Vec<u8> {
        let mut bytes = vec![0xff, 0x4f];
        bytes.extend(siz(width, height, precision, 3, 1));
        bytes.extend(cod(mct, 1));
        bytes.extend(segment(0x90, &[0, 0, 0, 0, 0, 0, 0, 1]));
        bytes.extend([0xff, 0x93]);
        bytes
    }
    fn object(
        syntax: &str,
        frames: usize,
        fragments: Vec<Vec<u8>>,
        offsets: Vec<u32>,
    ) -> DefaultDicomObject {
        let mut object = InMemDicomObject::new_empty();
        for (tag, vr, value) in [
            (Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.6.1"),
            (Tag(0x0008, 0x0018), VR::UI, "2.25.77291"),
            (Tag(0x0028, 0x0004), VR::CS, "RGB"),
        ] {
            object.put_str(tag, vr, value);
        }
        for (tag, value) in [
            (Tag(0x0028, 0x0010), 1u16),
            (Tag(0x0028, 0x0011), 1),
            (Tag(0x0028, 0x0002), 3),
            (Tag(0x0028, 0x0100), 8),
            (Tag(0x0028, 0x0101), 8),
            (Tag(0x0028, 0x0102), 7),
            (Tag(0x0028, 0x0103), 0),
        ] {
            object.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
        }
        object.put_str(Tag(0x0028, 0x0008), VR::IS, frames.to_string());
        object.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OB,
            Value::PixelSequence(PixelFragmentSequence::new(offsets, fragments)),
        ));
        object
            .with_meta(FileMetaTableBuilder::new().transfer_syntax(syntax))
            .unwrap()
    }

    #[test]
    fn enormous_encoded_dimensions_fail_using_only_small_headers() {
        for (syntax, bytes) in [
            ("1.2.840.10008.1.2.4.50", jpeg(65535, 65535, 8, false, 0x11)),
            ("1.2.840.10008.1.2.4.80", jpeg(65535, 65535, 8, true, 0x11)),
            ("1.2.840.10008.1.2.4.90", j2k(u32::MAX, u32::MAX, 8, 0)),
        ] {
            assert!(bytes.len() < 100);
            let error = check(&object(syntax, 1, vec![bytes], vec![]), None).unwrap_err();
            assert!(format!("{error:#}").contains("Encoded dimensions"));
        }
    }

    #[test]
    fn jpeg_subsampling_and_marker_fill_can_cross_fragments() {
        for sampling in [0x11, 0x21, 0x22] {
            let mut bytes = jpeg(1, 1, 8, false, sampling);
            bytes.insert(2, 0xff);
            let fragments = bytes.chunks(2).map(<[u8]>::to_vec).collect();
            check(
                &object("1.2.840.10008.1.2.4.50", 1, fragments, vec![]),
                None,
            )
            .unwrap();
        }
        let mut bytes = jpeg(1, 1, 8, true, 0x11);
        bytes.insert(2, 0xff);
        check(
            &object(
                "1.2.840.10008.1.2.4.80",
                1,
                bytes.chunks(2).map(<[u8]>::to_vec).collect(),
                vec![],
            ),
            None,
        )
        .unwrap();
    }

    #[test]
    fn every_selected_frame_is_checked_using_basic_offsets() {
        let first = jpeg(1, 1, 8, false, 0x22);
        let second = jpeg(32, 16, 8, false, 0x22);
        let mut fragments = vec![first[..10].to_vec(), first[10..].to_vec()];
        let second_offset = fragments.iter().map(|p| p.len() as u32 + 8).sum();
        fragments.extend([second[..12].to_vec(), second[12..].to_vec()]);
        let object = object(
            "1.2.840.10008.1.2.4.50",
            2,
            fragments.clone(),
            vec![0, second_offset],
        );
        check(&object, Some(0)).unwrap();
        assert!(check(&object, Some(1)).is_err());
        assert!(check(&object, None).is_err());
        assert!(frame_ranges(&fragments, &[0, second_offset + 1], 2).is_err());
        assert!(frame_ranges(&fragments, &[], 2).is_err());
    }

    #[test]
    fn component_precision_and_sample_width_mismatches_are_rejected() {
        for ls in [false, true] {
            let syntax = if ls {
                "1.2.840.10008.1.2.4.80"
            } else {
                "1.2.840.10008.1.2.4.50"
            };
            let bytes = jpeg(1, 1, 12, ls, 0x11);
            assert!(
                format!(
                    "{:#}",
                    check(&object(syntax, 1, vec![bytes], vec![]), None).unwrap_err()
                )
                .contains("precision")
            );
            let bytes = jpeg(1, 1, 8, ls, 0x11);
            let mut o = object(syntax, 1, vec![bytes], vec![]);
            o.put(DataElement::new(
                Tag(0x0028, 0x0100),
                VR::US,
                PrimitiveValue::from(16u16),
            ));
            assert!(format!("{:#}", check(&o, None).unwrap_err()).contains("sample width"));
        }
        let mut expected = expected();
        expected.components = 1;
        let bytes = vec![jpeg(1, 1, 8, false, 0x11)];
        assert!(check_jpeg(&mut Cursor::new(&bytes).unwrap(), &expected, false).is_err());
        let bytes = vec![j2k(1, 1, 12, 0)];
        assert!(check_jpeg2000(&mut Cursor::new(&bytes).unwrap(), &expected).is_err());
    }

    #[test]
    fn a_codestream_wider_than_bits_stored_is_read_when_its_samples_fit() {
        // Stored in 12 bits, encoded with 16-bit precision (as some scanners write a CT). The test codestreams have
        // three components; the precision rule does not depend on them.
        let mut ct = expected();
        (ct.precision, ct.allocated) = (12, 16);
        for ls in [false, true] {
            check_jpeg(&mut Cursor::new(&[jpeg(1, 1, 16, ls, 0x11)]).unwrap(), &ct, ls).unwrap();
            check_jpeg(&mut Cursor::new(&[jpeg(1, 1, 12, ls, 0x11)]).unwrap(), &ct, ls).unwrap();
            // Eight-bit samples would not fill the 16-bit buffer.
            let error = check_jpeg(&mut Cursor::new(&[jpeg(1, 1, 8, ls, 0x11)]).unwrap(), &ct, ls).unwrap_err();
            assert!(format!("{error:#}").contains("8-bit precision"), "{error:#}");
        }
        let mut j2k_ct = ct;
        check_jpeg2000(&mut Cursor::new(&[j2k(1, 1, 16, 0)]).unwrap(), &j2k_ct).unwrap();
        // As before: a precision equal to BitsStored, and a 16-bit precision that an 8-bit buffer cannot hold.
        j2k_ct.precision = 8;
        check_jpeg2000(&mut Cursor::new(&[j2k(1, 1, 8, 0)]).unwrap(), &j2k_ct).unwrap();
        j2k_ct.allocated = 8;
        assert!(check_jpeg2000(&mut Cursor::new(&[j2k(1, 1, 16, 0)]).unwrap(), &j2k_ct).is_err());
    }

    #[test]
    fn jpeg2000_color_transform_and_subsampling_are_not_guessed() {
        for (photometric, mct, transform) in [
            ("RGB", 0, 1),
            ("YBR_FULL", 0, 1),
            ("YBR_RCT", 1, 1),
            ("YBR_ICT", 1, 0),
        ] {
            let mut e = expected();
            e.photometric = photometric.into();
            let mut bytes = vec![0xff, 0x4f];
            bytes.extend(siz(1, 1, 8, 3, 1));
            bytes.extend(cod(mct, transform));
            bytes.extend(segment(0x90, &[0, 0, 0, 0, 0, 0, 0, 1]));
            bytes.extend([0xff, 0x93]);
            check_jpeg2000(&mut Cursor::new(&[bytes.clone()]).unwrap(), &e).unwrap();
            e.photometric = if mct == 0 { "YBR_RCT" } else { "RGB" }.into();
            assert!(check_jpeg2000(&mut Cursor::new(&[bytes]).unwrap(), &e).is_err());
        }
        let mut bytes = vec![0xff, 0x4f];
        bytes.extend(siz(1, 1, 8, 3, 2));
        assert!(
            format!(
                "{:#}",
                check_jpeg2000(&mut Cursor::new(&[bytes]).unwrap(), &expected()).unwrap_err()
            )
            .contains("Subsampled")
        );
        let mut bytes = j2k(1, 1, 8, 0);
        bytes.truncate(bytes.len() - 2);
        bytes.extend(cod(1, 1));
        bytes.extend([0xff, 0x93]);
        assert!(check_jpeg2000(&mut Cursor::new(&[bytes]).unwrap(), &expected()).is_err());
    }

    #[test]
    fn jpeg2000_tile_payload_is_skipped_without_copying_it_as_header() {
        let mut bytes = vec![0xff, 0x4f];
        bytes.extend(siz(1, 1, 8, 3, 1));
        bytes.extend(cod(0, 1));
        let payload_size = 2 * MAX_HEADER_BYTES;
        let mut sot = vec![0, 0];
        sot.extend(((payload_size + 14) as u32).to_be_bytes());
        sot.extend([0, 1]);
        bytes.extend(segment(0x90, &sot));
        bytes.extend([0xff, 0x93]);
        bytes.resize(bytes.len() + payload_size, 0);
        bytes.extend([0xff, 0xd9]);
        let pieces = vec![bytes];
        let mut reader = Cursor::new(&pieces).unwrap();
        check_jpeg2000(&mut reader, &expected()).unwrap();
        assert!(reader.header_bytes < 100);
    }

    #[test]
    fn malformed_or_excessive_headers_fail_before_decoder_calls() {
        let mut bytes = vec![0xff, 0xd8];
        for _ in 0..17 {
            bytes.extend(segment(0xe1, &vec![0; 65533]));
        }
        assert!(
            format!(
                "{:#}",
                check_jpeg(&mut Cursor::new(&[bytes]).unwrap(), &expected(), false).unwrap_err()
            )
            .contains("1 MiB")
        );
        for bytes in [
            vec![0xff],
            vec![0xff, 0xd8, 0xff, 0xc0, 0, 1],
            vec![0xff, 0xd8, 0xff, 0xc0, 0, 17, 8],
        ] {
            assert!(check_jpeg(&mut Cursor::new(&[bytes]).unwrap(), &expected(), false).is_err());
        }
    }
}
