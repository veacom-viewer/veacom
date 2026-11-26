// @ts-check
const HEAD_BYTES = 64 * 1024;
export const HEAD_GROUP_SIZE = 16;
const FILES_PER_WAVE = 256;
// The heads of 1024 files: a PET/CT is often 500 to 1000. The engine reads the head of every file beyond this one by one
// while it lists them, about 0.7 ms each; these are read several at once, and dropped once the listing ends.
const MAX_PREFETCH_BYTES = 64 * 1024 * 1024;
// Larger files use 1 MiB pieces in web/engine/src/blob.rs and discard a 64 KiB head.
const LARGE_FILE_BYTES = 16 * 1024 * 1024;

/** @param {{ index: number, part: Blob }[]} group @param {(Uint8Array | undefined)[]} result */
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

/** @param {ReadonlyArray<{file: Blob}>} files @param {(offset: number) => Promise<void>} [waitForFiles]
 * @param {(index: number, head: Uint8Array | undefined) => void} [onHead] */
export async function readHeads(files, waitForFiles, onHead) {
  /** @type {(Uint8Array | undefined)[]} */
  const result = Array(files.length).fill(undefined);
  let remaining = MAX_PREFETCH_BYTES;
  // On smaller CTs, finishing the reads before registration uses less memory.
  const registerEarly = files.length >= 3 * FILES_PER_WAVE ? onHead : undefined;
  for (let start = 0; start < files.length && (remaining > 0 || waitForFiles || registerEarly); start += FILES_PER_WAVE) {
    const reads = [];
    const end = Math.min(start + FILES_PER_WAVE, files.length);
    try {
      for (let from = start; from < end && (remaining > 0 || waitForFiles || registerEarly); from += HEAD_GROUP_SIZE) {
        if (waitForFiles) await waitForFiles(from);
        const group = [];
        for (let index = from; remaining > 0 && index < Math.min(from + HEAD_GROUP_SIZE, end); index++) {
          const { file } = files[index];
          const length = Math.min(file.size, HEAD_BYTES);
          if (!length || file.size > LARGE_FILE_BYTES || length > remaining) continue;
          remaining -= length;
          try { group.push({ index, part: file.slice(0, length) }); }
          catch { /* The engine can still read the file on demand. */ }
        }
        reads.push(group.length ? readGroup(group, result) : undefined);
      }
      if (registerEarly) {
        for (const [i, pending] of reads.entries()) {
          await pending;
          const from = start + i * HEAD_GROUP_SIZE;
          for (let index = from; index < Math.min(end, from + HEAD_GROUP_SIZE); index++) registerEarly(index, result[index]);
        }
      }
    } finally { await Promise.all(reads); }
  }
  if (onHead && !registerEarly) result.forEach((head, index) => onHead(index, head));
  return result;
}
