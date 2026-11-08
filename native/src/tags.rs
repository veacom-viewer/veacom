use anyhow::{Context, Result};
use dicom_core::{
    Tag, VR,
    dictionary::{DataDictionary, DataDictionaryEntry},
    header::{HasLength, Header},
};
use dicom_dictionary_std::StandardDataDictionary;
use dicom_object::{InMemDicomObject, OpenFileOptions};
use serde::Serialize;
use std::path::Path;

const MAX_ENTRIES: usize = 10_000;
const MAX_DEPTH: usize = 12;
const MAX_VALUE_CHARS: usize = 1_024;

#[derive(Debug, Serialize)]
pub struct TagEntry {
    pub tag: String,
    pub name: String,
    pub vr: String,
    pub value: String,
}

#[cfg(test)]
fn read_tags(path: &Path) -> Result<Vec<TagEntry>> {
    let (_, file) = crate::input_guard::open_metadata_checked(path)?;
    read_source_tags(file, path)
}

pub fn read_source_tags(file: impl std::io::Read, path: &Path) -> Result<Vec<TagEntry>> {
    // Stops before integer, float, or double-float pixel data without decoding it.
    let obj = OpenFileOptions::new()
        .read_until(Tag(0x7FE0, 0x0000))
        .from_reader(file)
        .with_context(|| format!("Cannot read DICOM metadata from {}", path.display()))?;
    let mut entries = Vec::new();
    for element in obj.meta().to_element_iter() {
        let display = if binary_vr(element.vr()) {
            format!("[binary: {} bytes]", element.length().0)
        } else {
            element
                .to_str()
                .map(|v| bounded(&v))
                .unwrap_or_else(|_| "[unprintable value]".into())
        };
        entries.push(entry(element.tag(), "", element.vr(), display));
    }
    append_dataset(&obj, "", 0, &mut entries);
    if entries.len() >= MAX_ENTRIES {
        entries.push(TagEntry {
            tag: String::new(),
            name: "Display limit reached".into(),
            vr: String::new(),
            value: format!("Showing the first {MAX_ENTRIES} metadata entries"),
        });
    }
    Ok(entries)
}

fn append_dataset(obj: &InMemDicomObject, prefix: &str, depth: usize, entries: &mut Vec<TagEntry>) {
    for element in obj.iter() {
        if entries.len() >= MAX_ENTRIES {
            return;
        }
        let tag = element.tag();
        if tag.0 == 0x7FE0 {
            continue;
        }
        if let Some(items) = element.items() {
            let value = if depth >= MAX_DEPTH {
                format!("{} item(s); nesting limit reached", items.len())
            } else {
                format!("{} item(s)", items.len())
            };
            entries.push(entry(tag, prefix, element.vr(), value));
            if depth < MAX_DEPTH {
                for (index, item) in items.iter().enumerate() {
                    if entries.len() >= MAX_ENTRIES {
                        return;
                    }
                    append_dataset(
                        item,
                        &format!("{prefix}({:04X},{:04X})[{}]/", tag.0, tag.1, index + 1),
                        depth + 1,
                        entries,
                    );
                }
            }
        } else {
            let display = if binary_vr(element.vr()) {
                format!("[binary: {} bytes]", element.length().0)
            } else if element.length().0 > 65_536 {
                format!("[large value: {} bytes]", element.length().0)
            } else {
                element
                    .to_str()
                    .map(|v| bounded(&v))
                    .unwrap_or_else(|_| "[unprintable value]".into())
            };
            entries.push(entry(tag, prefix, element.vr(), display));
        }
    }
}

fn entry(tag: Tag, prefix: &str, vr: VR, value: String) -> TagEntry {
    TagEntry {
        tag: format!("{prefix}({:04X},{:04X})", tag.0, tag.1),
        name: StandardDataDictionary
            .by_tag(tag)
            .map(|e| e.alias().to_string())
            .unwrap_or_else(|| {
                if tag.0 % 2 == 1 {
                    "Private tag".into()
                } else {
                    "Unknown tag".into()
                }
            }),
        vr: vr.to_string().to_string(),
        value,
    }
}

fn binary_vr(vr: VR) -> bool {
    matches!(
        vr,
        VR::OB | VR::OW | VR::OD | VR::OF | VR::OL | VR::OV | VR::UN
    )
}

fn bounded(text: &str) -> String {
    let mut chars = text.chars();
    let mut value: String = chars
        .by_ref()
        .take(MAX_VALUE_CHARS)
        .map(|ch| {
            if ch.is_control() && ch != '\n' && ch != '\t' {
                '�'
            } else {
                ch
            }
        })
        .collect();
    if chars.next().is_some() {
        value.push('…');
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{DataElement, Length, PrimitiveValue, value::DataSetSequence};
    use dicom_object::FileMetaTableBuilder;

    #[test]
    fn reads_nested_metadata_without_reading_truncated_pixel_payload() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("header.dcm");
        let mut obj = InMemDicomObject::new_empty();
        obj.put_str(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.2");
        obj.put_str(Tag(0x0008, 0x0018), VR::UI, "2.25.123");
        obj.put_str(Tag(0x0010, 0x0010), VR::PN, "TEST^PERSON");
        let mut item = InMemDicomObject::new_empty();
        item.put_str(Tag(0x0008, 0x1155), VR::UI, "2.25.456");
        obj.put(DataElement::new(
            Tag(0x0008, 0x1115),
            VR::SQ,
            DataSetSequence::new(vec![item], Length::UNDEFINED),
        ));
        obj.put(DataElement::new(
            Tag(0x7FE0, 0x0010),
            VR::OW,
            PrimitiveValue::U16(vec![0u16; 512].into()),
        ));
        obj.with_meta(FileMetaTableBuilder::new().transfer_syntax("1.2.840.10008.1.2.1"))
            .unwrap()
            .write_to_file(&path)
            .unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(file.metadata().unwrap().len() - 1_024)
            .unwrap();
        let entries = read_tags(&path).unwrap();
        assert!(
            entries
                .iter()
                .any(|e| e.tag == "(0002,0010)" && e.value == "1.2.840.10008.1.2.1")
        );
        assert!(
            entries
                .iter()
                .any(|e| e.name == "PatientName" && e.value == "TEST^PERSON")
        );
        assert!(
            entries
                .iter()
                .any(|e| e.tag == "(0008,1115)[1]/(0008,1155)" && e.value == "2.25.456")
        );
        assert!(!entries.iter().any(|e| e.tag.contains("7FE0")));
    }

    #[test]
    fn limits_unicode_values_without_splitting_characters() {
        let long = "İ".repeat(2_000);
        let result = bounded(&long);
        assert_eq!(result.chars().count(), MAX_VALUE_CHARS + 1);
        assert!(result.ends_with('…'));
        assert_eq!(bounded("a\0b"), "a�b");
    }
}
