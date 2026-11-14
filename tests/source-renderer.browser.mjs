// Real WebGL2 browser checks; serve with Vite. Optional nativeColors are decoded native-fixture results.
import {sliceRenderer} from '../src/imaging/sliceRenderer.ts';

export function verifySourceGpu(nativeColors = []){
 const renderer=sliceRenderer(),gl=renderer.gl,run=`source-proof-${performance.now()}`,results=[],uploads=[];
 const meta={id:'',uid:'',studyUid:'',patientId:'SYNTHETIC',patientName:'Source GPU phantom',studyDate:'20261103',description:'Analytic pixels',modality:'CT',seriesNumber:1,dimensions:[2,2,1],spacing:[1,1,1],origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1],windowCenter:128,windowWidth:256,valueUnit:'HU',suvFactor:null,canReconstruct:true,warnings:[],photometricInterpretation:'MONOCHROME2',components:1};
 const baseView={mode:'source',plane:'axial',slice:0,windowCenter:128,windowWidth:256,zoom:1,pan:[0,0],rotation:0,flipX:false,flipY:false,inverted:false};
 const original2=gl.texImage2D,original3=gl.texImage3D;
 gl.texImage2D=function(...args){const data=args[8];uploads.push({target:'2d',width:args[3],height:args[4],internalFormat:args[2],type:args[7],array:data?.constructor.name,bytes:data?.byteLength,byteOffset:data?.byteOffset,data});return original2.apply(this,args)};
 gl.texImage3D=function(...args){const data=args[9];uploads.push({target:'3d',width:args[3],height:args[4],depth:args[5],internalFormat:args[2],type:args[8],array:data?.constructor.name,bytes:data?.byteLength,byteOffset:data?.byteOffset,data});return original3.apply(this,args)};
 const vol=(name,data,extra={})=>({series:{...meta,...extra,id:`${run}:${name}`},data});
 const canvas=(w,h=w)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c};
 const record=(name,passed,details={})=>results.push({name,passed,...details});
 const attempt=(name,body)=>{try{body()}catch(error){record(name,false,{error:String(error.message||error)})}};
 const pixel=(c,x,y)=>[...c.getContext('2d').getImageData(x,y,1,1).data];
 const checkPixel=(name,c,x,y,expected)=>{const actual=pixel(c,x,y),error=gl.getError();record(name,error===gl.NO_ERROR&&actual.every((n,i)=>Math.abs(n-expected[i])<=1),{actual,expected,glError:error})};
 const summary=items=>items.map(({data,...item})=>item);
 const mainUploads=before=>uploads.slice(before).filter(upload=>upload.internalFormat!==gl.RGBA32F);
 const max2D=gl.getParameter(gl.MAX_TEXTURE_SIZE),max3D=gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
 try{
  record('Actual GPU has a larger 2D texture limit than its 3D limit',max2D>=4096&&max2D>max3D,{max2D,max3D});
  for(const [w,h] of [[4096,32],[32,4096],[3072,3072]])attempt(`Large acquired image ${w}×${h}`,()=>{
   const data=new Uint16Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)data[y*w+x]=(x+3*y)%4096;
   const volume=vol(`large-${w}-${h}`,data,{dimensions:[w,h,1],pixelType:'uint16',canReconstruct:false,modality:'DX'}),c=canvas(w,h),before=uploads.length;
   renderer.render(c,volume,{...baseView,windowCenter:2048,windowWidth:4096});
   for(const [x,y] of [[0,0],[Math.floor(w/2),Math.floor(h/2)],[w-1,h-1]]){const grey=Math.round(data[y*w+x]/4095*255);checkPixel(`Large ${w}×${h} original pixel ${x},${y}`,c,x,y,[grey,grey,grey,255])}
   const sent=mainUploads(before);record(`Large ${w}×${h} uses one exact 2D texture`,sent.length===1&&sent[0].target==='2d'&&sent[0].width===w&&sent[0].height===h&&sent[0].data.buffer===data.buffer,{uploads:summary(sent)});
  });
  const types=[['int16',Int16Array,-100,0,401,gl.R16I],['uint16',Uint16Array,60000,32768,65536,gl.R16UI],['uint8',Uint8Array,200,128,256,gl.R8UI],['float32',Float32Array,42.25,0,401,gl.R32F],['float64',Float64Array,42.25000000001,0,401,gl.R32F]];
  for(const [kind,Ctor,value,center,width,format]of types)attempt(`${kind} source texture`,()=>{
   const data=new Ctor(12);data.fill(0,0,4);data.fill(value,4,8);data.fill(value/2,8);
   const volume=vol(`dtype-${kind}`,data,{dimensions:[2,2,3],pixelType:kind}),c=canvas(2),before=uploads.length;
   renderer.render(c,volume,{...baseView,slice:1,windowCenter:center,windowWidth:width});
   const grey=Math.round(Math.max(0,Math.min(1,(value-(center-.5))/(width-1)+.5))*255);checkPixel(`${kind} selected-frame scalar`,c,0,0,[grey,grey,grey,255]);
   const sent=mainUploads(before);record(`${kind} uploads only selected frame with exact GPU format`,sent.length===1&&sent[0].target==='2d'&&sent[0].internalFormat===format&&sent[0].bytes===4*(kind==='float64'?4:Ctor.BYTES_PER_ELEMENT),{uploads:summary(sent)});
   record(`${kind} original source values remain unchanged`,data.slice(4,8).every(n=>n===(kind==='float32'?Math.fround(value):value)));
  });
  // A frame over the 2D limit is drawn in tiles that give exactly the pixels of one texture (sliceRenderer frameTiles).
  for(const [label,components]of [['scalar',1],['float64',1],['RGB',3]])attempt(`Tiled ${label} frame matches one texture`,()=>{
   const w=300,h=260,data=components===3?new Uint8Array(w*h*3):label==='float64'?new Float64Array(w*h):new Uint16Array(w*h);
   for(let y=0;y<h;y++)for(let x=0;x<w;x++){const v=(x*7+y*13)%4096;if(components===3)data.set([x%256,y%256,(x+y)%256],(y*w+x)*3);else data[y*w+x]=v}
   const volume=vol(`tiled-${label}`,data,{dimensions:[w,h,1],pixelType:components===3?'uint8':label==='float64'?'float64':'uint16',components,canReconstruct:false,modality:'DX',...(label==='float64'?{paddingRange:[128,147]}:{})});
   for(const view of [{zoom:1},{zoom:1.7,rotation:30,pan:[13,-7]},{flipX:true,zoom:.8},{rotation:90,flipY:true,zoom:2.3,pan:[-40,25]}]){
    const settled={...baseView,windowCenter:2048,windowWidth:4096,...view},whole=canvas(w,h),tiled=canvas(w,h);
    renderer.render(whole,volume,settled);
    renderer.limitTexturesForTesting(200);
    const before=uploads.length;
    try{renderer.render(tiled,volume,settled)}finally{renderer.limitTexturesForTesting(null)}
    const a=whole.getContext('2d').getImageData(0,0,w,h).data,b=tiled.getContext('2d').getImageData(0,0,w,h).data;
    let different=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])different++;
    const sent=mainUploads(before);
    if(label==='float64' && view.zoom===1) record('Float64 conversion buffer holds only its tile',sent.length>1&&sent.every(tile=>tile.bytes===4*tile.width*tile.height),{uploads:summary(sent)});
    // The tiles are uploaded at the first view and reused after it.
    record(`Tiled ${label} ${JSON.stringify(view)}: every pixel as one texture, in tiles of at most 200`,different===0&&(view.rotation!==undefined||view.flipX!==undefined||sent.length>1)&&sent.every(u=>u.width<=200&&u.height<=200),{different,tiles:sent.length});
   }
  });
  attempt('No acquired-frame interpolation',()=>{
   const data=new Uint8Array([0,100,200,250,120,120,120,120,240,240,240,240]),volume=vol('nearest-source',data,{dimensions:[2,2,3],pixelType:'uint8'}),c=canvas(4);
   renderer.render(c,volume,baseView);checkPixel('Zoomed source image keeps nearest original intensity',c,1,1,[0,0,0,255]);
   renderer.render(c,volume,{...baseView,slice:.5});checkPixel('Fractional source slice selects one acquired frame',c,1,1,[120,120,120,255]);
  });
  attempt('Per-frame physical source geometry',()=>{
   const frames=[{origin:[10,20,30],direction:[1,0,0,0,1,0,0,0,1],spacing:[1,1,1]},
    {origin:[-30,17,101],direction:[0,-1,0,1,0,0,0,0,1],spacing:[2,3,4]}];
   const data=new Uint8Array([240,240,240,240,0,64,128,255]),volume=vol('frame-geometry',data,{dimensions:[2,2,2],pixelType:'uint8',canReconstruct:false,origin:[10,20,30],frameMetadata:frames}),c=canvas(4,6);
   renderer.render(c,volume,{...baseView,slice:1});
   for(const [x,y,value]of [[1,1,0],[3,1,64],[1,4,128],[3,4,255]])checkPixel(`Selected frame physical geometry pixel${x},${y}`,c,x,y,[value,value,value,255]);
   const compact={series:{...volume.series,id:`${run}:compact-frame`},data:data.slice(4),sourceFrameIndex:1},before=uploads.length;
   renderer.render(c,compact,{...baseView,slice:1});checkPixel('Frame-only payload keeps selected acquired geometry and data',c,3,4,[255,255,255,255]);
   const sent=mainUploads(before);record('Frame-only payload uploads exactly one source frame',sent.length===1&&sent[0].target==='2d'&&sent[0].bytes===4,{uploads:summary(sent)});
   let rejected=false,message='';try{renderer.render(c,compact,{...baseView,slice:0})}catch(error){rejected=true;message=String(error.message)}
   record('Frame-only payload never masquerades as another acquired frame',rejected,{message});
  });
  attempt('Pixel padding stays empty under inversion',()=>{
   const data=new Int16Array([-1000,100,-1000,200]),volume=vol('padding-mono1',data,{dimensions:[2,2,1],pixelType:'int16',photometricInterpretation:'MONOCHROME1',paddingRange:[-1000,-1000]}),c=canvas(2);
   renderer.render(c,volume,baseView);checkPixel('MONOCHROME1 padding stays black',c,0,0,[0,0,0,255]);checkPixel('MONOCHROME1 finite anatomy stays visible',c,1,0,[155,155,155,255]);
   renderer.render(c,volume,{...baseView,inverted:true});checkPixel('User inversion never makes padding white',c,0,1,[0,0,0,255]);checkPixel('User inversion still affects finite anatomy',c,1,1,[200,200,200,255]);
   record('Padding rendering preserves source scalars',data[0]===-1000&&data[1]===100&&data[2]===-1000&&data[3]===200);
  });
  attempt('Per-frame padding overrides shared padding',()=>{
   const frame={origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1],spacing:[1,1,1]},data=new Uint8Array([100,100,100,100,0,50,100,200]);
   const volume=vol('frame-padding',data,{dimensions:[2,2,2],pixelType:'uint8',paddingRange:[100,100],frameMetadata:[frame,{...frame,origin:[0,0,1],paddingRange:[0,50]}]}),c=canvas(2);
   renderer.render(c,volume,{...baseView,slice:1});for(let i=0;i<4;i++){const expected=[0,0,100,200][i];checkPixel(`Per-frame padding pixel${i}`,c,i%2,Math.floor(i/2),[expected,expected,expected,255])}
  });
  attempt('MPR excludes different padding ranges before interpolation',()=>{
   const frame={origin:[0,0,0],direction:[1,0,0,0,1,0,0,0,1],spacing:[1,1,1]},data=new Uint16Array([1000,100,1000,2000,2000,100]);
   const volume=vol('mpr-frame-padding',data,{dimensions:[3,1,2],pixelType:'uint16',frameMetadata:[{...frame,paddingRange:[1000,1000]},{...frame,origin:[0,0,1],paddingRange:[2000,2000]}]}),c=canvas(3,1),before=data.slice();
   renderer.render(c,volume,{...baseView,mode:'mpr',slice:.25});
   for(let i=0;i<3;i++){const expected=[0,100,0][i];checkPixel(`MPR quarter-slice per-frame padding pixel${i}`,c,i,0,[expected,expected,expected,255])}
   renderer.render(c,volume,{...baseView,mode:'mpr',slice:.75});
   for(let i=0;i<3;i++){const expected=[0,0,100][i];checkPixel(`MPR three-quarter-slice per-frame padding pixel${i}`,c,i,0,[expected,expected,expected,255])}
   record('MPR padding leaves original compact values unchanged',data.every((value,i)=>value===before[i]));
  });
  for(const [kind,Ctor]of [['float32',Float32Array],['float64',Float64Array]])attempt(`${kind} source non-finite padding`,()=>{
   const data=new Ctor([100,NaN,Infinity,-Infinity]),volume=vol(`nonfinite-${kind}`,data,{dimensions:[2,2,1],pixelType:kind}),c=canvas(2);
   renderer.render(c,volume,baseView);for(let i=0;i<4;i++){const expected=i===0?100:0;checkPixel(`${kind} source padding pixel${i}`,c,i%2,Math.floor(i/2),[expected,expected,expected,255])}
   record(`${kind} original padding unchanged`,data.every((value,i)=>Object.is(value,[100,NaN,Infinity,-Infinity][i])));
  });
  attempt('Float64 padding classification precedes display rounding',()=>{
   const data=new Float64Array([2**24,2**24+1,2**24+2]),volume=vol('float64-padding-rounding',data,{dimensions:[3,1,1],pixelType:'float64',paddingRange:[2**24,2**24]}),c=canvas(3,1);
   renderer.render(c,volume,baseView);checkPixel('Exact Float64 padding remains empty',c,0,0,[0,0,0,255]);checkPixel('Finite Float64 neighbour is not erased by Float32 rounding collision',c,1,0,[255,255,255,255]);
   record('Float64 padding collision fix preserves all source values',data[0]===2**24&&data[1]===2**24+1&&data[2]===2**24+2);
  });
  attempt('Fractional padding ranges do not erase neighbouring integer values',()=>{
   const data=new Uint16Array([1000,1001]),volume=vol('integer-padding-rounding',data,{dimensions:[2,1,1],pixelType:'uint16',paddingRange:[1000.00001,1001]}),c=canvas(2,1);
   renderer.render(c,volume,baseView);checkPixel('Integer below fractional padding boundary stays visible',c,0,0,[255,255,255,255]);checkPixel('Integer inside inclusive padding boundary stays empty',c,1,0,[0,0,0,255]);
   renderer.render(c,volume,{...baseView,mode:'mpr'});checkPixel('MPR uses the same exact integer padding boundary',c,0,0,[255,255,255,255]);
  });
  attempt('RGB acquired frame channel order',()=>{
   const colors=[[255,0,0],[0,255,0],[0,0,255],[9,70,201],[250,30,4],[13,222,77]],data=new Uint8Array([...Array(18).fill(0),...colors.flat()]);
   const volume=vol('rgb',data,{dimensions:[3,2,2],components:3,pixelType:'uint8',photometricInterpretation:'RGB',modality:'US',direction:[1,0,0,0,0,-1,0,1,0],origin:[10,20,30],spacing:[1.3,1.3,2.5]}),c=canvas(3,2),before=uploads.length;
   renderer.render(c,volume,{...baseView,slice:1,inverted:true,windowCenter:0,windowWidth:1});
   for(let i=0;i<colors.length;i++)checkPixel(`RGB exact channel and row stride ${i}`,c,i%3,Math.floor(i/3),[...colors[i],255]);
   const sent=mainUploads(before);record('RGB uses exact interleaved selected frame in RGB8 texture',sent.length===1&&sent[0].target==='2d'&&sent[0].internalFormat===gl.RGB8&&sent[0].bytes===18&&sent[0].data.buffer===data.buffer&&sent[0].byteOffset===18,{uploads:summary(sent)});
   c.style.width='480px';const section=document.createElement('section');section.innerHTML='<h2>Direct RGB source · exact channels and row stride</h2>';section.append(c);document.querySelector('#preview')?.append(section);
  });
  for(const fixture of nativeColors)attempt(`Native decoded color ${fixture.fixture}`,()=>{
   const data=new Uint8Array(fixture.volume),volume=vol(`native-${fixture.fixture}`,data,{dimensions:fixture.dimensions,components:3,pixelType:'uint8',photometricInterpretation:'RGB',modality:'US',canReconstruct:false}),c=canvas(4,1);
   renderer.render(c,volume,baseView);
   for(let i=0;i<4;i++)checkPixel(`${fixture.fixture}: native output pixel ${i}`,c,i,0,[...fixture.expected.slice(i*3,i*3+3),255]);
   if(fixture.fixture==='YBR_FULL-rle.dcm'){c.style.width='480px';const section=document.createElement('section');section.innerHTML='<h2>Native RLE YBR decode → acquired-frame GPU image</h2><p>Expected red, green, blue, grey</p>';section.append(c);document.querySelector('#preview')?.append(section)}
  });
  attempt('Per-frame multi-pane cache',()=>{
   const data=new Uint8Array(8*8*25);for(let frame=0;frame<25;frame++)data.fill(4+frame*8,frame*64,(frame+1)*64);
   const volume=vol('cache-25',data,{dimensions:[8,8,25],pixelType:'uint8'}),targets=Array.from({length:25},()=>canvas(8)),before=uploads.length;
   for(let pass=0;pass<2;pass++)for(let frame=0;frame<25;frame++){renderer.render(targets[frame],volume,{...baseView,slice:frame});if(pass===1)checkPixel(`Cached acquired frame ${frame}`,targets[frame],4,4,Array(3).fill(4+frame*8).concat(255))}
   const sent=mainUploads(before);record('25 source panes upload each requested frame once across repaint',sent.length===25&&sent.every(u=>u.target==='2d'&&u.bytes===64),{uploadCount:sent.length,uploads:summary(sent)});
  });
  attempt('Oversized-stack two-pane cache',()=>{
   const depth=max3D+1,data=new Uint8Array(4*depth).fill(100);data.fill(20,0,4);data.fill(200,data.length-4);
   const volume=vol('cache-long',data,{dimensions:[2,2,depth],pixelType:'uint8'}),a=canvas(2),b=canvas(2),before=uploads.length;
   for(let pass=0;pass<5;pass++){renderer.render(a,volume,baseView);renderer.render(b,volume,{...baseView,slice:depth-1})}
   checkPixel('Long-stack first source frame stays exact',a,0,0,[20,20,20,255]);checkPixel('Long-stack last source frame stays exact',b,0,0,[200,200,200,255]);
   const sent=mainUploads(before);record('Two long-stack panes reuse both frames instead of reuploading every repaint',sent.length===2&&sent.every(u=>u.target==='2d'&&u.bytes===4),{uploadCount:sent.length,uploads:summary(sent)});
  });
  attempt('Visible-pane pinning survives unrelated cache churn',()=>{
   const data=new Uint8Array(4*25);for(let frame=0;frame<25;frame++)data.fill(frame+50,frame*4,(frame+1)*4);
   const volume=vol('pinned-25',data,{dimensions:[2,2,25],pixelType:'uint8'}),views=Array.from({length:25},(_,slice)=>({volume,view:{...baseView,slice}})),c=canvas(2);
   renderer.setVisibleViews(views);
   try{
    for(const item of views)renderer.render(c,item.volume,item.view);
    for(let i=0;i<80;i++)renderer.render(c,vol(`cache-churn-${i}`,new Uint8Array(4).fill(i),{dimensions:[2,2,1],pixelType:'uint8'}),baseView);
    const before=uploads.length;for(const item of views)renderer.render(c,item.volume,item.view);
    record('All25 visible textures stay resident under the byte budget',mainUploads(before).length===0,{reuploads:mainUploads(before).length});
    checkPixel('Pinned source image still contains its original values',c,0,0,[74,74,74,255]);
   }finally{renderer.setVisibleViews([])}
  });
  attempt('Source and MPR texture cache coexist',()=>{
   const data=new Uint8Array(8).fill(80),volume=vol('source-mpr-cache',data,{dimensions:[2,2,2],pixelType:'uint8'}),c=canvas(2),before=uploads.length;
   renderer.render(c,volume,baseView);renderer.render(c,volume,{...baseView,mode:'mpr'});renderer.render(c,volume,baseView);
   const sent=mainUploads(before);record('Source/MPR/source keeps both textures without a third upload',sent.length===2&&sent.filter(u=>u.target==='2d').length===1&&sent.filter(u=>u.target==='3d').length===1,{uploads:summary(sent)});
   checkPixel('Source image remains exact after MPR switch',c,0,0,[80,80,80,255]);
  });
  attempt('Closing the last pane releases GPU images and reopening stays exact',()=>{
   const volume=vol('closed-workspace',new Uint16Array(8).fill(80),{dimensions:[2,2,2],pixelType:'uint16'}),c=canvas(2);
   renderer.setVisibleViews([{volume,view:baseView}]);renderer.render(c,volume,baseView);
   gl.activeTexture(gl.TEXTURE0);const sourceTexture=gl.getParameter(gl.TEXTURE_BINDING_2D);
   renderer.render(c,volume,{...baseView,mode:'mpr'});
   gl.activeTexture(gl.TEXTURE0);const mprTexture=gl.getParameter(gl.TEXTURE_BINDING_3D);
   record('Source and MPR textures exist before closing',gl.isTexture(sourceTexture)&&gl.isTexture(mprTexture));
   renderer.setVisibleViews([]);
   record('Closing all panes deletes their source and MPR textures',!gl.isTexture(sourceTexture)&&!gl.isTexture(mprTexture));
   record('An empty workspace releases the large drawing buffer',renderer.canvas.width===1&&renderer.canvas.height===1);
   const before=uploads.length;
   renderer.setVisibleViews([{volume,view:baseView}]);renderer.render(c,volume,baseView);
   checkPixel('Reopening a released image preserves original pixels',c,0,0,[80,80,80,255]);
   record('Reopening reuploads just the requested source frame',mainUploads(before).length===1);
   renderer.setVisibleViews([]);
  });
  attempt('Oblique MPR paging follows tilted normal',()=>{
   const data=new Uint16Array(27);for(let z=0;z<3;z++)for(let y=0;y<3;y++)for(let x=0;x<3;x++)data[(z*3+y)*3+x]=y*100;
   const volume=vol('oblique-normal',data,{dimensions:[3,3,3],pixelType:'uint16'}),c=canvas(1);
   renderer.render(c,volume,{...baseView,mode:'mpr',slice:0,oblique:[90,0]});checkPixel('Oblique first slice is physical Y2',c,0,0,[200,200,200,255]);
   renderer.render(c,volume,{...baseView,mode:'mpr',slice:1,oblique:[90,0]});checkPixel('Oblique next slice advances to physical Y1',c,0,0,[100,100,100,255]);
  });
  // Over the GPU's own 2D limit a source image is drawn in tiles, never downsampled (sliceRenderer frameTiles).
  attempt('Over-limit source image is drawn in tiles without downsampling',()=>{
   const data=new Uint8Array(max2D+1);for(let i=0;i<data.length;i++)data[i]=i%251;
   const volume=vol('too-wide',data,{dimensions:[data.length,1,1],pixelType:'uint8',canReconstruct:false});
   renderer.canvas.width=Math.min(64,gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);renderer.canvas.height=1;
   const width=gl.drawingBufferWidth,c=canvas(width,1),before=uploads.length;
   for(const left of [0,data.length-width]){
    renderer.render(c,volume,{...baseView,zoom:data.length/width,pan:[(data.length-width)/2-left,0]});
    for(const x of [0,width-2,width-1]){const grey=data[left+x];checkPixel(`Over-limit image pixel ${left+x}`,c,x,0,[grey,grey,grey,255])}
   }
   const sent=mainUploads(before);record('Over-limit image uploads tiles within the 2D limit',sent.length>1&&sent.every(u=>u.width<=max2D&&u.height<=max2D),{uploads:summary(sent)});
  });
 }finally{gl.texImage2D=original2;gl.texImage3D=original3}
 return {passed:results.every(r=>r.passed),renderer:renderer.info,hardwareLimits:{max2D,max3D},checks:results.length,metadataUploads:summary(uploads.filter(upload=>upload.internalFormat===gl.RGBA32F)),failures:results.filter(r=>!r.passed),results};
}
