use crate::vfs::File;
use anyhow::{Context, Result, bail, ensure};
use dicom_core::{PrimitiveValue, Tag};
use dicom_encoding::{
    text::SpecificCharacterSet,
    transfer_syntax::{Codec, TransferSyntaxIndex},
};
use dicom_parser::{
    dataset::{LazyDataToken, lazy_read::LazyDataSetReader},
    stateful::decode::{DynStatefulDecoder, StatefulDecode},
};
use dicom_transfer_syntax_registry::TransferSyntaxRegistry;
use std::{
    cell::Cell,
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::Path,
    rc::Rc,
};

pub(crate) const MAX_META: u64 = 32 * 1024 * 1024;
const MAX_VALUE: u64 = 1024 * 1024;
const MAX_FILE_META: u64 = 64 * 1024;
/// In WebAssembly everything shares 4 GB, so one file's pixel data may take a quarter of it there.
const MAX_PIXELS: u64 = if cfg!(target_arch = "wasm32") {
    1024 * 1024 * 1024
} else {
    2 * 1024 * 1024 * 1024
};
const PIXEL_LIMIT: &str = if cfg!(target_arch = "wasm32") {
    "1 GiB"
} else {
    "2 GiB"
};
const MAX_DATA: u64 = MAX_PIXELS + MAX_META;
pub const MAX_FILE_SIZE: u64 = MAX_DATA + MAX_FILE_META + 132;
const MAX_ELEMENTS: usize = 200_000;
const MAX_DEPTH: usize = 32;
const PIXEL: Tag = Tag(0x7fe0, 0x0010);
const FLOAT_PIXEL: Tag = Tag(0x7fe0, 0x0008);
const DOUBLE_PIXEL: Tag = Tag(0x7fe0, 0x0009);
const EXTENDED_OFFSETS: Tag = Tag(0x7fe0, 0x0001);
const EXTENDED_LENGTHS: Tag = Tag(0x7fe0, 0x0002);

#[derive(Debug)]
pub struct InputInfo {
    pub frames: usize,
    pub metadata_bytes: usize,
}

trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}

enum Source {
    Native {
        reader: Box<dyn ReadSeek>,
        base: u64,
        length: u64,
    },
    Compressed(Box<dyn Read>),
}
struct GuardRead {
    source: Source,
    position: Rc<Cell<u64>>,
}

// StatefulDecoder::seek does not advance its byte counter. Sequence boundaries
// must use the actual source position when bulk values are skipped by seeking.
struct GuardDecoder {
    inner: DynStatefulDecoder<GuardRead>,
    position: Rc<Cell<u64>>,
}
type ParseResult<T> = dicom_parser::stateful::decode::Result<T>;
impl StatefulDecode for GuardDecoder {
    type Reader = GuardRead;
    fn decode_header(&mut self) -> ParseResult<dicom_core::header::DataElementHeader> {
        self.inner.decode_header()
    }
    fn decode_item_header(&mut self) -> ParseResult<dicom_core::header::SequenceItemHeader> {
        self.inner.decode_item_header()
    }
    fn read_value(
        &mut self,
        header: &dicom_core::header::DataElementHeader,
    ) -> ParseResult<PrimitiveValue> {
        self.inner.read_value(header)
    }
    fn read_value_preserved(
        &mut self,
        header: &dicom_core::header::DataElementHeader,
    ) -> ParseResult<PrimitiveValue> {
        self.inner.read_value_preserved(header)
    }
    fn read_value_bytes(
        &mut self,
        header: &dicom_core::header::DataElementHeader,
    ) -> ParseResult<PrimitiveValue> {
        self.inner.read_value_bytes(header)
    }
    fn read_to_vec(&mut self, length: u32, values: &mut Vec<u8>) -> ParseResult<()> {
        self.inner.read_to_vec(length, values)
    }
    fn read_u32_to_vec(&mut self, length: u32, values: &mut Vec<u32>) -> ParseResult<()> {
        self.inner.read_u32_to_vec(length, values)
    }
    fn read_to<W: io::Write>(&mut self, length: u32, writer: W) -> ParseResult<()> {
        self.inner.read_to(length, writer)
    }
    fn skip_bytes(&mut self, length: u32) -> ParseResult<()> {
        self.inner.seek(self.position.get() + u64::from(length))
    }
    fn seek(&mut self, position: u64) -> ParseResult<()> {
        self.inner.seek(position)
    }
    fn position(&self) -> u64 {
        self.position.get()
    }
}
impl Read for GuardRead {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if crate::progress::is_stopping() {
            return Err(io::Error::other("Native core is shutting down"));
        }
        if output.is_empty() {
            return Ok(0);
        }
        let remaining = MAX_DATA.saturating_sub(self.position.get());
        if remaining == 0 {
            let mut probe = [0];
            let count = match &mut self.source {
                Source::Native { reader, .. } => reader.read(&mut probe)?,
                Source::Compressed(reader) => reader.read(&mut probe)?,
            };
            return if count == 0 {
                Ok(0)
            } else {
                Err(io::Error::other(
                    "DICOM expanded data exceeds the input limit",
                ))
            };
        }
        let size = output.len().min(remaining as usize);
        let count = match &mut self.source {
            Source::Native { reader, .. } => reader.read(&mut output[..size])?,
            Source::Compressed(reader) => reader.read(&mut output[..size])?,
        };
        self.position.set(self.position.get() + count as u64);
        Ok(count)
    }
}
impl Seek for GuardRead {
    fn seek(&mut self, request: SeekFrom) -> io::Result<u64> {
        let current = self.position.get();
        let target = match request {
            SeekFrom::Start(value) => value,
            SeekFrom::Current(delta) => current
                .checked_add_signed(delta)
                .ok_or_else(|| io::Error::other("Invalid DICOM seek"))?,
            SeekFrom::End(_) => {
                return Err(io::Error::other("End-relative DICOM seek is unsupported"));
            }
        };
        if target < current || target > MAX_DATA {
            return Err(io::Error::other("DICOM value exceeds the input limit"));
        }
        if let Source::Native {
            reader,
            base,
            length,
        } = &mut self.source
        {
            if target > *length {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "DICOM value extends beyond the file",
                ));
            }
            reader.seek(SeekFrom::Start(*base + target))?;
            self.position.set(target);
        } else {
            let mut scratch = [0; 8192];
            while self.position.get() < target {
                let size = (target - self.position.get()).min(scratch.len() as u64) as usize;
                if self.read(&mut scratch[..size])? == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "Truncated deflated DICOM value",
                    ));
                }
            }
        }
        Ok(target)
    }
}

fn meta_header(reader: &mut impl Read) -> Result<(Tag, u32)> {
    let mut header = [0; 8];
    reader.read_exact(&mut header)?;
    let tag = Tag(
        u16::from_le_bytes(header[0..2].try_into()?),
        u16::from_le_bytes(header[2..4].try_into()?),
    );
    let vr =
        dicom_core::VR::from_binary(header[4..6].try_into()?).context("Invalid file meta VR")?;
    let length = if matches!(
        vr,
        dicom_core::VR::OB
            | dicom_core::VR::OD
            | dicom_core::VR::OF
            | dicom_core::VR::OL
            | dicom_core::VR::OV
            | dicom_core::VR::OW
            | dicom_core::VR::SQ
            | dicom_core::VR::UC
            | dicom_core::VR::UR
            | dicom_core::VR::UT
            | dicom_core::VR::UN
            | dicom_core::VR::SV
            | dicom_core::VR::UV
    ) {
        ensure!(header[6..8] == [0, 0], "Invalid file meta reserved bytes");
        let mut bytes = [0; 4];
        reader.read_exact(&mut bytes)?;
        u32::from_le_bytes(bytes)
    } else {
        u16::from_le_bytes(header[6..8].try_into()?) as u32
    };
    ensure!(length != u32::MAX, "Invalid file meta element");
    Ok((tag, length))
}

fn file_meta(reader: &mut (impl Read + Seek), file_length: u64) -> Result<(String, u64)> {
    let mut magic = [0; 4];
    reader.read_exact(&mut magic)?;
    if magic != *b"DICM" {
        reader.seek(SeekFrom::Start(128))?;
        reader.read_exact(&mut magic)?;
    }
    ensure!(
        magic == *b"DICM",
        coded!("file.notDicom", "Missing DICOM file meta marker")
    );
    let (tag, length) = meta_header(reader)?;
    ensure!(
        tag == Tag(2, 0) && length == 4,
        "Missing or invalid file meta group length"
    );
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    let group_length = u32::from_le_bytes(bytes) as u64;
    ensure!(
        group_length <= MAX_FILE_META,
        "DICOM file meta exceeds 64 KiB"
    );
    let meta_start = reader.stream_position()?;
    let end = meta_start
        .checked_add(group_length)
        .context("File meta length overflow")?;
    ensure!(end <= file_length, "File meta extends beyond the file");
    let mut syntax = None;
    while reader.stream_position()? < end {
        let (tag, length) = meta_header(reader)?;
        let next = reader
            .stream_position()?
            .checked_add(length as u64)
            .context("File meta length overflow")?;
        ensure!(
            next <= file_length && next - meta_start <= MAX_FILE_META,
            "File meta value exceeds its bounded group"
        );
        if tag == Tag(2, 0x10) {
            ensure!(
                syntax.is_none() && length > 0 && length <= 64,
                "Invalid transfer syntax UID"
            );
            let mut bytes = vec![0; length as usize];
            reader.read_exact(&mut bytes)?;
            let value = std::str::from_utf8(&bytes)?.trim_end_matches(['\0', ' ']);
            ensure!(
                !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit() || b == b'.'),
                "Invalid transfer syntax UID"
            );
            syntax = Some(value.to_owned());
        } else {
            reader.seek(SeekFrom::Start(next))?;
        }
    }
    // dicom-object consumes complete elements until the declared group length
    // is reached, including a final element that overshoots an incorrect length.
    Ok((
        syntax.context("Missing transfer syntax UID")?,
        reader.stream_position()?,
    ))
}

#[derive(Default)]
struct Dimensions {
    frames: Option<u64>,
    rows: Option<u64>,
    columns: Option<u64>,
    samples: Option<u64>,
    allocated: Option<u64>,
    stored: Option<u64>,
    high: Option<u64>,
    representation: Option<u64>,
    photometric: Option<String>,
}
fn relevant(tag: Tag) -> bool {
    matches!(
        tag,
        Tag(
            0x0028,
            0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0011 | 0x0100 | 0x0101 | 0x0102 | 0x0103
        )
    )
}
impl Dimensions {
    fn record(&mut self, tag: Tag, value: PrimitiveValue) -> Result<()> {
        let text = value.to_str();
        if tag == Tag(0x0028, 0x0004) {
            ensure!(
                self.photometric.is_none(),
                "Duplicate photometric interpretation"
            );
            self.photometric = Some(text.trim_matches([' ', '\0']).to_owned());
            return Ok(());
        }
        let number: u64 = text
            .trim_matches([' ', '\0'])
            .parse()
            .context("Image dimensions and NumberOfFrames must be integers")?;
        let target = match tag {
            Tag(0x0028, 0x0002) => &mut self.samples,
            Tag(0x0028, 0x0008) => &mut self.frames,
            Tag(0x0028, 0x0010) => &mut self.rows,
            Tag(0x0028, 0x0011) => &mut self.columns,
            Tag(0x0028, 0x0100) => &mut self.allocated,
            Tag(0x0028, 0x0101) => &mut self.stored,
            Tag(0x0028, 0x0102) => &mut self.high,
            Tag(0x0028, 0x0103) => &mut self.representation,
            _ => return Ok(()),
        };
        ensure!(
            target.is_none(),
            "Duplicate image dimension or frame attribute"
        );
        *target = Some(number);
        self.validate()
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            (1..=50_000).contains(&self.frames.unwrap_or(1)),
            "NumberOfFrames must be between 1 and 50000"
        );
        for n in [self.rows, self.columns].into_iter().flatten() {
            ensure!(
                (1..=32768).contains(&n),
                "Rows and Columns must be between 1 and 32768"
            );
        }
        ensure!(
            matches!(self.samples.unwrap_or(1), 1 | 3),
            "SamplesPerPixel must be 1 or 3"
        );
        if let Some(n) = self.allocated {
            ensure!(
                matches!(n, 1 | 8 | 16 | 32 | 64),
                "Unsupported BitsAllocated"
            );
        }
        if let Some(n) = self.stored {
            ensure!(
                n > 0 && n <= self.allocated.unwrap_or(64),
                "Invalid BitsStored"
            );
        }
        if let Some(n) = self.high {
            ensure!(
                n < self.allocated.unwrap_or(64) && n + 1 >= self.stored.unwrap_or(1),
                "Invalid HighBit"
            );
        }
        if let Some(n) = self.representation {
            ensure!(n <= 1, "Invalid PixelRepresentation");
        }
        Ok(())
    }
    fn bytes(&self, tag: Tag) -> Result<u64> {
        self.validate()?;
        let allocated = self
            .allocated
            .context("PixelData is missing BitsAllocated")?;
        if tag == FLOAT_PIXEL {
            ensure!(allocated == 32, "FloatPixelData requires BitsAllocated 32");
        }
        if tag == DOUBLE_PIXEL {
            ensure!(
                allocated == 64,
                "DoubleFloatPixelData requires BitsAllocated 64"
            );
        }
        let mut samples = self.samples.unwrap_or(1);
        if matches!(
            self.photometric.as_deref(),
            Some("YBR_FULL_422" | "YBR_PARTIAL_422")
        ) {
            samples = 2;
        }
        let bits = self
            .rows
            .context("PixelData is missing Rows")?
            .checked_mul(self.columns.context("PixelData is missing Columns")?)
            .and_then(|v| v.checked_mul(self.frames.unwrap_or(1)))
            .and_then(|v| v.checked_mul(samples))
            .and_then(|v| v.checked_mul(allocated))
            .context("Decoded image size overflow")?;
        let bytes = bits.div_ceil(8);
        ensure!(
            bytes > 0 && bytes <= MAX_PIXELS,
            "Decoded pixel data exceeds the {PIXEL_LIMIT} input limit"
        );
        Ok(bytes)
    }
}

#[derive(Clone, Copy)]
enum Container {
    Sequence { pixel: bool },
    Item { pixel: bool },
}
struct Encapsulated {
    items: usize,
    fragments: usize,
    bytes: u64,
    limit: u64,
    offsets: Vec<u64>,
    matched_offsets: usize,
    fragment_cursor: u64,
    lengths: Option<Vec<u64>>,
    current_pad: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum ScanMode {
    Complete,
    Metadata,
}

fn add_metadata(total: &mut u64, amount: u64) -> Result<()> {
    *total = total
        .checked_add(amount)
        .context("Metadata size overflow")?;
    ensure!(*total <= MAX_META, "DICOM metadata exceeds 32 MiB");
    Ok(())
}

pub fn inspect(path: &Path) -> Result<InputInfo> {
    open_checked(path).map(|(info, _)| info)
}

pub fn open_checked(path: &Path) -> Result<(InputInfo, File)> {
    open_with_mode(path, ScanMode::Complete)
}

pub fn open_metadata_checked(path: &Path) -> Result<(InputInfo, File)> {
    open_with_mode(path, ScanMode::Metadata)
}

fn open_with_mode(path: &Path, mode: ScanMode) -> Result<(InputInfo, File)> {
    let mut file = File::open(path)?;
    let before = file.metadata()?;
    let info = inspect_stream(file.try_clone()?, before.len(), mode)?;
    let after = file.metadata()?;
    ensure!(
        before.len() == after.len() && before.modified().ok() == after.modified().ok(),
        "DICOM source changed during validation"
    );
    file.seek(SeekFrom::Start(0))?;
    Ok((info, file))
}

pub fn inspect_reader(reader: impl Read + Seek + 'static, len: u64) -> Result<InputInfo> {
    inspect_stream(reader, len, ScanMode::Complete)
}

fn inspect_stream(
    file: impl Read + Seek + 'static,
    file_length: u64,
    mode: ScanMode,
) -> Result<InputInfo> {
    ensure!(
        file_length <= MAX_FILE_SIZE,
        coded!("file.tooLarge", "DICOM source exceeds the input size limit")
    );
    let mut reader = BufReader::new(file);
    let (uid, data_start) = file_meta(&mut reader, file_length)?;
    let syntax = TransferSyntaxRegistry
        .get(&uid)
        .context("Unknown DICOM transfer syntax")?;
    let source = match syntax.codec() {
        Codec::Dataset(Some(adapter)) => Source::Compressed(adapter.adapt_reader(Box::new(reader))),
        Codec::Dataset(None) => bail!("Unsupported encoded DICOM dataset"),
        _ => Source::Native {
            reader: Box::new(reader),
            base: data_start,
            length: file_length - data_start,
        },
    };
    let position = Rc::new(Cell::new(0));
    let guarded = GuardRead {
        source,
        position: position.clone(),
    };
    let decoder =
        DynStatefulDecoder::new_with(guarded, syntax, SpecificCharacterSet::default(), 0)?;
    let mut parser = LazyDataSetReader::new(GuardDecoder {
        inner: decoder,
        position: position.clone(),
    });
    let mut dimensions = Dimensions::default();
    let mut containers = Vec::<Container>::new();
    let mut metadata = data_start;
    let mut count = 0usize;
    let mut pixel_seen = false;
    let mut compressed: Option<Encapsulated> = None;
    let mut extended_offsets: Option<Vec<u64>> = None;
    let mut extended_lengths: Option<Vec<u64>> = None;
    loop {
        ensure!(
            !crate::progress::is_stopping(),
            "Native core is shutting down"
        );
        let before = position.get();
        let Some(token) = parser.advance() else {
            break;
        };
        let token = token.context("Invalid DICOM structure")?;
        add_metadata(&mut metadata, position.get() - before)?;
        if mode == ScanMode::Metadata && containers.is_empty() {
            let cutoff = Tag(0x7fe0, 0x0000);
            if match &token {
                LazyDataToken::ElementHeader(header) => header.tag >= cutoff,
                LazyDataToken::SequenceStart { tag, .. } => *tag >= cutoff,
                LazyDataToken::PixelSequenceStart => true,
                _ => false,
            } {
                break;
            }
        }
        match token {
            LazyDataToken::ElementHeader(header) => {
                count += 1;
                if containers.is_empty() && matches!(header.tag, PIXEL | FLOAT_PIXEL | DOUBLE_PIXEL)
                {
                    ensure!(
                        extended_offsets.is_none() && extended_lengths.is_none(),
                        "Extended Offset Table requires encapsulated PixelData"
                    );
                    ensure!(!pixel_seen, "Multiple root pixel data elements");
                    pixel_seen = true;
                    let expected = dimensions.bytes(header.tag)?;
                    let length = u64::from(
                        header
                            .len
                            .get()
                            .context("Undefined native pixel data length")?,
                    );
                    ensure!(
                        length == expected || (expected % 2 == 1 && length == expected + 1),
                        "PixelData length does not match Rows, Columns, and NumberOfFrames"
                    );
                } else {
                    let length = u64::from(
                        header
                            .len
                            .get()
                            .context("Undefined primitive value length")?,
                    );
                    ensure!(length <= MAX_VALUE, "DICOM element value exceeds 1 MiB");
                    if containers.is_empty()
                        && matches!(header.tag, EXTENDED_OFFSETS | EXTENDED_LENGTHS)
                    {
                        ensure!(
                            !pixel_seen && header.vr == dicom_core::VR::OV,
                            "Extended Offset Table must precede PixelData and use OV"
                        );
                        ensure!(
                            length == dimensions.frames.unwrap_or(1) * 8,
                            "Extended Offset Table count does not match NumberOfFrames"
                        );
                    }
                    if containers.is_empty() && relevant(header.tag) {
                        ensure!(
                            !pixel_seen && length <= 64,
                            "Image dimensions must precede PixelData and have bounded values"
                        );
                    }
                }
            }
            LazyDataToken::SequenceStart { tag, len: _ } => {
                ensure!(
                    !containers.is_empty() || !matches!(tag, EXTENDED_OFFSETS | EXTENDED_LENGTHS),
                    "Extended Offset Table must be a primitive OV value"
                );
                ensure!(
                    !matches!(tag, PIXEL | FLOAT_PIXEL | DOUBLE_PIXEL),
                    "Malformed pixel data sequence"
                );
                count += 1;
                containers.push(Container::Sequence { pixel: false });
            }
            LazyDataToken::PixelSequenceStart => {
                count += 1;
                if containers.is_empty() {
                    ensure!(!pixel_seen, "Duplicate encapsulated PixelData");
                    pixel_seen = true;
                    let (offsets, lengths) = match (
                        extended_offsets.take(),
                        extended_lengths.take(),
                    ) {
                        (Some(offsets), Some(lengths)) => {
                            let frames = dimensions.frames.unwrap_or(1) as usize;
                            ensure!(
                                offsets.len() == frames && lengths.len() == frames,
                                "Extended Offset Table count does not match final NumberOfFrames"
                            );
                            (offsets, Some(lengths))
                        }
                        (None, None) => (Vec::new(), None),
                        _ => {
                            bail!("Extended Offset Table and Lengths must be present together")
                        }
                    };
                    let decoded = dimensions.bytes(PIXEL)?;
                    let overhead = dimensions
                        .frames
                        .unwrap_or(1)
                        .checked_mul(65536)
                        .context("Frame count overflow")?;
                    let limit = (decoded.saturating_mul(2).saturating_add(overhead))
                        .clamp(16 * 1024 * 1024, MAX_PIXELS);
                    compressed = Some(Encapsulated {
                        items: 0,
                        fragments: 0,
                        bytes: 0,
                        limit,
                        offsets,
                        matched_offsets: 0,
                        fragment_cursor: 0,
                        lengths,
                        current_pad: false,
                    });
                }
                containers.push(Container::Sequence { pixel: true });
            }
            LazyDataToken::ItemStart { len } => {
                count += 1;
                let pixel = matches!(containers.last(), Some(Container::Sequence { pixel: true }));
                ensure!(
                    matches!(containers.last(), Some(Container::Sequence { .. })),
                    "DICOM item is outside a sequence"
                );
                if pixel {
                    let length =
                        u64::from(len.get().context("Undefined compressed fragment length")?);
                    if let Some(compressed) = compressed.as_mut() {
                        if compressed.items == 0 {
                            ensure!(
                                compressed.lengths.is_none() || length == 0,
                                "Basic Offset Table must be empty when Extended Offset Table is present"
                            );
                            ensure!(
                                length % 4 == 0
                                    && (length == 0
                                        || length / 4 == dimensions.frames.unwrap_or(1)),
                                "Basic Offset Table does not match NumberOfFrames"
                            );
                        } else {
                            ensure!(
                                length > 0 && length % 2 == 0,
                                "Invalid compressed fragment length"
                            );
                            compressed.current_pad = false;
                            if let Some(lengths) = &compressed.lengths {
                                let declared = *lengths.get(compressed.fragments).context(
                                    "Extended Offset Table requires one fragment per frame",
                                )?;
                                ensure!(
                                    compressed.offsets[compressed.fragments]
                                        == compressed.fragment_cursor,
                                    "Extended Offset Table does not match fragment boundaries"
                                );
                                ensure!(
                                    declared > 0
                                        && (declared == length
                                            || (declared % 2 == 1
                                                && declared.checked_add(1) == Some(length))),
                                    "Extended Offset Table Lengths do not match frame payload lengths"
                                );
                                compressed.current_pad = declared != length;
                            }
                            compressed.fragments += 1;
                            if let Some(&offset) =
                                compressed.offsets.get(compressed.matched_offsets)
                            {
                                ensure!(
                                    offset >= compressed.fragment_cursor,
                                    "Basic Offset Table points inside a fragment"
                                );
                                if offset == compressed.fragment_cursor {
                                    compressed.matched_offsets += 1;
                                }
                            }
                            compressed.fragment_cursor = compressed
                                .fragment_cursor
                                .checked_add(8 + length)
                                .context("Compressed fragment offset overflow")?;
                        }
                        compressed.items += 1;
                        compressed.bytes = compressed
                            .bytes
                            .checked_add(length)
                            .context("Compressed pixel size overflow")?;
                        ensure!(
                            compressed.bytes <= compressed.limit,
                            "Compressed PixelData exceeds its bounded image budget"
                        );
                    } else {
                        ensure!(length <= MAX_VALUE, "Nested pixel fragment exceeds 1 MiB");
                        add_metadata(&mut metadata, length)?;
                    }
                } else if let Some(length) = len.get() {
                    ensure!(
                        u64::from(length) <= MAX_META,
                        "DICOM item exceeds the metadata limit"
                    );
                }
                containers.push(Container::Item { pixel });
            }
            LazyDataToken::ItemEnd => {
                ensure!(
                    matches!(containers.pop(), Some(Container::Item { .. })),
                    "Unbalanced DICOM item"
                );
            }
            LazyDataToken::SequenceEnd => {
                let pixel = match containers.pop() {
                    Some(Container::Sequence { pixel }) => pixel,
                    _ => bail!("Unbalanced DICOM sequence"),
                };
                if pixel && containers.is_empty() {
                    let compressed = compressed.take().context("Missing pixel sequence")?;
                    let frames = dimensions.frames.unwrap_or(1) as usize;
                    ensure!(
                        compressed.matched_offsets == compressed.offsets.len(),
                        "Basic Offset Table does not match fragment boundaries"
                    );
                    ensure!(
                        compressed.lengths.is_none() || compressed.fragments == frames,
                        "Extended Offset Table requires one fragment per frame"
                    );
                    ensure!(
                        compressed.fragments >= frames,
                        "Compressed PixelData has fewer fragments than NumberOfFrames"
                    );
                    if uid == "1.2.840.10008.1.2.5" {
                        ensure!(
                            compressed.fragments == frames,
                            "RLE PixelData requires one fragment per frame"
                        );
                    }
                }
            }
            LazyDataToken::LazyValue { header, decoder } => {
                let length = u64::from(header.len.get().context("Undefined primitive length")?);
                let bulk = containers.is_empty()
                    && matches!(header.tag, PIXEL | FLOAT_PIXEL | DOUBLE_PIXEL);
                if !bulk {
                    add_metadata(&mut metadata, length)?;
                }
                if containers.is_empty()
                    && matches!(header.tag, EXTENDED_OFFSETS | EXTENDED_LENGTHS)
                {
                    let target = if header.tag == EXTENDED_OFFSETS {
                        &mut extended_offsets
                    } else {
                        &mut extended_lengths
                    };
                    ensure!(
                        target.is_none(),
                        "Duplicate Extended Offset Table attribute"
                    );
                    let mut bytes = Vec::new();
                    decoder.read_to_vec(length as u32, &mut bytes)?;
                    ensure!(
                        bytes.len() as u64 == length,
                        "Truncated Extended Offset Table"
                    );
                    let values: Vec<u64> = bytes
                        .as_chunks::<8>()
                        .0
                        .iter()
                        .map(|&word| {
                            if syntax.endianness() == dicom_encoding::Endianness::Big {
                                u64::from_be_bytes(word)
                            } else {
                                u64::from_le_bytes(word)
                            }
                        })
                        .collect();
                    if header.tag == EXTENDED_OFFSETS {
                        ensure!(
                            values.first() == Some(&0) && values.windows(2).all(|v| v[0] < v[1]),
                            "Extended Offset Table must start at zero and increase strictly"
                        );
                    } else {
                        ensure!(
                            values.iter().all(|&v| v > 0 && v <= MAX_PIXELS),
                            "Invalid Extended Offset Table frame length"
                        );
                    }
                    *target = Some(values);
                } else if containers.is_empty() && relevant(header.tag) {
                    let value = decoder.read_value_preserved(&header)?;
                    ensure!(
                        position.get() - before == length,
                        "Truncated image attribute"
                    );
                    dimensions.record(header.tag, value)?;
                } else {
                    decoder.seek(
                        position
                            .get()
                            .checked_add(length)
                            .context("Value offset overflow")?,
                    )?;
                }
            }
            LazyDataToken::LazyItemValue { len, decoder } => {
                ensure!(
                    matches!(containers.last(), Some(Container::Item { pixel: true })),
                    "Unexpected DICOM item value"
                );
                if let Some(compressed) = compressed.as_mut().filter(|c| c.items == 1) {
                    let mut table = Vec::new();
                    decoder.read_to_vec(len, &mut table)?;
                    ensure!(table.len() == len as usize, "Truncated Basic Offset Table");
                    compressed.offsets = table
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|&v| u64::from(u32::from_le_bytes(v)))
                        .collect();
                    ensure!(
                        compressed.offsets.first().is_none_or(|v| *v == 0)
                            && compressed.offsets.windows(2).all(|v| v[0] < v[1]),
                        "Basic Offset Table must start at zero and increase strictly"
                    );
                } else if compressed.as_ref().is_some_and(|c| c.current_pad) {
                    let end = position
                        .get()
                        .checked_add(u64::from(len))
                        .context("Fragment offset overflow")?;
                    decoder.seek(end - 1)?;
                    let mut pad = Vec::new();
                    decoder.read_to_vec(1, &mut pad)?;
                    ensure!(
                        pad == [0],
                        "Extended Offset Table odd frame length requires a zero pad byte"
                    );
                } else {
                    decoder.seek(
                        position
                            .get()
                            .checked_add(u64::from(len))
                            .context("Fragment offset overflow")?,
                    )?;
                }
            }
            _ => bail!("Unsupported DICOM token"),
        }
        ensure!(
            count <= MAX_ELEMENTS,
            "DICOM contains more than 200000 elements and items"
        );
        ensure!(
            containers
                .iter()
                .filter(|v| matches!(v, Container::Sequence { .. }))
                .count()
                <= MAX_DEPTH,
            "DICOM sequence nesting exceeds 32 levels"
        );
    }
    ensure!(
        containers.is_empty() && compressed.is_none(),
        "Truncated DICOM sequence"
    );
    dimensions.validate()?;
    ensure!(
        extended_offsets.is_none() && extended_lengths.is_none(),
        "Extended Offset Table requires paired arrays and encapsulated PixelData"
    );
    Ok(InputInfo {
        frames: dimensions.frames.unwrap_or(1) as usize,
        metadata_bytes: metadata as usize,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn header(tag: Tag, vr: &[u8; 2], length: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend(tag.0.to_le_bytes());
        bytes.extend(tag.1.to_le_bytes());
        bytes.extend(vr);
        if matches!(vr, b"OB" | b"OW" | b"OF" | b"OD" | b"OV" | b"SQ" | b"UN") {
            bytes.extend([0, 0]);
            bytes.extend(length.to_le_bytes());
        } else {
            bytes.extend((length as u16).to_le_bytes());
        }
        bytes
    }
    fn element(tag: Tag, vr: &[u8; 2], value: &[u8]) -> Vec<u8> {
        let mut bytes = header(tag, vr, value.len() as u32);
        bytes.extend(value);
        bytes
    }
    fn marker(element: u16, length: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend(0xfffeu16.to_le_bytes());
        bytes.extend(element.to_le_bytes());
        bytes.extend(length.to_le_bytes());
        bytes
    }
    fn image(frames: &str, pixels: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (tag, value) in [
            (Tag(0x28, 2), 1u16),
            (Tag(0x28, 0x10), 1),
            (Tag(0x28, 0x11), 1),
            (Tag(0x28, 0x100), 16),
        ] {
            bytes.extend(element(tag, b"US", &value.to_le_bytes()));
        }
        let mut count = frames.as_bytes().to_vec();
        if !count.len().is_multiple_of(2) {
            count.push(b' ');
        }
        bytes.extend(element(Tag(0x28, 8), b"IS", &count));
        bytes.extend(element(PIXEL, b"OW", pixels));
        bytes
    }
    fn nested(depth: usize, private_un: bool) -> Vec<u8> {
        let mut bytes = Vec::new();
        for _ in 0..depth {
            bytes.extend(header(
                Tag(0x11, 0x1010),
                if private_un { b"UN" } else { b"SQ" },
                u32::MAX,
            ));
            bytes.extend(marker(0xe000, u32::MAX));
        }
        bytes.extend(element(Tag(0x11, 0x1011), b"LO", b"ok"));
        for _ in 0..depth {
            bytes.extend(marker(0xe00d, 0));
            bytes.extend(marker(0xe0dd, 0));
        }
        bytes
    }
    fn file_bytes(dataset: &[u8], deflated: bool, preamble: bool) -> Vec<u8> {
        let syntax = if deflated {
            "1.2.840.10008.1.2.1.99"
        } else {
            "1.2.840.10008.1.2.1"
        };
        file_bytes_syntax(dataset, syntax, preamble)
    }
    fn file_bytes_syntax(dataset: &[u8], syntax: &str, preamble: bool) -> Vec<u8> {
        let mut meta = element(Tag(2, 1), b"OB", &[0, 1]);
        for (tag, value) in [
            (Tag(2, 2), "1.2.840.10008.5.1.4.1.1.2"),
            (Tag(2, 3), "2.25.42"),
            (Tag(2, 0x10), syntax),
            (Tag(2, 0x12), "2.25.43"),
        ] {
            let mut value = value.as_bytes().to_vec();
            if value.len() % 2 != 0 {
                value.push(0);
            }
            meta.extend(element(tag, b"UI", &value));
        }
        let mut output = if preamble { vec![0; 128] } else { Vec::new() };
        output.extend(b"DICM");
        output.extend(element(
            Tag(2, 0),
            b"UL",
            &(meta.len() as u32).to_le_bytes(),
        ));
        output.extend(meta);
        if syntax == "1.2.840.10008.1.2.1.99" {
            let mut encoder =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
            encoder.write_all(dataset).unwrap();
            output.extend(encoder.finish().unwrap());
        } else {
            output.extend(dataset);
        }
        output
    }
    fn check(bytes: &[u8]) -> Result<InputInfo> {
        let dir = crate::test_dir::tempdir()?;
        let path = dir.path().join("input.dcm");
        std::fs::write(&path, bytes)?;
        inspect(&path)
    }
    fn rejection(bytes: &[u8], expected: &str) {
        let error = format!("{:#}", check(bytes).unwrap_err());
        assert!(error.contains(expected), "{error}");
    }

    #[test]
    fn valid_native_and_deflated_with_both_preamble_forms_pass() {
        for deflated in [false, true] {
            for preamble in [false, true] {
                let info =
                    check(&file_bytes(&image("2", &[1, 0, 2, 0]), deflated, preamble)).unwrap();
                assert_eq!(info.frames, 2);
                assert!(info.metadata_bytes > 100 && info.metadata_bytes < 1000);
            }
        }
    }
    #[test]
    fn checked_handle_is_rewound_and_parses_with_both_preamble_forms() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("checked.dcm");
        for preamble in [false, true] {
            std::fs::write(&path, file_bytes(&image("1", &[42, 0]), false, preamble)).unwrap();
            let (info, file) = open_checked(&path).unwrap();
            assert_eq!(info.frames, 1);
            let object = dicom_object::OpenFileOptions::new()
                .from_reader(file)
                .unwrap();
            assert_eq!(
                object.element(PIXEL).unwrap().to_bytes().unwrap().as_ref(),
                [42, 0]
            );
        }
    }
    #[test]
    fn overstated_meta_group_length_matches_bounded_object_parser_behavior() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("overstated-meta.dcm");
        let mut dataset = element(Tag(8, 0x16), b"UI", b"1.2.840.10008.5.1.4.1.1.2\0");
        dataset.extend(image("1", &[42, 0]));
        for preamble in [false, true] {
            let mut bytes = file_bytes(&dataset, false, preamble);
            let length_at = if preamble { 140 } else { 12 };
            let declared = u32::from_le_bytes(bytes[length_at..length_at + 4].try_into().unwrap());
            bytes[length_at..length_at + 4].copy_from_slice(&(declared + 8).to_le_bytes());
            std::fs::write(&path, bytes).unwrap();
            let (info, file) = open_checked(&path).unwrap();
            assert_eq!(info.frames, 1);
            let object = dicom_object::OpenFileOptions::new()
                .from_reader(file)
                .unwrap();
            assert!(object.get(Tag(8, 0x16)).is_none());
            assert_eq!(
                object.element(PIXEL).unwrap().to_bytes().unwrap().as_ref(),
                [42, 0]
            );
        }
    }
    #[test]
    fn meta_group_length_overshoot_remains_bounded_by_actual_bytes() {
        let mut dataset = element(Tag(0x11, 0x1010), b"OB", &vec![0; MAX_FILE_META as usize]);
        dataset.extend(image("1", &[42, 0]));
        let mut bytes = file_bytes(&dataset, false, true);
        let declared = u32::from_le_bytes(bytes[140..144].try_into().unwrap());
        bytes[140..144].copy_from_slice(&(declared + 8).to_le_bytes());
        rejection(&bytes, "File meta value exceeds its bounded group");
    }
    #[test]
    fn checked_handle_survives_a_later_path_replacement() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("checked.dcm");
        std::fs::write(&path, file_bytes(&image("1", &[42, 0]), false, true)).unwrap();
        let (_, file) = open_checked(&path).unwrap();
        std::fs::rename(&path, dir.path().join("original.dcm")).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        let object = dicom_object::OpenFileOptions::new()
            .from_reader(file)
            .unwrap();
        assert_eq!(
            object.element(PIXEL).unwrap().to_bytes().unwrap().as_ref(),
            [42, 0]
        );
        assert!(inspect(&path).is_err());
    }
    #[test]
    fn nesting_is_bounded_before_and_after_pixel_data_including_deflate() {
        for deflated in [false, true] {
            let mut valid = nested(32, false);
            valid.extend(image("1", &[1, 0]));
            check(&file_bytes(&valid, deflated, true)).unwrap();
            for after in [false, true] {
                let mut bytes = if after {
                    image("1", &[1, 0])
                } else {
                    Vec::new()
                };
                bytes.extend(nested(1000, false));
                rejection(&file_bytes(&bytes, deflated, true), "nesting exceeds 32");
            }
        }
    }
    #[test]
    fn private_undefined_un_sequences_remain_accepted() {
        let mut bytes = nested(2, true);
        bytes.extend(image("1", &[1, 0]));
        check(&file_bytes(&bytes, false, true)).unwrap();
    }
    #[test]
    fn fake_frames_and_invalid_frame_numbers_are_rejected() {
        for frames in ["0", "-1", "50001", "1.5", "999999999999999999999999999"] {
            assert!(check(&file_bytes(&image(frames, &[1, 0]), false, true)).is_err());
        }
        for deflated in [false, true] {
            rejection(
                &file_bytes(&image("50000", &[1, 0]), deflated, true),
                "PixelData length does not match",
            );
        }
    }
    #[test]
    fn declared_values_are_rejected_before_allocation() {
        let oversized = header(Tag(0x11, 0x1010), b"OB", (MAX_VALUE + 2) as u32);
        for deflated in [false, true] {
            rejection(&file_bytes(&oversized, deflated, true), "exceeds 1 MiB");
        }
        let mut meta = file_bytes(&image("1", &[1, 0]), false, true);
        meta[140..144].copy_from_slice(&u32::MAX.to_le_bytes());
        rejection(&meta, "file meta exceeds");
        let mut meta = file_bytes(&image("1", &[1, 0]), false, true);
        meta[152..156].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(check(&meta).is_err());
    }
    #[test]
    fn truncated_native_and_deflated_pixel_values_fail() {
        let mut data = image("2", &[1, 0, 2, 0]);
        data.truncate(data.len() - 2);
        for deflated in [false, true] {
            let error = format!(
                "{:#}",
                check(&file_bytes(&data, deflated, true)).unwrap_err()
            );
            assert!(
                error.contains("beyond the file") || error.contains("Truncated deflated"),
                "{error}"
            );
        }
    }
    #[test]
    fn oversized_metadata_sum_and_element_count_fail() {
        let mut data = Vec::new();
        let value = vec![0; MAX_VALUE as usize];
        for _ in 0..33 {
            data.extend(element(Tag(0x11, 0x1010), b"OB", &value));
        }
        rejection(&file_bytes(&data, false, true), "metadata exceeds 32 MiB");
        let mut data = header(Tag(0x11, 0x1010), b"SQ", u32::MAX);
        for _ in 0..MAX_ELEMENTS {
            data.extend(marker(0xe000, 0));
        }
        data.extend(marker(0xe0dd, 0));
        rejection(&file_bytes(&data, false, true), "more than 200000");
    }
    #[test]
    fn truncated_sequences_and_late_dimensions_fail() {
        let mut data = nested(2, false);
        data.truncate(data.len() - 8);
        assert!(check(&file_bytes(&data, false, true)).is_err());
        let mut data = image("1", &[1, 0]);
        data.extend(element(Tag(0x28, 8), b"IS", b"42"));
        rejection(&file_bytes(&data, false, true), "must precede PixelData");
    }
    #[test]
    fn odd_native_payload_accepts_only_the_required_pad() {
        let mut data = Vec::new();
        for (tag, n) in [
            (Tag(0x28, 2), 1u16),
            (Tag(0x28, 0x10), 1),
            (Tag(0x28, 0x11), 1),
            (Tag(0x28, 0x100), 8),
        ] {
            data.extend(element(tag, b"US", &n.to_le_bytes()));
        }
        let mut valid = data.clone();
        valid.extend(element(PIXEL, b"OB", &[123, 0]));
        check(&file_bytes(&valid, false, true)).unwrap();
        data.extend(element(PIXEL, b"OB", &[1, 2, 3, 4]));
        rejection(
            &file_bytes(&data, false, true),
            "PixelData length does not match",
        );
    }

    fn encapsulated(frames: &str, fragments: &[&[u8]]) -> Vec<u8> {
        let mut bytes = image(frames, &[0, 0]);
        bytes.truncate(bytes.len() - 14);
        bytes.extend(header(PIXEL, b"OB", u32::MAX));
        bytes.extend(marker(0xe000, 0));
        for fragment in fragments {
            bytes.extend(marker(0xe000, fragment.len() as u32));
            bytes.extend_from_slice(fragment);
        }
        bytes.extend(marker(0xe0dd, 0));
        bytes
    }
    fn rle_file(dataset: &[u8]) -> Vec<u8> {
        let mut bytes = file_bytes(dataset, false, true);
        let original = b"1.2.840.10008.1.2.1";
        let at = bytes
            .windows(original.len())
            .position(|window| window == original)
            .unwrap();
        bytes[at + original.len() - 1] = b'5';
        bytes
    }
    #[test]
    fn compressed_frames_have_bounded_fragments_and_consistent_frame_counts() {
        let valid = rle_file(&encapsulated("2", &[&[1, 2], &[3, 4]]));
        assert_eq!(check(&valid).unwrap().frames, 2);
        rejection(
            &rle_file(&encapsulated("50000", &[&[1, 2]])),
            "fewer fragments than NumberOfFrames",
        );
        let mut data = encapsulated("1", &[]);
        data.truncate(data.len() - 8);
        data.extend(marker(0xe000, 20 * 1024 * 1024));
        rejection(&rle_file(&data), "bounded image budget");
        let mut data = encapsulated("2", &[]);
        data.truncate(data.len() - 16);
        data.extend(marker(0xe000, 4));
        data.extend([0; 4]);
        rejection(&rle_file(&data), "Basic Offset Table does not match");
    }
    #[test]
    fn compressed_thumbnail_sequences_are_bounded_metadata() {
        let mut data = header(Tag(0x88, 0x200), b"SQ", u32::MAX);
        data.extend(marker(0xe000, u32::MAX));
        data.extend(header(PIXEL, b"OB", u32::MAX));
        data.extend(marker(0xe000, 0));
        data.extend(marker(0xe000, 2));
        data.extend([1, 2]);
        data.extend(marker(0xe0dd, 0));
        data.extend(marker(0xe00d, 0));
        data.extend(marker(0xe0dd, 0));
        data.extend(image("1", &[1, 0]));
        check(&file_bytes(&data, false, true)).unwrap();
    }

    fn offset_file(
        frames: usize,
        fragments: &[&[u8]],
        bot: &[u32],
        eot: Option<&[u64]>,
        lengths: Option<&[u64]>,
    ) -> Vec<u8> {
        let mut bytes = image(&frames.to_string(), &[0, 0]);
        bytes.truncate(bytes.len() - 14);
        for (tag, table) in [(EXTENDED_OFFSETS, eot), (EXTENDED_LENGTHS, lengths)] {
            if let Some(table) = table {
                let raw: Vec<u8> = table.iter().flat_map(|v| v.to_le_bytes()).collect();
                bytes.extend(element(tag, b"OV", &raw));
            }
        }
        bytes.extend(header(PIXEL, b"OB", u32::MAX));
        bytes.extend(marker(0xe000, (bot.len() * 4) as u32));
        for offset in bot {
            bytes.extend(offset.to_le_bytes());
        }
        for fragment in fragments {
            bytes.extend(marker(0xe000, fragment.len() as u32));
            bytes.extend_from_slice(fragment);
        }
        bytes.extend(marker(0xe0dd, 0));
        file_bytes_syntax(&bytes, "1.2.840.10008.1.2.4.80", true)
    }
    #[test]
    fn basic_offsets_reject_duplicates_and_non_frame_boundaries() {
        let fragments: [&[u8]; 4] = [&[1, 2], &[3, 4], &[5, 6], &[7, 8]];
        assert_eq!(
            check(&offset_file(2, &fragments, &[0, 20], None, None))
                .unwrap()
                .frames,
            2
        );
        for table in [[0, 0], [1, 20], [20, 0], [0, 14], [0, 40], [0, u32::MAX]] {
            assert!(
                check(&offset_file(2, &fragments, &table, None, None)).is_err(),
                "accepted {table:?}"
            );
        }
    }
    #[test]
    fn extended_offsets_accept_padded_and_odd_unpadded_lengths() {
        let fragments: [&[u8]; 2] = [&[1, 2, 3, 0], &[4, 5]];
        for lengths in [[4, 2], [3, 2]] {
            assert_eq!(
                check(&offset_file(
                    2,
                    &fragments,
                    &[],
                    Some(&[0, 12]),
                    Some(&lengths)
                ))
                .unwrap()
                .frames,
                2
            );
        }
        let badpad: [&[u8]; 2] = [&[1, 2, 3, 9], &[4, 5]];
        rejection(
            &offset_file(2, &badpad, &[], Some(&[0, 12]), Some(&[3, 2])),
            "zero pad byte",
        );
    }
    #[test]
    fn extended_offsets_require_complete_bounded_and_consistent_tables() {
        let fragments: [&[u8]; 2] = [&[1, 2, 3, 0], &[4, 5]];
        let cases = [
            offset_file(2, &fragments, &[], Some(&[0, 0]), Some(&[4, 2])),
            offset_file(2, &fragments, &[], Some(&[0, 11]), Some(&[4, 2])),
            offset_file(2, &fragments, &[], Some(&[0, 14]), Some(&[4, 2])),
            offset_file(2, &fragments, &[], Some(&[0, 12]), Some(&[2, 2])),
            offset_file(2, &fragments, &[], Some(&[0, 12]), Some(&[4, 0])),
            offset_file(2, &fragments, &[], Some(&[0, 12]), None),
            offset_file(2, &fragments, &[], None, Some(&[4, 2])),
            offset_file(2, &fragments, &[], Some(&[0]), Some(&[4, 2])),
            offset_file(2, &fragments, &[0, 12], Some(&[0, 12]), Some(&[4, 2])),
            offset_file(
                2,
                &[&[1, 2], &[3, 4], &[5, 6]],
                &[],
                Some(&[0, 10]),
                Some(&[2, 2]),
            ),
        ];
        for (index, bytes) in cases.iter().enumerate() {
            assert!(check(bytes).is_err(), "accepted malformed EOT case {index}");
        }
        let mut oversized = image("1", &[1, 0]);
        oversized.truncate(oversized.len() - 14);
        oversized.extend(header(EXTENDED_OFFSETS, b"OV", 400_000));
        rejection(
            &file_bytes(&oversized, false, true),
            "count does not match NumberOfFrames",
        );
    }
    #[test]
    fn extended_tables_recheck_frame_count_after_out_of_order_metadata() {
        let mut data = image("1", &[0, 0]);
        let count_header = header(Tag(0x28, 8), b"IS", 2);
        let at = data
            .windows(count_header.len())
            .position(|v| v == count_header)
            .unwrap();
        data.truncate(at);
        data.extend(element(EXTENDED_OFFSETS, b"OV", &0u64.to_le_bytes()));
        data.extend(element(Tag(0x28, 8), b"IS", b"2 "));
        data.extend(element(
            EXTENDED_LENGTHS,
            b"OV",
            &[2u64.to_le_bytes(), 2u64.to_le_bytes()].concat(),
        ));
        data.extend(header(PIXEL, b"OB", u32::MAX));
        data.extend(marker(0xe000, 0));
        for _ in 0..2 {
            data.extend(marker(0xe000, 2));
            data.extend([1, 2]);
        }
        data.extend(marker(0xe0dd, 0));
        rejection(
            &file_bytes_syntax(&data, "1.2.840.10008.1.2.4.80", true),
            "final NumberOfFrames",
        );
    }
    #[test]
    fn metadata_only_handles_truncated_pixels_but_rejects_prior_deep_sequences() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("metadata.dcm");
        for deflated in [false, true] {
            let mut bytes = image("1", &[42, 0]);
            bytes.truncate(bytes.len() - 2);
            std::fs::write(&path, file_bytes(&bytes, deflated, true)).unwrap();
            let (_, file) = open_metadata_checked(&path).unwrap();
            let object = dicom_object::OpenFileOptions::new()
                .read_until(Tag(0x7fe0, 0))
                .from_reader(file)
                .unwrap();
            assert!(object.get(Tag(0x28, 0x10)).is_some());
            assert!(open_checked(&path).is_err());
            let mut deep = nested(33, false);
            deep.extend(bytes);
            std::fs::write(&path, file_bytes(&deep, deflated, true)).unwrap();
            assert!(
                format!("{:#}", open_metadata_checked(&path).unwrap_err())
                    .contains("nesting exceeds 32")
            );
        }
    }
}
