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

/// The patient a file belongs to. An ID with an issuer names one patient wherever it appears. An ID without one names
/// one patient across studies together with the name (as `comparable_name` reads it) and the birth date; with any of
/// the three missing, the key is scoped to the study.
pub fn patient_key(obj: &InMemDicomObject) -> PatientKey {
    patient_keys(obj).0
}

/// `patient_key`, and where it joins an ID without an issuer across studies, the key earlier builds made for it:
/// scoped to the study, with the name as written. PET measurements those builds kept are found by it.
pub fn patient_keys(obj: &InMemDicomObject) -> (PatientKey, Option<PatientKey>) {
    let id = text(obj, Tag(0x0010, 0x0020));
    let issuer = text(obj, Tag(0x0010, 0x0021));
    let qualifiers: Vec<_> = obj
        .get(Tag(0x0010, 0x0024))
        .and_then(|e| e.value().items())
        .into_iter()
        .flatten()
        .map(|item| {
            (
                text(item, Tag(0x0040, 0x0031)),
                text(item, Tag(0x0040, 0x0032)),
                text(item, Tag(0x0040, 0x0033)),
            )
        })
        .collect();
    let issued = !id.is_empty()
        && (!issuer.is_empty()
            || qualifiers.iter().any(|(local, universal, kind)| {
                !local.is_empty() || (!universal.is_empty() && !kind.is_empty())
            }));
    let name = text(obj, Tag(0x0010, 0x0010));
    let birth_date = text(obj, Tag(0x0010, 0x0030));
    if issued {
        let key = PatientKey {
            id,
            issuer,
            issuer_qualifiers: qualifiers,
            name,
            birth_date,
            study: None,
        };
        return (key, None);
    }
    let study = text(obj, Tag(0x0020, 0x000d));
    let comparable = comparable_name(&name);
    let scoped = PatientKey {
        id: id.clone(),
        issuer: issuer.clone(),
        issuer_qualifiers: qualifiers.clone(),
        name,
        birth_date: birth_date.clone(),
        study: Some(if study.is_empty() {
            text(obj, Tag(0x0008, 0x0018))
        } else {
            study
        }),
    };
    if id.is_empty() || comparable.is_empty() || birth_date.is_empty() {
        return (scoped, None);
    }
    let joined = PatientKey {
        id,
        issuer,
        issuer_qualifiers: qualifiers,
        name: comparable,
        birth_date,
        study: None,
    };
    (joined, Some(scoped))
}

/// A name as studies without an issuer are joined by: without case, with `^` (between the name's parts) and runs of
/// spaces as one space, and with Turkish letters as their Latin base letters (Ş as s, İ and ı as i, â as a). Systems
/// that write only ASCII spell ŞEKER as SEKER, and Turkish case pairs (I and ı, İ and i) would otherwise keep IŞIK
/// and Işık apart. Combining marks are left out: a decomposed İ is an I with one. Other letters stay as written.
fn comparable_name(name: &str) -> String {
    let words: Vec<String> = name
        .split(|c: char| c == '^' || c.is_whitespace())
        .map(|word| {
            word.chars()
                .filter(|c| !matches!(c, '\u{300}'..='\u{36f}'))
                .flat_map(|c| latin_base(c).to_lowercase())
                .collect()
        })
        .filter(|word: &String| !word.is_empty())
        .collect();
    words.join(" ")
}

fn latin_base(c: char) -> char {
    match c {
        'Ç' | 'ç' => 'c',
        'Ğ' | 'ğ' => 'g',
        'İ' | 'ı' | 'Î' | 'î' => 'i',
        'Ö' | 'ö' => 'o',
        'Ş' | 'ş' => 's',
        'Ü' | 'ü' | 'Û' | 'û' => 'u',
        'Â' | 'â' => 'a',
        other => other,
    }
}

impl PatientKey {
    /// Length-delimited fields prevent different identifiers from producing the same catalog key.
    pub fn digest(&self) -> String {
        let bytes =
            serde_json::to_vec(self).expect("patient identity has only strings and sequences");
        crate::random::hex(&Sha256::digest(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::VR;

    fn file(id: &str, issuer: &str, name: &str, birth_date: &str, study: &str) -> InMemDicomObject {
        let mut obj = InMemDicomObject::new_empty();
        for (tag, vr, value) in [
            (Tag(0x0010, 0x0020), VR::LO, id),
            (Tag(0x0010, 0x0021), VR::LO, issuer),
            (Tag(0x0010, 0x0010), VR::PN, name),
            (Tag(0x0010, 0x0030), VR::DA, birth_date),
            (Tag(0x0020, 0x000d), VR::UI, study),
        ] {
            if !value.is_empty() {
                obj.put_str(tag, vr, value);
            }
        }
        obj
    }

    fn sha(text: &str) -> String {
        crate::random::hex(&Sha256::digest(text.as_bytes()))
    }

    #[test]
    fn joins_studies_without_an_issuer_by_id_name_and_birth_date() {
        let (first, first_scoped) =
            patient_keys(&file("P1", "", "SENTETIK^HASTA", "19800101", "1.2.1"));
        let (second, second_scoped) =
            patient_keys(&file("P1", "", "sentetik  hasta ", "19800101", "1.2.2"));
        assert!(first == second);
        // Each study keeps the key earlier builds made for it.
        assert!(first_scoped.is_some() && second_scoped.is_some());
        assert!(first_scoped != second_scoped);
    }

    #[test]
    fn keeps_studies_apart_when_the_id_name_or_birth_date_differs_or_is_missing() {
        let key = |id, name, birth_date, study| patient_key(&file(id, "", name, birth_date, study));
        let first = key("P1", "SENTETIK^HASTA", "19800101", "1.2.1");
        assert!(first != key("P1", "SENTETIK^HASTA", "19800102", "1.2.2"));
        assert!(first != key("P2", "SENTETIK^HASTA", "19800101", "1.2.2"));
        assert!(first != key("P1", "SENTETIK^HASTAM", "19800101", "1.2.2"));
        assert!(first != key("P1", "HASTA^SENTETIK", "19800101", "1.2.2"));
        // With the ID, the name or the birth date missing, the key stays scoped to the study.
        for (id, name, birth_date) in [
            ("", "SENTETIK^HASTA", "19800101"),
            ("P1", "", "19800101"),
            ("P1", "^ ^", "19800101"),
            ("P1", "SENTETIK^HASTA", ""),
        ] {
            let (one, scoped) = patient_keys(&file(id, "", name, birth_date, "1.2.1"));
            assert!(scoped.is_none());
            assert!(one != key(id, name, birth_date, "1.2.2"));
            assert!(one == key(id, name, birth_date, "1.2.1"));
        }
    }

    #[test]
    fn keeps_ids_with_an_issuer_as_they_were() {
        let key = |issuer, name, study| patient_keys(&file("P1", issuer, name, "19800101", study));
        let (first, scoped) = key("SITE-A", "SENTETIK^HASTA", "1.2.1");
        assert!(scoped.is_none());
        assert!(first == key("SITE-A", "SENTETIK^HASTA", "1.2.2").0);
        assert!(first != key("SITE-B", "SENTETIK^HASTA", "1.2.1").0);
    }

    #[test]
    fn reads_turkish_letters_as_their_latin_base_letters() {
        for (a, b) in [
            ("ŞEKER^AYŞE", "SEKER^AYSE"),
            ("IŞIK^İLKER", "Işık ilker"),
            ("ÇAĞLAR^ÖZGÜR", "caglar ozgur"),
            ("KÂMİL^NÛR", "kamil nur"),
            ("I\u{307}LKER", "İLKER"),
        ] {
            assert_eq!(comparable_name(a), comparable_name(b), "{a} / {b}");
        }
        assert_eq!(comparable_name(" ŞEKER^AYŞE^^^ "), "seker ayse");
        assert_ne!(comparable_name("ŞEKER^AYŞE"), comparable_name("AYSE^SEKER"));
    }

    #[test]
    fn keeps_the_digests_earlier_builds_made() {
        // PET measurements are kept under these digests.
        let (issued, _) =
            patient_keys(&file("P1", "SITE-A", "SENTETIK^HASTA", "19800101", "1.2.1"));
        assert_eq!(
            issued.digest(),
            sha(
                r#"{"id":"P1","issuer":"SITE-A","issuer_qualifiers":[],"name":"SENTETIK^HASTA","birth_date":"19800101","study":null}"#
            )
        );
        let (_, scoped) = patient_keys(&file("P1", "", "SENTETIK^HASTA", "19800101", "1.2.1"));
        assert_eq!(
            scoped.map(|key| key.digest()),
            Some(sha(
                r#"{"id":"P1","issuer":"","issuer_qualifiers":[],"name":"SENTETIK^HASTA","birth_date":"19800101","study":"1.2.1"}"#
            ))
        );
        let (unnamed, _) = patient_keys(&file("P1", "", "", "19800101", "1.2.1"));
        assert_eq!(
            unnamed.digest(),
            sha(
                r#"{"id":"P1","issuer":"","issuer_qualifiers":[],"name":"","birth_date":"19800101","study":"1.2.1"}"#
            )
        );
    }
}
