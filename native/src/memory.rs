//! Large allocations go straight to the operating system, so freeing them returns the memory.
//!
//! A decoded volume is freed as soon as its response has been sent (volumes over the cache
//! budget are not kept). macOS's allocator hands a freed block this large back to the system
//! only later, and `malloc_zone_pressure_relief` does not hurry it: in nine runs on an M4 Pro
//! the engine still held a served 500 MiB volume 3 s afterwards in six, once for 20–40 s.
//! Blocks of at least [`LARGE`] are therefore mapped with `mmap` and unmapped on free, which
//! returns them at once; everything smaller, including small volumes, still uses the system
//! allocator. Windows is left as it is: its process heap already returns blocks this large on
//! free (on the Tesla T4 VM the engine's private bytes fell back to 9–31 MiB after each 500 MiB
//! transfer). `decode::volume_as` reserves each volume's exact size once, so mapping never adds
//! copies while a volume is built.

use std::alloc::{GlobalAlloc, Layout, System};

/// Allocations at least this large are mapped directly.
pub const LARGE: usize = 32 << 20;

pub struct PageAllocator;

fn mapped(layout: Layout) -> bool {
    cfg!(unix) && layout.size() >= LARGE && layout.align() <= 4096
}

#[cfg(unix)]
mod pages {
    /// Anonymous pages are zero-filled and aligned to at least 4 KiB.
    pub unsafe fn map(size: usize) -> *mut u8 {
        // SAFETY: a new private anonymous mapping aliases no existing memory.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANON,
                -1,
                0,
            )
        };
        if address == libc::MAP_FAILED {
            std::ptr::null_mut()
        } else {
            address.cast()
        }
    }
    pub unsafe fn unmap(address: *mut u8, size: usize) {
        // GlobalAlloc cannot unwind or report an error from dealloc. If the OS refuses,
        // the mapping stays in the process until exit.
        // SAFETY: the caller passes a mapping returned by `map` with its original size.
        unsafe { libc::munmap(address.cast(), size) };
    }
}

#[cfg(not(unix))]
mod pages {
    pub unsafe fn map(_: usize) -> *mut u8 {
        unreachable!("only unix maps large allocations")
    }
    pub unsafe fn unmap(_: *mut u8, _: usize) {
        unreachable!("only unix maps large allocations")
    }
}

// SAFETY: every block is released by the same mechanism that allocated it, chosen from its
// layout, which Rust passes unchanged to `dealloc` and `realloc`.
unsafe impl GlobalAlloc for PageAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if mapped(layout) {
            unsafe { pages::map(layout.size()) }
        } else {
            unsafe { System.alloc(layout) }
        }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if mapped(layout) {
            unsafe { pages::map(layout.size()) }
        } else {
            unsafe { System.alloc_zeroed(layout) }
        }
    }

    unsafe fn dealloc(&self, address: *mut u8, layout: Layout) {
        if mapped(layout) {
            unsafe { pages::unmap(address, layout.size()) }
        } else {
            unsafe { System.dealloc(address, layout) }
        }
    }

    unsafe fn realloc(&self, address: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: `new_size` with the old alignment is a valid layout per GlobalAlloc's contract.
        let new_layout = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
        if !mapped(layout) && !mapped(new_layout) {
            return unsafe { System.realloc(address, layout, new_size) };
        }
        let moved = unsafe { self.alloc(new_layout) };
        if !moved.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(address, moved, layout.size().min(new_size));
                self.dealloc(address, layout);
            }
        }
        moved
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// These tests run one at a time, so the memory one measures only its own buffer.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Physical footprint on macOS (what Activity Monitor shows), resident size on Linux.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn resident_bytes() -> usize {
        #[cfg(target_os = "macos")]
        {
            let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
            // SAFETY: RUSAGE_INFO_V2 fills a rusage_info_v2 for this process.
            let status = unsafe {
                libc::proc_pid_rusage(
                    libc::getpid(),
                    libc::RUSAGE_INFO_V2,
                    info.as_mut_ptr().cast(),
                )
            };
            assert_eq!(status, 0, "proc_pid_rusage failed");
            // SAFETY: the call succeeded, so the structure is filled.
            unsafe { info.assume_init() }.ri_phys_footprint as usize
        }
        #[cfg(target_os = "linux")]
        {
            let statm = std::fs::read_to_string("/proc/self/statm").unwrap();
            let pages: usize = statm.split_whitespace().nth(1).unwrap().parse().unwrap();
            // SAFETY: sysconf has no preconditions.
            pages * unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as usize
        }
    }

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn freeing_a_large_buffer_returns_its_memory() {
        let _serial = serial();
        const SIZE: usize = 256 << 20;
        let mut buffer: Vec<u8> = Vec::with_capacity(SIZE);
        buffer.resize(SIZE, 1); // every page is written, so every page is resident
        let held = resident_bytes();
        drop(std::hint::black_box(buffer));
        let after = resident_bytes();
        // Through macOS's allocator the drop comes seconds later: none at this point.
        assert!(
            held.saturating_sub(after) >= SIZE / 4 * 3,
            "freeing {} MiB lowered resident memory by only {} MiB ({} -> {} MiB)",
            SIZE >> 20,
            held.saturating_sub(after) >> 20,
            held >> 20,
            after >> 20
        );
    }

    #[test]
    fn mapped_buffers_keep_their_contents_when_resized_between_mapped_sizes() {
        let _serial = serial();
        let layout = Layout::from_size_align(LARGE, 8).unwrap();
        let pattern = |i: usize| (i * 31 + 7) as u8;
        // SAFETY: each pointer is used within the size of the layout it was last given.
        unsafe {
            let first = PageAllocator.alloc(layout);
            assert!(!first.is_null());
            for i in (0..LARGE).step_by(4093) {
                *first.add(i) = pattern(i);
            }
            let grown = PageAllocator.realloc(first, layout, 3 * LARGE);
            assert!(!grown.is_null());
            assert!(
                (0..LARGE)
                    .step_by(4093)
                    .all(|i| *grown.add(i) == pattern(i))
            );
            *grown.add(3 * LARGE - 1) = 9;
            let shrunk = PageAllocator.realloc(
                grown,
                Layout::from_size_align(3 * LARGE, 8).unwrap(),
                LARGE + 1,
            );
            assert!(!shrunk.is_null());
            assert!(
                (0..LARGE)
                    .step_by(4093)
                    .all(|i| *shrunk.add(i) == pattern(i))
            );
            PageAllocator.dealloc(shrunk, Layout::from_size_align(LARGE + 1, 8).unwrap());
        }
    }

    #[test]
    fn large_buffers_aligned_beyond_a_page_use_the_system_allocator() {
        let _serial = serial();
        let layout = Layout::from_size_align(LARGE, 1 << 16).unwrap();
        assert!(!mapped(layout));
        // SAFETY: the block is used within its layout and freed with the same layout.
        unsafe {
            let block = PageAllocator.alloc(layout);
            assert!(!block.is_null());
            assert_eq!(block as usize % (1 << 16), 0);
            *block.add(LARGE - 1) = 1;
            PageAllocator.dealloc(block, layout);
        }
    }

    #[test]
    fn large_buffers_keep_their_contents_across_growth_and_shrinking() {
        let _serial = serial();
        let mut values: Vec<u16> = (0..1_000).collect();
        values.reserve_exact(LARGE); // small -> mapped
        values.extend((0..LARGE as u64 / 2).map(|i| i as u16));
        assert!(
            values[..1_000]
                .iter()
                .enumerate()
                .all(|(i, &v)| v == i as u16)
        );
        values.truncate(10);
        values.shrink_to_fit(); // mapped -> small
        assert_eq!(values, (0..10).collect::<Vec<u16>>());
    }

    #[test]
    fn large_zeroed_buffers_are_zero() {
        let _serial = serial();
        let zeros = vec![0u8; LARGE + 4096];
        assert!(zeros.iter().step_by(4093).all(|&b| b == 0));
    }
}
