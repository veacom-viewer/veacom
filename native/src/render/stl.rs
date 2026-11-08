//! Binary STL in patient LPS millimetres. March the density and removal fields separately
//! so a burr cuts halfway between voxel centres without changing the stored intensities.
use super::{layers::Layers, surgery::Crop};
use crate::{
    frames,
    geometry::{cross, dot, norm, sub},
    model::SourceSeries,
    sampling::{Grid, Vector, VoxelPoint},
};
use anyhow::{Result, ensure};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub target: String,
    pub layer_revision: u32,
    pub revision: u64,
    pub threshold: f64,
    pub crop: Crop,
}
#[derive(Clone, Copy, Default)]
struct Vertex {
    point: Vector,
    fields: [f64; 2],
}
fn between(a: Vertex, b: Vertex, field: usize, level: f64) -> Vertex {
    let t = (level - a.fields[field]) / (b.fields[field] - a.fields[field]);
    Vertex {
        point: std::array::from_fn(|i| a.point[i] + (b.point[i] - a.point[i]) * t),
        fields: std::array::from_fn(|i| a.fields[i] + (b.fields[i] - a.fields[i]) * t),
    }
}
const CORNERS: [[usize; 3]; 8] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
];
const TETS: [[usize; 4]; 6] = [
    [0, 5, 1, 6],
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
];
struct Mesh {
    bytes: Vec<u8>,
    count: u32,
}
impl Mesh {
    fn triangle(&mut self, a: Vector, mut b: Vector, mut c: Vector, outward: Vector) -> Result<()> {
        let mut normal = cross(sub(b, a), sub(c, a));
        let length = norm(normal);
        if length < 1e-12 {
            return Ok(());
        }
        if dot(normal, outward) < 0. {
            std::mem::swap(&mut b, &mut c);
            normal = normal.map(|v| -v);
        }
        ensure!(self.count < 2_000_000, "STL exceeds two million triangles");
        for point in [normal.map(|v| v / length), a, b, c] {
            for value in point {
                let f = value as f32;
                ensure!(f.is_finite(), "Coordinate exceeds STL precision");
                self.bytes.extend_from_slice(&f.to_le_bytes());
            }
        }
        self.bytes.extend_from_slice(&[0, 0]);
        self.count += 1;
        Ok(())
    }
    fn contour(&mut self, tetra: [Vertex; 4], field: usize, levels: [f64; 2]) -> Result<()> {
        let (inside, outside): (Vec<_>, Vec<_>) = tetra
            .into_iter()
            .partition(|v| v.fields[field] >= levels[field]);
        if inside.is_empty() || outside.is_empty() {
            return Ok(());
        }
        let mean = |v: &[Vertex]| -> Vector {
            std::array::from_fn(|i| v.iter().map(|v| v.point[i]).sum::<f64>() / v.len() as f64)
        };
        let outward = sub(mean(&outside), mean(&inside));
        let edge = |a, b| between(a, b, field, levels[field]);
        let face: Vec<_> = if inside.len() == 1 {
            outside.iter().map(|b| edge(inside[0], *b)).collect()
        } else if outside.len() == 1 {
            inside.iter().map(|b| edge(outside[0], *b)).collect()
        } else {
            vec![
                edge(inside[0], outside[0]),
                edge(inside[0], outside[1]),
                edge(inside[1], outside[1]),
                edge(inside[1], outside[0]),
            ]
        };
        let other = 1 - field;
        let mut clipped = Vec::with_capacity(6);
        for i in 0..face.len() {
            let a = face[i];
            let b = face[(i + 1) % face.len()];
            let keep = a.fields[other] >= levels[other];
            if keep {
                clipped.push(a);
            }
            if keep != (b.fields[other] >= levels[other]) {
                clipped.push(between(a, b, other, levels[other]));
            }
        }
        for i in 2..clipped.len() {
            self.triangle(
                clipped[0].point,
                clipped[i - 1].point,
                clipped[i].point,
                outward,
            )?;
        }
        Ok(())
    }
}
pub fn extract(
    source: &SourceSeries,
    layers: &Layers,
    request: &Request,
    cancel: &AtomicBool,
) -> Result<Vec<u8>> {
    request.crop.validate(source)?;
    ensure!(
        source.info.can_reconstruct && source.info.components == 1 && request.threshold.is_finite(),
        "Invalid STL source"
    );
    let s = &source.info;
    let grid = Grid::new(s.origin, s.direction, s.spacing)?;
    let mut mesh = Mesh {
        bytes: vec![0; 84],
        count: 0,
    };
    let title = b"VEAcom isosurface; patient LPS mm; crop/padding boundaries may be open";
    mesh.bytes[..title.len()].copy_from_slice(title);
    let [nx, ny, _] = s.dimensions;
    let min = request.crop.min;
    let max = request.crop.max;
    let levels = [request.threshold, 0.5];
    for z in min[2]..max[2] {
        let planes = [frames::read(source, z)?, frames::read(source, z + 1)?];
        ensure!(
            planes.iter().all(|p| p.len() == nx * ny),
            "Incomplete scalar frame"
        );
        for y in min[1]..max[1] {
            ensure!(!cancel.load(Ordering::Relaxed), "STL export cancelled");
            'cube: for x in min[0]..max[0] {
                let mut verts = [Vertex::default(); 8];
                let mut above = 0;
                let mut kept = 0;
                for (i, [dx, dy, dz]) in CORNERS.into_iter().enumerate() {
                    let local = (y + dy) * nx + x + dx;
                    let flat = (z + dz) * nx * ny + local;
                    let plane = &planes[dz];
                    let scalar = plane.value(local);
                    if !scalar.is_finite() || plane.is_padding(source, z + dz, scalar) {
                        continue 'cube;
                    }
                    let live = layers.mask_at(flat) == 0;
                    kept += usize::from(live);
                    above += usize::from(scalar >= levels[0]);
                    verts[i].fields = [scalar, if live { 1. } else { 0. }];
                }
                if above == 0 || kept == 0 || (above == 8 && kept == 8) {
                    continue;
                }
                for (i, [dx, dy, dz]) in CORNERS.into_iter().enumerate() {
                    verts[i].point = grid
                        .world(VoxelPoint([
                            (x + dx) as f64,
                            (y + dy) as f64,
                            (z + dz) as f64,
                        ]))
                        .0;
                }
                for t in TETS {
                    let tet = t.map(|i| verts[i]);
                    if above != 8 {
                        mesh.contour(tet, 0, levels)?;
                    }
                    if kept != 8 {
                        mesh.contour(tet, 1, levels)?;
                    }
                }
            }
        }
    }
    mesh.bytes[80..84].copy_from_slice(&mesh.count.to_le_bytes());
    Ok(mesh.bytes)
}
