//! Typed Engine-Presenter command/event contract and bounded surface-lease state machine.
//!
//! Implements the control-channel contract and producer/consumer synchronization rules specified in
//! `docs/native-renderer-decision.md` without pulling in GPU or platform-window dependencies yet.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Opaque identifier of a leased presentation surface held by the presenter and its consumers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SurfaceLeaseId(pub u64);

/// Target slice or reconstructed plane requested for a viewport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ViewTarget {
    /// Acquired DICOM frame identified by stable engine frame ID.
    SourceFrame { frame_id: String },
    /// Reconstructed plane in patient LPS millimeters.
    PlaneLps {
        origin: [f64; 3],
        right: [f64; 3],
        down: [f64; 3],
        normal: [f64; 3],
    },
}

/// Window, palette, and presentation transform for a viewport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayParams {
    pub window_center: f64,
    pub window_width: f64,
    pub inverted: bool,
    pub palette: String,
    pub zoom: f64,
    pub pan: [f64; 2],
    pub rotation_deg: f64,
    pub flip_x: bool,
    pub flip_y: bool,
}

/// Thick-slab projection settings in patient millimeters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlabParams {
    pub mode: String,
    pub thickness_mm: f64,
}

/// Overlay fusion parameters referencing a secondary series revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FusionParams {
    pub overlay_source_revision: u64,
    pub opacity: f64,
    pub upper_value: f64,
    pub palette: String,
    pub blend: String,
}

/// Exact quantitative sampling strategy for clinical measurements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExactSamplingMethod {
    /// Sample exact stored pixels on an acquired source frame.
    SourceFrameExact,
    /// Sample exact trilinear interpolation in full-resolution patient space.
    VolumePatientSpaceExact,
}

/// Surgery mask editing operation expressed in patient LPS millimeters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MaskOperation {
    CarveSphere {
        center_lps: [f64; 3],
        radius_mm: f64,
    },
    RestoreRegion {
        min_lps: [f64; 3],
        max_lps: [f64; 3],
    },
    Undo,
}

/// Viewport state payload carried by [`Command::SetView`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetViewCommand {
    pub viewport_id: String,
    pub source_revision: u64,
    pub view_revision: u64,
    pub target: ViewTarget,
    pub display: DisplayParams,
    pub slab: Option<SlabParams>,
    pub fusion: Option<FusionParams>,
}

/// Typed commands crossing from the UI shell to the imaging engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    OpenStudy {
        paths: Vec<String>,
        request_id: u64,
    },
    SetView(Box<SetViewCommand>),
    Measure {
        source_revision: u64,
        roi_lps: Vec<[f64; 3]>,
        exact_sampling_method: ExactSamplingMethod,
    },
    EditMask {
        mask_revision: u64,
        operation_in_patient_space: MaskOperation,
    },
    Pick {
        frame_id: u64,
        viewport_pixel: [f64; 2],
    },
    ReleaseFrame {
        surface_lease: SurfaceLeaseId,
    },
}

/// Presentation texture pixel format reported in `FrameReady`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PixelFormat {
    Rgba8Unorm,
    Bgra8Unorm,
    Rgba16Float,
}

/// Presentation color space reported in `FrameReady`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColorSpace {
    Srgb,
    DisplayP3,
    GrayLinear,
}

/// Explicit missing-data coverage disclosure; missing voxels are never reported as complete anatomy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Coverage {
    Complete,
    Partial,
    Unavailable,
}

/// Explicit display resolution level disclosure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DisplayLevel {
    Full,
    Downsampled { stride: [u32; 3] },
}

/// Reason a rendered frame was discarded instead of published.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DropReason {
    Superseded,
    NoFreeSurface,
    ViewportClosed,
}

/// Typed events emitted from the imaging engine to the presenter and UI shell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    FrameReady {
        viewport_id: String,
        frame_id: u64,
        source_revision: u64,
        view_revision: u64,
        surface_lease: SurfaceLeaseId,
        dimensions: [u32; 2],
        format: PixelFormat,
        color_space: ColorSpace,
        coverage: Coverage,
        display_level: DisplayLevel,
    },
    FrameDropped {
        viewport_id: String,
        view_revision: u64,
        reason: DropReason,
    },
    PickResult {
        frame_id: u64,
        source_revision: u64,
        view_revision: u64,
        patient_lps: Option<[f64; 3]>,
        coverage: Coverage,
    },
}

/// Separate frame lifecycle milestones as required by `docs/native-renderer-decision.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FrameMilestones {
    pub gpu_completed_ns: Option<u64>,
    pub delivered_to_compositor_ns: Option<u64>,
    pub screen_observed_ns: Option<u64>,
}

/// Immutable published frame metadata kept while a surface lease is held so `Pick` binds to the displayed revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedFrame {
    pub frame_id: u64,
    pub source_revision: u64,
    pub view_revision: u64,
    pub surface_lease: SurfaceLeaseId,
    pub dimensions: [u32; 2],
    pub coverage: Coverage,
    pub display_level: DisplayLevel,
    pub milestones: FrameMilestones,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SlotState {
    Free,
    InFlight {
        source_revision: u64,
        view_revision: u64,
    },
    Leased {
        frame_id: u64,
        lease_id: SurfaceLeaseId,
        consumer_refs: usize,
    },
}

/// Bounded 2- or 3-surface lease queue for a single viewport.
///
/// Guarantees:
/// - No surface is reused before producer GPU completion and all consumer `ReleaseFrame` acknowledgments.
/// - Stale unpublished renders whose `view_revision` was superseded are discarded cleanly.
/// - Published frames keep immutable `(frame_id, source_revision, view_revision)` records for exact `Pick` binding.
#[derive(Debug)]
pub struct SurfaceLeasePool {
    viewport_id: String,
    slots: Vec<SlotState>,
    next_frame_id: u64,
    next_lease_id: u64,
    latest_requested_view: u64,
    latest_published_view: u64,
    published: HashMap<u64, PublishedFrame>,
    lease_to_slot: HashMap<SurfaceLeaseId, usize>,
}

impl SurfaceLeasePool {
    /// Creates a bounded surface pool with 2 (double-buffered) or 3 (triple-buffered) slots.
    pub fn new(viewport_id: impl Into<String>, capacity: usize) -> Result<Self, &'static str> {
        if !(2..=3).contains(&capacity) {
            return Err("surface lease pool capacity must be 2 or 3");
        }
        Ok(Self {
            viewport_id: viewport_id.into(),
            slots: vec![SlotState::Free; capacity],
            next_frame_id: 1,
            next_lease_id: 1,
            latest_requested_view: 0,
            latest_published_view: 0,
            published: HashMap::new(),
            lease_to_slot: HashMap::new(),
        })
    }

    pub fn viewport_id(&self) -> &str {
        &self.viewport_id
    }

    pub fn capacity(&self) -> usize {
        self.slots.len()
    }

    pub fn free_slots(&self) -> usize {
        self.slots
            .iter()
            .filter(|slot| matches!(slot, SlotState::Free))
            .count()
    }

    /// Reserves a free surface slot for producer GPU rendering of `(source_revision, view_revision)`.
    ///
    /// Returns `Ok(slot_index)` when a free slot is available, or `Err(Event::FrameDropped)` if all slots
    /// are busy or if `view_revision` is already older than the newest requested revision.
    pub fn begin_render(
        &mut self,
        source_revision: u64,
        view_revision: u64,
    ) -> Result<usize, Event> {
        if view_revision < self.latest_requested_view {
            return Err(Event::FrameDropped {
                viewport_id: self.viewport_id.clone(),
                view_revision,
                reason: DropReason::Superseded,
            });
        }
        self.latest_requested_view = view_revision;

        let Some(slot_index) = self
            .slots
            .iter()
            .position(|slot| matches!(slot, SlotState::Free))
        else {
            return Err(Event::FrameDropped {
                viewport_id: self.viewport_id.clone(),
                view_revision,
                reason: DropReason::NoFreeSurface,
            });
        };
        self.slots[slot_index] = SlotState::InFlight {
            source_revision,
            view_revision,
        };
        Ok(slot_index)
    }

    /// Marks producer GPU completion for `slot_index`.
    ///
    /// If a newer `view_revision` has already been requested or published, the completed surface is
    /// discarded immediately and returned to `Free` with `Event::FrameDropped(Superseded)`.
    #[allow(
        clippy::too_many_arguments,
        reason = "explicit presentation metadata avoids a throwaway wrapper struct"
    )]
    pub fn complete_gpu_render(
        &mut self,
        slot_index: usize,
        dimensions: [u32; 2],
        format: PixelFormat,
        color_space: ColorSpace,
        coverage: Coverage,
        display_level: DisplayLevel,
        gpu_completed_ns: u64,
    ) -> Option<Event> {
        let SlotState::InFlight {
            source_revision,
            view_revision,
        } = *self.slots.get(slot_index)?
        else {
            return None;
        };

        if view_revision < self.latest_requested_view || view_revision < self.latest_published_view
        {
            self.slots[slot_index] = SlotState::Free;
            return Some(Event::FrameDropped {
                viewport_id: self.viewport_id.clone(),
                view_revision,
                reason: DropReason::Superseded,
            });
        }

        let frame_id = self.next_frame_id;
        self.next_frame_id += 1;
        let lease_id = SurfaceLeaseId(self.next_lease_id);
        self.next_lease_id += 1;
        self.latest_published_view = view_revision;

        self.slots[slot_index] = SlotState::Leased {
            frame_id,
            lease_id,
            consumer_refs: 1,
        };
        self.lease_to_slot.insert(lease_id, slot_index);
        self.published.insert(
            frame_id,
            PublishedFrame {
                frame_id,
                source_revision,
                view_revision,
                surface_lease: lease_id,
                dimensions,
                coverage,
                display_level,
                milestones: FrameMilestones {
                    gpu_completed_ns: Some(gpu_completed_ns),
                    delivered_to_compositor_ns: None,
                    screen_observed_ns: None,
                },
            },
        );

        Some(Event::FrameReady {
            viewport_id: self.viewport_id.clone(),
            frame_id,
            source_revision,
            view_revision,
            surface_lease: lease_id,
            dimensions,
            format,
            color_space,
            coverage,
            display_level,
        })
    }

    /// Adds another consumer reference to an already-published surface lease (for example, compositor + capture).
    pub fn retain_lease(&mut self, lease_id: SurfaceLeaseId) -> bool {
        let Some(&slot_index) = self.lease_to_slot.get(&lease_id) else {
            return false;
        };
        if let SlotState::Leased { consumer_refs, .. } = &mut self.slots[slot_index] {
            *consumer_refs += 1;
            true
        } else {
            false
        }
    }

    /// Records the compositor-delivery milestone separately from GPU completion.
    pub fn mark_delivered_to_compositor(&mut self, frame_id: u64, delivered_ns: u64) -> bool {
        let Some(frame) = self.published.get_mut(&frame_id) else {
            return false;
        };
        frame.milestones.delivered_to_compositor_ns = Some(delivered_ns);
        true
    }

    /// Records the screen-observed milestone separately from compositor delivery.
    pub fn mark_screen_observed(&mut self, frame_id: u64, observed_ns: u64) -> bool {
        let Some(frame) = self.published.get_mut(&frame_id) else {
            return false;
        };
        frame.milestones.screen_observed_ns = Some(observed_ns);
        true
    }

    /// Looks up the immutable published frame state for a `Pick(frame_id, viewport_pixel)` request.
    pub fn frame_for_pick(&self, frame_id: u64) -> Option<&PublishedFrame> {
        self.published.get(&frame_id)
    }

    /// Releases one consumer reference on `lease_id`. The slot returns to `Free` only when the last consumer releases.
    pub fn release_frame(&mut self, lease_id: SurfaceLeaseId) -> bool {
        let Some(&slot_index) = self.lease_to_slot.get(&lease_id) else {
            return false;
        };
        let should_free = match &mut self.slots[slot_index] {
            SlotState::Leased {
                frame_id,
                consumer_refs,
                ..
            } => {
                if *consumer_refs > 1 {
                    *consumer_refs -= 1;
                    None
                } else {
                    Some(*frame_id)
                }
            }
            SlotState::Free | SlotState::InFlight { .. } => return false,
        };

        if let Some(frame_id) = should_free {
            self.slots[slot_index] = SlotState::Free;
            self.lease_to_slot.remove(&lease_id);
            self.published.remove(&frame_id);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_and_event_round_trip_json() {
        let cmd = Command::SetView(Box::new(SetViewCommand {
            viewport_id: "vp-1".to_string(),
            source_revision: 7,
            view_revision: 42,
            target: ViewTarget::PlaneLps {
                origin: [1.0, 2.0, 3.0],
                right: [1.0, 0.0, 0.0],
                down: [0.0, 1.0, 0.0],
                normal: [0.0, 0.0, 1.0],
            },
            display: DisplayParams {
                window_center: 40.0,
                window_width: 400.0,
                inverted: false,
                palette: "gray".to_string(),
                zoom: 1.5,
                pan: [0.0, -4.0],
                rotation_deg: 0.0,
                flip_x: false,
                flip_y: false,
            },
            slab: Some(SlabParams {
                mode: "mip".to_string(),
                thickness_mm: 10.0,
            }),
            fusion: None,
        }));
        let encoded = serde_json::to_string(&cmd).expect("serialize command");
        assert!(encoded.contains("\"type\":\"setView\""));
        assert!(encoded.contains("\"viewportId\":\"vp-1\""));
        let decoded: Command = serde_json::from_str(&encoded).expect("deserialize command");
        assert_eq!(decoded, cmd);

        let evt = Event::FrameReady {
            viewport_id: "vp-1".to_string(),
            frame_id: 9,
            source_revision: 7,
            view_revision: 42,
            surface_lease: SurfaceLeaseId(3),
            dimensions: [1024, 768],
            format: PixelFormat::Bgra8Unorm,
            color_space: ColorSpace::Srgb,
            coverage: Coverage::Partial,
            display_level: DisplayLevel::Downsampled { stride: [1, 1, 2] },
        };
        let evt_json = serde_json::to_string(&evt).expect("serialize event");
        let evt_decoded: Event = serde_json::from_str(&evt_json).expect("deserialize event");
        assert_eq!(evt_decoded, evt);
    }

    #[test]
    fn lease_pool_prevents_premature_reuse_and_tracks_multiple_consumers() {
        assert!(SurfaceLeasePool::new("vp-0", 1).is_err());
        assert!(SurfaceLeasePool::new("vp-0", 4).is_err());

        let mut pool = SurfaceLeasePool::new("vp-1", 2).expect("2-slot pool");
        assert_eq!(pool.free_slots(), 2);

        let slot0 = pool.begin_render(1, 10).expect("slot 0");
        let slot1 = pool.begin_render(1, 11).expect("slot 1");
        assert_eq!(pool.free_slots(), 0);

        // Pool is full while both slots are busy.
        let busy = pool.begin_render(1, 12).expect_err("no free slot");
        assert_eq!(
            busy,
            Event::FrameDropped {
                viewport_id: "vp-1".to_string(),
                view_revision: 12,
                reason: DropReason::NoFreeSurface,
            }
        );

        // Slot 0 finishes for revision 10, but revision 12 was already requested -> superseded!
        let dropped = pool
            .complete_gpu_render(
                slot0,
                [512, 512],
                PixelFormat::Bgra8Unorm,
                ColorSpace::Srgb,
                Coverage::Complete,
                DisplayLevel::Full,
                1000,
            )
            .expect("drop event");
        assert_eq!(
            dropped,
            Event::FrameDropped {
                viewport_id: "vp-1".to_string(),
                view_revision: 10,
                reason: DropReason::Superseded,
            }
        );
        assert_eq!(pool.free_slots(), 1);

        // Render and publish revision 12 on the freed slot.
        let slot_new = pool.begin_render(2, 12).expect("reused freed slot");
        let ready = pool
            .complete_gpu_render(
                slot_new,
                [512, 512],
                PixelFormat::Bgra8Unorm,
                ColorSpace::Srgb,
                Coverage::Complete,
                DisplayLevel::Full,
                2000,
            )
            .expect("ready event");
        let (frame_id, lease_id) = match ready {
            Event::FrameReady {
                frame_id,
                surface_lease,
                source_revision,
                view_revision,
                ..
            } => {
                assert_eq!(source_revision, 2);
                assert_eq!(view_revision, 12);
                (frame_id, surface_lease)
            }
            other => panic!("expected FrameReady, got {other:?}"),
        };

        // Add a second consumer; first release must NOT free the surface.
        assert!(pool.retain_lease(lease_id));
        assert!(pool.mark_delivered_to_compositor(frame_id, 2500));
        assert!(pool.mark_screen_observed(frame_id, 3000));

        // Pick resolves against immutable published metadata while leased.
        let picked = pool.frame_for_pick(frame_id).expect("published frame");
        assert_eq!(picked.source_revision, 2);
        assert_eq!(picked.view_revision, 12);
        assert_eq!(picked.milestones.gpu_completed_ns, Some(2000));
        assert_eq!(picked.milestones.delivered_to_compositor_ns, Some(2500));
        assert_eq!(picked.milestones.screen_observed_ns, Some(3000));

        assert!(pool.release_frame(lease_id));
        // Still leased by second consumer; slot1 is still InFlight -> 0 free slots.
        assert_eq!(pool.free_slots(), 0);
        assert!(pool.frame_for_pick(frame_id).is_some());

        // Final release returns slot to Free and retires Pick metadata.
        assert!(pool.release_frame(lease_id));
        assert_eq!(pool.free_slots(), 1);
        assert!(pool.frame_for_pick(frame_id).is_none());

        // Stale slot1 (revision 11) finishes late -> superseded and freed cleanly.
        let late = pool
            .complete_gpu_render(
                slot1,
                [512, 512],
                PixelFormat::Bgra8Unorm,
                ColorSpace::Srgb,
                Coverage::Complete,
                DisplayLevel::Full,
                3500,
            )
            .expect("late drop");
        assert_eq!(
            late,
            Event::FrameDropped {
                viewport_id: "vp-1".to_string(),
                view_revision: 11,
                reason: DropReason::Superseded,
            }
        );
        assert_eq!(pool.free_slots(), 2);
    }
}
