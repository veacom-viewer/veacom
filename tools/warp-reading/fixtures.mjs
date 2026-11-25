import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { dataset, element } from '../fixtures/dicom-elements.mjs';
const [dir, evidence] = process.argv.slice(2);
const root = '1.2.826.0.1.3680043.10.1700.20261125', syntax = '1.2.840.10008.1.2.1';
const manifest = { version: 1, synthetic: true, syntax, studies: {} };
for (const [modality,w,h,depth,group,sop] of [['MG',3328,4096,1,1,'1.2.840.10008.5.1.4.1.1.1.2'],['CT',512,512,25,2,'1.2.840.10008.5.1.4.1.1.2']]) {
  await mkdir(path.join(dir,modality),{recursive:true});
  const study = { dimensions:[w,h,depth],centerBySop:{},files:{} };
  for(let z=0;z<depth;z++){
    const uid=root+'.'+group+'.3.'+(z+1),central=modality==='MG'?1600:380+z*132;
    const pixels=Buffer.alloc(w*h*2);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const centre=Math.abs(x-w/2)<w*.14 && Math.abs(y-h/2)<h*.14;
      const val=centre?central:(x*17+y*37+z*83)%4096;
      pixels.writeUInt16LE(val,2*(y*w+x));
    }
    const meta=dataset([
      [2,1,'OB',[0,1]],[2,2,'UI',sop],[2,3,'UI',uid],[2,0x10,'UI',syntax],[2,0x12,'UI',root+'.8']
    ]);
    const bytes=Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,dataset([
      [8,0x16,'UI',sop],[8,0x18,'UI',uid],[8,0x20,'DA','20260101'],[8,0x60,'CS',modality],[8,0x103e,'LO','Synthetic '+modality],
      [16,0x10,'PN','SYNTHETIC^REDRAW'],[16,0x20,'LO','SYNTHETIC-REDRAW'],[24,0x50,'DS','1'],
      [32,0x0d,'UI',root+'.'+group+'.1'],[32,0x0e,'UI',root+'.'+group+'.2'],[32,0x11,'IS',1],[32,0x13,'IS',z+1],
      [32,0x32,'DS',[0,0,z]],[32,0x37,'DS',[1,0,0,0,1,0]],[32,0x52,'UI',root+'.'+group+'.4'],
      [40,2,'US',1],[40,4,'CS','MONOCHROME2'],[40,0x10,'US',h],[40,0x11,'US',w],[40,0x30,'DS',[1,1]],
      [40,0x100,'US',16],[40,0x101,'US',12],[40,0x102,'US',11],[40,0x103,'US',0],[40,0x1050,'DS',2048],[40,0x1051,'DS',4096],
      [40,0x1052,'DS',0],[40,0x1053,'DS',1],[0x7fe0,0x10,'OW',pixels]
    ])]);
    const file=String(z).padStart(3,'0')+'.dcm';
    await writeFile(path.join(dir,modality,file),bytes);study.files[file]=createHash('sha256').update(bytes).digest('hex');study.centerBySop[uid]=central;
  }
  manifest.studies[modality]=study;
}
await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'study-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
