// Exercise the real Node child pipes, including Windows named pipes. The expected hash comes from the synthetic
// DICOM pixels before they were written to disk. The 500 MiB response is hashed incrementally.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { EngineProcess } = require('../electron/engine-process.cjs');
const { EngineChannel } = require('../electron/engine-pipe.cjs');

const binary = path.resolve(__dirname, '../native/target/release', process.platform === 'win32' ? 'veacom-core.exe' : 'veacom-core');
const makeStudy = path.join(__dirname, 'fixtures/make-smoke-study.mjs');

async function checkArchiveCleanup(connection, directory) {
  const study = path.join(directory, 'archive-source'), output = path.join(directory, 'zip-output');
  const scratch = path.join(directory, 'extractions');
  execFileSync(process.execPath, [makeStudy, study]);
  const imported = await (await connection.request('import', { paths: [study] })).json();
  const response = await connection.request('export', { seriesId: imported.series[0].id,
    directory: output, zip: true, operation: 'zip-cleanup-check' });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  const [archive] = result.archives;
  await fs.mkdir(scratch);
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, VEACOM_CORE_PATH: binary };
  execFileSync(process.execPath, [path.join(__dirname, 'check-engine-import.cjs'), archive], { env, timeout: 60000 });
  assert.ok(!(await fs.readdir(scratch)).some(name => name.startsWith('veacom-import-')),
    'the standalone checker must wait for its archive extraction to be removed');
  return { archive, scratch, env };
}

// Replace the last indexed regular file with a FIFO. The reader must reject it without
// waiting for a writer and roll back the preceding files, leaving the chosen folder intact.
async function checkSpecialFileRollback(connection, directory, study) {
  const source = path.join(directory, 'fifo-source'), output = path.join(directory, 'fifo-export');
  await fs.mkdir(source); await fs.mkdir(output);
  const files = (await fs.readdir(path.join(study, 'S01'))).sort().slice(0, 100);
  for (const name of files) await fs.link(path.join(study, 'S01', name), path.join(source, name));
  const imported = await (await connection.request('import', { paths: [source] })).json();
  const last = path.join(source, files.at(-1));
  await fs.unlink(last);
  execFileSync('mkfifo', [last]);
  const response = await connection.request('export', { seriesId: imported.series[0].id, directory: output,
    operation: 'fifo-export', root: true, dicomdir: true }, { signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  assert.equal(response.status, 422, result.error);
  assert.match(result.error, /regular source file/);
  assert.deepEqual(await fs.readdir(output), []);
}

// Start shutdown while a real large export is writing. The manager must wait for the
// native worker to remove the incomplete export. engine-process.test.ts also exercises
// delayed completion past the manager's shutdown timeout.
async function checkShutdownRollback(manager, connection, directory, study) {
  const output = path.join(directory, 'shutdown-export');
  await fs.mkdir(output);
  const imported = await (await connection.request('import', { paths: [study] })).json();
  const exporting = connection.request('export', { seriesId: imported.series[0].id, directory: output,
    operation: 'shutdown-export', root: true, dicomdir: true }).then(async response => ({ status: response.status, body: await response.json() }));
  void exporting.catch(() => {});
  const first = path.join(output, 'DICOM', 'IM000001');
  for (const end = Date.now() + 20000; !(await fs.stat(first).catch(() => false));) {
    if (Date.now() >= end) throw new Error('Export did not write its first instance');
    await delay(2);
  }
  const stopping = manager.stop();
  const result = await exporting;
  await stopping;
  assert.equal(result.status, 422, JSON.stringify(result.body));
  assert.deepEqual(await fs.readdir(output), []);
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-pipe-'));
  const study = path.join(directory, 'study');
  const children = [];
  const timeout = setTimeout(() => {
    process.exitCode = 1;
    console.error('Engine transport check timed out.');
    for (const child of children) child.kill('SIGKILL');
  }, 180000);
  const manager = new EngineProcess({ binary, spawnImpl: (command, args, options) => {
    const child = spawn(command, args, { ...options, env: { ...process.env, VEACOM_CACHE_MIB: '768' } });
    children.push(child); return child;
  } });
  try {
    execFileSync(process.execPath, [makeStudy, study, '--pipe-volume'], { stdio: 'inherit' });
    const { pixelSha256 } = JSON.parse(await fs.readFile(path.join(study, 'manifest.json'), 'utf8'));
    const connection = await manager.start();
    const imported = await (await connection.request('import', { paths: [study] })).json();
    const { id } = imported.series[0];
    const volume = await connection.request('volume', { id });
    const hash = createHash('sha256');
    let length = 0;
    const start = performance.now();
    for await (const bytes of volume.body) { hash.update(bytes); length += bytes.length; }
    assert.equal(length, 500 * 1024 * 1024);
    assert.equal(hash.digest('hex'), pixelSha256);
    console.log(`Verified ${length} pixel bytes in ${Math.round(performance.now() - start)} ms including SHA-256.`);
    const controls = Array.from({ length: 12 }, () => new AbortController());
    const unread = controls.map(controller => connection.request('volume', { id }, { signal: controller.signal }));
    const settled = Promise.allSettled(unread);
    const open = await Promise.all(unread.slice(0, 4));
    assert.ok(open.every(r => r.ok));
    assert.equal((await connection.request('progress')).status, 200);
    const frame = await connection.request('frame', { id, index: 0 });
    assert.equal((await frame.arrayBuffer()).byteLength, 512 * 512 * 2);
    for (const controller of controls) controller.abort();
    await settled;
    const reading = (await connection.request('volume', { id })).body.getReader();
    assert.equal((await reading.read()).done, false);
    await reading.cancel();
    const interrupted = await connection.request('volume', { id });
    children[0].kill('SIGKILL');
    await assert.rejects(interrupted.arrayBuffer());
    for (const end = Date.now() + 30000; manager.state().generation === 1 || manager.state().status !== 'ready';) {
      if (Date.now() >= end) throw new Error('Engine did not recover');
      await delay(20);
    }
    assert.throws(() => manager.connection(connection.generation));
    const fresh = manager.connection();
    assert.deepEqual((await (await fresh.request('series')).json()).series, []);
    assert.equal((await (await fresh.request('import', { paths: [study] })).json()).series.length, 1);
    const { archive, scratch, env } = await checkArchiveCleanup(fresh, directory);
    if (process.platform !== 'win32') await checkSpecialFileRollback(fresh, directory, study);
    await checkShutdownRollback(manager, fresh, directory, study);
    await manager.stop();

    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'], env });
    const exit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const channel = new EngineChannel(child.stdout, child.stdin);
      await channel.hello;
      const imported = await (await channel.request('import', { paths: [archive] })).json();
      assert.equal(imported.series.length, 1);
      assert.ok((await fs.readdir(scratch)).some(name => name.startsWith('veacom-import-')));
      child.stdin.end();
      assert.equal(await exit, 0, 'closing stdin must stop the engine');
      assert.ok(!(await fs.readdir(scratch)).some(name => name.startsWith('veacom-import-')));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      clearTimeout(watchdog);
    }
    console.log('Verified concurrent reads, cancellation, crash recovery, reimport, and archive cleanup after checker shutdown and stdin EOF.');
  } finally {
    try { await manager.stop(); } finally { clearTimeout(timeout); }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
