use anyhow::{Context, Result, bail, ensure};
use dicom_core::{PrimitiveValue, Tag, value::Value};
use dicom_object::DefaultDicomObject;
use dicom_pixeldata::{ConvertOptions, DecodedPixelData, ModalityLutOption, PixelDecoder};
use std::collections::HashMap;

const MAX_PIXELS: usize = 64 * 1024 * 1024 / 3;
const MAX_PALETTE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Descriptor {
    count: usize,
    first: i64,
    bits: u16,
}

fn read_descriptor(object: &DefaultDicomObject, channel: u16) -> Result<Descriptor> {
    let values = object
        .element(Tag(0x0028, 0x1100 + channel))?
        .to_multi_int::<i64>()
        .context("Invalid palette LUT descriptor")?;
    ensure!(
        values.len() == 3,
        "Palette descriptor must contain three values"
    );
    let count = values[0] as u16;
    let signed = object
        .element(Tag(0x0028, 0x0103))
        .ok()
        .and_then(|e| e.to_int::<u16>().ok())
        .unwrap_or(0)
        == 1;
    let first = if signed {
        values[1] as i16 as i64
    } else {
        values[1] as u16 as i64
    };
    let bits = values[2] as u16;
    ensure!(
        matches!(bits, 8 | 16),
        "Palette entries must have 8 or 16 bits"
    );
    Ok(Descriptor {
        count: if count == 0 { 65536 } else { count as usize },
        first,
        bits,
    })
}

fn little_endian(object: &DefaultDicomObject) -> bool {
    object.meta().transfer_syntax() != "1.2.840.10008.1.2.2"
}

// OW values are decoded into host-endian words by dicom-rs. Restore their source
// byte order before interpreting packed 8-bit LUTs and indirect byte offsets.
fn source_bytes(object: &DefaultDicomObject, tag: Tag) -> Result<Vec<u8>> {
    let element = object.element(tag)?;
    let Value::Primitive(value) = element.value() else {
        bail!("Palette data is not a primitive value")
    };
    ensure!(
        value.to_bytes().len() <= MAX_PALETTE_BYTES,
        "Palette data exceeds its size limit"
    );
    let le = little_endian(object);
    Ok(match value {
        PrimitiveValue::U16(values) => values
            .iter()
            .flat_map(|v| if le { v.to_le_bytes() } else { v.to_be_bytes() })
            .collect(),
        PrimitiveValue::I16(values) => values
            .iter()
            .flat_map(|v| if le { v.to_le_bytes() } else { v.to_be_bytes() })
            .collect(),
        PrimitiveValue::U8(values) => values.to_vec(),
        _ => bail!("Unsupported palette data representation"),
    })
}

fn words(bytes: &[u8], le: bool) -> Result<Vec<u16>> {
    ensure!(
        bytes.len() % 2 == 0,
        "Palette word data has an odd byte count"
    );
    Ok(bytes
        .chunks_exact(2)
        .map(|v| {
            if le {
                u16::from_le_bytes([v[0], v[1]])
            } else {
                u16::from_be_bytes([v[0], v[1]])
            }
        })
        .collect())
}

fn direct_palette(bytes: &[u8], descriptor: Descriptor, le: bool) -> Result<Vec<u16>> {
    if descriptor.bits == 8 {
        if bytes.len() == descriptor.count
            || (descriptor.count % 2 == 1
                && bytes.len() == descriptor.count + 1
                && bytes.last() == Some(&0))
        {
            return Ok(bytes[..descriptor.count]
                .iter()
                .map(|v| *v as u16)
                .collect());
        }
        ensure!(
            bytes.len() == descriptor.count * 2,
            "8-bit palette data length does not match its descriptor"
        );
        let values = words(bytes, le)?;
        ensure!(
            values.iter().all(|v| *v <= 255),
            "8-bit palette stored in words has nonzero padding bits"
        );
        Ok(values)
    } else {
        ensure!(
            bytes.len() == descriptor.count * 2,
            "16-bit palette data length does not match its descriptor"
        );
        words(bytes, le)
    }
}

#[derive(Clone, Debug)]
enum Segment {
    Discrete(Vec<u16>),
    Linear { length: usize, end: u16 },
    Indirect { segments: usize, byte_offset: usize },
}

fn segmented_palette(bytes: &[u8], descriptor: Descriptor, le: bool) -> Result<Vec<u16>> {
    let unit_bytes = (descriptor.bits / 8) as usize;
    let data = if descriptor.bits == 8 {
        bytes.iter().map(|v| *v as u16).collect()
    } else {
        words(bytes, le)?
    };
    let mut segments = Vec::new();
    let mut starts = HashMap::new();
    let mut offset = 0usize;
    while offset < data.len() {
        if descriptor.bits == 8 && offset + 1 == data.len() && data[offset] == 0 {
            break;
        }
        ensure!(
            offset + 1 < data.len(),
            "Truncated segmented palette header"
        );
        starts.insert(offset * unit_bytes, segments.len());
        let opcode = data[offset];
        let length = data[offset + 1] as usize;
        ensure!(length > 0, "Palette segment length must be positive");
        offset += 2;
        let segment = match opcode {
            0 => {
                let end = offset
                    .checked_add(length)
                    .context("Palette segment size overflow")?;
                ensure!(end <= data.len(), "Truncated discrete palette segment");
                let values = data[offset..end].to_vec();
                offset = end;
                Segment::Discrete(values)
            }
            1 => {
                let end = *data
                    .get(offset)
                    .context("Truncated linear palette segment")?;
                offset += 1;
                Segment::Linear { length, end }
            }
            2 => {
                let pointer = if descriptor.bits == 16 {
                    ensure!(
                        offset + 1 < data.len(),
                        "Truncated indirect palette segment"
                    );
                    let pointer = data[offset] as u32 | ((data[offset + 1] as u32) << 16);
                    offset += 2;
                    pointer
                } else {
                    ensure!(
                        offset + 3 < data.len(),
                        "Truncated indirect palette segment"
                    );
                    let part = |at: usize| {
                        if le {
                            (data[at] as u32) | ((data[at + 1] as u32) << 8)
                        } else {
                            ((data[at] as u32) << 8) | data[at + 1] as u32
                        }
                    };
                    let pointer = part(offset) | (part(offset + 2) << 16);
                    offset += 4;
                    pointer
                };
                Segment::Indirect {
                    segments: length,
                    byte_offset: pointer as usize,
                }
            }
            _ => bail!("Unknown segmented palette opcode {opcode}"),
        };
        segments.push(segment);
    }
    let mut result = Vec::with_capacity(descriptor.count);
    for segment in &segments {
        if let Segment::Indirect {
            segments: count,
            byte_offset,
        } = segment
        {
            let start = *starts
                .get(byte_offset)
                .context("Indirect palette offset is not a segment boundary")?;
            let end = start
                .checked_add(*count)
                .context("Indirect palette count overflow")?;
            ensure!(
                end <= segments.len(),
                "Indirect palette reference extends outside the data"
            );
            for referenced in &segments[start..end] {
                ensure!(
                    !matches!(referenced, Segment::Indirect { .. }),
                    "Indirect palette segments cannot reference other indirect segments"
                );
                append_segment(referenced, &mut result, descriptor.count)?;
            }
        } else {
            append_segment(segment, &mut result, descriptor.count)?;
        }
    }
    ensure!(
        result.len() == descriptor.count,
        "Expanded palette length does not match its descriptor"
    );
    Ok(result)
}

fn append_segment(segment: &Segment, output: &mut Vec<u16>, limit: usize) -> Result<()> {
    match segment {
        Segment::Discrete(values) => {
            ensure!(
                output.len() + values.len() <= limit,
                "Expanded palette exceeds its descriptor count"
            );
            output.extend_from_slice(values);
        }
        Segment::Linear { length, end } => {
            let start = *output
                .last()
                .context("A linear palette segment needs a preceding value")?
                as u64;
            ensure!(
                output.len() + length <= limit,
                "Expanded palette exceeds its descriptor count"
            );
            let count = *length as u64;
            for i in 1..=count {
                let numerator = (count - i) * start + i * (*end as u64);
                let whole = numerator / count;
                let remainder = numerator % count;
                let round_up = remainder * 2 > count || (remainder * 2 == count && whole % 2 == 1);
                output.push((whole + u64::from(round_up)) as u16);
            }
        }
        Segment::Indirect { .. } => bail!("Nested indirect palette segment"),
    }
    Ok(())
}

fn channel(object: &DefaultDicomObject, channel: u16, descriptor: Descriptor) -> Result<Vec<u16>> {
    let direct = Tag(0x0028, 0x1200 + channel);
    let segmented = Tag(0x0028, 0x1220 + channel);
    let has_direct = object.element(direct).is_ok();
    let has_segmented = object.element(segmented).is_ok();
    ensure!(
        has_direct != has_segmented,
        "Palette channel must have exactly one direct or segmented LUT"
    );
    let bytes = source_bytes(object, if has_direct { direct } else { segmented })?;
    if has_direct {
        direct_palette(&bytes, descriptor, little_endian(object))
    } else {
        segmented_palette(&bytes, descriptor, little_endian(object))
    }
}

pub fn apply_palette(
    decoded: &DecodedPixelData<'_>,
    object: &DefaultDicomObject,
    index: u32,
) -> Result<Vec<u8>> {
    ensure!(
        decoded.samples_per_pixel() == 1,
        "Palette color requires one stored sample per pixel"
    );
    let count = (decoded.rows() as usize)
        .checked_mul(decoded.columns() as usize)
        .context("Palette image size overflow")?;
    ensure!(
        count > 0 && count <= MAX_PIXELS,
        "Palette image exceeds the supported frame size"
    );
    let descriptor = read_descriptor(object, 1)?;
    ensure!(
        read_descriptor(object, 2)? == descriptor && read_descriptor(object, 3)? == descriptor,
        "RGB palette descriptors must agree"
    );
    let red = channel(object, 1, descriptor)?;
    let green = channel(object, 2, descriptor)?;
    let blue = channel(object, 3, descriptor)?;
    if object.element(Tag(0x0028, 0x1104)).is_ok() {
        let alpha_descriptor = read_descriptor(object, 4)?;
        ensure!(
            alpha_descriptor.count == descriptor.count
                && alpha_descriptor.first == descriptor.first,
            "Alpha palette descriptor differs from RGB"
        );
        let alpha = channel(object, 4, alpha_descriptor)?;
        let opaque = if alpha_descriptor.bits == 8 {
            255
        } else {
            65535
        };
        ensure!(
            alpha.iter().all(|value| *value == opaque),
            "Palette alpha transparency requires an RGBA viewport"
        );
    }
    let bits = decoded.bits_stored();
    let high = decoded.high_bit();
    ensure!(
        matches!(decoded.bits_allocated(), 8 | 16)
            && bits > 0
            && bits <= 16
            && high < decoded.bits_allocated()
            && high + 1 >= bits,
        "Unsupported palette index bit layout"
    );
    let options = ConvertOptions::new().with_modality_lut(ModalityLutOption::None);
    let values = decoded
        .to_vec_frame_with_options::<i64>(index, &options)
        .context("Cannot decode palette indices")?;
    ensure!(
        values.len() == count,
        "Palette index count differs from image dimensions"
    );
    let shift = high + 1 - bits;
    let mask = (1u64 << bits) - 1;
    let sign = 1u64 << (bits - 1);
    let signed = decoded.pixel_representation() as u16 == 1;
    let depth_shift = descriptor.bits - 8;
    let mut rgb = Vec::with_capacity(count * 3);
    for value in values {
        let packed = ((value as u64) >> shift) & mask;
        let stored = if signed && packed & sign != 0 {
            packed as i64 - (1i64 << bits)
        } else {
            packed as i64
        };
        let index = (stored - descriptor.first).clamp(0, descriptor.count as i64 - 1) as usize;
        rgb.extend_from_slice(&[
            (red[index] >> depth_shift) as u8,
            (green[index] >> depth_shift) as u8,
            (blue[index] >> depth_shift) as u8,
        ]);
    }
    Ok(rgb)
}

pub fn decode_palette_frame(object: &DefaultDicomObject, index: u32) -> Result<Vec<u8>> {
    let decoded = object
        .decode_pixel_data_frame(index)
        .context("Cannot decode palette pixel data")?;
    apply_palette(&decoded, object, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{DataElement, VR};
    use dicom_object::{FileMetaTableBuilder, InMemDicomObject};

    fn fixture(
        pixels: &[u16],
        first: i16,
        bits: u16,
        tables: [Vec<u16>; 3],
        signed: bool,
    ) -> DefaultDicomObject {
        let mut object = InMemDicomObject::new_empty();
        for (tag, vr, value) in [
            (Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.7"),
            (Tag(0x0008, 0x0018), VR::UI, "2.25.123"),
            (Tag(0x0020, 0x000d), VR::UI, "2.25.124"),
            (Tag(0x0020, 0x000e), VR::UI, "2.25.125"),
            (Tag(0x0028, 0x0004), VR::CS, "PALETTE COLOR"),
        ] {
            object.put_str(tag, vr, value);
        }
        for (tag, value) in [
            (Tag(0x0028, 0x0010), 1),
            (Tag(0x0028, 0x0011), pixels.len() as u16),
            (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), 16),
            (Tag(0x0028, 0x0101), 16),
            (Tag(0x0028, 0x0102), 15),
            (Tag(0x0028, 0x0103), u16::from(signed)),
        ] {
            object.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
        }
        for (index, table) in tables.into_iter().enumerate() {
            let channel = index as u16 + 1;
            object.put(DataElement::new(
                Tag(0x0028, 0x1100 + channel),
                VR::US,
                PrimitiveValue::U16(vec![table.len() as u16, first as u16, bits].into()),
            ));
            object.put(DataElement::new(
                Tag(0x0028, 0x1200 + channel),
                VR::OW,
                PrimitiveValue::U16(table.into()),
            ));
        }
        object.put_str(Tag(0x0028, 0x1053), VR::DS, "100");
        object.put_str(Tag(0x0028, 0x1052), VR::DS, "1000");
        object.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OW,
            PrimitiveValue::U16(pixels.to_vec().into()),
        ));
        object
            .with_meta(FileMetaTableBuilder::new().transfer_syntax("1.2.840.10008.1.2.1"))
            .unwrap()
    }
    #[test]
    fn palette_clips_indices_and_does_not_rescale_or_window() {
        let object = fixture(
            &[0, 10, 11, 12, 255],
            10,
            8,
            [vec![5, 6, 7], vec![20, 30, 40], vec![200, 201, 202]],
            false,
        );
        assert_eq!(
            decode_palette_frame(&object, 0).unwrap(),
            [5, 20, 200, 5, 20, 200, 6, 30, 201, 7, 40, 202, 7, 40, 202]
        );
    }
    #[test]
    fn signed_first_mapped_value_and_sixteen_bit_display_conversion() {
        let object = fixture(
            &[(-2i16) as u16, (-1i16) as u16, 0, 1],
            -1,
            16,
            [
                vec![0, 32768, 65535],
                vec![65535, 256, 0],
                vec![257, 513, 769],
            ],
            true,
        );
        assert_eq!(
            decode_palette_frame(&object, 0).unwrap(),
            [0, 255, 1, 0, 255, 1, 128, 1, 2, 255, 0, 3]
        );
    }
    #[test]
    fn direct_eight_bit_packing_and_word_padding_are_distinct() {
        let d = Descriptor {
            count: 3,
            first: 0,
            bits: 8,
        };
        assert_eq!(direct_palette(&[1, 2, 3, 0], d, true).unwrap(), [1, 2, 3]);
        assert_eq!(
            direct_palette(&[1, 0, 2, 0, 3, 0], d, true).unwrap(),
            [1, 2, 3]
        );
        assert_eq!(
            direct_palette(&[0, 1, 0, 2, 0, 3], d, false).unwrap(),
            [1, 2, 3]
        );
        assert!(direct_palette(&[1, 0, 2, 1, 3, 0], d, true).is_err());
    }
    fn segmented(values: &[u16], count: usize) -> Result<Vec<u16>> {
        let bytes = values
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<_>>();
        segmented_palette(
            &bytes,
            Descriptor {
                count,
                first: 0,
                bits: 16,
            },
            true,
        )
    }
    #[test]
    fn segmented_linear_uses_previous_endpoint_and_rounds_ties_to_even() {
        assert_eq!(
            segmented(&[0, 1, 0, 1, 4, 10], 5).unwrap(),
            [0, 2, 5, 8, 10]
        );
        assert_eq!(
            segmented(&[0, 1, 10, 1, 4, 0], 5).unwrap(),
            [10, 8, 5, 2, 0]
        );
    }
    #[test]
    fn indirect_offsets_are_bytes_and_cannot_recurse() {
        assert_eq!(
            segmented(&[0, 1, 9, 0, 2, 1, 2, 2, 1, 6, 0], 5).unwrap(),
            [9, 1, 2, 1, 2]
        );
        assert!(segmented(&[0, 1, 9, 2, 1, 6, 0], 2).is_err());
        assert!(segmented(&[0, 1, 9, 2, 1, 2, 0], 2).is_err());
    }
    #[test]
    fn segmented_eight_bit_padding_and_indirect_words_honor_endianness() {
        let d = Descriptor {
            count: 4,
            first: 0,
            bits: 8,
        };
        assert_eq!(
            segmented_palette(&[0, 2, 5, 9, 2, 1, 0, 0, 0, 0], d, true).unwrap(),
            [5, 9, 5, 9]
        );
        assert_eq!(
            segmented_palette(&[0, 1, 5, 1, 2, 9, 0], Descriptor { count: 3, ..d }, false).unwrap(),
            [5, 7, 9]
        );
    }
    #[test]
    fn malformed_segment_lengths_and_mismatched_tables_fail() {
        assert!(segmented(&[0, 3, 1, 2], 3).is_err());
        assert!(segmented(&[1, 3, 100], 3).is_err());
        assert!(segmented(&[0, 1, 0, 1, 65535, 65535], 2).is_err());
        let mut object = fixture(&[0, 1], 0, 8, [vec![0, 1], vec![0, 1], vec![0, 1]], false);
        object.put(DataElement::new(
            Tag(0x0028, 0x1102),
            VR::US,
            PrimitiveValue::U16(vec![2, 1, 8].into()),
        ));
        assert!(decode_palette_frame(&object, 0).is_err());
    }
    #[test]
    fn zero_descriptor_count_means_65536() {
        let table = (0..=u16::MAX).collect::<Vec<_>>();
        let object = fixture(
            &[0, 65535],
            0,
            16,
            [table.clone(), table.clone(), table],
            false,
        );
        assert_eq!(
            decode_palette_frame(&object, 0).unwrap(),
            [0, 0, 0, 255, 255, 255]
        );
    }
    #[test]
    fn imported_palette_uses_color_metadata_and_typed_decode_pipeline() {
        let directory = crate::test_dir::tempdir().unwrap();
        let path = directory.path().join("palette.dcm");
        fixture(
            &[0, 1, 2],
            0,
            8,
            [vec![5, 6, 7], vec![20, 30, 40], vec![200, 201, 202]],
            false,
        )
        .write_to_file(&path)
        .unwrap();
        let imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
        let source = &imported.sources[0];
        assert_eq!(source.info.components, 3);
        assert_eq!(source.info.pixel_type, "uint8");
        assert_eq!(source.info.photometric_interpretation, "PALETTE COLOR");
        assert!(!source.info.can_reconstruct);
        let frame = crate::decode::decode_frame(source, 0).unwrap();
        let volume = crate::decode::decode_volume(source).unwrap();
        for pixels in [frame, volume] {
            assert_eq!(pixels.type_name(), "uint8");
            assert_eq!(pixels.bytes(), [5, 20, 200, 6, 30, 201, 7, 40, 202]);
        }
    }
}
