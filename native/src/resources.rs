// Counters for this process only. Read on demand by the main process's broker.
use serde::Serialize;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    cpu_seconds: Option<f64>,
    resident_bytes: Option<u64>,
    peak_resident_bytes: Option<u64>,
}

pub fn snapshot() -> Counters {
    read()
}

#[cfg(unix)]
fn read() -> Counters {
    // getrusage fills the whole structure on success.
    let mut raw = std::mem::MaybeUninit::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, raw.as_mut_ptr()) } != 0 {
        return Counters::default();
    }
    let raw = unsafe { raw.assume_init() };
    let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
    let peak = u64::try_from(raw.ru_maxrss).ok();
    Counters {
        cpu_seconds: Some(seconds(raw.ru_utime) + seconds(raw.ru_stime)),
        resident_bytes: resident(),
        // Darwin reports bytes; Linux reports KiB.
        peak_resident_bytes: peak
            .and_then(|n| n.checked_mul(if cfg!(target_os = "macos") { 1 } else { 1024 })),
    }
}

#[cfg(target_os = "macos")]
fn resident() -> Option<u64> {
    let mut task = std::mem::MaybeUninit::<libc::proc_taskinfo>::uninit();
    let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
    // PROC_PIDTASKINFO writes exactly one proc_taskinfo for our own PID.
    let count = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTASKINFO,
            0,
            task.as_mut_ptr().cast(),
            size,
        )
    };
    (count == size).then(|| unsafe { task.assume_init() }.pti_resident_size)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn resident() -> Option<u64> {
    let pages = std::fs::read_to_string("/proc/self/statm")
        .ok()?
        .split_whitespace()
        .nth(1)?
        .parse::<u64>()
        .ok()?;
    let page_size = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
    pages.checked_mul(page_size)
}

#[cfg(windows)]
fn read() -> Counters {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::{
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{GetCurrentProcess, GetProcessTimes},
        },
    };
    let own = unsafe { GetCurrentProcess() };
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    let ticks =
        |t: FILETIME| ((u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)) as f64;
    let cpu =
        unsafe { GetProcessTimes(own, &mut created, &mut exited, &mut kernel, &mut user) } != 0;
    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let mut memory = PROCESS_MEMORY_COUNTERS {
        cb: size,
        ..Default::default()
    };
    let ram = unsafe { GetProcessMemoryInfo(own, &mut memory, size) } != 0;
    Counters {
        cpu_seconds: cpu.then(|| (ticks(kernel) + ticks(user)) / 10_000_000.0),
        resident_bytes: ram.then_some(memory.WorkingSetSize as u64),
        peak_resident_bytes: ram.then_some(memory.PeakWorkingSetSize as u64),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_own_process_with_consistent_units() {
        let before = super::read();
        assert!(before.cpu_seconds.unwrap() >= 0.);
        let current = before.resident_bytes.unwrap();
        assert!(current > 1024 * 1024 && before.peak_resident_bytes.unwrap() > 1024 * 1024);
        assert!(super::read().cpu_seconds.unwrap() >= before.cpu_seconds.unwrap());
    }
}
