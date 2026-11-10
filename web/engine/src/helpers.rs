//! Threads lent to the engine's parallel work (`veacom_core::parallel`) in the threads build. The engine cannot start
//! threads in a browser: the page starts Web Workers that share this module's memory, and each calls `helper_serve`
//! again and again, where it waits for work. A parallel run (decoding a series' frames) then hands its items to them
//! and to the engine's own thread at once.
//!
//! A page's File can be read only on a Worker that was given it. Each helper is given the page's files too
//! (`blob::add_here`), between its waits: `helper_serve` returns to the Worker's own events when it has waited long
//! enough, after a run, and when the engine Worker wakes the helpers to hand them files (`wake`). A series is decoded
//! from the page's files on every thread once every helper has them (`blob::on_helpers`); otherwise only files held in
//! memory (`blob::hold`) are read there, or the work runs with `veacom_core::parallel::on_this_thread`.

use std::{
    cell::Cell,
    sync::{
        Condvar, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use veacom_core::parallel::Helpers;
use wasm_bindgen::prelude::*;

/// The work of the run under way, its lifetime erased: `Lent::run` returns only once no helper is in it.
#[derive(Clone, Copy)]
struct WorkRef(*const (dyn Fn() + Sync + 'static));
// Safety: the work is `Sync`, and the pointer is used only while `Lent::run` keeps the work alive.
unsafe impl Send for WorkRef {}

struct State {
    /// Bumped for each run, so a helper takes part in a run once.
    generation: u64,
    work: Option<WorkRef>,
    /// Open while the run's own thread is still taking items: a helper that comes later has nothing to do.
    open: bool,
    /// How many helpers the run wants, and how many have joined it.
    limit: usize,
    joined: usize,
    /// Helpers inside the run's work.
    running: usize,
    /// Bumped to send every waiting helper back to its Worker's events (`wake`).
    wake: u64,
}

static STATE: Mutex<State> = Mutex::new(State {
    generation: 0,
    work: None,
    open: false,
    limit: 0,
    joined: 0,
    running: 0,
    wake: 0,
});
/// Helpers wait here for the next run.
static NEXT: Condvar = Condvar::new();
/// The run's own thread waits here for its helpers to leave it.
static LEFT: Condvar = Condvar::new();
/// One run at a time; a run started meanwhile stays on its own thread.
static TURN: Mutex<()> = Mutex::new(());
static COUNT: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static HELPER: Cell<bool> = const { Cell::new(false) };
    /// The last run generation this helper has seen, kept between its calls to `helper_serve`.
    static SEEN: Cell<Option<u64>> = const { Cell::new(None) };
}

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Lent;
static LENT: Lent = Lent;

impl Helpers for Lent {
    fn count(&self) -> usize {
        COUNT.load(Ordering::Acquire)
    }

    fn run(&self, count: usize, work: &(dyn Fn() + Sync)) {
        // A run inside a helper's work, or while another run is under way, stays on its own thread.
        let turn = if HELPER.get() {
            None
        } else {
            TURN.try_lock().ok()
        };
        if turn.is_none() || count == 0 || self.count() == 0 {
            work();
            return;
        }
        // Safety: the reference outlives every use of the pointer: helpers join only while `open`, and this function
        // returns only after closing the run and waiting until no helper is running it.
        let erased: &'static (dyn Fn() + Sync) =
            unsafe { std::mem::transmute::<&(dyn Fn() + Sync), &'static (dyn Fn() + Sync)>(work) };
        {
            let mut state = state();
            state.generation += 1;
            state.work = Some(WorkRef(erased));
            state.open = true;
            state.limit = count;
            state.joined = 0;
        }
        NEXT.notify_all();
        work();
        let mut state = state();
        state.open = false;
        state.work = None;
        while state.running > 0 {
            state = LEFT.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

/// Lends this module's helpers to the engine; called once at start.
pub fn lend() {
    veacom_core::parallel::lend(&LENT);
}

/// What a helper Worker needs to set this module up on its thread: `[module, memory]`.
#[wasm_bindgen(js_name = helperSetup)]
pub fn helper_setup() -> js_sys::Array {
    js_sys::Array::of2(&wasm_bindgen::module(), &wasm_bindgen::memory())
}

/// Sends every helper waiting in `helper_serve` back to its Worker's events at once, to take the files the engine
/// Worker has just sent it.
pub fn wake() {
    state().wake += 1;
    NEXT.notify_all();
}

/// A lent thread's turn, called again and again by each helper Worker once the module is set up on it: waits up to
/// `wait_ms` for a run and takes part in it, then returns, so the Worker can take the page's files (see the module's
/// notes). It also returns when the helpers are woken (`wake`). A run that began while the Worker was away is joined
/// if it is still open.
#[wasm_bindgen(js_name = helperServe)]
pub fn helper_serve(wait_ms: u32) {
    if !HELPER.get() {
        HELPER.set(true);
        SEEN.set(Some(state().generation));
        COUNT.fetch_add(1, Ordering::AcqRel);
    }
    let mut seen = SEEN.get().unwrap_or_default();
    let work = {
        let mut state = state();
        let woken = state.wake;
        let mut waited = false;
        loop {
            if state.generation != seen {
                seen = state.generation;
                if state.open && state.joined < state.limit {
                    state.joined += 1;
                    state.running += 1;
                    break Some(state.work.expect("an open run has its work"));
                }
            }
            if state.wake != woken || waited {
                break None;
            }
            let (next, timeout) = NEXT
                .wait_timeout(state, Duration::from_millis(wait_ms.into()))
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
            waited = timeout.timed_out();
        }
    };
    SEEN.set(Some(seen));
    let Some(work) = work else { return };
    // Safety: the run stays open, and its work alive, until `running` is back to zero (see `Lent::run`).
    unsafe { (*work.0)() };
    let mut state = state();
    state.running -= 1;
    if state.running == 0 {
        LEFT.notify_all();
    }
}
