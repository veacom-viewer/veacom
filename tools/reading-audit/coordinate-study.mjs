import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataset, element } from '../fixtures/dicom-elements.mjs';

const [studyRoot,evidence]=process.argv.slice(2);
const n=[256,192,384], spacing=[1.25,.75,1.5], origin=[17.125,-93.25,41.75];
const root='2.25.150962532157482113344902996721560341569', ct='1.2.840.10008.5.1.4.1.1.2';
const markers=[{low:[50,73,100],high:[64,89,120],hu:1800},{low:[180,25,238],high:[198,42,252],hu:-1800}];
const manifest={synthetic:true,dimensions:n,spacing,origin,markers,window:{center:0,width:2000},
  ramp:{constant:-800,coefficients:[2,3,1]},encodings:{}};
for(const [index,encoding] of ['axial','reversed-sagittal'].entries()){
  const axial=index===0, orientation=axial?[1,0,0,0,1,0]:[0,-1,0,0,0,-1];
  const [cols,rows,frames]=axial?n:[n[1],n[2],n[0]];
  const dir=path.join(studyRoot,encoding), proof=path.join(evidence,'source',encoding);
  await mkdir(dir,{recursive:true});await mkdir(proof,{recursive:true});
  const series=root+'.2.'+(index+1), patient='SYNTHETIC-MPR-'+(index+1);
  const data=manifest.encodings[encoding]={series,patient,orientation,dimensions:[cols,rows,frames],files:[]};
  for(let k=0;k<frames;k++){
    const sop=series+'.3.'+(k+1), pixels=Buffer.alloc(2*rows*cols);
    for(let v=0;v<rows;v++)for(let u=0;u<cols;u++){
      const x=axial?u:k,y=axial?v:n[1]-1-u,z=axial?k:n[2]-1-v;
      let value=-800+2*x+3*y+z;
      for(const {low,high,hu} of markers)if(x>=low[0]&&x<=high[0]&&y>=low[1]&&y<=high[1]&&z>=low[2]&&z<=high[2])value=hu;
      pixels.writeInt16LE(value,2*(v*cols+u));
    }
    const ipp=axial?[origin[0],origin[1],origin[2]+k*spacing[2]]:[origin[0]+k*spacing[0],origin[1]+(n[1]-1)*spacing[1],origin[2]+(n[2]-1)*spacing[2]];
    const step=axial?spacing[2]:spacing[0];
    const meta=dataset([[2,1,'OB',[0,1]],[2,2,'UI',ct],[2,3,'UI',sop],[2,0x10,'UI','1.2.840.10008.1.2.1'],[2,0x12,'UI',root+'.9']]);
    const ds=dataset([
      [8,0x16,'UI',ct],[8,0x18,'UI',sop],[8,0x20,'DA','20000101'],[8,0x60,'CS','CT'],[8,0x103e,'LO','MPR coordinate phantom'],
      [16,16,'PN','COORDINATE^PHANTOM'],[16,32,'LO',patient],[24,0x50,'DS',step],[24,0x88,'DS',step],
      [32,0x0d,'UI',root+'.1.'+(index+1)],[32,0x0e,'UI',series],[32,0x11,'IS',1],[32,0x13,'IS',k+1],
      [32,0x32,'DS',ipp],[32,0x37,'DS',orientation],[32,0x52,'UI',root+'.7'],
      [40,2,'US',1],[40,4,'CS','MONOCHROME2'],[40,16,'US',rows],[40,17,'US',cols],[40,0x30,'DS',axial?[spacing[1],spacing[0]]:[spacing[2],spacing[1]]],
      [40,0x100,'US',16],[40,0x101,'US',16],[40,0x102,'US',15],[40,0x103,'US',1],
      [40,0x1050,'DS',0],[40,0x1051,'DS',2000],[40,0x1052,'DS',0],[40,0x1053,'DS',1],[40,0x1054,'LO','HU'],[0x7fe0,0x10,'OW',pixels],
    ]);
    const file=Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,ds]);
    const name=String(frames-k).padStart(4,'0')+'.dcm';
    await writeFile(path.join(dir,name),file);
    const archived=[0,Math.floor(frames/2),frames-1,axial?110:57,axial?245:189].includes(k);
    if(archived)await writeFile(path.join(proof,name),file);
    data.files.push({k,name,sop,ipp,archived,sha256:createHash('sha256').update(file).digest('hex')});
  }
}
await writeFile(path.join(evidence,'coordinate-source.json'),JSON.stringify(manifest,null,2));

