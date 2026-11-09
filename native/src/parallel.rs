//! Work spread over threads with the standard library alone: the three places the engine works in parallel (reading an
//! import's files, decoding a volume's frames, re-encoding an export's files) once took five crates from rayon for this.
//! Threads take the next item as each finishes one, so a slow file or frame does not hold the others up.
//!
//! In a browser the engine cannot start threads; the page lends it some (`Helpers`, `lend`), and without them every
//! item runs on the calling thread.

use std::{
    cell::Cell,
    sync::{
        Arc, Mutex, OnceLock, PoisonError,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

/// Threads lent by the host where the engine cannot start its own: in a browser, Web Workers that share the engine's
/// memory and wait for work (web/engine). `run` then hands its items to them instead of starting threads.
pub trait Helpers: Sync {
    /// How many threads are lent.
    fn count(&self) -> usize;
    /// Runs `work` on the calling thread and on up to `count` lent threads at once, and returns once each has
    /// returned from it.
    fn run(&self, count: usize, work: &(dyn Fn() + Sync));
}

static HELPERS: OnceLock<&'static dyn Helpers> = OnceLock::new();

/// Lends `helpers` to every parallel run from now on (once; later calls are ignored).
pub fn lend(helpers: &'static dyn Helpers) {
    let _ = HELPERS.set(helpers);
}

thread_local! {
    static ALONE: Cell<bool> = const { Cell::new(false) };
}

/// Runs `work` with every parallel run it starts kept on this thread: in a browser only the thread that received the
/// page's files can read them.
pub fn on_this_thread<R>(work: impl FnOnce() -> R) -> R {
    let before = ALONE.replace(true);
    let result = work();
    ALONE.set(before);
    result
}

/// How many threads this computer runs at once, or `fallback` if it cannot tell. Where threads are lent, those and
/// the calling thread.
pub fn available(fallback: usize) -> usize {
    if let Some(helpers) = HELPERS.get() {
        return helpers.count() + 1;
    }
    std::thread::available_parallelism().map_or(fallback, usize::from)
}

/// Stops the other threads taking items once this one unwinds from a panic.
struct StopOnPanic<'a>(&'a AtomicBool);
impl Drop for StopOnPanic<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0.store(true, Ordering::Release);
        }
    }
}

/// Runs `work` on every item of `items` on `threads` threads in all: the calling thread and up to `threads - 1` more,
/// named `{name}-1`, `{name}-2`… for the length of the call. Items are handed out in order, one at a time, as threads
/// come free; a thread the system will not start leaves its share to the others. After a panic in `work` no further
/// items are handed out, and the panic reaches the caller once every thread has stopped.
pub fn for_each<I>(name: &str, threads: usize, items: I, work: impl Fn(I::Item) + Sync)
where
    I: Iterator + Send,
    I::Item: Send,
{
    let stop = AtomicBool::new(false);
    run(name, threads, items, &stop, &work);
}

/// `for_each` for work that can fail: once an item fails no further items are handed out, and the first failure is
/// returned when the items under way have finished.
pub fn try_for_each<I, E>(
    name: &str,
    threads: usize,
    items: I,
    work: impl Fn(I::Item) -> Result<(), E> + Sync,
) -> Result<(), E>
where
    I: Iterator + Send,
    I::Item: Send,
    E: Send,
{
    let stop = AtomicBool::new(false);
    let failure = Mutex::new(None);
    run(name, threads, items, &stop, &|item| {
        if let Err(error) = work(item) {
            failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get_or_insert(error);
            stop.store(true, Ordering::Release);
        }
    });
    failure
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner)
        .map_or(Ok(()), Err)
}

type Job = Box<dyn FnOnce() + Send>;

/// Long-lived workers for independent requests that share one concurrency limit.
pub struct Pool {
    jobs: mpsc::Sender<Job>,
    threads: usize,
    inline: Mutex<()>,
}

impl Pool {
    #[allow(
        clippy::disallowed_methods,
        reason = "the fixed ZIP encoder pool shares its limit across exports"
    )]
    pub fn new(name: &str, limit: usize) -> Self {
        let (jobs, receive) = mpsc::channel::<Job>();
        let receive = Arc::new(Mutex::new(receive));
        let mut threads = 0;
        for index in 1..=limit {
            let receive = Arc::clone(&receive);
            let worker = std::thread::Builder::new()
                .name(format!("{name}-{index}"))
                .spawn(move || {
                    loop {
                        let job = receive
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .recv();
                        let Ok(job) = job else { break };
                        job();
                    }
                });
            if worker.is_err() {
                break;
            }
            threads += 1;
        }
        Self {
            jobs,
            threads: threads.max(1),
            inline: Mutex::new(()),
        }
    }

    pub fn threads(&self) -> usize {
        self.threads
    }

    /// A panic disconnects this job's reply. The worker stays available to other requests.
    pub fn submit<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> mpsc::Receiver<T> {
        let (send, receive) = mpsc::channel();
        let job: Job = Box::new(move || {
            if let Ok(value) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)) {
                let _ = send.send(value);
            }
        });
        if let Err(job) = self.jobs.send(job) {
            // If the OS could not start any workers, callers share one inline slot.
            let _slot = self.inline.lock().unwrap_or_else(PoisonError::into_inner);
            (job.0)();
        }
        receive
    }
}

fn run<I>(name: &str, threads: usize, items: I, stop: &AtomicBool, work: &(impl Fn(I::Item) + Sync))
where
    I: Iterator + Send,
    I::Item: Send,
{
    let items = Mutex::new(items);
    let take = || {
        let _stop = StopOnPanic(stop);
        while !stop.load(Ordering::Acquire) {
            let item = {
                let mut items = items.lock().unwrap_or_else(PoisonError::into_inner);
                if stop.load(Ordering::Acquire) {
                    break;
                }
                items.next()
            };
            let Some(item) = item else { break };
            // A channel can deliver this item after another worker has failed.
            if stop.load(Ordering::Acquire) {
                break;
            }
            work(item);
        }
    };
    // Kept on this thread (`on_this_thread`), or spread over the threads a host lends instead of new ones.
    let threads = if ALONE.get() { 1 } else { threads };
    if let Some(helpers) = HELPERS.get().filter(|_| threads > 1) {
        helpers.run(threads - 1, &take);
        return;
    }
    std::thread::scope(|scope| {
        let helpers: Vec<_> = (1..threads)
            .map_while(|index| {
                std::thread::Builder::new()
                    .name(format!("{name}-{index}"))
                    .spawn_scoped(scope, take)
                    .ok()
            })
            .collect();
        take();
        for helper in helpers {
            if let Err(panic) = helper.join() {
                std::panic::resume_unwind(panic);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashSet, sync::atomic::AtomicUsize, time::Duration};

    #[test]
    fn every_item_is_worked_on_once_across_the_threads() {
        let seen = Mutex::new(Vec::new());
        let threads = Mutex::new(HashSet::new());
        for_each("test-each", 4, 0..1000, |item| {
            // Slow enough that one thread cannot take every item before the others start.
            std::thread::sleep(Duration::from_micros(50));
            seen.lock().unwrap().push(item);
            threads.lock().unwrap().insert(std::thread::current().id());
        });
        let mut seen = seen.into_inner().unwrap();
        seen.sort();
        assert_eq!(seen, (0..1000).collect::<Vec<_>>());
        let threads = threads.into_inner().unwrap();
        assert!(
            threads.len() > 1 && threads.len() <= 4,
            "{} threads",
            threads.len()
        );
    }

    #[test]
    fn work_kept_on_this_thread_stays_there_for_that_call_only() {
        let caller = std::thread::current().id();
        on_this_thread(|| {
            for_each("test-alone", 8, 0..200, |_| {
                assert_eq!(std::thread::current().id(), caller)
            })
        });
        let threads = Mutex::new(HashSet::new());
        for_each("test-after", 4, 0..1000, |_| {
            std::thread::sleep(Duration::from_micros(50));
            threads.lock().unwrap().insert(std::thread::current().id());
        });
        assert!(threads.into_inner().unwrap().len() > 1);
    }

    #[test]
    fn one_thread_works_on_the_calling_thread_alone() {
        let caller = std::thread::current().id();
        for_each("test-one", 1, 0..10, |_| {
            assert_eq!(std::thread::current().id(), caller)
        });
        for_each("test-none", 0, 0..10, |_| {
            assert_eq!(std::thread::current().id(), caller)
        });
    }

    #[test]
    fn mutable_chunks_are_filled_in_place() {
        let mut volume = vec![0u32; 64 * 100];
        for_each(
            "test-chunks",
            8,
            volume.chunks_mut(64).enumerate(),
            |(index, frame)| frame.fill(index as u32),
        );
        assert!(
            volume
                .chunks(64)
                .enumerate()
                .all(|(index, frame)| frame.iter().all(|&v| v == index as u32))
        );
    }

    #[test]
    fn callers_share_the_same_workers_across_batches() {
        let pool = Pool::new("test-pool", 2);
        assert_eq!(pool.threads(), 2);
        let together = Arc::new(std::sync::Barrier::new(2));
        let request = || {
            (0..3)
                .map(|_| {
                    let together = Arc::clone(&together);
                    pool.submit(move || {
                        together.wait();
                        std::thread::current().id()
                    })
                    .recv()
                    .unwrap()
                })
                .collect::<Vec<_>>()
        };
        std::thread::scope(|scope| {
            let other = scope.spawn(request);
            let ids: HashSet<_> = request().into_iter().chain(other.join().unwrap()).collect();
            assert_eq!(ids.len(), 2);
        });
    }

    #[test]
    fn a_panicking_job_does_not_block_later_jobs() {
        for limit in [0, 1] {
            let pool = Pool::new("test-panic", limit);
            assert!(pool.submit(|| panic!("failed job")).recv().is_err());
            assert_eq!(pool.submit(|| 42).recv().unwrap(), 42);
        }
    }

    #[test]
    fn a_failure_stops_the_handing_out_and_is_returned() {
        let worked = AtomicUsize::new(0);
        let result = try_for_each("test-fail", 4, 0..10_000, |item| {
            worked.fetch_add(1, Ordering::Relaxed);
            if item >= 20 {
                Err("failed item")
            } else {
                Ok(())
            }
        });
        assert_eq!(result, Err("failed item"));
        // Each of the four workers can have one failing item in flight.
        assert!(worked.load(Ordering::Relaxed) <= 24);
        assert_eq!(
            try_for_each("test-ok", 4, 0..100, |_| Ok::<(), ()>(())),
            Ok(())
        );
    }

    #[test]
    fn a_panic_reaches_the_caller_after_the_threads_stop() {
        let stop = AtomicBool::new(false);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run("test-panic", 4, 0..100, &stop, &|item| {
                if item == 30 {
                    panic!("frame 30 failed");
                }
            })
        }));
        let panic = outcome.unwrap_err();
        assert_eq!(panic.downcast_ref::<&str>(), Some(&"frame 30 failed"));
        assert!(stop.load(Ordering::Acquire));
    }

    #[test]
    fn items_from_a_channel_are_taken_as_they_arrive() {
        let (send, receive) = std::sync::mpsc::channel();
        let total = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                for item in 1..=200usize {
                    send.send(item).unwrap();
                    if item % 50 == 0 {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
            });
            for_each("test-channel", 4, receive.into_iter(), |item| {
                total.fetch_add(item, Ordering::Relaxed);
            });
        });
        assert_eq!(total.load(Ordering::Relaxed), 200 * 201 / 2);
    }

    #[test]
    fn an_item_received_after_stop_is_not_started() {
        let stop = AtomicBool::new(false);
        let (reading, waiting) = std::sync::mpsc::sync_channel(0);
        let (send, receive) = std::sync::mpsc::sync_channel(0);
        std::thread::scope(|scope| {
            let stop = &stop;
            scope.spawn(move || {
                waiting.recv().unwrap();
                stop.store(true, Ordering::Release);
                send.send(42).unwrap();
            });
            let items = std::iter::once_with(move || {
                reading.send(()).unwrap();
                receive.recv().unwrap()
            });
            run("test-stop", 2, items, stop, &|_| {
                panic!("started work after stop")
            });
        });
    }
}
