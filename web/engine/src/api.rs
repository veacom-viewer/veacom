//! What the Worker calls. In the desktop app these are requests over the engine's pipes; here they are function calls
//! on the Worker's thread, one at a time. Errors carry the same JSON body (`{error, note}`), which the interface
//! translates the same way.
//!
//! Every call runs on the Worker's own thread (`parallel::on_this_thread`), the only one that can read the page's
//! files; in the threads build a series held in memory is decoded on the lent threads as well (`decode_volume_of`).

use crate::session::Session;
use std::{
    cell::{Cell, RefCell},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering},
    },
};
use veacom_core::{decode, message, model::PixelBuffer, parallel, progress, sampling, window};
use wasm_bindgen::prelude::*;

/// The cancel flag and progress record in the module's own memory. In the threads build that memory is shared with
/// the page, which writes the flag and reads the record directly: while a decode runs on the pool, the Worker's own
/// thread waits for it and can pass on nothing. Cancellation and progress use the same request id as the browser queue.
static REQUEST_ID: AtomicU32 = AtomicU32::new(0);
static SHARED_CANCEL: AtomicI32 = AtomicI32::new(0);
static SHARED_PROGRESS: [AtomicU32; 4] = [const { AtomicU32::new(0) }; 4];

thread_local! {
    static SESSION: RefCell<Session> = RefCell::new(Session::default());
    /// The page's progress listener and its cancel flag (a request id or zero).
    static WATCH: RefCell<Option<(js_sys::Function, js_sys::Int32Array)>> = const { RefCell::new(None) };
    static LAST_REPORT: Cell<f64> = const { Cell::new(0.) };
    /// The running export's own stop flag, which the engine checks between files.
    static EXPORT_CANCEL: RefCell<Arc<AtomicBool>> = RefCell::new(Arc::new(AtomicBool::new(false)));
}

fn error(error: anyhow::Error) -> JsError {
    let note = message::coded(&error).cloned().unwrap_or_else(|| format!("{error:#}").into());
    let body = if note.code.is_empty() {
        serde_json::json!({ "error": note.text })
    } else {
        serde_json::json!({ "error": note.text, "note": note })
    };
    JsError::new(&body.to_string())
}

fn session<T>(run: impl FnOnce(&mut Session) -> anyhow::Result<T>) -> Result<T, JsError> {
    SESSION.with_borrow_mut(|session| parallel::on_this_thread(|| run(session))).map_err(error)
}

fn json(value: impl serde::Serialize) -> Result<String, JsError> {
    serde_json::to_string(&value).map_err(|e| error(e.into()))
}

#[wasm_bindgen(js_name = beginRequest)]
pub fn begin_request(id: u32) {
    REQUEST_ID.store(id, Ordering::Release);
}

fn cancel(id: i32) {
    if id != 0 && id as u32 == REQUEST_ID.load(Ordering::Acquire) {
        progress::cancel();
        EXPORT_CANCEL.with_borrow(|flag| flag.store(true, Ordering::Release));
    }
}

/// Called before every file read during imports and decodes (`memory_fs::on_read`), on whichever thread reads:
/// cancels the job the page asked to cancel, and passes on the progress record at most ten times a second (on the
/// Worker's own thread to the page's listener; on any thread into the shared record).
fn read_hook() {
    cancel(SHARED_CANCEL.load(Ordering::Acquire));
    WATCH.with_borrow(|watch| {
        if let Some((_, flag)) = watch {
            cancel(js_sys::Atomics::load(flag, 0).unwrap_or(0));
        }
    });
    let now = crate::blob::now();
    if now - LAST_REPORT.get() < 100. {
        return;
    }
    LAST_REPORT.set(now);
    let mut record = progress::snapshot();
    record["id"] = REQUEST_ID.load(Ordering::Acquire).into();
    let number = |key: &str| record[key].as_u64().unwrap_or(0) as u32;
    SHARED_PROGRESS[0].store(record["running"].as_bool().unwrap_or(false) as u32, Ordering::Release);
    SHARED_PROGRESS[1].store(number("completed"), Ordering::Release);
    SHARED_PROGRESS[2].store(number("total"), Ordering::Release);
    SHARED_PROGRESS[3].store(number("id"), Ordering::Release);
    WATCH.with_borrow(|watch| {
        if let Some((listener, _)) = watch {
            let _ = listener.call1(&JsValue::NULL, &JsValue::from_str(&record.to_string()));
        }
    });
}

/// Where the shared cancel flag and progress record are in the module's memory: `[flag, record]` byte addresses.
#[wasm_bindgen(js_name = sharedState)]
pub fn shared_state() -> Vec<u32> {
    vec![&SHARED_CANCEL as *const AtomicI32 as u32, SHARED_PROGRESS.as_ptr() as u32]
}

/// The most a series' files may take when they are held whole for the threads (`decode_volume_of`), so the memory
/// this costs stays bounded. Most CT and MR series are well under it.
#[cfg(feature = "threads")]
static HOLD_LIMIT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(256 * 1024 * 1024);

/// For the measurement page (`?hold=` bytes): a lower limit, to time the decoding of a series too large to hold.
#[cfg(feature = "threads")]
#[doc(hidden)]
#[wasm_bindgen(js_name = setHoldLimit)]
pub fn set_hold_limit(bytes: f64) {
    HOLD_LIMIT.store(bytes as u64, Ordering::Relaxed);
}

/// Decodes a whole series, from the cache when it is there. In the threads build the series' files are first read
/// whole into shared memory, as the decoding threads cannot reach the page's files, and given back after.
fn decode_volume_of(id: &str, revision: Option<u64>) -> anyhow::Result<Arc<PixelBuffer>> {
    #[cfg(feature = "threads")]
    if !SESSION.with_borrow(|session| session.has_volume(id)) {
        let source = SESSION.with_borrow(|session| session.source(id))?;
        let mut paths: Vec<&std::path::Path> = source.frames.iter().map(|frame| frame.source.path.as_path()).collect();
        paths.sort();
        paths.dedup();
        // Above HOLD_LIMIT, or when memory runs short, the series is decoded on this thread alone, reading as it goes.
        let volume = match crate::blob::hold(&paths, HOLD_LIMIT.load(Ordering::Relaxed)) {
            Ok(true) => SESSION.with_borrow_mut(|session| session.volume(id, revision)),
            Ok(false) => SESSION.with_borrow_mut(|session| parallel::on_this_thread(|| session.volume(id, revision))),
            Err(error) => Err(error.into()),
        };
        crate::blob::release();
        return volume;
    }
    SESSION.with_borrow_mut(|session| parallel::on_this_thread(|| session.volume(id, revision)))
}

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    veacom_core::memory_fs::on_read(read_hook);
    #[cfg(feature = "threads")]
    crate::helpers::lend();
}

/// Where progress goes (a function taking the progress record as JSON) and the shared cancel flag.
#[wasm_bindgen]
pub fn watch(listener: js_sys::Function, cancel: js_sys::Int32Array) {
    WATCH.with_borrow_mut(|watch| *watch = Some((listener, cancel)));
}

/// The progress record as JSON (`{id, running, stage, completed, total, cancelled}`).
#[wasm_bindgen]
pub fn progress() -> String {
    progress::snapshot().to_string()
}

/// Lists a user's file (from a drop or a file chooser) at a path such as `/in/1/Study/1.dcm`. `head` may hold the
/// file's first 64 KiB, read by the page beforehand.
#[wasm_bindgen(js_name = addFile)]
pub fn add_file(path: &str, file: web_sys::Blob, head: Option<Vec<u8>>) {
    crate::blob::add(path, file, head);
}

/// Closes everything and forgets every listed file.
#[wasm_bindgen]
pub fn reset() {
    SESSION.with_borrow_mut(|session| *session = Session::default());
    crate::blob::clear();
}

/// Imports files, folders or ZIPs by path and adds their series to the catalog; returns `{series, warnings}`.
#[wasm_bindgen(js_name = importPaths)]
pub fn import_paths(paths: Vec<String>) -> Result<String, JsError> {
    let imported = session(|session| session.import(&paths));
    release_files();
    json(imported?)
}

/// After an import, whatever its outcome, and after a removal: the page's files that no series reads from go (a failed
/// import's, an archive once extracted, a closed series'), and so do the first pieces read ahead for the import.
fn release_files() {
    crate::blob::drop_heads();
    crate::blob::retain(&SESSION.with_borrow(Session::referenced_paths));
}

/// Every series in the catalog, as `{series, warnings}`.
#[wasm_bindgen(js_name = listSeries)]
pub fn list_series() -> Result<String, JsError> {
    json(SESSION.with_borrow(Session::list))
}

/// Takes series off the catalog; returns `{removed, remaining}`.
#[wasm_bindgen(js_name = removeSeries)]
pub fn remove_series(ids: Vec<String>) -> Result<String, JsError> {
    let (removed, remaining) = SESSION.with_borrow_mut(|session| session.remove(&ids));
    release_files();
    json(serde_json::json!({ "removed": removed, "remaining": remaining }))
}

fn pixel_object(pixels: &PixelBuffer, components: u8) -> Result<js_sys::Object, JsError> {
    let object = js_sys::Object::new();
    let set = |key: &str, value: JsValue| js_sys::Reflect::set(&object, &key.into(), &value).map(|_| ()).map_err(|_| JsError::new("pixel response"));
    set("bytes", js_sys::Uint8Array::from(pixels.bytes()).into())?;
    set("pixelType", pixels.type_name().into())?;
    set("components", components.into())?;
    Ok(object)
}

/// Requests name the catalog revision of the series they were made for (`catalogRevision`), so an answer never comes
/// from the series imported again since; without one, the series as it is now.
fn revision(value: Option<f64>) -> Option<u64> {
    value.map(|n| n as u64)
}

/// The whole series decoded: `{bytes, pixelType, components}`.
#[wasm_bindgen]
pub fn volume(id: &str, catalog_revision: Option<f64>) -> Result<js_sys::Object, JsError> {
    let volume = decode_volume_of(id, revision(catalog_revision)).map_err(error)?;
    let components = session(|session| Ok(session.source(id)?.info.components))?;
    pixel_object(&volume, components)
}

/// One source frame: `{bytes, pixelType, components, index, sopInstanceUid, sourceFrameNumber}`, the last two telling
/// the viewer it is the frame it asked for.
#[wasm_bindgen]
pub fn frame(id: &str, index: usize, catalog_revision: Option<f64>) -> Result<js_sys::Object, JsError> {
    let frame = session(|session| session.frame(id, index, revision(catalog_revision)))?;
    let object = pixel_object(&frame.pixels, frame.components)?;
    let set = |key: &str, value: JsValue| js_sys::Reflect::set(&object, &key.into(), &value).map(|_| ()).map_err(|_| JsError::new("pixel response"));
    set("index", (index as u32).into())?;
    set("sopInstanceUid", frame.metadata.sop_instance_uid.as_str().into())?;
    set("sourceFrameNumber", frame.metadata.source_frame_number.map_or(JsValue::UNDEFINED, JsValue::from))?;
    Ok(object)
}

/// Exports series (or frame `frame` of one series) as DICOM, with the desktop's options (`{anonymize, full, dicomdir,
/// decompress}`): `{result, files}`, the export's result JSON and every written file as `{name, bytes}`, for the page
/// to pack into one download. `reviewed`: `{seriesId: catalogRevision}` of the series whose pixels the reader reviewed,
/// which a full cleanup needs.
#[wasm_bindgen(js_name = exportDicom)]
pub fn export_dicom(ids: Vec<String>, frame: Option<u32>, options: &str, reviewed: &str) -> Result<js_sys::Object, JsError> {
    let options: serde_json::Value = serde_json::from_str(options).map_err(|e| error(e.into()))?;
    let reviewed: std::collections::BTreeMap<String, u64> = serde_json::from_str(reviewed).map_err(|e| error(e.into()))?;
    let cancelled = Arc::new(AtomicBool::new(false));
    EXPORT_CANCEL.with_borrow_mut(|flag| *flag = cancelled.clone());
    let (result, files) = session(|session| session.export(&ids, frame.map(|n| n as usize), options, &reviewed, cancelled))?;
    let list = js_sys::Array::new();
    for (name, bytes) in files {
        let item = js_sys::Object::new();
        js_sys::Reflect::set(&item, &"name".into(), &name.into()).map_err(|_| JsError::new("export response"))?;
        js_sys::Reflect::set(&item, &"bytes".into(), &js_sys::Uint8Array::from(bytes.as_slice()).into()).map_err(|_| JsError::new("export response"))?;
        list.push(&item);
    }
    let object = js_sys::Object::new();
    js_sys::Reflect::set(&object, &"result".into(), &json(result)?.into()).map_err(|_| JsError::new("export response"))?;
    js_sys::Reflect::set(&object, &"files".into(), &list).map_err(|_| JsError::new("export response"))?;
    Ok(object)
}

/// The tags of the file holding frame `frame` of the series, or of its first frame, as JSON.
#[wasm_bindgen]
pub fn tags(id: &str, frame: Option<u32>, catalog_revision: Option<f64>) -> Result<String, JsError> {
    json(session(|session| session.tags(id, frame.map(|n| n as usize), revision(catalog_revision)))?)
}

/// What a measurement samples from the series' source pixels: a region's statistics or a window.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SampleOperation {
    SourceRegion(sampling::Region),
    Window(window::Window),
}

/// Samples the source pixels of series `id` imported at `revision`, with the desktop engine's checks (its `sample`
/// request): from the one frame the operation lies in, or else from the whole volume.
#[wasm_bindgen]
pub fn sample(id: &str, revision: f64, operation: &str) -> Result<String, JsError> {
    json(sample_of(id, revision as u64, operation).map_err(error)?)
}

fn sample_of(id: &str, revision: u64, operation: &str) -> anyhow::Result<serde_json::Value> {
    let operation: SampleOperation = serde_json::from_str(operation)?;
    let series = SESSION.with_borrow(|session| session.source(id))?;
    anyhow::ensure!(series.info.source_revision == revision, "Source series changed");
    let frame = match &operation {
        SampleOperation::SourceRegion(region) => {
            anyhow::ensure!(region.points.len() <= 10_000, "Too many region points");
            region.plane.single_frame(&series)?
        }
        SampleOperation::Window(window) => match &window.frame {
            Some(frame) => {
                frame.validate(&series)?;
                Some(frame.index)
            }
            None => None,
        },
    };
    let pixels = match frame {
        Some(index) => Arc::new(parallel::on_this_thread(|| decode::decode_frame(&series, index))?),
        None => decode_volume_of(id, None)?,
    };
    parallel::on_this_thread(|| match &operation {
        SampleOperation::SourceRegion(region) => Ok(serde_json::to_value(sampling::region(&series, &pixels, region)?)?),
        SampleOperation::Window(window) => window::calculate(&series, &pixels, window),
    })
}

// The measurement page (web/index.html) names series by their position in the last import.

fn imported(index: usize) -> anyhow::Result<String> {
    SESSION.with_borrow(|session| session.last_import.get(index).cloned()).ok_or_else(|| anyhow::anyhow!("No such series"))
}

/// The middle frames' page: one frame drawn with the series' default window, as RGBA (columns × rows × 4).
#[wasm_bindgen(js_name = renderFrame)]
pub fn render_frame(series: usize, frame: usize) -> Result<Vec<u8>, JsError> {
    // Looked up before the session is borrowed for the decoding.
    let id = imported(series).map_err(error)?;
    session(|session| {
        let info = session.source(&id)?.info.clone();
        let pixels = session.frame(&id, frame, None)?.pixels;
        Ok(crate::view::window_rgba(&pixels, info.components as usize, info.window_center, info.window_width, info.photometric_interpretation == "MONOCHROME1"))
    })
}

/// Decodes a whole series; returns its sample count.
#[wasm_bindgen(js_name = decodeVolume)]
pub fn decode_volume(series: usize) -> Result<usize, JsError> {
    let id = imported(series).map_err(error)?;
    Ok(decode_volume_of(&id, None).map_err(error)?.len())
}

/// A whole decoded series as `{bytes, pixelType, components}`, for the page to checksum (to compare transfer syntaxes).
#[wasm_bindgen(js_name = volumeBytes)]
pub fn volume_bytes(series: usize) -> Result<js_sys::Object, JsError> {
    let id = imported(series).map_err(error)?;
    let volume = decode_volume_of(&id, None).map_err(error)?;
    let components = session(|session| Ok(session.source(&id)?.info.components))?;
    pixel_object(&volume, components)
}

/// Reads made from the browser's files since the last reset: `[count, bytes, milliseconds]`.
#[wasm_bindgen(js_name = fileReads)]
pub fn file_reads() -> Vec<f64> {
    let (reads, bytes, ms) = crate::blob::stats();
    vec![reads as f64, bytes as f64, ms]
}

/// Bytes the engine holds in memory for extracted ZIP entries.
#[wasm_bindgen(js_name = extractedBytes)]
pub fn extracted_bytes() -> f64 {
    veacom_core::memory_fs::memory_bytes() as f64
}
