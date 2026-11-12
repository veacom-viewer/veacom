//! The page's picture decoder, in the threads build: a Web Worker on this module's shared memory
//! (src/web/picture.worker.ts) that takes the PNG, JPEG and BMP pictures the engine reads (`veacom_core::pictures`) and
//! answers each with the browser's own decoders, as the desktop app's sandboxed renderers do. The engine thread that
//! asked waits for the answer, so the decoder needs a thread of its own, which only the threads build has.

use std::{sync::atomic::AtomicBool, time::Duration};
use veacom_core::pictures;
use wasm_bindgen::prelude::*;

/// Never set: the decoder stops when the page ends its Worker.
static STOPPED: AtomicBool = AtomicBool::new(false);

/// Tells the engine a decoder runs. Called by the decoder Worker before it takes pictures.
#[wasm_bindgen(js_name = pictureDecoderStarted)]
pub fn picture_decoder_started() {
    pictures::decoder_started();
}

/// The next picture, waiting up to `wait_ms` for one: `{ id, want, bytes }`, with `want` "probe", "size" or "pixels"
/// and the bytes copied out of the shared memory, or undefined.
#[wasm_bindgen(js_name = pictureNext)]
pub fn picture_next(wait_ms: u32) -> JsValue {
    let Some(task) = pictures::next(Duration::from_millis(wait_ms.into()), &STOPPED) else {
        return JsValue::UNDEFINED;
    };
    let value = js_sys::Object::new();
    // An id stays far below 2^53, the integers a JavaScript number holds exactly.
    let _ = js_sys::Reflect::set(&value, &"id".into(), &(task.id as f64).into());
    let _ = js_sys::Reflect::set(&value, &"want".into(), &task.want.name().into());
    let _ = js_sys::Reflect::set(
        &value,
        &"bytes".into(),
        &js_sys::Uint8Array::from(task.bytes.as_slice()),
    );
    value.into()
}

/// Picture `id` decoded: its size and, when its pixels were asked for, `width × height` RGBA samples (rows top first).
/// False when nothing waits for it any more.
#[wasm_bindgen(js_name = pictureDecoded)]
pub fn picture_decoded(id: f64, width: u32, height: u32, rgba: Vec<u8>) -> bool {
    pictures::answer(id as u64, Ok((width, height, rgba)))
}

/// Picture `id` could not be decoded, and why.
#[wasm_bindgen(js_name = pictureFailed)]
pub fn picture_failed(id: f64, reason: &str) -> bool {
    pictures::answer(id as u64, Err(reason.chars().take(300).collect()))
}
