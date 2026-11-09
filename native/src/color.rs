use anyhow::{Context, Result, ensure};
use dicom_core::Tag;
use dicom_encoding::adapters::PixelDataObject;
use dicom_object::DefaultDicomObject;
use dicom_pixeldata::DecodedPixelData;

pub fn decoded_photometric(object: &DefaultDicomObject, decoded: &DecodedPixelData<'_>) -> String {
    // dicom-pixeldata 0.10 labels all encapsulated three-component data RGB.
    // RLE/JPEG-LS only unpack components. JPEG2000 reverses RCT/ICT itself,
    // but YBR_FULL is stored without that transform and remains YBR_FULL.
    let source = object
        .get(Tag(0x0028, 0x0004))
        .and_then(|e| e.to_str().ok())
        .map(|s| s.trim_end_matches([' ', '\0']).to_owned())
        .unwrap_or_default();
    match object.meta().transfer_syntax() {
        "1.2.840.10008.1.2.5" | "1.2.840.10008.1.2.4.80" | "1.2.840.10008.1.2.4.81" => {
            return source;
        }
        "1.2.840.10008.1.2.4.90"
        | "1.2.840.10008.1.2.4.91"
        | "1.2.840.10008.1.2.4.92"
        | "1.2.840.10008.1.2.4.93"
        | "1.2.840.10008.1.2.4.201"
        | "1.2.840.10008.1.2.4.202"
        | "1.2.840.10008.1.2.4.203"
            if source == "YBR_FULL" =>
        {
            return source;
        }
        _ => {}
    }
    decoded.photometric_interpretation().as_str().to_owned()
}

pub fn rgb_frame(
    object: &DefaultDicomObject,
    decoded: &DecodedPixelData<'_>,
    index: u32,
    source_frame: u32,
) -> Result<Vec<u8>> {
    let photometric = decoded_photometric(object, decoded);
    if photometric == "YBR_FULL" || photometric == "RGB" {
        ensure!(
            decoded.samples_per_pixel() == 3,
            "Color images require three components"
        );
        ensure!(
            decoded.pixel_representation() as u16 == 0,
            "Color samples must be unsigned"
        );
        let bits = decoded.bits_stored();
        ensure!(
            matches!(decoded.bits_allocated(), 8 | 16)
                && bits > 0
                && bits <= decoded.bits_allocated()
                && decoded.high_bit() + 1 == bits,
            "Unsupported color sample bit layout"
        );
        let bytes = decoded.frame_data(index)?;
        let planar = if is_jpeg_ls(object) {
            jpeg_ls_planar(object, source_frame)?
        } else {
            decoded.planar_configuration() as u16 == 1
        };
        if photometric == "RGB" && bits == 8 && decoded.bits_allocated() == 8 && !planar {
            return Ok(bytes.to_vec());
        }
        let samples: Vec<u16> = if decoded.bits_allocated() == 8 {
            bytes.iter().map(|&n| u16::from(n)).collect()
        } else {
            ensure!(bytes.len() % 2 == 0, "Incomplete color sample");
            bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| u16::from_le_bytes([p[0], p[1]]))
                .collect()
        };
        let pixels = decoded.rows() as usize * decoded.columns() as usize;
        ensure!(
            samples.len() == pixels * 3,
            "Color frame dimensions differ from samples"
        );
        let max = (1u32 << bits) - 1;
        let neutral = f64::from(1u32 << (bits - 1));
        let channel = |value: f64| {
            let stored = value.round().clamp(0., f64::from(max));
            (stored * 255. / f64::from(max)).round() as u8
        };
        let mut output = Vec::with_capacity(pixels * 3);
        for p in 0..pixels {
            let sample = |c: usize| {
                f64::from(samples[if planar { c * pixels + p } else { p * 3 + c }] & max as u16)
            };
            let y = sample(0);
            let cb = sample(1) - neutral;
            let cr = sample(2) - neutral;
            if photometric == "RGB" {
                output.extend([channel(y), channel(sample(1)), channel(sample(2))]);
                continue;
            }
            // DICOM PS3.3 C.7.6.3.1.2: invert the full-range YCbCr transform.
            output.extend([
                channel(y + 1.402 * cr),
                channel(y - (0.114 * 1.772 / 0.587) * cb - (0.299 * 1.402 / 0.587) * cr),
                channel(y + 1.772 * cb),
            ]);
        }
        return Ok(output);
    }
    anyhow::bail!("Unsupported decoded DICOM color space: {photometric}")
}

fn is_jpeg_ls(object: &DefaultDicomObject) -> bool {
    matches!(
        object.meta().transfer_syntax(),
        "1.2.840.10008.1.2.4.80" | "1.2.840.10008.1.2.4.81"
    )
}

fn jpeg_ls_planar(object: &DefaultDicomObject, frame: u32) -> Result<bool> {
    let bytes = object
        .frame_pixel_data(frame)
        .context("Missing JPEG-LS frame")?;
    ensure!(
        bytes.starts_with(&[0xff, 0xd8]),
        "Invalid JPEG-LS start marker"
    );
    let mut offset = 2usize;
    while offset + 4 <= bytes.len() {
        ensure!(bytes[offset] == 0xff, "Invalid JPEG-LS marker");
        while bytes.get(offset + 1) == Some(&0xff) {
            offset += 1;
        }
        ensure!(offset + 4 <= bytes.len(), "Truncated JPEG-LS marker");
        let marker = bytes[offset + 1];
        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
        ensure!(
            length >= 2 && offset + 2 + length <= bytes.len(),
            "Invalid JPEG-LS marker length"
        );
        let payload = &bytes[offset + 4..offset + 2 + length];
        if marker == 0xda {
            let components = *payload.first().context("Missing JPEG-LS scan components")? as usize;
            let interleave = *payload
                .get(2 + 2 * components)
                .context("Missing JPEG-LS interleave mode")?;
            ensure!(interleave <= 2, "Invalid JPEG-LS interleave mode");
            return Ok(interleave == 0);
        }
        offset += 2 + length;
    }
    anyhow::bail!("Missing JPEG-LS scan header")
}

pub fn export_data(
    object: &DefaultDicomObject,
    decoded: DecodedPixelData<'_>,
) -> Result<(Vec<u8>, u16)> {
    let planar = decoded.planar_configuration() as u16;
    if decoded.samples_per_pixel() != 3 || !is_jpeg_ls(object) {
        return Ok((decoded.into_data(), planar));
    }
    let pixels = decoded.rows() as usize * decoded.columns() as usize;
    let stride = (decoded.bits_allocated() / 8) as usize;
    let mut output = Vec::with_capacity(decoded.data().len());
    for frame in 0..decoded.number_of_frames() {
        let bytes = decoded.frame_data(frame)?;
        ensure!(
            bytes.len() == pixels * 3 * stride,
            "JPEG-LS decoded dimensions differ from frame"
        );
        if jpeg_ls_planar(object, frame)? {
            for pixel in 0..pixels {
                for channel in 0..3 {
                    let start = (channel * pixels + pixel) * stride;
                    output.extend_from_slice(&bytes[start..start + stride]);
                }
            }
        } else {
            output.extend_from_slice(bytes);
        }
    }
    Ok((output, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{
        DataElement, PrimitiveValue, VR,
        value::{PixelFragmentSequence, Value},
    };
    use dicom_object::{FileMetaTableBuilder, InMemDicomObject};
    use dicom_pixeldata::{PixelDecoder, Transcode};

    const YBR: [u8; 12] = [76, 85, 255, 150, 44, 21, 29, 255, 107, 128, 128, 128];
    // Independently checked with pydicom 3.0.2 convert_color_space and pixel_array.
    const RGB: [u8; 12] = [254, 0, 0, 0, 255, 1, 0, 0, 254, 128, 128, 128];

    fn object(photometric: &str, planar: bool, rle: bool) -> DefaultDicomObject {
        let mut o = InMemDicomObject::new_empty();
        for (tag, vr, value) in [
            (Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.6.1"),
            (Tag(0x0008, 0x0018), VR::UI, "2.25.990001"),
            (Tag(0x0020, 0x000d), VR::UI, "2.25.990002"),
            (Tag(0x0020, 0x000e), VR::UI, "2.25.990003"),
            (Tag(0x0008, 0x0060), VR::CS, "US"),
            (Tag(0x0028, 0x0004), VR::CS, photometric),
        ] {
            o.put_str(tag, vr, value);
        }
        for (tag, n) in [
            (Tag(0x0028, 0x0010), 1),
            (Tag(0x0028, 0x0011), 4),
            (Tag(0x0028, 0x0002), 3),
            (Tag(0x0028, 0x0006), u16::from(planar)),
            (Tag(0x0028, 0x0100), 8),
            (Tag(0x0028, 0x0101), 8),
            (Tag(0x0028, 0x0102), 7),
            (Tag(0x0028, 0x0103), 0),
        ] {
            o.put(DataElement::new(tag, VR::US, PrimitiveValue::from(n)));
        }
        let values = if photometric == "RGB" { RGB } else { YBR };
        if rle {
            // Four literal samples per channel, matching pydicom's native RLE encoder.
            let mut fragment = vec![0u8; 64];
            for (i, n) in [3u32, 64, 70, 76].into_iter().enumerate() {
                fragment[i * 4..i * 4 + 4].copy_from_slice(&n.to_le_bytes());
            }
            for channel in 0..3 {
                fragment.push(3);
                fragment.extend((0..4).map(|p| values[p * 3 + channel]));
                fragment.push(0);
            }
            o.put(DataElement::new(
                Tag(0x7fe0, 0x0010),
                VR::OB,
                Value::PixelSequence(PixelFragmentSequence::new(vec![0], vec![fragment])),
            ));
        } else {
            let values = if planar {
                (0..3)
                    .flat_map(|c| (0..4).map(move |p| values[p * 3 + c]))
                    .collect()
            } else {
                values.to_vec()
            };
            o.put(DataElement::new(
                Tag(0x7fe0, 0x0010),
                VR::OB,
                PrimitiveValue::U8(values.into()),
            ));
        }
        o.with_meta(FileMetaTableBuilder::new().transfer_syntax(if rle {
            "1.2.840.10008.1.2.5"
        } else {
            "1.2.840.10008.1.2.1"
        }))
        .unwrap()
    }

    #[test]
    fn source_colors_match_independent_reference_across_rle_and_planar_layouts() {
        let directory = crate::test_dir::tempdir().unwrap();
        for photometric in ["RGB", "YBR_FULL"] {
            for planar in [false, true] {
                for rle in [false, true] {
                    let path = directory.path().join("color.dcm");
                    object(photometric, planar, rle)
                        .write_to_file(&path)
                        .unwrap();
                    let imported =
                        crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
                    let source = &imported.sources[0];
                    assert_eq!(crate::decode::decode_frame(source, 0).unwrap().bytes(), RGB);
                    assert_eq!(crate::decode::decode_volume(source).unwrap().bytes(), RGB);
                }
            }
        }
    }

    #[test]
    fn color_jpeg_reserves_component_threads_in_the_frame_budget() {
        let directory = crate::test_dir::tempdir().unwrap();
        let mut image = object("RGB", false, false);
        for tag in [Tag(0x0028, 0x0010), Tag(0x0028, 0x0011)] {
            image.put(DataElement::new(tag, VR::US, PrimitiveValue::from(256u16)));
        }
        image.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OB,
            PrimitiveValue::U8(RGB.repeat(256 * 256 / 4).into()),
        ));
        let mut costs = Vec::new();
        for name in ["native", "jpeg"] {
            if name == "jpeg" {
                image
                    .transcode(&dicom_transfer_syntax_registry::entries::JPEG_BASELINE.erased())
                    .unwrap();
            }
            let path = directory.path().join(format!("{name}.dcm"));
            image.write_to_file(&path).unwrap();
            let imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
            let source = &imported.sources[0];
            costs.push(source.frames[0].jpeg_component_threads);
            let frame = crate::decode::decode_frame(source, 0).unwrap();
            assert_eq!(frame.bytes().len(), 256 * 256 * 3);
            assert_eq!(
                crate::decode::decode_volume(source).unwrap().bytes(),
                frame.bytes()
            );
        }
        assert_eq!(costs, [0, 3]);
        assert_eq!(crate::decode::frame_workers(8, costs.iter().copied()), 2);
        assert_eq!(crate::decode::frame_workers(1, costs.into_iter()), 1);
    }

    #[test]
    fn rle_export_retains_original_ybr_components_and_labels_them_correctly() {
        let directory = crate::test_dir::tempdir().unwrap();
        let destination = crate::test_dir::tempdir().unwrap();
        let path = directory.path().join("color.dcm");
        object("YBR_FULL", true, true).write_to_file(&path).unwrap();
        let result = crate::export::export_series(
            &[path],
            &crate::export::ExportOptions {
                operation: None,
                cancelled: None,
                directory: destination.path().to_string_lossy().into_owned(),
                anonymize: false,
                dicomdir: false,
                decompress: true,
                root: false,
                full: false,
                zip: false,
                smallest: false,
            },
        )
        .unwrap();
        let exported =
            dicom_object::open_file(std::path::Path::new(&result.directory).join("DICOM/IM000001"))
                .unwrap();
        assert_eq!(exported.meta().transfer_syntax(), "1.2.840.10008.1.2.1");
        assert_eq!(
            exported.get(Tag(0x0028, 0x0004)).unwrap().to_str().unwrap(),
            "YBR_FULL"
        );
        assert_eq!(
            exported
                .get(Tag(0x0028, 0x0006))
                .unwrap()
                .to_int::<u16>()
                .unwrap(),
            0
        );
        let decoded = exported.decode_pixel_data().unwrap();
        assert_eq!(decoded.data(), YBR);
        assert_eq!(rgb_frame(&exported, &decoded, 0, 0).unwrap(), RGB);
    }

    #[test]
    fn multiframe_ybr_keeps_frame_order_and_channels() {
        let mut o = object("YBR_FULL", false, false);
        o.put_str(Tag(0x0028, 0x0008), VR::IS, "2");
        let mut pixels = YBR.to_vec();
        pixels.extend(YBR.as_chunks::<3>().0.iter().rev().flatten());
        o.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OB,
            PrimitiveValue::U8(pixels.into()),
        ));
        let decoded = o.decode_pixel_data().unwrap();
        assert_eq!(rgb_frame(&o, &decoded, 0, 0).unwrap(), RGB);
        assert_eq!(
            rgb_frame(&o, &decoded, 1, 1).unwrap(),
            RGB.as_chunks::<3>()
                .0
                .iter()
                .rev()
                .flatten()
                .copied()
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn sixteen_bit_ybr_uses_unsigned_midpoint_and_stored_precision() {
        let mut o = object("YBR_FULL", false, false);
        for bits in [12u16, 16] {
            for (tag, n) in [
                (Tag(0x0028, 0x0100), 16),
                (Tag(0x0028, 0x0101), bits),
                (Tag(0x0028, 0x0102), bits - 1),
            ] {
                o.put(DataElement::new(tag, VR::US, PrimitiveValue::from(n)));
            }
            let midpoint = 1u16 << (bits - 1);
            let maximum = ((1u32 << bits) - 1) as u16;
            let values = vec![
                0, midpoint, midpoint, maximum, midpoint, midpoint, midpoint, midpoint, midpoint,
                midpoint, 0, midpoint,
            ];
            o.put(DataElement::new(
                Tag(0x7fe0, 0x0010),
                VR::OW,
                PrimitiveValue::U16(values.into()),
            ));
            let decoded = o.decode_pixel_data().unwrap();
            let rgb = rgb_frame(&o, &decoded, 0, 0).unwrap();
            assert_eq!(&rgb[..9], [0, 0, 0, 255, 255, 255, 128, 128, 128]);
            assert!(rgb[10] > 128 && rgb[11] == 0);
        }
    }

    #[test]
    fn eight_bit_color_in_sixteen_bit_words_masks_unused_bits() {
        for photometric in ["RGB", "YBR_FULL"] {
            let mut o = object(photometric, false, false);
            o.put(DataElement::new(
                Tag(0x0028, 0x0100),
                VR::US,
                PrimitiveValue::from(16u16),
            ));
            let stored = if photometric == "RGB" { RGB } else { YBR };
            let values = stored
                .into_iter()
                .map(|v| u16::from(v) | 0xa500)
                .collect::<Vec<_>>();
            o.put(DataElement::new(
                Tag(0x7fe0, 0x0010),
                VR::OW,
                PrimitiveValue::U16(values.into()),
            ));
            let decoded = o.decode_pixel_data().unwrap();
            assert_eq!(rgb_frame(&o, &decoded, 0, 0).unwrap(), RGB);
        }
    }
}
