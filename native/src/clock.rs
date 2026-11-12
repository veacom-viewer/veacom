//! The clock the engine's own timeouts read. In WebAssembly std's `Instant` has no clock and panics, so the browser
//! engine supplies monotonic milliseconds on a common time origin: a wait may start on one Worker and end on another.

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::Instant;

#[cfg(target_arch = "wasm32")]
pub use host::{Instant, set_source};

#[cfg(target_arch = "wasm32")]
mod host {
    use std::{ops::Add, sync::OnceLock, time::Duration};

    static SOURCE: OnceLock<fn() -> f64> = OnceLock::new();

    /// Sets the clock, once: milliseconds from an origin every thread shares. Until then no time passes.
    pub fn set_source(now: fn() -> f64) {
        let _ = SOURCE.set(now);
    }

    /// A point in time, in the host's milliseconds.
    #[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
    pub struct Instant(f64);

    impl Instant {
        pub fn now() -> Self {
            Self(SOURCE.get().map_or(0.0, |now| now()))
        }

        pub fn elapsed(&self) -> Duration {
            Self::now().saturating_duration_since(*self)
        }

        pub fn saturating_duration_since(&self, earlier: Self) -> Duration {
            Duration::from_secs_f64((self.0 - earlier.0).max(0.0) / 1000.0)
        }
    }

    impl Add<Duration> for Instant {
        type Output = Self;
        fn add(self, duration: Duration) -> Self {
            Self(self.0 + duration.as_secs_f64() * 1000.0)
        }
    }
}
