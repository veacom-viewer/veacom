//! Visit disjoint boxes in camera order. Each pass accumulates the same globally spaced ray samples.
//! The interpolation and gradient halo is resident even at a box boundary.
use super::{
    FrameReady, FrameRequest, Renderer,
    atlas::{Atlas, Bounds, EDGE},
    image::bind,
    layers::Layers,
};
use crate::{
    model::SourceSeries,
    sampling::{Grid, PatientPoint, Vector},
};
use anyhow::{Result, ensure};
use serde::Deserialize;
use std::{collections::HashMap, sync::Arc};
use wgpu::util::DeviceExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    pub series_id: String,
    pub revision: u64,
    pub target: String,
    pub layer_revision: u32,
    pub width: u32,
    pub height: u32,
    pub lease: u32,
    #[serde(default)]
    pub slot: Option<usize>,
    #[serde(default)]
    pub bitmap: bool,
    center: PatientPoint,
    eye: Vector,
    inverse_vp: [f64; 16],
    crop_min: [usize; 3],
    crop_max: [usize; 3],
    threshold: f64,
    ramp: f64,
    step: f64,
    index_step: f64,
}

#[derive(Clone, Copy)]
struct Box3 {
    lo: [usize; 3],
    hi: [usize; 3],
}
impl Box3 {
    fn tiles(self, dims: [usize; 3]) -> Bounds {
        Bounds::of(
            self.lo.map(|n| n.saturating_sub(2) as f64),
            std::array::from_fn(|a| (self.hi[a] + 2).min(dims[a] - 1) as f64),
            dims,
        )
    }
    fn leaves(
        self,
        dims: [usize; 3],
        capacity: usize,
        eye: Vector,
        out: &mut Vec<Self>,
    ) -> Result<()> {
        let bounds = self.tiles(dims);
        if bounds.count() <= capacity {
            out.push(self);
            return Ok(());
        }
        let axis = (0..3)
            .filter(|&a| self.hi[a] > self.lo[a])
            .max_by_key(|&a| bounds.size[a])
            .ok_or_else(|| anyhow::anyhow!("Unable to subdivide render box"))?;
        let cut = (self.lo[axis] + self.hi[axis]) / 2;
        let (mut left, mut right) = (self, self);
        left.hi[axis] = cut;
        right.lo[axis] = cut + 1;
        let ordered = if eye[axis] < (cut as f64 + 0.5) {
            [left, right]
        } else {
            [right, left]
        };
        for item in ordered {
            item.leaves(dims, capacity, eye, out)?;
        }
        Ok(())
    }
}
#[derive(Clone)]
struct Stamp {
    target: String,
    series: String,
    source_revision: u64,
    version: u32,
    tile: [u32; 3],
}

impl Stamp {
    fn reusable(&self, scene: &Scene, layers: &Layers, tile: [u32; 3], dims: [usize; 3]) -> bool {
        if self.tile != tile
            || self.source_revision != scene.revision
            || self.series != scene.series_id
            || self.target != scene.target
        {
            return false;
        }
        if self.version == layers.revision {
            return true;
        }
        let Some((base, dirty)) = &layers.dirty else {
            return false;
        };
        let [x, y, z] = tile.map(|v| v as usize);
        let (left, top) = (x * EDGE, y * EDGE);
        *base == self.version
            && (top..(top + EDGE).min(dims[1])).all(|row| {
                let start = (z * dims[1] + row) * dims[0] + left;
                let end = start + EDGE.min(dims[0] - left);
                dirty
                    .get(dirty.partition_point(|&n| (n as usize) < start))
                    .is_none_or(|&n| n as usize >= end)
            })
    }
}

pub(super) struct VolumeState {
    march: wgpu::ComputePipeline,
    composite: wgpu::RenderPipeline,
    masks: wgpu::Buffer,
    dense_mask: super::layers::MaskTexture,
    stamps: Vec<Option<Stamp>>,
    layers: HashMap<String, Arc<Layers>>,
}
impl VolumeState {
    pub fn new(device: &wgpu::Device, capacity: usize) -> Result<Self> {
        let errors = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Volume raymarch"),
            source: wgpu::ShaderSource::Wgsl(
                concat!(include_str!("voxels.wgsl"), include_str!("volume.wgsl")).into(),
            ),
        });
        let march = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Volume rendering"),
            layout: None,
            module: &shader,
            entry_point: Some("march"),
            compilation_options: Default::default(),
            cache: None,
        });
        let composite = Renderer::pipeline(device, include_str!("composite.wgsl"));
        if let Some(error) = pollster::block_on(errors.pop()) {
            return Err(anyhow::anyhow!(error));
        }
        Ok(Self {
            march,
            composite,
            dense_mask: super::layers::MaskTexture::empty(device),
            masks: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Mask tiles"),
                size: (capacity * EDGE * EDGE * 2) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            stamps: vec![None; capacity],
            layers: Default::default(),
        })
    }
    fn mask_tiles(
        &mut self,
        queue: &wgpu::Queue,
        view: &Scene,
        layers: &Layers,
        b: Bounds,
        table: &[u32],
        dims: [usize; 3],
    ) {
        let mut n = 0;
        let mut tile = vec![0u32; EDGE * EDGE];
        let mut packed = vec![0u32; EDGE * EDGE / 2];
        for z in b.first[2]..b.first[2] + b.size[2] {
            for y in b.first[1]..b.first[1] + b.size[1] {
                for x in b.first[0]..b.first[0] + b.size[0] {
                    let slot = table[n] as usize - 1;
                    n += 1;
                    if let Some(stamp) = &mut self.stamps[slot]
                        && stamp.reusable(view, layers, [x, y, z], dims)
                    {
                        stamp.version = layers.revision;
                        continue;
                    }
                    tile.fill(0);
                    let left = x as usize * EDGE;
                    let top = y as usize * EDGE;
                    for j in 0..EDGE.min(dims[1] - top) {
                        let start = (z as usize * dims[1] + top + j) * dims[0] + left;
                        layers.fill_row(
                            start,
                            &mut tile[j * EDGE..j * EDGE + EDGE.min(dims[0] - left)],
                        );
                    }
                    for (word, values) in packed.iter_mut().zip(tile.chunks_exact(2)) {
                        *word = values[0] | (values[1] << 16);
                    }
                    queue.write_buffer(
                        &self.masks,
                        (slot * EDGE * EDGE * 2) as u64,
                        bytemuck::cast_slice(&packed),
                    );
                    self.stamps[slot] = Some(Stamp {
                        target: view.target.clone(),
                        series: view.series_id.clone(),
                        source_revision: view.revision,
                        version: layers.revision,
                        tile: [x, y, z],
                    });
                }
            }
        }
    }
}
impl Renderer {
    fn volume_state(&mut self) -> Result<&mut VolumeState> {
        if self.volume.is_none() {
            let atlas = self.atlas.get_or_insert_with(|| Atlas::new(&self.device));
            self.volume = Some(VolumeState::new(&self.device, atlas.capacity)?);
        }
        Ok(self.volume.as_mut().unwrap())
    }
    pub fn layers(
        &self,
        target: &str,
        series_id: &str,
        series_revision: u64,
        revision: u32,
    ) -> Result<Arc<Layers>> {
        if revision == 0 {
            return Ok(Arc::new(Layers::default()));
        }
        self.volume
            .as_ref()
            .and_then(|s| s.layers.get(target))
            .filter(|l| {
                l.series_id == series_id
                    && l.series_revision == series_revision
                    && l.revision == revision
            })
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Volume mask revision changed"))
    }
    pub fn set_layers(&mut self, name: String, layer: Layers) -> Result<()> {
        let state = self.volume_state()?;
        ensure!(
            state.layers.contains_key(&name) || state.layers.len() < 32,
            "Too many open volume views"
        );
        if state.layers.get(&name).is_some_and(|old| {
            old.series_id == layer.series_id
                && old.series_revision == layer.series_revision
                && old.revision >= layer.revision
        }) {
            return Ok(());
        }
        let used: usize = state
            .layers
            .iter()
            .filter(|(key, _)| **key != name)
            .map(|(_, l)| l.bytes())
            .sum();
        ensure!(
            used + layer.bytes() <= 128 << 20,
            "Volume masks exceed the memory budget"
        );
        state.layers.insert(name, Arc::new(layer));
        Ok(())
    }
    pub fn close_layers(&mut self, name: &str, id: &str, series_revision: u64, revision: u32) {
        if let Some(state) = &mut self.volume
            && state.layers.get(name).is_some_and(|l| {
                l.series_id == id && l.series_revision == series_revision && l.revision == revision
            })
        {
            state.layers.remove(name);
            for slot in &mut state.stamps {
                if slot
                    .as_ref()
                    .is_some_and(|s| s.target == name && s.series == id)
                {
                    *slot = None;
                }
            }
            if state.dense_mask.matches_target(name, id) {
                state.dense_mask = super::layers::MaskTexture::empty(&self.device);
            }
        }
    }
    pub fn forget_series(&mut self, id: &str) {
        self.resident.forget(id);
        if let Some(state) = &mut self.volume {
            state.layers.retain(|_, layer| layer.series_id != id);
            for slot in &mut state.stamps {
                if slot.as_ref().is_some_and(|s| s.series == id) {
                    *slot = None;
                }
            }
            if state.dense_mask.matches_series(id) {
                state.dense_mask = super::layers::MaskTexture::empty(&self.device);
            }
        }
    }
    pub fn volume(&mut self, scene: &Scene, source: &SourceSeries) -> Result<FrameReady> {
        let s = &source.info;
        ensure!(
            s.can_reconstruct && s.components == 1,
            "Volume requires reconstructable scalar pixels"
        );
        ensure!(
            (0..3)
                .all(|a| scene.crop_min[a] <= scene.crop_max[a]
                    && scene.crop_max[a] < s.dimensions[a]),
            "Invalid crop"
        );
        ensure!(
            scene.ramp > 0.
                && scene.step > 0.
                && scene.index_step > 0.
                && scene
                    .inverse_vp
                    .iter()
                    .chain(scene.eye.iter())
                    .all(|v| (*v as f32).is_finite()),
            "Invalid volume view"
        );
        self.volume_state()?;
        let kind = self.resident_kind(source)?;
        let frame = FrameRequest {
            width: scene.width,
            height: scene.height,
            lease: scene.lease,
            bitmap: scene.bitmap,
            slot: scene.slot,
        };
        let mut target = self.target(&frame)?;
        let layers = self.layers(
            &scene.target,
            &scene.series_id,
            scene.revision,
            scene.layer_revision,
        )?;
        let state = self.volume.as_mut().unwrap();
        let atlas = self.atlas.as_mut().unwrap();
        let mask = layers.has_values();
        let dense_mask = kind != 0
            && mask
            && state.dense_mask.update(
                &self.device,
                &self.queue,
                s.dimensions,
                &scene.target,
                &layers,
            )?;
        let needs_tiles = kind == 0 || (mask && !dense_mask);
        let grid = Grid::new(s.origin, s.direction, s.spacing)?;
        let center = grid.index(scene.center).0;
        let mut matrix = [0f32; 16];
        for col in 0..3 {
            for row in 0..3 {
                matrix[col * 4 + row] = grid.inverse[row * 3 + col] as f32;
            }
        }
        for i in 0..3 {
            matrix[12 + i] = center[i] as f32;
        }
        matrix[15] = 1.;
        let eye = grid
            .index(PatientPoint(std::array::from_fn(|i| {
                scene.eye[i] + scene.center.0[i]
            })))
            .0;
        let crop = Box3 {
            lo: scene.crop_min,
            hi: scene.crop_max,
        };
        let mut leaves = Vec::new();
        if !needs_tiles {
            leaves.push(crop);
        } else {
            crop.leaves(s.dimensions, atlas.capacity, eye, &mut leaves)?;
        }
        let colors: Vec<_> = std::iter::once(0)
            .chain(layers.colors.iter().copied())
            .collect();
        let palette = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&colors),
                usage: wgpu::BufferUsages::STORAGE,
            });
        // Submit shorter raymarches on Windows so a full-screen volume does not monopolize the display driver.
        let pixels_per_dispatch = if cfg!(windows) { 32 * 1024 } else { 1 << 20 };
        let rows = (pixels_per_dispatch / scene.width).max(1).min(scene.height);
        // Hold a bounded group of bands so each atlas leaf is decoded and uploaded once per group.
        let band_bytes = u64::from(scene.width) * u64::from(rows) * 16;
        let bands_per_group = ((32 << 20) / band_bytes).max(1) as usize;
        let band_starts: Vec<_> = (0..scene.height).step_by(rows as usize).collect();
        let mut dispatches = 0;
        for starts in band_starts.chunks(bands_per_group) {
            let bands: Vec<_> = starts
                .iter()
                .map(|&y| {
                    let h = rows.min(scene.height - y);
                    let rect = [0, y, scene.width, h];
                    let accum = self.device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("Ray accumulation"),
                        size: u64::from(scene.width) * u64::from(h) * 16,
                        usage: wgpu::BufferUsages::STORAGE,
                        mapped_at_creation: false,
                    });
                    (rect, accum)
                })
                .collect();
            for leaf in &leaves {
                let b = if !needs_tiles {
                    Bounds {
                        first: [0; 3],
                        size: [0; 3],
                    }
                } else {
                    leaf.tiles(s.dimensions)
                };
                let table = atlas.tables(&self.queue, &[(source, b)])?;
                if mask && !dense_mask {
                    state.mask_tiles(&self.queue, scene, &layers, b, &table, s.dimensions);
                }
                let mut params = vec![0f32; 24];
                for i in 0..3 {
                    params[12 + i] = s.dimensions[i] as f32;
                    params[16 + i] = b.first[i] as f32;
                    params[20 + i] = b.size[i] as f32;
                }
                params[19] = kind as f32;
                params.extend(scene.inverse_vp.map(|n| n as f32));
                params.extend(matrix);
                let v4 = |v: Vector, w: f32| [v[0] as f32, v[1] as f32, v[2] as f32, w];
                params.extend(v4(scene.eye, 0.));
                for bounds in [crop, *leaf] {
                    params.extend(v4(bounds.lo.map(|n| n as f64 - 0.5), 0.));
                    params.extend(v4(bounds.hi.map(|n| n as f64 + 0.5), 0.));
                }
                params.extend([
                    scene.width as f32,
                    scene.height as f32,
                    scene.threshold as f32,
                    scene.ramp as f32,
                ]);
                params.extend([
                    scene.step as f32,
                    scene.index_step as f32,
                    0.,
                    if dense_mask {
                        2.
                    } else {
                        u32::from(mask) as f32
                    },
                ]);
                let pages = self
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: None,
                        contents: bytemuck::cast_slice(&table),
                        usage: wgpu::BufferUsages::STORAGE,
                    });
                for (rect, accum) in &bands {
                    let h = rect[3];
                    let mut params = params.clone();
                    params.extend(rect.map(f32::from_bits));
                    let uniforms =
                        self.device
                            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: None,
                                contents: bytemuck::cast_slice(&params),
                                usage: wgpu::BufferUsages::UNIFORM,
                            });
                    let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        label: None,
                        layout: &state.march.get_bind_group_layout(0),
                        entries: &[
                            bind(0, &uniforms),
                            bind(1, &atlas.buffer),
                            bind(2, &pages),
                            bind(3, &state.masks),
                            bind(4, &palette),
                            bind(5, accum),
                            wgpu::BindGroupEntry {
                                binding: 6,
                                resource: wgpu::BindingResource::TextureView(
                                    self.resident.bindings().0,
                                ),
                            },
                            bind(7, self.resident.bindings().1),
                            wgpu::BindGroupEntry {
                                binding: 8,
                                resource: wgpu::BindingResource::TextureView(
                                    &state.dense_mask.view,
                                ),
                            },
                        ],
                    });
                    let mut encoder = self.device.create_command_encoder(&Default::default());
                    {
                        let mut pass =
                            encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
                        pass.set_pipeline(&state.march);
                        pass.set_bind_group(0, &group, &[]);
                        pass.dispatch_workgroups(scene.width.div_ceil(8), h.div_ceil(8), 1);
                    }
                    let submission = self.queue.submit([encoder.finish()]);
                    dispatches += 1;
                    if dispatches % 4 == 0 {
                        self.device.poll(wgpu::PollType::Wait {
                            submission_index: Some(submission),
                            timeout: Some(std::time::Duration::from_secs(20)),
                        })?;
                    }
                }
            }
            for (rect, accum) in bands {
                let params = self
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: None,
                        contents: bytemuck::cast_slice(&rect),
                        usage: wgpu::BufferUsages::UNIFORM,
                    });
                let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &state.composite.get_bind_group_layout(0),
                    entries: &[bind(0, &params), bind(1, &accum)],
                });
                target.pass(&self.device, &self.queue, &state.composite, &group, rect)?;
            }
        }
        self.finish_target(target, &frame)
    }
}
