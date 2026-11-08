use anyhow::{Result, ensure};
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_metal::{MTLTexture, MTLTextureType};
use std::{
    ffi::{CString, c_char, c_void},
    ptr::NonNull,
};

unsafe extern "C" {
    fn create_target(
        device: *const c_void,
        width: u32,
        height: u32,
        surface: *mut *mut c_void,
    ) -> *mut ProtocolObject<dyn MTLTexture>;
    fn release_target(surface: *mut c_void);
    fn send_target(surface: *mut c_void, service: *const c_char, lease: u32) -> i32;
}
pub struct Shared(NonNull<c_void>);
// SAFETY: this owns one retained IOSurface reference. It has no thread affinity, and
// the renderer mutex and the compositor release callback serialize reuse of its pixels.
unsafe impl Send for Shared {}
impl Shared {
    pub fn create(
        device: &wgpu::Device,
        desc: &wgpu::TextureDescriptor,
    ) -> Result<(Self, wgpu::Texture)> {
        // The allocation is created on this wgpu device with exactly the descriptor imported below.
        let raw = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }
            .ok_or_else(|| anyhow::anyhow!("Metal device unavailable"))?;
        let mut surface = std::ptr::null_mut();
        let texture = unsafe {
            create_target(
                Retained::as_ptr(raw.raw_device()).cast(),
                desc.size.width,
                desc.size.height,
                &mut surface,
            )
        };
        let texture = unsafe { Retained::from_raw(texture) }
            .ok_or_else(|| anyhow::anyhow!("Unable to create Metal surface"))?;
        let shared =
            Shared(NonNull::new(surface).ok_or_else(|| anyhow::anyhow!("Missing IOSurface"))?);
        let hal = unsafe {
            wgpu::hal::metal::Device::texture_from_raw(
                texture,
                desc.format,
                MTLTextureType::Type2D,
                1,
                1,
                desc.size.into(),
                None,
            )
        };
        drop(raw);
        let texture = unsafe {
            device.create_texture_from_hal::<wgpu::hal::api::Metal>(
                hal,
                desc,
                wgpu::TextureUses::UNINITIALIZED,
            )
        };
        Ok((shared, texture))
    }
    pub fn publish(&self, lease: u32) -> Result<String> {
        let service = CString::new(std::env::var("VEACOM_SURFACE_SERVICE")?)?;
        ensure!(
            unsafe { send_target(self.0.as_ptr(), service.as_ptr(), lease) } == 0,
            "Unable to deliver Metal surface"
        );
        Ok(String::new())
    }
}
impl Drop for Shared {
    fn drop(&mut self) {
        unsafe {
            release_target(self.0.as_ptr());
        }
    }
}
