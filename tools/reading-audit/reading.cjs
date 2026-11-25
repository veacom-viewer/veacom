const {fs,path,os,output,assert,sleep,fresh,tree,launch,closeDesktop,setView,save,PNG}=require('./desktop.cjs');
const {trace,jpeg}=require('./trace.cjs');

async function redrawCorner(page) {
    // Force a trace screenshot of an otherwise static window. The 2 px square is outside every image ROI.
    await page.evaluate(()=>{let e=document.getElementById('reading-audit-tick');
        if(!e){e=document.createElement('i');e.id='reading-audit-tick';e.style.cssText='position:fixed;top:1px;left:1px;width:2px;height:2px;z-index:99999;pointer-events:none';document.body.append(e);}
        e.style.backgroundColor=e.style.backgroundColor==='white'?'black':'white';
    });await sleep(40);
}
async function paging(page,depth) {
    await setView(page,{slice:Math.floor(depth/2)});
    const btn=page.getByTestId('dicom-viewport').first(),box=await btn.boundingBox();
    await page.mouse.move(box.x+box.width*.6,box.y+box.height*.45);
    await page.evaluate(()=>{let n=0;window.addEventListener('wheel',()=>performance.mark('bench:notch-'+n++),{capture:true,passive:true});});
    const stop=await trace(page);await redrawCorner(page);
    const count=12;
    for(let i=0;i<count;i++){await page.mouse.wheel(0,i<6?120:-120);await sleep(160);}
    await redrawCorner(page);const {marks,frames}=await stop();
    const inputs=Object.keys(marks).filter(k=>k.startsWith('bench:notch-')).sort((a,b)=>Number(a.split('-').at(-1))-Number(b.split('-').at(-1)));
    assert.equal(inputs.length,count,'one wheel event for every test input');
    const pixels=frames.filter(f=>f.index!==null&&f.unit/f.width>.008);
    const baseline=pixels.filter(f=>f.ts<marks[inputs[0]]).at(-1);
    assert(baseline,'Source image marker must be readable before the first notch');
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
async function mpr(page,depth,calibrating) {
    await setView(page,{slice:Math.floor((await page.evaluate(()=>window.__VEACOM_TEST__.state().dimensions[2]))/2)});
    await page.getByTestId('dicom-viewport').first().focus();
    await page.evaluate(()=>window.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='m')performance.mark('bench:mpr-command');},{capture:true,once:true}));
    if (calibrating) await page.evaluate(() => {
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
    await redrawCorner(page);await sleep(450);await redrawCorner(page);await page.keyboard.press('m');
    await page.waitForFunction(()=>new Set([...document.querySelectorAll('canvas[data-renderer]')].map(c=>c.dataset.plane)).size===3,undefined,{timeout:20000});
    await sleep(330);
    const panes=await page.evaluate(()=>[...document.querySelectorAll('canvas[data-renderer]')].map(c=>{
        const r=c.getBoundingClientRect();return {plane:c.dataset.plane,x:r.left/innerWidth,y:r.top/innerHeight,w:r.width/innerWidth,h:r.height/innerHeight};
    }));
    assert.deepEqual(panes.map(r=>r.plane).sort(),['axial','coronal','sagittal']);
    await redrawCorner(page);await redrawCorner(page);await redrawCorner(page);
    const {marks,frames}=await stop();
    const png=PNG.sync.read(await page.screenshot({scale:'css'}));
    const full=features({width:png.width,height:png.height,pixels:png.data},panes,8,6);
    const traceImage=jpeg(frames.at(-1).jpeg),last=features(traceImage,panes);
    const coarse=features(traceImage,panes,8,6);
    const crossResolutionCorrelation=coarse.map((plane,i)=>correlation(plane,full[i]));
    assert(crossResolutionCorrelation.every(r=>r>.9),'Full-window and trace images must correlate in each plane: '+crossResolutionCorrelation);
    if(calibrating) references.set(depth,last);
    const target=references.get(depth);
    assert(target.every(c=>Math.max(...c)-Math.min(...c)>70),'Each MPR plane must show contrast');
    const t=marks['bench:mpr-command'];assert(Number.isFinite(t));
    const scored=frames.map(f=>({ms:f.ts-t,errors:errors(features(jpeg(f.jpeg),panes),target)}));
    const values=scored.map(s=>Math.max(...s.errors));
    // Score against an independently launched calibration process at the same trace raster.
    const limit=2;
    assert(values.slice(-3).length===3 && values.slice(-3).every(v=>v<=limit),'Three final screenshots must agree with the calibration: '+values.slice(-3));
    assert(scored.some((s,i)=>s.ms<0 && values[i]>limit),'Single-plane negative control');
    assert(values.at(-1)<=limit,'Final MPR image must match the reference: '+values.at(-1));
    const lastWrong=scored.findLastIndex((s,i)=>s.ms>=0&&values[i]>limit);
    const matched=scored.find((s,i)=>s.ms>=0 && i>lastWrong&&values[i]<=limit);
    assert(matched);
    const calls=calibrating ? await page.evaluate(() => window.__mprCalls.filter(c => c.at>=window.__mprInput && (c.ms>=1 || c.name==='texImage3D'))
        .map(c=>({...c,at:c.at-window.__mprInput}))) : undefined;
    return {calls,timeToThreeStablePlanesMs:matched.ms,referenceToleranceGray:limit,planes:panes.map(b=>b.plane),crossResolutionCorrelation,screens:scored,referenceRange:target.map(t=>Math.max(...t)-Math.min(...t))};
}
async function main() {
    const rows=[],controls=[];
    const base=process.argv[5]??path.join(os.homedir(),'.cache/veacom-bench/studies');
    const rounds=Number(process.argv[6]??5);
    for(let run=0;run<=rounds;run++)for(const n of [1000]){
        const profile=await fresh();let current;
        try{
            current=await launch(profile,path.join(base,'ct-'+n,'S01'));
            const {page}=current;
            await page.waitForFunction(()=>window.__VEACOM_TEST__.state().fullVolumeLoaded,undefined,{timeout:90000});
            const state=await page.evaluate(()=>window.__VEACOM_TEST__.state());
            assert.equal(state.dimensions[2],n);
            const wheel=run?await paging(page,n):null,transition=await mpr(page,n,run===0);
            if(run===1)await page.screenshot({path:path.join(output,'mpr-three-planes.png')});
            (run?rows:controls).push({run,depth:n,renderer:await page.locator('canvas[data-renderer]').first().getAttribute('data-renderer'),paging:wheel,mpr:transition});
            await save('reading.json',{tree,controls,rows});
            console.log('CT',n,'trial',run,'wheel errors',wheel?.wrongSteps,'MPR ms',transition.timeToThreeStablePlanesMs);
        }finally{if(current)await closeDesktop(current.app);await fs.rm(profile,{recursive:true,force:true});}
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
