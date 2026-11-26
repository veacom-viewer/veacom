const { assert,closeDesktop,fresh,fs,launch,output,path,repo,save,settle }=require('./desktop.cjs');
const { toggleMpr }=require(path.join(repo,'tools/lib/mpr.cjs'));
const studyRoot=path.resolve(process.argv[5]), candidate=path.resolve(process.argv[6]);
const measureEdges=process.env.EXERCISE==='physical-edges';
const source=JSON.parse(require('node:fs').readFileSync(path.join(output,'coordinate-source.json'),'utf8'));

function edgeViews(plane,bright,dark,width,height){
  const [h,v]=plane==='axial'?[0,1]:plane==='coronal'?[0,2]:[1,2];
  const {dimensions,spacing,markers}=source;
  const fit=Math.min(width/(dimensions[h]*spacing[h]),height/(dimensions[v]*spacing[v]));
  const views=[];
  for(const [i,slice] of [bright,dark].entries())for(const zoom of [1,2,4]){
    const marker=markers[i];
    const offset=axis=>(marker.low[axis]+marker.high[axis]-dimensions[axis]+1)*spacing[axis]/2;
    const pan=[-offset(h)*fit*zoom,offset(v)*fit*zoom*(plane==='axial'?-1:1)];
    views.push({label:(i===0?'bright':'dark')+'-'+zoom+'x',slice,zoom,pan});
  }
  return views;
}
const report={reference:process.env.REFERENCE_COMMIT,candidate:process.env.CANDIDATE_COMMIT,views:[]};
async function capture(checkout,build,encoding){
  const profile=await fresh();let current;
  try {
    current=await launch(profile,path.join(studyRoot,encoding),checkout);
    const {page}=current;
    await page.waitForFunction(()=>window.__VEACOM_TEST__.state().fullVolumeLoaded,undefined,{timeout:90000});
    const s=await page.evaluate(async()=>{const {series:[s]}=await window.veacom.listSeries();return {uid:s.uid,patient:s.patientId,dimensions:s.dimensions,spacing:s.spacing,direction:s.direction,origin:s.origin,frames:s.frameMetadata.length};});
    const orientation=encoding==='axial'?1:2;
    assert.equal(s.patient,'SYNTHETIC-MPR-'+orientation);assert.equal(s.uid,'2.25.150962532157482113344902996721560341569.2.'+orientation);
    await toggleMpr(page);
    await page.waitForFunction(()=>new Set([...document.querySelectorAll('canvas[data-renderer]')].map(c=>c.dataset.plane)).size===3);
    await settle(page);
    for(const [plane,count,bright,dark] of [['axial',384,110,245],['coronal',192,81,33],['sagittal',256,198,66]]){
      const canvas=page.locator('canvas[data-renderer][data-plane="'+plane+'"]');
      const cell=page.getByTestId('viewport-cell').filter({has:canvas});
      await cell.getByTestId('dicom-viewport').focus();
      await page.waitForFunction(p=>document.querySelector('.viewport-cell.is-active canvas[data-renderer]')?.dataset.plane===p,plane);
      const box=await canvas.boundingBox();
      const views=measureEdges?edgeViews(plane,bright,dark,box.width,box.height)
        :Object.entries({below:3,above:4,bright,dark,center:Math.floor((count-1)/2),last:count-4}).map(([label,slice])=>({label,slice,zoom:1,pan:[0,0]}));
      for(const {label,slice,zoom,pan} of views){
        const windowWidth=measureEdges?4096:2000;
        await page.evaluate(({slice,zoom,pan,windowWidth})=>window.__VEACOM_TEST__.setView({mode:'mpr',slice,windowWidth,windowCenter:0,zoom,rotation:0,pan,flipX:false,flipY:false}),{slice,zoom,pan,windowWidth});
        await page.waitForFunction(([p,z,zoom,width])=>{const c=document.querySelector('.viewport-cell.is-active canvas[data-renderer]'),v=window.__VEACOM_TEST__.state().displayedView;
          return c?.dataset.plane===p&&Math.abs(Number(c.dataset.slice)-z)<1e-7&&v.zoom===zoom&&v.windowWidth===width;},[plane,slice,zoom,windowWidth],{timeout:15000});
        await settle(page);
        const image=await canvas.evaluate(c=>{
          const rect=c.getBoundingClientRect(),pane=c.closest('[data-testid="dicom-viewport"]').getBoundingClientRect(),state=window.__VEACOM_TEST__.state().displayedView;
          return {width:c.width,height:c.height,cssWidth:rect.width,cssHeight:rect.height,ratio:devicePixelRatio,
            canvasOrigin:[rect.left,rect.top],paneOrigin:[pane.left,pane.top],paneSize:[pane.width,pane.height],
            adapter:c.dataset.renderer,view:state,png:c.toDataURL('image/png').split(',')[1]};
        });
        const name=build+'-'+encoding+'-'+plane+'-'+label;
        await fs.writeFile(path.join(output,name+'.png'),Buffer.from(image.png,'base64'));delete image.png;
        if(label==='bright'||label==='dark'||(measureEdges&&zoom===4))await cell.screenshot({path:path.join(output,name+'-visible.png')});
        report.views.push({name,build,encoding,series:s,plane,label,slice,...image});
        await save('patient-space.json',report);
      }
    }
  } catch(e) {
    if(current?.page)report.lastPane=await current.page.evaluate(()=>({state:window.__VEACOM_TEST__.state().displayedView,
      panes:[...document.querySelectorAll('canvas[data-renderer]')].map(c=>({plane:c.dataset.plane,slice:c.dataset.slice}))})).catch(()=>null);
    if(current?.page)await current.page.screenshot({path:path.join(output,build+'-'+encoding+'-error.png')}).catch(()=>{});
    report.error=String(e?.stack??e);await save('patient-space.json',report);throw e;
  } finally {
    if(current)await closeDesktop(current.app);
    await fs.rm(profile,{force:true,recursive:true});
  }
}
(async()=>{
  for(const [build,tree] of [['reference',repo],['candidate',candidate]])for(const series of ['axial','reversed-sagittal'])await capture(tree,build,series);
  assert.equal(report.views.length,72);
})().catch(e=>{console.error(e);process.exitCode=1;});

