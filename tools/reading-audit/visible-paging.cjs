const { assert, fs, output, path, PNG, repo, save, settle, sleep } = require('./desktop.cjs');
const { focusPlane, seek, withVolume } = require('./plane-paging.cjs');
const { jpeg, mark, trace } = require('./trace.cjs');

const pairs = Number(process.argv[6]), candidate = path.resolve(process.argv[7]);
const planes = ['axial', 'coronal', 'sagittal'];
const anchors = { axial: 500, coronal: 256, sagittal: 256 };
const directions = { axial: -1, coronal: 1, sagittal: -1 };
const forward = 18, back = 6;
const report = { reference: process.env.REFERENCE_COMMIT, candidate: process.env.CANDIDATE_COMMIT, forward, back, controls: {}, rows: [] };
const persist = () => save('visible-paging.json', report);

// Change a corner outside the image after the natural redraw, so a static final frame is captured too.
async function tick(page) {
  await page.evaluate(() => {
    let corner = document.querySelector('#plane-audit-corner');
    if (!corner) {
      corner = document.createElement('i'); corner.id = 'plane-audit-corner';
      corner.style.cssText = 'position:fixed;bottom:2px;right:2px;width:12px;height:12px;z-index:99999;pointer-events:none';
      document.body.append(corner);
    }
    corner.style.backgroundColor = corner.style.backgroundColor === 'black' ? 'white' : 'black';
  });
  await sleep(60);
}

async function sampleBox(canvas) {
  return canvas.evaluate(c => {
    const r = c.getBoundingClientRect();
    return [(r.x + .42*r.width)/innerWidth, (r.y + .34*r.height)/innerHeight,
      (r.x + .58*r.width)/innerWidth, (r.y + .45*r.height)/innerHeight];
  });
}

function meanGray(picture, box) {
  const data = picture.pixels ?? picture.data, { width, height } = picture;
  const [x0, y0, x1, y1] = box.map((v, i) => Math.floor(v * (i % 2 ? height : width)));
  assert.ok(x1-x0 >= 8 && y1-y0 >= 8);
  let sum = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += data[4*(y*width+x)+1];
  return sum/((x1-x0)*(y1-y0));
}

async function calibrate(page, plane) {
  const c = await focusPlane(page, plane), box = await sampleBox(c), anchor = anchors[plane], direction = directions[plane];
  const stop = await trace(page), full = [];
  for (let i = 0; i <= forward; i++) {
    await mark(page, 'change-' + i);
    await seek(page, plane, anchor + i*direction);
    await mark(page, 'settled-' + i);
    await tick(page); await tick(page);
    const raw = await page.screenshot({scale:'css'});
    full.push(meanGray(PNG.sync.read(raw), box));
    if (i === 0 || i === forward) await fs.writeFile(path.join(output, plane+'-control-'+i+'.png'), raw);
  }
  const { marks, frames } = await stop(), values = [];
  for (let i = 0; i <= forward; i++) {
    const from = marks['bench:settled-'+i], to = marks['bench:change-'+(i+1)] ?? Infinity;
    const last = frames.filter(f => f.ts >= from && f.ts < to).at(-1);
    assert.ok(last, 'Missing composited calibration for '+plane+' '+i);
    values.push(meanGray(jpeg(last.jpeg), box));
  }
  const ordered = [...values].sort((a,b) => a-b);
  const separation = Math.min(...ordered.slice(1).map((v,i) => v-ordered[i]));
  const fullDeltaError = Math.max(...values.map((v,i) => Math.abs(v-values[0]-(full[i]-full[0]))));
  report.controls[plane] = { anchor, direction, box, values, full, separation, fullDeltaError };
  await persist();
  assert.ok(separation > 1.2 && fullDeltaError < separation/2, 'Ambiguous control for '+plane+' '+JSON.stringify({separation,fullDeltaError}));
}

async function measure(page, plane, pair, build) {
  const control = report.controls[plane], { anchor, direction, values, separation } = control;
  const canvas = await focusPlane(page, plane), box = await sampleBox(canvas);
  assert.deepEqual(box, control.box);
  await seek(page, plane, anchor);
  await page.evaluate(() => {
    window.__visibleInputs?.abort();
    window.__visibleInputs = new AbortController();
    let n = 0;
    window.addEventListener('wheel', () => performance.mark('bench:visible-wheel-' + n++),
      {capture:true, passive:true, signal:window.__visibleInputs.signal});
  });
  const stop = await trace(page);
  await tick(page); await tick(page); await tick(page);
  const positions = [0];
  for (let i = 0; i < forward+back; i++) {
    const sign = i < forward ? 1 : -1, next = positions.at(-1)+sign;
    await page.mouse.wheel(0, sign*120);
    await page.waitForFunction(([p,z]) => Number(document.querySelector('canvas[data-plane="'+p+'"]')?.dataset.slice) === z,
      [plane, anchor+next*direction], {timeout:5000});
    await settle(page); await sleep(100); await tick(page);
    positions.push(next);
  }
  const { marks, frames } = await stop();
  const times = positions.slice(1).map((_,i) => marks['bench:visible-wheel-'+i]);
  assert.ok(times.every(Number.isFinite) && marks['bench:visible-wheel-'+times.length] === undefined);
  const observed = frames.map(f => {
    const gray = meanGray(jpeg(f.jpeg), box), errors = values.map(v => Math.abs(v-gray));
    const bestError = Math.min(...errors);
    return { at:f.ts-times[0], gray, slot:bestError < separation/2 ? errors.indexOf(bestError) : null };
  });
  const baseline = observed.filter(f => f.at<0).at(-1);
  assert.equal(baseline?.slot, 0, 'Wrong initial composited '+plane+' image '+JSON.stringify(baseline));
  const steps = times.map((at,i) => {
    const t = at-times[0], end = (times[i+1] ?? Infinity)-times[0];
    const group = observed.filter(f => f.at >= t && f.at < end);
    const from = positions[i], to = positions[i+1], first = group.findIndex(f => f.slot===to);
    const extra = group.filter(f => f.slot!==from && f.slot!==to);
    const late = first < 0 ? [] : group.slice(first+1).filter(f => f.slot!==to);
    return {from:anchor+direction*from, to:anchor+direction*to, at:t, visibleMs:first < 0 ? null : group[first].at-t,
      captures:group.length, unexpected:extra.length, late:late.length, settled:group.at(-1)?.slot===to};
  });
  if (pair === 1) {
    for (const [index, suffix] of [[0,'initial'],[frames.length-1,'final']])
      await fs.writeFile(path.join(output,build+'-'+plane+'-'+suffix+'.jpg'),Buffer.from(frames[index].jpeg,'base64'));
  }
  if (pairs === 1 && plane === 'sagittal') {
    const directory = path.join(output,build);
    await fs.mkdir(directory,{recursive:true});
    const captured = [];
    for (const [index,f] of frames.entries()) {
      const file = String(index).padStart(4,'0')+'.jpg';
      await fs.writeFile(path.join(directory,file),Buffer.from(f.jpeg,'base64'));
      captured.push({file,ms:f.ts-times[0]});
    }
    await fs.writeFile(path.join(directory,'captured.json'),JSON.stringify(captured));
  }
  return { plane, pair, build, steps, frames:observed, box };
}

async function main() {
  assert.ok(Number.isInteger(pairs) && pairs > 0);
  await withVolume(repo, async page => { for (const plane of planes) await calibrate(page, plane); });
  for (let pair = 1; pair <= pairs; pair++) for (const build of pair%2 ? ['reference','candidate'] : ['candidate','reference']) {
    await withVolume(build === 'reference' ? repo : candidate, async page => {
      for (let p = 0; p < planes.length; p++) {
        const plane = planes[(p+pair-1)%planes.length];
        report.rows.push(await measure(page, plane, pair, build)); await persist();
      }
    });
    console.log('Captured wheel input and composited images for '+build+' pair '+pair);
  }
}
main().catch(async e => { report.error = String(e.stack ?? e); await persist(); console.error(e); process.exitCode = 1; });
