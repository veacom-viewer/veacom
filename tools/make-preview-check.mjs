// Exercise the two versions of the package's actual reference check with a real, temporary MR middle slice.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [head] = process.argv.slice(2);
const contents=execFileSync('git',['show',head+':web/tools/browser-check.mjs'],{encoding:'utf8'});
let src=contents.replace('import { mkdtempSync,','import { mkdirSync, writeFileSync, mkdtempSync,');
const start=src.indexOf('async function checkCachedPatientSwitches('),end=src.indexOf('\n}',start);
assert(start>=0 && end>start);
let test=src.slice(start,end);
const fixed=test.includes('state.displayedView?.slice === sourceFrame');
test=test.replace('  const references = new Map();',`  const mode=await page.evaluate(()=>self.crossOriginIsolated?'threaded':'single');
  const dir=path.join(process.env.VEACOM_SWITCH_OUT,mode);mkdirSync(dir,{recursive:true});
  const trace={warm:{},first:{}};const save=()=>writeFileSync(path.join(dir,'trace.json'),JSON.stringify(trace,null,2));
  const bytes=uri=>Buffer.from(uri.split(',')[1],'base64');
  const keep=(name,uri)=>{const b=bytes(uri);writeFileSync(path.join(dir,name+'.png'),b);return createHash('sha256').update(b).digest('hex');};
  const references=new Map();`);
test=test.replace('for (const { id } of series)', 'for (const { id, modality } of series)');
const clicked="    await page.getByTestId('series-' + id).click();";
assert(test.includes(clicked));
test=test.replace(clicked,clicked+`
    if(modality==='MR' && process.env.FORCE_PREVIEW==='yes'){
      await page.waitForFunction(id=>window.__VEACOM_TEST__.state().activeSeriesId===id&&window.__VEACOM_TEST__.state().fullVolumeLoaded,id);
      await page.evaluate(()=>window.__VEACOM_TEST__.setView({slice:1}));
      await page.waitForFunction(id=>{const c=document.querySelector('[data-testid="dicom-canvas"]');return c.dataset.seriesId===id&&c.dataset.sourceFrame==='1';},id);
      trace.middle=keep('MR-controlled-middle',await page.getByTestId('dicom-canvas').evaluate(c=>c.toDataURL()));
      await page.evaluate(()=>setTimeout(()=>window.__VEACOM_TEST__.setView({slice:2}),250));
    }`);
const loopEnd=test.indexOf('\n  }\n  assert.equal(new Set(references.values())');
assert(loopEnd>0);
test=test.slice(0,loopEnd)+`
    trace.warm[modality]=keep(modality+'-reference',references.get(id));
    if(modality==='MR' && process.env.FORCE_PREVIEW==='yes'){
      await page.waitForFunction(id=>{const c=document.querySelector('[data-testid="dicom-canvas"]');return c.dataset.seriesId===id&&c.dataset.sourceFrame==='2';},id);
      trace.superior=keep('MR-controlled-superior',await page.getByTestId('dicom-canvas').evaluate(c=>c.toDataURL()));
    }
    save();`+test.slice(loopEnd);
const assertion=fixed?'    assert.equal(first.series, id,':'    assert(pixels === references.get(id),';
assert(test.includes(assertion));
test=test.replace(assertion,`    trace.first[modality]=keep(modality+'-first',${fixed?'first.pixels':'pixels'});save();\n`+assertion);
src=src.slice(0,start)+test+src.slice(end);
src=src.replace('      await checkPatientDrop(browser, page.url(), false);','      await checkPatientDrop(browser, page.url(), false);\n      continue;');
writeFileSync('web/tools/reference-preview-check.mjs',src);
