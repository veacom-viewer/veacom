// @ts-check
const HEAD_BYTES = 64 * 1024;
// The heads of 1024 files: a PET/CT is often 500 to 1000. The engine reads the head of every file beyond this one by one
// while it lists them, about 0.7 ms each; these are read several at once, and dropped once the listing ends.
const MAX_PREFETCH_BYTES = 64 * 1024 * 1024;
// Larger files use 1 MiB pieces in web/engine/src/blob.rs and discard a 64 KiB head.
const LARGE_FILE_BYTES = 16 * 1024 * 1024;

/** @param {{ index: number, part: Blob }[]} group @param {(Uint8Array<ArrayBuffer> | undefined)[]} result */
async function readGroup(group, result) {
  try {
    const bytes = new Uint8Array(await new Blob(group.map(item => item.part)).arrayBuffer());
    if (bytes.byteLength === group.reduce((sum, item) => sum + item.part.size, 0)) {
      let offset = 0;
      for (const { index, part } of group) {
        result[index] = bytes.subarray(offset, offset + part.size);
        offset += part.size;
      }
      return;
    }
  } catch { /* A changed file can make the whole group unreadable. Try the files separately. */ }
  await Promise.all(group.map(async ({ index, part }) => {
    try { result[index] = new Uint8Array(await part.arrayBuffer()); }
    catch { /* The engine reads a missing head on demand. */ }
  }));
}

/** @param {ReadonlyArray<{file: Blob}>} files @param {number} digestBytes */
export async function readSourceHeads(files, digestBytes) {
  /** @type {(Uint8Array<ArrayBuffer> | undefined)[]} */
  const result = Array(files.length).fill(undefined);
  /** @type {(Uint8Array | undefined)[]} */
  const digests = [];
  const crypto = globalThis.crypto?.subtle;
  let remaining = MAX_PREFETCH_BYTES;
  for (let start = 0; start < files.length && remaining > 0; start += 256) {
    const reads = [];
    const end = Math.min(start + 256, files.length);
    for (let from = start; from < end && remaining > 0; from += 16) {
      /** @type {{ index: number, part: Blob }[]} */
      const group = [];
      for (let index = from; index < Math.min(from + 16, end); index++) {
        const { file } = files[index];
        const length = Math.min(file.size, HEAD_BYTES);
        if (!length || file.size > LARGE_FILE_BYTES || length > remaining) continue;
        remaining -= length;
        try { group.push({ index, part: file.slice(0, length) }); }
        catch { /* The engine can still read the file on demand. */ }
      }
      if (!group.length) continue;
      const read = readGroup(group, result);
      if (digestBytes && crypto) {
        reads.push(read.then(() => Promise.all(group.map(async ({ index }) => {
          const head = result[index];
          if (!head) return;
          try { digests[index] = new Uint8Array(await crypto.digest('SHA-256', head.subarray(0, digestBytes))); }
          catch { /* The engine hashes the source itself if the browser cannot. */ }
        }))));
      } else {
        reads.push(read);
      }
    }
    await Promise.all(reads);
  }
  return { heads: result, digests };
}

/** @param {ReadonlyArray<{file: Blob}>} files */
export async function readHeads(files) {
  return (await readSourceHeads(files, 0)).heads;
}
