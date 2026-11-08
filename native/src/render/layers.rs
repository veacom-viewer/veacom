//! Immutable, sparse mask runs. A result identifies the input revision used for a draw.
use anyhow::{Result, ensure};

#[derive(Default, Clone)]
pub struct Layers {
    pub revision: u32,
    pub series_revision: u64,
    pub series_id: String,
    pub dirty: Option<(u32, Vec<u32>)>,
    mask: Vec<[u32; 3]>,
    labels: Vec<[u32; 3]>,
    pub colors: Vec<u32>,
}
impl Layers {
    // Little-endian words: version, color count / mask run count / label run count, then colors and triples.
    pub fn read(
        bytes: &[u8],
        voxels: usize,
        revision: u32,
        series_revision: u64,
        id: &str,
    ) -> Result<Self> {
        ensure!(
            bytes.len() >= 16 && bytes.len().is_multiple_of(4),
            "Invalid mask payload"
        );
        let mut words = bytes
            .chunks_exact(4)
            .map(|v| u32::from_le_bytes(v.try_into().unwrap()));
        ensure!(words.next() == Some(1), "Unknown mask format");
        let palette = words.next().unwrap() as usize;
        let masks = words.next().unwrap() as usize;
        let labels = words.next().unwrap() as usize;
        ensure!(
            palette <= 255
                && (masks + labels)
                    .checked_mul(3)
                    .and_then(|n| n.checked_add(palette))
                    == Some(words.len()),
            "Invalid mask lengths"
        );
        let colors: Vec<_> = words.by_ref().take(palette).collect();
        let mut runs = |n: usize, max: u32| -> Result<Vec<[u32; 3]>> {
            let mut result = Vec::with_capacity(n);
            let mut previous = 0;
            for _ in 0..n {
                let start = words.next().unwrap();
                let length = words.next().unwrap();
                let value = words.next().unwrap();
                let end = start
                    .checked_add(length)
                    .ok_or_else(|| anyhow::anyhow!("Mask run overflow"))?;
                ensure!(
                    start >= previous
                        && length > 0
                        && end as usize <= voxels
                        && value > 0
                        && value <= max,
                    "Invalid mask run"
                );
                result.push([start, end, value]);
                previous = end;
            }
            Ok(result)
        };
        let mask = runs(masks, 2)?;
        let labels = runs(labels, palette as u32)?;
        Ok(Self {
            revision,
            series_revision,
            series_id: id.into(),
            dirty: None,
            mask,
            labels,
            colors,
        })
    }
    pub fn patch(
        &self,
        bytes: &[u8],
        voxels: usize,
        version: u32,
        series_revision: u64,
        id: &str,
    ) -> Result<Self> {
        ensure!(
            bytes.len().is_multiple_of(4) && bytes.len() >= 12,
            "Invalid mask patch"
        );
        ensure!(
            self.revision == 0 || (self.series_id == id && self.series_revision == series_revision),
            "Mask source changed"
        );
        let mut words = bytes
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()));
        ensure!(
            words.next() == Some(2) && words.next() == Some(self.revision),
            "Mask patch base changed"
        );
        let count = words.next().unwrap() as usize;
        ensure!(
            count <= 2_000_000 && words.len() == count * 2 && version > self.revision,
            "Invalid mask patch length"
        );
        let mut mask = Vec::<[u32; 3]>::new();
        let mut emit = |lo: u32, hi: u32, value: u32| {
            if value == 0 || lo >= hi {
                return;
            }
            if let Some(last) = mask.last_mut()
                && last[1] == lo
                && last[2] == value
            {
                last[1] = hi;
            } else {
                mask.push([lo, hi, value]);
            }
        };
        let mut old = self.mask.iter().copied();
        let mut run = old.next();
        let mut dirty = Vec::with_capacity(count);
        while let Some(index) = words.next() {
            let value = words.next().unwrap();
            ensure!(
                (index as usize) < voxels
                    && index < u32::MAX
                    && value <= 2
                    && dirty.last().is_none_or(|n| *n < index),
                "Invalid mask patch voxel"
            );
            while let Some([lo, hi, val]) = run {
                if lo > index {
                    break;
                }
                if hi <= index {
                    emit(lo, hi, val);
                    run = old.next();
                    continue;
                }
                emit(lo, index, val);
                run = if index + 1 < hi {
                    Some([index + 1, hi, val])
                } else {
                    old.next()
                };
                break;
            }
            emit(index, index + 1, value);
            dirty.push(index);
        }
        for [lo, hi, value] in run.into_iter().chain(old) {
            emit(lo, hi, value);
        }
        Ok(Self {
            mask,
            labels: self.labels.clone(),
            colors: self.colors.clone(),
            series_id: id.into(),
            series_revision,
            revision: version,
            dirty: Some((self.revision, dirty)),
        })
    }
    pub fn mask_at(&self, index: usize) -> u32 {
        let at = self.mask.partition_point(|r| r[1] as usize <= index);
        self.mask
            .get(at)
            .filter(|r| r[0] as usize <= index)
            .map_or(0, |r| r[2])
    }
    pub fn bytes(&self) -> usize {
        (self.mask.len() + self.labels.len()) * 12
            + self.colors.len() * 4
            + self.dirty.as_ref().map_or(0, |(_, v)| v.len() * 4)
    }
    pub fn has_values(&self) -> bool {
        !self.mask.is_empty() || !self.labels.is_empty()
    }
    pub fn fill_row(&self, start: usize, row: &mut [u32]) {
        for (runs, shift) in [(&self.mask, 8), (&self.labels, 0)] {
            let at = runs.partition_point(|r| r[1] as usize <= start);
            for &[lo, hi, value] in &runs[at..] {
                if lo as usize >= start + row.len() {
                    break;
                }
                let end = (hi as usize - start).min(row.len());
                for cell in &mut row[(lo as usize).saturating_sub(start)..end] {
                    *cell |= value << shift;
                }
            }
        }
    }
}

pub(super) struct MaskTexture {
    texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    target: String,
    series: String,
    source_revision: u64,
    version: u32,
}

impl MaskTexture {
    fn allocate(device: &wgpu::Device, d: [usize; 3], target: &str, layers: &Layers) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Carving and segmentation volume"),
            size: wgpu::Extent3d {
                width: d[0] as u32,
                height: d[1] as u32,
                depth_or_array_layers: d[2] as u32,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::R16Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        Self {
            view: texture.create_view(&Default::default()),
            texture,
            target: target.into(),
            series: layers.series_id.clone(),
            source_revision: layers.series_revision,
            version: 0,
        }
    }
    pub fn empty(device: &wgpu::Device) -> Self {
        Self::allocate(device, [1; 3], "", &Layers::default())
    }
    pub fn matches_series(&self, id: &str) -> bool {
        self.series == id
    }
    pub fn matches_target(&self, target: &str, id: &str) -> bool {
        self.target == target && self.series == id
    }
    pub fn update(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        dims: [usize; 3],
        target: &str,
        layer: &Layers,
    ) -> Result<bool> {
        if dims
            .into_iter()
            .try_fold(2, usize::checked_mul)
            .is_none_or(|n| n > 512 << 20)
        {
            return Ok(false);
        }
        let same = self.matches_target(target, &layer.series_id)
            && self.source_revision == layer.series_revision;
        if same && self.version == layer.revision {
            return Ok(true);
        }
        let patch = layer
            .dirty
            .as_ref()
            .filter(|(base, _)| same && *base == self.version);
        if patch.is_none() {
            let errors = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
            let next = Self::allocate(device, dims, target, layer);
            if pollster::block_on(errors.pop()).is_some() {
                return Ok(false);
            }
            *self = next;
        }
        let [nx, ny, nz] = dims;
        let plane = nx * ny;
        let mut rectangles = vec![None::<[usize; 4]>; nz];
        let mut mark = |mut first: usize, end: usize| {
            while first < end {
                let z = first / plane;
                let stop = end.min((z + 1) * plane);
                let a = first % plane;
                let b = (stop - 1) % plane;
                let top = a / nx;
                let bottom = b / nx;
                let (left, right) = if top == bottom {
                    (a % nx, b % nx)
                } else {
                    (0, nx - 1)
                };
                let rect = rectangles[z].get_or_insert([left, top, right, bottom]);
                rect[0] = rect[0].min(left);
                rect[1] = rect[1].min(top);
                rect[2] = rect[2].max(right);
                rect[3] = rect[3].max(bottom);
                first = stop;
            }
        };
        if let Some((_, changes)) = patch {
            for &i in changes {
                mark(i as usize, i as usize + 1);
            }
        } else {
            for &[lo, hi, _] in layer.mask.iter().chain(&layer.labels) {
                mark(lo as usize, hi as usize);
            }
        }
        let mut words = Vec::<u16>::new();
        let mut row = Vec::<u32>::new();
        let mut staged = 0;
        for (z, rect) in rectangles.into_iter().enumerate() {
            let Some([left, top, right, bottom]) = rect else {
                continue;
            };
            let width = right + 1 - left;
            let height = bottom + 1 - top;
            row.resize(width, 0);
            words.clear();
            for y in top..=bottom {
                row.fill(0);
                layer.fill_row(z * plane + y * nx + left, &mut row);
                words.extend(row.iter().map(|v| *v as u16));
            }
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: left as u32,
                        y: top as u32,
                        z: z as u32,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                bytemuck::cast_slice(&words),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some((width * 2) as u32),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: width as u32,
                    height: height as u32,
                    depth_or_array_layers: 1,
                },
            );
            staged += words.len() * 2;
            if staged >= 32 << 20 {
                let index = queue.submit([]);
                device.poll(wgpu::PollType::Wait {
                    submission_index: Some(index),
                    timeout: Some(std::time::Duration::from_secs(15)),
                })?;
                staged = 0;
            }
        }
        self.version = layer.revision;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn words(words: &[u32]) -> Vec<u8> {
        words.iter().flat_map(|n| n.to_le_bytes()).collect()
    }

    #[test]
    fn patches_split_and_join_runs_and_preserve_labels() {
        // A mask at 2..7 and a label at voxel 3.
        let layers = Layers::read(
            &words(&[1, 1, 1, 1, 0xff8888, 2, 5, 1, 3, 1, 1]),
            10,
            1,
            6,
            "ct",
        )
        .unwrap();
        let patch = words(&[2, 1, 4, 0, 1, 1, 1, 4, 0, 6, 2]);
        let changed = layers.patch(&patch, 10, 2, 6, "ct").unwrap();
        assert_eq!(changed.mask, [[0, 4, 1], [5, 6, 1], [6, 7, 2]]);
        assert_eq!(changed.dirty, Some((1, vec![0, 1, 4, 6])));
        let mut row = [0; 10];
        changed.fill_row(0, &mut row);
        assert_eq!(row, [256, 256, 256, 257, 0, 256, 512, 0, 0, 0]);
        assert!(changed.patch(&patch, 10, 3, 6, "ct").is_err());
        assert!(layers.patch(&patch, 10, 2, 6, "pet").is_err());
        assert!(layers.patch(&patch, 10, 2, 7, "ct").is_err());
    }

    #[test]
    fn patch_requires_sorted_unique_in_range_changes() {
        let layers = Layers::default();
        for pair in [[3, 3], [4, 2], [2, 10]] {
            assert!(
                layers
                    .patch(&words(&[2, 0, 2, pair[0], 1, pair[1], 1]), 10, 1, 1, "ct")
                    .is_err()
            );
        }
        let first = layers
            .patch(&words(&[2, 0, 1, 3, 2]), 10, 1, 1, "ct")
            .unwrap();
        assert_eq!(first.mask_at(3), 2);
    }
}
