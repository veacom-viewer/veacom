//! The engine's one channel to Electron's main process: its stdin and stdout, which only the main process holds. No
//! port is open, so no other program or web page can reach the engine, and no token is needed.
//!
//! Every message, both ways, is `kind: u8, id: u32, length: u32` (little-endian) followed by `length` bytes.
//! - Main to engine: REQUEST starts request `id`: the call's JSON `{"op", "body"}` after its `u32` length, then any raw
//!   bytes the call carries; CREDIT (a `u32`) lets the engine send that many more bytes of response `id`'s body;
//!   CANCEL says main gave request `id` up.
//! - Engine to main: HELLO (once, first, id 0: JSON `{"protocol", "version"}`); HEAD (JSON `{"status", "headers",
//!   "length"}`) starts response `id`, whose `length` body bytes follow in DATA messages; END says the engine stopped a
//!   body short, after a CANCEL.
//!
//! Fixed workers serve control, catalog, frame, and other operations independently. Each bounded queue retains
//! requests in arrival order. Small replies can be sent immediately. Larger replies need CREDIT from the first
//! byte. One writer interleaves ready replies and writes pixels straight from the engine's shared buffer.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    io::{self, BufReader, BufWriter, ErrorKind, Read, Write},
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Condvar, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

/// Which messages this engine speaks; HELLO carries it, and main refuses an engine that speaks another.
pub const PROTOCOL: u32 = 2;
/// Main to engine.
const REQUEST: u8 = 1;
const CREDIT: u8 = 2;
const CANCEL: u8 = 3;
/// Engine to main.
const HELLO: u8 = 0;
const HEAD: u8 = 1;
const DATA: u8 = 2;
const END: u8 = 3;
const HEADER: usize = 9;
/// The largest request main may send; an import of 50,000 long paths fits.
const MAX_REQUEST: usize = 16 << 20;
/// The largest piece of a body in one DATA message.
pub const CHUNK: usize = 1 << 20;
/// Small replies can complete in the same write as their head (including a shutdown acknowledgement).
pub const INLINE: usize = 16 << 10;
const MAX_QUEUED: usize = 32;
const MAX_PENDING: usize = 64;

/// A response: an HTTP-like status, headers (lowercase names) and a body sent from the buffer it holds.
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Box<dyn AsRef<[u8]> + Send>,
}
impl Reply {
    pub fn json(status: u16, value: &impl Serialize) -> Self {
        // Values the engine sends always serialize; an empty object keeps main's JSON parse working if one did not.
        let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
        Self {
            status,
            headers: vec![("content-type", "application/json".into())],
            body: Box::new(body),
        }
    }
}

/// One request, as its thread sees it.
pub struct Request {
    pub id: u32,
    payload: Vec<u8>,
    abandoned: Arc<AtomicBool>,
    shared: Arc<Shared>,
}
impl Request {
    /// Where the call's JSON ends and its raw bytes begin; a malformed length leaves an empty call, which fails to parse.
    fn split(&self) -> (usize, usize) {
        let length = self
            .payload
            .get(..4)
            .map_or(0, |n| u32::from_le_bytes(n.try_into().unwrap()) as usize);
        let end = self.payload.len();
        if end >= 4 && length <= end - 4 {
            (4, 4 + length)
        } else {
            (end, end)
        }
    }
    /// The call: JSON `{"op", "body"}`.
    pub fn call(&self) -> &[u8] {
        let (start, end) = self.split();
        &self.payload[start..end]
    }
    /// Raw bytes following the JSON, used for a chunk of decoded picture samples.
    pub fn data(&self) -> &[u8] {
        &self.payload[self.split().1..]
    }
    /// Set when main sends CANCEL: what waits for a queue's turn gives up (as a dropped HTTP request's wait did), and
    /// the reply, if one still comes, is not sent.
    pub fn abandoned(&self) -> &AtomicBool {
        &self.abandoned
    }
    /// Ends `Server::wait_for_stop` (the shutdown request).
    pub fn stop_server(&self) {
        self.shared.stop();
    }
    pub fn export_flag(&self, operation: &str) -> Option<Arc<AtomicBool>> {
        self.shared
            .pending()
            .get(&self.id)?
            .export
            .as_ref()
            .filter(|(id, _)| id == operation)
            .map(|(_, flag)| flag.clone())
    }
    /// An export can be cancelled from admission until its worker finishes rollback.
    pub fn cancel_export(&self, operation: &str) -> bool {
        let pending = self.shared.pending();
        let Some((_, flag)) = pending
            .values()
            .filter_map(|p| p.export.as_ref())
            .find(|(id, _)| id == operation)
        else {
            return false;
        };
        flag.store(true, Ordering::Release);
        true
    }
    /// Warm decodes share the catalog worker with imports and volume requests.
    pub fn warm(&self, work: impl FnOnce() + Send + 'static) -> bool {
        self.shared
            .queue(Lane::Catalog)
            .push(Job::Warm(Box::new(work)))
            .is_ok()
    }
}

enum Event {
    Reply {
        id: u32,
        reply: Reply,
        abandoned: Arc<AtomicBool>,
    },
    Credit {
        id: u32,
        bytes: usize,
    },
    /// A request was cancelled; the writer drops its body if it is sending one.
    Wake,
    /// Shutdown: send what can be sent, then stop.
    Finish,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lane {
    Control,
    Catalog,
    Volume,
    Frame,
    PicturePoll,
    PictureAnswer,
    Other,
}
#[derive(Clone)]
struct Pending {
    lane: Lane,
    abandoned: Arc<AtomicBool>,
    export: Option<(String, Arc<AtomicBool>)>,
}
impl Pending {
    fn new(json: &[u8], abandoned: Arc<AtomicBool>) -> Self {
        #[derive(Deserialize)]
        struct Operation<'a> {
            op: &'a str,
        }
        let op = serde_json::from_slice::<Operation>(json)
            .map(|call| call.op)
            .unwrap_or("");
        let lane = match op {
            "health" | "progress" | "cancel" | "shutdown" | "exportCancel" | "processCounters" => {
                Lane::Control
            }
            "import" | "removeSeries" => Lane::Catalog,
            "volume" => Lane::Volume,
            "frame" => Lane::Frame,
            "pictureNext" => Lane::PicturePoll,
            "pictureAnswer" => Lane::PictureAnswer,
            _ => Lane::Other,
        };
        #[derive(Deserialize)]
        struct ExportCall {
            body: ExportBody,
        }
        #[derive(Deserialize)]
        struct ExportBody {
            operation: String,
        }
        let export = if op == "export" {
            serde_json::from_slice::<ExportCall>(json)
                .ok()
                .map(|c| (c.body.operation, Arc::new(AtomicBool::new(false))))
        } else {
            None
        };
        Self {
            lane,
            abandoned,
            export,
        }
    }
}

enum Job {
    Request(Request),
    Warm(Box<dyn FnOnce() + Send>),
}
impl Job {
    fn size(&self) -> usize {
        match self {
            Self::Request(r) => r.payload.len(),
            Self::Warm(_) => 0,
        }
    }
}

#[derive(Default)]
struct QueueState {
    closed: bool,
    bytes: usize,
    jobs: VecDeque<Job>,
}
#[derive(Default)]
struct WorkQueue {
    state: Mutex<QueueState>,
    ready: Condvar,
}
impl WorkQueue {
    fn push(&self, job: Job) -> Result<(), Job> {
        let mut state = self.state.lock().unwrap();
        if state.closed || state.jobs.len() >= MAX_QUEUED || state.bytes + job.size() > MAX_REQUEST
        {
            return Err(job);
        }
        state.bytes += job.size();
        state.jobs.push_back(job);
        self.ready.notify_one();
        Ok(())
    }
    fn next(&self) -> Option<Job> {
        let mut state = self
            .ready
            .wait_while(self.state.lock().unwrap(), |s| {
                s.jobs.is_empty() && !s.closed
            })
            .unwrap();
        let job = state.jobs.pop_front()?;
        state.bytes -= job.size();
        Some(job)
    }
    fn cancel(&self, id: u32) -> bool {
        let mut state = self.state.lock().unwrap();
        let Some(at) = state
            .jobs
            .iter()
            .position(|job| matches!(job, Job::Request(r) if r.id == id))
        else {
            return false;
        };
        let job = state.jobs.remove(at).unwrap();
        state.bytes -= job.size();
        true
    }
    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.ready.notify_all();
    }
}

#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<u32, Pending>>,
    queues: [WorkQueue; 7],
    stopped: Mutex<bool>,
    stopping: Condvar,
}
impl Shared {
    fn pending(&self) -> MutexGuard<'_, HashMap<u32, Pending>> {
        self.pending.lock().unwrap()
    }
    fn queue(&self, lane: Lane) -> &WorkQueue {
        &self.queues[lane as usize]
    }
    fn stop(&self) {
        *self.stopped.lock().unwrap() = true;
        for queue in &self.queues {
            queue.close();
        }
        self.stopping.notify_all();
    }
}

pub struct Server {
    shared: Arc<Shared>,
    events: mpsc::Sender<Event>,
    written: mpsc::Receiver<()>,
    workers: Vec<thread::JoinHandle<()>>,
}
impl Server {
    #[allow(clippy::disallowed_methods)] // All long-lived engine workers are owned here.
    pub fn start(
        input: impl Read + Send + 'static,
        output: impl Write + Send + 'static,
        handle: impl Fn(&Request) -> Reply + Send + Sync + 'static,
        cancelled: impl Fn() + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let shared = Arc::new(Shared::default());
        let (events, receiver) = mpsc::channel();
        let (done, written) = mpsc::channel();
        let handle = Arc::new(handle);
        let mut server = Self {
            shared: shared.clone(),
            events: events.clone(),
            written,
            workers: Vec::new(),
        };
        for (lane, name) in [
            (Lane::Control, "control"),
            (Lane::Catalog, "catalog"),
            (Lane::Frame, "frame"),
            (Lane::Volume, "volume"),
            (Lane::PicturePoll, "picture-poll"),
            (Lane::PictureAnswer, "picture-answer"),
            (Lane::Other, "tools-1"),
            (Lane::Other, "tools-2"),
        ] {
            let (shared, events, handle) = (shared.clone(), events.clone(), handle.clone());
            server
                .workers
                .push(thread::Builder::new().name(name.into()).spawn(move || {
                    while let Some(job) = shared.queue(lane).next() {
                        match job {
                            Job::Warm(work) => {
                                let _ = catch_unwind(AssertUnwindSafe(work));
                            }
                            Job::Request(r) => {
                                if r.abandoned.load(Ordering::Acquire) {
                                    shared.pending().remove(&r.id);
                                    continue;
                                }
                                let reply = catch_unwind(AssertUnwindSafe(|| handle(&r)))
                                    .unwrap_or_else(|_| {
                                        Reply::json(
                                            500,
                                            &json!({"error":"The operation stopped unexpectedly"}),
                                        )
                                    });
                                send_reply(&shared, &events, r.id, reply, r.abandoned);
                            }
                        }
                    }
                })?);
        }
        let hello = serde_json::to_vec(
            &json!({"protocol": PROTOCOL, "version": env!("CARGO_PKG_VERSION")}),
        )?;
        let writer_shared = shared.clone();
        thread::Builder::new()
            .name("pipe-writer".into())
            .spawn(move || {
                if let Err(error) = write_loop(output, &hello, &receiver, &writer_shared) {
                    eprintln!("Engine output closed: {error}");
                    writer_shared.stop();
                }
                let _ = done.send(());
            })?;
        thread::Builder::new()
            .name("pipe-reader".into())
            .spawn(move || {
                if let Err(error) = read_loop(input, &shared, &events, &cancelled) {
                    eprintln!("Engine input failed: {error}");
                }
                shared.stop();
            })?;
        Ok(server)
    }
    pub fn wait_for_stop(&self) {
        let _stopped = self
            .shared
            .stopping
            .wait_while(self.shared.stopped.lock().unwrap(), |s| !*s)
            .unwrap();
    }
    /// The catalog and export destinations belong to workers until they have finished or rolled back.
    pub fn drain(&mut self) {
        for worker in self.workers.drain(..) {
            worker.join().expect("engine worker failed");
        }
    }
    /// Sends what is queued (a body still waiting for main to read it is dropped) and stops the writer, waiting for it
    /// up to `timeout`.
    pub fn finish(self, timeout: Duration) {
        if self.events.send(Event::Finish).is_ok() {
            let _ = self.written.recv_timeout(timeout);
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shared.stop();
    }
}

fn read_loop(
    input: impl Read,
    shared: &Arc<Shared>,
    events: &mpsc::Sender<Event>,
    cancelled: &dyn Fn(),
) -> io::Result<()> {
    let mut input = BufReader::with_capacity(1 << 16, input);
    let mut header = [0u8; HEADER];
    loop {
        // End of input between messages is main closing stdin; inside one it is an error.
        match input.read(&mut header[..1]) {
            Ok(0) => return Ok(()),
            Ok(_) => input.read_exact(&mut header[1..])?,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
        let id = u32::from_le_bytes(header[1..5].try_into().unwrap());
        let length = u32::from_le_bytes(header[5..9].try_into().unwrap()) as usize;
        match header[0] {
            REQUEST if length <= MAX_REQUEST => {
                let mut payload = vec![0; length];
                input.read_exact(&mut payload)?;
                let abandoned = Arc::new(AtomicBool::new(false));
                let request = Request {
                    id,
                    payload,
                    abandoned: abandoned.clone(),
                    shared: shared.clone(),
                };
                let ticket = Pending::new(request.call(), abandoned.clone());
                let lane = ticket.lane;
                let mut pending = shared.pending();
                if pending.contains_key(&id) || id == 0 {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        "duplicate or reserved request ID",
                    ));
                }
                let limit = if lane == Lane::Control {
                    MAX_PENDING + 8
                } else {
                    MAX_PENDING
                };
                if pending.len() < limit {
                    pending.insert(id, ticket);
                    drop(pending);
                    if shared.queue(lane).push(Job::Request(request)).is_ok() {
                        continue;
                    }
                } else {
                    drop(pending);
                }
                let reply = Reply::json(503, &json!({"error": "Imaging engine is busy"}));
                let _ = events.send(Event::Reply {
                    id,
                    reply,
                    abandoned,
                });
            }
            REQUEST => {
                io::copy(&mut (&mut input).take(length as u64), &mut io::sink())?;
                let reply = Reply::json(413, &json!({"error": "Engine request too large"}));
                let _ = events.send(Event::Reply {
                    id,
                    reply,
                    abandoned: Arc::new(AtomicBool::new(false)),
                });
            }
            CREDIT if length == 4 => {
                let mut bytes = [0u8; 4];
                input.read_exact(&mut bytes)?;
                let _ = events.send(Event::Credit {
                    id,
                    bytes: u32::from_le_bytes(bytes) as usize,
                });
            }
            kind => {
                // CANCEL carries nothing; anything else main might send later is skipped.
                io::copy(&mut (&mut input).take(length as u64), &mut io::sink())?;
                if kind == CANCEL {
                    let abandoned = shared.pending().get(&id).cloned();
                    if let Some(ticket) = abandoned {
                        ticket.abandoned.store(true, Ordering::Release);
                        if let Some((_, flag)) = &ticket.export {
                            flag.store(true, Ordering::Release);
                        }
                        if shared.queue(ticket.lane).cancel(id) {
                            shared.pending().remove(&id);
                        }
                        cancelled();
                        let _ = events.send(Event::Wake);
                    }
                }
            }
        }
    }
}

fn send_reply(
    shared: &Shared,
    events: &mpsc::Sender<Event>,
    id: u32,
    reply: Reply,
    abandoned: Arc<AtomicBool>,
) {
    if abandoned.load(Ordering::Acquire) {
        shared.pending().remove(&id);
        return;
    }
    if let Some(ticket) = shared.pending().get_mut(&id) {
        ticket.export = None;
    }
    let _ = events.send(Event::Reply {
        id,
        reply,
        abandoned,
    });
}

/// A reply being sent.
struct Outgoing {
    id: u32,
    head: Option<Vec<u8>>,
    body: Box<dyn AsRef<[u8]> + Send>,
    sent: usize,
    /// Body bytes main has granted, or the complete length of an inline reply.
    allowed: usize,
    abandoned: Arc<AtomicBool>,
}
impl Outgoing {
    fn length(&self) -> usize {
        self.body.as_ref().as_ref().len()
    }
    fn done(&self) -> bool {
        self.head.is_none() && self.sent == self.length()
    }
    fn writable(&self) -> bool {
        !self.abandoned.load(Ordering::Acquire)
            && (self.head.is_some() || (self.sent < self.length() && self.sent < self.allowed))
    }
}

fn write_message(out: &mut impl Write, kind: u8, id: u32, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "message too long"))?;
    let mut header = [0u8; HEADER];
    header[0] = kind;
    header[1..5].copy_from_slice(&id.to_le_bytes());
    header[5..9].copy_from_slice(&length.to_le_bytes());
    out.write_all(&header)?;
    out.write_all(payload)
}

fn write_loop(
    output: impl Write,
    hello: &[u8],
    events: &mpsc::Receiver<Event>,
    shared: &Shared,
) -> io::Result<()> {
    let mut out = BufWriter::with_capacity(1 << 16, output);
    write_message(&mut out, HELLO, 0, hello)?;
    let mut streams: Vec<Outgoing> = Vec::new();
    let mut finishing = false;
    let apply =
        |event: Event, streams: &mut Vec<Outgoing>, finishing: &mut bool| -> io::Result<()> {
            match event {
                Event::Reply {
                    id,
                    reply,
                    abandoned,
                } => {
                    let length = reply.body.as_ref().as_ref().len();
                    let headers: serde_json::Map<String, Value> = reply
                        .headers
                        .into_iter()
                        .map(|(name, value)| (name.to_string(), Value::String(value)))
                        .collect();
                    let inline = length <= INLINE
                        && headers.get("content-type").and_then(Value::as_str)
                            == Some("application/json");
                    let head = serde_json::to_vec(
                        &json!({"status": reply.status, "headers": headers, "length": length}),
                    )?;
                    streams.push(Outgoing {
                        id,
                        head: Some(head),
                        body: reply.body,
                        sent: 0,
                        allowed: if inline { length } else { 0 },
                        abandoned,
                    });
                }
                Event::Credit { id, bytes } => {
                    if let Some(stream) = streams.iter_mut().find(|stream| stream.id == id) {
                        stream.allowed = stream.allowed.saturating_add(bytes);
                    }
                }
                Event::Wake => {}
                Event::Finish => *finishing = true,
            }
            Ok(())
        };
    loop {
        // The writer waits for an event only when it has nothing it may send; then it applies every event waiting.
        if !finishing && !streams.iter().any(Outgoing::writable) {
            out.flush()?;
            match events.recv() {
                Ok(event) => apply(event, &mut streams, &mut finishing)?,
                Err(_) => finishing = true,
            }
        }
        loop {
            match events.try_recv() {
                Ok(event) => apply(event, &mut streams, &mut finishing)?,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    finishing = true;
                    break;
                }
            }
        }
        // One round: each stream sends its head, then one piece of its body.
        for stream in streams.iter_mut().filter(|stream| stream.writable()) {
            if let Some(head) = stream.head.take() {
                write_message(&mut out, HEAD, stream.id, &head)?;
            }
            let end = stream.length().min(stream.allowed).min(stream.sent + CHUNK);
            if end > stream.sent {
                write_message(
                    &mut out,
                    DATA,
                    stream.id,
                    &stream.body.as_ref().as_ref()[stream.sent..end],
                )?;
                stream.sent = end;
            }
        }
        // Sent, cancelled, or (when finishing) waiting for main to read: the stream goes.
        let mut kept = Vec::with_capacity(streams.len());
        for stream in streams.drain(..) {
            let cancelled = stream.abandoned.load(Ordering::Acquire);
            if !stream.done() && !cancelled && (!finishing || stream.writable()) {
                kept.push(stream);
                continue;
            }
            if !stream.done() && stream.head.is_none() {
                write_message(&mut out, END, stream.id, &[])?;
            }
            shared.pending().remove(&stream.id);
        }
        streams = kept;
        if finishing && streams.is_empty() {
            return out.flush();
        }
    }
}

/// The engine's ends of the pipes main gave it: stdin to read requests, and a private copy of stdout to answer on.
/// On Unix, fd 1 itself then points at stderr, so a stray print (a library's, say) lands in the log, not in a reply.
#[cfg(unix)]
pub fn stdio() -> io::Result<(std::fs::File, std::fs::File)> {
    use std::os::fd::{AsFd, AsRawFd};
    let input = io::stdin().as_fd().try_clone_to_owned()?;
    let output = io::stdout().as_fd().try_clone_to_owned()?;
    // SAFETY: output owns a separate descriptor. Only the standard output descriptor is redirected.
    unsafe {
        if libc::dup2(2, 1) < 0 {
            return Err(io::Error::last_os_error());
        }
        let size: libc::c_int = 4 << 20;
        libc::setsockopt(
            output.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            (&size as *const libc::c_int).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
    Ok((input.into(), output.into()))
}

#[cfg(windows)]
pub fn stdio() -> io::Result<(std::fs::File, std::fs::File)> {
    use std::os::windows::io::{AsHandle, AsRawHandle};
    use windows_sys::Win32::System::Console::{STD_OUTPUT_HANDLE, SetStdHandle};
    unsafe extern "C" {
        fn _dup2(old: i32, new: i32) -> i32;
    }
    let input = io::stdin().as_handle().try_clone_to_owned()?;
    let output = io::stdout().as_handle().try_clone_to_owned()?;
    // C codecs use CRT descriptor 1. Rust and Win32 callers use the process standard handle.
    unsafe {
        if _dup2(2, 1) != 0 {
            return Err(io::Error::other("cannot redirect CRT stdout"));
        }
        if SetStdHandle(STD_OUTPUT_HANDLE, io::stderr().as_raw_handle()) == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok((input.into(), output.into()))
}

/// For tests: reads the engine's messages from `input`, one per call.
#[cfg(test)]
pub fn read_message(input: &mut impl Read) -> io::Result<(u8, u32, Vec<u8>)> {
    let mut header = [0u8; HEADER];
    input.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header[5..9].try_into().unwrap()) as usize;
    let mut payload = vec![0; length];
    input.read_exact(&mut payload)?;
    Ok((
        header[0],
        u32::from_le_bytes(header[1..5].try_into().unwrap()),
        payload,
    ))
}

/// Waits up to `timeout` for `ready`; for tests.
#[cfg(test)]
pub fn eventually(timeout: Duration, ready: impl Fn() -> bool) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while !ready() {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(5));
    }
    true
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{PipeReader, PipeWriter};

    struct Engine {
        server: Option<Server>,
        requests: PipeWriter,
        replies: PipeReader,
    }
    impl Engine {
        fn start(handle: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Self {
            let (input, requests) = io::pipe().unwrap();
            let (replies, output) = io::pipe().unwrap();
            let server = Server::start(input, output, handle, || {}).unwrap();
            let mut engine = Self {
                server: Some(server),
                requests,
                replies,
            };
            let (kind, id, hello) = engine.next();
            assert_eq!((kind, id), (HELLO, 0));
            assert_eq!(
                serde_json::from_slice::<Value>(&hello).unwrap()["protocol"],
                json!(PROTOCOL)
            );
            engine
        }
        fn send(&mut self, kind: u8, id: u32, payload: &[u8]) {
            write_message(&mut self.requests, kind, id, payload).unwrap();
        }
        fn request(&mut self, id: u32, op: &str) {
            self.send(REQUEST, id, &call(&json!({"op": op}), b""));
        }
        fn next(&mut self) -> (u8, u32, Vec<u8>) {
            read_message(&mut self.replies).unwrap()
        }
        fn head(&mut self) -> (u32, Value) {
            let (kind, id, payload) = self.next();
            assert_eq!(kind, HEAD);
            (id, serde_json::from_slice(&payload).unwrap())
        }
    }

    /// A REQUEST payload: the call's JSON after its length, then `data`.
    pub(crate) fn call(value: &Value, data: &[u8]) -> Vec<u8> {
        let json = serde_json::to_vec(value).unwrap();
        let mut payload = (json.len() as u32).to_le_bytes().to_vec();
        payload.extend(json);
        payload.extend(data);
        payload
    }

    #[test]
    fn a_request_carries_its_call_and_raw_bytes_apart() {
        let (input, mut requests) = io::pipe().unwrap();
        let (mut replies, output) = io::pipe().unwrap();
        let _server = Server::start(input, output, |request: &Request| {
            Reply::json(200, &json!({"call": serde_json::from_slice::<Value>(request.call()).ok(), "data": request.data()}))
        }, || {}).unwrap();
        read_message(&mut replies).unwrap();
        write_message(
            &mut requests,
            REQUEST,
            1,
            &call(&json!({"op": "picture"}), &[1, 2, 3]),
        )
        .unwrap();
        write_message(&mut requests, REQUEST, 2, &[200, 0, 0, 0, b'{']).unwrap();
        let mut expected = HashMap::from([
            (1, json!({"call": {"op": "picture"}, "data": [1, 2, 3]})),
            (2, json!({"call": null, "data": []})),
        ]);
        while !expected.is_empty() {
            let (kind, id, _) = read_message(&mut replies).unwrap();
            assert_eq!(kind, HEAD);
            let (kind, from, body) = read_message(&mut replies).unwrap();
            assert_eq!((kind, from), (DATA, id));
            assert_eq!(
                Some(serde_json::from_slice::<Value>(&body).unwrap()),
                expected.remove(&id)
            );
        }
    }

    /// Answers `{"op":"big"}` with `size` bytes counting up, and anything else with `{"op": op}` at once.
    fn echo(size: usize) -> impl Fn(&Request) -> Reply + Send + Sync + 'static {
        move |request: &Request| {
            let value: Value = serde_json::from_slice(request.call()).unwrap();
            if value["op"] == "big" {
                let body: Vec<u8> = (0..size).map(|n| n as u8).collect();
                Reply {
                    status: 200,
                    headers: vec![("x-pixel-type", "uint8".into())],
                    body: Box::new(body),
                }
            } else {
                Reply::json(200, &json!({"op": value["op"]}))
            }
        }
    }

    #[test]
    fn a_large_body_goes_out_in_pieces_within_its_window_and_a_small_reply_passes_it() {
        let size = 5 * CHUNK + 5;
        let mut engine = Engine::start(echo(size));
        engine.request(7, "big");
        let (id, head) = engine.head();
        assert_eq!(
            (id, head["status"].clone(), head["length"].clone()),
            (7, json!(200), json!(size))
        );
        assert_eq!(head["headers"]["x-pixel-type"], json!("uint8"));
        // Ask for two pieces, then leave the reader idle.
        engine.send(CREDIT, 7, &(2 * CHUNK as u32).to_le_bytes());
        let mut received = Vec::new();
        while received.len() < 2 * CHUNK {
            let (kind, id, piece) = engine.next();
            assert_eq!((kind, id), (DATA, 7));
            assert!(piece.len() <= CHUNK);
            received.extend(piece);
        }
        assert_eq!(received.len(), 2 * CHUNK);
        // A reply to a later request is not held up by the body waiting for credit.
        engine.request(8, "progress");
        let (id, head) = engine.head();
        assert_eq!((id, head["length"].as_u64().unwrap() > 0), (8, true));
        let (kind, id, body) = engine.next();
        assert_eq!(
            (kind, id, serde_json::from_slice::<Value>(&body).unwrap()),
            (DATA, 8, json!({"op": "progress"}))
        );
        engine.send(CREDIT, 7, &(4 * CHUNK as u32).to_le_bytes());
        while received.len() < size {
            let (kind, id, piece) = engine.next();
            assert_eq!((kind, id), (DATA, 7));
            received.extend(piece);
        }
        assert_eq!(
            received,
            (0..size).map(|n| n as u8).collect::<Vec<_>>(),
            "the body arrives whole and in order"
        );
    }

    #[test]
    fn full_catalog_queue_is_bounded_and_control_and_frame_work_still_run() {
        let (started, busy) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let wait = Mutex::new(wait);
        let mut engine = Engine::start(move |r| {
            let op = serde_json::from_slice::<Value>(r.call()).unwrap()["op"].clone();
            if op == "import" {
                started.send(()).unwrap();
                let _ = wait.lock().unwrap().recv();
            }
            Reply::json(200, &op)
        });
        engine.request(1, "import");
        busy.recv_timeout(Duration::from_secs(5)).unwrap();
        for id in 2..2 + MAX_QUEUED as u32 {
            engine.request(id, "removeSeries");
        }
        engine.request(100, "removeSeries");
        engine.request(101, "progress");
        engine.request(102, "frame");
        let mut statuses = HashMap::new();
        for _ in 0..3 {
            let (id, head) = engine.head();
            statuses.insert(id, head["status"].as_u64().unwrap());
            assert_eq!(engine.next().0, DATA);
        }
        assert_eq!(
            statuses,
            HashMap::from([(100, 503), (101, 200), (102, 200)])
        );
        engine.send(CANCEL, 2, &[]);
        engine.request(103, "removeSeries");
        engine.request(104, "progress");
        assert_eq!(
            engine.head().0,
            104,
            "cancellation freed the queue slot for 103"
        );
        engine.next();
        release.send(()).unwrap();
    }

    #[test]
    fn a_cancel_names_an_export_while_it_is_queued_and_while_it_runs() {
        let (started, busy) = mpsc::channel();
        let (release, wait) = mpsc::channel::<()>();
        let wait = Mutex::new(wait);
        let mut engine = Engine::start(move |r| {
            let call: Value = serde_json::from_slice(r.call()).unwrap();
            let value = match call["op"].as_str() {
                Some("hold") => {
                    started.send(()).unwrap();
                    wait.lock().unwrap().recv().unwrap();
                    false
                }
                Some("export") => {
                    let flag = r.export_flag("export-1").unwrap();
                    let cancelled_on_entry = flag.load(Ordering::Acquire);
                    started.send(()).unwrap();
                    wait.lock().unwrap().recv().unwrap();
                    cancelled_on_entry
                }
                Some("exportCancel") => {
                    r.cancel_export(call["body"]["operation"].as_str().unwrap())
                }
                _ => unreachable!(),
            };
            Reply::json(200, &value)
        });
        for id in [1, 2] {
            engine.request(id, "hold");
            busy.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        engine.send(
            REQUEST,
            3,
            &call(
                &json!({"op":"export", "body":{"operation":"export-1"}}),
                b"",
            ),
        );
        let cancel = |engine: &mut Engine, id, op| {
            engine.send(
                REQUEST,
                id,
                &call(&json!({"op":"exportCancel", "body":{"operation":op}}), b""),
            );
            assert_eq!(engine.head().0, id);
            serde_json::from_slice::<bool>(&engine.next().2).unwrap()
        };
        assert!(!cancel(&mut engine, 4, "another"));
        assert!(cancel(&mut engine, 5, "export-1"));
        release.send(()).unwrap();
        busy.recv_timeout(Duration::from_secs(5)).unwrap();
        engine.head();
        engine.next(); // The blocker that released a worker.
        assert!(cancel(&mut engine, 6, "export-1"));
        release.send(()).unwrap();
        release.send(()).unwrap();
        // The export and remaining blocker may finish in either order.
        for _ in 0..2 {
            let (id, _) = engine.head();
            let value = serde_json::from_slice::<bool>(&engine.next().2).unwrap();
            assert_eq!(value, id == 3, "export saw cancellation before starting");
        }
        assert!(!cancel(&mut engine, 7, "export-1"));
    }

    #[test]
    fn a_cancelled_body_ends_short_and_a_cancelled_wait_sends_nothing() {
        let (release, wait) = mpsc::channel::<()>();
        let (started, running) = mpsc::channel();
        let wait = Mutex::new(wait);
        let size = 3 * CHUNK;
        let big = echo(size);
        let mut engine = Engine::start(move |request: &Request| {
            let value: Value = serde_json::from_slice(request.call()).unwrap();
            if value["op"] == "slow" {
                started.send(()).unwrap();
                wait.lock().unwrap().recv().unwrap();
                assert!(
                    request.abandoned().load(Ordering::Acquire),
                    "the request saw its cancel"
                );
            }
            big(request)
        });
        engine.request(1, "big");
        engine.head();
        engine.send(CREDIT, 1, &(CHUNK as u32).to_le_bytes());
        let mut received = 0;
        while received < CHUNK {
            received += engine.next().2.len();
        }
        engine.send(CANCEL, 1, &[]);
        assert_eq!(
            engine.next(),
            (END, 1, Vec::new()),
            "the body that waited for credit ends there"
        );
        // Cancelled while it works: its reply is never sent.
        engine.request(2, "slow");
        running.recv_timeout(Duration::from_secs(5)).unwrap();
        engine.send(CANCEL, 2, &[]);
        assert!(eventually(Duration::from_secs(5), || engine
            .server
            .as_ref()
            .unwrap()
            .shared
            .pending()
            .get(&2)
            .is_some_and(|p| p.abandoned.load(Ordering::Acquire))));
        release.send(()).unwrap();
        engine.request(3, "after");
        let (id, _) = engine.head();
        assert_eq!(id, 3, "nothing came for the cancelled request");
    }

    #[test]
    fn a_panicking_request_answers_500_and_shutdown_waits_for_requests() {
        let mut engine = Engine::start(|request: &Request| {
            let value: Value = serde_json::from_slice(request.call()).unwrap();
            match value["op"].as_str() {
                Some("panic") => panic!("synthetic"),
                Some("shutdown") => {
                    request.stop_server();
                    Reply::json(200, &json!({"ok": true}))
                }
                _ => Reply::json(200, &json!({})),
            }
        });
        engine.request(1, "panic");
        let (_, head) = engine.head();
        assert_eq!(head["status"], json!(500));
        engine.next();
        engine.request(2, "shutdown");
        let mut server = engine.server.take().unwrap();
        server.wait_for_stop();
        server.drain();
        server.finish(Duration::from_secs(5));
        let (id, head) = engine.head();
        assert_eq!((id, head["status"].clone()), (2, json!(200)));
        assert_eq!(
            serde_json::from_slice::<Value>(&engine.next().2).unwrap(),
            json!({"ok": true})
        );
    }

    #[test]
    fn closing_stdin_stops_the_server() {
        let engine = Engine::start(echo(0));
        let Engine {
            server, requests, ..
        } = engine;
        drop(requests);
        server.unwrap().wait_for_stop();
    }

    #[test]
    fn an_oversized_request_is_refused_without_losing_the_stream() {
        let mut engine = Engine::start(echo(0));
        let header = [REQUEST, 9, 0, 0, 0];
        engine.requests.write_all(&header).unwrap();
        engine
            .requests
            .write_all(&((MAX_REQUEST + 1) as u32).to_le_bytes())
            .unwrap();
        engine
            .requests
            .write_all(&vec![b' '; MAX_REQUEST + 1])
            .unwrap();
        let (id, head) = engine.head();
        assert_eq!((id, head["status"].clone()), (9, json!(413)));
        engine.next();
        engine.request(10, "progress");
        assert_eq!(engine.head().0, 10);
    }
}
