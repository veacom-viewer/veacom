const assert=require('node:assert/strict');
const {execFileSync,spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const [known,directory]=process.argv.slice(2).map(s=>path.resolve(s));
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
const heads={old:'95810d2c902ecc3521ee886b2c2c9826695abcf1',fixed:'7f8142a1e6c1cc92ec44138f14559e1856e2ee44'};
fs.mkdirSync(directory,{recursive:true});
const rows=[],checkFile=path.join(__dirname,'video-presentation-replay.cjs');
for(const [version,variant,rounds] of [['old','known',4],['fixed','known',4],['fixed','fresh',2],['fixed','black-first',1]]){
  let source=execFileSync('git',['show',heads[version]+':tools/check-video-encoder.cjs'],{encoding:'utf8'});
  if(variant==='known'){
    const needle="require('node:url').pathToFileURL(destination).href";assert(source.includes(needle));
    source=source.replace(needle,"require('node:url').pathToFileURL(process.env.VEACOM_VIDEO_CONTROL).href");
  }
  if(variant==='black-first'){
    const mark='    context.putImageData(noise, 0, 340);';assert(source.includes(mark));
    source=source.replace(mark,mark+"\n    if(slice===0){ context.fillStyle='black'; context.fillRect(0,0,width,height); }");
  }
  fs.writeFileSync(checkFile,source);
  for(const noGpu of [false,true]) for(let i=0;i<rounds;i++){
    const name=[version,variant,noGpu?'software':'default',i+1].join('-'),out=path.join(directory,name);
    const params=[checkFile,out,...(noGpu?['--no-gpu']:[])];
    const command=process.platform==='linux'?'xvfb-run':process.execPath;
    const args=process.platform==='linux'?['-a',process.execPath,...params]:params;
    const run=spawnSync(command,args,{encoding:'utf8',timeout:205000,env:{...process.env,VEACOM_VIDEO_CONTROL:known}});
    fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'run.log'),(run.stdout??'')+(run.stderr??''));
    const file=path.join(out,noGpu?'video-no-gpu.json':'video.json');
    assert(fs.existsSync(file),name+' did not produce a check result. '+String(run.stderr).slice(-400));
    const result=JSON.parse(fs.readFileSync(file));
    const movie=path.join(out,noGpu?'video-no-gpu.mp4':'video.mp4');
    rows.push({version,variant,noGpu,trial:i+1,status:run.status,result,exportHash:sha(fs.readFileSync(movie))});
    fs.writeFileSync(path.join(directory,'replay.json'),JSON.stringify({platform:process.platform,knownSha256:sha(fs.readFileSync(known)),rows},null,2));
    if(i>0||variant==='known') fs.unlinkSync(movie);
    if(version==='fixed' && variant!=='black-first')assert.equal(run.status,0,name+' '+result.failures);
    if(version==='fixed'){
      for(const f of result.sampledFrames)assert.equal(Math.round(f.mediaTime*5),f.slice);
      if(variant==='black-first')assert(run.status!==0 && result.failures.some(x=>x.includes('slice 0 marker')) && result.failures.every(x=>x.startsWith('slice 0 ')),name);
    }
    console.log(name,run.status,result.failures.length);
  }
}
