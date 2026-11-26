import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

/** Read the stored ZIP returned by the browser using its central directory and local file headers. */
export function readStoredZip(archive: Uint8Array) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  const files = [];
  let at = directory;
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    assert.equal(view.getUint16(at + 10, true), 0);
    const nameLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    const local = view.getUint32(at + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    assert.equal(view.getUint16(local + 8, true), 0);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const size = view.getUint32(at + 24, true);
    assert.equal(view.getUint32(local + 18, true), size);
    assert(start + size <= directory);
    const bytes = archive.subarray(start, start + size);
    assert.equal(crc32(bytes), view.getUint32(at + 16, true));
    files.push({ name, bytes });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  assert.equal(at, end);
  return files;
}
