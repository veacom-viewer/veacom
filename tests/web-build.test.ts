// The browser build's own pieces (src/web): its MP4 writer against the desktop's, its ZIP, and its Trusted Types rule.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import glyphs from '../src/assets/glyphs.json';
import { checkSample, mp4Header } from '../src/web/mp4';
import { iconMarkup, ownScript } from '../src/web/trusted-types';
import { zipStored } from '../src/web/zip';

const desktop = createRequire(import.meta.url)('../electron/mp4.cjs');

it('writes the same MP4 header as the desktop, in both layouts', () => {
  const config = new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0]);
  const video = { width: 640, height: 480, fps: 15, config, sizes: [1200, 300, 280, 900, 310], keyFrames: [0, 3] };
  assert.deepEqual(Buffer.from(mp4Header(video)), desktop.mp4Header(video));
  // The 64-bit layout, as a video over 4 GiB has.
  assert.deepEqual(Buffer.from(mp4Header(video, 1024)), desktop.mp4Header({ ...video, wideAt: 1024 }));
  assert.throws(() => mp4Header({ ...video, keyFrames: [1] }));
  assert.throws(() => checkSample(new Uint8Array([0, 0, 0, 9, 1])));
});

it('stores files in a ZIP that reads back byte for byte', async () => {
  const files = [
    { name: 'VEACOM_1/DICOM/IM000001', bytes: new Uint8Array([1, 2, 3, 250]) },
    { name: 'VEACOM_1/DICOMDIR', bytes: new Uint8Array(70_000).map((_, i) => i % 251) },
    { name: 'Görüntü 1.png', bytes: new Uint8Array() },
  ];
  const archive = new Uint8Array(await zipStored(files).arrayBuffer());
  const view = new DataView(archive.buffer);
  const end = archive.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), files.length);
  // Walk the central directory and read each file through its local header.
  let at = view.getUint32(end + 16, true);
  for (const file of files) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    assert.equal(new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength)), file.name);
    const start = local + 30 + view.getUint16(local + 26, true), size = view.getUint32(local + 18, true);
    assert.equal(view.getUint16(local + 8, true), 0);
    assert.deepEqual(archive.subarray(start, start + size), file.bytes);
    at += 46 + nameLength;
  }
});

it('lets through every toolbar icon and nothing that could run', () => {
  for (const [name, svg] of Object.entries(glyphs.glyphs as Record<string, string>)) {
    const body = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replaceAll('{fg}', 'currentColor').replaceAll('{accent}', '#4f9dff')
      .replaceAll('{w}', '1.8').replaceAll('{red}', '#ff5c5c').replaceAll('{blue}', '#54a8ff').replaceAll('{hot}', '#ff8c1a');
    assert.equal(iconMarkup(body), body, name);
  }
  for (const hostile of [
    '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '<path d="M0 0" onclick="alert(1)"/>',
    '<a href="javascript:alert(1)"><path d="M0 0"/></a>', '<path d="M0 0" fill="url(javascript:alert(1))"/>',
    '<foreignObject><div/></foreignObject>', '<path d="M0 0"/>text', '<image href="https://example.com/x.png"/>',
    '<path d="M0 0" style="fill:red"/>',
  ]) assert.throws(() => iconMarkup(hostile), TypeError, hostile);
});

it('starts Workers from this site only', () => {
  Object.assign(globalThis, { location: new URL('https://viewer.veacom.app/web.html') });
  assert.equal(ownScript('https://viewer.veacom.app/assets/engine.worker.js'), 'https://viewer.veacom.app/assets/engine.worker.js');
  assert.equal(ownScript('./assets/roi.worker.js'), './assets/roi.worker.js');
  assert.throws(() => ownScript('https://example.com/evil.js'));
  assert.throws(() => ownScript('data:text/javascript,alert(1)'));
});
