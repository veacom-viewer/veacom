import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { dataset, element } from '../fixtures/dicom-elements.mjs';
import close from '../lib/close-desktop.cjs';

const [executable, directory]=process.argv.slice(2);
const out=path.resolve(directory), profile=mkdtempSync(path.join(tmpdir(),'veacom-window-profile-'));
const source=path.join(out,'source'), uid='2.25.62047513801436420093944067106387542817';
const ct='1.2.840.10008.5.1.4.1.1.2', sop=uid+'.3', size=144, codes=[-64,-48,-32,-4,0,1,2,4,8];
const bytes=Buffer.alloc(size*size*2);
for(let y=0;y<size;y++)for(let x=0;x<size;x++)bytes.writeInt16LE(codes[Math.floor(x/16)],2*(y*size+x));
const meta=dataset([[2,1,'OB',[0,1]],[2,2,'UI',ct],[2,3,'UI',sop],[2,0x10,'UI','1.2.840.10008.1.2.1'],[2,0x12,'UI',uid+'.5']]);
const contents=Buffer.concat([Buffer.alloc(128),Buffer.from('DICM'),element(2,0,'UL',meta.length),meta,dataset([
  [8,0x16,'UI',ct],[8,0x18,'UI',sop],[8,0x20,'DA','20000101'],[8,0x60,'CS','CT'],[8,0x103e,'LO','Window controls'],
  [0x10,0x10,'PN','WINDOW^PHANTOM'],[0x10,0x20,'LO','SYNTHETIC-INSTALLED-WINDOW'],[0x18,0x50,'DS',1],
  [0x20,0x0d,'UI',uid+'.1'],[0x20,0x0e,'UI',uid+'.2'],[0x20,0x11,'IS',1],[0x20,0x13,'IS',1],
  [0x20,0x32,'DS',[0,0,0]],[0x20,0x37,'DS',[1,0,0,0,1,0]],[0x20,0x52,'UI',uid+'.4'],
  [0x28,2,'US',1],[0x28,4,'CS','MONOCHROME2'],[0x28,0x10,'US',size],[0x28,0x11,'US',size],[0x28,0x30,'DS',[1,1]],
  [0x28,0x100,'US',16],[0x28,0x101,'US',16],[0x28,0x102,'US',15],[0x28,0x103,'US',1],
  [0x28,0x1050,'DS',.5],[0x28,0x1051,'DS',.125],[0x28,0x1052,'DS',.5],[0x28,0x1053,'DS',.015625],[0x28,0x1056,'CS','LINEAR_EXACT'],
  [0x7fe0,0x10,'OW',bytes],
])]);
mkdirSync(source,{recursive:true});writeFileSync(path.join(source,'bands.dcm'),contents);
const hash=data=>createHash('sha256').update(data).digest('hex');
const report={sourceSha256:hash(contents),states:[]};
let app, page;
try {
  const env={...process.env,VEACOM_USER_DATA:profile,VEACOM_TEST_MODE:'1'};delete env.VEACOM_CORE_PATH;
  app=await electron.launch({executablePath:executable,args:['--study',source],env,timeout:90000});
  report.runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,executable:app.getPath('exe'),resources:process.resourcesPath,electron:process.versions.electron}));
  assert(report.runtime.packaged);assert.equal(path.resolve(report.runtime.executable).toLowerCase(),path.resolve(executable).toLowerCase());
  report.engineSha256=hash(readFileSync(path.join(report.runtime.resources,'native','veacom-core.exe')));
  page=await app.firstWindow();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1250,800));
  await page.waitForFunction(()=>window.__VEACOM_TEST__?.state().fullVolumeLoaded,undefined,{timeout:90000});
  const patient=await page.evaluate(async()=>{const {series:[s]}=await window.veacom.listSeries();return {patient:s.patientId,sop:s.frameMetadata[0].sopInstanceUid};});
  assert.deepEqual(patient,{patient:'SYNTHETIC-INSTALLED-WINDOW',sop});report.patient=patient;
  const width=page.locator('[data-action="window-width-input"]'),level=page.locator('[data-action="window-level-input"]');
  for(const language of ['en','tr']){
    await page.getByTestId('tool-language').click();await page.getByTestId('language-'+language).click();
    assert.equal(await page.locator('html').getAttribute('lang'),language);
    if(!await page.locator('.inspector').isVisible())await page.getByTestId('tool-inspector').click();
    await page.getByTestId('inspector-tab-display').click();
    if(!await width.isVisible())await page.locator('#section-window-toggle').click();
    for(const [stage,w,c] of [['opening',.125,.5],['narrow',.0625,.484375],['negative',1.25,-.375],['restored',.125,.5]]){
      if(stage==='opening'||stage==='restored'){
        await page.getByTestId('tool-window-presets').click();await page.getByTestId('preset-dicom').click();
      } else {
        await width.fill('');await width.pressSequentially(String(w));await width.press('Tab');
        await level.fill('');await level.pressSequentially(String(c));await level.press('Tab');
      }
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await width.inputValue(),String(w));assert.equal(await level.inputValue(),String(c));
      const view=await page.evaluate(()=>window.__VEACOM_TEST__.state().displayedView);assert.equal(view.windowWidth,w);assert.equal(view.windowCenter,c);assert.equal(view.voiFunction,'LINEAR_EXACT');
      const pane=page.getByTestId('dicom-canvas').first(), file=language+'-'+stage+'.png';
      await pane.screenshot({path:path.join(out,file)});await page.screenshot({path:path.join(out,'screen-'+file)});
      report.states.push({language,stage,w,c,file,view,adapter:await pane.getAttribute('data-renderer'),overlay:await page.getByTestId('image-overlay').first().textContent()});
    }
  }
} catch(e) {
  report.error=String(e?.stack??e);if(page)await page.screenshot({path:path.join(out,'error.png')}).catch(()=>{});throw e;
} finally {
  writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));if(app)await close.closeDesktop(app);
  rmSync(profile,{recursive:true,force:true});
}

