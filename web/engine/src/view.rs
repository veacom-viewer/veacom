//! Pixels for looking at: a frame under a window as RGBA.

use veacom_core::model::PixelBuffer;

/// The linear VOI function of PS3.3 C.11.2.1.2 to 8 bits; color pixels are passed through.
pub fn window_rgba(pixels: &PixelBuffer, components: usize, center: f64, width: f64, invert: bool) -> Vec<u8> {
    let count = pixels.len() / components.max(1);
    let mut rgba = vec![255u8; count * 4];
    if components == 3 {
        for (i, out) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            for (c, channel) in out.iter_mut().take(3).enumerate() {
                *channel = pixels.value(i * 3 + c).clamp(0., 255.) as u8;
            }
        }
        return rgba;
    }
    let width = width.max(1.);
    let low = center - 0.5 - (width - 1.) / 2.;
    let high = center - 0.5 + (width - 1.) / 2.;
    for (i, out) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let x = pixels.value(i);
        let y = if x <= low {
            0.
        } else if x > high {
            255.
        } else {
            ((x - (center - 0.5)) / (width - 1.).max(1.) + 0.5) * 255.
        };
        let y = if invert { 255. - y } else { y } as u8;
        out[0] = y;
        out[1] = y;
        out[2] = y;
    }
    rgba
}

