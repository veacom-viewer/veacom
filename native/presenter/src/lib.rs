//! Electron main receives only locally owned handles. No handle is exposed to the page.
mod node;
use std::{cell::Cell, ffi::CStr};
type Result<T> = std::result::Result<T, &'static CStr>;

#[cfg(target_os = "macos")]
mod os {
    unsafe extern "C" {
        pub fn start_receiver(name: *const std::ffi::c_char) -> u32;
        pub fn stop_receiver(port: u32);
        pub fn receive_surface(port: u32, pid: u32, lease: u32) -> *const std::ffi::c_void;
        pub fn release_surface(surface: *const std::ffi::c_void);
    }
}
#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

pub struct Receiver {
    #[cfg(target_os = "macos")]
    port: u32,
}
impl Receiver {
    pub fn new(name: &CStr) -> Result<Self> {
        #[cfg(target_os = "macos")]
        {
            // The port owns a private receive right and is destroyed with this object.
            let port = unsafe { os::start_receiver(name.as_ptr()) };
            if port == 0 {
                return Err(c"Could not register texture receiver");
            }
            Ok(Self { port })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = name;
            Ok(Self {})
        }
    }
    pub fn receive(&self, pid: u32, lease: u32, handle: &CStr) -> Result<Surface> {
        #[cfg(target_os = "macos")]
        let pointer = {
            let _ = handle;
            (unsafe { os::receive_surface(self.port, pid, lease) }) as usize
        };
        #[cfg(windows)]
        let pointer = {
            use windows::Win32::{
                Foundation::{
                    CloseHandle as close, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE,
                },
                System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE},
            };
            let _ = lease;
            let raw = handle
                .to_str()
                .ok()
                .and_then(|s| usize::from_str_radix(s, 16).ok())
                .filter(|v| *v != 0)
                .ok_or(c"Invalid texture handle")?;
            // Only the known producer's handle table is consulted. Our duplicate belongs
            // to this process and remains valid until Electron releases the surface.
            let process = unsafe { OpenProcess(PROCESS_DUP_HANDLE, false, pid) }
                .map_err(|_| c"Could not duplicate the producer texture handle")?;
            let mut local = HANDLE::default();
            let copied = unsafe {
                DuplicateHandle(
                    process,
                    HANDLE(raw as *mut _),
                    GetCurrentProcess(),
                    &mut local,
                    0,
                    false,
                    DUPLICATE_SAME_ACCESS,
                )
            };
            unsafe {
                let _ = close(process);
            }
            copied.map_err(|_| c"Could not duplicate the producer texture handle")?;
            local.0 as usize
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let pointer = {
            let _ = (pid, lease, handle);
            0
        };
        if pointer == 0 {
            return Err(c"Native texture handle unavailable");
        }
        Ok(Surface {
            pointer: Cell::new(pointer),
        })
    }
}
impl Drop for Receiver {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        unsafe {
            os::stop_receiver(self.port);
        }
    }
}

pub struct Surface {
    pointer: Cell<usize>,
}
impl Surface {
    pub fn bytes(&self) -> [u8; size_of::<usize>()] {
        self.pointer.get().to_ne_bytes()
    }
    pub fn release(&self) {
        let p = self.pointer.replace(0);
        if p == 0 {
            return;
        }
        #[cfg(target_os = "macos")]
        unsafe {
            os::release_surface(p as *const _);
        }
        #[cfg(windows)]
        unsafe {
            CloseHandle(p as *mut _);
        }
    }
}
impl Drop for Surface {
    fn drop(&mut self) {
        self.release();
    }
}
