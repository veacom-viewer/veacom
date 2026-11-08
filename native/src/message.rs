//! Messages for the person using the viewer.
//!
//! A message carries a stable `code` that the interface translates, the parameters its
//! wording needs, and its English `text`: what logs, tests and clients without a
//! translation show. Parameters can themselves be messages (the reason a file could not
//! be read), so a translated message never has to pick English text apart.
use serde::{Serialize, Serializer, ser::SerializeMap};
use std::{
    collections::BTreeMap,
    fmt,
    ops::{Deref, DerefMut},
};

/// One message: `note!` builds coded ones; plain strings convert to uncoded ones, which
/// every interface shows as they are.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Note {
    #[serde(skip_serializing_if = "uncoded")]
    pub code: &'static str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<&'static str, Param>,
    pub text: String,
}

/// A value filled into a message: text, or a message the interface translates in turn.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Param {
    Text(String),
    Note(Box<Note>),
    /// Joined with "; ".
    Notes(Vec<Note>),
}

fn uncoded(code: &&'static str) -> bool {
    code.is_empty()
}

impl Note {
    /// A coded message whose English text is `template` with each `{name}` replaced by
    /// that parameter's English text.
    pub fn new(code: &'static str, template: &str, params: BTreeMap<&'static str, Param>) -> Self {
        let mut text = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(start) = rest.find('{') {
            text.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            match after.find('}').and_then(|end| params.get(&after[..end]).map(|value| (end, value))) {
                Some((end, value)) => {
                    text.push_str(&value.text());
                    rest = &after[end + 1..];
                }
                None => {
                    text.push('{');
                    rest = after;
                }
            }
        }
        text.push_str(rest);
        Self { code, params, text }
    }
}

impl Param {
    /// The reason an operation failed: its message when the whole error is one, else
    /// the error's English text.
    pub fn error(error: &anyhow::Error) -> Self {
        match coded(error) {
            Some(note) => Self::Note(Box::new(note.clone())),
            None => Self::Text(error.to_string()),
        }
    }

    fn text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Note(note) => note.text.clone(),
            Self::Notes(notes) => notes.iter().map(|note| note.text.as_str()).collect::<Vec<_>>().join("; "),
        }
    }
}

impl From<String> for Param {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}
impl From<&str> for Param {
    fn from(value: &str) -> Self {
        Self::Text(value.into())
    }
}
impl From<Note> for Param {
    fn from(value: Note) -> Self {
        Self::Note(Box::new(value))
    }
}
impl From<Vec<Note>> for Param {
    fn from(value: Vec<Note>) -> Self {
        Self::Notes(value)
    }
}

impl From<String> for Note {
    fn from(text: String) -> Self {
        Self { code: "", params: BTreeMap::new(), text }
    }
}
impl From<&str> for Note {
    fn from(text: &str) -> Self {
        text.to_owned().into()
    }
}
impl fmt::Display for Note {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

/// An error whose message the interface can translate.
#[derive(Debug)]
pub struct Coded(pub Note);

impl fmt::Display for Coded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0.text)
    }
}
impl std::error::Error for Coded {}

/// The error's message when the whole error is a coded one. A coded cause under English
/// context is not: translating it would drop the context.
pub fn coded(error: &anyhow::Error) -> Option<&Note> {
    error.downcast_ref::<Coded>().map(|coded| &coded.0).filter(|note| note.text == format!("{error:#}"))
}

/// Warnings of a series, an import or an export. They serialize as `warnings`, the English
/// texts every client reads, and `warningNotes`, the same messages for translation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Notes(pub Vec<Note>);

impl Deref for Notes {
    type Target = Vec<Note>;
    fn deref(&self) -> &Vec<Note> {
        &self.0
    }
}
impl DerefMut for Notes {
    fn deref_mut(&mut self) -> &mut Vec<Note> {
        &mut self.0
    }
}
impl From<Vec<Note>> for Notes {
    fn from(notes: Vec<Note>) -> Self {
        Self(notes)
    }
}
impl Serialize for Notes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("warnings", &self.0.iter().map(|note| note.text.as_str()).collect::<Vec<_>>())?;
        map.serialize_entry("warningNotes", &self.0)?;
        map.end()
    }
}

/// `note!("code", "English text with {name}", name = value, …)`
#[macro_export]
macro_rules! note {
    ($code:literal, $template:literal $(, $name:ident = $value:expr)* $(,)?) => {
        $crate::message::Note::new(
            $code,
            $template,
            [$((stringify!($name), $crate::message::Param::from($value))),*].into_iter().collect(),
        )
    };
}

/// A coded error, for `bail!`, `ensure!` and `Err(…)`: takes the same arguments as `note!`.
#[macro_export]
macro_rules! coded {
    ($($arguments:tt)*) => {
        $crate::message::Coded($crate::note!($($arguments)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Holder {
        series_number: i32,
        #[serde(flatten)]
        warnings: Notes,
    }

    #[test]
    fn renders_english_text_from_the_template_and_nested_messages() {
        let reason = note!("file.notDicom", "Missing DICOM file meta marker");
        let warning = note!("import.fileUnreadable", "{file}: {reason}", file = "a.txt", reason = reason.clone());
        assert_eq!(warning.text, "a.txt: Missing DICOM file meta marker");
        let all = note!("import.noImages", "No supported images were found. {details}", details = vec![warning.clone(), "b.bin: short".into()]);
        assert_eq!(all.text, "No supported images were found. a.txt: Missing DICOM file meta marker; b.bin: short");
        assert_eq!(note!("x.y", "Keep {unknown} braces {").text, "Keep {unknown} braces {");
    }

    #[test]
    fn serializes_texts_for_old_clients_and_codes_for_translation() {
        let notes: Notes = vec![note!("geometry.irregular", "Irregular {what}", what = "slices"), "Plain".into()].into();
        let json = serde_json::to_value(Holder { series_number: 3, warnings: notes }).unwrap();
        assert_eq!(json, serde_json::json!({
            "seriesNumber": 3,
            "warnings": ["Irregular slices", "Plain"],
            "warningNotes": [{"code": "geometry.irregular", "params": {"what": "slices"}, "text": "Irregular slices"}, {"text": "Plain"}],
        }));
    }

    #[test]
    fn finds_a_coded_error_only_when_it_is_the_whole_message() {
        let error = anyhow::Error::new(coded!("job.cancelled", "Operation cancelled"));
        assert_eq!(coded(&error).map(|note| note.code), Some("job.cancelled"));
        let wrapped = Err::<(), _>(anyhow::Error::new(coded!("job.cancelled", "Operation cancelled"))).context("Cannot import").unwrap_err();
        assert!(coded(&wrapped).is_none());
        assert_eq!(Param::error(&wrapped), Param::Text("Cannot import".into()));
        assert_eq!(Param::error(&error), Param::Note(Box::new(note!("job.cancelled", "Operation cancelled"))));
    }
}
