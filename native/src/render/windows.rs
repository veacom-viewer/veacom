use anyhow::Result;
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::Mutex,
};
use windows::Win32::{
    Foundation::GENERIC_ALL,
    Graphics::{Direct3D12::*, Dxgi::Common::*},
};

// Main serializes producer requests until it has duplicated the previous handle.
// Keep the last handle alive until main can duplicate it from the private pipe reply.
static PUBLISHED: Mutex<Option<OwnedHandle>> = Mutex::new(None);
pub struct Shared(OwnedHandle);
impl Shared {
    pub fn create(
        device: &wgpu::Device,
        desc: &wgpu::TextureDescriptor,
    ) -> Result<(Self, wgpu::Texture)> {
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }
            .ok_or_else(|| anyhow::anyhow!("D3D12 device unavailable"))?;
        let raw = hal.raw_device();
        let heap = D3D12_HEAP_PROPERTIES {
            Type: D3D12_HEAP_TYPE_DEFAULT,
            CreationNodeMask: 1,
            VisibleNodeMask: 1,
            ..Default::default()
        };
        let resource_desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
            Width: desc.size.width.into(),
            Height: desc.size.height,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
            // Chromium opens this allocation on its own D3D11 device after the D3D12 fence completes.
            Flags: D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET
                | D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS,
            ..Default::default()
        };
        let mut resource: Option<ID3D12Resource> = None;
        unsafe {
            raw.CreateCommittedResource(
                &heap,
                D3D12_HEAP_FLAG_SHARED,
                &resource_desc,
                D3D12_RESOURCE_STATE_COMMON,
                None,
                &mut resource,
            )
        }?;
        let resource = resource.ok_or_else(|| anyhow::anyhow!("D3D12 texture unavailable"))?;
        let raw_handle = unsafe { raw.CreateSharedHandle(&resource, None, GENERIC_ALL.0, None) }?;
        let handle = unsafe { OwnedHandle::from_raw_handle(raw_handle.0) };
        let texture = unsafe {
            wgpu::hal::dx12::Device::texture_from_raw(
                resource,
                desc.format,
                desc.dimension,
                desc.size,
                1,
                1,
            )
        };
        drop(hal);
        let texture = unsafe {
            device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
                texture,
                desc,
                wgpu::TextureUses::UNINITIALIZED,
            )
        };
        Ok((Self(handle), texture))
    }
    pub fn publish(&self, _lease: u32) -> Result<String> {
        let handle = self.0.try_clone()?;
        let token = format!("{:x}", handle.as_raw_handle() as usize);
        *PUBLISHED.lock().unwrap() = Some(handle);
        Ok(token)
    }
}
