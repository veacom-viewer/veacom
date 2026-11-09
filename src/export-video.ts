export interface ViewportVideoOptions {
  viewport: HTMLElement;
  setSlice: (slice: number) => void | Promise<void>;
  /** The series being exported. The pane can be given another series while the slices are captured (the series
   * list, toolbar and keyboard stay usable); a slice drawn from any other series stops the export. */
  seriesId?: string;
  originalSlice: number;
  frameCount: number;
  fps: number;
  suggestedName?: string;
  range?: { start: number; end: number };
  outputSize?: { width: number; height: number };
  includeOverlays?: boolean;
  /** Basic overlays include only viewer-generated orientation and crosshair markings. */
  hideIdentity?: boolean;
  /** From the range's last slice to its first (the other way through the body). */
  descending?: boolean;
  /** A slice's number as the reader sees it (pictures are named by it); the index + 1 if not given. */
  numberOf?: (slice: number) => number;
  /** Put before each picture's name. */
  prefix?: string;
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}

/** English text plus the interface's message key (src/i18n). This module has no imports, because a test
 * loads it on its own in a browser; the dialog shows the error in the current language from the key. */
function videoError(key: string, english: string, params?: Record<string, string | number>): Error {
  return Object.assign(new Error(english), { messageKey: key, messageParams: params });
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Video export cancelled.', 'AbortError');
}

function nextFrame(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let frame: number;
    const cleanup = () => { clearTimeout(timeout); cancelAnimationFrame(frame); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new DOMException('Video export cancelled.', 'AbortError')); };
    const timeout = setTimeout(() => { cleanup(); reject(videoError('video.stoppedDrawing', 'The viewer stopped drawing. Keep its window visible during export.')); }, 10000);
    signal?.addEventListener('abort', abort, { once: true });
    frame = requestAnimationFrame(() => { cleanup(); resolve(); });
  });
}

/** Stops the export when the pane draws another series than the one being exported. */
function checkSeries(layer: HTMLElement | SVGElement | null | undefined, seriesId?: string): void {
  const shown = layer?.dataset.seriesId;
  if (seriesId !== undefined && shown !== undefined && shown !== seriesId) {
    throw videoError('video.paneChanged', 'Another series was opened in the pane while it was being exported. The export was stopped and nothing was kept.');
  }
}

export async function waitForSlice(viewport: HTMLElement, slice: number, signal?: AbortSignal, seriesId?: string): Promise<void> {
  const deadline = performance.now() + 10000;
  do {
    await nextFrame(signal);
    const canvas = viewport.querySelector<HTMLCanvasElement>('canvas[data-slice]');
    const overlay = viewport.querySelector<SVGSVGElement>('svg[data-slice]');
    if (!canvas) throw videoError('video.selectViewport', 'Select an image viewport to export a slice video.');
    checkSeries(canvas, seriesId); checkSeries(overlay, seriesId);
    if (canvas.dataset.slice === String(slice) && overlay?.dataset.slice === String(slice)) {
      await nextFrame(signal);
      return;
    }
    const error = viewport.querySelector('[role="alert"]');
    if (error) throw error.textContent.trim() ? new Error(error.textContent.trim()) : videoError('video.renderFailed', 'The selected image could not be rendered.');
  } while (performance.now() < deadline);
  throw videoError('video.sliceMissing', `The viewer did not present slice ${slice + 1}. No video was saved.`, { number: slice + 1 });
}

const svgProperties = ['color', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'font-family', 'font-size', 'font-style', 'font-weight', 'letter-spacing', 'text-anchor',
  'dominant-baseline', 'paint-order', 'vector-effect', 'opacity', 'visibility', 'display'];

async function svgImage(source: SVGSVGElement, hideIdentity = false): Promise<{ image: HTMLImageElement; release: () => void }> {
  const copy = source.cloneNode(true) as SVGSVGElement;
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [copy, ...copy.querySelectorAll('*')];
  originals.forEach((node, index) => {
    const style = getComputedStyle(node), target = copies[index] as SVGElement;
    for (const property of svgProperties) target.style.setProperty(property, style.getPropertyValue(property));
  });
  if (hideIdentity) copy.replaceChildren(...copy.querySelectorAll('.orientation-labels, [data-crosshair-marker]'));
  const bounds = source.getBoundingClientRect();
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(bounds.width));
  copy.setAttribute('height', String(bounds.height));
  copy.style.width = `${bounds.width}px`;
  copy.style.height = `${bounds.height}px`;
  copy.style.opacity = '1';
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }));
  const image = new Image();
  image.src = url;
  try { await image.decode(); return { image, release: () => URL.revokeObjectURL(url) }; }
  catch (error) { URL.revokeObjectURL(url); throw error; }
}

/** What a capture of a series' slice must find drawn: checked with nothing awaited before the pixels are copied. */
interface Expected { slice: number; seriesId?: string }

/** Draws the displayed pixels and measurement/orientation overlays at the viewport's actual resolution. */
async function captureViewportCanvas(viewport: HTMLElement, options: Pick<ViewportVideoOptions, 'outputSize' | 'includeOverlays' | 'hideIdentity'>, expected?: Expected): Promise<HTMLCanvasElement> {
  const bounds = viewport.getBoundingClientRect();
  const source = viewport.querySelector('canvas');
  if (!viewport.isConnected || !source || !bounds.width || !bounds.height) throw videoError('video.viewportHidden', 'The image viewport is not visible.');
  if (expected) {
    const image = viewport.querySelector<HTMLCanvasElement>('canvas[data-slice]'), overlay = viewport.querySelector<SVGSVGElement>('svg[data-slice]');
    checkSeries(image, expected.seriesId); checkSeries(overlay, expected.seriesId);
    if (image?.dataset.slice !== String(expected.slice) || (overlay && overlay.dataset.slice !== String(expected.slice))) {
      throw videoError('video.sliceMissing', `The viewer did not present slice ${expected.slice + 1}. No video was saved.`, { number: expected.slice + 1 });
    }
  }
  const alert = viewport.querySelector('[role="alert"]');
  if (alert) throw alert.textContent.trim() ? new Error(alert.textContent.trim()) : videoError('video.imageFailed', 'The image could not be rendered.');
  const sourceBounds = source.getBoundingClientRect();
  const requested = options.outputSize;
  if (requested && (!Number.isInteger(requested.width) || !Number.isInteger(requested.height)
    || requested.width < 16 || requested.height < 16)) throw videoError('video.sizeInvalid', 'Output width and height must be whole numbers of at least 16 pixels.');
  const scale = requested ? Math.min(requested.width / bounds.width, requested.height / bounds.height) : source.width / sourceBounds.width;
  const canvas = document.createElement('canvas');
  canvas.width = requested?.width ?? Math.round(bounds.width * scale);
  canvas.height = requested?.height ?? Math.round(bounds.height * scale);
  if (!Number.isFinite(scale) || canvas.width < 1 || canvas.height < 1 || canvas.width > 8192 || canvas.height > 8192
    || canvas.width * canvas.height > 36000000) throw videoError('video.viewportTooLarge', 'Resize the viewport to at most 8192 pixels per side before exporting.');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw videoError('video.canvasFailed', 'Could not create the video capture canvas.');
  context.fillStyle = '#000000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate((canvas.width - bounds.width * scale) / 2, (canvas.height - bounds.height * scale) / 2);
  context.scale(scale, scale);
  context.fillStyle = getComputedStyle(viewport).backgroundColor || '#000000';
  context.fillRect(0, 0, bounds.width, bounds.height);
  for (const layer of viewport.querySelectorAll<HTMLCanvasElement | SVGSVGElement | HTMLElement>('canvas,svg,[data-export-label]')) {
    if (layer.closest('[data-export-exclude]')) continue;
    if (options.includeOverlays === false && !(layer instanceof HTMLCanvasElement)) continue;
    if (options.hideIdentity && !(layer instanceof HTMLCanvasElement || layer instanceof SVGSVGElement)) continue;
    const style = getComputedStyle(layer), rect = layer.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || !rect.width || !rect.height) continue;
    const x = rect.left - bounds.left, y = rect.top - bounds.top;
    context.save();
    context.globalAlpha = Number(style.opacity);
    if (layer instanceof HTMLCanvasElement) context.drawImage(layer, x, y, rect.width, rect.height);
    else if (layer instanceof SVGSVGElement) {
      const image = await svgImage(layer, options.hideIdentity);
      try { context.drawImage(image.image, x, y, rect.width, rect.height); }
      finally { image.release(); }
    } else {
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.fillStyle = style.color;
      context.textBaseline = 'top';
      const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
      const lines = layer.innerText.split('\n');
      lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight, rect.width));
    }
    context.restore();
  }
  return canvas;
}

export async function captureViewportPng(viewport: HTMLElement, options: Pick<ViewportVideoOptions, 'outputSize' | 'includeOverlays' | 'hideIdentity'> & { type?: 'image/png' | 'image/jpeg'; quality?: number; expected?: Expected } = {}):Promise<ArrayBuffer> {
  const canvas = await captureViewportCanvas(viewport, options, options.expected);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(videoError('video.captureFailed', 'Could not capture the displayed image.')), options.type ?? 'image/png', options.quality));
  return blob.arrayBuffer();
}

// Target bits per output pixel per frame. The paired desktop test measures encoded bytes and
// decodes a CT frame to check it against the uncompressed export.
const BITS_PER_PIXEL = 0.30;
const MAX_BITRATE = 240e6;
const MAX_QUEUED_FRAMES = 2;
const MAX_QUEUED_WRITES = 8;
// H.264 levels: level_idc, frame macroblocks, macroblocks per second, and base profile bit rate.
const LEVELS: [number, number, number, number][] = [[0x1f, 3600, 108000, 14e6], [0x20, 5120, 216000, 20e6], [0x28, 8192, 245760, 20e6],
  [0x29, 8192, 245760, 50e6], [0x2a, 8704, 522240, 50e6], [0x32, 22080, 589824, 135e6], [0x33, 36864, 983040, 240e6],
  [0x34, 36864, 2073600, 240e6], [0x3c, 139264, 4177920, 240e6], [0x3d, 139264, 8355840, 480e6], [0x3e, 139264, 16711680, 800e6]];
const hex = (value: number) => value.toString(16).padStart(2, '0');

/**
 * The encoder settings to try, best first: High, then Main, then Baseline, in software and then on any encoder.
 * Software comes first because it gives every computer the same result and needs no graphics driver. At the same
 * rate on a noisy CT it gave 40.2 dB on both Mac and Windows, where the hardware encoders gave 41.5 dB and 35.5 dB.
 */
export function videoEncoderConfigs(width: number, height: number, fps: number): VideoEncoderConfig[] {
  const across = Math.ceil(width / 16), down = Math.ceil(height / 16), macroblocks = across * down;
  const bitrate = Math.min(MAX_BITRATE, Math.max(1e6, Math.round(width * height * fps * BITS_PER_PIXEL)));
  const level = LEVELS.find(([, frame, rate, bits]) => macroblocks <= frame && macroblocks * fps <= rate && bitrate <= bits
    && across ** 2 <= frame * 8 && down ** 2 <= frame * 8) ?? LEVELS[LEVELS.length - 1];
  const settings: VideoEncoderConfig[] = [];
  for (const hardwareAcceleration of ['prefer-software', 'no-preference'] as const) {
    for (const profile of ['6400', '4d40', '42e0']) {
      settings.push({ codec: `avc1.${profile}${hex(level[0])}`, width, height, bitrate, framerate: fps, hardwareAcceleration,
        bitrateMode: 'variable', latencyMode: 'quality', avc: { format: 'avc' } });
    }
  }
  return settings;
}

/**
 * Canvas RGBA to limited-range BT.709 I420, here rather than in the encoder so that every computer gets the
 * same levels. Gray stays exactly neutral. Width and height are even; pixels beyond the data's edge are black.
 */
export function rgbaToI420(rgba: Uint8ClampedArray, width: number, height: number, output: Uint8Array): void {
  const chromaStart = width * height, chromaWidth = width >> 1, redStart = chromaStart + chromaWidth * (height >> 1);
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let red = 0, green = 0, blue = 0;
      for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
        const source = ((y + row) * width + x + column) * 4;
        const r = rgba[source], g = rgba[source + 1], b = rgba[source + 2];
        red += r; green += g; blue += b;
        output[(y + row) * width + x + column] = 16 + ((11966 * r + 40254 * g + 4064 * b + 32768) >> 16);
      }
      const chroma = (y >> 1) * chromaWidth + (x >> 1);
      output[chromaStart + chroma] = 128 + ((-6596 * red - 22189 * green + 28785 * blue + 131072) >> 18);
      output[redStart + chroma] = 128 + ((28785 * red - 26145 * green - 2640 * blue + 131072) >> 18);
    }
  }
}

const COLOR_SPACE: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false };

/**
 * The first encoder that starts. A supported answer doesn't promise that: an encoder can still fail here, and
 * the flush reports that while the next setting can still be tried.
 */
async function openEncoder(width: number, height: number, fps: number, output: EncodedVideoChunkOutputCallback, onError: () => void): Promise<VideoEncoder> {
  if (typeof VideoEncoder !== 'undefined') {
    for (const config of videoEncoderConfigs(width, height, fps)) {
      if (!(await VideoEncoder.isConfigSupported(config).catch(() => null))?.supported) continue;
      let started = false;
      const encoder = new VideoEncoder({ output, error: () => { if (started) onError(); } });
      try {
        encoder.configure(config);
        await encoder.flush();
        started = true;
        return encoder;
      } catch {
        if (encoder.state !== 'closed') encoder.close();
      }
    }
  }
  throw videoError('video.sizeUnsupported', 'This computer cannot encode a video of this size. Choose a smaller output size.');
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

export async function exportViewportVideo(options: ViewportVideoOptions): Promise<string | null> {
  const { viewport, setSlice, originalSlice, frameCount, fps, signal, onProgress } = options;
  const bridge = window.veacom;
  if (!bridge) throw videoError('video.desktopRequired', 'Video export requires the VEAcom desktop application.');
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 60000 || !Number.isInteger(originalSlice)
    || originalSlice < 0 || originalSlice >= frameCount) throw videoError('video.invalidRange', 'Invalid slice range for video export.');
  const start = options.range?.start ?? 0, end = options.range?.end ?? frameCount - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= frameCount) throw videoError('video.chooseRange', 'Choose a valid first and last slice.');
  const total = end - start + 1;
  checkAbort(signal);
  const job = await bridge.beginVideo(options.suggestedName ?? 'VEAcom-video', fps);
  if (!job) return null;
  let finished = false, encoder: VideoEncoder | null = null, failure: unknown = null, wake: (() => void) | null = null;
  let writes: Promise<void> = Promise.resolve(), queuedWrites = 0, samples = 0, lastTimestamp = -1, configuration: Uint8Array | null = null, width = 0, height = 0;
  const fail = (error: unknown) => { failure ??= error; wake?.(); };
  const encodingFailed = () => videoError('video.encodingFailed', 'The video could not be encoded. No file was saved.');
  const throwIfFailed = () => { if (failure) throw failure; };
  const output: EncodedVideoChunkOutputCallback = (chunk, metadata) => {
    // A reordered or dropped frame would put slices in the wrong place, so it stops the export.
    if (chunk.timestamp <= lastTimestamp) { fail(encodingFailed()); return; }
    lastTimestamp = chunk.timestamp;
    samples++;
    const sample = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(sample);
    const key = chunk.type === 'key';
    let description: ArrayBuffer | null = null;
    const source = metadata?.decoderConfig?.description;
    if (source) {
      const bytes = (ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source)).slice();
      // The file holds one configuration, so a changed one would corrupt every frame after it.
      if (configuration && !sameBytes(configuration, bytes)) { fail(encodingFailed()); return; }
      if (!configuration) { configuration = bytes; description = bytes.buffer; }
    }
    queuedWrites++;
    writes = writes.then(async () => {
      if (failure) return;
      if (description) await bridge.configureVideo(job.id, { width, height, description });
      await bridge.appendVideo(job.id, sample, key);
    }).catch(fail).finally(() => { queuedWrites--; wake?.(); });
  };
  const abort = () => { void bridge.cancelVideo(job.id).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkAbort(signal);
    await document.fonts.ready;
    onProgress?.(0, total);
    let pixels: Uint8Array | null = null;
    const captureOptions = { ...options };
    for (let step = 0; step < total; step++) {
      const slice = options.descending ? end - step : start + step;
      checkAbort(signal);
      await setSlice(slice);
      await waitForSlice(viewport, slice, signal, options.seriesId);
      const canvas = await captureViewportCanvas(viewport, captureOptions, { slice, seriesId: options.seriesId });
      checkAbort(signal);
      const frameWidth = canvas.width + canvas.width % 2, frameHeight = canvas.height + canvas.height % 2;
      if (!encoder) {
        width = frameWidth; height = frameHeight;
        // Keep one MP4 size when the viewer shows or dismisses a notice during the export.
        captureOptions.outputSize ??= { width: canvas.width, height: canvas.height };
        encoder = await openEncoder(width, height, fps, output, () => fail(encodingFailed()));
        pixels = new Uint8Array(width * height * 3 / 2);
      } else if (frameWidth !== width || frameHeight !== height) throw videoError('video.sizeChanged', 'Keep the viewport size unchanged while exporting.');
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw videoError('video.canvasFailed', 'Could not create the video capture canvas.');
      rgbaToI420(context.getImageData(0, 0, width, height).data, width, height, pixels!);
      // Frames are numbered in the order they play, which is the slice order reversed when descending.
      const frame = new VideoFrame(pixels!, { format: 'I420', codedWidth: width, codedHeight: height, colorSpace: COLOR_SPACE,
        timestamp: Math.round(step * 1e6 / fps), duration: Math.round(1e6 / fps) });
      try { encoder.encode(frame, { keyFrame: step % (fps * 2) === 0 }); }
      catch (error) { throw failure ?? error; }
      finally { frame.close(); }
      while (!failure && (encoder.encodeQueueSize > MAX_QUEUED_FRAMES || queuedWrites > MAX_QUEUED_WRITES)) {
        const active = encoder;
        await new Promise<void>(resolve => {
          wake = resolve;
          active.addEventListener('dequeue', () => resolve(), { once: true });
        });
        wake = null;
      }
      throwIfFailed();
      onProgress?.(step + 1, total);
    }
    checkAbort(signal);
    await encoder!.flush().catch(() => fail(encodingFailed()));
    await writes;
    throwIfFailed();
    if (samples !== total) throw encodingFailed();
    checkAbort(signal);
    const destination = await bridge.finishVideo(job.id);
    finished = true;
    return destination;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (encoder && encoder.state !== 'closed') encoder.close();
    await writes;
    try { if (!finished) await bridge.cancelVideo(job.id); }
    finally { await setSlice(originalSlice); }
  }
}

export interface ViewportImagesOptions extends Omit<ViewportVideoOptions, 'fps'> {
  format: 'png' | 'jpeg';
  /** Into the remembered export folder (no folder asked for). */
  here?: boolean;
  /** JPEG quality, 0.5 to 1. */
  quality?: number;
}

/** The slices of the selected pane saved as PNG or JPEG pictures, one file per slice, as shown (VEAcom Next's series
 * picture export). The pane goes back to the slice it showed. */
export async function exportViewportImages(options: ViewportImagesOptions): Promise<string | null> {
  const { viewport, setSlice, originalSlice, frameCount, signal, onProgress, format } = options;
  const bridge = window.veacom;
  if (!bridge?.beginImages || !bridge.appendImage || !bridge.finishImages || !bridge.cancelImages) throw videoError('video.desktopRequired', 'Video export requires the VEAcom desktop application.');
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 60000 || !Number.isInteger(originalSlice)
    || originalSlice < 0 || originalSlice >= frameCount) throw videoError('video.invalidRange', 'Invalid slice range for video export.');
  const start = options.range?.start ?? 0, end = options.range?.end ?? frameCount - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= frameCount) throw videoError('video.chooseRange', 'Choose a valid first and last slice.');
  const total = end - start + 1, digits = Math.max(3, String(frameCount).length), numberOf = options.numberOf ?? ((slice: number) => slice + 1);
  checkAbort(signal);
  const job = await bridge.beginImages(options.suggestedName ?? 'VEAcom', options.here);
  if (!job) return null;
  let finished = false;
  try {
    await document.fonts.ready;
    onProgress?.(0, total);
    for (let step = 0; step < total; step++) {
      const slice = options.descending ? end - step : start + step;
      checkAbort(signal);
      await setSlice(slice);
      await waitForSlice(viewport, slice, signal, options.seriesId);
      const data = await captureViewportPng(viewport, { ...options, expected: { slice, seriesId: options.seriesId }, type: format === 'jpeg' ? 'image/jpeg' : 'image/png', quality: format === 'jpeg' ? options.quality ?? 0.92 : undefined });
      checkAbort(signal);
      // Named by the slice number the reader sees, after the prefix chosen.
      await bridge.appendImage(job.id, `${options.prefix ?? ''}${String(numberOf(slice)).padStart(digits, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`, data);
      onProgress?.(step + 1, total);
    }
    const directory = await bridge.finishImages(job.id);
    finished = true;
    return directory;
  } finally {
    try { if (!finished) await bridge.cancelImages(job.id); }
    finally { await setSlice(originalSlice); }
  }
}
