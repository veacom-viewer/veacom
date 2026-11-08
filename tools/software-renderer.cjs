// Same pattern as src/imaging/rendererInfo.ts (tests/renderer-info.test.ts keeps them equal), so the
// desktop checks also classify builds that do not report their own classification.
const SOFTWARE_RENDERERS = /swiftshader|basic render driver|\bwarp\b|llvmpipe|softpipe|lavapipe|software (?:renderer|rasterizer)|gdi generic/i;
const isSoftwareRenderer = renderer => SOFTWARE_RENDERERS.test(String(renderer ?? ''));
module.exports = { SOFTWARE_RENDERERS, isSoftwareRenderer };
