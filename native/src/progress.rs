use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};

struct Progress {
    /// Names the job that last began, so a cancel can say which job it is for.
    id: AtomicU64,
    running: AtomicBool,
    cancelled: AtomicBool,
    stopping: AtomicBool,
    completed: AtomicUsize,
    total: AtomicUsize,
    stage: Mutex<String>,
}

impl Progress {
    const fn new() -> Self {
        Self {
            id: AtomicU64::new(0),
            running: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            completed: AtomicUsize::new(0),
            total: AtomicUsize::new(0),
            stage: Mutex::new(String::new()),
        }
    }
    fn begin(&self, stage: &str, total: usize) {
        // Under the stage lock, as `cancel_operation` reads them: a cancel for the job before cannot reach this one.
        let mut current_stage = self.stage.lock().unwrap_or_else(|e| e.into_inner());
        *current_stage = stage.to_owned();
        self.id.fetch_add(1, Ordering::AcqRel);
        self.completed.store(0, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
        self.cancelled.store(false, Ordering::Release);
        self.running.store(true, Ordering::Release);
    }
    fn set_stage(&self, stage: &str, total: usize) {
        let mut current_stage = self.stage.lock().unwrap_or_else(|e| e.into_inner());
        *current_stage = stage.to_owned();
        self.completed.store(0, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
    }
    fn check(&self) -> Result<()> {
        if self.stopping.load(Ordering::Acquire) {
            bail!(coded!("core.stopping", "Native core is shutting down"));
        }
        if self.running.load(Ordering::Acquire) && self.cancelled.load(Ordering::Acquire) {
            bail!(coded!("job.cancelled", "Operation cancelled"));
        }
        Ok(())
    }
    fn step(&self) -> Result<()> {
        self.check()?;
        if self.running.load(Ordering::Acquire) {
            let total = self.total.load(Ordering::Relaxed);
            let _ = self
                .completed
                .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                    Some(n.saturating_add(1).min(total))
                });
        }
        self.check()
    }
    fn finish(&self) {
        self.running.store(false, Ordering::Release);
    }
    fn cancel(&self) -> bool {
        if !self.running.load(Ordering::Acquire) {
            return false;
        }
        self.cancelled.store(true, Ordering::Release);
        true
    }
    /// Cancels the job `id` names, if it is the one running: the progress bar's Cancel stops what the bar showed, not a
    /// job that began since (a pre-load, a pane's decode, the next import).
    fn cancel_operation(&self, id: u64) -> bool {
        let _stage = self.stage.lock().unwrap_or_else(|e| e.into_inner());
        if !self.running.load(Ordering::Acquire) || self.id.load(Ordering::Acquire) != id {
            return false;
        }
        self.cancelled.store(true, Ordering::Release);
        true
    }
    fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        self.cancelled.store(true, Ordering::Release);
    }
    fn snapshot(&self) -> Value {
        let stage = self.stage.lock().unwrap_or_else(|e| e.into_inner());
        json!({
            "id": self.id.load(Ordering::Acquire),
            "running": self.running.load(Ordering::Acquire),
            "stage": *stage,
            "completed": self.completed.load(Ordering::Relaxed),
            "total": self.total.load(Ordering::Relaxed),
            "cancelled": self.cancelled.load(Ordering::Acquire),
        })
    }
}

static CURRENT: Progress = Progress::new();

pub fn begin(stage: &str, total: usize) {
    CURRENT.begin(stage, total);
}
pub fn set_stage(stage: &str, total: usize) {
    CURRENT.set_stage(stage, total);
}
pub fn step() -> Result<()> {
    CURRENT.step()
}
pub fn check() -> Result<()> {
    CURRENT.check()
}
pub fn finish() {
    CURRENT.finish();
}
pub fn cancel() -> bool {
    CURRENT.cancel()
}
pub fn cancel_operation(id: u64) -> bool {
    CURRENT.cancel_operation(id)
}
pub fn snapshot() -> Value {
    CURRENT.snapshot()
}
pub fn shutdown() {
    CURRENT.shutdown();
}
pub fn is_stopping() -> bool {
    CURRENT.stopping.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shutdown_rejects_pending_work_and_cannot_be_reset_by_a_queued_job() {
        let progress = Progress::new();
        progress.begin("import", 10);
        progress.shutdown();
        assert_eq!(
            progress.check().unwrap_err().to_string(),
            "Native core is shutting down"
        );
        progress.finish();
        progress.begin("queued decode", 1);
        assert!(progress.check().is_err());
    }

    #[test]
    fn cancellation_stops_steps_and_new_work_resets_state() {
        let progress = Progress::new();
        assert!(!progress.cancel());
        progress.begin("decode", 2);
        progress.step().unwrap();
        assert_eq!(progress.snapshot()["completed"], 1);
        assert!(progress.cancel());
        assert_eq!(
            progress.step().unwrap_err().to_string(),
            "Operation cancelled"
        );
        assert_eq!(progress.snapshot()["completed"], 1);
        progress.set_stage("indexing", 10);
        assert_eq!(progress.snapshot()["completed"], 0);
        assert_eq!(progress.snapshot()["total"], 10);
        assert!(progress.check().is_err());
        progress.finish();
        assert!(!progress.cancel());
        assert_eq!(progress.snapshot()["running"], false);
        progress.begin("import", 1);
        progress.check().unwrap();
        progress.step().unwrap();
        progress.step().unwrap();
        let mut snapshot = progress.snapshot();
        snapshot.as_object_mut().unwrap().remove("id");
        assert_eq!(
            snapshot,
            json!({"running":true,"stage":"import","completed":1,"total":1,"cancelled":false})
        );
    }

    #[test]
    fn a_cancel_stops_only_the_job_it_names() {
        let progress = Progress::new();
        progress.begin("decode", 10);
        let shown = progress.snapshot()["id"].as_u64().unwrap();
        progress.finish();
        // The import the bar was about to show began in the meantime: the cancel for the decode does not stop it.
        progress.begin("import", 0);
        assert!(!progress.cancel_operation(shown));
        progress.check().unwrap();
        let import = progress.snapshot()["id"].as_u64().unwrap();
        assert_ne!(import, shown);
        assert!(progress.cancel_operation(import));
        assert!(progress.check().is_err());
        progress.finish();
        assert!(!progress.cancel_operation(import), "nothing runs any more");
    }

    #[test]
    fn concurrent_steps_are_counted_and_clamped() {
        let progress = Progress::new();
        progress.begin("decode", 400);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    for _ in 0..100 {
                        progress.step().unwrap();
                    }
                });
            }
        });
        assert_eq!(progress.snapshot()["completed"], 400);
    }
}
