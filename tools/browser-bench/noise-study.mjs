import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataset, element } from '../fixtures/dicom-elements.mjs';

export const patient = 'SYNTHETIC-CT-NOISE';
export const root = '2.25.' + BigInt('0x' + createHash('sha256').update('veacom-grain-study-v1').digest('hex').slice(0,24));
const size = 512;
const count = size * size;
const center = 40, targetSd = 20;

function normalField(seed) {
  let state = seed;
  function uniform() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  }
  const values = new Float64Array(count);
  for (let i = 0; i < count; i += 2) {
    const radius = Math.sqrt(-2 * Math.log(uniform()));
    const phase = 2 * Math.PI * uniform();
    values[i] = radius * Math.cos(phase);
    values[i + 1] = radius * Math.sin(phase);
  }
  return values;
}

function lowPass(input, vertical) {
  const output = new Float64Array(count);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = y * size + x;
      const left = vertical ? ((y + size - 1) % size) * size + x : y * size + (x + size - 1) % size;
      const right = vertical ? ((y + 1) % size) * size + x : y * size + (x + 1) % size;
      output[offset] = (input[left] + 2 * input[offset] + input[right]) / 4;
    }
  }
  return output;
}

function samples(index) {
  const pixels = Buffer.alloc(count * 2);
  if (index === 0) {
    for (let i = 0; i < count; i++) pixels.writeInt16LE(center, 2 * i);
    return pixels;
  }
  const seed = [7841, 97151, 45767][(index - 1) % 3];
  const white = normalField(seed);
  const field = index <= 3 ? white : lowPass(lowPass(white, false), true);
  const mean = field.reduce((sum, v) => sum + v, 0) / count;
  const sd = Math.sqrt(field.reduce((sum, v) => sum + (v - mean) ** 2, 0) / count);
  for (let i = 0; i < count; i++) pixels.writeInt16LE(Math.round(center + targetSd * (field[i] - mean) / sd), 2 * i);
  return pixels;
}

export async function makeNoiseSeries(folder, indices) {
  await mkdir(path.join(folder,'S01'),{recursive:true});
  const sopClass='1.2.840.10008.5.1.4.1.1.2', syntax='1.2.840.10008.1.2.1';
  for (const z of indices) {
    const uid=root+'.3.'+(z+1);
    const meta=dataset([[2,1,'OB',[0,1]],[2,2,'UI',sopClass],[2,3,'UI',uid],[2,16,'UI',syntax],[2,18,'UI',root+'.4']]);
    const data=dataset([
      [8,8,'CS',['DERIVED','SECONDARY','AXIAL']],[8,0x16,'UI',sopClass],[8,0x18,'UI',uid],
      [8,0x20,'DA','20000101'],[8,0x30,'TM','120000'],[8,0x60,'CS','CT'],[8,0x103e,'LO','Synthetic uniform CT noise'],
      [0x10,0x10,'PN','NOISE^SYNTHETIC'],[0x10,0x20,'LO',patient],[0x18,0x50,'DS',1],
      [0x20,0x0d,'UI',root+'.1'],[0x20,0x0e,'UI',root+'.2'],[0x20,0x11,'IS',1],[0x20,0x13,'IS',z+1],
      [0x20,0x32,'DS',[-256,-256,-z]],[0x20,0x37,'DS',[1,0,0,0,1,0]],[0x20,0x52,'UI',root+'.5'],
      [0x28,2,'US',1],[0x28,4,'CS','MONOCHROME2'],[0x28,0x10,'US',size],[0x28,0x11,'US',size],[0x28,0x30,'DS',[1,1]],
      [0x28,0x100,'US',16],[0x28,0x101,'US',16],[0x28,0x102,'US',15],[0x28,0x103,'US',1],
      [0x28,0x1050,'DS',40],[0x28,0x1051,'DS',400],[0x28,0x1052,'DS',0],[0x28,0x1053,'DS',1],[0x28,0x1054,'LO','HU'],
      [0x7fe0,0x10,'OW',samples(z)],
    ]);
    const file=Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,data]);
    await writeFile(path.join(folder,'S01','IM'+String(z).padStart(5,'0')+'.dcm'),file);
  }
  return { size, sourcePixelMm: 1, centerHu: center, targetSdHu: targetSd, window: { center: 40, width: 400 } };
}
