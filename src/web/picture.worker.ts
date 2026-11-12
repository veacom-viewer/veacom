// The picture decoder (web/engine/src/pictures.rs), started by the page (src/web/bridge.ts) on the threads build's module
// and memory, like the engine's helpers. It takes each PNG, JPEG or BMP the engine reads and answers with the browser's
// own decoders and the options of the desktop app's sandboxed renderers (electron/picture-preload.cjs), so a picture
// gives the same samples in both. The engine never parses these formats itself.
//
// Sizes come from headers, as on the desktop. A Worker has no <img>, which the desktop also loads to check that Chromium
// reads the header the same way: a picture whose data Chromium cannot read fails when it is shown, not at import.
//
// The threads build aborts on a panic. Then the engine's calls throw here, and the page hears of it and replaces the
// engine, as for a helper.
import { headerSize, invalidHeader, pngHasOrientation, type PictureSize } from './pictureHeader';

type ThreadedEngine = typeof import('../../web/engine/pkg-threads/veacom_web_engine.js');
// The bytes are a copy out of the shared memory (web/engine/src/pictures.rs), which a Blob can hold.
interface Task { id: number; want: 'probe' | 'size' | 'pixels'; bytes: Uint8Array<ArrayBuffer> }

// The engine's frame limit, in RGB samples (native/src/pictures.rs MAX_SAMPLES).
const MAX_SAMPLES = 64 * 1024 * 1024;
// Pictures decoded at once, as in each desktop renderer (electron/picture-decoder.cjs). The engine bounds the bytes
// they hold.
const CONCURRENCY = 8;
const IDLE_WAIT_MS = 1000;

type Shared = { module: WebAssembly.Module; memory: WebAssembly.Memory };
const scope = self as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent<Shared>) => void) | null };

const tooLarge = () => new Error('Frame exceeds the supported 64 million sample limit');

/** The size the picture is shown at. Only a PNG with its own orientation is decoded for it, unless its header is beyond
 * the frame limit: then the engine refuses it by that size. */
async function shownSize(bytes: Uint8Array<ArrayBuffer>, probe: boolean): Promise<PictureSize> {
  const { kind, width, height } = headerSize(bytes, probe);
  if (kind !== 'png' || width * height * 3 > MAX_SAMPLES || !pngHasOrientation(bytes)) return { width, height };
  const bitmap = await createImageBitmap(new Blob([bytes])).catch(() => { throw invalidHeader(); });
  try {
    // The header's size, turned or not, as the desktop's <img> must give it.
    if (!((bitmap.width === width && bitmap.height === height) || (bitmap.width === height && bitmap.height === width))) throw invalidHeader();
    return { width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}

/** Red, green, blue and alpha samples, rows top first, read back as the desktop's renderers read them. */
async function pixels(bytes: Uint8Array<ArrayBuffer>): Promise<PictureSize & { rgba: Uint8Array }> {
  const header = headerSize(bytes, false);
  if (header.width * header.height * 3 > MAX_SAMPLES) throw tooLarge();
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const { width, height } = bitmap;
    if (width * height * 3 > MAX_SAMPLES) throw tooLarge();
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The picture could not be drawn');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    return { width, height, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally { bitmap.close(); }
}

async function answer(engine: ThreadedEngine, { id, want, bytes }: Task): Promise<void> {
  try {
    if (want === 'pixels') {
      const { width, height, rgba } = await pixels(bytes);
      engine.pictureDecoded(id, width, height, rgba);
    } else {
      const { width, height } = await shownSize(bytes, want === 'probe');
      engine.pictureDecoded(id, width, height, new Uint8Array(0));
    }
  } catch (error) {
    // A probe that fails is retried with the whole file (native/src/pictures.rs `size`).
    engine.pictureFailed(id, want === 'probe' ? 'Incomplete picture header' : error instanceof Error ? error.message : String(error));
  }
}

/** Takes pictures for ever: up to CONCURRENCY at once, waiting in the engine while there are none. */
async function serve(engine: ThreadedEngine): Promise<never> {
  const running = new Set<Promise<void>>();
  for (;;) {
    // Waiting blocks this thread, so it only waits while no decode needs it to finish.
    const task = running.size < CONCURRENCY ? engine.pictureNext(running.size ? 0 : IDLE_WAIT_MS) as Task | undefined : undefined;
    if (task) {
      const job: Promise<void> = answer(engine, task).finally(() => running.delete(job));
      running.add(job);
    } else if (running.size) {
      await Promise.race(running);
    }
  }
}

async function start({ module, memory }: Shared): Promise<void> {
  try {
    const engine: ThreadedEngine = await import('../../web/engine/pkg-threads/veacom_web_engine.js');
    engine.initSync({ module, memory });
    engine.pictureDecoderStarted();
    scope.postMessage({ type: 'ready' });
    await serve(engine);
  } catch (error) {
    scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
}

scope.onmessage = ({ data }) => {
  scope.onmessage = null;
  void start(data);
};
