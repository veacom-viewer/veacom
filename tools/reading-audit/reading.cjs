const {fs,path,os,output,assert,sleep,fresh,tree,launch,closeDesktop,setView,save,PNG}=require('./desktop.cjs');
const {trace,jpeg}=require('./trace.cjs');
const {repo}=require('./desktop.cjs');
const {pathToFileURL}=require('node:url');
const pictures=import(pathToFileURL(path.join(repo,'tools/browser-bench/lib/trace.mjs')).href);

async function redrawCorner(page) {
    // Force a trace screenshot of an otherwise static window. The corner square is outside every image ROI.
    await page.evaluate(()=>{let e=document.getElementById('reading-audit-tick');
        if(!e){e=document.createElement('i');e.id='reading-audit-tick';e.style.cssText='position:fixed;bottom:2px;right:2px;width:16px;height:16px;z-index:99999;pointer-events:none';document.body.append(e);}
        e.style.backgroundColor=e.style.backgroundColor==='white'?'black':'white';
    });await sleep(40);
}
async function paging(page,depth) {
    await setView(page,{slice:Math.floor(depth/2)});
    const btn=page.getByTestId('dicom-viewport').first(),box=await btn.boundingBox();
    await page.mouse.move(box.x+box.width*.6,box.y+box.height*.45);
    await page.evaluate(()=>{let n=0;window.addEventListener('wheel',()=>performance.mark('bench:notch-'+n++),{capture:true,passive:true});});
    const stop=await trace(page);
    for(let i=0;i<6;i++){await redrawCorner(page);await sleep(100);}
    const before=PNG.sync.read(await page.screenshot({scale:'css'}));
    const actual=(await pictures).readPicture({width:before.width,height:before.height,pixels:before.data});
    const expected=await page.evaluate(() => {
        const state=window.__VEACOM_TEST__.state(), series=state.series.find(s=>s.id===state.activeSeriesId);
        // The phantom stores marker k at patient z = -k. Catalog slices follow the volume's patient-space axis.
        return Math.round(-(series.origin[2]+series.direction[8]*series.spacing[2]*state.view.slice));
    });
    assert.equal(actual.index,expected,'The source pixels must identify the selected physical slice before paging');
    const count=12;
    for(let i=0;i<count;i++){await page.mouse.wheel(0,i<6?120:-120);await sleep(160);}
    await redrawCorner(page);const {marks,frames}=await stop();
    const inputs=Object.keys(marks).filter(k=>k.startsWith('bench:notch-')).sort((a,b)=>Number(a.split('-').at(-1))-Number(b.split('-').at(-1)));
    assert.equal(inputs.length,count,'one wheel event for every test input');
    const pixels=frames.filter(f=>f.index!==null&&f.unit/f.width>.008);
    const recorded=pixels.filter(f=>(f.estimateMs??f.ts)<marks[inputs[0]]).at(-1);
    if(recorded) assert.equal(recorded.index,actual.index,'Trace and independent pre-notch capture must agree');
    const baseline=actual;
    const steps=[];let previous=baseline.index;
    for(let i=0;i<count;i++){
        const t=marks[inputs[i]],end=i+1<count?marks[inputs[i+1]]:Infinity;
        const changes=pixels.filter(f=>f.ts>=t&&f.ts<end&&f.index!==previous);
        const seen=changes[0];
        steps.push({from:previous,to:seen?.index??null,delayMs:seen?seen.ts-t:null,extraIndices:[...new Set(changes.map(f=>f.index))].slice(1)});
        if(seen)previous=seen.index;
    }
    const sign=Math.sign(steps[0].to-baseline.index);
    const bad=steps.filter((s,i)=>s.to===null||s.to-s.from!==(i<6?sign:-sign)||s.extraIndices.length);
    return {start:baseline.index,end:previous,expectedOneSlice:count,wrongSteps:bad.length,steps};
}
function features(image,boxes,cols=16,rows=12){
    return boxes.map(b=>{
        const v=[];
        for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){
            const x0=Math.floor((b.x+b.w*(.14+.72*x/cols))*image.width);
            const x1=Math.max(x0+1,Math.floor((b.x+b.w*(.14+.72*(x+1)/cols))*image.width));
            const y0=Math.floor((b.y+b.h*(.16+.68*y/rows))*image.height);
            const y1=Math.max(y0+1,Math.floor((b.y+b.h*(.16+.68*(y+1)/rows))*image.height));
            let sum=0;
            for(let iy=y0;iy<y1;iy++)for(let ix=x0;ix<x1;ix++)sum+=image.pixels[4*(iy*image.width+ix)+1];
            v.push(sum/((x1-x0)*(y1-y0)));
        }
        return v;
    });
}
function errors(a,b){return a.map((r,i)=>r.reduce((acc,v,j)=>acc+Math.abs(v-b[i][j]),0)/r.length);}
const references=new Map();
function correlation(a,b){
    const mean=x=>x.reduce((s,v)=>s+v,0)/x.length,ma=mean(a),mb=mean(b);
    let product=0,va=0,vb=0;
    for(let i=0;i<a.length;i++){const x=a[i]-ma,y=b[i]-mb;product+=x*y;va+=x*x;vb+=y*y;}
    return product/Math.sqrt(va*vb);
}
async function mpr(page,depth,calibrating,diagnostic,recording,scenario) {
    if(scenario==='reading')await setView(page,{slice:Math.floor((await page.evaluate(()=>window.__VEACOM_TEST__.state().dimensions[2]))/2)});
    await page.getByTestId('dicom-viewport').first().focus();
    await page.evaluate(()=>window.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='m')performance.mark('bench:mpr-command');},{capture:true,once:true}));
    if (diagnostic) await page.evaluate(() => {
        // The diagnostic launch records driver waits. The 30 counted launches use the untouched WebGL methods.
        window.__mprCalls = [];
        for (const name of ['texImage3D', 'texImage2D', 'getError', 'getProgramParameter', 'drawArrays']) {
            const api = WebGL2RenderingContext.prototype, original = api[name];
            api[name] = function(...args) {
                const at = performance.now();
                try { return original.apply(this, args); } finally {
                    window.__mprCalls.push({name,at,ms:performance.now()-at,...(name==='texImage3D'?{dimensions:args.slice(3,6)}:{})});
                }
            };
        }
        window.addEventListener('keydown', event => {
            if(event.key.toLowerCase()==='m') window.__mprInput=performance.now();
        },{capture:true,once:true});
    });
    const stop=await trace(page);
    if(scenario==='reading')for(let i=0;i<6;i++){await redrawCorner(page);await sleep(100);}
    else await redrawCorner(page);
    const before = PNG.sync.read(await page.screenshot({scale:'css'}));
    assert.equal(await page.locator('canvas[data-renderer]').count(),1);
    if(scenario==='reading')await redrawCorner(page);
    await page.waitForFunction(()=>window.__VEACOM_TEST__.state().fullVolumeLoaded && Number.isFinite(window.__readyAt),undefined,{timeout:90000});
    await page.keyboard.press('m');
    await page.waitForFunction(()=>new Set([...document.querySelectorAll('canvas[data-renderer]')].map(c=>c.dataset.plane)).size===3,undefined,{timeout:20000});
    await sleep(330);
    const panes=await page.evaluate(()=>[...document.querySelectorAll('canvas[data-renderer]')].map(c=>{
        const r=c.getBoundingClientRect();return {plane:c.dataset.plane,x:r.left/innerWidth,y:r.top/innerHeight,w:r.width/innerWidth,h:r.height/innerHeight};
    }));
    assert.deepEqual(panes.map(r=>r.plane).sort(),['axial','coronal','sagittal']);
    await redrawCorner(page);await redrawCorner(page);await redrawCorner(page);
    const {marks,frames}=await stop();
    if(recording){
        const dir=path.join(output,recording);await fs.mkdir(dir,{recursive:true});
        const times=[];
        for(const [i,frame] of frames.entries()){
            const file=String(i).padStart(4,'0')+'.jpg';
            await fs.writeFile(path.join(dir,file),Buffer.from(frame.jpeg,'base64'));
            times.push({file,ms:frame.ts-marks['bench:mpr-command']});
        }
        await fs.writeFile(path.join(dir,'captured.json'),JSON.stringify(times));
    }
    const png=PNG.sync.read(await page.screenshot({scale:'css'}));
    const full=features({width:png.width,height:png.height,pixels:png.data},panes,8,6);
    const traceImage=jpeg(frames.at(-1).jpeg),last=features(traceImage,panes);
    const coarse=features(traceImage,panes,8,6);
    const crossResolutionCorrelation=coarse.map((plane,i)=>correlation(plane,full[i]));
    assert(crossResolutionCorrelation.every(r=>r>.9),'Full-window and trace images must correlate in each plane: '+crossResolutionCorrelation);
    const key=depth+'-'+scenario;
    if(calibrating) references.set(key,last);
    const target=references.get(key);
    assert(target.every(c=>Math.max(...c)-Math.min(...c)>70),'Each MPR plane must show contrast');
    const t=marks['bench:mpr-command'];assert(Number.isFinite(t));
    const scored=frames.map(f=>({ms:f.ts-t,estimateMs:f.estimateMs===undefined?null:f.estimateMs-t,errors:errors(features(jpeg(f.jpeg),panes),target)}));
    const negative=errors(features({width:before.width,height:before.height,pixels:before.data},panes,8,6),full);
    await save('most-recent-trace.json',{negative,scored,crossResolutionCorrelation,panes});
    assert(Math.max(...negative)>10,'The independent single-pane capture must fail the three-plane reference');
    const values=scored.map(s=>Math.max(...s.errors));
    // Score against an independently launched calibration process at the same trace raster.
    const limit=2;
    assert(values.slice(-3).length===3 && values.slice(-3).every(v=>v<=limit),'Three final screenshots must agree with the calibration: '+values.slice(-3));
    const traceNegative=scored.some((s,i)=>(s.ms<0 || (s.estimateMs!==null && s.estimateMs<0)) && values[i]>limit);
    assert(traceNegative,'The trace must cover a single-pane frame before the command');
    assert(values.at(-1)<=limit,'Final MPR image must match the reference: '+values.at(-1));
    const lastWrong=scored.findLastIndex((s,i)=>s.ms>=0&&values[i]>limit);
    const matched=scored.find((s,i)=>s.ms>=0 && i>lastWrong&&values[i]<=limit);
    assert(matched);
    const calls=diagnostic ? await page.evaluate(() => window.__mprCalls.filter(c => c.at>=window.__mprInput && (c.ms>=1 || c.name==='texImage3D'))
        .map(c=>({...c,at:c.at-window.__mprInput}))) : undefined;
    const readiness=await page.evaluate(()=>({alreadyLoadedAtAttach:window.__readyAtAttach,readyMs:window.__readyAt,
        firstCanvasMs:performance.getEntriesByName('veacom:first-draw')[0]?.startTime,
        commandAfterObservedReadyMs:performance.getEntriesByName('bench:mpr-command')[0].startTime-window.__readyAt}));
    return {calls,readiness,timeToThreeStablePlanesMs:matched.ms,referenceToleranceGray:limit,planes:panes.map(b=>b.plane),crossResolutionCorrelation,screens:scored,referenceRange:target.map(t=>Math.max(...t)-Math.min(...t))};
}
async function main() {
    const rows=[],controls=[];
    const base=process.argv[5]??path.join(os.homedir(),'.cache/veacom-bench/studies');
    const rounds=Number(process.argv[6]??5);
    const builds=[{name:'reference',folder:repo}, {name:'candidate',folder:path.resolve(process.argv[7])}];
    const n=1000;
    for(let run=0;run<=rounds;run++)for(const scenario of run%2?['loaded','reading']:['reading','loaded'])for(const build of (run%2 ? [...builds].reverse() : builds)){
        const profile=await fresh();let current;
        try{
            current=await launch(profile,path.join(base,'ct-'+n,'S01'),build.folder);
            const {page}=current;
            await page.evaluate(()=>{
                const ready=()=>document.querySelector('[data-testid="viewport-cell"]')?.dataset.volumeComplete==='true';
                window.__readyAtAttach=ready();
                if(window.__readyAtAttach){window.__readyAt=performance.now();return;}
                const obs=new MutationObserver(()=>{if(ready()){window.__readyAt=performance.now();obs.disconnect();}});
                obs.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-volume-complete']});
            });
            assert.equal(await page.evaluate(()=>window.__VEACOM_TEST__.state().dimensions[2]),n);
            if(scenario==='reading')await page.waitForFunction(()=>window.__VEACOM_TEST__.state().fullVolumeLoaded,undefined,{timeout:90000});
            const wheel=run&&scenario==='reading'?await paging(page,n):null;
            const transition=await mpr(page,n,run===0 && build.name==='reference',run===0,run===1&&scenario==='reading'?build.name:undefined,scenario);
            if(run===1)await page.screenshot({path:path.join(output,build.name+'-'+scenario+'-three-planes.png')});
            (run?rows:controls).push({build:build.name,scenario,run,depth:n,renderer:await page.locator('canvas[data-renderer]').first().getAttribute('data-renderer'),paging:wheel,mpr:transition});
            await save('reading.json',{tree,referenceCommit:process.env.REFERENCE_COMMIT,candidateCommit:process.env.CANDIDATE_COMMIT,controls,rows});
            console.log(build.name,'CT',n,'trial',run,'wheel errors',wheel?.wrongSteps,'MPR ms',transition.timeToThreeStablePlanesMs);
        }finally{if(current)await closeDesktop(current.app);await fs.rm(profile,{recursive:true,force:true});}
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
