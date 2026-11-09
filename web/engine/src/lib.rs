//! The engine (`veacom_core`, native/) in a browser. The engine reads the user's files through its in-memory file
//! system; this crate supplies them from the page's File objects (`blob`), and offers the calls the Worker makes
//! (`api`). In the desktop app the same calls are requests over the engine's pipes.

mod session;
mod view;

#[cfg(target_arch = "wasm32")]
mod allocator;
#[cfg(target_arch = "wasm32")]
mod api;
#[cfg(not(target_arch = "wasm32"))]
pub mod bench;
#[cfg(target_arch = "wasm32")]
mod blob;
#[cfg(target_arch = "wasm32")]
mod libc_shim;

/// The threads build's lent threads: Web Workers that call `helperMain` and work on the engine's parallel runs.
#[cfg(all(target_arch = "wasm32", feature = "threads"))]
mod helpers;
