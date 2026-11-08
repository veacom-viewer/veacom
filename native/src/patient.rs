use crate::ingest::text;
use dicom_core::Tag;
use dicom_object::InMemDicomObject;
use sha2::{Digest, Sha256};

#[derive(Eq, Hash, PartialEq, serde::Serialize)]
pub struct PatientKey {
    id: String,
    issuer: String,
    issuer_qualifiers: Vec<(String, String, String)>,
    name: String,
    birth_date: String,
    study: Option<String>,
}

pub fn patient_key(obj: &InMemDicomObject) -> PatientKey {
    let id = text(obj, Tag(0x0010, 0x0020));
    let issuer = text(obj, Tag(0x0010, 0x0021));
    let qualifiers: Vec<_> = obj.get(Tag(0x0010, 0x0024)).and_then(|e| e.value().items())
        .into_iter().flatten().map(|item| (text(item, Tag(0x0040, 0x0031)),
            text(item, Tag(0x0040, 0x0032)), text(item, Tag(0x0040, 0x0033)))).collect();
    let scoped = !id.is_empty() && (!issuer.is_empty() || qualifiers.iter().any(|(local, universal, kind)| {
        !local.is_empty() || (!universal.is_empty() && !kind.is_empty())
    }));
    PatientKey {
        id, issuer, issuer_qualifiers: qualifiers,
        name: text(obj, Tag(0x0010, 0x0010)),
        birth_date: text(obj, Tag(0x0010, 0x0030)),
        study: (!scoped).then(|| {
            let study = text(obj, Tag(0x0020, 0x000d));
            if study.is_empty() { text(obj, Tag(0x0008, 0x0018)) } else { study }
        }),
    }
}

impl PatientKey {
    /// Length-delimited fields prevent different identifiers from producing the same catalog key.
    pub fn digest(&self) -> String {
        let bytes = serde_json::to_vec(self).expect("patient identity has only strings and sequences");
        crate::random::hex(&Sha256::digest(bytes))
    }
}
