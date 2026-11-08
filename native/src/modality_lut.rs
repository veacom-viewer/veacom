use anyhow::{Context, Result, ensure};
use dicom_core::{PrimitiveValue, Tag, value::Value};
use dicom_object::InMemDicomObject;
use std::borrow::Cow;

#[derive(Debug)]
pub struct Descriptor {
    pub count: usize,
    pub first: i64,
    pub bits: u16,
    pub unit: String,
}

pub struct Lut<'a> {
    pub descriptor: Descriptor,
    values: Cow<'a, [u16]>,
}
impl Lut<'_> {
    pub fn value(&self, stored: i64) -> f64 {
        let index = stored
            .saturating_sub(self.descriptor.first)
            .clamp(0, self.descriptor.count as i64 - 1) as usize;
        f64::from(self.values[index])
    }
}

fn single(object: &InMemDicomObject, tag: Tag) -> Result<Option<&InMemDicomObject>> {
    let Some(element) = object.get(tag) else {
        return Ok(None);
    };
    let items = element
        .items()
        .context("Functional-group transformation is not a sequence")?;
    ensure!(
        items.len() == 1,
        "Shared functional groups and pixel transformations require exactly one item"
    );
    Ok(items.first())
}

fn item(object: &InMemDicomObject, frame: usize) -> Result<Option<&InMemDicomObject>> {
    let per_frame = if let Some(element) = object.get(Tag(0x5200, 0x9230)) {
        let items = element
            .items()
            .context("Per-frame functional groups are not a sequence")?;
        Some(
            items
                .get(frame)
                .context("Missing per-frame functional group")?,
        )
    } else {
        None
    };
    let shared = single(object, Tag(0x5200, 0x9229))?;
    let places = [
        per_frame
            .map(|v| single(v, Tag(0x0028, 0x9145)))
            .transpose()?
            .flatten(),
        per_frame,
        shared
            .map(|v| single(v, Tag(0x0028, 0x9145)))
            .transpose()?
            .flatten(),
        shared,
        Some(object),
    ];
    for place in places.into_iter().flatten() {
        if let Some(sequence) = place.get(Tag(0x0028, 0x3000)) {
            ensure!(
                place.get(Tag(0x0028, 0x1052)).is_none()
                    && place.get(Tag(0x0028, 0x1053)).is_none(),
                "Modality LUT and rescale cannot coexist in the same transformation"
            );
            let items = sequence
                .items()
                .context("Modality LUT Sequence is not a sequence")?;
            ensure!(
                items.len() == 1,
                "Modality LUT Sequence must contain exactly one item"
            );
            return Ok(items.first());
        }
        if place.get(Tag(0x0028, 0x1052)).is_some() || place.get(Tag(0x0028, 0x1053)).is_some() {
            return Ok(None);
        }
    }
    Ok(None)
}

fn describe(object: &InMemDicomObject, item: &InMemDicomObject) -> Result<Descriptor> {
    let descriptor = item
        .get(Tag(0x0028, 0x3002))
        .context("Missing Modality LUT Descriptor")?;
    ensure!(
        descriptor.value().multiplicity() == 3,
        "Modality LUT Descriptor must contain three values"
    );
    let values = descriptor.to_multi_int::<i64>()?;
    ensure!(
        values.len() == 3,
        "Modality LUT Descriptor must contain three values"
    );
    ensure!(
        values.iter().all(|&v| (-32768..=65535).contains(&v)),
        "Modality LUT Descriptor exceeds its 16-bit representation"
    );
    let count = values[0] as u16;
    let signed = object
        .get(Tag(0x0028, 0x0103))
        .context("Missing PixelRepresentation for Modality LUT")?
        .to_int::<u16>()?;
    ensure!(
        signed <= 1,
        "Invalid Modality LUT source PixelRepresentation"
    );
    let first = if signed == 1 {
        values[1] as i16 as i64
    } else {
        values[1] as u16 as i64
    };
    let bits = values[2] as u16;
    ensure!(
        matches!(bits, 8 | 16),
        "Modality LUT entries must have 8 or 16 bits"
    );
    let type_element = item
        .get(Tag(0x0028, 0x3004))
        .context("Missing Modality LUT Type")?;
    ensure!(
        type_element.value().multiplicity() == 1,
        "Modality LUT Type must contain one unit code"
    );
    let unit_value = type_element.to_str()?;
    let unit = unit_value.trim_end_matches([' ', '\0']);
    ensure!(
        !unit.is_empty() && unit.len() <= 64,
        "Modality LUT Type is empty or exceeds64characters"
    );
    Ok(Descriptor {
        count: if count == 0 { 65536 } else { count as usize },
        first,
        bits,
        unit: unit.to_owned(),
    })
}

/// The VOI LUT for a frame (PS3.3 C.11.2, C.7.6.16.2.10): the first item of a VOI LUT Sequence in
/// the frame's own Frame VOI LUT functional group, the shared one, or at the top level. A table
/// that cannot be read is ignored, as if absent.
pub fn voi_lut(object: &InMemDicomObject, frame: usize, little_endian: bool) -> Option<crate::model::VoiLut> {
    let group = |sequence: Tag, index: usize| {
        object
            .get(sequence)?
            .items()?
            .get(index)?
            .get(Tag(0x0028, 0x9132))?
            .items()?
            .first()
    };
    let places = [group(Tag(0x5200, 0x9230), frame), group(Tag(0x5200, 0x9229), 0), Some(object)];
    let item = places
        .into_iter()
        .flatten()
        .find_map(|place| place.get(Tag(0x0028, 0x3010))?.items()?.first())?;
    voi_item(object, item, little_endian).ok()
}

fn voi_item(object: &InMemDicomObject, item: &InMemDicomObject, little_endian: bool) -> Result<crate::model::VoiLut> {
    let element = item.get(Tag(0x0028, 0x3002)).context("Missing VOI LUT Descriptor")?;
    let values = element.to_multi_int::<i64>()?;
    ensure!(values.len() == 3, "VOI LUT Descriptor must contain three values");
    let count = match values[0] as u16 { 0 => 65536, n => n as usize };
    // The first input value mapped is signed when stored as SS, or as US for signed pixels.
    let signed = object.get(Tag(0x0028, 0x0103)).and_then(|v| v.to_int::<u16>().ok()) == Some(1);
    let first = if element.vr() == dicom_core::VR::US && signed { values[1] as u16 as i16 as i64 } else { values[1] };
    let bits = u16::try_from(values[2])?;
    ensure!((8..=16).contains(&bits), "VOI LUT entries must have 8 to 16 bits");
    let descriptor = Descriptor { count, first, bits: if bits <= 8 { 8 } else { 16 }, unit: String::new() };
    let Value::Primitive(data) = item.get(Tag(0x0028, 0x3006)).context("Missing VOI LUT Data")?.value() else {
        anyhow::bail!("VOI LUT Data is not primitive")
    };
    let entries: Vec<u16> = match data {
        PrimitiveValue::U16(words) if words.len() == count => words.to_vec(),
        PrimitiveValue::U8(bytes) => decode_bytes(bytes, &descriptor, little_endian)?.into_owned(),
        PrimitiveValue::U16(words) if descriptor.bits == 8 && words.len() * 2 == count + count % 2 => {
            let bytes: Vec<_> = words.iter().flat_map(|v| v.to_le_bytes()).collect();
            decode_bytes(&bytes, &descriptor, true)?.into_owned()
        }
        _ => anyhow::bail!("VOI LUT Data length or representation differs from descriptor"),
    };
    let top = (1u32 << bits) - 1;
    Ok(crate::model::VoiLut {
        first,
        bits,
        data: entries.into_iter().map(|v| u32::from(v).min(top) as u16).collect(),
        explanation: item
            .get(Tag(0x0028, 0x3003))
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim_end_matches([' ', '\0']).chars().take(64).collect())
            .unwrap_or_default(),
    })
}

/// A linear window spanning where a VOI LUT rises from 1% to 99% of its output range, for
/// manual window changes that start from the file's own display. Returns (center, width).
pub fn voi_window(lut: &crate::model::VoiLut) -> (f64, f64) {
    let (low, high) = lut.data.iter().fold((u16::MAX, 0), |(a, b), &v| (a.min(v), b.max(v)));
    let span = f64::from(high.saturating_sub(low));
    let crossing = |fraction: f64| {
        lut.data
            .iter()
            .position(|&v| f64::from(v.saturating_sub(low)) > span * fraction)
            .unwrap_or(0)
    };
    let (mut start, mut end) = (crossing(0.01), crossing(0.99));
    // A falling or flat table has no rising span: its whole input range stands in.
    if span == 0. || lut.data.first() > lut.data.last() || end < start {
        (start, end) = (0, lut.data.len() - 1);
    }
    let lower = lut.first as f64 + start as f64;
    let width = (end - start + 1) as f64;
    (lower + width / 2., width)
}

pub fn descriptor(object: &InMemDicomObject, frame: usize) -> Result<Option<Descriptor>> {
    item(object, frame)?
        .map(|item| describe(object, item))
        .transpose()
}

pub fn read(
    object: &InMemDicomObject,
    frame: usize,
    little_endian: bool,
) -> Result<Option<Lut<'_>>> {
    let Some(item) = item(object, frame)? else {
        return Ok(None);
    };
    let descriptor = describe(object, item)?;
    let element = item
        .get(Tag(0x0028, 0x3006))
        .context("Missing Modality LUT Data")?;
    let Value::Primitive(data) = element.value() else {
        anyhow::bail!("Modality LUT Data is not primitive")
    };
    let count = descriptor.count;
    let values = match data {
        PrimitiveValue::U16(words)
            if words.len() == count
                && (descriptor.bits == 16 || words.iter().all(|&v| v <= 255)) =>
        {
            Cow::Borrowed(words.as_slice())
        }
        PrimitiveValue::U8(bytes) => decode_bytes(bytes, &descriptor, little_endian)?,
        // Packed 8-bit entries: entry 2k is the low-order byte of word k, as with 8-bit
        // pixels in OW (PS3.3 C.11.1.1, "equivalent to 8 bits allocated"). The words are
        // already values here, so that holds whichever byte order the file used.
        PrimitiveValue::U16(words)
            if descriptor.bits == 8 && words.len() * 2 == count + count % 2 =>
        {
            let bytes: Vec<_> = words.iter().flat_map(|v| v.to_le_bytes()).collect();
            Cow::Owned(decode_bytes(&bytes, &descriptor, true)?.into_owned())
        }
        _ => anyhow::bail!("Modality LUT Data length or representation differs from descriptor"),
    };
    ensure!(
        descriptor.bits == 16 || values.iter().all(|&v| v <= 255),
        "8-bit Modality LUT contains nonzero high bits"
    );
    Ok(Some(Lut { descriptor, values }))
}

fn decode_bytes<'a>(
    bytes: &'a [u8],
    descriptor: &Descriptor,
    little_endian: bool,
) -> Result<Cow<'a, [u16]>> {
    let count = descriptor.count;
    if descriptor.bits == 8 {
        // Raw OW bytes from a big-endian file hold each word high byte first: swap them so
        // that entry 2k, the word's low-order byte, comes first.
        let ordered: Cow<[u8]> = if little_endian || bytes.len() % 2 == 1 {
            Cow::Borrowed(bytes)
        } else {
            Cow::Owned(bytes.as_chunks::<2>().0.iter().flat_map(|v| [v[1], v[0]]).collect())
        };
        if ordered.len() == count
            || (count % 2 == 1 && ordered.len() == count + 1 && ordered.last() == Some(&0))
        {
            return Ok(Cow::Owned(
                ordered[..count].iter().map(|&n| u16::from(n)).collect(),
            ));
        }
    }
    ensure!(
        bytes.len() == count * 2,
        "Modality LUT Data length differs from descriptor"
    );
    Ok(Cow::Owned(
        bytes
            .as_chunks::<2>().0.iter()
            .map(|v| {
                if little_endian {
                    u16::from_le_bytes([v[0], v[1]])
                } else {
                    u16::from_be_bytes([v[0], v[1]])
                }
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{DataElement, Length, VR};

    fn object(
        count: u16,
        first: u16,
        bits: u16,
        signed: bool,
        data: PrimitiveValue,
    ) -> InMemDicomObject {
        let mut item = InMemDicomObject::new_empty();
        item.put(DataElement::new(
            Tag(0x0028, 0x3002),
            VR::US,
            PrimitiveValue::U16(vec![count, first, bits].into()),
        ));
        item.put_str(Tag(0x0028, 0x3004), VR::LO, "HU");
        item.put(DataElement::new(Tag(0x0028, 0x3006), VR::OW, data));
        let mut object = InMemDicomObject::new_empty();
        object.put(DataElement::new(
            Tag(0x0028, 0x0103),
            VR::US,
            PrimitiveValue::from(u16::from(signed)),
        ));
        object.put(DataElement::new(
            Tag(0x0028, 0x3000),
            VR::SQ,
            Value::new_sequence(vec![item], Length::UNDEFINED),
        ));
        object
    }

    #[test]
    fn signed_first_entry_and_both_clamps_preserve_nonlinear_values() {
        let object = object(
            4,
            (-2i16) as u16,
            16,
            true,
            PrimitiveValue::U16(vec![10, 500, 42, 99].into()),
        );
        let lut = read(&object, 0, true).unwrap().unwrap();
        assert_eq!(
            [-10, -2, -1, 0, 1, 10].map(|v| lut.value(v)),
            [10., 10., 500., 42., 99., 99.]
        );
        assert_eq!(lut.descriptor.unit, "HU");
    }

    #[test]
    fn zero_count_means_65536_even_for_signed_descriptors() {
        let object = object(
            0,
            32768,
            16,
            true,
            PrimitiveValue::U16((0..=65535u16).collect()),
        );
        let lut = read(&object, 0, true).unwrap().unwrap();
        assert_eq!(lut.descriptor.count, 65536);
        assert_eq!(
            [-32769, -32768, -1, 32767, 32768].map(|v| lut.value(v)),
            [0., 0., 32767., 65535., 65535.]
        );
        assert!(matches!(lut.values, Cow::Borrowed(_)));
    }

    #[test]
    fn packed_and_word_eight_bit_data_handle_big_endian_and_odd_padding() {
        // Words are values: entry 2k is the low-order byte, in either byte order.
        for (data, le) in [
            (PrimitiveValue::U16(vec![0x140a, 0x001e].into()), true),
            (PrimitiveValue::U16(vec![0x140a, 0x001e].into()), false),
            // Raw OW bytes as they lie in the file.
            (PrimitiveValue::U8(vec![10, 20, 30, 0].into()), true),
            (PrimitiveValue::U8(vec![20, 10, 0, 30].into()), false),
            // One entry per word.
            (PrimitiveValue::U16(vec![10, 20, 30].into()), false),
        ] {
            let object = object(3, 0, 8, false, data);
            let lut = read(&object, 0, le).unwrap().unwrap();
            assert_eq!((0..3).map(|v| lut.value(v)).collect::<Vec<_>>(), [10., 20., 30.]);
        }
        let padded = object(1, 0, 8, false, PrimitiveValue::U16(vec![0x0080].into()));
        assert_eq!(read(&padded, 0, false).unwrap().unwrap().value(0), 128.);
        // A nonzero padding byte (the high byte of the last word) is malformed.
        let malformed = object(1, 0, 8, false, PrimitiveValue::U16(vec![0x8000].into()));
        assert!(read(&malformed, 0, false).is_err());
    }

    #[test]
    fn contradictory_or_malformed_tables_are_rejected() {
        let mut source = object(2, 0, 16, false, PrimitiveValue::U16(vec![10, 20].into()));
        source.put_str(Tag(0x0028, 0x1052), VR::DS, "0");
        assert!(read(&source, 0, true).is_err());
        let malformed = object(2, 0, 16, false, PrimitiveValue::U16(vec![10].into()));
        assert!(read(&malformed, 0, true).is_err());
        source.remove_element(Tag(0x0028, 0x1052));
        let mut group = InMemDicomObject::new_empty();
        group.put(DataElement::new(
            Tag(0x0028, 0x9145),
            VR::SQ,
            Value::new_sequence(
                vec![InMemDicomObject::new_empty(), InMemDicomObject::new_empty()],
                Length::UNDEFINED,
            ),
        ));
        source.put(DataElement::new(
            Tag(0x5200, 0x9229),
            VR::SQ,
            Value::new_sequence(vec![group], Length::UNDEFINED),
        ));
        assert!(read(&source, 0, true).is_err());
    }
}
