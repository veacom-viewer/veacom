use super::{
    ApiError, ApiResult, App, SourceSeries, assessment, frames, ok, pipe::Reply, plane_region,
    probe, sampling, source, sphere,
};
use serde::Deserialize;
use std::sync::{Arc, atomic::AtomicBool};

fn checked(core: &App, id: &str, revision: u64) -> ApiResult<Arc<SourceSeries>> {
    let series = source(core, id)?;
    if series.info.source_revision != revision {
        return Err(ApiError(409, "Source series changed".into()));
    }
    Ok(series)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SampleOperation {
    SourceRegion(sampling::Region),
    Sphere(sphere::Sphere),
    PlaneRegion(plane_region::PlaneRegion),
    #[cfg(any(target_os = "macos", windows))]
    Surface(crate::render::surgery::Touch),
    #[cfg(any(target_os = "macos", windows))]
    Selection(crate::render::surgery::Selection),
    Probe(probe::Probe),
    Ray(probe::Ray),
    Window(WindowRequest),
    Assessment {
        sets: Vec<assessment::PointSet>,
    },
}
#[derive(Deserialize)]
#[serde(untagged)]
enum WindowRequest {
    View(crate::window::Window),
    Volume(probe::WindowRequest),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OperationBody {
    Nested { operation: SampleOperation },
    Direct(SampleOperation),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SampleRequest {
    id: String,
    source_revision: u64,
    #[serde(flatten)]
    operation: OperationBody,
}

pub(super) fn sample(
    core: &App,
    cancelled: &AtomicBool,
    request: SampleRequest,
) -> ApiResult<Reply> {
    let _turn = core.samples.turn(cancelled)?;
    let series = checked(core, &request.id, request.source_revision)?;
    let pixels = |frame: Option<usize>| -> ApiResult<Arc<crate::model::PixelBuffer>> {
        if let Some(index) = frame {
            return Ok(frames::read(&series, index)?);
        }
        let (pixels, loaded) = super::load_volume(core, &request.id, false, cancelled)?;
        if loaded.info.source_revision != request.source_revision {
            return Err(ApiError(409, "Source series changed".into()));
        }
        Ok(pixels)
    };
    let (OperationBody::Nested { operation } | OperationBody::Direct(operation)) =
        request.operation;
    let reply = match operation {
        SampleOperation::SourceRegion(region) => {
            if region.points.len() > 10_000 {
                return Err(ApiError(400, "Too many region points".into()));
            }
            let pixels = pixels(region.plane.single_frame(&series)?)?;
            ok(&sampling::region(&series, &pixels, &region)?)
        }
        SampleOperation::PlaneRegion(region) => ok(&plane_region::measure(&series, &region)?),
        SampleOperation::Sphere(sphere) => ok(&sphere::measure(&series, &sphere)?),
        SampleOperation::Assessment { sets } => ok(&assessment::measure(&series, &sets)?),
        SampleOperation::Probe(q) => ok(&probe::probe(&series, &q)?),
        SampleOperation::Ray(q) => ok(&probe::ray(&series, &q)?),
        SampleOperation::Window(WindowRequest::Volume(q)) => ok(&probe::window(&series, &q)?),
        SampleOperation::Window(WindowRequest::View(q))
            if q.plane.is_none() && q.frame.is_none() =>
        {
            ok(&probe::window(
                &series,
                &probe::WindowRequest {
                    frame: q.frame,
                    full_range: !q.automatic,
                },
            )?)
        }
        SampleOperation::Window(WindowRequest::View(q)) => {
            let index = if let Some(frame) = &q.frame {
                frame.validate(&series)?;
                Some(frame.index)
            } else {
                None
            };
            let pixels = pixels(index)?;
            ok(&crate::window::calculate(&series, &pixels, &q)?)
        }
        #[cfg(any(target_os = "macos", windows))]
        SampleOperation::Selection(q) => {
            let layers = display::with_renderer(|r| {
                r.layers(
                    &q.target,
                    &request.id,
                    request.source_revision,
                    q.layer_revision,
                )
            })?;
            ok(&crate::render::surgery::selected(&series, &layers, &q)?)
        }
        #[cfg(any(target_os = "macos", windows))]
        SampleOperation::Surface(q) => {
            let layers = display::with_renderer(|r| {
                r.layers(
                    &q.target,
                    &request.id,
                    request.source_revision,
                    q.layer_revision,
                )
            })?;
            ok(&crate::render::surgery::touch(&series, &layers, &q)?)
        }
    }?;
    checked(core, &request.id, request.source_revision)?;
    Ok(reply)
}

#[cfg(any(target_os = "macos", windows))]
pub(super) use display::{LayerUploads, forget_series, render};

#[cfg(any(target_os = "macos", windows))]
mod display {
    use super::*;
    use crate::{Call, body, pipe, render};
    use anyhow::{Result, ensure};
    use serde_json::json;
    use std::{
        collections::{HashMap, VecDeque},
        sync::{LazyLock, Mutex, atomic::Ordering},
        time::{Duration, Instant},
    };

    static RENDERER: LazyLock<Mutex<Option<render::Renderer>>> = LazyLock::new(|| Mutex::new(None));
    type FusionLevels = VecDeque<(String, u64, f64)>;
    static FUSION_LEVELS: Mutex<FusionLevels> = Mutex::new(VecDeque::new());

    fn cached_factor(series: &SourceSeries) -> Option<f64> {
        FUSION_LEVELS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(id, rev, _)| id == &series.info.id && *rev == series.info.source_revision)
            .map(|entry| entry.2)
    }

    fn overlay_factor(core: &App, series: &SourceSeries, cancelled: &AtomicBool) -> ApiResult<f64> {
        if let Some(factor) = cached_factor(series) {
            return Ok(factor);
        }
        let _turn = core.samples.turn(cancelled)?;
        if let Some(factor) = cached_factor(series) {
            return Ok(factor);
        }
        let factor = render::image::fusion_factor(series, cancelled)?;
        checked(core, &series.info.id, series.info.source_revision)?;
        let mut levels = FUSION_LEVELS.lock().unwrap_or_else(|e| e.into_inner());
        if levels.len() == 32 {
            levels.pop_front();
        }
        levels.push_back((series.info.id.clone(), series.info.source_revision, factor));
        Ok(factor)
    }

    pub(crate) fn forget_series(id: &str) {
        FUSION_LEVELS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|e| e.0 != id);
        if let Ok(mut state) = RENDERER.lock()
            && let Some(renderer) = state.as_mut()
        {
            renderer.forget_series(id);
        }
    }

    pub(super) fn with_renderer<T>(
        work: impl FnOnce(&mut render::Renderer) -> Result<T>,
    ) -> Result<T> {
        let mut slot = RENDERER.lock().unwrap_or_else(|poison| {
            let mut slot = poison.into_inner();
            *slot = None;
            RENDERER.clear_poison();
            slot
        });
        if slot
            .as_ref()
            .is_some_and(|r| r.lost.load(Ordering::Acquire))
        {
            *slot = None;
        }
        if slot.is_none() {
            *slot = Some(render::Renderer::new()?);
        }
        work(slot.as_mut().unwrap())
    }

    #[derive(Deserialize)]
    struct Chunk {
        id: String,
        target: String,
        revision: u64,
        version: u32,
        offset: usize,
        total: usize,
    }
    struct Partial {
        id: String,
        revision: u64,
        version: u32,
        total: usize,
        bytes: Vec<u8>,
        last: Instant,
    }
    #[derive(Default)]
    pub(crate) struct LayerUploads(HashMap<String, Partial>);

    impl LayerUploads {
        fn append(&mut self, chunk: &Chunk, bytes: &[u8]) -> Result<Option<Vec<u8>>> {
            let now = Instant::now();
            self.0
                .retain(|_, part| now.duration_since(part.last) < Duration::from_secs(60));
            ensure!(
                chunk.total <= 64 << 20 && !bytes.is_empty() && bytes.len() <= 4 << 20,
                "Invalid mask upload"
            );
            ensure!(
                chunk
                    .offset
                    .checked_add(bytes.len())
                    .is_some_and(|end| end <= chunk.total),
                "Invalid mask offset"
            );
            if chunk.offset == 0 {
                if let Some(old) = self.0.get(&chunk.target) {
                    ensure!(
                        (chunk.revision, chunk.version) >= (old.revision, old.version),
                        "Mask version changed"
                    );
                }
                self.0.remove(&chunk.target);
                if bytes.len() == chunk.total {
                    return Ok(Some(bytes.to_vec()));
                }
                let reserved = self.0.values().map(|part| part.total).sum::<usize>();
                ensure!(
                    self.0.len() < 32 && reserved + chunk.total <= 64 << 20,
                    "Mask upload budget exceeded"
                );
                self.0.insert(
                    chunk.target.clone(),
                    Partial {
                        id: chunk.id.clone(),
                        revision: chunk.revision,
                        version: chunk.version,
                        total: chunk.total,
                        bytes: Vec::with_capacity(chunk.total),
                        last: now,
                    },
                );
            }
            let part = self
                .0
                .get_mut(&chunk.target)
                .ok_or_else(|| anyhow::anyhow!("Mask upload expired"))?;
            ensure!(
                part.id == chunk.id
                    && part.revision == chunk.revision
                    && part.version == chunk.version
                    && part.total == chunk.total
                    && part.bytes.len() == chunk.offset,
                "Mask upload changed"
            );
            part.last = now;
            part.bytes.extend_from_slice(bytes);
            if part.bytes.len() == part.total {
                return Ok(self.0.remove(&chunk.target).map(|part| part.bytes));
            }
            Ok(None)
        }
    }

    fn layers(core: &App, chunk: Chunk, bytes: &[u8]) -> ApiResult<Reply> {
        let name = chunk.target.strip_prefix("veacom-native-").and_then(|s| {
            let number = s.strip_suffix("-selection").unwrap_or(s);
            (!number.is_empty() && number.len() <= 12 && number.bytes().all(|c| c.is_ascii_digit()))
                .then_some(number)
        });
        if name.is_none() {
            return Err(ApiError(400, "Invalid volume target".into()));
        }
        let series = checked(core, &chunk.id, chunk.revision)?;
        let mut uploads = core.layer_uploads.lock().unwrap();
        if chunk.total == 0 {
            if chunk.offset != 0 || !bytes.is_empty() {
                return Err(ApiError(400, "Invalid empty mask".into()));
            }
            if uploads.0.get(&chunk.target).is_some_and(|partial| {
                partial.id == chunk.id
                    && partial.revision == chunk.revision
                    && partial.version == chunk.version
            }) {
                uploads.0.remove(&chunk.target);
            }
            drop(uploads);
            with_renderer(|r| {
                r.close_layers(&chunk.target, &chunk.id, chunk.revision, chunk.version);
                Ok(())
            })?;
        } else if let Some(full) = uploads.append(&chunk, bytes)? {
            drop(uploads);
            let voxels = series
                .info
                .dimensions
                .into_iter()
                .try_fold(1usize, usize::checked_mul)
                .ok_or_else(|| ApiError(400, "Invalid volume size".into()))?;
            checked(core, &chunk.id, chunk.revision)?;
            with_renderer(|r| {
                let layer = if full.get(..4) == Some(&2u32.to_le_bytes()) {
                    let previous = full
                        .get(4..8)
                        .ok_or_else(|| anyhow::anyhow!("Invalid mask patch header"))?;
                    let parent = u32::from_le_bytes(previous.try_into().unwrap());
                    r.layers(&chunk.target, &chunk.id, chunk.revision, parent)?
                        .patch(&full, voxels, chunk.version, chunk.revision, &chunk.id)?
                } else {
                    render::layers::Layers::read(
                        &full,
                        voxels,
                        chunk.version,
                        chunk.revision,
                        &chunk.id,
                    )?
                };
                r.set_layers(chunk.target, layer)
            })?;
        }
        ok(&json!({"version":chunk.version}))
    }

    fn frame_reply(mut frame: render::FrameReady) -> ApiResult<Reply> {
        let Some(bytes) = frame.rgba.take() else {
            return ok(&frame);
        };
        let json = serde_json::to_vec(&frame).map_err(anyhow::Error::from)?;
        Ok(Reply {
            status: 200,
            headers: vec![
                ("content-type", "application/vnd.veacom.rgba".into()),
                ("x-frame-info", crate::random::hex(&json)),
            ],
            body: Box::new(bytes),
        })
    }

    pub(crate) fn render(core: &App, request: &pipe::Request, call: Call) -> ApiResult<Reply> {
        if call.op == "renderMesh" {
            #[derive(Deserialize)]
            struct Mesh {
                id: String,
                #[serde(flatten)]
                mesh: render::stl::Request,
            }
            let Mesh { id, mesh } = body(call.body)?;
            let _turn = core.mesh.turn(request.abandoned())?;
            let series = checked(core, &id, mesh.revision)?;
            let layers =
                with_renderer(|r| r.layers(&mesh.target, &id, mesh.revision, mesh.layer_revision))?;
            let bytes = render::stl::extract(&series, &layers, &mesh, request.abandoned())?;
            checked(core, &id, mesh.revision)?;
            return Ok(Reply {
                status: 200,
                headers: vec![
                    ("content-type", "model/stl".into()),
                    ("cache-control", "no-store".into()),
                ],
                body: Box::new(bytes),
            });
        }
        if call.op == "renderView" {
            let mut view: render::image::View = body(call.body)?;
            let series = checked(core, &view.series_id, view.revision)?;
            let pet = view
                .fusion
                .as_ref()
                .map(|f| checked(core, &f.series_id, f.revision))
                .transpose()?;
            if let Some(other) = &pet
                && (other.info.frame_of_reference_uid.is_empty()
                    || other.info.frame_of_reference_uid != series.info.frame_of_reference_uid)
            {
                return Err(ApiError(
                    400,
                    "Fusion series have different coordinates".into(),
                ));
            }
            if let (Some(fusion), Some(overlay)) = (&mut view.fusion, &pet)
                && fusion.factor.is_none()
            {
                fusion.factor = Some(overlay_factor(core, overlay, request.abandoned())?);
            }
            let _turn = core.gpu.turn(request.abandoned())?;
            let frame = with_renderer(|r| r.image(&view, &series, pet.as_deref()))?;
            checked(core, &view.series_id, view.revision)?;
            if let Some(fusion) = view.fusion {
                checked(core, &fusion.series_id, fusion.revision)?;
            }
            return frame_reply(frame);
        }
        let _turn = core.gpu.turn(request.abandoned())?;
        match call.op.as_str() {
            "renderInfo" => ok(&with_renderer(|r| {
                Ok(json!({"renderer":r.adapter,"software":r.software}))
            })?),
            "renderPattern" => {
                let q = body(call.body)?;
                frame_reply(with_renderer(|r| r.pattern(&q))?)
            }
            "renderVolume" => {
                let scene: render::volume::Scene = body(call.body)?;
                let series = checked(core, &scene.series_id, scene.revision)?;
                let frame = with_renderer(|r| r.volume(&scene, &series))?;
                checked(core, &scene.series_id, scene.revision)?;
                frame_reply(frame)
            }
            "renderLayers" => layers(core, body(call.body)?, request.data()),
            _ => Err(ApiError(404, "Unknown rendering operation".into())),
        }
    }
}
