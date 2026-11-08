//! Draw into an OS-shareable allocation. The receiver only gets a handle after this submission completes.
#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac::Shared;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::Shared;

mod atlas;
pub mod image;
pub mod layers;
mod resident;
pub mod stl;
pub mod surgery;
pub mod volume;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use wgpu::util::DeviceExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameRequest {
    pub width: u32,
    pub height: u32,
    pub lease: u32,
    #[serde(default)]
    pub slot: Option<usize>,
    #[serde(default)]
    pub bitmap: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameReady {
    pub width: u32,
    pub height: u32,
    pub lease: u32,
    pub handle: String,
    pub adapter: String,
    pub gpu_complete_ms: f64,
    #[serde(skip)]
    pub rgba: Option<Vec<u8>>,
}

pub struct Renderer {
    pub lost: std::sync::Arc<std::sync::atomic::AtomicBool>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pub adapter: String,
    pub software: bool,
    pattern: wgpu::RenderPipeline,
    image_pipeline: wgpu::RenderPipeline,
    atlas: Option<atlas::Atlas>,
    resident: resident::Resident,
    targets: [Option<Target>; 3],
    volume: Option<volume::VolumeState>,
}
impl Renderer {
    pub fn new() -> Result<Self> {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = if cfg!(windows) {
            wgpu::Backends::DX12
        } else {
            wgpu::Backends::METAL
        };
        let instance = wgpu::Instance::new(descriptor);
        let adapter =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))?;
        let lost = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let notify = lost.clone();
        device.set_device_lost_callback(move |_, _| {
            notify.store(true, std::sync::atomic::Ordering::Release)
        });
        let errors = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let pattern = Self::pipeline(&device, include_str!("pattern.wgsl"));
        let image_pipeline = Self::pipeline(
            &device,
            concat!(include_str!("voxels.wgsl"), include_str!("image.wgsl")),
        );
        if let Some(error) = pollster::block_on(errors.pop()) {
            return Err(anyhow::anyhow!(error));
        }
        Ok(Self {
            lost,
            targets: Default::default(),
            volume: None,
            atlas: None,
            image_pipeline,
            resident: resident::Resident::new(&device),
            device,
            queue,
            software: adapter.get_info().device_type == wgpu::DeviceType::Cpu,
            adapter: adapter.get_info().name,
            pattern,
        })
    }
    fn pipeline(device: &wgpu::Device, shader: &str) -> wgpu::RenderPipeline {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("VEAcom image"),
            source: wgpu::ShaderSource::Wgsl(shader.into()),
        });
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("VEAcom image"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vertex"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fragment"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::TextureFormat::Bgra8Unorm.into())],
            }),
            multiview_mask: None,
            cache: None,
        })
    }
    fn target(&mut self, request: &FrameRequest) -> Result<Target> {
        if let Some(slot) = request.slot {
            ensure!(slot < self.targets.len(), "Invalid presentation slot");
            if let Some(mut t) = self.targets[slot].take()
                && t.texture.width() == request.width
                && t.texture.height() == request.height
                && t.shared.is_some() != request.bitmap
            {
                t.first = true;
                t.start = Instant::now();
                t.submissions = 0;
                return Ok(t);
            }
        }
        Target::new(&self.device, request)
    }
    fn finish_target(&mut self, target: Target, request: &FrameRequest) -> Result<FrameReady> {
        let frame = target.publish(&self.device, &self.queue, request, &self.adapter)?;
        if let Some(slot) = request.slot {
            self.targets[slot] = Some(target);
        }
        Ok(frame)
    }

    pub fn pattern(&mut self, request: &FrameRequest) -> Result<FrameReady> {
        let uniforms = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Frame number"),
                contents: bytemuck::cast_slice(&[request.lease, 0, 0, 0]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
        let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.pattern.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
        });
        let mut target = self.target(request)?;
        target.pass(
            &self.device,
            &self.queue,
            &self.pattern,
            &group,
            [0, 0, request.width, request.height],
        )?;
        self.finish_target(target, request)
    }
}
struct Target {
    shared: Option<Shared>,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    start: Instant,
    first: bool,
    submissions: usize,
}
impl Target {
    fn new(device: &wgpu::Device, request: &FrameRequest) -> Result<Self> {
        ensure!(
            request.width > 0
                && request.height > 0
                && request.width <= 8192
                && request.height <= 8192
                && u64::from(request.width) * u64::from(request.height) <= 16_777_216,
            "Invalid viewport dimensions"
        );
        let start = Instant::now();
        let desc = wgpu::TextureDescriptor {
            label: Some("Shared display frame"),
            size: wgpu::Extent3d {
                width: request.width,
                height: request.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | if request.bitmap {
                    wgpu::TextureUsages::COPY_SRC
                } else {
                    wgpu::TextureUsages::empty()
                },
            view_formats: &[],
        };
        let (shared, texture) = if request.bitmap {
            (None, device.create_texture(&desc))
        } else {
            let (shared, texture) = Shared::create(device, &desc)?;
            (Some(shared), texture)
        };
        let view = texture.create_view(&Default::default());
        Ok(Self {
            shared,
            texture,
            view,
            start,
            first: true,
            submissions: 0,
        })
    }
    fn pass(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pipeline: &wgpu::RenderPipeline,
        group: &wgpu::BindGroup,
        rect: [u32; 4],
    ) -> Result<()> {
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Image"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: if self.first {
                            wgpu::LoadOp::Clear(wgpu::Color::BLACK)
                        } else {
                            wgpu::LoadOp::Load
                        },
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_scissor_rect(rect[0], rect[1], rect[2], rect[3]);
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.draw(0..3, 0..1);
        }
        let submission = queue.submit([encoder.finish()]);
        self.first = false;
        self.submissions += 1;
        if self.submissions.is_multiple_of(8) {
            device.poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(Duration::from_secs(10)),
            })?;
        }
        Ok(())
    }
    fn publish(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        request: &FrameRequest,
        adapter: &str,
    ) -> Result<FrameReady> {
        let mut encoder = device.create_command_encoder(&Default::default());
        let bytes_per_row = request.width * 4;
        let pitch = bytes_per_row.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let readback = if self.shared.is_none() {
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Finished display frame"),
                size: u64::from(pitch) * u64::from(request.height),
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            encoder.copy_texture_to_buffer(
                self.texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(pitch),
                        rows_per_image: None,
                    },
                },
                self.texture.size(),
            );
            Some(buffer)
        } else {
            // D3D12 consumers open the shared resource in COMMON after producer completion.
            #[cfg(windows)]
            encoder.transition_resources(
                std::iter::empty(),
                std::iter::once(wgpu::TextureTransition {
                    texture: &self.texture,
                    selector: None,
                    state: wgpu::TextureUses::PRESENT,
                }),
            );
            None
        };
        let submission = queue.submit([encoder.finish()]);
        let mapped = readback.as_ref().map(|buffer| {
            let (send, receive) = std::sync::mpsc::sync_channel(1);
            buffer
                .slice(..)
                .map_async(wgpu::MapMode::Read, move |result| {
                    let _ = send.send(result);
                });
            receive
        });
        device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(10)),
        })?;
        let rgba = match (readback, mapped) {
            (Some(buffer), Some(receive)) => {
                receive.recv_timeout(Duration::from_secs(10))??;
                let mapped = buffer.slice(..).get_mapped_range()?;
                let mut bytes =
                    Vec::with_capacity(bytes_per_row as usize * request.height as usize);
                for row in mapped.chunks_exact(pitch as usize) {
                    for pixel in row[..bytes_per_row as usize].chunks_exact(4) {
                        bytes.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
                    }
                }
                Some(bytes)
            }
            _ => None,
        };
        let elapsed = self.start.elapsed().as_secs_f64() * 1000.;
        Ok(FrameReady {
            width: request.width,
            height: request.height,
            lease: request.lease,
            handle: self
                .shared
                .as_ref()
                .map(|shared| shared.publish(request.lease))
                .transpose()?
                .unwrap_or_default(),
            adapter: adapter.to_owned(),
            gpu_complete_ms: elapsed,
            rgba,
        })
    }
}
