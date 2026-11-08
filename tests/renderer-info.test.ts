import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SOFTWARE_RENDERERS, isSoftwareRenderer, isSoftwareWebglStatus } from '../src/imaging/rendererInfo';

const require = createRequire(import.meta.url);
const tools = require('../tools/software-renderer.cjs');

describe('software renderer detection', () => {
  it('recognizes the renderers Chromium uses without a graphics driver', () => {
    for (const renderer of [
      // Windows on Microsoft's basic display driver, a remote session or a blocklisted driver: Direct3D WARP.
      'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11-WARP)',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'Google SwiftShader',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'ANGLE (Mesa, llvmpipe (LLVM 15.0.7 256 bits), OpenGL 4.5)',
      'GDI Generic',
      'Apple Software Renderer',
    ]) assert.equal(isSoftwareRenderer(renderer), true, renderer);
  });

  it('keeps graphics drivers classified as hardware', () => {
    for (const renderer of [
      'ANGLE (NVIDIA, NVIDIA Tesla T4 (0x00001EB8) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)',
      'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      // Remote desktop with a virtual GPU stays hardware accelerated in Chromium.
      'ANGLE (Microsoft, Microsoft RemoteFX Graphics Device - WDDM (0x000002C1) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Mesa Intel(R) UHD Graphics 620 (KBL GT2)',
      'WebKit WebGL',
      '',
    ]) assert.equal(isSoftwareRenderer(renderer), false, renderer);
  });

  it('reads Chromium WebGL feature status', () => {
    assert.equal(isSoftwareWebglStatus('unavailable_software'), true);
    assert.equal(isSoftwareWebglStatus('disabled_software'), true);
    for (const status of ['enabled', 'enabled_readback', 'disabled_off', 'unavailable_off', undefined, null, 1]) assert.equal(isSoftwareWebglStatus(status), false);
  });

  it('uses one pattern in the app and the desktop checks', () => {
    assert.equal(tools.SOFTWARE_RENDERERS.source, SOFTWARE_RENDERERS.source);
    assert.equal(tools.SOFTWARE_RENDERERS.flags, SOFTWARE_RENDERERS.flags);
    assert.equal(tools.isSoftwareRenderer(undefined), false);
  });
});
