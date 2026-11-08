/**
 * Chromium draws WebGL on the CPU when a PC has no usable graphics driver: on Windows through
 * Direct3D WARP, which reports itself as "Microsoft Basic Render Driver", elsewhere through
 * SwiftShader or Mesa. These names identify such software renderers in WebGL's unmasked
 * renderer string. tools/software-renderer.cjs keeps the same pattern for the desktop checks.
 */
export const SOFTWARE_RENDERERS = /swiftshader|basic render driver|\bwarp\b|llvmpipe|softpipe|lavapipe|software (?:renderer|rasterizer)|gdi generic/i;

/** True when a WebGL renderer string names a software (CPU) implementation. */
export function isSoftwareRenderer(renderer: string): boolean {
  return SOFTWARE_RENDERERS.test(renderer);
}

/** True for Chromium's WebGL feature status when WebGL runs without hardware acceleration. */
export function isSoftwareWebglStatus(status: unknown): boolean {
  return status === 'unavailable_software' || status === 'disabled_software';
}
