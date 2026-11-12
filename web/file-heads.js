// @ts-check
const HEAD_BYTES = 64 * 1024;
// The heads of 1024 files: a PET/CT is often 500 to 1000. The engine reads the head of every file beyond this one by one
// while it lists them, about 0.7 ms each; these are read several at once, and dropped once the listing ends.
const MAX_PREFETCH_BYTES = 64 * 1024 * 1024;
// Larger files use 1 MiB pieces in web/engine/src/blob.rs and discard a 64 KiB head.
const LARGE_FILE_BYTES = 16 * 1024 * 1024;

/** @param {ReadonlyArray<{file: Blob}>} files */
export async function readHeads(files) {
  /** @type {(Uint8Array | undefined)[]} */
  const result = Array(files.length).fill(undefined);
  let remaining = MAX_PREFETCH_BYTES;
  for (let start = 0; start < files.length && remaining > 0; start += 256) {
    await Promise.all(files.slice(start, start + 256).map(async ({ file }, index) => {
      const length = Math.min(file.size, HEAD_BYTES);
      if (!length || file.size > LARGE_FILE_BYTES || length > remaining) return;
      remaining -= length;
      try {
        result[start + index] = new Uint8Array(await file.slice(0, length).arrayBuffer());
      } catch { /* The engine can still read the file on demand. */ }
    }));
  }
  return result;
}
