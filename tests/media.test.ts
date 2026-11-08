import { createRequire, stripTypeScriptTypes } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { assertFields, waitFor } from './support';
import { chromium } from 'playwright';
import { rgbaToI420, videoEncoderConfigs } from '../src/export-video';

const require = createRequire(import.meta.url);
const { createVideoExporter, registerMediaHandlers, sweepExportLeftovers } = require('../electron/media.cjs');
// The module object media.cjs calls `rm` on: a test can make removal fail the way Windows does while antivirus or
// the indexer still holds a file just written.
const fsPromises = require('node:fs/promises');
const directories: string[] = [];
const exporters: Array<{ dispose: () => Promise<void> }> = [];
const settings = { width: 18, height: 16, description: Buffer.from([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0]) };
/** One encoded frame: a NAL unit with its 4-byte length. */
const sample = (...payload: number[]) => Buffer.from([0, 0, 0, payload.length, ...payload]);

async function fixture(filename = 'study.mp4', idleTimeoutMs = 5000) {
  const directory = await mkdtemp(path.join(tmpdir(), 'veacom-media-test-'));
  directories.push(directory);
  const destination = path.join(directory, filename);
  const exporter = createVideoExporter({ idleTimeoutMs, chooseDestination: async () => destination });
  exporters.push(exporter);
  return { exporter, directory, destination };
}

afterEach(async () => {
  await Promise.all(exporters.splice(0).map(exporter => exporter.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true })));
});

describe('video file writing', () => {
  it('writes the samples in order and replaces an existing file only when finished', async () => {
    const { exporter, destination, directory } = await fixture();
    await writeFile(destination, 'existing file is replaced only after writing succeeds');
    assert.equal(exporter.active, false);
    const { id } = await exporter.beginVideo('study', 10);
    assert.equal(exporter.active, true);
    await exporter.configureVideo(id, settings);
    await exporter.appendVideo(id, sample(0x65, 1, 2), true);
    await exporter.appendVideo(id, sample(0x41, 3), false);
    assert.ok((await readFile(destination, 'utf8')).includes('existing file'));
    assert.equal(await exporter.finishVideo(id), destination);
    assert.equal(exporter.active, false);
    const file = await readFile(destination);
    assert.equal(file.subarray(4, 8).toString(), 'ftyp');
    assert.deepEqual(file.subarray(file.length - 13), Buffer.concat([sample(0x65, 1, 2), sample(0x41, 3)]));
    assert.ok(file.indexOf('moov') < file.indexOf('mdat'));
    assert.deepEqual(await readdir(directory), ['study.mp4']);
  });

  it('cancels without deleting or replacing a user file', async () => {
    const { exporter, destination, directory } = await fixture();
    await writeFile(destination, 'keep me');
    const { id } = await exporter.beginVideo('study', 30);
    await exporter.configureVideo(id, settings);
    await exporter.appendVideo(id, sample(0x65), true);
    await exporter.cancelVideo(id);
    await exporter.cancelVideo(id);
    assert.equal(await readFile(destination, 'utf8'), 'keep me');
    assert.deepEqual(await readdir(directory), ['study.mp4']);
    await assert.rejects(exporter.finishVideo(id), { message: /no longer active/ });
  });

  it('rejects concurrent jobs and output that is not a video it can write', async () => {
    const { exporter } = await fixture();
    const { id } = await exporter.beginVideo('study', 30);
    await assert.rejects(exporter.beginVideo('second', 30), { message: /already running/ });
    await assert.rejects(exporter.appendVideo(id, sample(0x65), true), { message: /no encoder settings/ });
    await assert.rejects(exporter.configureVideo(id, { ...settings, width: 17 }), { message: /Invalid video size/ });
    await assert.rejects(exporter.configureVideo(id, { ...settings, description: Buffer.from('avcC') }), { message: /Invalid H\.264 configuration/ });
    await exporter.configureVideo(id, settings);
    await assert.rejects(exporter.configureVideo(id, settings), { message: /already configured/ });
    await assert.rejects(exporter.appendVideo(id, Buffer.from('not a sample'), true), { message: /Invalid H\.264 sample/ });
    await assert.rejects(exporter.appendVideo(id, sample(0x41), false), { message: /key frame/ });
    await assert.rejects(exporter.finishVideo(id), { message: /No video frames/ });
  });

  it('does not let the idle deadline stop a video that is being finished', async () => {
    const { exporter, destination } = await fixture('study.mp4', 30);
    const { id } = await exporter.beginVideo('study', 10);
    await exporter.configureVideo(id, settings);
    await exporter.appendVideo(id, sample(0x65, 1), true);
    const finishing = exporter.finishVideo(id);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(await finishing, destination);
    assert.equal((await readFile(destination)).subarray(4, 8).toString(), 'ftyp');
  });

  it('refuses an invalid frame rate', async () => {
    const { exporter } = await fixture();
    await assert.rejects(exporter.beginVideo('study', 0), { message: /frame rate/ });
    await assert.rejects(exporter.beginVideo('study', 121), { message: /frame rate/ });
    await assert.rejects(exporter.beginVideo('study', 1.5), { message: /frame rate/ });
  });

  it('removes abandoned partial files after the idle deadline', async () => {
    const { exporter, directory } = await fixture('study.mp4', 30);
    const { id } = await exporter.beginVideo('study', 30);
    await waitFor(async () => assert.deepEqual(await readdir(directory), []), { timeout: 5000, interval: 30 });
    await exporter.cancelVideo(id);
    await assert.rejects(exporter.appendVideo(id, sample(0x65), true), { message: /no longer active/ });
    assert.deepEqual(await readdir(directory), []);
  });

  it('leaves no file when the user cancels the save dialog', async () => {
    const exporter = createVideoExporter({ chooseDestination: async () => null });
    exporters.push(exporter);
    assert.equal(await exporter.beginVideo('study', 24), null);
  });

  it('neither blocks the next video nor fails a saved one when its temporary folder cannot be removed yet', async () => {
    const { exporter, destination } = await fixture();
    const realRm = fsPromises.rm;
    mock.method(process.stderr, 'write', () => true);
    mock.method(fsPromises, 'rm', async (...args: any[]) => {
      if (String(args[0]).includes('.veacom-video-')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return realRm(...args);
    });
    try {
      const cancelled = await exporter.beginVideo('study', 24);
      assert.equal(await exporter.cancelVideo(cancelled.id), undefined);
      assert.equal(await exporter.cancelVideo(cancelled.id), undefined);
      // The MP4 is in place: the export succeeded, whatever happens to its samples' folder.
      const saved = await exporter.beginVideo('study', 24);
      await exporter.configureVideo(saved.id, settings);
      await exporter.appendVideo(saved.id, sample(0x65, 1), true);
      assert.equal(await exporter.finishVideo(saved.id), destination);
      assert.equal(existsSync(destination), true);
      const next = await exporter.beginVideo('study', 24);
      assert.deepEqual(Object.keys(next), ['id']); assert.equal(typeof next.id, 'string');
    } finally { mock.restoreAll(); }
  });
});

describe('leftovers of exports that never finished', () => {
  it('sweeps old temporary export folders, and nothing else', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'veacom-media-test-'));
    directories.push(folder);
    const old = ['.veacom-video-Ab12Cd', '.veacom-iso-Xy98Zw', 'veacom-dicom-Qq1Ww2', '.veacom-video-much-longer', 'SYNTHETIC - CT'];
    for (const name of [...old, '.veacom-video-Ne1234']) await mkdir(path.join(folder, name));
    await writeFile(path.join(folder, '.veacom-iso-Ab12Cd'), 'a file, not an export folder');
    const sevenHoursAgo = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
    for (const name of [...old, '.veacom-iso-Ab12Cd']) await utimes(path.join(folder, name), sevenHoursAgo, sevenHoursAgo);
    await sweepExportLeftovers([folder]);
    // An export still running (a recent folder) keeps its folder; other names are not VEAcom's to remove.
    assert.deepEqual((await readdir(folder)).sort(), ['.veacom-iso-Ab12Cd', '.veacom-video-Ne1234', '.veacom-video-much-longer', 'SYNTHETIC - CT'].sort());
  });
});

describe('video export into the export folder', () => {
  it('cleans the name, asks no dialog and keeps an earlier export', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'veacom-media-test-'));
    directories.push(directory);
    const folder = path.join(directory, 'exports');
    await mkdir(folder);
    const { createExportFolder } = require('../electron/export-folder.cjs');
    // A first run: no folder remembered yet, so exports go to the "Desktop", here the temporary folder.
    const app = { getPath: (name: string) => name === 'desktop' ? folder : directory };
    const refuse = async () => { throw new Error('The export folder needs no dialog.'); };
    const dialog = { showSaveDialog: refuse, showOpenDialog: refuse };
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const dispose = registerMediaHandlers({
      handle: (channel: string, handler: (...args: any[]) => Promise<any>) => handlers.set(channel, handler),
      getWindow: () => null, dialog, exportDicomDirectory: refuse,
      exportFolder: createExportFolder({ app, dialog, getWindow: () => null, t: (key: string) => key }),
    });
    exporters.push({ dispose });
    const exportOnce = async () => {
      const { id } = await handlers.get('video:begin')!('../../Bench: CT <1>.mp4', 10);
      await handlers.get('video:configure')!(id, settings);
      await handlers.get('video:append')!(id, sample(0x65, 1), true);
      return handlers.get('video:finish')!(id);
    };
    assert.equal(await exportOnce(), path.join(folder, 'Bench CT 1.mp4'));
    assert.equal(await exportOnce(), path.join(folder, 'Bench CT 1 (2).mp4'));
    assert.deepEqual((await readdir(folder)).sort(), ['Bench CT 1 (2).mp4', 'Bench CT 1.mp4']);
    assert.deepEqual(await readdir(directory), ['exports']);
  });
});

describe('encoder settings', () => {
  it('asks for an H.264 level that fits the size, rate and bit rate', () => {
    const codec = (width: number, height: number, fps: number) => videoEncoderConfigs(width, height, fps)[0].codec;
    assert.equal(codec(16, 16, 1), 'avc1.64001f');
    assert.equal(codec(1024, 768, 15), 'avc1.640020');
    assert.equal(codec(1920, 1080, 15), 'avc1.640029');
    assert.equal(codec(4096, 2304, 15), 'avc1.640033');
    assert.equal(codec(8192, 4320, 15), 'avc1.64003c');
  });

  it('tries software from High to Baseline, then any other encoder', () => {
    const configs = videoEncoderConfigs(640, 480, 15);
    assert.deepEqual(configs.map(config => `${config.codec.slice(5, 9)} ${config.hardwareAcceleration}`), [
      '6400 prefer-software', '4d40 prefer-software', '42e0 prefer-software', '6400 no-preference', '4d40 no-preference', '42e0 no-preference']);
    assert.equal(configs[0].bitrate, Math.round(640 * 480 * 15 * 1.2));
    assert.equal(videoEncoderConfigs(16, 16, 1)[0].bitrate, 1e6);
    assert.equal(configs[0].avc?.format, 'avc');
  });
});

describe('RGB to limited-range video levels', () => {
  const convert = (rgb: number[]) => {
    const rgba = new Uint8ClampedArray(16);
    for (let index = 0; index < 4; index++) rgba.set([...rgb, 255], index * 4);
    const output = new Uint8Array(6);
    rgbaToI420(rgba, 2, 2, output);
    return [output[0], output[4], output[5]];
  };

  it('keeps black, white and every gray neutral', () => {
    assert.deepEqual(convert([0, 0, 0]), [16, 128, 128]);
    assert.deepEqual(convert([255, 255, 255]), [235, 128, 128]);
    for (let gray = 0; gray < 256; gray++) {
      const [luma, blue, red] = convert([gray, gray, gray]);
      assert.equal(luma, 16 + Math.round(gray * 219 / 255));
      assert.deepEqual([blue, red], [128, 128]);
    }
  });

  it('uses the BT.709 matrix for colour', () => {
    assert.deepEqual(convert([255, 0, 0]), [63, 102, 240]);
    assert.deepEqual(convert([0, 255, 0]), [173, 42, 26]);
    assert.deepEqual(convert([0, 0, 255]), [32, 240, 118]);
  });

  it('averages colour over each two-by-two block', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const output = new Uint8Array(6);
    rgbaToI420(rgba, 2, 2, output);
    assert.deepEqual(Array.from(output.subarray(0, 4)), [63, 16, 16, 63]);
    assert.equal(output[4], 115);
    assert.equal(output[5], 184);
  });
});

const chrome = process.env.VEACOM_TEST_CHROME ?? (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : chromium.executablePath());

it('captures presented slice pixels and SVG overlays, restores the slice and cancels failed exports', { skip: !process.env.VEACOM_TEST_CHROME && !existsSync(chrome), timeout: 20000 }, async () => {
  const source = await readFile(new URL('../src/export-video.ts', import.meta.url), 'utf8');
  const javascript = stripTypeScriptTypes(source);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="viewport" style="position:relative;width:64px;height:64px;background:black">
      <canvas width="64" height="64" data-slice="2" style="position:absolute;inset:0"></canvas>
      <svg width="64" height="64" viewBox="0 0 64 64" data-slice="2" style="position:absolute;inset:0">
        <rect x="0" y="0" width="16" height="16" fill="white"/><text x="20" y="20" fill="white">2</text>
      </svg></div>`);
    const result = await page.evaluate(async javascript => {
      const url = URL.createObjectURL(new Blob([javascript], { type: 'text/javascript' }));
      const { exportViewportVideo, captureViewportPng } = await new Function('url', 'return import(url)')(url);
      URL.revokeObjectURL(url);
      const viewport = document.getElementById('viewport')!;
      const canvas = viewport.querySelector('canvas')!;
      const overlay = viewport.querySelector('svg')!;
      const colors = ['#ff0000', '#00ff00', '#0000ff'];
      let current = 2, cancelled = false, fail = false;
      const captured: number[][] = [], progress: number[] = [];
      const setSlice = (slice: number) => {
        current = slice;
        canvas.dataset.slice = String(slice);
        overlay.dataset.slice = String(slice);
        overlay.querySelector('text')!.textContent = String(slice);
        const context = canvas.getContext('2d')!;
        context.fillStyle = colors[slice]; context.fillRect(0, 0, 64, 64);
      };
      setSlice(current);
      // A stand-in encoder that keeps the frames: this checks the pixels it is given on any browser, with or
      // without an H.264 encoder. tools/check-video-encoder.cjs checks the real one.
      let drop = false, changeConfig = false, brokenStarts = 0, starts: string[] = [];
      const frames: { data: Uint8Array; width: number; height: number; timestamp: number; colorSpace: unknown; key: boolean }[] = [];
      const description = new Uint8Array([1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0]);
      class FakeFrame {
        data: Uint8Array; init: { codedWidth: number; codedHeight: number; timestamp: number; colorSpace: unknown };
        constructor(data: Uint8Array, init: FakeFrame['init']) { this.data = data.slice(); this.init = init; }
        close() {}
      }
      class FakeEncoder {
        static isConfigSupported = async (config: unknown) => ({ supported: true, config });
        state = 'unconfigured'; encodeQueueSize = 0; handlers; sent = 0; broken = false;
        constructor(handlers: { output: (chunk: unknown, metadata?: unknown) => void; error: (error: Error) => void }) { this.handlers = handlers; }
        configure(config: { hardwareAcceleration: string; codec: string }) {
          this.state = 'configured';
          starts.push(`${config.codec.slice(5, 9)} ${config.hardwareAcceleration}`);
          if (starts.length <= brokenStarts) this.broken = true;
        }
        encode(frame: FakeFrame, { keyFrame }: { keyFrame: boolean }) {
          frames.push({ data: frame.data, width: frame.init.codedWidth, height: frame.init.codedHeight, timestamp: frame.init.timestamp, colorSpace: frame.init.colorSpace, key: keyFrame });
          if (drop && this.sent === 1) { this.sent++; return; }
          const changed = changeConfig && this.sent === 1;
          this.handlers.output({ timestamp: frame.init.timestamp, type: keyFrame ? 'key' : 'delta', byteLength: 5,
            copyTo: (target: ArrayBuffer) => new Uint8Array(target).set([0, 0, 0, 1, 0x65]) },
            changed ? { decoderConfig: { description: new Uint8Array([1, 0x4d, 0, 0x1f, 0xff, 0xe1, 0, 0]) } }
              : this.sent === 0 || keyFrame ? { decoderConfig: { description } } : undefined);
          this.sent++;
        }
        async flush() { if (this.broken) { this.state = 'closed'; this.handlers.error(new Error('Broken driver')); throw new Error('Broken driver'); } }
        close() { this.state = 'closed'; }
        addEventListener() {}
      }
      Object.assign(window, { VideoEncoder: FakeEncoder, VideoFrame: FakeFrame });
      const written: { size: number; key: boolean }[] = [];
      let configured: { width: number; height: number; description: ArrayBuffer } | null = null;
      window.veacom = {
        beginVideo: async () => ({ id: 'test' }),
        configureVideo: async (_id: string, value: typeof configured) => { configured = value; },
        appendVideo: async (_id: string, sample: ArrayBuffer, key: boolean) => {
          if (fail) throw new Error('Encoder failed');
          written.push({ size: sample.byteLength, key });
        },
        finishVideo: async () => '/test/study.mp4',
        cancelVideo: async () => { cancelled = true; },
      } as unknown as Window['veacom'];
      const levels = (frame: (typeof frames)[number], x: number, y: number) => {
        const chroma = frame.width * frame.height + (y >> 1) * (frame.width >> 1) + (x >> 1);
        return [frame.data[y * frame.width + x], frame.data[chroma], frame.data[chroma + (frame.width >> 1) * (frame.height >> 1)]];
      };
      const take = () => { const taken = frames.map(frame => [...levels(frame, 32, 32), frame.data[5 * frame.width + 5]]); frames.length = 0; return taken; };
      const options = { viewport, setSlice, originalSlice: 2, frameCount: 3, fps: 10, onProgress: (done: number) => progress.push(done) };
      const destination = await exportViewportVideo(options);
      const restoredAfterSuccess = current;
      const firstMeta = { timestamps: frames.map(frame => frame.timestamp), keys: frames.map(frame => frame.key), size: [frames[0].width, frames[0].height], colorSpace: frames[0].colorSpace };
      const firstFrames = take();
      const firstWritten = [...written], firstConfigured = configured as { width: number; height: number; description: ArrayBuffer } | null;
      fail = true;
      let failure = '';
      try { await exportViewportVideo(options); } catch (error) { failure = (error as Error).message; }
      const restoredAfterError = current;
      fail = false; frames.length = 0;
      await exportViewportVideo({ ...options, range: { start: 1, end: 1 } });
      const rangeFrames = take();
      drop = true; cancelled = false;
      let dropFailure = '';
      try { await exportViewportVideo(options); } catch (error) { dropFailure = (error as Error).message; }
      const cancelledAfterDrop = cancelled;
      drop = false;
      changeConfig = true; cancelled = false;
      let configFailure = '';
      try { await exportViewportVideo(options); } catch (error) { configFailure = (error as Error).message; }
      const cancelledAfterConfig = cancelled;
      changeConfig = false;
      brokenStarts = 2; starts = [];
      const fellBack = await exportViewportVideo(options);
      const fallbackStarts = [...starts];
      brokenStarts = 99; starts = []; cancelled = false;
      let noEncoder = '';
      try { await exportViewportVideo(options); } catch (error) { noEncoder = (error as Error).message; }
      const noEncoderTried = starts.length, cancelledAfterNoEncoder = cancelled;
      brokenStarts = 0; frames.length = 0;
      viewport.style.width = '65px'; viewport.style.height = '63px';
      canvas.width = 65; canvas.height = 63; canvas.style.width = '65px'; canvas.style.height = '63px';
      setSlice(0);
      await exportViewportVideo({ ...options, originalSlice: 0, range: { start: 0, end: 0 }, includeOverlays: false });
      const odd = { size: [frames[0].width, frames[0].height], inside: frames[0].data[62 * frames[0].width + 63], padded: frames[0].data[63 * frames[0].width + 65] };
      viewport.style.width = '64px'; viewport.style.height = '64px';
      canvas.width = 64; canvas.height = 64; canvas.style.width = '64px'; canvas.style.height = '64px';
      setSlice(0);
      const resized = await captureViewportPng(viewport, { outputSize: { width: 128, height: 64 }, includeOverlays: false });
      const bitmap = await createImageBitmap(new Blob([resized], { type: 'image/png' }));
      const output = document.createElement('canvas'); output.width = bitmap.width; output.height = bitmap.height;
      const context = output.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
      const resizedPixels = [...context.getImageData(8, 32, 1, 1).data, ...context.getImageData(35, 5, 1, 1).data];
      // A notice appearing during the export shrinks the pane: the video keeps its first frame's size.
      frames.length = 0;
      await exportViewportVideo({ ...options, setSlice: (slice: number) => {
        viewport.style.height = slice === 1 ? '48px' : '64px';
        setSlice(slice);
      } });
      const videoSizes = frames.map(frame => [frame.width, frame.height]);
      return { destination, restoredAfterSuccess, restoredAfterError, failure, cancelled, captured: firstFrames, firstMeta, firstWritten, videoSizes,
        configured: firstConfigured && { width: firstConfigured.width, height: firstConfigured.height, description: [...new Uint8Array(firstConfigured.description)] },
        progress: progress.slice(0, 4), rangeFrames, dropFailure, cancelledAfterDrop, configFailure, cancelledAfterConfig, fellBack, fallbackStarts, noEncoder, noEncoderTried, cancelledAfterNoEncoder, odd, resizedDimensions: [output.width, output.height], resizedPixels };
    }, javascript);
    assert.equal(result.destination, '/test/study.mp4');
    // Luma and chroma of the slice's colour at the centre, and the luma of the white overlay corner.
    assert.deepEqual(result.captured, [[63, 102, 240, 235], [173, 42, 26, 235], [32, 240, 118, 235]]);
    assert.deepEqual(result.firstMeta.timestamps, [0, 100000, 200000]);
    assert.deepEqual(result.firstMeta.keys, [true, false, false]);
    assert.deepEqual(result.firstMeta.size, [64, 64]);
    assert.deepEqual(result.firstMeta.colorSpace, { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false });
    assert.deepEqual(result.firstWritten, [{ size: 5, key: true }, { size: 5, key: false }, { size: 5, key: false }]);
    assert.deepEqual(result.configured, { width: 64, height: 64, description: [1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0] });
    assert.ok(result.dropFailure.includes('could not be encoded'));
    assert.equal(result.cancelledAfterDrop, true);
    // A changed configuration would corrupt the frames after it, so it stops the export.
    assert.ok(result.configFailure.includes('could not be encoded'));
    assert.equal(result.cancelledAfterConfig, true);
    // An encoder that says yes and then fails to start doesn't stop the export while another one works.
    assert.equal(result.fellBack, '/test/study.mp4');
    assert.deepEqual(result.fallbackStarts, ['6400 prefer-software', '4d40 prefer-software', '42e0 prefer-software']);
    assert.ok(result.noEncoder.includes('cannot encode a video of this size'));
    assert.equal(result.noEncoderTried, 6);
    assert.equal(result.cancelledAfterNoEncoder, true);
    // An odd viewport is padded with black to the even size H.264 needs.
    assert.deepEqual(result.odd.size, [66, 64]);
    assert.equal(result.odd.inside, 63);
    assert.equal(result.odd.padded, 16);
    assert.deepEqual(result.progress, [0, 1, 2, 3]);
    assert.equal(result.restoredAfterSuccess, 2);
    assert.equal(result.restoredAfterError, 2);
    assert.equal(result.failure, 'Encoder failed');
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.rangeFrames, [[173, 42, 26, 235]]);
    assert.deepEqual(result.resizedDimensions, [128, 64]);
    assert.deepEqual(result.videoSizes, [[64, 64], [64, 64], [64, 64]]);
    assert.deepEqual(result.resizedPixels, [0, 0, 0, 255, 255, 0, 0, 255]);
  } finally { await browser.close(); }
});

it('creates an ISO from the native nested DICOMDIR folder and preserves export warnings', { skip: !['darwin', 'win32'].includes(process.platform), timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'veacom-media-test-'));
  directories.push(directory);
  const destination = path.join(directory, 'study.iso');
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let staging = '';
  const burnedIn = { code: 'export.burnedIn', params: { name: 'IM000001' }, text: 'Pixel text requires review.' };
  const dispose = registerMediaHandlers({
    handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler),
    getWindow: () => null,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) },
    exportDicomDirectory: async (seriesIds: string[], temporary: string, anonymize: boolean, decompress: boolean) => {
      assert.deepEqual(seriesIds, ['test-series', 'second-series']);
      assert.equal(anonymize, true);
      assert.equal(decompress, true);
      staging = temporary;
      const directory = path.join(temporary, 'VEACOM_test');
      await mkdir(directory);
      await writeFile(path.join(directory, 'DICOMDIR'), 'Synthetic directory fixture');
      return { directory, warnings: ['Pixel text requires review.'], warningNotes: [burnedIn] };
    },
  });
  exporters.push({ dispose });
  const result = await handlers.get('media:iso')!(['test-series', 'second-series', 'test-series'], { anonymize: true, decompress: true, label: 'SYNTHETIC' });
  // The engine's warnings keep their notes, so the interface can translate them.
  assert.deepEqual(result, { path: destination, warnings: ['Pixel text requires review.'], warningNotes: [burnedIn] });
  const iso = await readFile(destination);
  assert.equal(iso.subarray(16 * 2048 + 1, 16 * 2048 + 6).toString(), 'CD001');
  assert.equal(iso.includes(Buffer.from('Synthetic directory fixture')), true);
  assert.deepEqual(await readdir(directory), ['study.iso']);
  assert.equal(existsSync(staging), false);
});

it('reports a saved ISO as saved when its temporary DICOM copy cannot be removed yet', { skip: !['darwin', 'win32'].includes(process.platform), timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'veacom-media-test-'));
  directories.push(directory);
  const destination = path.join(directory, 'study.iso');
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let staging = '';
  const dispose = registerMediaHandlers({
    handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler),
    getWindow: () => null,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) },
    exportDicomDirectory: async (_seriesIds: string[], temporary: string) => {
      staging = temporary;
      const folder = path.join(temporary, 'VEACOM_test');
      await mkdir(folder);
      await writeFile(path.join(folder, 'DICOMDIR'), 'Synthetic directory fixture');
      return { directory: folder, warnings: [] };
    },
  });
  exporters.push({ dispose });
  const realRm = fsPromises.rm;
  mock.method(process.stderr, 'write', () => true);
  mock.method(fsPromises, 'rm', async (...args: any[]) => {
    if (String(args[0]).includes('veacom-dicom-')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return realRm(...args);
  });
  try {
    assertFields(await handlers.get('media:iso')!(['test-series'], { anonymize: false, label: 'SYNTHETIC' }), { path: destination });
    // The ISO's own temporary folder next to it still goes.
    assert.deepEqual(await readdir(directory), ['study.iso']);
  } finally {
    mock.restoreAll();
    await rm(staging, { recursive: true, force: true });
  }
});

it('cancels a disc export: no ISO is built from its DICOM copy and nothing is left', { skip: !['darwin', 'win32'].includes(process.platform), timeout: 20000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'veacom-media-test-'));
  directories.push(directory);
  const destination = path.join(directory, 'study.iso');
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let staging = '', release!: () => void;
  const copied = new Promise<void>(resolve => { release = resolve; });
  const dispose = registerMediaHandlers({
    handle: (channel: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(channel, handler),
    getWindow: () => null,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: destination }) },
    exportDicomDirectory: async (_seriesIds: string[], temporary: string) => {
      staging = temporary;
      const folder = path.join(temporary, 'VEACOM_test');
      await mkdir(folder);
      await writeFile(path.join(folder, 'DICOMDIR'), 'Synthetic directory fixture');
      await copied; // the engine's copy cannot be stopped: it ends, then the ISO step sees the cancel
      return { directory: folder, warnings: [] };
    },
  });
  exporters.push({ dispose });
  const running = handlers.get('media:iso')!(['test-series'], { anonymize: false, label: 'SYNTHETIC' });
  await waitFor(() => assert.notEqual(staging, ''));
  await handlers.get('media:cancel')!();
  release();
  await assert.rejects(running, { message: /cancelled/ });
  assert.deepEqual(await readdir(directory), []);
  assert.equal(existsSync(staging), false);
  // A later disc export starts normally.
  assertFields(await handlers.get('media:iso')!(['test-series'], { anonymize: false, label: 'SYNTHETIC' }), { path: destination });
});
