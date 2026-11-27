//! Pixels for looking at: a frame under a window as RGBA.

use veacom_core::model::PixelBuffer;

/// Apply the frame window under PS3.3 C.11.2.1.2-3 and quantize to 8 bits.
pub fn window_rgba(
    pixels: &PixelBuffer,
    components: usize,
    center: f64,
    width: f64,
    curve: Option<&str>,
    invert: bool,
) -> Vec<u8> {
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
    let center = if center.is_finite() { center } else { 0. };
    let narrow_curve = matches!(curve, Some("SIGMOID" | "LINEAR_EXACT"));
    // DICOM PS3.3 C.11.2.1.2-3: LINEAR requires width >= 1; SIGMOID and LINEAR_EXACT permit any positive width.
    let width = if width.is_finite()
        && if narrow_curve {
            width > 0.
        } else {
            width >= 1.
        } {
        width
    } else {
        1.
    };
    for (i, out) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let x = pixels.value(i);
        // Non-finite padding stays background black even under MONOCHROME1 inversion.
        let y = if !x.is_finite() {
            0
        } else {
            let grey = match curve {
                Some("SIGMOID") => 1. / (1. + (-4. * (x - center) / width).exp()),
                Some("LINEAR_EXACT") => ((x - center) / width + 0.5).clamp(0., 1.),
                _ if width <= 1. => f64::from(x > center - 0.5),
                _ => ((x - (center - 0.5)) / (width - 1.) + 0.5).clamp(0., 1.),
            };
            ((if invert { 1. - grey } else { grey }) * 255.).round() as u8
        };
        out[0] = y;
        out[1] = y;
        out[2] = y;
    }
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_windows_keep_fractional_widths_and_the_threshold_boundary() {
        let pixels = PixelBuffer::F32(vec![0.4375, 0.46875, 0.5, 0.5625]);
        for (curve, width, center, levels) in [
            (Some("LINEAR_EXACT"), 0.125, 0.5, [0, 64, 128, 255]),
            (Some("SIGMOID"), 0.125, 0.5, [30, 69, 128, 225]),
            (None, 1., 1., [0, 0, 0, 255]),
            (None, 1.5, 1., [96, 112, 128, 159]),
        ] {
            let rgba = window_rgba(&pixels, 1, center, width, curve, false);
            let actual: Vec<u8> = rgba.chunks_exact(4).map(|p| p[0]).collect();
            assert_eq!(actual, levels);
        }
    }

    #[test]
    fn invalid_widths_fall_back_and_nonfinite_padding_stays_black_under_monochrome1() {
        let pixels = PixelBuffer::F32(vec![f32::NAN, 0.0, 1.0, f32::INFINITY]);
        // Zero, negative, and NaN widths never divide by zero or invert contrast.
        for curve in [None, Some("LINEAR_EXACT"), Some("SIGMOID")] {
            for width in [0.0, -5.0, f64::NAN] {
                let rgba = window_rgba(&pixels, 1, 0.5, width, curve, false);
                let actual: Vec<u8> = rgba.chunks_exact(4).map(|p| p[0]).collect();
                assert_eq!(actual[0], 0);
                assert_eq!(actual[3], 0);
                assert!(
                    actual[2] > actual[1],
                    "curve={curve:?} width={width:?} got {actual:?}"
                );
            }
        }
        // Under MONOCHROME1 (invert = true), NaN padding must remain 0 (black), not 255 (white).
        let inverted = window_rgba(&pixels, 1, 0.5, 1.0, None, true);
        let levels: Vec<u8> = inverted.chunks_exact(4).map(|p| p[0]).collect();
        assert_eq!(levels, [0, 255, 0, 0]);
    }
}
