use crate::model::{Frame, PixelBuffer, SourceSeries};
use anyhow::{Context, Result, bail};
use dicom_pixeldata::{DecodedPixelData, PixelDecoder};
use std::{collections::HashMap, path::Path};

/// In WebAssembly everything shares 4 GB, so a decoded volume may take a quarter of it there.
const MAX_VOLUME_BYTES: usize = if cfg!(target_arch = "wasm32") { 1024 * 1024 * 1024 } else { 2 * 1024 * 1024 * 1024 };
const VOLUME_LIMIT: &str = if cfg!(target_arch = "wasm32") { "1 GiB" } else { "2 GiB" };
const MAX_FRAME_SAMPLES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
struct TypeDoesNotFit;
impl std::fmt::Display for TypeDoesNotFit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Physical pixel values need floating point storage")
    }
}
impl std::error::Error for TypeDoesNotFit {}

#[derive(Debug)]
struct Float64Required;
impl std::fmt::Display for Float64Required {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Physical pixels require float64 precision")
    }
}
impl std::error::Error for Float64Required {}

struct FrameValues {
    values: Vec<f64>,
    preserve_precision: bool,
    allow_ieee: bool,
}
impl From<Vec<f64>> for FrameValues {
    fn from(values: Vec<f64>) -> Self {
        Self {
            values,
            preserve_precision: false,
            allow_ieee: false,
        }
    }
}

trait Sample: Default + Clone + Send + Sync {
    const IS_FLOAT32: bool = false;
    fn from_value(value: f64) -> Result<Self>;
    fn from_ieee(_value: f64) -> Result<Self> {
        Err(TypeDoesNotFit.into())
    }
}
macro_rules! integer_sample {
    ($kind:ty) => {
        impl Sample for $kind {
            fn from_value(value: f64) -> Result<Self> {
                if !value.is_finite() {
                    bail!("Pixel rescale produced a non-finite value");
                }
                if value.fract() != 0. || value < <$kind>::MIN as f64 || value > <$kind>::MAX as f64
                {
                    return Err(TypeDoesNotFit.into());
                }
                Ok(value as $kind)
            }
        }
    };
}
integer_sample!(i16);
integer_sample!(u16);
integer_sample!(u8);
impl Sample for f32 {
    const IS_FLOAT32: bool = true;
    fn from_value(value: f64) -> Result<Self> {
        let result = value as f32;
        if !result.is_finite() {
            bail!("Pixel rescale exceeds the finite float32 range");
        }
        Ok(result)
    }
    fn from_ieee(value: f64) -> Result<Self> {
        Ok(value as f32)
    }
}
impl Sample for f64 {
    fn from_value(value: f64) -> Result<Self> {
        if !value.is_finite() {
            bail!("Pixel rescale produced a non-finite value");
        }
        Ok(value)
    }
    fn from_ieee(value: f64) -> Result<Self> {
        Ok(value)
    }
}

fn frame_samples(source: &SourceSeries) -> Result<usize> {
    let n = source.info.dimensions[0]
        .checked_mul(source.info.dimensions[1])
        .and_then(|n| n.checked_mul(source.info.components as usize))
        .context("Image dimensions overflow")?;
    if n == 0 || n > MAX_FRAME_SAMPLES {
        bail!("Frame exceeds the supported 64 million sample limit");
    }
    Ok(n)
}

fn validate_decoded(source: &SourceSeries, decoded: &DecodedPixelData<'_>) -> Result<()> {
    if decoded.columns() as usize != source.info.dimensions[0]
        || decoded.rows() as usize != source.info.dimensions[1]
        || decoded.samples_per_pixel() as u8 != source.info.components
    {
        bail!("Decoded frame dimensions or components differ from the imported series");
    }
    // A palette label map's indices are its segment numbers; the palette only suggests colours.
    let label_map = source.info.segmentation.is_some() && source.info.photometric_interpretation == "PALETTE COLOR";
    if source.info.components == 1
        && !label_map
        && !matches!(
            source.info.photometric_interpretation.as_str(),
            "MONOCHROME1" | "MONOCHROME2"
        )
    {
        bail!(
            "Unsupported scalar photometric interpretation: {}",
            source.info.photometric_interpretation
        );
    }
    Ok(())
}

fn check_object(object: &dicom_object::DefaultDicomObject, full_volume: bool) -> Result<()> {
    use dicom_core::Tag;
    if full_volume {
        let attr = |tag: Tag, default: u64| {
            object
                .element(tag)
                .ok()
                .and_then(|e| e.to_int::<u64>().ok())
                .unwrap_or(default)
        };
        let mut bytes = attr(Tag(0x0028, 0x0100), 16).div_ceil(8);
        for factor in [
            attr(Tag(0x0028, 0x0010), 0),
            attr(Tag(0x0028, 0x0011), 0),
            attr(Tag(0x0028, 0x0002), 1),
            attr(Tag(0x0028, 0x0008), 1),
        ] {
            bytes = bytes
                .checked_mul(factor)
                .context("Decoded DICOM dimensions overflow")?;
        }
        if bytes > MAX_VOLUME_BYTES as u64 {
            bail!("Multiframe DICOM exceeds the {VOLUME_LIMIT} decoded source limit");
        }
    }
    Ok(())
}

fn decode_rle32(fragment: &[u8], pixels: usize) -> Result<Vec<u32>> {
    if pixels == 0 || pixels > MAX_FRAME_SAMPLES {
        bail!("Invalid RLE32 frame dimensions");
    }
    if fragment.len() < 64 || fragment.len() % 2 != 0 {
        bail!("Invalid RLE32 frame header or padding");
    }
    let word = |index: usize| {
        u32::from_le_bytes(fragment[index * 4..index * 4 + 4].try_into().unwrap()) as usize
    };
    if word(0) != 4 || fragment[20..64].iter().any(|&b| b != 0) {
        bail!("RLE32 requires exactly four byte segments and zero unused offsets");
    }
    let offsets = [word(1), word(2), word(3), word(4), fragment.len()];
    if offsets[0] != 64
        || offsets
            .windows(2)
            .any(|v| v[0] >= v[1] || v[1] > fragment.len() || v[0] % 2 != 0)
    {
        bail!("Invalid RLE32 segment offsets");
    }
    let mut output = vec![0u32; pixels];
    for segment in 0..4 {
        let encoded = &fragment[offsets[segment]..offsets[segment + 1]];
        let mut cursor = 0;
        let mut written = 0;
        let shift = (3 - segment) * 8;
        while cursor < encoded.len() {
            // An odd-length compressed segment has one trailing zero pad byte.
            if written == pixels && encoded.len() - cursor == 1 && encoded[cursor] == 0 {
                break;
            }
            let control = encoded[cursor] as i8;
            cursor += 1;
            if control == -128 {
                continue;
            }
            let count = if control >= 0 {
                control as usize + 1
            } else {
                (1i16 - i16::from(control)) as usize
            };
            if count > pixels - written {
                bail!("RLE32 segment expands beyond the frame dimensions");
            }
            if control >= 0 {
                let end = cursor
                    .checked_add(count)
                    .context("RLE32 literal length overflow")?;
                let bytes = encoded
                    .get(cursor..end)
                    .context("Truncated RLE32 literal run")?;
                for (target, &byte) in output[written..written + count].iter_mut().zip(bytes) {
                    *target |= u32::from(byte) << shift;
                }
                cursor = end;
            } else {
                let byte = *encoded.get(cursor).context("Truncated RLE32 repeat run")?;
                cursor += 1;
                for target in &mut output[written..written + count] {
                    *target |= u32::from(byte) << shift;
                }
            }
            written += count;
        }
        if written != pixels {
            bail!("RLE32 segment contains fewer pixels than the frame dimensions");
        }
    }
    Ok(output)
}

fn rle32_frame(
    sequence: &dicom_core::value::PixelFragmentSequence<Vec<u8>>,
    frames: usize,
    frame: usize,
    pixels: usize,
) -> Result<Vec<u32>> {
    let fragments = sequence.fragments();
    if fragments.len() != frames {
        bail!("RLE32 requires exactly one fragment per frame");
    }
    let offsets = sequence.offset_table();
    if !offsets.is_empty() {
        if offsets.len() != frames {
            bail!("Invalid RLE32 basic offset table length");
        }
        let mut expected = 0u64;
        for (&offset, fragment) in offsets.iter().zip(fragments) {
            if u64::from(offset) != expected {
                bail!("RLE32 basic offset table does not match frame boundaries");
            }
            expected = expected
                .checked_add(fragment.len() as u64 + 8)
                .context("RLE32 frame offset overflow")?;
        }
    }
    decode_rle32(
        fragments
            .get(frame)
            .context("RLE32 frame index is out of bounds")?,
        pixels,
    )
}

/// Compressed 1-bit frames (binary segmentations, CP-2301) decode to one sample per byte: RLE pads
/// each 1-bit pixel code to a byte (PS3.5 G.2) and JPEG 2000 decodes whole samples. They are read
/// as 8-bit pixels with one stored bit, which the codecs already support.
fn widen_encapsulated_bits(object: &mut dicom_object::DefaultDicomObject) {
    use dicom_core::{DataElement, PrimitiveValue, Tag, VR, value::Value};
    let one_bit = object
        .element(Tag(0x0028, 0x0100))
        .ok()
        .and_then(|e| e.to_int::<u16>().ok())
        == Some(1);
    let encapsulated = object
        .element(Tag(0x7fe0, 0x0010))
        .is_ok_and(|e| matches!(e.value(), Value::PixelSequence(_)));
    if one_bit && encapsulated {
        object.put(DataElement::new(Tag(0x0028, 0x0100), VR::US, PrimitiveValue::from(8u16)));
    }
}

/// One frame of 1-bit pixel data, as a binary segmentation stores its masks: 0 or 1
/// per pixel, least significant bit first, the frames following one another without
/// byte alignment (PS3.5 8.1.1).
fn bit_values(
    source: &SourceSeries,
    object: &dicom_object::DefaultDicomObject,
    frame: &Frame,
) -> Result<FrameValues> {
    use dicom_core::{PrimitiveValue, Tag, value::Value};
    let attribute = |tag: Tag| -> Result<usize> {
        Ok(object.element(tag)?.to_int::<usize>()?)
    };
    let (rows, columns) = (attribute(Tag(0x0028, 0x0010))?, attribute(Tag(0x0028, 0x0011))?);
    if [columns, rows] != [source.info.dimensions[0], source.info.dimensions[1]]
        || attribute(Tag(0x0028, 0x0002))? != 1
        || source.info.components != 1
    {
        bail!("Decoded frame dimensions or components differ from the imported series");
    }
    if object.meta().transfer_syntax().trim_end_matches('\0') == "1.2.840.10008.1.2.2" {
        bail!("1-bit pixel data in big-endian transfer syntax is not supported");
    }
    let frames = object
        .element(Tag(0x0028, 0x0008))
        .ok()
        .map(|e| e.to_int::<usize>())
        .transpose()?
        .unwrap_or(1);
    if frame.index as usize >= frames {
        bail!("Frame index is outside the pixel data");
    }
    // Borrowed as stored: a multiframe mask is read once per frame.
    let bytes: std::borrow::Cow<[u8]> = match object.element(Tag(0x7fe0, 0x0010))?.value() {
        Value::Primitive(PrimitiveValue::U8(bytes)) => std::borrow::Cow::Borrowed(&bytes[..]),
        Value::Primitive(PrimitiveValue::U16(words)) => {
            std::borrow::Cow::Owned(words.iter().flat_map(|word| word.to_le_bytes()).collect())
        }
        Value::PixelSequence(_) => bail!("Encapsulated 1-bit pixel data must be decoded by its codec"),
        _ => bail!("1-bit PixelData has an invalid value representation"),
    };
    let per_frame = frame_samples(source)?;
    let start = per_frame
        .checked_mul(frame.index as usize)
        .context("Frame offset overflow")?;
    let end = start.checked_add(per_frame).context("Frame offset overflow")?;
    if end.div_ceil(8) > bytes.len() {
        bail!("1-bit PixelData is shorter than its frames");
    }
    let values: Vec<f64> = (start..end)
        .map(|bit| f64::from((bytes[bit / 8] >> (bit % 8)) & 1))
        .collect();
    Ok(FrameValues::from(values))
}

fn special_scalar_values(
    source: &SourceSeries,
    object: &dicom_object::DefaultDicomObject,
    frame: &Frame,
) -> Result<Option<FrameValues>> {
    use dicom_core::{PrimitiveValue, Tag, value::Value};
    let float = object.element(Tag(0x7fe0, 0x0008)).ok();
    let double = object.element(Tag(0x7fe0, 0x0009)).ok();
    let allocated = object.element(Tag(0x0028, 0x0100))?.to_int::<u16>()?;
    if allocated == 1 && float.is_none() && double.is_none() {
        return bit_values(source, object, frame).map(Some);
    }
    if float.is_none() && double.is_none() && allocated != 32 {
        return Ok(None);
    }
    if source.info.components != 1
        || !matches!(
            source.info.photometric_interpretation.as_str(),
            "MONOCHROME1" | "MONOCHROME2"
        )
    {
        bail!("32-bit and floating point pixel data require a monochrome scalar image");
    }
    let rows = object.element(Tag(0x0028, 0x0010))?.to_int::<usize>()?;
    let columns = object.element(Tag(0x0028, 0x0011))?.to_int::<usize>()?;
    let components = object.element(Tag(0x0028, 0x0002))?.to_int::<usize>()?;
    if [columns, rows] != [source.info.dimensions[0], source.info.dimensions[1]] || components != 1
    {
        bail!("Decoded frame dimensions or components differ from the imported series");
    }
    let frames = object
        .element(Tag(0x0028, 0x0008))
        .ok()
        .map(|e| e.to_int::<usize>())
        .transpose()?
        .unwrap_or(1);
    if frame.index as usize >= frames {
        bail!("Frame index is outside the pixel data");
    }
    let per_frame = frame_samples(source)?;
    let count = per_frame
        .checked_mul(frames)
        .context("Pixel count overflow")?;
    let start = per_frame
        .checked_mul(frame.index as usize)
        .context("Frame offset overflow")?;
    let end = start
        .checked_add(per_frame)
        .context("Frame offset overflow")?;
    if usize::from(float.is_some())
        + usize::from(double.is_some())
        + usize::from(object.element(Tag(0x7fe0, 0x0010)).is_ok())
        != 1
    {
        bail!("DICOM must contain exactly one scalar pixel data element");
    }
    let mut values: Vec<f64>;
    let exact_transport;
    if let Some(element) = float {
        if allocated != 32 {
            bail!("FloatPixelData requires BitsAllocated 32");
        }
        let Value::Primitive(PrimitiveValue::F32(data)) = element.value() else {
            bail!("FloatPixelData has an invalid value representation");
        };
        if data.len() != count {
            bail!("FloatPixelData length differs from image dimensions");
        }
        values = data[start..end].iter().map(|&v| f64::from(v)).collect();
        exact_transport = false;
    } else if let Some(element) = double {
        if allocated != 64 {
            bail!("DoubleFloatPixelData requires BitsAllocated 64");
        }
        let Value::Primitive(PrimitiveValue::F64(data)) = element.value() else {
            bail!("DoubleFloatPixelData has an invalid value representation");
        };
        if data.len() != count {
            bail!("DoubleFloatPixelData length differs from image dimensions");
        }
        values = data[start..end].to_vec();
        exact_transport = true;
    } else {
        let bits = object.element(Tag(0x0028, 0x0101))?.to_int::<u16>()?;
        let high = object.element(Tag(0x0028, 0x0102))?.to_int::<u16>()?;
        let representation = object.element(Tag(0x0028, 0x0103))?.to_int::<u16>()?;
        if bits == 0 || bits > 32 || high >= 32 || high + 1 < bits || representation > 1 {
            bail!("Unsupported or inconsistent 32-bit stored pixel layout");
        }
        let element = object.element(Tag(0x7fe0, 0x0010))?;
        let (data, rle) = match element.value() {
            Value::Primitive(data) => (Some(data), None),
            Value::PixelSequence(sequence)
                if object.meta().transfer_syntax() == "1.2.840.10008.1.2.5" =>
            {
                (
                    None,
                    Some(rle32_frame(
                        sequence,
                        frames,
                        frame.index as usize,
                        per_frame,
                    )?),
                )
            }
            _ => bail!("This encapsulated 32-bit integer transfer syntax is not supported"),
        };
        let big_endian_ow = element.vr() == dicom_core::VR::OW
            && object.meta().transfer_syntax() == "1.2.840.10008.1.2.2";
        let shift = high + 1 - bits;
        let mask = (1u64 << bits) - 1;
        let sign = 1u64 << (bits - 1);
        values = Vec::with_capacity(per_frame);
        for index in start..end {
            let raw = match (data, rle.as_ref()) {
                (_, Some(words)) => words[index - start],
                // OW words are values in either byte order, and a 32-bit cell continues from its
                // low bits in one word into the next word (PS3.5 8.2).
                (Some(PrimitiveValue::U16(words)), _) if words.len() == count * 2 => {
                    u32::from(words[index * 2]) | (u32::from(words[index * 2 + 1]) << 16)
                }
                // Raw OW bytes keep each word in the transfer syntax's byte order; OB bytes are
                // unaffected by it.
                (Some(PrimitiveValue::U8(bytes)), _) if bytes.len() == count * 4 => {
                    let b: [u8; 4] = bytes[index * 4..index * 4 + 4].try_into().unwrap();
                    if big_endian_ow {
                        u32::from_le_bytes([b[1], b[0], b[3], b[2]])
                    } else {
                        u32::from_le_bytes(b)
                    }
                }
                (Some(PrimitiveValue::U32(words)), _) if words.len() == count => words[index],
                (Some(PrimitiveValue::I32(words)), _) if words.len() == count => {
                    words[index] as u32
                }
                _ => {
                    bail!("32-bit PixelData length or representation differs from image dimensions")
                }
            };
            let packed = (u64::from(raw) >> shift) & mask;
            let stored = if representation == 1 && packed & sign != 0 {
                packed as i64 - (1i64 << bits)
            } else {
                packed as i64
            };
            values.push(stored as f64);
        }
        exact_transport = true;
    }
    let floating = float.is_some() || double.is_some();
    apply_modality(&mut values, object, frame, floating)?;
    let allow_ieee = floating || frame.metadata.padding_is_nan;
    Ok(Some(FrameValues {
        values,
        preserve_precision: exact_transport,
        allow_ieee,
    }))
}

fn apply_modality(values:&mut [f64],object:&dicom_object::DefaultDicomObject,frame:&Frame,floating:bool)->Result<()> {
    use dicom_core::Tag;
    if let Some(mapping) = &frame.activity {
        let signed = object.get(Tag(0x0028,0x0103)).and_then(|v| v.to_int::<u16>().ok()) == Some(1);
        let bits = object.get(Tag(0x0028,0x0100)).context("Missing BitsAllocated")?.to_int::<u32>()?;
        let padding = crate::ingest::padding_range(object, frame.index as usize, 1., 0., signed, bits);
        for value in values {
            *value = if padding.is_some_and(|range| (range[0]..=range[1]).contains(value)) { f64::NAN } else { mapping.value(*value) };
            if value.is_infinite() { bail!("Activity mapping exceeds the finite range"); }
        }
    } else if let Some(lut)=crate::modality_lut::read(object,frame.index as usize,object.meta().transfer_syntax()!="1.2.840.10008.1.2.2")? {
        if floating { bail!("Modality LUT requires integer stored pixel values"); }
        let signed=object.get(Tag(0x0028,0x0103)).and_then(|v|v.to_int::<u16>().ok())==Some(1);
        let bits=object.get(Tag(0x0028,0x0100)).context("Missing BitsAllocated")?.to_int::<u32>()?;
        let padding=crate::ingest::padding_range(object,frame.index as usize,1.,0.,signed,bits);
        for value in values {
            if !value.is_finite() || value.fract()!=0. { bail!("Invalid stored value for Modality LUT"); }
            *value=if padding.is_some_and(|range| *value>=range[0] && *value<=range[1]) {f64::NAN} else {lut.value(*value as i64)};
        }
    } else {
        for value in values {
            let was_finite=value.is_finite();
            *value=*value*frame.slope+frame.intercept;
            if !value.is_finite() && (was_finite || !floating) {bail!("Pixel rescale produced non-finite physical values");}
        }
    }
    Ok(())
}

fn scalar_values(
    object: &dicom_object::DefaultDicomObject,
    decoded: &DecodedPixelData<'_>,
    index: u32,
    frame: &Frame,
) -> Result<Vec<f64>> {
    let bits = decoded.bits_stored();
    let high = decoded.high_bit();
    if bits == 0 || bits > 16 || high >= decoded.bits_allocated() || high + 1 < bits {
        bail!("Unsupported or inconsistent stored pixel bit layout");
    }
    let data = decoded
        .frame_data(index)
        .context("Cannot convert scalar pixels without a presentation transform")?;
    let signed = decoded.pixel_representation() as u16 == 1;
    let shift = high + 1 - bits;
    let range = 1i32 << bits;
    let unpack = |word: u16| {
        let stored = i32::from(word >> shift) & (range - 1);
        let value = if signed && stored >= range / 2 {
            stored - range
        } else {
            stored
        };
        f64::from(value)
    };
    let mut values: Vec<f64> = match decoded.bits_allocated() {
        8 => data.iter().map(|&byte| unpack(u16::from(byte))).collect(),
        // The decoder has already converted the file's words to native byte order.
        16 => data
            .chunks_exact(2)
            .map(|word| unpack(u16::from_ne_bytes([word[0], word[1]])))
            .collect(),
        _ => bail!("Unsupported scalar BitsAllocated"),
    };
    apply_modality(&mut values, object, frame, false)?;
    Ok(values)
}

fn decoded_values(
    source: &SourceSeries,
    object: &dicom_object::DefaultDicomObject,
    decoded: &DecodedPixelData<'_>,
    index: u32,
    frame: &Frame,
) -> Result<Vec<f64>> {
    validate_decoded(source, decoded)?;
    if source.info.components == 3 {
        Ok(crate::color::rgb_frame(object, decoded, index, frame.index)?
            .into_iter()
            .map(f64::from)
            .collect())
    } else if source.info.components == 1 {
        scalar_values(object,decoded, index, frame)
    } else {
        bail!("Only scalar and RGB images are supported")
    }
}

/// A source file that cannot be opened or parsed when its pixels are needed: often a CD or
/// USB drive that was removed after import.
fn cannot_read(path: &Path, error: anyhow::Error) -> anyhow::Error {
    if crate::source_file::is_changed(&error) {
        return crate::source_file::changed().into();
    }
    let reason = match error.downcast_ref::<std::io::Error>() {
        Some(io) if io.kind() == std::io::ErrorKind::NotFound => {
            note!("file.missing", "{detail}", detail = error.to_string()).into()
        }
        _ => crate::message::Param::error(&error),
    };
    coded!("decode.cannotRead", "Cannot read {path}: {reason}", path = path.display().to_string(), reason = reason).into()
}

/// A picture's RGB samples, decoded in the desktop app's sandboxed picture decoder (pictures.rs).
fn ordinary_rgb(source: &SourceSeries, frame: &Frame, check: fn() -> Result<()>) -> Result<Vec<u8>> {
    let path = &frame.source.path;
    let request = crate::pictures::read(&frame.source, crate::pictures::Want::Pixels, check).map_err(|error| {
        if crate::message::coded(&error).is_some() { error } else { cannot_read(path, error) }
    })?;
    let picture = request.decode().context("Cannot decode this ordinary image")?;
    if picture.width as usize != source.info.dimensions[0] || picture.height as usize != source.info.dimensions[1] {
        bail!("Image dimensions changed after import");
    }
    if source.info.components != 3 {
        bail!("Ordinary images are read as RGB");
    }
    anyhow::ensure!(picture.rgb.len() == frame_samples(source)?, "Decoded pixel count differs from image dimensions");
    Ok(picture.rgb)
}

fn one_frame_values(source: &SourceSeries, frame: &Frame, check: fn() -> Result<()>) -> Result<FrameValues> {
    if frame.ordinary_image {
        return Ok(FrameValues::from(ordinary_rgb(source, frame, check)?.into_iter().map(f64::from).collect::<Vec<_>>()));
    }
    let file = frame.source.open().map_err(|error| cannot_read(&frame.source.path, error))?;
    let mut object = dicom_object::OpenFileOptions::new().from_reader(file)
        .map_err(|error| cannot_read(&frame.source.path, error.into()))?;
    check_object(&object, false)?;
    crate::codec_guard::check(&object, Some(frame.index))?;
    widen_encapsulated_bits(&mut object);
    if source.info.photometric_interpretation == "PALETTE COLOR" && source.info.segmentation.is_none() {
        return Ok(FrameValues::from(
            crate::palette::decode_palette_frame(&object, frame.index)?
                .into_iter()
                .map(f64::from)
                .collect::<Vec<_>>(),
        ));
    }
    if let Some(values) = special_scalar_values(source, &object, frame)? {
        return Ok(values);
    }
    let decoded = object
        .decode_pixel_data_frame(frame.index)
        .map_err(|error| coded!(
            "decode.unsupportedPixels",
            "Unsupported or damaged DICOM pixel data (transfer syntax {syntax}): {reason}",
            syntax = object.meta().transfer_syntax().to_string(),
            reason = error.to_string(),
        ))?;
    Ok(FrameValues {
        values:decoded_values(source, &object, &decoded, 0, frame)?,
        preserve_precision:false,
        allow_ieee:frame.metadata.padding_is_nan,
    })
}

fn copy_values<T: Sample>(target: &mut [T], frame: FrameValues) -> Result<()> {
    if target.len() != frame.values.len() {
        bail!("Decoded pixel count differs from image dimensions");
    }
    for (target, value) in target.iter_mut().zip(frame.values) {
        if frame.allow_ieee && !value.is_finite() {
            *target = T::from_ieee(value)?;
            continue;
        }
        if T::IS_FLOAT32
            && (!(value as f32).is_finite()
                || (frame.preserve_precision && (value as f32) as f64 != value))
        {
            return Err(Float64Required.into());
        }
        *target = T::from_value(value)?;
    }
    Ok(())
}

/// A frame worker and the threads its codec can start share one CPU budget.
pub(crate) fn frame_workers(threads: usize, codec_threads: impl Iterator<Item = u8>) -> usize {
    let per_frame = 1 + usize::from(codec_threads.max().unwrap_or(0));
    (threads / per_frame).max(1)
}

fn volume_as<T: Sample>(source: &SourceSeries) -> Result<Vec<T>> {
    crate::progress::check()?;
    let per_frame = frame_samples(source)?;
    let count = per_frame
        .checked_mul(source.frames.len())
        .context("Volume dimensions overflow")?;
    if count
        .checked_mul(std::mem::size_of::<T>())
        .is_none_or(|n| n > MAX_VOLUME_BYTES)
    {
        bail!("Volume exceeds the {VOLUME_LIMIT} decoded output limit");
    }
    let mut output = Vec::new();
    output
        .try_reserve_exact(count)
        .map_err(|_| coded!("decode.noMemory", "Not enough memory for the decoded volume"))?;
    output.resize(count, T::default());
    crate::progress::check()?;
    let mut groups: HashMap<&Path, Vec<usize>> = HashMap::new();
    for (index, frame) in source.frames.iter().enumerate() {
        groups.entry(&frame.source.path).or_default().push(index);
    }
    // Frames stored one to a file are decoded on up to `workers` threads; a file holding several is read once, below.
    let individuals = groups.values().filter(|indices| indices.len() == 1);
    let workers = frame_workers(
        crate::parallel::available(2).min(8),
        individuals.map(|indices| source.frames[indices[0]].jpeg_component_threads),
    )
    .min((1024 * 1024 * 1024 / (per_frame * 24)).max(1));
    crate::parallel::try_for_each("frame-decode", workers, output.chunks_mut(per_frame).enumerate(), |(index, target)| -> Result<()> {
        let frame = &source.frames[index];
        if groups[frame.source.path.as_path()].len() == 1 {
            crate::progress::check()?;
            copy_values(target, one_frame_values(source, frame, crate::progress::check)?)?;
            crate::progress::step()?;
        }
        Ok(())
    })?;

    for (path, indices) in groups.into_iter().filter(|(_, indices)| indices.len() > 1) {
        crate::progress::check()?;
        let file = source.frames[indices[0]].source.open().map_err(|error| cannot_read(path, error))?;
        let mut object = dicom_object::OpenFileOptions::new().from_reader(file).map_err(|error| cannot_read(path, error.into()))?;
        check_object(&object, true)?;
        crate::codec_guard::check(&object, None)?;
        widen_encapsulated_bits(&mut object);
        let first = &source.frames[indices[0]];
        if let Some(values) = special_scalar_values(source, &object, first)? {
            let first_index = indices[0];
            copy_values(
                &mut output[first_index * per_frame..(first_index + 1) * per_frame],
                values,
            )?;
            crate::progress::step()?;
            for &index in &indices[1..] {
                crate::progress::check()?;
                let values = special_scalar_values(source, &object, &source.frames[index])?
                    .context("Inconsistent scalar pixel encoding")?;
                copy_values(
                    &mut output[index * per_frame..(index + 1) * per_frame],
                    values,
                )?;
                crate::progress::step()?;
            }
            continue;
        }
        let decoded = object.decode_pixel_data().map_err(|error| coded!(
            "decode.unsupportedPixels",
            "Unsupported or damaged DICOM pixel data (transfer syntax {syntax}): {reason}",
            syntax = object.meta().transfer_syntax().to_string(),
            reason = error.to_string(),
        ))?;
        for index in indices {
            crate::progress::check()?;
            let frame = &source.frames[index];
            let values = if source.info.photometric_interpretation == "PALETTE COLOR" && source.info.segmentation.is_none() {
                crate::palette::apply_palette(&decoded, &object, frame.index)?
                    .into_iter()
                    .map(f64::from)
                    .collect()
            } else {
                decoded_values(source, &object, &decoded, frame.index, frame)?
            };
            copy_values(
                &mut output[index * per_frame..(index + 1) * per_frame],
                FrameValues {values,preserve_precision:false,allow_ieee:frame.metadata.padding_is_nan},
            )?;
            crate::progress::step()?;
        }
    }
    crate::progress::check()?;
    Ok(output)
}

pub fn decode_volume(source: &SourceSeries) -> Result<PixelBuffer> {
    anyhow::ensure!(!source.frames.is_empty(), "This series has no image frames");
    match decode_volume_compact(source) {
        Err(error) if error.downcast_ref::<Float64Required>().is_some() => {
            volume_as::<f64>(source).map(PixelBuffer::F64)
        }
        result => result,
    }
}

fn decode_volume_compact(source: &SourceSeries) -> Result<PixelBuffer> {
    if source.frames.len() != source.info.dimensions[2] {
        bail!("Frame count differs from series dimensions");
    }
    if let [frame] = source.frames.as_slice() && frame.ordinary_image {
        return ordinary_rgb(source, frame, crate::progress::check).map(PixelBuffer::U8);
    }
    if source.info.pixel_type == "float32"
        && source.info.components == 1
        && source
            .frames
            .iter()
            .all(|frame| !frame.metadata.padding_is_nan && frame.slope.fract() == 0. && frame.intercept.fract() == 0.)
    {
        // Header ranges can exceed i16 even when every stored physical value fits.
        // Check during the compact decode, without allocating a float volume first.
        match volume_as::<i16>(source) {
            Ok(values) => return Ok(PixelBuffer::I16(values)),
            Err(error) if error.downcast_ref::<TypeDoesNotFit>().is_some() => {}
            Err(error) => return Err(error),
        }
        match volume_as::<u16>(source) {
            Ok(values) => return Ok(PixelBuffer::U16(values)),
            Err(error) if error.downcast_ref::<TypeDoesNotFit>().is_some() => {}
            Err(error) => return Err(error),
        }
    }
    let result = match source.info.pixel_type.as_str() {
        "int16" => volume_as::<i16>(source).map(PixelBuffer::I16),
        "uint16" => volume_as::<u16>(source).map(PixelBuffer::U16),
        "uint8" => volume_as::<u8>(source).map(PixelBuffer::U8),
        _ => return volume_as::<f32>(source).map(PixelBuffer::F32),
    };
    match result {
        Err(error) if error.downcast_ref::<TypeDoesNotFit>().is_some() => {
            volume_as::<f32>(source).map(PixelBuffer::F32)
        }
        result => result,
    }
}

pub fn decode_frame(source: &SourceSeries, index: usize) -> Result<PixelBuffer> {
    let expected = frame_samples(source)?;
    let frame = source
        .frames
        .get(index)
        .context("Frame index is outside this series")?;
    if frame.ordinary_image {
        return ordinary_rgb(source, frame, || Ok(())).map(PixelBuffer::U8);
    }
    let FrameValues {
        values,
        preserve_precision,
        allow_ieee,
    } = one_frame_values(source, frame, || Ok(()))?;
    if values.len() != expected {
        bail!("Decoded pixel count differs from image dimensions");
    }
    if source.info.components == 3 {
        return Ok(PixelBuffer::U8(
            values
                .into_iter()
                .map(u8::from_value)
                .collect::<Result<_>>()?,
        ));
    }
    if values
        .iter()
        .all(|v| v.fract() == 0. && *v >= 0. && *v <= u16::MAX as f64)
    {
        return Ok(PixelBuffer::U16(
            values.into_iter().map(|v| v as u16).collect(),
        ));
    }
    if values
        .iter()
        .all(|v| v.fract() == 0. && *v >= i16::MIN as f64 && *v <= i16::MAX as f64)
    {
        return Ok(PixelBuffer::I16(
            values.into_iter().map(|v| v as i16).collect(),
        ));
    }
    if values.iter().any(|&value| {
        value.is_finite()
            && (!(value as f32).is_finite()
                || (preserve_precision && (value as f32) as f64 != value))
    }) {
        return Ok(PixelBuffer::F64(values));
    }
    Ok(PixelBuffer::F32(
        values
            .into_iter()
            .map(|value| {
                if allow_ieee && !value.is_finite() {
                    f32::from_ieee(value)
                } else {
                    f32::from_value(value)
                }
            })
            .collect::<Result<_>>()?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{DataElement, PrimitiveValue, Tag, VR};
    use dicom_object::{FileMetaTableBuilder, InMemDicomObject};

    fn fixture(
        path: &Path,
        pixels: &[u16],
        signed: bool,
        bits: u16,
        slope: f64,
        intercept: f64,
        monochrome: &str,
    ) {
        let mut object = InMemDicomObject::new_empty();
        for (tag, vr, value) in [
            (Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.2"),
            (Tag(0x0008, 0x0018), VR::UI, "2.25.1"),
            (Tag(0x0020, 0x000d), VR::UI, "2.25.2"),
            (Tag(0x0020, 0x000e), VR::UI, "2.25.3"),
            (Tag(0x0008, 0x0060), VR::CS, "CT"),
            (Tag(0x0028, 0x0004), VR::CS, monochrome),
        ] {
            object.put_str(tag, vr, value);
        }
        for (tag, value) in [
            (Tag(0x0028, 0x0010), 1),
            (Tag(0x0028, 0x0011), pixels.len() as u16),
            (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), 16),
            (Tag(0x0028, 0x0101), bits),
            (Tag(0x0028, 0x0102), bits - 1),
            (Tag(0x0028, 0x0103), u16::from(signed)),
        ] {
            object.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
        }
        object.put_str(Tag(0x0028, 0x1053), VR::DS, slope.to_string());
        object.put_str(Tag(0x0028, 0x1052), VR::DS, intercept.to_string());
        object.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OW,
            PrimitiveValue::U16(pixels.to_vec().into()),
        ));
        object
            .with_meta(FileMetaTableBuilder::new().transfer_syntax("1.2.840.10008.1.2.1"))
            .unwrap()
            .write_to_file(path)
            .unwrap();
    }
    fn check(
        pixels: &[u16],
        signed: bool,
        bits: u16,
        slope: f64,
        intercept: f64,
        monochrome: &str,
        expected: &[f64],
        expected_type: &str,
    ) {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("frame.dcm");
        fixture(&path, pixels, signed, bits, slope, intercept, monochrome);
        let imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
        let buffer = decode_frame(&imported.sources[0], 0).unwrap();
        assert_eq!(buffer.type_name(), expected_type);
        assert_eq!(
            (0..buffer.len())
                .map(|i| buffer.value(i))
                .collect::<Vec<_>>(),
            expected
        );
        let volume = decode_volume(&imported.sources[0]).unwrap();
        assert_eq!(
            (0..volume.len())
                .map(|i| volume.value(i))
                .collect::<Vec<_>>(),
            expected
        );
    }
    fn wide_fixture(
        path: &Path,
        pixels: PrimitiveValue,
        allocated: u16,
        signed: bool,
        columns: u16,
        frames: usize,
        transfer_syntax: &str,
    ) {
        fixture(
            path,
            &vec![0; columns as usize],
            signed,
            allocated,
            1.,
            0.,
            "MONOCHROME2",
        );
        let mut object = dicom_object::open_file(path).unwrap();
        object.put(DataElement::new(
            Tag(0x0028, 0x0100),
            VR::US,
            PrimitiveValue::from(allocated),
        ));
        object.put_str(Tag(0x0028, 0x0008), VR::IS, frames.to_string());
        object.remove_element(Tag(0x7fe0, 0x0010));
        let (tag, vr) = match pixels {
            PrimitiveValue::F32(_) => (Tag(0x7fe0, 0x0008), VR::OF),
            PrimitiveValue::F64(_) => (Tag(0x7fe0, 0x0009), VR::OD),
            _ => (Tag(0x7fe0, 0x0010), VR::OW),
        };
        if vr == VR::OF || vr == VR::OD {
            for tag in [
                Tag(0x0028, 0x0101),
                Tag(0x0028, 0x0102),
                Tag(0x0028, 0x0103),
            ] {
                object.remove_element(tag);
            }
        }
        object.put(DataElement::new(tag, vr, pixels));
        object.update_meta(|meta| meta.transfer_syntax = transfer_syntax.to_owned());
        object.write_to_file(path).unwrap();
    }

    fn imported(path: &Path) -> crate::ingest::Imported {
        crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap()
    }

    fn rle32_encoded(segments: [Vec<u8>; 4]) -> Vec<u8> {
        let mut frame = vec![0u8; 64];
        frame[0..4].copy_from_slice(&4u32.to_le_bytes());
        for (index, mut segment) in segments.into_iter().enumerate() {
            if segment.len() % 2 != 0 {
                segment.push(0);
            }
            let offset = frame.len() as u32;
            frame[(index + 1) * 4..(index + 2) * 4].copy_from_slice(&offset.to_le_bytes());
            frame.extend(segment);
        }
        frame
    }

    fn rle32_literal(values: &[u32]) -> Vec<u8> {
        rle32_encoded(std::array::from_fn(|segment| {
            let plane: Vec<u8> = values
                .iter()
                .map(|&v| (v >> ((3 - segment) * 8)) as u8)
                .collect();
            let mut encoded = Vec::new();
            for bytes in plane.chunks(128) {
                encoded.push((bytes.len() - 1) as u8);
                encoded.extend_from_slice(bytes);
            }
            encoded
        }))
    }

    #[test]
    fn rle32_reads_literal_repeat_noop_and_padding_without_byte_order_loss() {
        let expected = [0, 0x12345678, u32::MAX, 0x80000000];
        assert_eq!(
            decode_rle32(&rle32_literal(&expected), 4).unwrap(),
            expected
        );
        let frame = rle32_encoded([
            vec![128, 254, 0x10],
            vec![254, 0x20],
            vec![254, 0x30],
            vec![2, 0x40, 0x41, 0x42],
        ]);
        assert_eq!(
            decode_rle32(&frame, 3).unwrap(),
            [0x10203040, 0x10203041, 0x10203042]
        );
    }

    #[test]
    fn rle32_matches_independently_encoded_pydicom_packets() {
        // Captured from pydicom's RLELossless encoder with validate=False for its 32-bit compatibility path.
        for (hex, expected) in [
            (
                "04000000400000004400000046000000480000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ff000001fe00fe000000ff01",
                [0, 1, 16777217],
            ),
            (
                "040000004000000044000000480000004c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002017f070200ff5b0200ffcd0201ff15",
                [16777217, 2147483647, 123456789],
            ),
        ] {
            let bytes: Vec<u8> = hex
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            assert_eq!(decode_rle32(&bytes, 3).unwrap(), expected);
        }
    }

    #[test]
    fn rle32_rejects_bad_headers_truncated_runs_and_expansion_overflow() {
        let valid = rle32_literal(&[1, 2, 3]);
        for bad in [
            vec![0; 63],
            {
                let mut v = valid.clone();
                v[0] = 5;
                v
            },
            {
                let mut v = valid.clone();
                v[4..8].copy_from_slice(&65u32.to_le_bytes());
                v
            },
            {
                let mut v = valid.clone();
                v[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
                v
            },
            {
                let mut v = valid.clone();
                v[60] = 1;
                v
            },
        ] {
            assert!(decode_rle32(&bad, 3).is_err());
        }
        for malformed in [vec![3, 1, 2, 0], vec![129, 42], vec![255, 42]] {
            let frame = rle32_encoded([malformed, vec![254, 0], vec![254, 0], vec![254, 0]]);
            assert!(decode_rle32(&frame, 3).is_err());
        }
    }

    #[test]
    fn rle32_multiframe_pipeline_retains_signed_values_and_checks_frame_offsets() {
        use dicom_core::value::{PixelFragmentSequence, Value};
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("rle32.dcm");
        let expected = [i32::MIN, -16777217, 0, 16777217, i32::MAX, -1];
        wide_fixture(
            &path,
            PrimitiveValue::U32(expected.iter().map(|&v| v as u32).collect()),
            32,
            true,
            3,
            2,
            "1.2.840.10008.1.2.1",
        );
        let fragments: Vec<_> = expected
            .chunks(3)
            .map(|values| rle32_literal(&values.iter().map(|&v| v as u32).collect::<Vec<_>>()))
            .collect();
        let offsets = vec![0, fragments[0].len() as u32 + 8];
        let sequence = PixelFragmentSequence::new(offsets, fragments.clone());
        let mut object = dicom_object::open_file(&path).unwrap();
        object.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OB,
            Value::PixelSequence(sequence),
        ));
        object.update_meta(|meta| meta.transfer_syntax = "1.2.840.10008.1.2.5".into());
        object.write_to_file(&path).unwrap();
        let data = imported(&path);
        let volume = decode_volume(&data.sources[0]).unwrap();
        assert_eq!(volume.type_name(), "float64");
        assert_eq!(
            (0..volume.len())
                .map(|i| volume.value(i))
                .collect::<Vec<_>>(),
            expected.map(f64::from)
        );
        let frame = decode_frame(&data.sources[0], 1).unwrap();
        assert_eq!(
            (0..frame.len()).map(|i| frame.value(i)).collect::<Vec<_>>(),
            expected[3..]
                .iter()
                .map(|&v| f64::from(v))
                .collect::<Vec<_>>()
        );
        let invalid = PixelFragmentSequence::new(vec![0, 1], fragments);
        assert!(rle32_frame(&invalid, 2, 0, 3).is_err());
        assert!(rle32_frame(&invalid, 1, 0, 3).is_err());
    }

    #[test]
    fn signed_32_bit_pixels_preserve_full_range_in_both_byte_orders() {
        for syntax in ["1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"] {
            let dir = crate::test_dir::tempdir().unwrap();
            let path = dir.path().join("i32.dcm");
            let expected = [i32::MIN, -16777217, 0, 16777217, i32::MAX];
            // Each cell as OW words, low bits first (PS3.5 8.2); a big-endian file then holds
            // 0x01020304 as the bytes 03 04 01 02.
            wide_fixture(
                &path,
                PrimitiveValue::U16(
                    expected
                        .iter()
                        .flat_map(|&v| [v as u32 as u16, ((v as u32) >> 16) as u16])
                        .collect(),
                ),
                32,
                true,
                5,
                1,
                syntax,
            );
            let data = imported(&path);
            for pixels in [
                decode_frame(&data.sources[0], 0).unwrap(),
                decode_volume(&data.sources[0]).unwrap(),
            ] {
                assert_eq!(pixels.type_name(), "float64");
                assert_eq!(
                    (0..pixels.len())
                        .map(|i| pixels.value(i))
                        .collect::<Vec<_>>(),
                    expected.map(f64::from)
                );
            }
        }
    }

    #[test]
    fn unsigned_32_bit_pixels_preserve_values_above_float32_integer_precision() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("u32.dcm");
        wide_fixture(
            &path,
            PrimitiveValue::U32(vec![0, 16777217, u32::MAX].into()),
            32,
            false,
            3,
            1,
            "1.2.840.10008.1.2.1",
        );
        let data = imported(&path);
        let pixels = decode_volume(&data.sources[0]).unwrap();
        assert_eq!(pixels.type_name(), "float64");
        assert_eq!(
            (0..pixels.len())
                .map(|i| pixels.value(i))
                .collect::<Vec<_>>(),
            [0., 16777217., 4294967295.]
        );
    }

    #[test]
    fn exact_32_bit_values_stay_float32_after_rescale() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("exact32.dcm");
        wide_fixture(
            &path,
            PrimitiveValue::U32(vec![0x00ffffff, 0x00800000, 0x007fffff].into()),
            32,
            true,
            3,
            1,
            "1.2.840.10008.1.2.1",
        );
        let mut object = dicom_object::open_file(&path).unwrap();
        object.put(DataElement::new(
            Tag(0x0028, 0x0101),
            VR::US,
            PrimitiveValue::from(24u16),
        ));
        object.put(DataElement::new(
            Tag(0x0028, 0x0102),
            VR::US,
            PrimitiveValue::from(23u16),
        ));
        object.put_str(Tag(0x0028, 0x1053), VR::DS, "0.5");
        object.put_str(Tag(0x0028, 0x1052), VR::DS, "10");
        object.write_to_file(&path).unwrap();
        let data = imported(&path);
        let pixels = decode_volume(&data.sources[0]).unwrap();
        assert_eq!(pixels.type_name(), "float32");
        assert_eq!(
            (0..pixels.len())
                .map(|i| pixels.value(i))
                .collect::<Vec<_>>(),
            [9.5, -4194294., 4194313.5]
        );
    }

    #[test]
    fn float_pixel_data_keeps_ieee_padding_and_applies_rescale_once() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("float.dcm");
        wide_fixture(
            &path,
            PrimitiveValue::F32(vec![f32::NAN, f32::INFINITY, -1.5, 0.25].into()),
            32,
            false,
            4,
            1,
            "1.2.840.10008.1.2.1",
        );
        let mut object = dicom_object::open_file(&path).unwrap();
        object.put_str(Tag(0x0028, 0x1053), VR::DS, "2");
        object.put_str(Tag(0x0028, 0x1052), VR::DS, "1");
        object.write_to_file(&path).unwrap();
        let data = imported(&path);
        for pixels in [
            decode_frame(&data.sources[0], 0).unwrap(),
            decode_volume(&data.sources[0]).unwrap(),
        ] {
            assert_eq!(pixels.type_name(), "float32");
            assert!(pixels.value(0).is_nan());
            assert_eq!(pixels.value(1), f64::INFINITY);
            assert_eq!(pixels.value(2), -2.);
            assert_eq!(pixels.value(3), 1.5);
        }
    }

    #[test]
    fn double_pixel_data_preserves_precision_and_range_beyond_float32() {
        for syntax in ["1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"] {
            let dir = crate::test_dir::tempdir().unwrap();
            let path = dir.path().join("double.dcm");
            wide_fixture(
                &path,
                PrimitiveValue::F64(vec![0.1, 1e100, f64::NAN, f64::NEG_INFINITY].into()),
                64,
                false,
                4,
                1,
                syntax,
            );
            let data = imported(&path);
            for pixels in [
                decode_frame(&data.sources[0], 0).unwrap(),
                decode_volume(&data.sources[0]).unwrap(),
            ] {
                assert_eq!(pixels.type_name(), "float64");
                assert_eq!(pixels.value(0), 0.1);
                assert_eq!(pixels.value(1), 1e100);
                assert!(pixels.value(2).is_nan());
                assert_eq!(pixels.value(3), f64::NEG_INFINITY);
            }
        }
    }

    #[test]
    fn floating_multiframe_uses_frame_order_and_each_frame_rescale() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("float-frames.dcm");
        wide_fixture(
            &path,
            PrimitiveValue::F32(vec![0.5, 1.5, 2.5, 3.5].into()),
            32,
            false,
            2,
            2,
            "1.2.840.10008.1.2.1",
        );
        let mut data = imported(&path);
        let source = std::sync::Arc::get_mut(&mut data.sources[0]).unwrap();
        source.frames[0].slope = 2.;
        source.frames[0].intercept = -10.;
        source.frames[1].slope = 0.5;
        source.frames[1].intercept = 20.;
        source.frames.swap(0, 1);
        let pixels = decode_volume(source).unwrap();
        assert_eq!(
            (0..pixels.len())
                .map(|i| pixels.value(i))
                .collect::<Vec<_>>(),
            [21.25, 21.75, -9., -7.]
        );
    }

    #[test]
    fn finite_float_rescale_overflow_is_rejected() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("overflow.dcm");
        wide_fixture(
            &path,
            PrimitiveValue::F64(vec![f64::MAX].into()),
            64,
            false,
            1,
            1,
            "1.2.840.10008.1.2.1",
        );
        let mut data = imported(&path);
        let source = std::sync::Arc::get_mut(&mut data.sources[0]).unwrap();
        source.frames[0].slope = 2.;
        let error = decode_volume(source).err().unwrap().to_string();
        assert!(error.contains("non-finite"), "{error}");
    }
    #[test]
    fn ct_rescale_preserves_signed_hu() {
        check(
            &[0, 1024, 4095],
            false,
            12,
            1.,
            -1024.,
            "MONOCHROME2",
            &[-1024., 0., 3071.],
            "int16",
        );
    }
    #[test]
    fn fractional_and_negative_rescale_are_applied_once() {
        check(
            &[0, 1, 4095],
            false,
            12,
            -0.5,
            10.25,
            "MONOCHROME2",
            &[10.25, 9.75, -2037.25],
            "float32",
        );
    }
    #[test]
    fn monochrome_one_does_not_invert_physical_pixels() {
        check(
            &[0, 100, 4095],
            false,
            12,
            1.,
            0.,
            "MONOCHROME1",
            &[0., 100., 4095.],
            "uint16",
        );
    }
    #[test]
    fn signed_stored_bits_are_sign_extended() {
        check(
            &[0x0fff, 0x0800, 0x07ff],
            true,
            12,
            1.,
            0.,
            "MONOCHROME2",
            &[-1., -2048., 2047.],
            "int16",
        );
    }
    #[test]
    fn shifted_signed_pixels_ignore_the_unused_bits_in_both_byte_orders() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("shifted.dcm");
        for syntax in ["1.2.840.10008.1.2.1", "1.2.840.10008.1.2.2"] {
            for (allocated, high, vr, pixels) in [
                (8u16, 6u16, VR::OB, PrimitiveValue::U8(vec![0xc3, 0xff, 0x83, 0xbf].into())),
                (16, 13, VR::OW, PrimitiveValue::U16(vec![0xe1ff, 0xffff, 0xc1ff, 0xdfff].into())),
            ] {
                fixture(&path, &[0; 4], true, 5, 1., 0., "MONOCHROME2");
                let mut object = dicom_object::open_file(&path).unwrap();
                for (tag, value) in [(Tag(0x0028, 0x0100), allocated), (Tag(0x0028, 0x0102), high)] {
                    object.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
                }
                object.put(DataElement::new(Tag(0x7fe0, 0x0010), vr, pixels));
                object.update_meta(|meta| meta.transfer_syntax = syntax.to_owned());
                object.write_to_file(&path).unwrap();
                let data = imported(&path);
                let source = &data.sources[0];
                for buffer in [decode_frame(source, 0).unwrap(), decode_volume(source).unwrap()] {
                    let values: Vec<_> = (0..buffer.len()).map(|i| buffer.value(i)).collect();
                    assert_eq!(values, [-16., -1., 0., 15.], "{allocated} bits in {syntax}");
                }
            }
        }
    }
    #[test]
    fn conservative_header_range_can_still_use_compact_physical_pixels() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("compact.dcm");
        fixture(&path, &[0, 1024, 4095], true, 16, 1., -1024., "MONOCHROME2");
        let imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(imported.sources[0].info.pixel_type, "float32");
        let volume = decode_volume(&imported.sources[0]).unwrap();
        assert_eq!(volume.type_name(), "int16");
        assert_eq!(
            (0..volume.len())
                .map(|i| volume.value(i))
                .collect::<Vec<_>>(),
            [-1024., 0., 3071.]
        );
    }
    #[test]
    fn ordinary_images_only_reach_the_png_jpeg_and_bmp_decoders() {
        use crate::pictures::testing::{self, JPEG, PNG};
        testing::serve();
        let dir = crate::test_dir::tempdir().unwrap();
        // A TIFF named .png is refused before any decoder sees it.
        let disguised = dir.path().join("disguised.png");
        std::fs::write(&disguised, b"II*\0\x08\0\0\0\0\0\0\0\0\0").unwrap();
        let error = crate::ingest::import(&[disguised.to_string_lossy().into_owned()]).err().unwrap();
        assert!(format!("{error:#}").contains("PNG, JPEG and BMP"), "{error:#}");
        assert!(!testing::decoded().lock().unwrap().iter().any(|bytes| bytes.starts_with(b"II*")));
        // A PNG named .jpg opens: the decoder follows the contents.
        let misnamed = dir.path().join("misnamed.jpg");
        let bytes = testing::picture(PNG, 1, 1, &[1, 2, 3]);
        std::fs::write(&misnamed, &bytes).unwrap();
        let imported = crate::ingest::import(&[misnamed.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(decode_volume(&imported.sources[0]).unwrap().bytes(), [1, 2, 3]);
        assert!(testing::decoded().lock().unwrap().contains(&bytes));
        // So does a JPEG.
        let photo = dir.path().join("photo.jpeg");
        std::fs::write(&photo, testing::picture(JPEG, 1, 2, &[4, 5, 6, 7, 8, 9])).unwrap();
        let imported = crate::ingest::import(&[photo.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(imported.sources[0].info.dimensions, [1, 2, 1]);
    }
    #[test]
    fn ordinary_png_preserves_rgb_components() {
        use crate::pictures::testing::{self, PNG};
        testing::serve();
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("color.png");
        std::fs::write(&path, testing::picture(PNG, 2, 1, &[255, 0, 20, 0, 200, 255])).unwrap();
        let imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
        let pixels = decode_volume(&imported.sources[0]).unwrap();
        assert_eq!(pixels.type_name(), "uint8");
        assert_eq!(pixels.bytes(), [255, 0, 20, 0, 200, 255]);
        assert_eq!(decode_frame(&imported.sources[0], 0).unwrap().bytes(), [255, 0, 20, 0, 200, 255]);
        assert!(!imported.sources[0].info.can_reconstruct);
    }
    #[test]
    fn ordinary_bmp_opens_like_png() {
        // BMP pictures open as the Python viewer and VEAcom Next open them (TIFF is not supported).
        use crate::pictures::testing::{self, BMP};
        testing::serve();
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("scan.bmp");
        std::fs::write(&path, testing::picture(BMP, 2, 1, &[255, 0, 20, 0, 200, 255])).unwrap();
        let imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(imported.sources[0].info.dimensions, [2, 1, 1]);
        let pixels = decode_volume(&imported.sources[0]).unwrap();
        assert_eq!(pixels.bytes(), [255, 0, 20, 0, 200, 255]);
    }
    #[test]
    fn ordinary_pictures_keep_the_frame_and_size_limits() {
        use crate::pictures::testing::{self, PNG};
        testing::serve();
        let dir = crate::test_dir::tempdir().unwrap();
        // Wider than 32768 pixels: refused while the import reads it, before its samples are asked for.
        let wide = dir.path().join("wide.png");
        std::fs::write(&wide, [PNG, b"VEACOM TEST PICTURE", &32769u32.to_le_bytes(), &1u32.to_le_bytes()].concat()).unwrap();
        let error = crate::ingest::import(&[wide.to_string_lossy().into_owned()]).err().unwrap();
        assert!(format!("{error:#}").contains("Invalid or excessive image dimensions"), "{error:#}");
        // 5000 × 5000 RGB is 75 million samples: listed, but its samples are never asked for.
        let large = dir.path().join("large.png");
        std::fs::write(&large, [PNG, b"VEACOM TEST PICTURE", &5000u32.to_le_bytes(), &5000u32.to_le_bytes()].concat()).unwrap();
        let imported = crate::ingest::import(&[large.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(imported.sources[0].info.dimensions, [5000, 5000, 1]);
        let error = decode_frame(&imported.sources[0], 0).err().unwrap();
        assert!(error.to_string().contains("64 million sample limit"), "{error}");
        assert!(decode_volume(&imported.sources[0]).is_err());
        // A picture whose file changed to another size after the import is not shown with the old one's geometry.
        std::fs::write(&large, testing::picture(PNG, 2, 1, &[0; 6])).unwrap();
        let small = crate::ingest::import(&[large.to_string_lossy().into_owned()]).unwrap();
        std::fs::write(&large, testing::picture(PNG, 1, 2, &[0; 6])).unwrap();
        let error = decode_frame(&small.sources[0], 0).err().unwrap();
        assert!(crate::source_file::is_changed(&error), "{error}");
    }
    #[test]
    fn dicom_planar_rgb_is_interleaved_without_windowing() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("color.dcm");
        fixture(&path, &[0, 0], false, 8, 10., -20., "RGB");
        let mut object = dicom_object::open_file(&path).unwrap();
        for (tag, value) in [
            (Tag(0x0028, 0x0002), 3u16),
            (Tag(0x0028, 0x0006), 1),
            (Tag(0x0028, 0x0100), 8),
        ] {
            object.put(DataElement::new(tag, VR::US, PrimitiveValue::from(value)));
        }
        object.put(DataElement::new(
            Tag(0x7fe0, 0x0010),
            VR::OB,
            PrimitiveValue::U8(vec![255, 0, 0, 200, 20, 255].into()),
        ));
        object.write_to_file(&path).unwrap();
        let imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
        let pixels = decode_volume(&imported.sources[0]).unwrap();
        assert_eq!(pixels.type_name(), "uint8");
        assert_eq!(pixels.bytes(), [255, 0, 20, 0, 200, 255]);
        assert!(!imported.sources[0].info.can_reconstruct);
    }
    #[test]
    fn multiframe_order_and_per_frame_rescale_are_preserved() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("frames.dcm");
        fixture(&path, &[1, 2, 3, 4], false, 12, 1., 0., "MONOCHROME2");
        let mut object = dicom_object::open_file(&path).unwrap();
        object.put(DataElement::new(
            Tag(0x0028, 0x0011),
            VR::US,
            PrimitiveValue::from(2u16),
        ));
        object.put_str(Tag(0x0028, 0x0008), VR::IS, "2");
        object.write_to_file(&path).unwrap();
        let mut imported = crate::ingest::import(&[path.to_string_lossy().into_owned()]).unwrap();
        let source = std::sync::Arc::get_mut(&mut imported.sources[0]).unwrap();
        source.frames[0].slope = 2.;
        source.frames[0].intercept = -10.;
        source.frames[1].slope = 0.5;
        source.frames[1].intercept = 20.;
        source.frames.swap(0, 1);
        // An intentionally stale integer hint must fall back without losing fractions.
        source.info.pixel_type = "uint16".into();
        let volume = decode_volume(source).unwrap();
        assert_eq!(volume.type_name(), "float32");
        assert_eq!(
            (0..volume.len())
                .map(|i| volume.value(i))
                .collect::<Vec<_>>(),
            [21.5, 22., -8., -6.]
        );
        let second = decode_frame(source, 1).unwrap();
        assert_eq!(
            (0..second.len())
                .map(|i| second.value(i))
                .collect::<Vec<_>>(),
            [-8., -6.]
        );
    }
}
