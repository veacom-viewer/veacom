// @ts-check
// The initial buffer used by both DICOM header passes in native/src/source_file.rs.
const HEAD_BYTES = 8 * 1024;
// The heads of 1024 files: a PET/CT is often 500 to 1000. The engine reads the head of every file beyond this one by one
// while it lists them, about 0.7 ms each; these are read several at once, and dropped once the listing ends.
const MAX_PREFETCH_BYTES = 1024 * HEAD_BYTES;
// The engine reads larger files on demand in 1 MiB pieces.
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

/** @param {ReadonlyArray<{file: Blob}>} files */
export async function readHeads(files) {
  /** @type {(Uint8Array | undefined)[]} */
  const result = Array(files.length).fill(undefined);
  let remaining = MAX_PREFETCH_BYTES;
  for (let start = 0; start < files.length && remaining > 0; start += 256) {
    const reads = [];
    const end = Math.min(start + 256, files.length);
    for (let from = start; from < end && remaining > 0; from += 16) {
      const group = [];
      for (let index = from; index < Math.min(from + 16, end); index++) {
        const { file } = files[index];
        const length = Math.min(file.size, HEAD_BYTES);
        if (!length || file.size > LARGE_FILE_BYTES || length > remaining) continue;
        remaining -= length;
        try { group.push({ index, part: file.slice(0, length) }); }
        catch { /* The engine can still read the file on demand. */ }
      }
      if (group.length) reads.push(readGroup(group, result));
    }
    await Promise.all(reads);
  }
  return result;
}
