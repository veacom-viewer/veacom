//! PNG, JPEG and BMP pictures, decoded outside the engine. The engine runs with the user's full rights, so it parses no
//! image format but DICOM: it hands a picture's bytes to the desktop app, which reads them with Chromium's own decoders
//! in sandboxed renderers of their own (electron/picture-decoder.cjs) and sends back the size (read from the header
//! alone, as an import asks it) or the samples. Here a picture is only told apart by its first bytes, so no other
//! decoder ever sees a file the user opened.
//!
//! The desktop app takes each picture with the `pictureNext` pipe operation and replies with `pictureAnswer`.
//! The engine thread that asked waits in `decode` until then. Answers carry four samples
//! a pixel, as Chromium reads them back, and the alpha samples are dropped here: in JavaScript that cost more than the
//! decoding.
//!
//! In the browser the decoder is a Worker of the page on the engine's shared memory (web/engine/src/pictures.rs), which
//! takes and answers pictures through the same calls.

use crate::clock::Instant;
use anyhow::{Context, Result, bail};
use std::{
    collections::{BTreeMap, VecDeque},
    io::Read,
    path::Path,
    sync::{
        Condvar, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

/// Maximum encoded size of one picture.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Files share this allowance from the first allocation through the decoder's reply. A larger file runs alone.
const IN_FLIGHT_BYTES: usize = 16 * 1024 * 1024;
const PROBE_BYTES: usize = 64 * 1024;
/// RGB samples a picture may have: decode.rs's frame limit.
pub const MAX_SAMPLES: usize = 64 * 1024 * 1024;
/// The largest answer: a picture at that limit, with an alpha sample to each pixel.
pub const MAX_ANSWER_BYTES: usize = MAX_SAMPLES / 3 * 4;
/// A picture no decoder has taken by then is refused: the desktop app is not running one (the engine started alone).
const TAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a decoder has for a picture once it has taken it.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

/// What the engine asks for: the size while an import reads its files, the samples when the picture is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Want {
    Probe,
    Size,
    Pixels,
}
impl Want {
    pub fn name(self) -> &'static str {
        match self {
            Self::Probe => "probe",
            Self::Size => "size",
            Self::Pixels => "pixels",
        }
    }
}

/// A decoded picture: its size and, when asked for, its samples (red, green, blue for each pixel, rows top first).
#[derive(Debug, PartialEq, Eq)]
pub struct Picture {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// A picture handed to a decoder.
pub struct Task {
    pub id: u64,
    pub want: Want,
    pub bytes: Vec<u8>,
}

struct Job {
    want: Want,
    weight: usize,
    abandoned: bool,
    /// The file's bytes until a decoder takes them.
    bytes: Option<Vec<u8>>,
    /// RGBA received so far when a reply spans more than one pipe request.
    partial: Option<PartialPicture>,
    taken: Option<Instant>,
    answer: Option<Result<Picture, String>>,
}

struct PartialPicture {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

struct Jobs {
    next: u64,
    waiting: VecDeque<u64>,
    jobs: BTreeMap<u64, Job>,
    stopping: bool,
}

static JOBS: Mutex<Jobs> = Mutex::new(Jobs {
    next: 1,
    waiting: VecDeque::new(),
    jobs: BTreeMap::new(),
    stopping: false,
});
/// Signalled when a picture is waiting for a decoder, and when the engine stops.
static WAITING: Condvar = Condvar::new();
/// Signalled when a picture has its answer.
static ANSWERED: Condvar = Condvar::new();

fn jobs() -> MutexGuard<'static, Jobs> {
    JOBS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether `head`, a file's first bytes, starts as a PNG, a JPEG or a BMP does: the only pictures that are opened.
pub fn is_picture(head: &[u8]) -> bool {
    head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(&[0xff, 0xd8, 0xff])
        || head.starts_with(b"BM")
}

/// Reserves the encoded bytes before reading them and holds the reservation through the decoder's reply.
pub struct Request {
    id: u64,
    want: Want,
    bytes: Vec<u8>,
    check: fn() -> Result<()>,
}

impl Request {
    fn reserve(length: usize, want: Want, check: fn() -> Result<()>) -> Result<Self> {
        let weight = length.min(IN_FLIGHT_BYTES);
        let mut jobs = jobs();
        loop {
            check()?;
            if jobs.stopping {
                bail!(coded!("core.stopping", "Native core is shutting down"));
            }
            jobs.jobs.retain(|_, job| {
                !job.abandoned || job.taken.is_some_and(|at| at.elapsed() < ANSWER_TIMEOUT)
            });
            let used: usize = jobs.jobs.values().map(|job| job.weight).sum();
            if used + weight <= IN_FLIGHT_BYTES {
                let id = jobs.next;
                jobs.next += 1;
                jobs.jobs.insert(
                    id,
                    Job {
                        want,
                        weight,
                        abandoned: false,
                        bytes: None,
                        partial: None,
                        taken: None,
                        answer: None,
                    },
                );
                return Ok(Self {
                    id,
                    want,
                    bytes: Vec::new(),
                    check,
                });
            }
            jobs = wait_for_change(jobs);
        }
    }

    pub fn decode(self) -> Result<Picture> {
        self.wait()?.map_err(anyhow::Error::msg)
    }

    // The outer error covers cancellation, shutdown and timeouts. Only a decoder's rejection of a prefix is retried.
    fn wait(mut self) -> Result<Result<Picture, String>> {
        let posted = Instant::now();
        let mut jobs = jobs();
        jobs.jobs
            .get_mut(&self.id)
            .context("Picture request lost")?
            .bytes = Some(std::mem::take(&mut self.bytes));
        jobs.waiting.push_back(self.id);
        WAITING.notify_one();
        loop {
            (self.check)()?;
            if jobs.stopping {
                bail!(coded!("core.stopping", "Native core is shutting down"));
            }
            let job = jobs
                .jobs
                .get_mut(&self.id)
                .context("Picture request lost")?;
            if let Some(answer) = job.answer.take() {
                return Ok(answer);
            }
            match job.taken {
                None if posted.elapsed() >= TAKE_TIMEOUT => bail!("No picture decoder is running"),
                Some(at) if at.elapsed() >= ANSWER_TIMEOUT => {
                    bail!("The picture decoder did not answer")
                }
                _ => {}
            }
            jobs = wait_for_change(jobs);
        }
    }
}

fn wait_for_change(jobs: MutexGuard<'static, Jobs>) -> MutexGuard<'static, Jobs> {
    ANSWERED
        .wait_timeout(jobs, Duration::from_millis(200))
        .unwrap_or_else(PoisonError::into_inner)
        .0
}

impl Drop for Request {
    fn drop(&mut self) {
        let mut jobs = jobs();
        jobs.waiting.retain(|id| *id != self.id);
        if let Some(job) = jobs.jobs.get_mut(&self.id)
            && job.taken.is_some_and(|at| at.elapsed() < ANSWER_TIMEOUT)
        {
            // The renderer still has the bytes. Its answer or deadline releases them.
            job.abandoned = true;
        } else {
            jobs.jobs.remove(&self.id);
            ANSWERED.notify_all();
        }
    }
}

/// Set once a decoder runs in this process: the browser's picture Worker.
static DECODER_STARTED: AtomicBool = AtomicBool::new(false);

/// Called by a decoder in this process before it takes pictures. In WebAssembly, pictures are refused until one has.
pub fn decoder_started() {
    DECODER_STARTED.store(true, Ordering::Release);
}

/// Checks the signature on the open file before allocating for its contents.
pub fn index(path: &Path) -> Result<std::sync::Arc<crate::source_file::SourceFile>> {
    // A page without the decoder (no shared memory, so no threads build) has none to answer; waiting for one would only
    // delay the rest of the import.
    if cfg!(target_arch = "wasm32") && !DECODER_STARTED.load(Ordering::Acquire) {
        bail!(coded!(
            "pictures.browser",
            "PNG, JPEG and BMP pictures cannot be opened in this browser"
        ));
    }
    use std::io::{Seek, SeekFrom};
    let mut file = crate::source_file::open_file(path)?;
    let len = file.metadata()?.len();
    if len > MAX_FILE_BYTES {
        bail!("Not a picture file of a supported size");
    }
    let mut prefix = [0; 8];
    let prefix = &mut prefix[..len.min(8) as usize];
    file.read_exact(prefix)?;
    if !is_picture(prefix) {
        bail!("Only PNG, JPEG and BMP images can be opened");
    }
    file.seek(SeekFrom::Start(0))?;
    crate::source_file::SourceFile::index_handle(path, file)
}

pub fn read(
    source: &std::sync::Arc<crate::source_file::SourceFile>,
    want: Want,
    check: fn() -> Result<()>,
) -> Result<Request> {
    let mut file = source.open()?;
    let file_length = source.len as usize;
    let want = if want == Want::Probe && file_length <= PROBE_BYTES {
        Want::Size
    } else {
        want
    };
    let length = if want == Want::Probe {
        PROBE_BYTES
    } else {
        file_length
    };
    let mut prefix = [0; 8];
    let prefix = &mut prefix[..length.min(8)];
    file.read_exact(prefix)?;
    if !is_picture(prefix) {
        bail!("Only PNG, JPEG and BMP images can be opened");
    }
    let mut request = Request::reserve(length, want, check)?;
    request.bytes.try_reserve_exact(length)?;
    request.bytes.resize(length, 0);
    request.bytes[..prefix.len()].copy_from_slice(prefix);
    for chunk in request.bytes[prefix.len()..].chunks_mut(256 * 1024) {
        check()?;
        file.read_exact(chunk)?;
    }
    if want != Want::Probe && file.read(&mut [0])? != 0 {
        bail!("Picture file changed while reading");
    }
    Ok(request)
}

/// Try the first 64 KiB. A renderer that needs later headers gets the full file under the same byte budget.
pub fn size(source: &std::sync::Arc<crate::source_file::SourceFile>) -> Result<Picture> {
    let probe = read(source, Want::Probe, crate::progress::check)?;
    if probe.want == Want::Size {
        return probe.decode();
    }
    match probe.wait()? {
        Ok(size) => return Ok(size),
        Err(reason) if reason == "Incomplete picture header" => {}
        Err(reason) => return Err(anyhow::Error::msg(reason)),
    }
    read(source, Want::Size, crate::progress::check)?.decode()
}

/// The next picture for a decoder, waiting up to `wait` for one; None when there is none, or the engine is stopping.
pub fn next(wait: Duration, cancelled: &AtomicBool) -> Option<Task> {
    let deadline = Instant::now() + wait;
    let mut jobs = jobs();
    loop {
        if jobs.stopping || cancelled.load(Ordering::Acquire) {
            return None;
        }
        while let Some(id) = jobs.waiting.pop_front() {
            if let Some(job) = jobs.jobs.get_mut(&id) {
                job.taken = Some(Instant::now());
                let task = Task {
                    id,
                    want: job.want,
                    bytes: job.bytes.take().unwrap_or_default(),
                };
                // Another decoder may take the next one meanwhile.
                if !jobs.waiting.is_empty() {
                    WAITING.notify_one();
                }
                return Some(task);
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        jobs = WAITING
            .wait_timeout(jobs, left)
            .unwrap_or_else(PoisonError::into_inner)
            .0;
    }
}

/// Lets an idle poll observe cancellation without taking the next decoder's picture.
pub fn wake_poll() {
    let _jobs = jobs();
    WAITING.notify_all();
}

/// An RGBA reply can exceed the pipe's per-request limit. Join its chunks in order before
/// handing the samples to the waiting frame or volume decode.
pub fn answer_part(
    id: u64,
    width: u32,
    height: u32,
    offset: usize,
    more: bool,
    bytes: &[u8],
) -> bool {
    let mut jobs = jobs();
    let Some(job) = jobs.jobs.get_mut(&id).filter(|job| job.taken.is_some()) else {
        return false;
    };
    if job.abandoned {
        jobs.jobs.remove(&id);
        ANSWERED.notify_all();
        return false;
    }
    let received = job.partial.as_ref().map_or(0, |part| part.rgba.len());
    let resized = job
        .partial
        .as_ref()
        .is_some_and(|part| (part.width, part.height) != (width, height));
    let result = if resized || offset != received || bytes.len() > MAX_ANSWER_BYTES - received {
        Err("Invalid picture answer dimensions, offset or length".into())
    } else if more {
        let pixels = u64::from(width) * u64::from(height);
        if job.want != Want::Pixels
            || pixels > (MAX_SAMPLES / 3) as u64
            || bytes.is_empty()
            || offset + bytes.len() >= pixels as usize * 4
        {
            Err("Invalid partial picture answer".into())
        } else {
            let part = job.partial.get_or_insert_with(|| PartialPicture {
                width,
                height,
                rgba: Vec::with_capacity(pixels as usize * 4),
            });
            part.rgba.extend_from_slice(bytes);
            return true;
        }
    } else {
        let mut samples = job.partial.take().map_or_else(Vec::new, |part| part.rgba);
        samples.extend_from_slice(bytes);
        Ok((width, height, samples))
    };
    drop(jobs);
    answer(id, result)
}

/// A decoder's answer for picture `id`: its width and height and, if the samples were asked for, exactly
/// `width × height` pixels of red, green, blue and alpha (rows top first), or why it could not be decoded. False if no
/// picture `id` is waiting for an answer.
pub fn answer(id: u64, answer: Result<(u32, u32, Vec<u8>), String>) -> bool {
    let want = {
        let jobs = jobs();
        match jobs
            .jobs
            .get(&id)
            .filter(|job| job.taken.is_some() && job.answer.is_none())
        {
            Some(job) => job.want,
            None => return false,
        }
    };
    // Checked and turned into RGB before the lock is taken again, so other answers do not wait for a large one.
    let answer = answer.and_then(|(width, height, mut samples)| {
        let pixels = width as usize * height as usize;
        match want {
            _ if pixels == 0 => Err("The picture has no pixels".into()),
            Want::Probe | Want::Size if samples.is_empty() => Ok(Picture {
                width,
                height,
                rgb: samples,
            }),
            Want::Pixels if pixels.checked_mul(3).is_none_or(|rgb| rgb > MAX_SAMPLES) => {
                Err("Frame exceeds the supported 64 million sample limit".into())
            }
            Want::Pixels if samples.len() == pixels * 4 => {
                for pixel in 1..pixels {
                    samples.copy_within(pixel * 4..pixel * 4 + 3, pixel * 3);
                }
                samples.truncate(pixels * 3);
                Ok(Picture {
                    width,
                    height,
                    rgb: samples,
                })
            }
            _ => Err("The picture decoder answered with the wrong number of samples".into()),
        }
    });
    let mut jobs = jobs();
    if jobs.jobs.get(&id).is_some_and(|job| job.abandoned) {
        jobs.jobs.remove(&id);
        ANSWERED.notify_all();
        return false;
    }
    let Some(job) = jobs
        .jobs
        .get_mut(&id)
        .filter(|job| job.taken.is_some() && job.answer.is_none())
    else {
        return false;
    };
    job.taken = None;
    job.answer = Some(answer);
    ANSWERED.notify_all();
    true
}

/// Ends every wait: the engine is stopping.
pub fn stop() {
    jobs().stopping = true;
    WAITING.notify_all();
    ANSWERED.notify_all();
}

/// Pictures as the engine's tests write them, and a decoder for them that stands in for the desktop app's.
#[cfg(test)]
pub mod testing {
    use super::*;
    use std::sync::OnceLock;

    const MARK: &[u8] = b"VEACOM TEST PICTURE";

    /// A file that starts as a PNG does (or a JPEG or BMP, after `kind`'s first bytes), then holds its size and samples
    /// for `serve`'s decoder to read back.
    pub fn picture(kind: &[u8], width: u32, height: u32, rgb: &[u8]) -> Vec<u8> {
        assert_eq!(rgb.len(), width as usize * height as usize * 3);
        [kind, MARK, &width.to_le_bytes(), &height.to_le_bytes(), rgb].concat()
    }
    pub const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
    pub const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0];
    pub const BMP: &[u8] = b"BM";

    /// Pictures each test process has had decoded, by their bytes, so a test can tell what reached the decoder.
    pub fn decoded() -> &'static Mutex<Vec<Vec<u8>>> {
        static DECODED: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());
        &DECODED
    }

    /// Starts the tests' decoder once: it takes pictures as the desktop app does and answers from what `picture` wrote,
    /// or that the picture cannot be decoded.
    #[allow(
        clippy::disallowed_methods,
        reason = "the test decoder stands in for the desktop process"
    )]
    pub fn serve() {
        static SERVING: OnceLock<()> = OnceLock::new();
        // Never cancelled.
        static KEPT: AtomicBool = AtomicBool::new(false);
        SERVING.get_or_init(|| {
            std::thread::Builder::new()
                .name("test-picture-decoder".into())
                .spawn(|| {
                    loop {
                        let Some(task) = next(Duration::from_secs(3600), &KEPT) else {
                            continue;
                        };
                        decoded().lock().unwrap().push(task.bytes.clone());
                        let _ = answer(
                            task.id,
                            read_back(&task.bytes, task.want).map(|picture| {
                                // Answered as Chromium reads pictures back: an opaque alpha sample after each pixel's three.
                                let rgba = picture
                                    .rgb
                                    .chunks(3)
                                    .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
                                    .collect();
                                (picture.width, picture.height, rgba)
                            }),
                        );
                    }
                })
                .unwrap();
        });
    }

    fn read_back(bytes: &[u8], want: Want) -> Result<Picture, String> {
        let at = bytes
            .windows(MARK.len())
            .position(|window| window == MARK)
            .ok_or("The source image could not be decoded.")?;
        let rest = &bytes[at + MARK.len()..];
        let number =
            |range: std::ops::Range<usize>| u32::from_le_bytes(rest[range].try_into().unwrap());
        let (width, height) = (number(0..4), number(4..8));
        let rgb = if want == Want::Pixels {
            rest[8..].to_vec()
        } else {
            Vec::new()
        };
        Ok(Picture { width, height, rgb })
    }
}

#[cfg(test)]
mod tests {
    use super::{testing::*, *};

    #[test]
    fn only_png_jpeg_and_bmp_count_as_pictures() {
        for head in [PNG, JPEG, BMP] {
            assert!(is_picture(head));
        }
        for head in [
            &b"GIF89a"[..],
            b"RIFF\0\0\0\0WEBP",
            b"\0\0\x01\0",
            b"\x89PNG",
            b"\xff\xd8",
            b"B",
            b"DICM",
            b"",
        ] {
            assert!(!is_picture(head), "{head:?}");
        }
    }

    fn decode(bytes: Vec<u8>, want: Want) -> Result<Picture> {
        let mut request = Request::reserve(bytes.len(), want, || Ok(()))?;
        request.bytes = bytes;
        request.decode()
    }

    #[test]
    fn a_decoder_answers_the_size_or_the_samples() {
        serve();
        let rgb = [255, 0, 20, 0, 200, 255];
        assert_eq!(
            decode(picture(PNG, 2, 1, &rgb), Want::Size).unwrap(),
            Picture {
                width: 2,
                height: 1,
                rgb: Vec::new()
            }
        );
        assert_eq!(
            decode(picture(BMP, 2, 1, &rgb), Want::Pixels).unwrap(),
            Picture {
                width: 2,
                height: 1,
                rgb: rgb.to_vec()
            }
        );
        let error = decode(PNG.to_vec(), Want::Size).unwrap_err();
        assert_eq!(error.to_string(), "The source image could not be decoded.");
    }

    fn taken(want: Want) -> u64 {
        let mut queue = jobs();
        let id = queue.next;
        queue.next += 1;
        queue.jobs.insert(
            id,
            Job {
                want,
                weight: 0,
                abandoned: false,
                bytes: None,
                partial: None,
                taken: Some(Instant::now()),
                answer: None,
            },
        );
        id
    }

    fn answered(want: Want, given: (u32, u32, Vec<u8>)) -> Result<Picture, String> {
        let id = taken(want);
        assert!(answer(id, Ok(given)));
        jobs().jobs.remove(&id).unwrap().answer.unwrap()
    }

    #[test]
    fn partial_answers_reject_gaps_and_dimension_changes() {
        for (offset, width, height) in [(0, 2, 1), (4, 1, 2)] {
            let id = taken(Want::Pixels);
            assert!(answer_part(id, 2, 1, 0, true, &[10, 11, 12, 255]));
            assert!(answer_part(
                id,
                width,
                height,
                offset,
                false,
                &[13, 14, 15, 255]
            ));
            assert!(jobs().jobs.remove(&id).unwrap().answer.unwrap().is_err());
        }
    }

    #[test]
    fn answers_lose_their_alpha_samples() {
        let rgba = vec![255, 0, 20, 255, 0, 200, 255, 128, 1, 2, 3, 0];
        assert_eq!(
            answered(Want::Pixels, (3, 1, rgba)),
            Ok(Picture {
                width: 3,
                height: 1,
                rgb: vec![255, 0, 20, 0, 200, 255, 1, 2, 3]
            })
        );
        assert_eq!(
            answered(Want::Size, (3, 1, Vec::new())),
            Ok(Picture {
                width: 3,
                height: 1,
                rgb: Vec::new()
            })
        );
    }

    #[test]
    fn answers_of_the_wrong_size_and_unknown_pictures_are_refused() {
        assert!(!answer(u64::MAX, Ok((1, 1, Vec::new()))));
        let wrong = |want, given| answered(want, given).unwrap_err();
        assert!(wrong(Want::Pixels, (2, 2, vec![0; 12])).contains("wrong number of samples"));
        assert!(wrong(Want::Size, (2, 2, vec![0; 16])).contains("wrong number of samples"));
        assert!(wrong(Want::Size, (0, 5, Vec::new())).contains("no pixels"));
        assert!(
            wrong(Want::Pixels, (32768, 32768, Vec::new())).contains("64 million sample limit")
        );
    }

    #[test]
    fn only_picture_files_are_read() {
        let dir = crate::test_dir::tempdir().unwrap();
        let disguised = dir.path().join("photo.png");
        std::fs::write(&disguised, b"GIF89a....").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&disguised)
            .unwrap()
            .set_len(MAX_FILE_BYTES)
            .unwrap();
        assert_eq!(
            index(&disguised).err().unwrap().to_string(),
            "Only PNG, JPEG and BMP images can be opened"
        );
        // A JPEG named .png is read: what decodes it follows the contents.
        let misnamed = dir.path().join("scan.png");
        std::fs::write(&misnamed, picture(JPEG, 1, 1, &[1, 2, 3])).unwrap();
        assert!(
            read(&index(&misnamed).unwrap(), Want::Size, || Ok(()))
                .unwrap()
                .bytes
                .starts_with(JPEG)
        );
        assert!(index(&dir.path().join("missing.png")).is_err());
    }

    #[test]
    fn a_replaced_picture_is_rejected_before_reaching_the_sandbox_decoder() {
        let dir = crate::test_dir::tempdir().unwrap();
        let path = dir.path().join("synthetic.png");
        std::fs::write(&path, testing::picture(testing::PNG, 1, 1, &[1, 2, 3])).unwrap();
        let source = index(&path).unwrap();
        // File times tick a few milliseconds apart on Linux and Windows; a later write moves them.
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(&path, testing::picture(testing::PNG, 1, 1, &[4, 5, 6])).unwrap();
        for want in [Want::Probe, Want::Size, Want::Pixels] {
            let error = read(&source, want, || Ok(())).err().unwrap();
            assert!(crate::source_file::is_changed(&error), "{error:#}");
        }
    }

    #[test]
    fn a_taken_picture_keeps_its_byte_allowance_until_the_late_answer() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CHECKS: AtomicUsize = AtomicUsize::new(0);
        let request = Request::reserve(MAX_FILE_BYTES as usize, Want::Size, || Ok(())).unwrap();
        let id = request.id;
        jobs().jobs.get_mut(&id).unwrap().taken = Some(Instant::now());
        drop(request);
        let blocked = Request::reserve(1, Want::Size, || {
            if CHECKS.fetch_add(1, Ordering::Relaxed) > 0 {
                bail!("cancelled while waiting for memory");
            }
            Ok(())
        });
        assert_eq!(
            blocked.err().unwrap().to_string(),
            "cancelled while waiting for memory"
        );
        assert!(!answer(id, Ok((1, 1, Vec::new()))));
        assert!(!jobs().jobs.contains_key(&id));
        assert!(Request::reserve(IN_FLIGHT_BYTES, Want::Pixels, || Ok(())).is_ok());
    }
}
