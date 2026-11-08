// DICOM Part 10, Explicit VR Little Endian: just the value types this study uses.
const LONG_LENGTH = new Set(['OB', 'OW', 'SQ']);
export function element(group, item, vr, value) {
  let body;
  if (LONG_LENGTH.has(vr)) body = Buffer.from(value);
  else if (vr === 'US') { body = Buffer.alloc(2); body.writeUInt16LE(value); }
  else if (vr === 'UL') { body = Buffer.alloc(4); body.writeUInt32LE(value); }
  else body = Buffer.from(Array.isArray(value) ? value.join('\\') : String(value), 'latin1');
  if (body.length % 2) body = Buffer.concat([body, Buffer.from(vr === 'UI' || vr === 'OB' ? [0] : [0x20])]);
  const header = Buffer.alloc(LONG_LENGTH.has(vr) ? 12 : 8);
  header.writeUInt16LE(group); header.writeUInt16LE(item, 2); header.write(vr, 4, 'latin1');
  if (LONG_LENGTH.has(vr)) header.writeUInt32LE(body.length, 8); else header.writeUInt16LE(body.length, 6);
  return Buffer.concat([header, body]);
}
export const dataset = elements => Buffer.concat(elements.map(([group, item, vr, value]) => element(group, item, vr, value)));
