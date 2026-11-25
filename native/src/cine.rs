//! DICOM PS3.3 C.7.6.5. A time vector gives the interval from the preceding source frame.
use crate::ingest::number;
use crate::model::Frame;
use dicom_core::{PrimitiveValue, Tag, VR, header::HasLength};
use dicom_object::InMemDicomObject;
use serde::Serialize;
use std::sync::Arc;

const FRAME_TIME: Tag = Tag(0x0018, 0x1063);
const TIME_VECTOR: Tag = Tag(0x0018, 0x1065);
const RECOMMENDED_RATE: Tag = Tag(0x0008, 0x2144);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CineTiming {
    /// Catalog slices in DICOM playback order, after Start Trim and Stop Trim.
    pub slices: Vec<usize>,
    /// One fixed interval, or the interval between each consecutive pair of slices.
    pub intervals_ms: Vec<f64>,
    pub sweeping: bool,
}

#[derive(Debug)]
pub struct FileCine {
    count: usize,
    start: usize,
    stop: usize,
    intervals: Vec<f64>,
    sweeping: bool,
}

fn intervals(obj: &InMemDicomObject, frames: usize) -> Option<Vec<f64>> {
    let pointers = obj
        .get(Tag(0x0028, 0x0009))
        .and_then(|e| e.value().primitive());
    let points_to =
        |tag| matches!(pointers, Some(PrimitiveValue::Tags(tags)) if tags.contains(&tag));
    if points_to(TIME_VECTOR) || (pointers.is_none() && obj.get(TIME_VECTOR).is_some()) {
        let element = obj.get(TIME_VECTOR)?;
        // A DS occupies at most 16 bytes plus its separator. Explicit VR permits UN for a long Frame Time Vector.
        if element.length().0 as usize > frames * 17 {
            return None;
        }
        let values = match element.value().primitive()? {
            PrimitiveValue::U8(bytes) if element.vr() == VR::UN => std::str::from_utf8(bytes)
                .ok()?
                .trim_end_matches([' ', '\0'])
                .split('\\')
                .take(frames + 1)
                .map(|ds| ds.trim().parse::<f64>())
                .collect::<Result<Vec<_>, _>>()
                .ok()?,
            _ => element.to_multi_float64().ok()?,
        };
        if values.len() != frames || values[0] != 0.0 {
            return None;
        }
        let result: Vec<_> = values.into_iter().skip(1).collect();
        let total: f64 = result.iter().sum();
        return (total.is_finite()
            && total > 0.0
            && result.iter().all(|v| v.is_finite() && *v >= 0.0))
        .then_some(result);
    }
    // A display recommendation can deliberately differ from the acquisition rate (for example, slow motion).
    let rate = |tag| number(obj, tag).filter(|v| *v > 0.).map(|fps| 1000. / fps);
    let fixed = rate(RECOMMENDED_RATE)
        .or_else(|| {
            (points_to(FRAME_TIME) || pointers.is_none())
                .then(|| number(obj, FRAME_TIME))
                .flatten()
        })
        .or_else(|| rate(Tag(0x0018, 0x0040)))?;
    (fixed.is_finite() && fixed > 0. && (fixed * frames as f64).is_finite()).then(|| vec![fixed])
}

impl FileCine {
    pub fn read(obj: &InMemDicomObject, frames: usize) -> Option<Self> {
        if !(2..=crate::ingest::MAX_FILES).contains(&frames) {
            return None;
        }
        let intervals = intervals(obj, frames)?;
        let boundary = |tag, default: usize| {
            if obj.get(tag).is_none() {
                return Some(default);
            }
            let value = number(obj, tag)?;
            (value.fract() == 0. && value >= 1. && value <= frames as f64).then_some(value as usize)
        };
        let start = boundary(Tag(0x0008, 0x2142), 1)? - 1;
        let stop = boundary(Tag(0x0008, 0x2143), frames)?;
        (start < stop).then(|| Self {
            count: frames,
            start,
            stop,
            intervals,
            sweeping: number(obj, Tag(0x0018, 0x1244)) == Some(1.),
        })
    }

    pub fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.intervals.capacity() * size_of::<f64>()
            + self.count * (size_of::<usize>() + size_of::<f64>())
    }
}

/// A catalog can reorder source frames, join several instances or split a temporal acquisition into stacks.
/// Only a complete instance can play its own timeline.
pub fn for_series(frames: &[Frame]) -> Option<CineTiming> {
    let file = frames.first()?.cine.as_ref()?;
    if file.count != frames.len() {
        return None;
    }
    let mut order = vec![usize::MAX; frames.len()];
    for (slice, frame) in frames.iter().enumerate() {
        if !Arc::ptr_eq(file, frame.cine.as_ref()?) {
            return None;
        }
        let position = order.get_mut(frame.index as usize)?;
        if *position != usize::MAX {
            return None;
        }
        *position = slice;
    }
    let times = if file.intervals.len() == 1 {
        &file.intervals[..]
    } else {
        &file.intervals[file.start..file.stop - 1]
    };
    if file.stop - file.start > 1 {
        let total: f64 = times.iter().sum();
        if !(total > 0.
            && (1000. * times.len() as f64 / total).is_finite()
            && (2. * total).is_finite())
        {
            return None;
        }
    }
    Some(CineTiming {
        slices: order[file.start..file.stop].to_vec(),
        intervals_ms: times.to_vec(),
        sweeping: file.sweeping,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::DataElement;

    fn pointed(obj: &mut InMemDicomObject, tag: Tag) {
        obj.put(DataElement::new(
            Tag(0x0028, 0x0009),
            VR::AT,
            PrimitiveValue::from(tag),
        ));
    }

    #[test]
    fn fixed_interval_and_recommended_display_rate() {
        let mut obj = InMemDicomObject::new_empty();
        pointed(&mut obj, FRAME_TIME);
        obj.put(DataElement::new(FRAME_TIME, VR::DS, "50"));
        assert_eq!(FileCine::read(&obj, 4).unwrap().intervals, [50.]);
        obj.put(DataElement::new(RECOMMENDED_RATE, VR::IS, "40"));
        assert_eq!(FileCine::read(&obj, 4).unwrap().intervals, [25.]);
        assert!(FileCine::read(&obj, 1).is_none());
    }

    #[test]
    fn variable_timing_requires_all_increments_and_starts_at_zero() {
        let mut obj = InMemDicomObject::new_empty();
        pointed(&mut obj, TIME_VECTOR);
        for (values, valid) in [
            ("0\\25\\75\\25", true),
            ("0\\0\\80\\20", true),
            ("1\\25\\75\\25", false),
            ("0\\-1\\75\\25", false),
            ("0\\20", false),
            ("0\\0\\0\\0", false),
            ("0\\NaN\\25\\50", false),
        ] {
            obj.put(DataElement::new(
                TIME_VECTOR,
                VR::UN,
                PrimitiveValue::from(values.as_bytes().to_vec()),
            ));
            assert_eq!(FileCine::read(&obj, 4).is_some(), valid, "{values}");
        }
        obj.put(DataElement::new(
            TIME_VECTOR,
            VR::DS,
            PrimitiveValue::Strs(
                ["0", "25", "75", "25"]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
            ),
        ));
        obj.put(DataElement::new(RECOMMENDED_RATE, VR::IS, "60"));
        assert_eq!(FileCine::read(&obj, 4).unwrap().intervals, [25., 75., 25.]);
        obj.put(DataElement::new(Tag(0x0008, 0x2142), VR::IS, "5"));
        assert!(FileCine::read(&obj, 4).is_none());
    }
}
