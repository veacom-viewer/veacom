//! A shared, bounded GPU cache of 16×16 tiles, one source frame deep.
//! Both source and reconstructed views address the same tiles. A table covers only the current draw.
use crate::{
    model::{PixelBuffer, SourceSeries},
    sampling::Vector,
};
use anyhow::{Result, ensure};
use std::{collections::HashMap, sync::Arc};

// Two strips across a 512 × 1,000 coronal plane fit in the 64 MiB atlas, including interpolation at a tile boundary.
pub const EDGE: usize = 16;
const TILE: usize = EDGE * EDGE;

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    revision: u64,
    id: Arc<str>,
    x: u32,
    y: u32,
    z: u32,
}
struct Slot {
    key: Key,
    touched: u64,
}
#[derive(Clone, Copy)]
pub struct Bounds {
    pub first: [u32; 3],
    pub size: [u32; 3],
}
impl Bounds {
    pub fn count(self) -> usize {
        self.size
            .into_iter()
            .fold(1usize, |n, v| n.saturating_mul(v as usize))
    }
    pub fn of(low: Vector, high: Vector, dimensions: [usize; 3]) -> Self {
        let mut first = [0; 3];
        let mut size = [0; 3];
        for a in 0..3 {
            // One voxel either side contains the trilinear interpolation halo.
            if low[a] > dimensions[a] as f64 - 0.5 || high[a] < -0.5 {
                return Self {
                    first,
                    size: [0; 3],
                };
            }
            let stride = if a == 2 { 1 } else { EDGE };
            first[a] = (low[a].floor().max(0.) as usize / stride) as u32;
            let end = (high[a].ceil().max(0.) as usize).min(dimensions[a] - 1) / stride;
            size[a] = (end + 1).saturating_sub(first[a] as usize) as u32;
        }
        Self { first, size }
    }
    pub fn frame(mut self, index: usize) -> Self {
        if self.count() != 0 {
            self.first[2] = index as u32;
            self.size[2] = 1;
        }
        self
    }
}
pub struct Atlas {
    pub buffer: wgpu::Buffer,
    pub capacity: usize,
    slots: Vec<Slot>,
    lookup: HashMap<Key, usize>,
    epoch: u64,
}

// Adjacent physical slots share a staging write. Flush on errors too: slots already indexed stay valid.
struct TileUpload<'a> {
    queue: &'a wgpu::Queue,
    buffer: &'a wgpu::Buffer,
    first: usize,
    words: Vec<u32>,
}
impl TileUpload<'_> {
    fn flush(&mut self) {
        if !self.words.is_empty() {
            self.queue.write_buffer(
                self.buffer,
                (self.first * TILE * 4) as u64,
                bytemuck::cast_slice(&self.words),
            );
            self.words.clear();
        }
    }
    fn push(&mut self, slot: usize, tile: &[u32]) {
        if self.first + self.words.len() / TILE != slot || self.words.len() * 4 >= 1 << 20 {
            self.flush();
        }
        if self.words.is_empty() {
            self.first = slot;
        }
        self.words.extend_from_slice(tile);
    }
}
impl Drop for TileUpload<'_> {
    fn drop(&mut self) {
        self.flush();
    }
}

impl Atlas {
    pub fn new(device: &wgpu::Device) -> Self {
        let budget = (64u64 << 20).min(u64::from(device.limits().max_storage_buffer_binding_size));
        let capacity = budget as usize / (4 * TILE);
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Shared voxel tiles"),
            size: (capacity * 4 * TILE) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Self {
            buffer,
            capacity,
            slots: Vec::new(),
            lookup: HashMap::new(),
            epoch: 0,
        }
    }
    pub fn tables(
        &mut self,
        queue: &wgpu::Queue,
        layers: &[(&SourceSeries, Bounds)],
    ) -> Result<Vec<u32>> {
        self.epoch += 1;
        let mut keys = Vec::new();
        let mut missing = 0usize;
        let mut ranges = Vec::new();
        for (s, b) in layers {
            let id: Arc<str> = s.info.id.as_str().into();
            let at = keys.len();
            for z in b.first[2]..b.first[2] + b.size[2] {
                for y in b.first[1]..b.first[1] + b.size[1] {
                    for x in b.first[0]..b.first[0] + b.size[0] {
                        let key = Key {
                            revision: s.info.source_revision,
                            id: id.clone(),
                            x,
                            y,
                            z,
                        };
                        if let Some(slot) = self.lookup.get(&key) {
                            self.slots[*slot].touched = self.epoch;
                        } else {
                            missing += 1;
                        }
                        keys.push(key);
                    }
                }
            }
            ranges.push(at..keys.len());
        }
        ensure!(
            keys.len() <= self.capacity,
            "Viewport tile exceeds the GPU memory budget"
        );
        let take = missing.saturating_sub(self.capacity - self.slots.len());
        let mut evict = Vec::new();
        if take > 0 {
            evict.extend(
                self.slots
                    .iter()
                    .enumerate()
                    .filter(|(_, slot)| slot.touched != self.epoch)
                    .map(|(n, slot)| (slot.touched, n)),
            );
            evict.sort_unstable();
            evict.truncate(take);
            evict.sort_unstable_by_key(|(_, slot)| std::cmp::Reverse(*slot));
        }
        let mut upload = TileUpload {
            queue,
            buffer: &self.buffer,
            first: 0,
            words: Vec::new(),
        };
        let mut table = Vec::with_capacity(keys.len().max(1));
        let mut tile = vec![0u32; TILE];
        for ((s, _), range) in layers.iter().zip(ranges) {
            let [nx, ny, _] = s.info.dimensions;
            let mut frame: Option<(u32, Arc<PixelBuffer>)> = None;
            for key in &keys[range] {
                if let Some(&slot) = self.lookup.get(key) {
                    table.push(slot as u32 + 1);
                    continue;
                }
                if frame.as_ref().is_none_or(|(z, _)| *z != key.z) {
                    frame = Some((key.z, crate::frames::read(s, key.z as usize)?));
                }
                let pixels = &frame.as_ref().unwrap().1;
                let bx = key.x as usize * EDGE;
                let by = key.y as usize * EDGE;
                for y in 0..EDGE.min(ny - by) {
                    for x in 0..EDGE.min(nx - bx) {
                        let at = (by + y) * nx + bx + x;
                        tile[y * EDGE + x] = if s.info.components == 3 {
                            ((pixels.value(at * 3) as u32) << 16)
                                | ((pixels.value(at * 3 + 1) as u32) << 8)
                                | pixels.value(at * 3 + 2) as u32
                        } else {
                            let v = pixels.value(at);
                            if pixels.is_padding(s, key.z as usize, v) {
                                f32::NAN.to_bits()
                            } else {
                                let displayed = v as f32;
                                ensure!(
                                    !v.is_finite() || displayed.is_finite(),
                                    "Pixel value exceeds the GPU display range"
                                );
                                displayed.to_bits()
                            }
                        };
                    }
                }
                let slot = if self.slots.len() < self.capacity {
                    self.slots.push(Slot {
                        key: key.clone(),
                        touched: self.epoch,
                    });
                    self.slots.len() - 1
                } else {
                    let (_, n) = evict
                        .pop()
                        .ok_or_else(|| anyhow::anyhow!("No available GPU tile"))?;
                    self.lookup.remove(&self.slots[n].key);
                    self.slots[n] = Slot {
                        key: key.clone(),
                        touched: self.epoch,
                    };
                    n
                };
                self.lookup.insert(key.clone(), slot);
                upload.push(slot, &tile);
                table.push(slot as u32 + 1);
            }
        }
        if table.is_empty() {
            table.push(0);
        }
        Ok(table)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_interpolated_coronal_plane_fits_the_cache_on_a_thousand_frame_ct() {
        let bounds = Bounds::of([0., 255.5, 0.], [511., 256.5, 999.], [512, 512, 1000]);
        assert!(bounds.count() * TILE * 4 <= 64 << 20);
        assert!(include_str!("voxels.wgsl").contains(&format!("const tileEdge: u32 = {EDGE}u;")));
    }
}
