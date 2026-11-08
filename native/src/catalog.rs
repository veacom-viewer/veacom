//! What an import adds to a session's catalog, the same for the desktop's transport (main.rs) and the browser's
//! (web/engine/src/session.rs): what each series costs against the catalog's limits, whether the catalog stays within
//! them, and whether a study UID has come to name more than one patient.

use crate::{
    import_budget,
    message::Note,
    model::{Frame, SourceSeries},
    source_file::SourceFile,
};
use anyhow::{Context, Result};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

/// Frames and documents a session's catalog holds at most.
pub const MAX_ENTRIES: usize = 100_000;
/// Memory a session's catalog may take at most, by `cost`.
pub const MAX_BYTES: usize = 512 * 1024 * 1024;

/// What a series costs the catalog: its metadata twice (held, and written out for the interface), its frames, and what
/// its files keep in memory, each file once.
pub fn cost(source: &SourceSeries) -> Result<usize> {
    let metadata = import_budget::serialized_size(&source.info)?;
    let mut counted = HashSet::new();
    let frame_bytes = source
        .frames
        .iter()
        .map(|frame| {
            let file_bytes = if counted.insert(&frame.source.path) { frame.source.retained_bytes() } else { 0 };
            size_of::<Frame>() + frame.sop_uid.len() + file_bytes
        })
        .sum::<usize>();
    let document_bytes = source
        .documents
        .iter()
        .map(|file| size_of::<Arc<SourceFile>>() + file.retained_bytes())
        .sum::<usize>();
    metadata
        .checked_mul(2)
        .and_then(|n| n.checked_add(frame_bytes))
        .and_then(|n| n.checked_add(document_bytes))
        .context("Catalog size overflow")
}

/// The costs of `incoming`, by series id.
pub fn costs(incoming: &[Arc<SourceSeries>]) -> Result<BTreeMap<String, usize>> {
    incoming.iter().map(|source| Ok((source.info.id.clone(), cost(source)?))).collect()
}

/// What a series counts against `MAX_ENTRIES`: its frames and its documents.
pub fn entries(source: &SourceSeries) -> usize {
    source.frames.len() + source.documents.len()
}

/// Whether the catalog stays within its limits once `incoming` (whose costs are `incoming_costs`) has replaced the
/// series of the same ids in `open` (whose costs are `open_costs`).
pub fn fits(
    open: &BTreeMap<String, Arc<SourceSeries>>,
    open_costs: &BTreeMap<String, usize>,
    incoming: &[Arc<SourceSeries>],
    incoming_costs: &BTreeMap<String, usize>,
) -> bool {
    let mut count = open.values().map(|source| entries(source)).sum::<usize>();
    let mut bytes = open_costs.values().sum::<usize>();
    for source in incoming {
        let id = &source.info.id;
        count = count.saturating_sub(open.get(id).map_or(0, |old| entries(old))).saturating_add(entries(source));
        bytes = bytes
            .saturating_sub(*open_costs.get(id).unwrap_or(&0))
            .saturating_add(*incoming_costs.get(id).unwrap_or(&0));
    }
    count <= MAX_ENTRIES && bytes <= MAX_BYTES
}

/// Whether a study UID among `incoming` names more than one patient, across `incoming` and the series already `open`
/// (an earlier import's among them). Ingest keeps such images in series of their own; the import then warns
/// (`conflict_note`).
pub fn patient_conflict<'a>(incoming: &'a [Arc<SourceSeries>], open: impl Iterator<Item = &'a Arc<SourceSeries>>) -> bool {
    let studies: HashSet<&str> = incoming.iter().map(|source| source.info.study_uid.as_str()).collect();
    let mut patients = BTreeMap::new();
    incoming.iter().chain(open).any(|source| {
        studies.contains(source.info.study_uid.as_str())
            && patients
                .insert(&source.info.study_uid, &source.info.patient_key)
                .is_some_and(|previous| previous != &source.info.patient_key)
    })
}

/// The import's warning when `patient_conflict` finds a study with two patients.
pub fn conflict_note() -> Note {
    note!(
        "import.patientConflict",
        "This study UID has conflicting patient identities. Their images have been kept in separate series."
    )
}

/// The import's error when `fits` finds the catalog full.
pub fn full_note() -> Note {
    note!(
        "import.catalogFull",
        "The session catalog reached its resource limit; restart the viewer before importing more studies"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Series;

    fn series(id: &str, study: &str, patient: &str) -> Arc<SourceSeries> {
        Arc::new(SourceSeries {
            info: Series { id: id.into(), study_uid: study.into(), patient_key: patient.into(), ..Default::default() },
            frames: Vec::new(),
            geometry: crate::geometry::assemble(&[]),
            documents: Vec::new(),
        })
    }

    #[test]
    fn a_study_that_names_another_patient_in_a_later_import_is_a_conflict() {
        let first = [series("a", "1.2.3", "SYNTHETIC^A")];
        let open: BTreeMap<String, Arc<SourceSeries>> = first.iter().map(|s| (s.info.id.clone(), s.clone())).collect();
        assert!(!patient_conflict(&first, std::iter::empty()), "one patient on its own");
        // The second import names the open study with another patient.
        assert!(patient_conflict(&[series("b", "1.2.3", "SYNTHETIC^B")], open.values()));
        // The same patient again, or another study, is no conflict.
        assert!(!patient_conflict(&[series("c", "1.2.3", "SYNTHETIC^A")], open.values()));
        assert!(!patient_conflict(&[series("d", "9.9.9", "SYNTHETIC^B")], open.values()));
        // Two patients within one import are a conflict too.
        assert!(patient_conflict(&[series("e", "4.5", "SYNTHETIC^A"), series("f", "4.5", "SYNTHETIC^B")], std::iter::empty()));
    }

    #[test]
    fn the_limits_count_documents_and_let_a_series_replace_itself() {
        let temp = crate::test_dir::tempdir().unwrap();
        let report = temp.path().join("report.pdf");
        std::fs::write(&report, b"%PDF-1.4").unwrap();
        let mut document_series = (*series("doc", "1", "P")).clone();
        document_series.documents = vec![SourceFile::index(&report).unwrap()];
        assert_eq!(entries(&document_series), 1);
        let one = series("a", "1", "P");
        let open: BTreeMap<_, _> = [(one.info.id.clone(), one.clone())].into();
        let open_costs: BTreeMap<_, _> = [(one.info.id.clone(), MAX_BYTES)].into();
        // Imported again at the same cost, the series takes its own place.
        let incoming = [one.clone()];
        assert!(fits(&open, &open_costs, &incoming, &[(one.info.id.clone(), MAX_BYTES)].into()));
        // Beside it, another one byte would not fit.
        let other = [series("b", "2", "P")];
        assert!(!fits(&open, &open_costs, &other, &[("b".to_owned(), 1)].into()));
    }
}
