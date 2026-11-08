// Reproduce the two original pydicom 3.0.2 studies, including its Part 10 header and decimal strings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataset, element } from './dicom-elements.mjs';

const study = '2.25.91000', syntax = '1.2.840.10008.1.2.1', storage = '1.2.840.10008.5.1.4.1.1.';
const classes = { CT: storage + '2', SR: storage + '88.33', KO: storage + '88.59', PR: storage + '11.1' };
const positions = ['0.0', '0.62', '1.25', '1.88', '2.5', '3.12', '3.75', '4.38', '5.0'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function sequence(tags) {
  const body = dataset(tags), header = Buffer.alloc(8);
  header.writeUInt16LE(0xfffe); header.writeUInt16LE(0xe000, 2); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
function reportTags(kind) {
  const concept = sequence([[8, 0x0100, 'SH', '113701'], [8, 0x0102, 'SH', 'DCM'], [8, 0x0104, 'LO', 'Synthetic']]);
  return [
    [0x40, 0xa040, 'CS', 'CONTAINER'], [0x40, 0xa043, 'SQ', concept], [0x40, 0xa050, 'CS', 'SEPARATE'],
    ...(kind === 'SR' ? [[0x40, 0xa491, 'CS', 'COMPLETE'], [0x40, 0xa493, 'CS', 'UNVERIFIED']] : []),
    [0x40, 0xa730, 'SQ', sequence([[0x40, 0xa010, 'CS', 'HAS CONCEPT MOD'], [0x40, 0xa040, 'CS', 'CODE'],
      [0x40, 0xa043, 'SQ', concept], [0x40, 0xa168, 'SQ', concept]])],
  ];
}
function instance(kind, series, number, description, slice) {
  const uid = study + number, sop = classes[kind], report = kind === 'SR' || kind === 'KO';
  const meta = dataset([[2, 1, 'OB', [0, 1]], [2, 2, 'UI', sop], [2, 3, 'UI', uid], [2, 0x10, 'UI', syntax],
    [2, 0x12, 'UI', '1.2.826.0.1.3680043.8.498.1'], [2, 0x13, 'SH', 'PYDICOM 3.0.2']]);
  const tags = [[8, 0x16, 'UI', sop], [8, 0x18, 'UI', uid], [8, 0x20, 'DA', '20240101'],
    [8, 0x30, 'TM', '120000'], [8, 0x60, 'CS', kind], [0x10, 0x10, 'PN', 'Synthetic^Test'], [0x10, 0x20, 'LO', 'TEST'],
    [0x20, 0x0d, 'UI', study], [0x20, 0x0e, 'UI', study + '.' + series], [0x20, 0x10, 'SH', '1'],
    [0x20, 0x11, 'IS', series], [0x20, 0x13, 'IS', number]];
  if (report) tags.push([8, 0x23, 'DA', '20240101'], [8, 0x33, 'TM', '120000'], ...reportTags(kind));
  if (kind === 'PR') {
    const ref = sequence([[8, 0x1150, 'UI', classes.CT], [8, 0x1155, 'UI', study + '4']]);
    tags.push([8, 0x1115, 'SQ', sequence([[8, 0x1140, 'SQ', ref], [0x20, 0x0e, 'UI', study + '.1']])],
      [0x70, 0x80, 'CS', 'DISPLAY'], [0x70, 0x81, 'LO', 'Synthetic'], [0x70, 0x82, 'DA', '20240101'],
      [0x70, 0x83, 'TM', '120000'], [0x70, 0x84, 'PN', '']);
  }
  if (kind === 'CT') {
    const pixels = Buffer.alloc(162);
    pixels.writeInt16LE(3200, 6 * 2);
    if (number === 4) pixels.writeInt16LE(1000, 40 * 2);
    if (description) tags.push([8, 0x103e, 'LO', description]);
    tags.push([0x20, 0x32, 'DS', description ? ['0.0', description === 'Scout' ? '4.0' : positions[slice], '5.0'] : ['0.0', '0.0', positions[slice]]],
      [0x20, 0x37, 'DS', ['1.0', '0.0', '0.0', '0.0', description ? '0.0' : '1.0', description ? '-1.0' : '0.0']],
      [0x20, 0x52, 'UI', '2.25.99'], [0x28, 2, 'US', 1], [0x28, 4, 'CS', 'MONOCHROME2'], [0x28, 0x10, 'US', 9],
      [0x28, 0x11, 'US', 9], [0x28, 0x30, 'DS', ['1.0', '1.0']], [0x28, 0x100, 'US', 16],
      [0x28, 0x101, 'US', 16], [0x28, 0x102, 'US', 15], [0x28, 0x103, 'US', 1], [0x7fe0, 0x10, 'OW', pixels]);
  }
  tags.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), element(2, 0, 'UL', meta.length), meta, dataset(tags)]);
}
export async function makeParityStudies(root) {
  await mkdir(root);
  const hashes = {};
  const files = new Map();
  for (let i = 0; i < 9; i++) files.set(i + '.dcm', instance('CT', 1, i, '', i));
  for (const [i, kind] of ['SR', 'KO', 'PR'].entries()) files.set(kind + '.dcm', instance(kind, 2 + i, 12 + i));
  for (const name of ['documents', 'linked']) {
    if (name === 'linked') {
      for (let i = 0; i < 9; i++) files.set('Coronal' + i + '.dcm', instance('CT', 5, 100 + i, 'Coronal', i));
      files.set('Scout0.dcm', instance('CT', 6, 120, 'Scout', 0));
    }
    await mkdir(path.join(root, name));
    hashes[name] = {};
    for (const file of [...files.keys()].sort()) {
      const bytes = files.get(file);
      hashes[name][file] = sha256(bytes);
      await writeFile(path.join(root, name, file), bytes);
    }
    assert.equal(sha256(JSON.stringify(hashes[name])), fingerprints[name], 'Original ' + name + ' study has changed');
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ generator: 'parity-v1', synthetic: true,
    dimensions: [9, 9, 9], transferSyntax: syntax, fingerprints, sha256: hashes }, null, 2) + '\n');
  return hashes;
}
export const fingerprints = { documents: '8ead9a070611777a927e8afac47e29a1da3351aa80533c938ca7ed17ceacbfcf', linked: '54c5c8b1b562f8a3cd690577502f8933cabcccec3b6f69b660f03e77a6c87490' };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await makeParityStudies(process.argv[2]);
