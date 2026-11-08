//! The C library functions the pure-Rust OpenJPEG port (`openjp2`, machine-translated from C) still calls.
//! WebAssembly has no C library, so they are provided here on Rust's allocator. Memory, `memcpy` and the
//! math functions come from Rust's own compiler builtins.

use std::{
    alloc::{Layout, alloc, alloc_zeroed, dealloc, realloc as grow},
    ffi::{c_char, c_int},
    ptr::null_mut,
};

/// Each block starts with its size, so `free` and `realloc` can rebuild the layout.
const HEADER: usize = 16;

fn layout(size: usize) -> Option<Layout> {
    Layout::from_size_align(size.checked_add(HEADER)?, HEADER).ok()
}

unsafe fn allocate(size: usize, zeroed: bool) -> *mut u8 {
    let Some(layout) = layout(size) else { return null_mut() };
    unsafe {
        let block = if zeroed { alloc_zeroed(layout) } else { alloc(layout) };
        if block.is_null() {
            return null_mut();
        }
        (block as *mut usize).write(size);
        block.add(HEADER)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn malloc(size: usize) -> *mut u8 {
    unsafe { allocate(size, false) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn calloc(count: usize, size: usize) -> *mut u8 {
    match count.checked_mul(size) {
        Some(total) => unsafe { allocate(total, true) },
        None => null_mut(),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn free(pointer: *mut u8) {
    if pointer.is_null() {
        return;
    }
    unsafe {
        let block = pointer.sub(HEADER);
        let size = (block as *const usize).read();
        dealloc(block, layout(size).unwrap());
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn realloc(pointer: *mut u8, size: usize) -> *mut u8 {
    if pointer.is_null() {
        return unsafe { malloc(size) };
    }
    let Some(new_layout) = layout(size) else { return null_mut() };
    unsafe {
        let block = pointer.sub(HEADER);
        let old = (block as *const usize).read();
        let block = grow(block, layout(old).unwrap(), new_layout.size());
        if block.is_null() {
            return null_mut();
        }
        (block as *mut usize).write(size);
        block.add(HEADER)
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn strlen(text: *const c_char) -> usize {
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
    }
    length
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn strcpy(target: *mut c_char, source: *const c_char) -> *mut c_char {
    unsafe {
        let length = strlen(source);
        std::ptr::copy_nonoverlapping(source, target, length + 1);
    }
    target
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn strncmp(a: *const c_char, b: *const c_char, limit: usize) -> c_int {
    for i in 0..limit {
        let (x, y) = unsafe { (*a.add(i) as u8, *b.add(i) as u8) };
        if x != y {
            return x as c_int - y as c_int;
        }
        if x == 0 {
            return 0;
        }
    }
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn strcmp(a: *const c_char, b: *const c_char) -> c_int {
    unsafe { strncmp(a, b, usize::MAX) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn atoi(text: *const c_char) -> c_int {
    let text = unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy();
    let text = text.trim_start();
    let digits = text
        .char_indices()
        .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+')))
        .count();
    text[..digits].parse().unwrap_or(0)
}

/// OpenJPEG reads OPJ_NUM_THREADS; a page has no environment.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn getenv(_name: *const c_char) -> *mut c_char {
    null_mut()
}
