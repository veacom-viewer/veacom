import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataset, element } from '../fixtures/dicom-elements.mjs';
import { drawBand } from './lib/marker.mjs';

export const patient = 'SYNTHETIC-CT-EDGES';
export const root = '2.25.' + BigInt('0x' + createHash('sha256').update('veacom-edge-study-v1').digest('hex').slice(0,24));
const size = 512, slope = 5 / 64, phase = 3 / 16;
const panels = [
  { axis: 'x', x: 128, y: 128, low: 20, high: 60 },
  { axis: 'x', x: 384, y: 128, low: -80, high: 160 },
  { axis: 'y', x: 128, y: 384, low: 20, high: 60 },
  { axis: 'y', x: 384, y: 384, low: -80, high: 160 },
];

function samples(index) {
  const pixels = new Int16Array(size * size).fill(40);
  for (const panel of panels) {
    for (let y = panel.y - 88; y < panel.y + 88; y++) for (let x = panel.x - 88; x < panel.x + 88; x++) {
      const normal = panel.axis === 'x' ? x - panel.x : y - panel.y;
      const tangent = panel.axis === 'x' ? y - panel.y : x - panel.x;
      // Area of the bright half-plane within the original 1 mm source pixel. The position is in pixel-center coordinates.
      let covered = 0;
      for (let n = 0; n < 32; n++) {
        const edge = phase + slope * (tangent - 0.5 + (n + 0.5) / 32);
        covered += Math.max(0, Math.min(1, normal + 0.5 - edge));
      }
      pixels[y * size + x] = Math.round(panel.low + (panel.high - panel.low) * covered / 32);
    }
  }
  drawBand(pixels, size, index, -3000, 3000);
  return Buffer.from(pixels.buffer);
}

export async function makeEdgeSeries(folder, indices) {
  await mkdir(path.join(folder,'S01'),{recursive:true});
  const sopClass='1.2.840.10008.5.1.4.1.1.2', syntax='1.2.840.10008.1.2.1';
  for (const z of indices) {
    const uid=root+'.3.'+(z+1);
    const meta=dataset([[2,1,'OB',[0,1]],[2,2,'UI',sopClass],[2,3,'UI',uid],[2,16,'UI',syntax],[2,18,'UI',root+'.4']]);
    const data=dataset([
      [8,8,'CS',['DERIVED','SECONDARY','AXIAL']],[8,0x16,'UI',sopClass],[8,0x18,'UI',uid],
      [8,0x20,'DA','20000101'],[8,0x30,'TM','120000'],[8,0x60,'CS','CT'],[8,0x103e,'LO','Synthetic slanted edges'],
      [0x10,0x10,'PN','EDGE^SYNTHETIC'],[0x10,0x20,'LO',patient],[0x18,0x50,'DS',1],
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
  return {size,slope,phase,sourcePixelMm:1,panels,window:{center:40,width:400}};
}
