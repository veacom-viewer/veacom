use super::{
    FrameReady, FrameRequest, Renderer,
    atlas::{Atlas, Bounds},
};
use crate::{
    geometry::multiply,
    model::SourceSeries,
    sampling::{FrameRef, Grid, PatientPoint, Vector},
};
use anyhow::{Result, ensure};
use serde::Deserialize;
use wgpu::util::DeviceExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fusion {
    pub series_id: String,
    pub revision: u64,
    pub factor: Option<f64>,
    opacity: f64,
    upper: f64,
    palette: i32,
    classic: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    pub series_id: String,
    pub revision: u64,
    pub width: u32,
    pub height: u32,
    pub lease: u32,
    #[serde(default)]
    pub slot: Option<usize>,
    #[serde(default)]
    pub bitmap: bool,
    pub frame: Option<FrameRef>,
    top: PatientPoint,
    right: Vector,
    down: Vector,
    center: f64,
    width_value: f64,
    inverted: bool,
    palette: i32,
    #[serde(default)]
    curve: u32,
    #[serde(default)]
    log_curve_k: f32,
    voi_function: u32,
    voi_lut: Option<usize>,
    slab_mode: u32,
    slab_half: u32,
    slab_step: Vector,
    pub fusion: Option<Fusion>,
}

#[derive(Clone, Copy)]
struct Mapping {
    top: Vector,
    dx: Vector,
    dy: Vector,
    dims: [usize; 3],
    frame: Option<usize>,
    rgb: bool,
}
impl Mapping {
    fn new(view: &View, source: &SourceSeries, frame: Option<&FrameRef>) -> Result<Self> {
        let s = &source.info;
        let (grid, z) = if let Some(f) = frame {
            f.validate(source)?;
            let m = &source.frames[f.index].metadata;
            (Grid::new(m.origin, m.direction, m.spacing)?, Some(f.index))
        } else {
            ensure!(
                s.can_reconstruct && s.components == 1,
                "Reconstruction unavailable"
            );
            (Grid::new(s.origin, s.direction, s.spacing)?, None)
        };
        let mut top = grid.index(view.top).0;
        let mut dx = multiply(grid.inverse, view.right);
        let mut dy = multiply(grid.inverse, view.down);
        if let Some(z) = z {
            top[2] = z as f64;
            dx[2] = 0.;
            dy[2] = 0.;
        }
        ensure!(
            top.into_iter()
                .chain(dx)
                .chain(dy)
                .all(|v| (v as f32).is_finite()),
            "Invalid screen transform"
        );
        Ok(Self {
            top,
            dx,
            dy,
            dims: s.dimensions,
            frame: z,
            rgb: s.components == 3,
        })
    }
    fn bounds(self, rect: [u32; 4], half: u32, step: Vector) -> Bounds {
        let [x, y, w, h] = rect;
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for i in [x, x + w] {
            for j in [y, y + h] {
                for a in 0..3 {
                    let center = self.top[a] + self.dx[a] * i as f64 + self.dy[a] * j as f64;
                    let extent = f64::from(half) * step[a].abs();
                    lo[a] = lo[a].min(center - extent);
                    hi[a] = hi[a].max(center + extent);
                }
            }
        }
        let b = Bounds::of(lo, hi, self.dims);
        if let Some(index) = self.frame {
            b.frame(index)
        } else {
            b
        }
    }
    fn uniforms(self, b: Bounds, page: usize) -> [[f32; 4]; 6] {
        let vec = |v: Vector, w: f32| [v[0] as f32, v[1] as f32, v[2] as f32, w];
        [
            vec(self.top, page as f32),
            vec(self.dx, 0.),
            vec(self.dy, 0.),
            vec(
                self.dims.map(|n| n as f64),
                if self.rgb {
                    2.
                } else if self.frame.is_some() {
                    1.
                } else {
                    0.
                },
            ),
            vec(b.first.map(f64::from), 0.),
            vec(b.size.map(f64::from), 0.),
        ]
    }
}

pub fn fusion_factor(
    source: &SourceSeries,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<f64> {
    let s = &source.info;
    let [nx, ny, nz] = s.dimensions;
    let count = nx
        .checked_mul(ny)
        .and_then(|v| v.checked_mul(nz))
        .ok_or_else(|| anyhow::anyhow!("Invalid overlay dimensions"))?;
    ensure!(count > 0 && s.components == 1, "Invalid overlay");
    let mut values = Vec::new();
    let mut reader = crate::probe::Reader::new(source);
    for (sample, i) in (0..count).step_by((count / 500_000).max(1)).enumerate() {
        if sample % 1024 == 0 && cancelled.load(std::sync::atomic::Ordering::Acquire) {
            anyhow::bail!("Overlay sampling cancelled");
        }
        if let crate::probe::Sample::Value { value } =
            reader.at(i % nx, (i / nx) % ny, i / (nx * ny))?
            && value > 0.
        {
            values.push(value);
        }
    }
    values.sort_unstable_by(f64::total_cmp);
    let level = if values.is_empty() {
        1.
    } else {
        let at = 0.995 * (values.len() - 1) as f64;
        values[at.floor() as usize] * (1. - at.fract()) + values[at.ceil() as usize] * at.fract()
    };
    let factor = 5. / level;
    ensure!(factor.is_finite(), "Invalid overlay intensity");
    Ok(factor)
}

impl Renderer {
    pub fn image(
        &mut self,
        view: &View,
        source: &SourceSeries,
        pet: Option<&SourceSeries>,
    ) -> Result<FrameReady> {
        ensure!(
            view.curve <= 2
                && (view.curve != 2 || (view.log_curve_k.is_finite() && view.log_curve_k > 0.))
                && view.slab_half <= 2048
                && view.slab_mode <= 3
                && view.center.is_finite()
                && view.width_value.is_finite()
                && view.slab_step.iter().all(|v| (*v as f32).is_finite()),
            "Invalid display parameters"
        );
        let base = Mapping::new(view, source, view.frame.as_ref())?;
        let overlay = pet.map(|s| Mapping::new(view, s, None)).transpose()?;
        if let Some(f) = &view.fusion {
            ensure!(
                f.opacity.is_finite()
                    && (0.0..=1.0).contains(&f.opacity)
                    && f.upper > 0.
                    && f.factor.is_none_or(|v| v.is_finite() && v > 0.),
                "Invalid fusion settings"
            );
        }
        let fusion_factor = view.fusion.as_ref().and_then(|f| f.factor).unwrap_or(0.);
        let frame = FrameRequest {
            width: view.width,
            height: view.height,
            lease: view.lease,
            bitmap: view.bitmap,
            slot: view.slot,
        };
        let kind = if view.frame.is_none() {
            self.resident_kind(source)?
        } else {
            0
        };
        let mut target = self.target(&frame)?;
        let atlas = self.atlas.get_or_insert_with(|| Atlas::new(&self.device));
        let lut = view
            .voi_lut
            .and_then(|i| source.info.voi_luts.get(i))
            .filter(|_| view.frame.is_some());
        let entries = lut.map_or_else(
            || vec![0],
            |l| l.data.iter().copied().map(u32::from).collect(),
        );
        let lut_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("VOI LUT"),
                contents: bytemuck::cast_slice(&entries),
                usage: wgpu::BufferUsages::STORAGE,
            });
        let mut rects = vec![[0, 0, view.width, view.height]];
        while let Some(rect) = rects.pop() {
            let b = if kind == 0 {
                base.bounds(rect, view.slab_half, view.slab_step)
            } else {
                Bounds {
                    first: [0; 3],
                    size: [0; 3],
                }
            };
            let overlay_bounds = overlay.map(|m| m.bounds(rect, 0, [0.; 3]));
            if b.count()
                .saturating_add(overlay_bounds.map_or(0, Bounds::count))
                > atlas.capacity
            {
                let axis = usize::from(rect[3] > rect[2]);
                let length = rect[axis + 2];
                ensure!(length > 1, "View ray exceeds GPU tile budget");
                let mut first = rect;
                first[axis + 2] = length / 2;
                let mut second = rect;
                second[axis] += first[axis + 2];
                second[axis + 2] -= first[axis + 2];
                rects.extend([second, first]);
                continue;
            }
            let mut layers = vec![(source, b)];
            if let (Some(pet), Some(ob)) = (pet, overlay_bounds) {
                layers.push((pet, ob));
            }
            let pages = atlas.tables(&self.queue, &layers)?;
            let mut params = Vec::<[f32; 4]>::with_capacity(17);
            params.extend(base.uniforms(b, 0));
            params[4][3] = kind as f32;
            params.extend(
                overlay
                    .zip(overlay_bounds)
                    .map_or([[0.; 4]; 6], |(m, b2)| m.uniforms(b2, b.count())),
            );
            params.push([
                view.center as f32,
                view.width_value as f32,
                (view.inverted != (source.info.photometric_interpretation == "MONOCHROME1")) as u32
                    as f32,
                view.palette as f32,
            ]);
            params.push([
                view.slab_step[0] as f32,
                view.slab_step[1] as f32,
                view.slab_step[2] as f32,
                view.slab_mode as f32,
            ]);
            params.push([
                view.slab_half as f32,
                view.voi_function as f32,
                lut.map_or(0., |l| l.first as f32),
                lut.map_or(1., |l| ((1u32 << l.bits) - 1) as f32),
            ]);
            let f = view.fusion.as_ref();
            params.push([
                lut.map_or(0., |l| l.data.len() as f32),
                fusion_factor as f32,
                f.map_or(0., |v| v.opacity as f32),
                f.map_or(1., |v| v.upper as f32),
            ]);
            params.push([
                f.map_or(0., |v| v.palette as f32),
                f.is_some_and(|v| v.classic) as u32 as f32,
                view.curve as f32,
                view.log_curve_k,
            ]);
            let table = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Viewport page table"),
                    contents: bytemuck::cast_slice(&pages),
                    usage: wgpu::BufferUsages::STORAGE,
                });
            let uniforms = self
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("View transform"),
                    contents: bytemuck::cast_slice(&params),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.image_pipeline.get_bind_group_layout(0),
                entries: &[
                    bind(0, &uniforms),
                    bind(1, &atlas.buffer),
                    bind(2, &table),
                    bind(3, &lut_buffer),
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: wgpu::BindingResource::TextureView(self.resident.bindings().0),
                    },
                    bind(7, self.resident.bindings().1),
                ],
            });
            target.pass(
                &self.device,
                &self.queue,
                &self.image_pipeline,
                &group,
                rect,
            )?;
        }
        self.finish_target(target, &frame)
    }
}
pub fn bind(index: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding: index,
        resource: buffer.as_entire_binding(),
    }
}
