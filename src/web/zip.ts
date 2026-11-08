// A ZIP of files stored as they are (no compression): the browser build's downloads of exported DICOM and pictures.
// DICOM keeps its bytes exactly, and pictures are compressed already. Names are UTF-8; one archive holds at most
// 65,535 files and under 4 GiB, which no export from one session reaches.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The time in MS-DOS form, as ZIP stores it. */
function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry { name: string; bytes: Uint8Array }

/** The archive of `entries`, in their order. */
export function zipStored(entries: ZipEntry[], now = new Date()): Blob {
  if (entries.length > 0xffff) throw new Error('Too many files for one ZIP.');
  const { time, day } = dosTime(now);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameBytes = encoder.encode(name.replaceAll('\\', '/'));
    const crc = crc32(bytes), size = bytes.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, day, true);
    local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true); record.setUint16(4, 20, true); record.setUint16(6, 20, true); record.setUint16(8, 0x0800, true);
    record.setUint16(10, 0, true); record.setUint16(12, time, true); record.setUint16(14, day, true);
    record.setUint32(16, crc, true); record.setUint32(20, size, true); record.setUint32(24, size, true);
    record.setUint16(28, nameBytes.length, true); record.setUint32(42, offset, true);
    parts.push(local.buffer, nameBytes, bytes as Uint8Array<ArrayBuffer>);
    central.push(new Uint8Array(record.buffer), nameBytes);
    offset += 30 + nameBytes.length + size;
    if (offset >= 2 ** 32) throw new Error('The export is too large for one ZIP.');
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central as Uint8Array<ArrayBuffer>[], end.buffer], { type: 'application/zip' });
}
