const { decodePng, encodePng } = require('./png.cjs');

function unexpectedChunks(bytes) {
  const unexpected = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    offset += length + 12;
    if (offset > bytes.length) throw new Error('PNG chunk exceeds file size');
    if (!['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) unexpected.push(type);
    if (type === 'IEND' && offset !== bytes.length) unexpected.push('trailing data');
    if (type === 'IEND') break;
  }
  return unexpected;
}

function comparePng(expectedBytes, actualBytes) {
  const expected = decodePng(expectedBytes), actual = decodePng(actualBytes);
  const sizeMatch = expected.width === actual.width && expected.height === actual.height;
  const result = { passed: false, sizeMatch, expectedSize: [expected.width, expected.height],
    actualSize: [actual.width, actual.height], differingPixels: null, maxChannelDifference: null,
    unexpectedReferenceChunks: unexpectedChunks(expectedBytes), unexpectedExportChunks: unexpectedChunks(actualBytes) };
  if (!sizeMatch) return { result, diff: null };
  const diff = { width: expected.width, height: expected.height, data: Buffer.alloc(expected.data.length) };
  let differingPixels = 0, maxChannelDifference = 0;
  for (let index = 0; index < expected.data.length; index += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) {
      const difference = Math.abs(expected.data[index + channel] - actual.data[index + channel]);
      changed ||= difference !== 0;
      maxChannelDifference = Math.max(maxChannelDifference, difference);
    }
    if (changed) differingPixels++;
    diff.data.set(changed ? [255, 0, 0, 255] : [0, 0, 0, 255], index);
  }
  const passed = differingPixels === 0 && !result.unexpectedReferenceChunks.length && !result.unexpectedExportChunks.length;
  return { result: { ...result, passed, differingPixels, maxChannelDifference }, diff: encodePng(diff) };
}

module.exports = { comparePng };
