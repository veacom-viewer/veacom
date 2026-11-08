import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const browser=await chromium.launch({channel:process.env.VEACOM_BROWSER_CHANNEL??'chrome',headless:true,args:['--enable-gpu']});
const page=await browser.newPage({viewport:{width:1000,height:800}}), errors=[];
page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(process.env.VEACOM_ROI_TEST_URL??'http://127.0.0.1:5188/tools/roi-worker-check.html');
  await page.waitForFunction(()=>typeof window.runRoiWorkerProof==='function');
  const result=await page.evaluate(()=>window.runRoiWorkerProof());
  assert.equal(result.passed,true);
  assert.equal(errors.length,0,errors.join('\n'));
  assert.ok(result.profiles.every(profile=>profile.before.maxLongTaskMs>=50),'Synchronous baseline must demonstrate the original stall');
  assert.ok(result.profiles.every(profile=>profile.after.maxLongTaskMs===0),'Background calculation must not produce a50ms main-thread long task');
  const output=process.env.VEACOM_ROI_PROOF_OUTPUT??fileURLToPath(new URL('../../work/roi-profile/browser-result.json',import.meta.url));
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
