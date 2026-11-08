// Exact pixel and geometry checks through the packaged Electron → Rust → compositor path.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ignoreOutsideInput, launchDesktop } = require('./lib/outside-input.cjs');
const privileged = require('./privileged-imaging.cjs');

async function phantom(root) {
  const { element, dataset } = await import('./fixtures/dicom-elements.mjs');
  const base = '2.25.6194101', sop = '1.2.840.10008.5.1.4.1.1.2';
  for (const [series, modality, width, depth] of [[1,'CT',128,4], [2,'PT',128,4], [3,'CT',2,2051]]) {
    const dir = path.join(root, 'S' + series);
    await fs.mkdir(dir, { recursive: true });
    for (let z = 0; z < depth; z++) {
      const uid = base + '.' + series + '.' + (z + 1);
      const meta = dataset([[2,2,'UI',sop],[2,3,'UI',uid],[2,16,'UI','1.2.840.10008.1.2.1'],[2,18,'UI',base]]);
      const pixels = Buffer.alloc(2 * width * width);
      for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
        const v = series === 3 ? z % 251 : series === 2 ? 5 : x === 64 && y === 64 && z === 1 ? -1000 : x + y + 12*z;
        pixels.writeInt16LE(v, 2*(y*width+x));
      }
      const bytes = Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,dataset([
        [8,22,'UI',sop],[8,24,'UI',uid],[8,96,'CS',modality],[8,0x103e,'LO','Test ' + series],
        [0x20,0xd,'UI',base + (modality === 'PT' ? '.9' : '.7')],[0x20,0xe,'UI',base+'.8.'+series],[0x20,0x11,'IS',series],[0x20,0x13,'IS',z+1],
        [0x20,0x32,'DS',[0,0,z]],[0x20,0x37,'DS',[1,0,0,0,1,0]],[0x20,0x52,'UI',base+'.6'],
        [0x28,2,'US',1],[0x28,4,'CS','MONOCHROME2'],[0x28,0x10,'US',width],[0x28,0x11,'US',width],
        [0x28,0x30,'DS',[1,1]],[0x28,0x100,'US',16],[0x28,0x101,'US',16],[0x28,0x102,'US',15],[0x28,0x103,'US',1],
        [0x28,0x120,'SS',-1000],[0x28,0x1050,'DS',128],[0x28,0x1051,'DS',256],[0x7fe0,16,'OW',pixels],
      ])]);
      await fs.writeFile(path.join(dir,z+'.dcm'),bytes);
    }
  }
}
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(),'veacom-native-views-'));
  const study = path.join(tmp,'study');
  let app;
  try {
    await phantom(study);
    const exe = process.env.VEACOM_SMOKE_EXECUTABLE;
    app = await launchDesktop({ ...(exe ? { executablePath:exe, args:[] } : { args:[path.resolve(__dirname,'..')] }),
      env:{...process.env,VEACOM_USER_DATA:path.join(tmp,'profile'),VEACOM_TEST_MODE:'1',VEACOM_TELEMETRY_CONSENT:'denied'},timeout:90000 });
    const page = await app.firstWindow();
    await ignoreOutsideInput(app);
    await page.waitForFunction(()=>window.__VEACOM_TEST__);
    const hold = await app.evaluate(({app})=>app.__VEACOM_PRIVILEGED_TEST__.holdPixelRequests('volume'));
    await privileged.importPaths(app,page,[study]);
    const { catalog, generation } = await privileged.readCatalog(app);
    // Only import metadata and request the exact source frames needed by these views.
    const [ct,pet,long] = [1,2,3].map(n=>catalog.series.find(s=>s.seriesNumber===n));
    for (const s of [ct,pet,long]) assert(s?.canReconstruct, 'Phantom reconstructability');
    const target = 'veacom-native-9000000';
    await page.evaluate(id=>{const c=document.createElement('canvas');c.id=id;c.width=32;c.height=32;document.body.append(c);},target);
    let stamp=0;
    const draw=async (s, args, volume=false) => {
      const revision=++stamp;
      return page.evaluate(async({target,generation,revision,view,volume})=>{
        const canvas=document.getElementById(target);canvas.dataset.nativeRevision=String(revision);
        if(volume) await window.veacom.renderVolume(target,revision,generation,view);
        else await window.veacom.renderView(target,revision,generation,view);
        if(canvas.dataset.nativePresented!==String(revision)) throw new Error('Published the wrong frame');
        return Array.from(canvas.getContext('2d').getImageData(0,0,32,32).data);
      },{target,generation,revision,volume,view:{seriesId:s.id, revision:s.sourceRevision,width:32,height:32, ...args}});
    };
    const base={top:[61.5,62.5,1],right:[1,0,0],down:[0,1,0],center:128,widthValue:256,inverted:false,
      palette:-1,voiFunction:0,slabMode:0,slabHalf:0,slabStep:[0,0,0]};
    const frame=(s,i)=>({index:i,sopInstanceUid:s.frameMetadata[i].sopInstanceUid,sourceFrameNumber:s.frameMetadata[i].sourceFrameNumber});
    const expect=(pixels,x,y,...want)=>{const i=(y*32+x)*4;assert(want.every((c,n)=>Math.abs(pixels[i+n]-c)<=1),JSON.stringify({x,y,want,got:pixels.slice(i,i+3)}));};
    const source=await draw(ct,{...base,frame:frame(ct,1)});
    if (process.platform === 'win32') {
      const info = await page.evaluate(() => window.veacom.rendererInfo());
      if (/\b(?:Tesla |NVIDIA )T4\b/i.test(info.renderer)) {
        assert.equal(await page.locator('#' + target).getAttribute('data-native-transport'), 'bitmap');
        console.log('PASS clinical frames rendered on the T4 and transferred as pixels');
      }
    }
    expect(source,0,0,137,137,137);expect(source,2,1,0,0,0);expect(source,3,1,141,141,141);
    console.log('PASS acquired frame, 64-voxel tile boundary, padding');
    const { curveGrey, DISPLAY_CURVES, LOG_CURVE_K } = await import('../src/imaging/displayCurve.ts');
    for (const curve of ['linear', 'sqrt', 'log']) for (const inverted of [false, true]) {
      const args = { ...base, center:10.5, widthValue:21, curve:DISPLAY_CURVES[curve], logCurveK:LOG_CURVE_K, inverted };
      const grey = curveGrey(0.25, curve);
      const expected = Math.round(255 * (inverted ? 1-grey : grey));
      for (const plane of [{frame:frame(pet,1)}, {slabMode:1,slabHalf:2,slabStep:[0,0,1]}]) {
        expect(await draw(pet,{...args,...plane}),0,0,expected,expected,expected);
      }
    }
    console.log('PASS linear, square-root and logarithmic PET pixels before inversion on a source frame and MIP');
    const oblique=await draw(ct,{...base,top:[61.75,62.25,.1],right:[1,0,.2],down:[0,1,.1]});
    expect(oblique,0,0,128,128,128);expect(oblique,1,1,134,134,134);
    const max=await draw(ct,{...base,slabMode:1,slabHalf:1,slabStep:[0,0,1]});
    const min=await draw(ct,{...base,slabMode:2,slabHalf:1,slabStep:[0,0,1]});
    const mean=await draw(ct,{...base,slabMode:3,slabHalf:1,slabStep:[0,0,1]});
    expect(max,0,0,149,149,149);expect(min,0,0,125,125,125);expect(mean,0,0,137,137,137);
    const inverted=await draw(ct,{...base,inverted:true});expect(inverted,0,0,118,118,118);
    assert.notEqual(ct.studyUid, pet.studyUid);
    assert.equal(ct.frameOfReferenceUid, pet.frameOfReferenceUid);
    const fused=await draw(ct,{...base,fusion:{seriesId:pet.id,revision:pet.sourceRevision,opacity:1,upper:10,factor:1,palette:0,classic:true}});
    expect(fused,0,0,255,153,0);
    const relative = await draw(ct, {...base,fusion:{seriesId:pet.id,revision:pet.sourceRevision,opacity:1,upper:10,palette:0,classic:true}});
    expect(relative,0,0,255,153,0);
    console.log('PASS oblique interpolation, MIP, MinIP, mean, inversion and fusion');
    const deep=await draw(long,{...base,top:[-.5,-.5,2050],frame:frame(long,2050)});expect(deep,0,0,42,42,42);
    const deepMpr=await draw(long,{...base,top:[-.5,0,2048.5],down:[0,0,1]});expect(deepMpr,0,0,41,41,41);
    console.log('PASS source and reconstructed views at depth 2051');
    const { Matrix4, PerspectiveCamera } = await import('three');
    const camera=new PerspectiveCamera(35,1,.1,1200);camera.up.set(0,0,1);camera.position.set(0,-180,0);camera.lookAt(0,0,0);camera.updateMatrixWorld();
    const scene={target,layerRevision:0,center:[64,64,1.5],eye:camera.position.toArray(),
      inverseVp:new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).invert().toArray(),
      cropMin:[0,0,0],cropMax:[127,127,3],threshold:120,ramp:20,step:.5,indexStep:.5};
    const tissue=await draw(ct,scene,true), blank=await draw(ct,{...scene,threshold:10000},true);
    assert(tissue.some((v,i)=>i%4!==3 && v>blank[i]+32), 'No tissue drawn');
    const background=[6,9,11,255];
    assert(blank.every((v,i)=>Math.abs(v-background[i%4])<=1),'Expected empty 3D background, got '+blank.slice(0,4));
    console.log('PASS 3D raycast draws tissue and removes it above threshold');
    const layers = (s, version, words) => page.evaluate(({id, revision, generation, target, version, words}) =>
      window.veacom.volumeLayers(id, revision, generation, target, version, new Uint8Array(new Uint32Array(words).buffer)),
      {id:s.id, revision:s.sourceRevision, generation, target, version, words});
    const count = 128 * 128 * 4;
    await layers(ct, 1, [1,0,1,0,0,count,1]);
    assert.deepEqual(await draw(ct, {...scene,layerRevision:1}, true), blank);
    // An obsolete view closing after another series occupies this target cannot erase its mask.
    await layers(pet, 1, []);
    assert.deepEqual(await draw(ct, {...scene,layerRevision:1}, true), blank);
    const undo = [2,1,count];
    for (let i = 0; i < count; i++) undo.push(i, 0);
    await layers(ct, 2, undo);
    assert.deepEqual(await draw(ct, {...scene,layerRevision:2}, true), tissue);
    await layers(ct, 1, []);
    assert.deepEqual(await draw(ct, {...scene,layerRevision:2}, true), tissue);
    await layers(ct, 2, []);
    console.log('PASS carving, undo, and stale mask disposal across series and revisions');
    const mesh=await page.evaluate(async({id,generation,revision,target})=>{
      const raw=await window.veacom.surfaceMesh(id,generation,revision,target,{layerRevision:0,threshold:142.5,crop:{min:[56,58,0],max:[80,80,3]}});
      const view=new DataView(raw), triangles=view.getUint32(80,true);let deviation=0;
      for(let at=84;at<raw.byteLength;at+=50)for(let p=at+12;p<at+48;p+=12){
        deviation=Math.max(deviation,Math.abs(view.getFloat32(p,true)+view.getFloat32(p+4,true)+12*view.getFloat32(p+8,true)-142.5));
      }
      return {triangles,deviation,size:raw.byteLength};
    },{id:ct.id,generation,revision:ct.sourceRevision,target});
    assert(mesh.triangles>0 && mesh.size===84+50*mesh.triangles && mesh.deviation<0.0001,JSON.stringify(mesh));
    console.log('PASS surgical STL is in patient coordinates');
    const selected=await page.evaluate(async({id,generation,revision,target})=>{
      const candidate=target+'-selection';
      const body=new Uint32Array([1,0,1,0,0,128*128,2]);
      await window.veacom.volumeLayers(id,revision,generation,candidate,1,new Uint8Array(body.buffer));
      try {
        return await window.veacom.measure(id,generation,revision,{kind:'selection',target:candidate,layerRevision:1,crop:{min:[63,63,0],max:[65,65,2]}});
      } finally { await window.veacom.volumeLayers(id,revision,generation,candidate,1,new Uint8Array()); }
    },{id:ct.id,generation,revision:ct.sourceRevision,target});
    assert.deepEqual(selected,{min:[63,63,1],max:[65,65,2],insideCount:17});
    console.log('PASS selection excludes the mask and declared source padding');
    const counts=await app.evaluate(({app})=>app.__VEACOM_PRIVILEGED_TEST__.pixelRequestCounts());
    assert.equal(counts.volume??0,0);
    await app.evaluate(({app},id)=>app.__VEACOM_PRIVILEGED_TEST__.releasePixelRequests(id),hold);
    console.log('PASS all views and STL with zero frontend volume requests');
  } finally {if(app)await app.close();await fs.rm(tmp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
