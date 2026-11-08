//! One full-resolution scalar texture for reconstructed planes and raycasts. Source frames and
//! volumes outside the device limits still use the bounded tile atlas.
use super::Renderer;
use crate::model::SourceSeries;
use anyhow::{Result, ensure};
use wgpu::util::DeviceExt;

const MAX_BYTES: usize = 512 << 20;

struct Texture {
    view: wgpu::TextureView,
    padding: wgpu::Buffer,
    kind: u32,
}
pub(super) struct Resident {
    empty: Texture,
    volume: Option<(String, u64, Texture)>,
    declined: Option<(String, u64)>,
}

impl Resident {
    pub fn new(device: &wgpu::Device) -> Self {
        let texture = allocate(device, [1; 3], wgpu::TextureFormat::R8Uint);
        let empty = Texture {
            view: texture.create_view(&Default::default()),
            padding: padding_buffer(device, &[[1., -1.]]),
            kind: 0,
        };
        Self {
            empty,
            volume: None,
            declined: None,
        }
    }
    pub fn bindings(&self) -> (&wgpu::TextureView, &wgpu::Buffer) {
        let texture = self.volume.as_ref().map_or(&self.empty, |v| &v.2);
        (&texture.view, &texture.padding)
    }
    pub fn forget(&mut self, id: &str) {
        if self.volume.as_ref().is_some_and(|v| v.0 == id) {
            self.volume = None;
        }
        if self.declined.as_ref().is_some_and(|v| v.0 == id) {
            self.declined = None;
        }
    }
}

fn allocate(device: &wgpu::Device, d: [u32; 3], format: wgpu::TextureFormat) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Resident scalar volume"),
        size: wgpu::Extent3d {
            width: d[0],
            height: d[1],
            depth_or_array_layers: d[2],
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}
fn padding_buffer(device: &wgpu::Device, ranges: &[[f32; 2]]) -> wgpu::Buffer {
    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Per-frame padding"),
        contents: bytemuck::cast_slice(ranges),
        usage: wgpu::BufferUsages::STORAGE,
    })
}

impl Renderer {
    pub(super) fn resident_kind(&mut self, source: &SourceSeries) -> Result<u32> {
        let s = &source.info;
        if let Some((id, revision, texture)) = &self.resident.volume
            && id == &s.id
            && *revision == s.source_revision
        {
            return Ok(texture.kind);
        }
        if self
            .resident
            .declined
            .as_ref()
            .is_some_and(|(id, rev)| id == &s.id && *rev == s.source_revision)
        {
            return Ok(0);
        }
        let d = s.dimensions;
        let max = self.device.limits().max_texture_dimension_3d as usize;
        if s.components != 1 || !s.can_reconstruct || d.iter().any(|&n| n == 0 || n > max) {
            return Ok(0);
        }
        let (kind, format, bytes) = match s.pixel_type.as_str() {
            "uint8" => (1, wgpu::TextureFormat::R8Uint, 1),
            "uint16" => (1, wgpu::TextureFormat::R16Uint, 2),
            "int16" => (2, wgpu::TextureFormat::R16Uint, 2),
            "float32" | "float64" => (3, wgpu::TextureFormat::R32Uint, 4),
            _ => return Ok(0),
        };
        if d.into_iter()
            .try_fold(bytes, usize::checked_mul)
            .is_none_or(|n| n > MAX_BYTES)
        {
            return Ok(0);
        }
        self.resident.volume = None;
        let errors = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let texture = allocate(&self.device, d.map(|v| v as u32), format);
        if pollster::block_on(errors.pop()).is_some() {
            self.resident.declined = Some((s.id.clone(), s.source_revision));
            return Ok(0);
        }
        let mut ranges = Vec::with_capacity(d[2]);
        let mut converted = Vec::new();
        let mut integers = Vec::new();
        let mut staged = 0;
        for z in 0..d[2] {
            let frame = crate::frames::read(source, z)?;
            ensure!(frame.len() == d[0] * d[1], "Invalid resident source frame");
            let range = source.frames[z].metadata.padding_range.or(s.padding_range);
            ranges.push(range.filter(|_| kind != 3).map_or([1., -1.], |[a, b]| {
                [a.min(b).ceil() as f32, a.max(b).floor() as f32]
            }));
            let raw = if kind == 3 {
                converted.clear();
                for n in 0..frame.len() {
                    let v = frame.value(n);
                    let displayed = if frame.is_padding(source, z, v) {
                        f32::NAN
                    } else {
                        let value = v as f32;
                        ensure!(
                            !v.is_finite() || value.is_finite(),
                            "Pixel value exceeds the GPU display range"
                        );
                        value
                    };
                    converted.push(displayed.to_bits());
                }
                bytemuck::cast_slice(&converted)
            } else if frame.type_name() == s.pixel_type {
                frame.bytes()
            } else {
                // A source frame may use a narrower buffer than the series. Never clamp a rescaled voxel.
                integers.clear();
                let (lo, hi) = if kind == 2 {
                    (i16::MIN as f64, i16::MAX as f64)
                } else if bytes == 1 {
                    (0., 255.)
                } else {
                    (0., 65535.)
                };
                for n in 0..frame.len() {
                    let v = frame.value(n);
                    if v.fract() != 0. || !(lo..=hi).contains(&v) {
                        self.resident.declined = Some((s.id.clone(), s.source_revision));
                        return Ok(0);
                    }
                    if bytes == 1 {
                        integers.push(v as u8);
                    } else if kind == 2 {
                        integers.extend_from_slice(&(v as i16).to_le_bytes());
                    } else {
                        integers.extend_from_slice(&(v as u16).to_le_bytes());
                    }
                }
                integers.as_slice()
            };
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: 0,
                        z: z as u32,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                raw,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some((d[0] * bytes) as u32),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: d[0] as u32,
                    height: d[1] as u32,
                    depth_or_array_layers: 1,
                },
            );
            staged += raw.len();
            if staged >= 32 << 20 || z + 1 == d[2] {
                let submission = self.queue.submit([]);
                self.device.poll(wgpu::PollType::Wait {
                    submission_index: Some(submission),
                    timeout: Some(std::time::Duration::from_secs(15)),
                })?;
                staged = 0;
            }
        }
        self.resident.volume = Some((
            s.id.clone(),
            s.source_revision,
            Texture {
                view: texture.create_view(&Default::default()),
                padding: padding_buffer(&self.device, &ranges),
                kind,
            },
        ));
        Ok(kind)
    }
}
