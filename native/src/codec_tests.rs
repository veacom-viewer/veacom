use dicom_core::{DataElement, PrimitiveValue, Tag, VR};
use dicom_object::{FileMetaTableBuilder, InMemDicomObject};
use dicom_pixeldata::Transcode;

#[test]
fn jpeg_ls_lossless_preserves_stored_values_and_physical_rescale() {
    let directory = crate::test_dir::tempdir().unwrap();
    let path = directory.path().join("jls.dcm");
    let mut object = InMemDicomObject::new_empty();
    for (tag, vr, value) in [
        (Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.2"),
        (Tag(0x0008, 0x0018), VR::UI, "2.25.101"),
        (Tag(0x0020, 0x000d), VR::UI, "2.25.102"),
        (Tag(0x0020, 0x000e), VR::UI, "2.25.103"),
        (Tag(0x0008, 0x0060), VR::CS, "CT"),
        (Tag(0x0028, 0x0004), VR::CS, "MONOCHROME2"),
        (Tag(0x0028, 0x1053), VR::DS, "1"),
        (Tag(0x0028, 0x1052), VR::DS, "-1024"),
    ] {
        object.put_str(tag, vr, value);
    }
    for (tag, value) in [
        (Tag(0x0028, 0x0010), 2),
        (Tag(0x0028, 0x0011), 3),
        (Tag(0x0028, 0x0002), 1),
        (Tag(0x0028, 0x0100), 16),
        (Tag(0x0028, 0x0101), 12),
        (Tag(0x0028, 0x0102), 11),
        (Tag(0x0028, 0x0103), 0),
    ] {
        object.put(DataElement::new(
            tag,
            VR::US,
            PrimitiveValue::from(value as u16),
        ));
    }
    object.put(DataElement::new(
        Tag(0x7fe0, 0x0010),
        VR::OW,
        PrimitiveValue::U16(vec![0, 1, 4095, 1024, 500, 2000].into()),
    ));
    let mut object = object
        .with_meta(FileMetaTableBuilder::new().transfer_syntax("1.2.840.10008.1.2.1"))
        .unwrap();
    object
        .transcode(
            &dicom_transfer_syntax_registry::entries::JPEG_LS_LOSSLESS_IMAGE_COMPRESSION.erased(),
        )
        .unwrap();
    assert_eq!(object.meta().transfer_syntax(), "1.2.840.10008.1.2.4.80");
    object.write_to_file(&path).unwrap();
    let imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
    for buffer in [
        crate::decode::decode_frame(&imported.sources[0], 0).unwrap(),
        crate::decode::decode_volume(&imported.sources[0]).unwrap(),
    ] {
        assert_eq!(
            (0..buffer.len())
                .map(|i| buffer.value(i))
                .collect::<Vec<_>>(),
            [-1024., -1023., 3071., 0., -524., 976.]
        );
    }
}
