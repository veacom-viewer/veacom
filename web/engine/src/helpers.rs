//! Threads lent to the engine's parallel work (`veacom_core::parallel`) in the threads build. The engine cannot start
//! threads in a browser: the page starts Web Workers that share this module's memory, and each calls `helper_main`,
//! where it waits for work. A parallel run (decoding a series' frames, say) then hands its items to them and to the
//! engine's own thread at once.
//!
//! Only files held in memory can be read on these threads (`blob::hold`): a page's File belongs to the Worker that
//! received it. Everything else runs with `veacom_core::parallel::on_this_thread`.

use std::{
    cell::Cell,
    sync::{
        Condvar, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
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
}

static STATE: Mutex<State> = Mutex::new(State {
    generation: 0,
    work: None,
    open: false,
    limit: 0,
    joined: 0,
    running: 0,
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

/// A lent thread's life: called by each helper Worker once the module is set up on it, and never returns.
#[wasm_bindgen(js_name = helperMain)]
pub fn helper_main() {
    HELPER.set(true);
    let mut seen = state().generation;
    COUNT.fetch_add(1, Ordering::AcqRel);
    loop {
        let work = {
            let mut state = state();
            while state.generation == seen {
                state = NEXT.wait(state).unwrap_or_else(PoisonError::into_inner);
            }
            seen = state.generation;
            if !state.open || state.joined >= state.limit {
                continue;
            }
            state.joined += 1;
            state.running += 1;
            state.work.expect("an open run has its work")
        };
        // Safety: the run stays open, and its work alive, until `running` is back to zero (see `Lent::run`).
        unsafe { (*work.0)() };
        let mut state = state();
        state.running -= 1;
        if state.running == 0 {
            LEFT.notify_all();
        }
    }
}
