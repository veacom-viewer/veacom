// First, so `note!` and `coded!` are available to every module below.
#[macro_use]
mod message;
#[cfg(test)]
mod codec_tests;
mod archive_temp;
#[cfg(windows)]
mod archive_owner_windows;
mod color;
mod confidentiality;
mod codec_guard;
mod decode;
mod export;
mod gamma_camera;
mod geometry;
mod ingest;
mod media_directory;
mod import_budget;
mod input_guard;
mod measure;
mod frames;
mod probe;
mod plane_region;
mod sampling;
mod sphere;
mod sphere_threshold;
mod assessment;
mod imaging_ops;
#[cfg(test)]
mod shader_tests;
#[cfg(any(target_os="macos",windows))]
mod render;
mod window;
mod memory;
mod model;
mod modality_lut;
mod palette;
mod patient;
mod parallel;
mod pictures;
mod pipe;
mod progress;
mod random;
mod resources;
mod rle_guard;
mod source_file;
mod tags;
#[cfg(test)]
mod test_dir;

/// Volumes and other large buffers are mapped directly, so freeing them returns the memory.
#[global_allocator]
static ALLOCATOR: memory::PageAllocator = memory::PageAllocator;

#[cfg(not(target_endian = "little"))]
compile_error!("VEAcom binary transport currently requires a little-endian target");

use model::{ImportResult, PixelBuffer, SourceSeries, Volume};
use pipe::Reply;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    sync::{
        Arc, Condvar, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

struct Cache {
    entries: VecDeque<(String, Arc<PixelBuffer>)>,
    bytes: usize,
    limit: usize,
    /// A warmed volume too large to keep, held for the one request it was decoded for.
    handoff: Option<(String, Arc<PixelBuffer>)>,
}
impl Cache {
    fn get(&mut self, id: &str) -> Option<Arc<PixelBuffer>> {
        if self.handoff.as_ref().is_some_and(|(k, _)| k == id) {
            return self.handoff.take().map(|(_, v)| v);
        }
        let at = self.entries.iter().position(|(k, _)| k == id)?;
        let item = self.entries.remove(at)?;
        let value = item.1.clone();
        self.entries.push_back(item);
        Some(value)
    }
    fn remove(&mut self, id: &str) {
        if self.handoff.as_ref().is_some_and(|(k, _)| k == id) {
            self.handoff = None;
        }
        if let Some(at) = self.entries.iter().position(|(k, _)| k == id) {
            if let Some((_, v)) = self.entries.remove(at) {
                self.bytes -= v.bytes().len();
            }
        }
    }
    fn put(&mut self, id: String, value: Arc<PixelBuffer>) {
        self.remove(&id);
        let bytes = value.bytes().len();
        while self.bytes + bytes > self.limit {
            if let Some((_, old)) = self.entries.pop_front() {
                self.bytes -= old.bytes().len();
            } else {
                break;
            }
        }
        if bytes <= self.limit {
            self.bytes += bytes;
            self.entries.push_back((id, value));
        }
    }
    /// Keeps a warmed volume for the request that follows it, even when it exceeds the
    /// cache, so that request does not decode it again.
    fn hand_off(&mut self, id: String, value: Arc<PixelBuffer>) {
        // Too large to cache: kept aside, and the volumes cached for other series stay.
        if value.bytes().len() > self.limit {
            self.remove(&id);
            self.handoff = Some((id, value));
        } else {
            self.put(id, value);
        }
    }
    fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
        self.handoff = None;
    }
}
struct Core {
    sources: RwLock<BTreeMap<String, Arc<SourceSeries>>>,
    catalog_bytes:Mutex<BTreeMap<String,usize>>,
    cache: Mutex<Cache>,
    archives: Mutex<Vec<archive_temp::ArchiveTempDir>>,
    jobs: Queue,
    frames: Queue,
    samples: Queue,
    #[cfg(any(target_os="macos",windows))]
    gpu: Queue,
    #[cfg(any(target_os="macos",windows))]
    mesh: Queue,
    #[cfg(any(target_os="macos",windows))]
    layer_uploads: Mutex<imaging_ops::LayerUploads>,
    early: Mutex<EarlyImport>,
}
type App = Arc<Core>;
/// The series the import under way has handed over before its end (see ingest::import_with), for importEarly.
#[derive(Default)]
struct EarlyImport {
    /// Counts imports, so a reader can tell one import's series from the next one's.
    import: u64,
    request_id: String,
    series: Vec<model::Series>,
    /// The ids this import added to the catalogue ahead of its end.
    added: Vec<String>,
}
/// An HTTP-like status and the message: `error` is the English text; `note`, when the message is coded, lets the
/// interface translate it.
struct ApiError(u16, message::Note);
impl ApiError {
    fn reply(self) -> Reply {
        let body = if self.1.code.is_empty() {
            json!({"error":self.1.text})
        } else {
            json!({"error":self.1.text,"note":self.1})
        };
        Reply::json(self.0, &body)
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        if source_file::is_changed(&e) {
            return Self(422, source_file::changed().0);
        }
        let note = message::coded(&e).cloned().unwrap_or_else(|| format!("{e:#}").into());
        Self(422, note)
    }
}
type ApiResult<T> = Result<T, ApiError>;

fn not_found() -> ApiError {
    ApiError(404, note!("series.notFound", "Series not found; import it first"))
}
/// Main gave the request up while it waited; nobody reads this.
fn abandoned() -> ApiError {
    ApiError(499, "Request cancelled".to_string().into())
}
fn next_revision() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}
fn check_revision(series: &SourceSeries, expected: Option<u64>) -> ApiResult<()> {
    if expected.is_some_and(|revision| revision != series.info.catalog_revision) {
        return Err(ApiError(409, note!("series.replaced", "This series was replaced. Open the current series again.")));
    }
    Ok(())
}
fn source(core: &App, id: &str) -> ApiResult<Arc<SourceSeries>> {
    core.sources.read().unwrap().get(id).cloned().ok_or_else(not_found)
}

/// Ends the shared progress record when a job's work ends, also when the work panics.
struct FinishProgress;
impl Drop for FinishProgress {
    fn drop(&mut self) {
        progress::finish();
    }
}

/// Work done one at a time: imports, removals and volume decodes share one queue, frame decodes another. Turns are
/// given in the order they were asked for, as tokio's semaphore gave them.
struct Queue {
    state: Mutex<QueueState>,
    changed: Condvar,
}
#[derive(Default)]
struct QueueState {
    busy: bool,
    waiting: VecDeque<u64>,
    next: u64,
}
impl Queue {
    fn new() -> Self {
        Self { state: Mutex::new(QueueState::default()), changed: Condvar::new() }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
    /// Waits for this queue's turn, which the returned value holds until dropped. A request main cancels while it
    /// waits leaves the line without its turn (paging cancels frame requests by the dozen; each would decode a whole
    /// file). Work is done on the thread that holds the turn, so the turn lasts until the work ends: a cancelled
    /// request never frees it early, and a job's progress record is never left "running" with nobody to finish it.
    #[allow(clippy::disallowed_methods)] // the one place a queue's turn is waited for (clippy.toml)
    fn turn(&self, cancelled: &AtomicBool) -> ApiResult<Turn<'_>> {
        let mut state = self.lock();
        let ticket = state.next;
        state.next += 1;
        state.waiting.push_back(ticket);
        loop {
            if cancelled.load(Ordering::Acquire) {
                state.waiting.retain(|waiting| *waiting != ticket);
                drop(state);
                self.changed.notify_all();
                return Err(abandoned());
            }
            if !state.busy && state.waiting.front() == Some(&ticket) {
                state.waiting.pop_front();
                state.busy = true;
                return Ok(Turn { queue: self });
            }
            state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
    /// Lets waiting requests see that main cancelled them.
    fn wake(&self) {
        let _state = self.lock();
        self.changed.notify_all();
    }
}
/// After main cancels a request, wakes every queue a request can wait in, so a cancelled one leaves at once
/// instead of after whatever is running there finishes.
fn wake_cancelled(core: &Core) {
    core.jobs.wake();
    core.frames.wake();
    core.samples.wake();
    #[cfg(any(target_os = "macos", windows))]
    {
        core.gpu.wake();
        core.mesh.wake();
    }
}
/// A queue's turn, given back when dropped.
struct Turn<'a> {
    queue: &'a Queue,
}
impl Turn<'_> {
    /// Runs the import or decode `progress::begin` was called for in this turn; its end (also by panic) finishes the
    /// progress record.
    fn job<T>(&self, work: impl FnOnce() -> T) -> T {
        let _finish = FinishProgress;
        work()
    }
}
impl Drop for Turn<'_> {
    fn drop(&mut self) {
        self.queue.lock().busy = false;
        self.queue.changed.notify_all();
    }
}
/// Never cancelled: background work and tests.
static KEPT: AtomicBool = AtomicBool::new(false);

/// What main asks: `op` names the operation, `body` holds what an HTTP route had in its JSON body or its path.
#[derive(Deserialize)]
struct Call {
    op: String,
    #[serde(default)]
    body: Option<Value>,
}
fn body<T: DeserializeOwned>(body: Option<Value>) -> ApiResult<T> {
    serde_json::from_value(body.unwrap_or(Value::Null)).map_err(|e| ApiError(400, format!("Invalid request: {e}").into()))
}
#[derive(Deserialize)]
struct SeriesRef {
    id: String,
    revision: Option<u64>,
}
#[derive(Deserialize)]
struct FrameRef {
    id: String,
    revision: Option<u64>,
    index: usize,
}
fn ok(value: &impl Serialize) -> ApiResult<Reply> {
    Ok(Reply::json(200, value))
}
fn handle(core: &App, request: &pipe::Request) -> Reply {
    let result = (|| {
        let call: Call = serde_json::from_slice(request.call()).map_err(|_| ApiError(400, "Invalid engine request".to_string().into()))?;
        if progress::is_stopping() && call.op != "shutdown" {
            return Err(ApiError(503, note!("core.stopping", "Native core is shutting down")));
        }
        let cancelled = request.abandoned();
        match call.op.as_str() {
            "health" => ok(&health()),
            "processCounters" => ok(&resources::snapshot()),
            "progress" => ok(&progress::snapshot()),
            "pictureNext" => Ok(next_picture(cancelled)),
            "pictureAnswer" => answer_picture(body(call.body)?, request.data()),
            "cancel" => cancel_job(call.body),
            "shutdown" => {
                progress::shutdown();
                request.stop_server();
                ok(&json!({"ok":true}))
            }
            "series" => ok(&list_series(core)),
            "import" => import_series(core, cancelled, body(call.body)?).and_then(|result| ok(&result)),
            "importEarly" => ok(&early_series(core, body(call.body)?)),
            "removeSeries" => remove_series(core, cancelled, body(call.body)?).and_then(|result| ok(&result)),
            "volume" => {
                let series: SeriesRef = body(call.body)?;
                volume(core, cancelled, &series.id, series.revision)
            }
            "warm" => warm_volume(core, request, body::<SeriesRef>(call.body)?.id),
            "frame" => {
                let FrameRef { id, index, revision } = body(call.body)?;
                frame(core, cancelled, &id, index, revision)
            }
            "tags" => series_tags(core, body(call.body)?).and_then(|result| ok(&result)),
            "sample" => imaging_ops::sample(core, cancelled, body(call.body)?),
            #[cfg(any(target_os="macos",windows))]
            "renderInfo" | "renderPattern" | "renderView" | "renderVolume" | "renderLayers" | "renderMesh" =>
                imaging_ops::render(core, request, call),
            "measure" => measure_series(core, cancelled, body(call.body)?).and_then(|result| ok(&result)),
            "export" => export_series(core, request, body(call.body)?).and_then(|result| ok(&result)),
            "exportEstimate" => estimate_export(core, body(call.body)?).and_then(|result| ok(&result)),
            "exportCancel" => {
                let operation: Value = body(call.body)?;
                ok(&json!({"requested": operation["operation"].as_str().is_some_and(|id| request.cancel_export(id))}))
            }
            _ => Err(ApiError(404, "Unknown engine operation".to_string().into())),
        }
    })();
    result.unwrap_or_else(ApiError::reply)
}
fn health() -> Value {
    json!({"ok":true,"version":env!("CARGO_PKG_VERSION"),"protocol":pipe::PROTOCOL,"transport":"little-endian","capabilities":{"dicom":true,"jpeg":true,"jpegLs":true,"rle":true,"jpeg2000":true,"png":true,"zip":true,"dicomdir":true,"color":true,"palette":true,"wideScalars":true}})
}
fn next_picture(cancelled: &AtomicBool) -> Reply {
    let Some(task) = pictures::next(Duration::from_secs(20), cancelled) else {
        return picture_ack();
    };
    Reply {
        status: 200,
        headers: vec![
            ("content-type", "application/octet-stream".into()),
            ("x-picture-id", task.id.to_string()),
            ("x-picture-want", task.want.name().into()),
        ],
        body: Box::new(task.bytes),
    }
}
fn picture_ack() -> Reply {
    Reply { status: 204, headers: Vec::new(), body: Box::new([]) }
}
#[derive(Deserialize)]
struct PictureAnswer {
    id: String,
    width: Option<u32>,
    height: Option<u32>,
    error: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    more: bool,
}
fn answer_picture(answer: PictureAnswer, bytes: &[u8]) -> ApiResult<Reply> {
    let invalid = || ApiError(400, "Invalid picture answer".into());
    let id = answer.id.parse().map_err(|_| invalid())?;
    let accepted = match answer.error {
        Some(error) => pictures::answer(id, Err(error.chars().take(300).collect())),
        None => pictures::answer_part(
            id,
            answer.width.ok_or_else(invalid)?,
            answer.height.ok_or_else(invalid)?,
            answer.offset,
            answer.more,
            bytes,
        ),
    };
    if !accepted {
        return Err(ApiError(404, "No picture is waiting for this answer".into()));
    }
    Ok(picture_ack())
}
/// Cancels the job `{"id"}` names (from progress), if it is still the one running; without a body, whatever runs.
fn cancel_job(body: Option<Value>) -> ApiResult<Reply> {
    #[derive(Deserialize)]
    struct CancelRequest { id: u64 }
    let Some(body) = body else {
        return ok(&json!({"requested":progress::cancel()}));
    };
    let request: CancelRequest = serde_json::from_value(body).map_err(|_| ApiError(400, "Invalid cancel request".to_string().into()))?;
    ok(&json!({"requested":progress::cancel_operation(request.id)}))
}
fn list_series(core: &App) -> ImportResult {
    ImportResult {
        series: core
            .sources
            .read()
            .unwrap()
            .values()
            .map(|s| s.info.clone())
            .collect(),
        warnings: Default::default(),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportRequest {
    paths: Vec<String>,
    #[serde(default)]
    request_id: String,
}
fn import_series(core: &App, cancelled: &AtomicBool, request: ImportRequest) -> ApiResult<ImportResult> {
    if request.request_id.len() > 128 {
        return Err(ApiError(400, "Invalid import request id".into()));
    }
    if request.paths.len() > ingest::MAX_FILES {
        return Err(ApiError(400, note!("import.tooManyPaths", "Select at most 50,000 paths per import")));
    }
    if core.archives.lock().unwrap().len() >= 24 {
        return Err(ApiError(422,note!("import.tooManyArchives", "This session already holds 24 extracted archives; restart before importing more archives")));
    }
    let turn = core.jobs.turn(cancelled)?;
    progress::check()?;
    progress::begin("import", 0);
    let revision = {
        let mut early = core.early.lock().unwrap();
        early.import += 1;
        early.request_id = request.request_id;
        early.series.clear();
        early.added.clear();
        early.import
    };
    turn.job(|| {
        // A series handed over early goes into the catalogue at once, so its frames can be shown while the rest is
        // read (frame does not wait for imports). Only series not open already: those stay as they are to the end.
        let hand_over = |found: Vec<Arc<SourceSeries>>| {
            let mut sources = core.sources.write().unwrap();
            let mut early = core.early.lock().unwrap();
            for mut source in found {
                if sources.contains_key(&source.info.id) {
                    continue;
                }
                Arc::make_mut(&mut source).info.catalog_revision = next_revision();
                early.added.push(source.info.id.clone());
                early.series.push(source.info.clone());
                sources.insert(source.info.id.clone(), source);
            }
        };
        let imported = ingest::import_session(&request.paths, Some(&hand_over), revision);
        let result = finish_import(core, imported);
        // Commit or retract early series while the work holds its turn, even if main cancelled the request.
        let added = {
            let mut early = core.early.lock().unwrap();
            early.series.clear();
            early.request_id.clear();
            std::mem::take(&mut early.added)
        };
        if !added.is_empty() {
            let kept: HashSet<&str> = result.as_ref().map(|result| result.series.iter().map(|series| series.id.as_str()).collect()).unwrap_or_default();
            let mut sources = core.sources.write().unwrap();
            for id in added.iter().filter(|id| !kept.contains(id.as_str())) {
                sources.remove(id);
            }
        }
        result
    })
}
/// Puts an import's series in the catalogue (replacing any of the same id, those added early among them) within the
/// session's limits, and keeps its archives' extractions.
fn finish_import(core: &App, imported: anyhow::Result<ingest::Imported>) -> ApiResult<ImportResult> {
    let mut imported = imported?;
    {
        let sources = core.sources.read().unwrap();
        let early = core.early.lock().unwrap();
        let provisional: HashSet<_> = early.added.iter().collect();
        for incoming in &mut imported.sources {
            let previous = sources.get(&incoming.info.id).filter(|s| provisional.contains(&s.info.id)
                && s.documents.len() == incoming.documents.len()
                && s.documents.iter().zip(&incoming.documents).all(|(a, b)| Arc::ptr_eq(a, b))
                && s.frames.len() == incoming.frames.len()
                && s.frames.iter().zip(&incoming.frames).all(|(a, b)| a.index == b.index && Arc::ptr_eq(&a.source, &b.source)));
            let revision = previous.map_or_else(next_revision, |s| s.info.catalog_revision);
            Arc::make_mut(incoming).info.catalog_revision = revision;
        }
    }
    let costs=imported.sources.iter().map(|source| {
        let metadata=import_budget::serialized_size(&source.info)?;
        let mut counted = HashSet::new();
        let frame_bytes = source.frames.iter().map(|frame| {
            let file_bytes = if counted.insert(&frame.source.path) { frame.source.retained_bytes() } else { 0 };
            size_of::<model::Frame>() + frame.sop_uid.len() + file_bytes
        }).sum::<usize>();
        let document_bytes = source.documents.iter().map(|f| size_of::<Arc<source_file::SourceFile>>() + f.retained_bytes()).sum::<usize>();
        let bytes=metadata.checked_mul(2).and_then(|n| n.checked_add(frame_bytes)).and_then(|n| n.checked_add(document_bytes)).ok_or_else(||anyhow::anyhow!("Catalog size overflow"))?;
        Ok((source.info.id.clone(),bytes))
    }).collect::<anyhow::Result<BTreeMap<_,_>>>()?;
    let mut result = ImportResult {
        series: imported.sources.iter().map(|s| s.info.clone()).collect(),
        warnings: imported.warnings.into(),
    };
    {
        let mut sources = core.sources.write().unwrap();
        let incoming_studies: HashSet<_> = imported.sources.iter().map(|s| s.info.study_uid.as_str()).collect();
        let mut patients = BTreeMap::new();
        let conflict = imported.sources.iter().chain(sources.values()).any(|s| {
            incoming_studies.contains(s.info.study_uid.as_str()) && patients.insert(&s.info.study_uid, &s.info.patient_key)
                .is_some_and(|previous| previous != &s.info.patient_key)
        });
        if conflict {
            result.warnings.push(note!("import.patientConflict", "This study UID has conflicting patient identities. Their images have been kept in separate series."));
        }
        let mut catalog=core.catalog_bytes.lock().unwrap();
        let mut frames=sources.values().map(|s|s.frames.len() + s.documents.len()).sum::<usize>();
        let mut bytes=catalog.values().sum::<usize>();
        for incoming in &imported.sources {
            frames=frames.saturating_sub(sources.get(&incoming.info.id).map_or(0,|s|s.frames.len() + s.documents.len())).saturating_add(incoming.frames.len() + incoming.documents.len());
            bytes=bytes.saturating_sub(*catalog.get(&incoming.info.id).unwrap_or(&0)).saturating_add(costs[&incoming.info.id]);
        }
        if frames>100_000 || bytes>512*1024*1024 {
            return Err(ApiError(422,note!("import.catalogFull", "The session catalog reached its resource limit; restart the viewer before importing more studies")));
        }
        let mut cache = core.cache.lock().unwrap();
        for s in imported.sources {
            cache.remove(&s.info.id);
            catalog.insert(s.info.id.clone(),costs[&s.info.id]);
            sources.insert(s.info.id.clone(), s);
        }
    }
    core.archives.lock().unwrap().extend(imported.archives);
    Ok(result)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EarlyQuery {
    #[serde(default)]
    after: usize,
    #[serde(default)]
    request_id: String,
}
/// Written as import writes its series, so an early series and the final one compare field by field.
#[derive(Serialize)]
struct EarlyList {
    import: u64,
    series: Vec<model::Series>,
}
/// The series the import under way has handed over early, from the `after`th on (see ingest::import_with).
fn early_series(core: &App, query: EarlyQuery) -> EarlyList {
    let early = core.early.lock().unwrap();
    let from = query.after.min(early.series.len());
    let series = if query.request_id == early.request_id { early.series[from..].to_vec() } else { Vec::new() };
    EarlyList { import: early.import, series }
}
#[derive(Deserialize)]
struct RemoveRequest {
    ids: Vec<String>,
}
/// Series taken off the viewer's list: their catalog entries and decoded volumes go, which frees
/// the session's catalog limit too. Once the list is empty the extracted archives go as well,
/// since nothing reads from them any more. Serialised with imports by the jobs queue.
fn remove_series(core: &App, cancelled: &AtomicBool, request: RemoveRequest) -> ApiResult<Value> {
    if request.ids.len() > ingest::MAX_FILES {
        return Err(ApiError(400, "Too many series in one request".to_string().into()));
    }
    let _turn = core.jobs.turn(cancelled)?;
    let mut removed = 0usize;
    let remaining = {
        let mut sources = core.sources.write().unwrap();
        let mut catalog = core.catalog_bytes.lock().unwrap();
        let mut cache = core.cache.lock().unwrap();
        for id in &request.ids {
            if sources.remove(id).is_some() {
                removed += 1;
            }
            catalog.remove(id);
            cache.remove(id);
        }
        sources.len()
    };
    for id in &request.ids {
        frames::forget(id);
        #[cfg(any(target_os="macos",windows))]
        imaging_ops::forget_series(id);
    }
    if remaining == 0 {
        core.archives.lock().unwrap().clear();
    }
    Ok(json!({"removed": removed, "remaining": remaining}))
}
/// A cached volume and the catalog entry it was decoded from, read together under the catalog's lock, which an import
/// or a removal holds while it drops the cached volume of a series it replaces.
fn cached(core: &App, id: &str) -> ApiResult<Option<(Arc<PixelBuffer>, Arc<SourceSeries>)>> {
    let sources = core.sources.read().unwrap();
    let series = sources.get(id).cloned().ok_or_else(not_found)?;
    let volume = core.cache.lock().unwrap().get(id);
    Ok(volume.map(|volume| (volume, series)))
}
fn load_volume(core: &App, id: &str, warming: bool, cancelled: &AtomicBool) -> ApiResult<(Arc<PixelBuffer>, Arc<SourceSeries>)> {
    if let Some(hit) = cached(core, id)? {
        return Ok(hit);
    }
    let turn = core.jobs.turn(cancelled)?;
    progress::check()?;
    if let Some(hit) = cached(core, id)? {
        return Ok(hit);
    }
    // The series as the catalog holds it now. Imports and removals need this turn to change the catalog, so it stays
    // this series until its volume is stored. Read before waiting for the turn, it could be a series an import has
    // replaced meanwhile, whose pixels were then cached under the new one.
    let series = source(core, id)?;
    progress::begin("decode", series.frames.len());
    let decoded = turn.job(|| decode::decode_volume(&series));
    let volume = Arc::new(decoded?);
    // A request main gave up while it decoded is not answered, and its volume is not kept, as a dropped HTTP request's
    // was not.
    if cancelled.load(Ordering::Acquire) {
        return Err(abandoned());
    }
    // Stored while this job still holds the turn, so a request waiting on it finds the volume.
    let mut cache = core.cache.lock().unwrap();
    if warming {
        cache.hand_off(id.to_string(), volume.clone());
    } else {
        cache.put(id.to_string(), volume.clone());
    }
    Ok((volume, series))
}
/// Pixels sent from the buffer the volume cache shares, without a copy.
fn pixel_reply(pixels: Arc<PixelBuffer>, components: u8, revision:u64) -> Reply {
    Reply {
        status: 200,
        headers: vec![
            ("content-type", "application/octet-stream".into()),
            ("cache-control", "no-store".into()),
            ("x-source-revision",revision.to_string()), ("x-pixel-type", pixels.type_name().into()),
            ("x-components", components.to_string()),
        ],
        body: Box::new(Volume(pixels)),
    }
}
fn volume(core: &App, cancelled: &AtomicBool, id: &str, revision: Option<u64>) -> ApiResult<Reply> {
    let (pixels, series) = load_volume(core, id, false, cancelled)?;
    check_revision(&series, revision)?;
    Ok(pixel_reply(pixels, series.info.components, series.info.source_revision))
}
// Decodes a series into the volume cache in the background; the viewer's own volume request then finds it
// ready, or waits for this decode instead of starting another.
fn warm_volume(core: &App, request: &pipe::Request, id: String) -> ApiResult<Reply> {
    source(core, &id)?;
    let core = core.clone();
    if !request.warm(move || {
        let _ = load_volume(&core, &id, true, &KEPT);
    }) { return Err(ApiError(503, "Imaging engine is busy".into())); }
    Ok(Reply::json(202, &json!({ "warming": true })))
}
/// A header value main's Headers accepts: visible ASCII and tabs, as HTTP allowed.
fn header_value(value: &str) -> bool {
    value.bytes().all(|b| (0x20..0x7f).contains(&b) || b == b'\t')
}
fn frame(core: &App, cancelled: &AtomicBool, id: &str, index: usize, revision: Option<u64>) -> ApiResult<Reply> {
    let series = source(core, id)?;
    check_revision(&series, revision)?;
    if index >= series.frames.len() {
        return Err(ApiError(404, "Frame index is out of bounds".into()));
    }
    let _turn = core.frames.turn(cancelled)?;
    if progress::is_stopping() {
        return Err(ApiError(503, note!("core.stopping", "Native core is shutting down")));
    }
    // As the catalogue has the series now: an import may have replaced it while this request waited.
    let series = source(core, id)?;
    check_revision(&series, revision)?;
    if index >= series.frames.len() {
        return Err(ApiError(404, "Frame index is out of bounds".into()));
    }
    let metadata = series.frames[index].metadata.clone();
    // Each decode reads the whole file. Paging cancels requests by the dozen; holding the turn until the decode ends
    // keeps one decode at a time instead of one beside every cancelled one. Read from the file, not the shared frame
    // cache, so a file changed since its import is refused here (file.sourceChanged) rather than shown from memory.
    let pixels = Arc::new(decode::decode_frame(&series, index)?);
    let mut reply = pixel_reply(pixels,series.info.components,series.info.source_revision);
    reply.headers.push(("x-source-frame-index", index.to_string()));
    if !metadata.sop_instance_uid.is_empty() {
        if !header_value(&metadata.sop_instance_uid) {
            return Err(ApiError(422, "Invalid source frame identifier".into()));
        }
        reply.headers.push(("x-sop-instance-uid", metadata.sop_instance_uid.clone()));
    }
    if let Some(number) = metadata.source_frame_number {
        reply.headers.push(("x-source-frame-number", number.to_string()));
    }
    Ok(reply)
}
#[derive(Deserialize)]
struct TagsQuery {
    id: String,
    revision: Option<u64>,
    frame: Option<usize>,
}
/// The tags of the file holding frame `frame` of the series (the slice shown), or of its first frame.
fn series_tags(core: &App, query: TagsQuery) -> ApiResult<Value> {
    let series = source(core, &query.id)?;
    check_revision(&series, query.revision)?;
    if let Some(file) = series.documents.first() {
        return Ok(serde_json::to_value(tags::read_source_tags(file.open()?, &file.path)?).unwrap());
    }
    let frame = &series.frames[query.frame.filter(|n| *n < series.frames.len()).unwrap_or(0)];
    if frame.ordinary_image {
        return Ok(json!([]));
    }
    Ok(serde_json::to_value(tags::read_source_tags(frame.source.open()?, &frame.source.path)?).unwrap())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeasureRequest {
    series_id: String,
    points: Vec<[f64; 3]>,
    kind: String,
    #[serde(default)]
    plane: Option<measure::Plane>,
}
fn measure_series(core: &App, cancelled: &AtomicBool, request: MeasureRequest) -> ApiResult<Value> {
    if request.points.len() > 10_000 {
        return Err(ApiError(400, "Too many measurement points".into()));
    }
    let (pixels, series) = if matches!(
        request.kind.as_str(),
        "length" | "line" | "distance" | "polyline" | "angle" | "cobb"
    ) {
        (Arc::new(PixelBuffer::U8(Vec::new())), source(core, &request.series_id)?)
    } else {
        load_volume(core, &request.series_id, false, cancelled)?
    };
    Ok(measure::measure_with_plane(
        &series,
        &pixels,
        &request.points,
        &request.kind,
        request.plane.as_ref(),
    )?)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportRequest {
    #[serde(default)]
    reviewed_revisions: BTreeMap<String, u64>,
    #[serde(default)]
    series_id: Option<String>,
    #[serde(default)]
    series_ids: Vec<String>,
    /// The current slice alone: that frame of the one series asked for.
    #[serde(default)]
    frame: Option<usize>,
    #[serde(flatten)]
    options: export::ExportOptions,
}
fn export_series(core: &App, call: &pipe::Request, mut request: ExportRequest) -> ApiResult<Value> {
    request.options.cancelled = request.options.operation.as_deref().and_then(|id| call.export_flag(id));
    request.options.check()?;
    let files = export_files(core, &request, true)?;
    Ok(serde_json::to_value(export::export_indexed(&files, &request.options)?).unwrap())
}
/// How big a ZIP export would come out and how long it would take, from a few of its files really compressed.
fn estimate_export(core: &App, request: ExportRequest) -> ApiResult<Value> {
    let files = export_files(core, &request, false)?;
    let result = export::estimate_indexed(&files, &request.options)?;
    Ok(serde_json::to_value(result).unwrap())
}
/// The source files of the series (or the one slice) an export asks for.
fn export_files(core: &App, request: &ExportRequest, writing: bool) -> ApiResult<Vec<Arc<source_file::SourceFile>>> {
    let mut ids = request.series_ids.clone();
    if let Some(id) = &request.series_id {
        ids.push(id.clone());
    }
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Err(ApiError(400, note!("export.noSeries", "Select at least one series to export")));
    }
    if request.frame.is_some() && ids.len() != 1 {
        return Err(ApiError(400, "Select exactly one series for current-slice export.".into()));
    }
    let mut files = Vec::new();
    for id in ids {
        let series = source(core, &id)?;
        if writing && request.options.full && request.options.anonymize {
            let revision = request.reviewed_revisions.get(&id).ok_or_else(|| ApiError(409,
                note!("export.pixelReview", "Review the selected images for identifying text before a full cleanup export.")))?;
            check_revision(&series, Some(*revision))?;
        }
        if series.frames.iter().any(|f| f.ordinary_image) {
            return Err(ApiError(422, note!("export.ordinaryImages", "Ordinary images cannot be exported as original DICOM")));
        }
        match request.frame {
            Some(index) => {
                let frame = series.frames.get(index).ok_or_else(|| ApiError(422, note!("export.sourceFrame", "No acquired DICOM frame at this index")))?;
                if frame.metadata.source_frame_number.is_some() {
                    return Err(ApiError(422, note!("export.multiframeSlice", "This slice belongs to a multiframe DICOM. Choose the whole series or export this slice as an image.")));
                }
                files.push(frame.source.clone());
            }
            None => {
                files.extend(series.frames.iter().map(|frame| frame.source.clone()));
                files.extend(series.documents.iter().cloned());
            }
        }
    }
    if files.is_empty() {
        return Err(ApiError(400, note!("export.noSeries", "Select at least one series to export")));
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path && a.same_contents(b));
    Ok(files)
}
fn new_core(cache_limit: usize) -> App {
    Arc::new(Core {
        sources: RwLock::new(BTreeMap::new()),
        catalog_bytes: Mutex::new(BTreeMap::new()),
        cache: Mutex::new(Cache { entries: VecDeque::new(), bytes: 0, limit: cache_limit, handoff: None }),
        archives: Mutex::new(Vec::new()),
        jobs: Queue::new(),
        frames: Queue::new(),
        samples: Queue::new(),
        #[cfg(any(target_os="macos",windows))]
        gpu: Queue::new(),
        #[cfg(any(target_os="macos",windows))]
        mesh: Queue::new(),
        #[cfg(any(target_os="macos",windows))]
        layer_uploads: Mutex::default(),
        early: Mutex::new(EarlyImport::default()),
    })
}
fn main() -> anyhow::Result<()> {
    // First: the pipes are the protocol from here on, and a print to fd 1 must not reach main.
    let (input, output) = pipe::stdio()?;
    if let Err(error)=archive_temp::cleanup_stale() {eprintln!("Archive cleanup could not complete: {error}");}
    let limit = std::env::var("VEACOM_CACHE_MIB")
        .ok()
        .and_then(|x| x.parse::<usize>().ok())
        .unwrap_or(256)
        .clamp(64, 2048)
        * 1024
        * 1024;
    let core = new_core(limit);
    let (serving, waking) = (core.clone(), core.clone());
    let mut server = pipe::Server::start(input, output, move |request| handle(&serving, request), move || {
        wake_cancelled(&waking);
        pictures::wake_poll();
    })?;
    // Until the shutdown request, or main closing stdin (it quit or crashed): an engine without its app exits.
    server.wait_for_stop();
    progress::shutdown();
    pictures::stop();
    server.drain();
    core.sources.write().unwrap().clear();
    core.catalog_bytes.lock().unwrap().clear();
    core.cache.lock().unwrap().clear();
    core.archives.lock().unwrap().clear();
    server.finish(Duration::from_secs(1));
    Ok(())
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    fn volume(values: usize) -> Arc<PixelBuffer> {
        Arc::new(PixelBuffer::U16(vec![0; values]))
    }

    #[test]
    fn a_warmed_volume_too_large_to_cache_is_handed_to_one_request() {
        let mut cache = Cache { entries: VecDeque::new(), bytes: 0, limit: 64, handoff: None };
        let large = volume(64);
        cache.hand_off("large".into(), large.clone());
        assert_eq!(cache.bytes, 0);
        assert!(Arc::ptr_eq(&cache.get("large").unwrap(), &large));
        assert!(cache.get("large").is_none());
        // One that fits stays cached as before, and repeated requests find it.
        cache.hand_off("small".into(), volume(8));
        assert!(cache.get("small").is_some() && cache.get("small").is_some());
        // A re-import drops a pending hand-off, as it drops cached pixels.
        cache.hand_off("large".into(), large);
        cache.remove("large");
        assert!(cache.get("large").is_none());
        cache.hand_off("large".into(), volume(64));
        cache.clear();
        assert!(cache.get("large").is_none() && cache.get("small").is_none());
    }

    #[test]
    fn a_warmed_volume_too_large_to_cache_leaves_the_cached_ones_alone() {
        let mut cache = Cache { entries: VecDeque::new(), bytes: 0, limit: 64, handoff: None };
        cache.put("small".into(), volume(8));
        cache.hand_off("large".into(), volume(64));
        assert!(cache.get("small").is_some(), "pre-loading another series does not empty the cache");
        assert!(cache.get("large").is_some());
    }
}

#[cfg(test)]
mod job_tests {
    use super::*;
    use dicom_core::{DataElement, PrimitiveValue, Tag, VR};
    use dicom_object::{FileMetaTableBuilder, InMemDicomObject};
    use std::{sync::mpsc, thread, time::Duration};

    /// The progress record is one per process: the tests that start jobs take turns.
    static PROGRESS: Mutex<()> = Mutex::new(());
    pub(super) fn progress_lock() -> std::sync::MutexGuard<'static, ()> {
        PROGRESS.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub(super) fn slice(directory: &std::path::Path, name: &str, value: u16) -> String {
        write_slice(directory, name, value)
    }

    /// A synthetic 2 × 2 MR slice of `value`, in the one series every call shares.
    fn write_slice(directory: &std::path::Path, name: &str, value: u16) -> String {
        let instance = format!("2.25.{value}");
        let mut slice = InMemDicomObject::from_element_iter([
            DataElement::new(Tag(0x0008, 0x0016), VR::UI, "1.2.840.10008.5.1.4.1.1.4"),
            DataElement::new(Tag(0x0008, 0x0018), VR::UI, instance.as_str()),
            DataElement::new(Tag(0x0008, 0x0060), VR::CS, "MR"),
            DataElement::new(Tag(0x0010, 0x0010), VR::PN, "SYNTHETIC"),
            DataElement::new(Tag(0x0020, 0x000d), VR::UI, "2.25.1"),
            DataElement::new(Tag(0x0020, 0x000e), VR::UI, "2.25.2"),
            DataElement::new(Tag(0x0020, 0x0052), VR::UI, "2.25.3"),
            DataElement::new(Tag(0x0020, 0x0032), VR::DS, "0\\0\\0"),
            DataElement::new(Tag(0x0020, 0x0037), VR::DS, "1\\0\\0\\0\\1\\0"),
            DataElement::new(Tag(0x0028, 0x0004), VR::CS, "MONOCHROME2"),
            DataElement::new(Tag(0x0028, 0x0030), VR::DS, "1\\1"),
            DataElement::new(Tag(0x0018, 0x0050), VR::DS, "1"),
        ]);
        for (tag, number) in [
            (Tag(0x0028, 0x0010), 2u16), (Tag(0x0028, 0x0011), 2), (Tag(0x0028, 0x0002), 1),
            (Tag(0x0028, 0x0100), 16), (Tag(0x0028, 0x0101), 16), (Tag(0x0028, 0x0102), 15), (Tag(0x0028, 0x0103), 0),
        ] {
            slice.put(DataElement::new(tag, VR::US, PrimitiveValue::from(number)));
        }
        slice.put(DataElement::new(Tag(0x7fe0, 0x0010), VR::OW, PrimitiveValue::U16(vec![value; 4].into())));
        let path = directory.join(name);
        slice
            .with_meta(FileMetaTableBuilder::new()
                .media_storage_sop_class_uid("1.2.840.10008.5.1.4.1.1.4")
                .media_storage_sop_instance_uid(instance.as_str())
                .transfer_syntax("1.2.840.10008.1.2.1"))
            .unwrap()
            .write_to_file(&path)
            .unwrap();
        path.to_string_lossy().into_owned()
    }
    fn import_one(path: String) -> Arc<SourceSeries> {
        ingest::import(&[path]).ok().unwrap().sources.remove(0)
    }
    fn core() -> App {
        new_core(1 << 20)
    }
    fn values(pixels: &PixelBuffer) -> Vec<f64> {
        match pixels {
            PixelBuffer::I16(v) => v.iter().map(|&x| x as f64).collect(),
            PixelBuffer::U16(v) => v.iter().map(|&x| x as f64).collect(),
            PixelBuffer::U8(v) => v.iter().map(|&x| x as f64).collect(),
            PixelBuffer::F32(v) => v.iter().map(|&x| x as f64).collect(),
            PixelBuffer::F64(v) => v.clone(),
        }
    }

    #[test]
    fn dicomdir_import_reads_only_the_indexed_files_inside_the_selected_media() {
        let source = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        let selected = write_slice(source.path(), "approved.dcm", 11);
        let opts = serde_json::from_value(json!({"directory":out.path(), "dicomdir":true})).unwrap();
        let media = export::export_series(&[selected.into()], &opts).unwrap();
        let root = std::path::Path::new(&media.directory);
        write_slice(root, "unreferenced.dcm", 22);
        let index = root.join("DICOMDIR");
        let imported = ingest::import(&[index.to_string_lossy().into_owned()]).unwrap();
        let uids: Vec<_> = imported.sources.iter().flat_map(|s| &s.frames).map(|f| f.sop_uid.as_str()).collect();
        assert_eq!(uids, ["2.25.11"]);

        let referenced = root.join("DICOM/IM000001");
        let original = std::fs::read(&referenced).unwrap();
        std::fs::copy(root.join("unreferenced.dcm"), &referenced).unwrap();
        assert!(ingest::import(&[index.to_string_lossy().into_owned()]).is_err());
        std::fs::write(&referenced, original).unwrap();
        #[cfg(unix)]
        {
            let target = root.join("DICOM/IM000001");
            std::fs::remove_file(&target).unwrap();
            std::os::unix::fs::symlink(root.join("unreferenced.dcm"), &target).unwrap();
            assert!(ingest::import(&[index.to_string_lossy().into_owned()]).is_err());
        }

        let mut obj = dicom_object::open_file(&index).unwrap();
        obj.update_value(Tag(0x0004, 0x1220), |sequence| {
            let record = sequence.items_mut().unwrap().iter_mut().find(|r| r.get(Tag(0x0004, 0x1500)).is_some()).unwrap();
            record.put_str(Tag(0x0004, 0x1500), VR::CS, "..\\PRIVATE");
        });
        obj.write_to_file(&index).unwrap();
        assert!(ingest::import(&[index.to_string_lossy().into_owned()]).is_err());
        std::fs::write(&index, b"not a directory index").unwrap();
        assert!(ingest::import(&[index.to_string_lossy().into_owned()]).is_err());
        std::fs::remove_file(&index).unwrap();
        std::fs::create_dir(&index).unwrap();
        assert!(ingest::import(&[index.to_string_lossy().into_owned()]).is_err());
        write_slice(&index, "inside.dcm", 33);
        let imported = ingest::import(&[index.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(imported.sources[0].frames.len(), 1);
        assert_eq!(imported.sources[0].frames[0].sop_uid, "2.25.33");
    }

    /// Whether `queue` gives a turn within `wait` (and gives it back at once).
    fn free_within(queue: &Queue, wait: Duration) -> bool {
        let cancelled = AtomicBool::new(false);
        thread::scope(|scope| {
            let waiting = scope.spawn(|| queue.turn(&cancelled).is_ok());
            if pipe::eventually(wait, || waiting.is_finished()) {
                return waiting.join().unwrap();
            }
            cancelled.store(true, Ordering::Release);
            queue.wake();
            assert!(!waiting.join().unwrap(), "a cancelled wait gets no turn");
            false
        })
    }

    #[test]
    fn a_job_whose_request_is_cancelled_still_ends_and_then_lets_the_next_job_run() {
        let _turn = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        let jobs = Arc::new(Queue::new());
        let cancelled = Arc::new(AtomicBool::new(false));
        let (started, running) = mpsc::channel::<()>();
        let (release, wait) = mpsc::channel::<()>();
        let request = thread::spawn({
            let (jobs, cancelled) = (jobs.clone(), cancelled.clone());
            move || {
                let turn = jobs.turn(&cancelled).ok().expect("a turn");
                progress::begin("import", 0);
                turn.job(|| {
                    started.send(()).unwrap();
                    wait.recv().unwrap();
                });
            }
        });
        running.recv().unwrap();
        // Main gives up (the app reloads its page): the request is cancelled while its work runs on.
        cancelled.store(true, Ordering::Release);
        jobs.wake();
        assert!(!free_within(&jobs, Duration::from_millis(100)), "the work keeps the queue's turn");
        release.send(()).unwrap();
        request.join().unwrap();
        assert!(free_within(&jobs, Duration::from_secs(10)), "the turn is given back when the work ends");
        // Finished, so a cancel finds nothing to stop and cannot fail the next job before it begins.
        assert_eq!(progress::snapshot()["running"], json!(false));
        progress::check().unwrap();
    }

    #[test]
    fn a_request_cancelled_while_it_waits_leaves_the_line_and_the_rest_keep_their_order() {
        let frames = Arc::new(Queue::new());
        let holder = frames.turn(&KEPT).ok().unwrap();
        let (served, order) = mpsc::channel();
        let cancelled: Vec<_> = (0..4).map(|_| Arc::new(AtomicBool::new(false))).collect();
        let mut waiting = Vec::new();
        for (index, flag) in cancelled.iter().enumerate() {
            let (queue, flag, served) = (frames.clone(), flag.clone(), served.clone());
            waiting.push(thread::spawn(move || {
                let turn = queue.turn(&flag);
                served.send((index, turn.is_ok())).unwrap();
            }));
            // In line one after another, as paging asks.
            assert!(pipe::eventually(Duration::from_secs(5), || frames.lock().waiting.len() == index + 1));
        }
        // The viewer pages on: requests 0 and 2 are cancelled before their turn.
        for index in [0, 2] {
            cancelled[index].store(true, Ordering::Release);
        }
        frames.wake();
        assert!(pipe::eventually(Duration::from_secs(5), || frames.lock().waiting.len() == 2));
        drop(holder);
        for thread in waiting {
            thread.join().unwrap();
        }
        let served: Vec<_> = order.try_iter().collect();
        let given: Vec<_> = served.iter().filter(|(_, turn)| *turn).map(|(index, _)| *index).collect();
        assert_eq!(given, [1, 3], "only the requests still wanted decode, in the order they asked");
        assert!(served.iter().filter(|(_, turn)| !*turn).all(|(index, _)| [0, 2].contains(index)));
    }

    #[test]
    fn a_volume_is_decoded_from_the_series_the_catalog_holds_once_its_job_runs() {
        let _turn = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_dir::tempdir().unwrap();
        let first = import_one(write_slice(temp.path(), "first.dcm", 100));
        let second = import_one(write_slice(temp.path(), "second.dcm", 200));
        assert_eq!(first.info.id, second.info.id, "one series, imported twice");
        let id = first.info.id.clone();
        let core = core();
        core.sources.write().unwrap().insert(id.clone(), first);
        // A second import holds the jobs queue's turn when the viewer asks for the series' volume.
        let import = core.jobs.turn(&KEPT).ok().unwrap();
        let request = thread::spawn({
            let (core, id) = (core.clone(), id.clone());
            move || load_volume(&core, &id, false, &KEPT).ok().map(|(pixels, _)| pixels)
        });
        assert!(pipe::eventually(Duration::from_secs(5), || core.jobs.lock().waiting.len() == 1));
        // It commits as import_series does: the series is replaced and its cached volume dropped.
        core.sources.write().unwrap().insert(id.clone(), second.clone());
        core.cache.lock().unwrap().remove(&id);
        drop(import);
        let expected = values(&decode::decode_volume(&second).unwrap());
        assert_eq!(values(&request.join().unwrap().expect("a volume")), expected);
        let (cached, _) = load_volume(&core, &id, false, &KEPT).ok().unwrap();
        assert_eq!(values(&cached), expected, "and the cache holds the new series' pixels, not the replaced one's");
    }

    #[test]
    fn early_series_belong_only_to_the_request_that_started_the_import() {
        let _turn = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_dir::tempdir().unwrap();
        let series = import_one(write_slice(temp.path(), "early.dcm", 100));
        let core = core();
        {
            let mut early = core.early.lock().unwrap();
            early.import = 1;
            early.request_id = "startup-import".into();
            early.series.push(series.info.clone());
        }
        for (request_id, after, count) in [("startup-import", 0, 1), ("manual-import", 0, 0), ("", 0, 0), ("startup-import", 1, 0)] {
            let query = serde_json::from_value(json!({ "requestId": request_id, "after": after })).unwrap();
            let result = early_series(&core, query);
            assert_eq!(result.series.len(), count, "{request_id} at {after}");
        }
    }

    #[test]
    fn cached_pixels_do_not_hold_the_cache_while_waiting_for_the_catalogue() {
        let _turn = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
        let temp = crate::test_dir::tempdir().unwrap();
        let series = import_one(write_slice(temp.path(), "cached.dcm", 100));
        let id = series.info.id.clone();
        let core = core();
        core.sources.write().unwrap().insert(id.clone(), series);
        core.cache.lock().unwrap().put(id.clone(), Arc::new(PixelBuffer::U16(vec![100; 4])));
        let sources = core.sources.write().unwrap();
        let (started, wait) = mpsc::channel();
        let reader = thread::spawn({
            let core = core.clone();
            move || {
                started.send(()).unwrap();
                load_volume(&core, &id, false, &KEPT).is_ok()
            }
        });
        wait.recv().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_millis(100);
        let mut cache_held = false;
        while std::time::Instant::now() < deadline {
            if core.cache.try_lock().is_err() {
                cache_held = true;
                break;
            }
            thread::yield_now();
        }
        drop(sources);
        assert!(reader.join().unwrap());
        assert!(!cache_held, "imports hold the catalogue while taking the cache; reversing that order deadlocks");
    }

    #[test]
    fn a_cancelled_export_stops_before_writing_anything() {
        let temp = crate::test_dir::tempdir().unwrap();
        let source = std::path::PathBuf::from(write_slice(temp.path(), "slice.dcm", 100));
        let destination = temp.path().join("export");
        std::fs::create_dir(&destination).unwrap();
        for zip in [false, true] {
            let options = export::ExportOptions {
                operation: Some("export-1".into()),
                cancelled: Some(Arc::new(std::sync::atomic::AtomicBool::new(true))),
                directory: destination.to_string_lossy().into_owned(),
                anonymize: false, dicomdir: false, decompress: false, root: false, full: false, zip, smallest: false,
            };
            let error = export::export_series(std::slice::from_ref(&source), &options).err().expect("cancelled");
            assert_eq!(error.to_string(), "Export cancelled; nothing was kept");
            assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0, "nothing written (zip: {zip})");
        }
    }


}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use std::{io::{PipeReader, PipeWriter}, thread};

    /// The engine as main runs it, over pipes: requests by op, answers with status, headers and body.
    struct Engine {
        requests: PipeWriter,
        replies: PipeReader,
        next: u32,
        core: App,
        _server: pipe::Server,
    }
    impl Engine {
        fn start() -> Self {
            let (input, requests) = std::io::pipe().unwrap();
            let (mut replies, output) = std::io::pipe().unwrap();
            let core = new_core(1 << 20);
            let (serving, waking) = (core.clone(), core.clone());
            let server = pipe::Server::start(input, output, move |request| handle(&serving, request), move || {
                wake_cancelled(&waking);
            }).unwrap();
            let (kind, _, hello) = pipe::read_message(&mut replies).unwrap();
            assert_eq!(kind, 0);
            assert_eq!(serde_json::from_slice::<Value>(&hello).unwrap()["protocol"], json!(pipe::PROTOCOL));
            Self { requests, replies, next: 1, core, _server: server }
        }
        /// Sends a request without waiting for its answer, as main does before it cancels one.
        fn send(&mut self, request: Value) -> u32 {
            let id = self.next;
            self.next += 1;
            let payload = pipe::tests::call(&request, b"");
            let mut message = vec![1u8];
            message.extend(id.to_le_bytes());
            message.extend((payload.len() as u32).to_le_bytes());
            message.extend(payload);
            std::io::Write::write_all(&mut self.requests, &message).unwrap();
            id
        }
        fn cancel(&mut self, id: u32) {
            let mut message = vec![3u8];
            message.extend(id.to_le_bytes());
            message.extend(0u32.to_le_bytes());
            std::io::Write::write_all(&mut self.requests, &message).unwrap();
        }
        fn call(&mut self, request: Value) -> (Value, Vec<u8>) {
            let id = self.send(request);
            let (kind, from, head) = pipe::read_message(&mut self.replies).unwrap();
            assert_eq!((kind, from), (1, id));
            let head: Value = serde_json::from_slice(&head).unwrap();
            let length = head["length"].as_u64().unwrap() as u32;
            if length > 0 && (head["headers"]["content-type"] != "application/json" || length as usize > pipe::INLINE) {
                let mut credit = vec![2u8];
                credit.extend(id.to_le_bytes());
                credit.extend(4u32.to_le_bytes());
                credit.extend(length.to_le_bytes());
                std::io::Write::write_all(&mut self.requests, &credit).unwrap();
            }
            let mut body = Vec::new();
            while body.len() < head["length"].as_u64().unwrap() as usize {
                let (kind, from, piece) = pipe::read_message(&mut self.replies).unwrap();
                assert_eq!((kind, from), (2, id));
                body.extend(piece);
            }
            (head, body)
        }
        fn json(&mut self, request: Value) -> (u64, Value) {
            let (head, body) = self.call(request);
            (head["status"].as_u64().unwrap(), serde_json::from_slice(&body).unwrap())
        }
    }

    #[test]
    fn a_cancelled_measurement_leaves_its_queue_while_another_measurement_runs() {
        let mut engine = Engine::start();
        let core = engine.core.clone();
        // A measurement in progress holds the turn; the next one waits behind it.
        let Ok(running) = core.samples.turn(&AtomicBool::new(false)) else { panic!("the measurement turn is free") };
        let id = engine.send(json!({"op": "sample", "body": {"id": "none", "sourceRevision": 1,
            "operation": {"kind": "window", "automatic": true}}}));
        let waiting = || core.samples.lock().waiting.len();
        let wait_for = |count: usize| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while waiting() != count {
                assert!(std::time::Instant::now() < deadline, "{} waiting for the measurement turn, expected {count}", waiting());
                thread::sleep(std::time::Duration::from_millis(5));
            }
        };
        wait_for(1);
        engine.cancel(id);
        // Main cancelled it: it leaves now, not when the running measurement ends.
        wait_for(0);
        drop(running);
    }

    #[test]
    fn main_reaches_every_operation_by_name_with_the_bodies_http_had() {
        let _turn = job_tests_progress();
        let temp = crate::test_dir::tempdir().unwrap();
        let path = write_test_slice(temp.path());
        let mut engine = Engine::start();
        let (status, health) = engine.json(json!({"op": "health"}));
        assert_eq!((status, health["ok"].clone(), health["protocol"].clone()), (200, json!(true), json!(pipe::PROTOCOL)));
        assert_eq!(engine.json(json!({"op": "unknown"})).0, 404);
        assert_eq!(engine.json(json!({"op": "import"})).0, 400, "a body the operation cannot read");
        let (status, imported) = engine.json(json!({"op": "import", "body": {"paths": [path], "requestId": "r1"}}));
        assert_eq!(status, 200, "{imported}");
        let id = imported["series"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(engine.json(json!({"op": "series"})).1["series"][0]["id"], json!(id));
        let (head, pixels) = engine.call(json!({"op": "frame", "body": {"id": id, "index": 0}}));
        assert_eq!(head["status"], json!(200));
        assert_eq!(head["headers"]["x-pixel-type"], json!("uint16"));
        assert_eq!(head["headers"]["x-source-frame-index"], json!("0"));
        assert_eq!(head["headers"]["x-sop-instance-uid"], json!("2.25.100"));
        assert_eq!(pixels, [100u16; 4].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<_>>());
        let (head, volume) = engine.call(json!({"op": "volume", "body": {"id": id}}));
        assert_eq!((head["headers"]["x-components"].clone(), volume.len()), (json!("1"), 8));
        assert_eq!(engine.json(json!({"op": "frame", "body": {"id": id, "index": 1}})).0, 404);
        assert_eq!(engine.json(json!({"op": "tags", "body": {"id": id}})).0, 200);
        assert_eq!(engine.json(json!({"op": "progress"})).1["running"], json!(false));
        assert_eq!(engine.json(json!({"op": "cancel"})).1, json!({"requested": false}));
        assert_eq!(engine.json(json!({"op": "cancel", "body": {"id": 1}})).1, json!({"requested": false}));
        assert_eq!(engine.json(json!({"op": "importEarly", "body": {"after": 0, "requestId": "r1"}})).1["series"], json!([]));
        assert_eq!(engine.json(json!({"op": "processCounters"})).0, 200);
        let (status, length) = engine.json(json!({"op": "measure", "body": {"seriesId": id, "points": [[0, 0, 0], [1, 0, 0]], "kind": "length"}}));
        assert_eq!((status, length["value"].clone()), (200, json!(1.0)));
        assert_eq!(engine.json(json!({"op": "exportCancel", "body": {"operation": "none"}})).1, json!({"requested": false}));
        assert_eq!(engine.json(json!({"op": "removeSeries", "body": {"ids": [id]}})).1, json!({"removed": 1, "remaining": 0}));
        let (status, error) = engine.json(json!({"op": "volume", "body": {"id": id}}));
        assert_eq!((status, error["note"]["code"].clone()), (404, json!("series.notFound")));
    }

    #[test]
    fn colliding_study_and_series_uids_keep_patient_frames_separate() {
        use dicom_core::{Tag, VR};
        let _turn = job_tests_progress();
        let temp = crate::test_dir::tempdir().unwrap();
        let mut paths = Vec::new();
        for (value, name, issuer) in [(11, "SYNTHETIC^A", "SITE-A"), (22, "SYNTHETIC^B", "SITE-B"), (33, "SYNTHETIC^A", "SITE-B")] {
            let path = super::job_tests::slice(temp.path(), &format!("slice{value}.dcm"), value);
            let mut obj = dicom_object::open_file(&path).unwrap();
            obj.put_str(Tag(0x0010, 0x0010), VR::PN, name);
            obj.put_str(Tag(0x0010, 0x0020), VR::LO, "LOCAL-1");
            obj.put_str(Tag(0x0010, 0x0021), VR::LO, issuer);
            obj.write_to_file(&path).unwrap();
            paths.push(path);
        }
        let mut engine = Engine::start();
        let (status, result) = engine.json(json!({"op":"import", "body":{"paths":paths}}));
        assert_eq!(status, 200, "{result}");
        let series = result["series"].as_array().unwrap();
        assert_eq!(series.len(), 3, "{result}");
        assert!(result["warningNotes"].as_array().unwrap().iter().any(|n| n["code"] == "import.patientConflict"));
        let mut samples = Vec::new();
        for s in series {
            assert_eq!(s["dimensions"][2], 1);
            let (head, pixels) = engine.call(json!({"op":"frame","body":{"id":s["id"],"index":0}}));
            assert_eq!(head["status"], 200);
            samples.push(u16::from_le_bytes([pixels[0],pixels[1]]));
        }
        samples.sort();
        assert_eq!(samples, [11,22,33]);
    }

    #[test]
    fn changed_source_never_supplies_pixels_tags_or_exports_under_the_old_uid() {
        use dicom_core::{Tag, VR};
        let _turn = job_tests_progress();
        let temp = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        let path = super::job_tests::slice(temp.path(), "source.dcm", 11);
        let import = json!({"op":"import", "body":{"paths":[path]}});
        let mut engine = Engine::start();
        let (status, result) = engine.json(import.clone());
        assert_eq!(status, 200, "{result}");
        let id = &result["series"][0]["id"];
        let frame = json!({"op":"frame", "body":{"id":id, "index":0}});
        let tags = json!({"op":"tags", "body":{"id":id, "frame":0}});
        let (head, pixels) = engine.call(frame.clone());
        assert_eq!(head["headers"]["x-sop-instance-uid"], json!("2.25.11"));
        assert_eq!(pixels, 11u16.to_le_bytes().repeat(4));
        assert_eq!(engine.json(tags.clone()).0, 200);

        let replacement = super::job_tests::slice(temp.path(), "replacement.dcm", 22);
        std::fs::copy(replacement, &path).unwrap();
        for preserve_uid in [false, true] {
            if preserve_uid {
                let mut other = dicom_object::open_file(&path).unwrap();
                other.put_str(Tag(0x0008, 0x0018), VR::UI, "2.25.11");
                other.meta_mut().media_storage_sop_instance_uid = "2.25.11".into();
                other.write_to_file(&path).unwrap();
            }
            for call in [
                frame.clone(), tags.clone(), json!({"op":"volume", "body":{"id":id}}),
                json!({"op":"export", "body":{"seriesId":id, "directory":out.path()}}),
                json!({"op":"export", "body":{"seriesId":id, "directory":out.path(), "zip":true}}),
                json!({"op":"exportEstimate", "body":{"seriesId":id, "directory":out.path(), "zip":true}}),
            ] {
                let op = call["op"].clone();
                let (status, error) = engine.json(call);
                assert_eq!((status, &error["note"]["code"]), (422, &json!("file.sourceChanged")), "{op}: {error}");
            }
            assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
        }
        let (status, fresh) = engine.json(import);
        assert_eq!(status, 200, "{fresh}");
        let (head, pixels) = engine.call(json!({"op":"frame", "body":{"id":fresh["series"][0]["id"], "index":0}}));
        assert_eq!(head["status"], 200);
        assert_eq!(pixels, 22u16.to_le_bytes().repeat(4));
    }

    #[test]
    fn old_pixel_and_tag_requests_cannot_follow_a_reimport() {
        use dicom_core::{DataElement, PrimitiveValue, Tag, VR};
        let _turn = job_tests_progress();
        let temp = crate::test_dir::tempdir().unwrap();
        let path = super::job_tests::slice(temp.path(), "source.dcm", 11);
        let mut engine = Engine::start();
        let import = json!({"op":"import","body":{"paths":[path]}});
        let (_, first) = engine.json(import.clone());
        let id = &first["series"][0]["id"];
        let old = first["series"][0]["catalogRevision"].as_u64().unwrap();
        let frame = |revision| json!({"op":"frame","body":{"id":id,"index":0,"revision":revision}});
        assert_eq!(engine.call(frame(old)).1, 11u16.to_le_bytes().repeat(4));
        let mut obj = dicom_object::open_file(&path).unwrap();
        obj.put(DataElement::new(Tag(0x7fe0, 0x0010), VR::OW, PrimitiveValue::U16(vec![22; 4].into())));
        obj.write_to_file(&path).unwrap();
        let (_, second) = engine.json(import);
        let new = second["series"][0]["catalogRevision"].as_u64().unwrap();
        assert!(new > old);
        assert_eq!(&second["series"][0]["id"], id);
        for op in ["frame", "volume", "tags"] {
            let (status, error) = engine.json(json!({"op":op,"body":{"id":id,"revision":old,"index":0}}));
            assert_eq!((status, &error["note"]["code"]), (409, &json!("series.replaced")));
        }
        assert_eq!(engine.call(frame(new)).1, 22u16.to_le_bytes().repeat(4));
    }

    #[test]
    fn full_export_requires_review_of_the_current_pixels_and_refuses_declared_burned_text() {
        use dicom_core::{Tag, VR};
        let _turn = job_tests_progress();
        let temp = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        let path = super::job_tests::slice(temp.path(), "synthetic.dcm", 11);
        let mut engine = Engine::start();
        let import = json!({"op":"import","body":{"paths":[path]}});
        let (_, first) = engine.json(import.clone());
        let id = first["series"][0]["id"].as_str().unwrap();
        let revision = first["series"][0]["catalogRevision"].clone();
        let request = |review: Value, zip: bool| json!({"op":"export","body":{"seriesId":id, "directory":out.path(),
            "anonymize":true, "full":true, "zip":zip, "reviewedRevisions":review}});
        assert_eq!(engine.json(request(json!({}), false)).1["note"]["code"], "export.pixelReview");
        let mut obj = dicom_object::open_file(&path).unwrap();
        obj.put_str(Tag(0x0028, 0x0301), VR::CS, "YES");
        obj.write_to_file(&path).unwrap();
        let (_, current) = engine.json(import);
        assert_eq!(engine.json(request(json!({id:revision}), false)).1["note"]["code"], "series.replaced");
        for zip in [true, false] {
            let (_, error) = engine.json(request(json!({id:current["series"][0]["catalogRevision"]}), zip));
            assert_eq!(error["note"]["code"], "export.burnedReview", "{error}");
        }
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
    }

    #[test]
    fn current_slice_refuses_multiframe_dicom_before_creating_output() {
        use dicom_core::{DataElement, PrimitiveValue, Tag, VR};
        let _turn = job_tests_progress();
        let temp = crate::test_dir::tempdir().unwrap();
        let out = crate::test_dir::tempdir().unwrap();
        let path = super::job_tests::slice(temp.path(), "frames.dcm", 11);
        let mut image = dicom_object::open_file(&path).unwrap();
        image.put_str(Tag(0x0028, 0x0008), VR::IS, "2");
        image.put(DataElement::new(Tag(0x7fe0, 0x0010), VR::OW,
            PrimitiveValue::U16(vec![11,11,11,11,22,22,22,22].into())));
        image.write_to_file(&path).unwrap();
        let mut engine = Engine::start();
        let (status, result) = engine.json(json!({"op":"import", "body":{"paths":[path]}}));
        assert_eq!(status, 200, "{result}");
        let id = &result["series"][0]["id"];
        for zip in [false, true] {
            for index in [0, 1] {
                for op in ["export", "exportEstimate"] {
                    let (status, error) = engine.json(json!({"op":op, "body":{"seriesId":id, "directory":out.path(), "frame":index, "zip":zip}}));
                    assert_eq!((status, &error["note"]["code"]), (422, &json!("export.multiframeSlice")), "{error}");
                }
            }
        }
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
        let (status, result) = engine.json(json!({"op":"export", "body":{"seriesId":id, "directory":out.path()}}));
        assert_eq!(status, 200, "{result}");
        let single = super::job_tests::slice(temp.path(), "single.dcm", 33);
        let (status, result) = engine.json(json!({"op":"import", "body":{"paths":[single]}}));
        assert_eq!(status, 200, "{result}");
        let (status, result) = engine.json(json!({"op":"export", "body":{"seriesId":result["series"][0]["id"], "directory":out.path(), "frame":0, "zip":true}}));
        assert_eq!(status, 200, "{result}");
    }

    fn job_tests_progress() -> std::sync::MutexGuard<'static, ()> {
        super::job_tests::progress_lock()
    }
    fn write_test_slice(directory: &std::path::Path) -> String {
        super::job_tests::slice(directory, "pipe.dcm", 100)
    }

    #[test]
    fn a_frame_request_main_cancels_while_another_decodes_is_never_decoded() {
        let temp = crate::test_dir::tempdir().unwrap();
        let path = super::job_tests::slice(temp.path(), "frame.dcm", 7);
        let core = new_core(1 << 20);
        core.sources.write().unwrap().insert("s".into(), ingest::import(&[path]).ok().unwrap().sources.remove(0));
        // A decode holds the frames queue; main asks for a frame, then pages on and cancels it.
        let holder = core.frames.turn(&KEPT).ok().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let waiting = thread::spawn({
            let (core, cancelled) = (core.clone(), cancelled.clone());
            move || frame(&core, &cancelled, "s", 0, None).err().map(|error| error.0)
        });
        assert!(pipe::eventually(std::time::Duration::from_secs(5), || core.frames.lock().waiting.len() == 1));
        cancelled.store(true, Ordering::Release);
        core.frames.wake();
        assert_eq!(waiting.join().unwrap(), Some(499), "it gave up waiting without decoding");
        drop(holder);
        assert!(frame(&core, &KEPT, "s", 0, None).is_ok(), "and the queue still serves the next request");
    }
}
