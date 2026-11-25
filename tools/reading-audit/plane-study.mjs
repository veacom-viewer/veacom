import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataset, element } from '../fixtures/dicom-elements.mjs';

const [directory, receipt] = process.argv.slice(2);
const width = 512, height = 512, depth = 1000;
const root = '1.2.826.0.1.3680043.10.1700.20261125.7';
const sopClass = '1.2.840.10008.5.1.4.1.1.2', syntax = '1.2.840.10008.1.2.1';
const manifest = { generator: 'veacom-three-axis-ramp-v1', synthetic: true, dimensions: [width,height,depth],
  spacing: [1,1,1], syntax, storedHU: '-100 + 6*(x mod 23) + 8*(y mod 19) + 5*(fileZ mod 29)',
  patientPosition: '[-256,-256,-fileZ]', window: { centre: 100, width: 512 }, files: {} };
await mkdir(directory, {recursive: true});
const patterns = Array.from({length:29}, (_,z) => {
  const b = Buffer.alloc(width*height*2);
  for(let y=0; y<height; y++) for(let x=0; x<width; x++) b.writeInt16LE(-100+6*(x%23)+8*(y%19)+5*z, 2*(y*width+x));
  return b;
});
for(let z=0; z<depth; z++) {
  const uid=root+'.3.'+(z+1);
  const meta=dataset([[2,1,'OB',[0,1]],[2,2,'UI',sopClass],[2,3,'UI',uid],[2,16,'UI',syntax],[2,18,'UI',root+'.9']]);
  const ds=dataset([
    [8,0x16,'UI',sopClass],[8,0x18,'UI',uid],[8,0x20,'DA','20260101'],[8,0x60,'CS','CT'],[8,0x103e,'LO','Synthetic three-axis ramp'],
    [16,16,'PN','SYNTHETIC^THREEPLANES'],[16,32,'LO','SYNTHETIC-THREEPLANES'],[24,0x50,'DS','1'],
    [32,0x0d,'UI',root+'.1'],[32,0x0e,'UI',root+'.2'],[32,0x11,'IS',1],[32,0x13,'IS',z+1],[32,0x32,'DS',[-width/2,-height/2,-z]],
    [32,0x37,'DS',[1,0,0,0,1,0]],[32,0x52,'UI',root+'.4'],[40,2,'US',1],[40,4,'CS','MONOCHROME2'],[40,16,'US',height],[40,17,'US',width],
    [40,0x30,'DS',[1,1]],[40,0x100,'US',16],[40,0x101,'US',16],[40,0x102,'US',15],[40,0x103,'US',1],
    [40,0x1050,'DS',100],[40,0x1051,'DS',512],[40,0x1052,'DS',0],[40,0x1053,'DS',1],[40,0x1054,'LO','HU'],[0x7fe0,0x10,'OW',patterns[z%29]],
  ]);
  const bytes=Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,ds]);
  const file=String(z).padStart(4,'0')+'.dcm';await writeFile(path.join(directory,file),bytes);
  manifest.files[file]=createHash('sha256').update(bytes).digest('hex');
}
await writeFile(receipt,JSON.stringify(manifest,null,2)+'\n');
