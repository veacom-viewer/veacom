const {path,repo,jpegjs}=require('./desktop.cjs');
const {pathToFileURL}=require('node:url');
const analysis=import(pathToFileURL(path.join(repo,'tools/browser-bench/lib/trace.mjs')).href);
function jpeg(encoded) {
    const {data,width,height}=jpegjs.decode(Buffer.from(encoded,'base64'),{useTArray:true});
    return {pixels:data,width,height};
}
async function trace(page) {
    const cdp=await page.context().newCDPSession(page), events=[];
    cdp.on('Tracing.dataCollected',p=>events.push(...p.value));
    await cdp.send('Tracing.start',{transferMode:'ReportEvents',traceConfig:{includedCategories:['disabled-by-default-devtools.screenshot','blink.user_timing'],excludedCategories:['*']}});
    return async () => {
        let timeout;
        try {
            const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
            await cdp.send('Tracing.end');
            await Promise.race([complete,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Trace timed out')),30000);})]);
        } finally {clearTimeout(timeout);await cdp.detach();}
        return (await analysis).readTrace(events,jpeg);
    };
}
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2:null;};
const quant=(a,p)=>a.length?[...a].sort((x,y)=>x-y)[Math.ceil(p*a.length)-1]:null;
const mark=(page,name)=>page.evaluate(n=>performance.mark('bench:'+n),name);
module.exports={trace,median,quant,mark,jpeg};
