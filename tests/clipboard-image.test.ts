import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { copyCanvas } from '../src/ui/clipboard';
import { restoreGlobals, stubGlobal } from './support';
import { createRequire } from 'node:module';

interface Picture { width: number; height: number; pixels: ArrayBuffer | ArrayBufferView }
interface Bitmap { buffer: Buffer; width: number; height: number }
interface Written { buffer: Buffer; size: { width: number; height: number } }

const require = createRequire(import.meta.url);
const { MAX_SIDE, clipboardBitmap, writeClipboardImage } = require('../electron/clipboard-image.cjs') as {
  MAX_SIDE: number;
  clipboardBitmap: (picture: unknown) => Bitmap;
  writeClipboardImage: (picture: unknown, electron: { clipboard: { writeImage: (image: Written) => void }; nativeImage: { createFromBitmap: (buffer: Buffer, size: { width: number; height: number }) => Written & { isEmpty: () => boolean } } }) => void;
};

const rgba = (...bytes: number[]) => new Uint8Array(bytes).buffer;

describe('a picture for the clipboard', () => {
  it('turns the page\'s RGBA pixels into an opaque bitmap in blue, green, red order', () => {
    const bitmap = clipboardBitmap({ width: 2, height: 1, pixels: rgba(10, 20, 30, 0, 200, 150, 100, 255) } satisfies Picture);
    assert.deepEqual([...bitmap.buffer], [30, 20, 10, 255, 100, 150, 200, 255]);
    assert.deepEqual([bitmap.width, bitmap.height], [2, 1]);
  });

  it('takes a view of the pixels as well as their buffer', () => {
    const padded = new Uint8Array([9, 9, 1, 2, 3, 4, 9]);
    const bitmap = clipboardBitmap({ width: 1, height: 1, pixels: new Uint8ClampedArray(padded.buffer, 2, 4) } satisfies Picture);
    assert.deepEqual([...bitmap.buffer], [3, 2, 1, 255]);
  });

  it('refuses a size that is not whole, positive and within the limits, and pixels that do not fill it', () => {
    const one = rgba(1, 2, 3, 4);
    const refused: unknown[] = [undefined, null, 'picture', {}, { width: 1, height: 1 }, { width: 1, height: 1, pixels: 'abcd' },
      { width: 0, height: 1, pixels: one }, { width: 1, height: -1, pixels: one }, { width: 1.5, height: 1, pixels: one },
      { width: '1', height: 1, pixels: one }, { width: MAX_SIDE + 1, height: 1, pixels: one }, { width: 7000, height: 7000, pixels: one },
      { width: 2, height: 1, pixels: one }, { width: 1, height: 1, pixels: rgba(1, 2, 3, 4, 5) }];
    for (const picture of refused) assert.throws(() => clipboardBitmap(picture), /Invalid picture/, JSON.stringify(picture));
  });

  it('writes the bitmap to the clipboard as an image, and nothing when the image is empty', () => {
    const written: Written[] = [];
    const clipboard = { writeImage: (image: Written) => { written.push(image); } };
    const image = (empty: boolean) => ({ createFromBitmap: (buffer: Buffer, size: { width: number; height: number }) => ({ buffer, size, isEmpty: () => empty }) });
    writeClipboardImage({ width: 1, height: 1, pixels: rgba(1, 2, 3, 4) }, { clipboard, nativeImage: image(false) });
    assert.equal(written.length, 1);
    assert.deepEqual(written[0].size, { width: 1, height: 1 });
    assert.deepEqual([...written[0].buffer], [3, 2, 1, 255]);
    assert.throws(() => writeClipboardImage({ width: 1, height: 1, pixels: rgba(1, 2, 3, 4) }, { clipboard, nativeImage: image(true) }), /Invalid picture/);
    assert.throws(() => writeClipboardImage({ width: 1, height: 2, pixels: rgba(1, 2, 3, 4) }, { clipboard, nativeImage: image(false) }), /Invalid picture/);
    assert.equal(written.length, 1);
  });
});

describe('copying a picture in the browser', () => {
  afterEach(restoreGlobals);

  it('starts the write during the gesture and supplies the PNG after capture', async () => {
    const capture = Promise.withResolvers<HTMLCanvasElement>();
    const png = new Blob(['synthetic'], { type: 'image/png' });
    class Item {
      readonly data: Record<string, Promise<Blob>>;
      constructor(data: Record<string, Promise<Blob>>) { this.data = data; }
    }
    let writing = false;
    stubGlobal('window', {});
    stubGlobal('ClipboardItem', Item);
    stubGlobal('navigator', { clipboard: { write: async ([item]: Item[]) => {
      writing = true;
      assert.equal(await item.data['image/png'], png);
    } } });
    const copied = copyCanvas(capture.promise);
    assert.equal(writing, true);
    capture.resolve({ toBlob(done: BlobCallback, type: string) {
      assert.equal(type, 'image/png');
      done(png);
    } } as HTMLCanvasElement);
    await copied;
  });
});
