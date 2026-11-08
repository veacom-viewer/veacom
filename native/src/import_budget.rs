use anyhow::{Result, bail};
use serde::Serialize;
use std::{io::{self,Write},sync::Mutex};

// Bounds for one import: its frames and the frame metadata kept from it. The header bytes read are not
// bounded in sum (each file's are, at 32 MiB in input_guard): a 64 MiB total refused real MR studies, whose
// vendor headers run to tens of kilobytes an image, while parsed headers are not kept.
const MAX_FRAMES:usize=50_000;
const MAX_INDEX:usize=256*1024*1024;

#[derive(Default)]
struct Counts {frames:usize,index:usize,failed:Option<fn()->crate::message::Coded>}
#[derive(Default)]
pub struct ImportBudget {counts:Mutex<Counts>}
impl ImportBudget {
    pub fn check(&self)->Result<()> {
        if let Some(message)=self.counts.lock().unwrap().failed {bail!(message());}
        Ok(())
    }
    /// A file read: its frames count against the import's limit (its header bytes are bounded per file).
    pub fn reserve_header(&self,frames:usize,_bytes:usize)->Result<()> {
        let mut counts=self.counts.lock().unwrap();
        if let Some(message)=counts.failed {bail!(message());}
        let next_frames=counts.frames.checked_add(frames);
        if next_frames.is_none_or(|n|n>MAX_FRAMES) {counts.failed=Some(||coded!("import.frameLimit", "Import exceeds the 50,000-frame resource limit"));}
        if let Some(message)=counts.failed {bail!(message());}
        counts.frames=next_frames.unwrap();Ok(())
    }
    pub fn reserve_index(&self,frames:usize,per_frame:usize)->Result<()> {
        let mut counts=self.counts.lock().unwrap();
        if let Some(message)=counts.failed {bail!(message());}
        let next=frames.checked_mul(per_frame).and_then(|n|counts.index.checked_add(n));
        if next.is_none_or(|n|n>MAX_INDEX) {
            counts.failed=Some(||coded!("import.retainedLimit", "Retained frame metadata exceeds the 256 MiB import resource limit"));
            bail!(counts.failed.unwrap()());
        }
        counts.index=next.unwrap();Ok(())
    }
}

struct Counter(usize);
impl Write for Counter {
    fn write(&mut self,bytes:&[u8])->io::Result<usize> {
        self.0=self.0.checked_add(bytes.len()).ok_or_else(||io::Error::other("Metadata size overflow"))?;
        if self.0>MAX_INDEX {return Err(io::Error::other("Metadata exceeds the import resource limit"));}
        Ok(bytes.len())
    }
    fn flush(&mut self)->io::Result<()> {Ok(())}
}
pub fn serialized_size(value:&impl Serialize)->Result<usize> {
    let mut counter=Counter(0);serde_json::to_writer(&mut counter,value)?;Ok(counter.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_amplification_is_rejected_before_copying_metadata() {
        let budget=ImportBudget::default();budget.reserve_header(50_000,60*1024).unwrap();
        assert!(budget.reserve_index(50_000,60*1024).is_err());assert!(budget.check().is_err());
    }
    #[test]
    fn aggregate_limits_cannot_be_bypassed_by_many_small_files_or_overflow() {
        let budget=ImportBudget::default();budget.reserve_header(30_000,1024).unwrap();
        assert!(budget.reserve_header(30_000,1024).is_err());
        let budget=ImportBudget::default();assert!(budget.reserve_index(usize::MAX,usize::MAX).is_err());
    }
    #[test]
    fn header_bytes_do_not_limit_a_large_study() {
        // 4,000 MR images with 60 KB vendor headers each: 240 MB of headers, one study.
        let budget=ImportBudget::default();
        for _ in 0..4_000 {budget.reserve_header(1,60*1024).unwrap();}
        assert!(budget.check().is_ok());
    }
    #[test]
    fn metadata_size_counts_without_constructing_a_second_json_buffer() {
        let value=serde_json::json!({"name":"synthetic","values":[1,2,3]});
        assert_eq!(serialized_size(&value).unwrap(),serde_json::to_vec(&value).unwrap().len());
    }
}
