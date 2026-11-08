import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { EngineProcess } = require('../electron/engine-process.cjs');
const directories: string[] = [];
const managers: InstanceType<typeof EngineProcess>[] = [];
const children: ChildProcess[] = [];
type Plan = { hang?: boolean; ignoreTerm?: boolean; exitBeforeReady?: boolean; protocol?: unknown; crashImport?: boolean; ignoreShutdown?: boolean; deafToShutdown?: boolean };
async function fixture(plan: Plan[], options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'veacom-engine-test-'));
  directories.push(directory);
  await writeFile(path.join(directory, 'plan.json'), JSON.stringify(plan));
  const spawned: ChildProcess[] = [];
  const manager = new EngineProcess({ binary: process.execPath, args: [path.resolve('tests/fixtures/engine.cjs'), directory],
    startupTimeoutMs: 1500, restartDelaysMs: [10, 10], shutdownTimeoutMs: 60, exitTimeoutMs: 100, killTimeoutMs: 100,
    stderr: () => {}, spawnImpl: (...args: Parameters<typeof spawn>) => { const child = spawn(...args); spawned.push(child); children.push(child); return child; }, ...options });
  managers.push(manager);
  const states: Array<{ status: string; generation: number }> = [];
  manager.on('state', (state: typeof states[number]) => states.push(state));
  return { manager, states, spawned, directory,
    records: async () => (await readFile(path.join(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
async function until(check: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error('Timed out waiting for engine state.'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(manager => manager.stop()));
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('imaging engine process lifecycle', () => {
  it('restarts after a crashing import with a new connection and never replays the request', async () => {
    const f = await fixture([{ crashImport: true }, {}]);
    const incidents: unknown[] = [];
    f.manager.on('incident', (value: unknown) => incidents.push(value));
    const first = await f.manager.start();
    await assert.rejects(first.request('import', { paths: ['bad-file.dcm'] }), { message: /unavailable|stopped/ });
    await until(() => f.manager.state().status === 'ready' && f.manager.state().generation === 2);
    const second = f.manager.connection();
    assert.deepEqual(incidents, [{ reason: 'unexpected-exit', code: 17, signal: null }]);
    assert.notEqual(second.request, first.request);
    assert.equal(second.generation, 2);
    assert.throws(() => f.manager.connection(first.generation), { message: /Reopen this study/ });
    assert.equal(f.states.some(state => state.status === 'restarting'), true);
    assert.equal((await f.records()).filter(record => record.op === 'import').length, 1);
    // The old connection's pipes went with its engine: nothing reaches the new engine through them.
    await assert.rejects(first.request('series'), { message: /unavailable|stopped/ });
    assert.equal((await second.request('series')).ok, true);
    assert.equal((await second.request('import', { paths: [] })).ok, true);
    assert.deepEqual((await f.records()).filter(record => record.op === 'import').map(record => record.index), [0, 1]);
  });
  it('retires and replaces a live child whose stdout protocol failed', async () => {
    const f = await fixture([{}, {}]);
    const incidents: unknown[] = [];
    f.manager.on('incident', (value: unknown) => incidents.push(value));
    const first = await f.manager.start();
    await assert.rejects(first.request('corrupt'), /too long/);
    await until(() => f.manager.state().status === 'ready' && f.manager.state().generation === 2);
    assert.deepEqual(incidents, [{ reason: 'protocol-error', code: null, signal: null }]);
    assert.equal(f.manager.state().restartCount, 1);
    assert.equal((await f.manager.connection().request('health')).ok, true);
    assert.ok(f.spawned[0].exitCode !== null || f.spawned[0].signalCode !== null);
  });
  it('lets an acknowledged shutdown drain a slow export before starting the kill timer', async () => {
    const f = await fixture([{}], { exitTimeoutMs: 20 });
    const connection = await f.manager.start();
    const exporting = connection.request('export');
    await f.manager.stop();
    assert.equal((await exporting).status, 200);
    assert.equal(f.spawned[0].exitCode, 0);
  });
  it('has a fixed restart budget even when every replacement initially becomes ready', async () => {
    const f = await fixture([{}, {}, {}]);
    await f.manager.start();
    for (let generation = 1; generation <= 3; generation++) {
      const connection = f.manager.connection();
      await connection.request('crash').catch(() => {});
      await until(() => generation === 3 ? f.manager.state().status === 'failed' : f.manager.state().status === 'ready' && f.manager.state().generation === generation + 1);
    }
    assert.equal(f.spawned.length, 3);
    assert.equal(f.manager.state().restartCount, 2);
    assert.throws(() => f.manager.connection(), { message: /limit reached/ });
    await assert.rejects(f.manager.start(), { message: /limit reached/ });
    assert.equal(f.spawned.length, 3);
  });
  it('also bounds replacements that exit before readiness', async () => {
    const f = await fixture([{}, { exitBeforeReady: true }, { exitBeforeReady: true }]);
    const connection = await f.manager.start();
    await connection.request('crash').catch(() => {});
    await until(() => f.manager.state().status === 'failed');
    assert.equal(f.spawned.length, 3);
    assert.throws(() => f.manager.connection());
  });
  it('kills a timed-out initial engine, including one that ignores SIGTERM', async () => {
    const f = await fixture([{ hang: true, ignoreTerm: true }], { startupTimeoutMs: 350 });
    await assert.rejects(f.manager.start(), { message: /did not start/ });
    assert.equal(f.manager.state().status, 'failed');
    assert.equal(f.spawned[0].exitCode !== null || f.spawned[0].signalCode !== null, true);
    assert.equal(f.spawned.length, 1);
  });
  for (const protocol of [1, 0, '2', null]) it(`rejects and cleans up an engine that speaks protocol ${protocol}`, async () => {
    const f = await fixture([{ protocol }]);
    await assert.rejects(f.manager.start(), { message: /does not match this version/ });
    assert.equal(f.spawned[0].exitCode !== null || f.spawned[0].signalCode !== null, true);
  });
  it('reports spawn failure without a restart loop', async () => {
    const f = await fixture([], { binary: path.join(tmpdir(), 'no-such-veacom-engine') });
    await assert.rejects(f.manager.start(), { message: /ENOENT/ });
    assert.equal(f.manager.state().status, 'failed');
    assert.equal(f.spawned.length, 1);
  });
  it('ignores a retired process exit after its replacement is ready', async () => {
    const f = await fixture([{}, {}]);
    const first = await f.manager.start();
    await first.request('crash').catch(() => {});
    await until(() => f.manager.state().status === 'ready' && f.manager.state().generation === 2);
    const state = f.manager.state();
    const connection = f.manager.connection();
    f.spawned[0].emit('exit', 1, null);
    f.spawned[0].emit('error', new Error('late old-child error'));
    assert.deepEqual(f.manager.state(), state);
    assert.deepEqual(f.manager.connection(), connection);
    assert.equal(f.spawned.length, 2);
  });
  it('shuts down gracefully, invalidates the connection, and never restarts on exit', async () => {
    const f = await fixture([{}]);
    await f.manager.start();
    await Promise.all([f.manager.stop(), f.manager.stop()]);
    assert.equal(f.manager.state().status, 'stopped');
    assert.equal(f.spawned[0].exitCode, 0);
    assert.equal((await f.records()).filter(record => record.op === 'shutdown').length, 1);
    assert.throws(() => f.manager.connection(), { message: /unavailable/ });
    assert.equal(f.spawned.length, 1);
    await assert.rejects(f.manager.start(), { message: /stopping/ });
  });
  it('force-stops an engine that ignores shutdown, without starting another', async () => {
    const f = await fixture([{ ignoreShutdown: true, ignoreTerm: true }]);
    await f.manager.start(); await f.manager.stop();
    assert.equal(f.spawned[0].exitCode !== null || f.spawned[0].signalCode !== null, true);
    assert.equal(f.spawned.length, 1);
  });
  it('cancels a queued recovery when the app closes', async () => {
    const f = await fixture([{}, {}], { restartDelaysMs: [200, 200] });
    const first = await f.manager.start();
    await first.request('crash').catch(() => {});
    await until(() => f.manager.state().status === 'restarting');
    await f.manager.stop();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(f.manager.state().status, 'stopped');
    assert.equal(f.spawned.length, 1);
  });
  it('allows a state subscriber to stop synchronously before spawning', async () => {
    const f = await fixture([{}]);
    f.manager.on('state', (state: { status: string }) => { if (state.status === 'starting') void f.manager.stop(); });
    await assert.rejects(f.manager.start(), { message: /stopping/ });
    await f.manager.stop();
    assert.equal(f.spawned.length, 0);
    assert.equal(f.manager.state().status, 'stopped');
  });
  it('allows a state subscriber to stop when the first readiness event arrives', async () => {
    const f = await fixture([{}]);
    f.manager.on('state', (state: { status: string }) => { if (state.status === 'ready') void f.manager.stop(); });
    await assert.rejects(f.manager.start(), { message: /stopping/ });
    await f.manager.stop();
    assert.equal(f.spawned.length, 1);
    assert.equal(f.spawned[0].exitCode, 0);
    assert.equal(f.manager.state().status, 'stopped');
  });
  it('closes the engine\'s stdin on shutdown, so an engine that missed the request still stops', async () => {
    const f = await fixture([{ deafToShutdown: true }]);
    const connection = await f.manager.start();
    await f.manager.stop();
    assert.equal((await f.records()).filter(record => record.op === 'shutdown').length, 1);
    assert.deepEqual([f.spawned[0].exitCode, f.spawned[0].signalCode], [0, null]);
    await assert.rejects(connection.request('series'));
  });
  it('cleans an engine when the app closes during startup', async () => {
    const f = await fixture([{ hang: true }]);
    const starting = f.manager.start();
    const rejected = assert.rejects(starting, { message: /stopping/ });
    await until(() => f.spawned[0]?.pid !== undefined);
    await f.manager.stop(); await rejected;
    assert.equal(f.manager.state().status, 'stopped');
    assert.equal(f.spawned[0].exitCode !== null || f.spawned[0].signalCode !== null, true);
  });
});
