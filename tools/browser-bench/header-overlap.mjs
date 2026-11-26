import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { makeStudy } from './make-study.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scratch = await mkdtemp(path.join(tmpdir(), 'veacom-file-timing-'));
const folder = path.join(scratch, 'ct-300');
const headReader = await readFile(new URL('../../web/file-heads.js', import.meta.url));
function workerBody(readHeads) {
  const pending = [], held = [];
  self.onmessage = async ({ data }) => {
    try {
      if (data.start) { self.postMessage({ ready: true }); return; }
      if (data.entries) {
        const job = readHeads(data.entries).then(heads => {
          for (const [i, entry] of data.entries.entries()) held.push({ path: entry.path, head: heads[i] });
        });
        pending.push(job);
      } else if (data.finish) {
        await Promise.all(pending);
        self.postMessage({ complete: true });
      } else if (data.verify) {
        const hashes = {};
        for (const { path, head } of held) {
          const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', head));
          hashes[path] = Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
        }
        self.postMessage({ hashes });
      }
    } catch (error) { self.postMessage({ error: String(error) }); }
  };
}
const workerScript = "import {readHeads} from '/file-heads.js';\n("+workerBody.toString()+")(readHeads);";

function prepare(mode) {
  const worker = new Worker('/worker.js', { type:'module' });
  const ready = Promise.withResolvers(), complete = Promise.withResolvers(), verified = Promise.withResolvers();
  worker.onmessage = ({ data }) => {
    if (data.error) { complete.reject(new Error(data.error)); verified.reject(new Error(data.error)); }
    if (data.ready) ready.resolve();
    if (data.complete) complete.resolve(performance.now());
    if (data.hashes) verified.resolve(data.hashes);
  };
  worker.onerror = e => { ready.reject(new Error(e.message)); complete.reject(new Error(e.message)); };
  worker.postMessage({start:true});
  window.probeStage = 'waiting for a native drop';
  window.result = new Promise((resolve, reject) => document.addEventListener('drop', event => {
    event.preventDefault();
    window.probeStage = 'reading the directory entries';
    const root = event.dataTransfer.items[0].webkitGetAsEntry();
    const start = performance.now();
    (async () => {
      const entries = [];
      async function visit(entry, name) {
        if (entry.isFile) { entries.push({ entry, path:name }); return; }
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((done, fail) => reader.readEntries(done,fail));
          if (!batch.length) break;
          await Promise.all(batch.map(child => visit(child, name ? name+'/'+child.name : child.name)));
        }
      }
      await visit(root, '');
      window.probeStage = 'acquiring ' + entries.length + ' files';
      const listed = performance.now(), counts = [], acquired = [], times = [];
      let firstGroup, firstSent;
      const size = 16;
      const send = batch => {
        firstSent ??= performance.now();
        worker.postMessage({ entries:batch });
      };
      await Promise.all(entries.map(({entry,path},i) => new Promise((done,fail) => entry.file(file => {
        acquired[i] = {path,file};
        times.push(performance.now());
        const group = Math.floor(i/size);
        counts[group] = (counts[group] ?? 0)+1;
        const from=group*size, until=Math.min(from+size,entries.length);
        if (counts[group] === until-from) {
          firstGroup ??= performance.now();
          if (mode==='overlap') send(acquired.slice(from,until));
        }
        done();
      }, fail))));
      const all = performance.now();
      if(mode==='single') send(acquired);
      if(mode==='grouped') for(let i=0;i<acquired.length;i+=size) send(acquired.slice(i,i+size));
      window.probeStage = 'waiting for header reads';
      worker.postMessage({finish:true});
      const end = await complete.promise;
      window.probeStage = 'checking prefix hashes';
      worker.postMessage({verify:true});
      const hashes = await verified.promise;
      resolve({ files:acquired.length, listedMs:listed-start, firstFileMs:times[0]-listed,
        medianFileMs:times[Math.floor(times.length/2)]-listed, acquisitionMs:all-listed,
        firstCompletedGroupMs:firstGroup-listed, availableOverlapMs:all-firstGroup,
        sentBeforeAllMs:all-firstSent, afterAcquisitionMs:end-all, totalMs:end-start, hashes });
    })().catch(reject).finally(() => worker.terminate());
  },{once:true}));
  return ready.promise;
}

const server = createServer((req,res) => {
  const resources = {
    '/':['text/html','<!doctype html><body style="min-height:100vh">Synthetic CT folder measurement</body>'],
    '/worker.js':['text/javascript',workerScript], '/file-heads.js':['text/javascript',headReader],
  };
  const file = resources[req.url];
  if (!file) { res.writeHead(404);res.end();return; }
  res.writeHead(200, {'Content-Type':file[0],'Cache-Control':'no-store'});res.end(file[1]);
});
let browser;
try {
  const manifest=await makeStudy('ct-300',folder);
  const expected={};
  for(const file of [...Object.keys(manifest.sha256),'manifest.json']) expected[file]=sha((await readFile(path.join(folder,file))).subarray(0,65536));
  assert.equal(Object.keys(expected).length,301);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch();
  const page=await browser.newPage();
  await page.goto('http://127.0.0.1:'+server.address().port);
  const cdp=await page.context().newCDPSession(page);
  await page.evaluate(() => {
    for(const type of ['dragenter','dragover']) document.addEventListener(type,e=>{
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
  });
  async function timed(label, work) {
    let timer;
    const deadline = new Promise((_,reject) => {
      timer=setTimeout(()=>reject(new Error('Timed out during '+label)),20_000);
    });
    try { return await Promise.race([work,deadline]); }
    catch (error) {
      console.error(label,await page.evaluate(()=>window.probeStage));
      throw error;
    } finally { clearTimeout(timer); }
  }
  const orders=[['single','grouped','overlap'],['grouped','overlap','single'],['overlap','single','grouped'],
    ['overlap','grouped','single'],['grouped','single','overlap'],['single','overlap','grouped']];
  const trials=[];
  for(let round=-1;round<12;round++) {
    const order=orders[(round+orders.length)%orders.length];
    for(const mode of order) {
      await timed('worker startup',page.evaluate(prepare,mode));
      for(const type of ['dragEnter','dragOver','drop']) await cdp.send('Input.dispatchDragEvent',{type,x:100,y:80,data:{items:[],files:[folder],dragOperationsMask:1}});
      const {hashes,...timing}=await timed(mode+' drop '+round,page.evaluate(() => window.result));
      console.log(round,mode,'files',timing.files,'ms',Math.round(timing.totalMs));
      assert.deepEqual(hashes,expected);
      if(round>=0)trials.push({round,mode,slot:order.indexOf(mode)+1,...timing});
    }
  }
  const record={platform:process.platform,cpu:cpus()[0].model,chromium:browser.version(),headReaderSha256:sha(headReader),
    cohort:'300 generated CT slices and the original manifest', fixtureSha256:sha(await readFile(path.join(folder,'manifest.json'))),
    verifiedPrefixesPerTrial:Object.keys(expected).length, groups:16, trials};
  await writeFile(process.argv[2],JSON.stringify(record,null,2)+'\n');
  console.log(trials.length+' measured real drops, '+Object.keys(expected).length+' exact source prefixes per drop');
} finally { await browser?.close();server.close();await rm(scratch,{recursive:true,force:true}); }
