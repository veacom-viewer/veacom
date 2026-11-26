// The browser build's own pieces (src/web): its MP4 writer against the desktop's, its ZIP, and its Trusted Types rule.
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import glyphs from '../src/assets/glyphs.json';
import { checkSample, mp4Header } from '../src/web/mp4';
import { iconMarkup, ownScript } from '../src/web/trusted-types';
import { zipStored } from '../src/web/zip';
import { readStoredZip } from './storedZip';

const desktop = createRequire(import.meta.url)('../electron/mp4.cjs');
const { readHeads } = createRequire(import.meta.url)('../web/file-heads.js');

it('bounds the total bytes read ahead and preserves file indices when reads are skipped', async () => {
  const file = new File([new Uint8Array(64 * 1024)], 'slice.dcm');
  let largeReads = 0;
  const large = { size: 17 * 1024 * 1024, slice: () => { largeReads++; return file; } };
  const heads: (Uint8Array | undefined)[] = await readHeads([{ file: large }, ...Array(1100).fill({ file })]);
  assert.equal(heads.length, 1101);
  assert.equal(heads[0], undefined);
  assert.equal(largeReads, 0);
  assert.equal(heads[1024]?.length, 64 * 1024);
  assert.equal(heads[1025], undefined);
  assert.equal(heads.reduce((total, head) => total + (head?.length ?? 0), 0), 64 * 1024 * 1024);
});

it('returns the exact prefix for each source across batches, empty files and a file changed on disk', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'veacom-file-heads-'));
  try {
    const changedPath = path.join(directory, 'changed');
    await writeFile(changedPath, 'old');
    const changed = await openAsBlob(changedPath);
    await writeFile(changedPath, 'new and longer');
    const bytes = Array.from({ length: 270 }, (_, index) => new Uint8Array(index % 23 === 0 ? 65541 : index).fill(index % 251));
    const files = bytes.map(data => ({ file: new Blob([data]) }));
    files[17] = { file: changed };
    files[64] = { file: new Blob() };
    const heads: (Uint8Array | undefined)[] = await readHeads(files);
    assert.equal(heads.length, files.length);
    for (const [index, expected] of bytes.entries()) {
      assert.deepEqual(heads[index], index === 17 || index === 64 ? undefined : expected.subarray(0, 65536), String(index));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
  assert.deepEqual(readStoredZip(archive), files);
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
