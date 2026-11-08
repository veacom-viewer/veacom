// Run against synthetic input only. Compares the desktop calculation, native frame sampling and the public volume API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexToWorld } from '../src/imaging/geometry.ts';
import { peakKernel, PEAK_RADIUS_MM, sphereStatistics } from '../src/imaging/voi.ts';
import { quantitativeScale, roiStatistics } from '../src/imaging/annotations.ts';
import { ImagingBroker } from '../electron/imaging-broker.cjs';
import { EngineProcess } from '../electron/engine-process.cjs';

const temp = await mkdtemp(path.join(tmpdir(), 'veacom-sampling-'));
const executable = path.resolve('native/target/release', process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core');
let engine, broker;
try {
  const original = path.join(temp, 'original');
  execFileSync(process.execPath, ['tools/fixtures/make-smoke-study.mjs', original]);
  const directory = path.join(temp, 'input');
  await mkdir(directory);
  const xy = [[32,32],[33,32],[32,33],[33,33]];
  const points = [[32,32,1],[33,32,1],[33,33,1],[32,33,1]];
  const values = [-1000,10,20,30];
  async function study({ missingSpacing = false, irregular = false } = {}) {
    for (const [i,name] of ['IM00000.dcm','IM00001.dcm','IM00002.dcm'].entries()) {
      let file = await readFile(path.join(original, 'S01', name));
      const element = (group, tag, vr) => file.indexOf(Buffer.from([group,0,tag & 255,tag >>> 8,...Buffer.from(vr)]));
      const pixels = file.indexOf(Buffer.from([0xe0,0x7f,0x10,0x00,0x4f,0x57,0,0]));
      assert(pixels > 0);
      for (const [n,[x,y]] of xy.entries()) file.writeInt16LE(values[n],pixels+12+2*(128*y+x));
      if (irregular && i===2) file[element(0x20,0x32,'DS')+12]=0x38; // "0\\0\\8"
      if (missingSpacing) {
        const at = element(0x28,0x30,'DS'); assert(at>0);
        file = Buffer.concat([file.subarray(0,at), file.subarray(at+8+file.readUInt16LE(at+6))]);
      }
      const at = element(0x28,0x1050,'DS'); assert(at>0);
      const padding = Buffer.from([0x28,0,0x20,1,0x53,0x53,2,0,0x18,0xfc]);
      await writeFile(path.join(directory,name),Buffer.concat([file.subarray(0,at),padding,file.subarray(at)]));
    }
  }
  await study();
  engine = new EngineProcess({ binary: executable, env: {...process.env, TMPDIR:temp, TEMP:temp, TMP:temp} });
  const connection = await engine.start();
  broker = new ImagingBroker({engine});
  async function open() {
    const result = await broker.importSelected(await broker.authorizeImportPaths([directory]));
    assert.equal(result.series.length,1);
    return result.series[0];
  }
  const series = await open();
  const frame = s => ({index:1,sopInstanceUid:s.frameMetadata[1].sopInstanceUid,sourceFrameNumber:s.frameMetadata[1].sourceFrameNumber});
  const region = s => ({kind:'sourceRegion',shape:'rectangle',points,frame:frame(s)});
  const measure = (s,op) => broker.measure(s.id,1,s.sourceRevision,op);
  const native = await measure(series,region(series));
  const legacy = (await broker.requestJson('measure',{seriesId:series.id,kind:'rectangle',points:[points[0],points[2]]})).value;
  const input = await connection.request('frame',{id:series.id,index:1});
  const data = new Int16Array(await input.arrayBuffer());
  const reference = roiStatistics({id:'rect',type:'rectangle',mode:'source',plane:'axial',slice:1,sourceFrame:1,points},{series,data,sourceFrameIndex:1});
  assert.deepEqual(native,reference);
  assert.deepEqual([native.mean,native.count,native.paddingCount],[20,3,1]);
  assert.deepEqual([legacy.mean,legacy.count,legacy.excludedPadding],[20,3,1]);
  await assert.rejects(measure(series,{...region(series),frame:{...frame(series),index:0}}));
  const allPadding = [[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  assert.equal(await measure(series,{...region(series),points:allPadding}),null);
  const assessment = await measure(series,{kind:'assessment',sets:[{outline:[[32.6,32.6,1],[33.1,32.6,1],[33.1,33.1,1],[32.6,33.1,1]]}]});
  assert.deepEqual([assessment.sampling,assessment.mean],['derived-nearest',30]);
  await study({missingSpacing:true,irregular:true});
  const replaced = await open();
  assert.notEqual(series.sourceRevision,replaced.sourceRevision);
  assert.equal(replaced.canReconstruct,false);
  await assert.rejects(measure(series,region(series)));
  const uncalibrated = await measure(replaced,region(replaced));
  assert.deepEqual([uncalibrated.mean,uncalibrated.area,uncalibrated.areaUnit],[20,1,'px²']);
  const calibrated = await measure(replaced,{...region(replaced),measurementScale:2});
  assert.deepEqual([calibrated.area,calibrated.areaUnit],[4,'mm²']);
  const petDirectory = path.join(temp, 'pet');
  execFileSync(process.execPath, ['tools/fixtures/make-petct-study.mjs', petDirectory]);
  const imported = await broker.importSelected(await broker.authorizeImportPaths([path.join(petDirectory, 'S02')]));
  const pet = imported.series[0], sphere = {center: [-82,-12,-96], radius:18};
  const response = await connection.request('volume',{id:pet.id});
  assert(response.ok);
  const constructors = {uint8:Uint8Array,uint16:Uint16Array,int16:Int16Array,float32:Float32Array,float64:Float64Array};
  const volume = {series:pet,data:new constructors[response.headers.get('X-Pixel-Type')](await response.arrayBuffer())};
  const quantity = quantitativeScale(pet);
  const result = await measure(pet,{kind:'sphere',...sphere});
  const referenceSphere = sphereStatistics(volume,sphere,quantity);
  assert.equal(result.count,referenceSphere.count);
  assert(Math.abs(result.mean-referenceSphere.mean)<1e-9);
  const weights = peakKernel(pet);
  const [nx,ny,nz] = pet.dimensions;
  const distance = p => Math.hypot(...indexToWorld(pet,p).map((value,i)=>value-sphere.center[i]));
  let expected = -Infinity;
  for (let z=0;z<nz;z++) for (let y=0;y<ny;y++) for(let x=0;x<nx;x++) {
    if(distance([x,y,z])+PEAK_RADIUS_MM>sphere.radius+1e-9) continue;
    let sum=0;
    for(let n=0;n<weights.weights.length;n++) {
      const i=x+weights.offsets[3*n], j=y+weights.offsets[3*n+1], k=z+weights.offsets[3*n+2];
      if(i<0 || j<0 || k<0 || i>=nx || j>=ny || k>=nz || distance([i,j,k])>sphere.radius+1e-9) { sum=NaN; break; }
      sum+=weights.weights[n]*volume.data[(k*ny+j)*nx+i]*quantity.factor;
    }
    if(Number.isFinite(sum)) expected=Math.max(expected,sum/weights.total);
  }
  assert(Number.isFinite(expected) && Math.abs(result.peak.value-expected)<1e-9);
  console.log('PASS native SUVpeak against an exhaustive search on a nonuniform PET');
  console.log('PASS native sampling, padding, irregular slices, calibration, frame identity and stale revisions');
} finally {
  broker?.dispose();
  await engine?.stop();
  await rm(temp,{recursive:true,force:true});
}
