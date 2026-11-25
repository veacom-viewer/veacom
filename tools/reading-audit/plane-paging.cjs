const { assert, closeDesktop, fresh, fs, launch, output, path, repo, save, settle } = require('./desktop.cjs');
const study = path.resolve(process.argv[5]), pairs = Number(process.argv[6]), candidate = path.resolve(process.argv[7]);
const planes = ['axial', 'coronal', 'sagittal'];
const report = { reference: process.env.REFERENCE_COMMIT, candidate: process.env.CANDIDATE_COMMIT, controls: {}, rows: [] };
const persist = () => save('plane-paging.json', report);

async function withVolume(checkout, action) {
  const profile = await fresh();
  let current;
  try {
    current = await launch(profile, study, checkout);
    const { page } = current;
    await page.waitForFunction(() => window.__VEACOM_TEST__.state().fullVolumeLoaded, undefined, { timeout: 90000 });
    assert.deepEqual(await page.evaluate(() => window.__VEACOM_TEST__.state().dimensions), [512, 512, 1000]);
    await page.getByTestId('dicom-viewport').first().focus();
    await page.keyboard.press('m');
    await page.waitForFunction(() => new Set([...document.querySelectorAll('canvas[data-renderer]')].map(c => c.dataset.plane)).size === 3);
    await settle(page);
    await page.evaluate(() => {
      window.__planeDigest = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), v => v.toString(16).padStart(2, '0')).join('');
      window.addEventListener('wheel', () => {
        const trial = window.__planeTrial;
        if (trial) { trial.inputs++; if (trial.at === null) trial.at = performance.now(); }
      }, { capture: true, passive: true });
      document.addEventListener('veacom:frame', event => {
        const t = window.__planeTrial, c = event.target;
        if (!t || t.at === null || event.detail.mode !== 'mpr' || c.dataset.plane !== t.plane) return;
        const n = Number(c.dataset.slice);
        if (n === t.from || n === t.slice) return;
        if (t.slice !== null) { t.extra.push(n); return; }
        t.slice = n; t.ms = performance.now() - t.at;
        // Timestamp the normal submission, then copy those pixels before the next render can change them.
        const frame = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        window.__planeDigest(frame).then(sha => { t.sha = sha; });
      });
    });
    return await action(page);
  } finally {
    if (current) await closeDesktop(current.app);
    await fs.rm(profile, { recursive: true, force: true });
  }
}
async function focusPlane(page, plane) {
  const canvas = page.locator(`canvas[data-renderer][data-plane="${plane}"]`);
  const cell = page.getByTestId('viewport-cell').filter({ has: canvas });
  await cell.getByTestId('dicom-viewport').focus();
  await page.waitForFunction(p => document.querySelector('.viewport-cell.is-active canvas[data-renderer]')?.dataset.plane === p, plane);
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * .53, box.y + box.height * .47);
  return canvas;
}
async function seek(page, plane, slice) {
  await page.evaluate(z => window.__VEACOM_TEST__.setView({ slice: z }), slice);
  await page.waitForFunction(([p, z]) => Number(document.querySelector(`canvas[data-renderer][data-plane="${p}"]`)?.dataset.slice) === z, [plane, slice]);
  await settle(page);
}
function checksum(canvas) {
  return canvas.evaluate(c => window.__planeDigest(c.getContext('2d').getImageData(0, 0, c.width, c.height).data));
}
async function notch(page, plane, from, delta) {
  await page.evaluate(([plane, from]) => { window.__planeTrial = { plane, from, at: null, slice: null, sha: null, inputs: 0, extra: [] }; }, [plane, from]);
  await page.mouse.wheel(0, delta);
  await page.waitForFunction(() => window.__planeTrial.sha !== null, undefined, { timeout: 5000 });
  await settle(page);
  const row = await page.evaluate(() => { const t = window.__planeTrial; window.__planeTrial = null; return t; });
  assert.equal(row.inputs, 1); assert.deepEqual(row.extra, []); assert.ok(Number.isFinite(row.ms) && row.ms >= 0);
  return row;
}
async function calibrate(page) {
  for (const plane of planes) {
    const c = await focusPlane(page, plane), initial = Number(await c.getAttribute('data-slice'));
    const anchor = plane === 'axial' ? 500 : 256;
    await seek(page, plane, anchor);
    const plus = await notch(page, plane, anchor, 120), direction = plus.slice - anchor;
    assert.equal(Math.abs(direction), 1);
    const golden = {};
    for (let z = anchor - 6; z <= anchor + 6; z++) { await seek(page, plane, z); golden[z] = await checksum(c); }
    report.controls[plane] = { initial, anchor, direction, golden };
    await c.screenshot({path: path.join(output, 'control-' + plane + '.png')});
    await persist();
    assert.equal(new Set(Object.values(golden)).size, 13, plane + ' must distinguish all 13 source positions');
    assert.equal(plus.sha, golden[plus.slice]);
    await seek(page, plane, anchor);
  }
}
async function main() {
  assert.ok(Number.isInteger(pairs) && pairs > 0);
  await withVolume(repo, calibrate);
  for (let pair = 1; pair <= pairs; pair++) for (const build of pair % 2 ? ['reference', 'candidate'] : ['candidate', 'reference']) {
    await withVolume(build === 'reference' ? repo : candidate, async page => {
      const record = { pair, build, renderer: await page.locator('canvas[data-renderer]').first().getAttribute('data-renderer'), planes: {} };
      report.rows.push(record);
      for (let i = 0; i < planes.length; i++) {
        const plane = planes[(i + pair - 1) % planes.length], { anchor, direction, golden } = report.controls[plane];
        const canvas = await focusPlane(page, plane); await seek(page, plane, anchor);
        assert.equal(await checksum(canvas), golden[anchor]);
        let z = anchor; const results = record.planes[plane] = [];
        for (let n = 0; n < 12; n++) {
          const delta = n < 6 ? 120 : -120, next = z + direction * Math.sign(delta);
          const r = await notch(page, plane, z, delta);
          assert.equal(r.slice, next, `${plane} selected the wrong slice`);
          assert.equal(r.sha, golden[next], `${plane} ${next} submitted different pixels`);
          results.push({ from: z, to: next, ms: r.ms, sha: r.sha }); z = next;
        }
        assert.equal(z, anchor); await persist();
      }
    });
    console.log('Verified all 36 reconstructed wheel steps for', build, 'pair', pair);
  }
}
main().catch(async e => { report.error = String(e.stack || e); await persist(); console.error(e); process.exitCode = 1; });
