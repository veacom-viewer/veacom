// Writes a RAR 5 archive of a folder of synthetic files, for the checks of RAR import. The files are stored, not
// compressed: that needs none of RAR's compression, so the archive is just headers and the files' own bytes (RAR 5.0
// archive format, rarlab.com technote: a signature, a main header, one header per file before its bytes, an end
// header; every header starts with the CRC-32 of what follows it).
//
//   node tools/fixtures/make-rar-archive.mjs <folder> <new-archive.rar>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';

const [folder, archive, ...rest] = process.argv.slice(2);
if (!folder || !archive || rest.length) throw new Error('Usage: node tools/fixtures/make-rar-archive.mjs <folder> <new-archive.rar>');

/** A RAR 5 variable-length integer: seven bits a byte, lowest first, the high bit set on all but the last. */
function vint(value) {
  const bytes = [];
  let rest = BigInt(value);
  do { const low = Number(rest & 0x7fn); rest >>= 7n; bytes.push(rest ? low | 0x80 : low); } while (rest);
  return Buffer.from(bytes);
}
const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); return bytes; };
/** One header: its CRC-32 and size, then the type, flags and fields the size counts. */
function header(type, flags, ...fields) {
  const body = Buffer.concat([vint(type), vint(flags), ...fields]);
  const sized = Buffer.concat([vint(body.length), body]);
  return Buffer.concat([u32(crc32(sized)), sized]);
}
async function files(directory, prefix = '') {
  const found = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await files(path.join(directory, entry.name), name));
    else if (entry.isFile()) found.push({ name, file: path.join(directory, entry.name) });
  }
  return found;
}

const parts = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]), header(1, 0, vint(0))];
for (const { name, file } of await files(folder)) {
  const data = await readFile(file), stored = Buffer.from(name, 'utf8');
  // Header flag 0x0002: a data area follows. File flag 0x0004: the data's CRC-32 is given. Compression 0: stored.
  parts.push(header(2, 0x0002, vint(data.length), vint(0x0004), vint(data.length), vint(0x20), u32(crc32(data)), vint(0), vint(0), vint(stored.length), stored), data);
}
parts.push(header(5, 0, vint(0)));
await writeFile(archive, Buffer.concat(parts), { flag: 'wx' }); // Refuse to replace an existing archive.
console.log(`Wrote ${archive}`);
