import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { assertFields } from './support';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ResourceMonitor, ResourceWindow, electronRows } = require('../electron/resource-monitor.cjs');
const { sanitizeEvent } = require('../electron/usage.cjs');
const M = 1024 * 1024, trace = 'a'.repeat(32), wall = 1.8e12;
const row = (cpu: number, rss: number, hwm: number, key = 'engine:1') => ({ key, role: 'engine', cpu, rss: rss*M, hwm: hwm*M });

describe('app resource samples', () => {
  it('distinguishes steady RAM from a short allocation, and normalizes CPU per core', () => {
    const win = new ResourceWindow();
    win.sample([row(11,600,600)], 0);
    win.sample([row(12.5,600,900)], 1000, { trace, action: 'tool-mpr' });
    win.sample([row(14,600,900)], 2000);
    win.sample([row(15.5,600,900)], 3000);
    const [e] = win.drain(4000, wall, trace);
    assertFields(sanitizeEvent(e).attributes, { 'veacom.perf.signal':'cpu-ram', 'veacom.perf.cpu_pct':150, 'veacom.perf.cpu_hot_ms':2000,
      'veacom.perf.ram_mib':600, 'veacom.perf.ram_rise_mib':300,'veacom.perf.process_hwm_mib':900, 'veacom.action':'tool-mpr' });
    win.sample([row(15.5,600,900)], 4000);
    assert.equal(win.drain(5000,wall,trace)[0].attributes['veacom.perf.signal'], 'baseline');
  });
  it('does not mislabel a new engine, missing counters or sleep as a CPU spike', () => {
    const win = new ResourceWindow();
    win.sample([row(1,400,500)],0);
    win.sample([row(200,400,500)],20_000);
    win.sample([row(100,400,1000,'engine:2')],21_000);
    const [e] = win.drain(22_000,wall,trace);
    assert.ok(!Object.hasOwn(e.attributes, 'veacom.perf.cpu_pct'));
    assert.equal(e.attributes['veacom.perf.signal'], 'baseline');
    assert.deepEqual(win.drain(22_001,wall,trace), []);
  });
  it('keeps role and units, and discards process IDs and names before export', () => {
    const win = new ResourceWindow();
    win.sample(electronRows([{ type:'Tab', pid:82, creationTime:12, name:'do-not-export', cpu:{}, memory:{workingSetSize:512*1024} }]),1000);
    const [e] = win.drain(2000,wall,trace);
    assertFields(e.attributes, { 'veacom.perf.role':'renderer','veacom.perf.ram_mib':512 });
    assert.ok(!JSON.stringify(e).includes('do-not-export')); assert.ok(!JSON.stringify(e).includes('e:82'));
  });
  it('drops an in-flight sample on revoke and does not start a second timer', async () => {
    // Pending promise work runs before and after each jump of the fake clock; setImmediate stays real for that.
    const settle = () => new Promise(resolve => setImmediate(resolve));
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let finish!: (r: unknown[]) => void; const read = mock.fn(() => new Promise(resolve => {finish=resolve;}));
      const emit = mock.fn(), monitor = new ResourceMonitor({read});
      monitor.start(emit); monitor.start(emit); await settle(); mock.timers.tick(1000); await settle();
      assert.equal(read.mock.callCount(), 1);
      monitor.stop(false); finish([row(0,300,300)]); await settle(); mock.timers.tick(10000); await settle();
      assert.equal(emit.mock.callCount(), 0); assert.equal(read.mock.callCount(), 1);
    } finally { mock.timers.reset(); }
  });
});
