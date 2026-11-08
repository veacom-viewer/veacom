//! WebAssembly's allocator with one difference: freeing a null pointer does nothing.
//!
//! openjp2 0.6.1 (JPEG 2000) frees every code block's decoded buffer with `dealloc`, also blocks that were
//! never decoded and whose pointer is null (`opj_tcd_code_block_dec_deallocate`, tcd.rs). The system
//! allocators of desktop platforms ignore that; WebAssembly's (dlmalloc) reads the block header below the
//! pointer, outside memory, and the module stops ("memory access out of bounds") on the first JPEG 2000
//! image. Until openjp2 checks the pointer itself, null is skipped here.

use std::alloc::{GlobalAlloc, Layout, System};

pub struct NullTolerant;

unsafe impl GlobalAlloc for NullTolerant {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if !pointer.is_null() {
            unsafe { System.dealloc(pointer, layout) }
        }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: NullTolerant = NullTolerant;
