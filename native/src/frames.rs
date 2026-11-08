//! Exact source frames shared by measurement, thumbnails and GPU tile uploads.
use crate::{
    decode,
    model::{PixelBuffer, SourceSeries},
};
use anyhow::Result;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, LazyLock, Mutex, OnceLock},
};

const BUDGET: usize = 64 << 20;
struct Entry {
    id: String,
    revision: u64,
    index: usize,
    pixels: Arc<PixelBuffer>,
}
type PendingFrame = Arc<OnceLock<Result<Arc<PixelBuffer>, String>>>;
#[derive(Default)]
struct Cache {
    loading: HashMap<(String, u64, usize), PendingFrame>,
    frames: VecDeque<Entry>,
    bytes: usize,
}
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));

pub fn read(source: &SourceSeries, index: usize) -> Result<Arc<PixelBuffer>> {
    if source.info.source_revision == 0 {
        return Ok(Arc::new(decode::decode_frame(source, index)?));
    }
    let key = (source.info.id.clone(), source.info.source_revision, index);
    let loading = {
        let mut cache = CACHE.lock().unwrap();
        if let Some(i) = cache
            .frames
            .iter()
            .position(|f| f.id == key.0 && f.revision == key.1 && f.index == index)
        {
            let entry = cache.frames.remove(i).unwrap();
            let pixels = entry.pixels.clone();
            cache.frames.push_back(entry);
            return Ok(pixels);
        }
        cache.loading.entry(key.clone()).or_default().clone()
    };
    let result = loading
        .get_or_init(|| {
            decode::decode_frame(source, index)
                .map(Arc::new)
                .map_err(|e| format!("{e:#}"))
        })
        .clone();
    let mut cache = CACHE.lock().unwrap();
    let current = cache
        .loading
        .get(&key)
        .is_some_and(|pending| Arc::ptr_eq(pending, &loading));
    if current {
        cache.loading.remove(&key);
    }
    let pixels = result.map_err(anyhow::Error::msg)?;
    if !current {
        return Ok(pixels);
    }
    let bytes = pixels.bytes().len();
    if bytes <= BUDGET {
        while cache.bytes > BUDGET - bytes {
            let old = cache.frames.pop_front().unwrap();
            cache.bytes -= old.pixels.bytes().len();
        }
        cache.bytes += bytes;
        cache.frames.push_back(Entry {
            id: source.info.id.clone(),
            revision: source.info.source_revision,
            index,
            pixels: pixels.clone(),
        });
    }
    Ok(pixels)
}

pub fn forget(id: &str) {
    let mut cache = CACHE.lock().unwrap();
    cache.loading.retain(|(series, _, _), _| series != id);
    cache.frames.retain(|entry| entry.id != id);
    cache.bytes = cache
        .frames
        .iter()
        .map(|entry| entry.pixels.bytes().len())
        .sum();
}
