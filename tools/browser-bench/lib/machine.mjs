// The machine's state around each trial, so a slow result can be traced to a busy, hot or battery-powered computer
// instead of to a viewer, and a run refuses to start on a machine that is not idle.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const run = (command, args) => { try { return execFileSync(command, args, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return null; } };

/** What does not change during a run: hardware, system, runtime. */
export function describe() {
  const cpus = os.cpus();
  const model = process.platform === 'darwin' ? run('sysctl', ['-n', 'hw.model']) : process.platform === 'linux' ? run('cat', ['/sys/devices/virtual/dmi/id/product_name']) : null;
  return {
    platform: process.platform, arch: process.arch, release: os.release(), osVersion: os.version?.() ?? null,
    model, cpu: cpus[0]?.model ?? null, cores: cpus.length, memoryGB: Math.round(os.totalmem() / 2 ** 30),
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
  };
}

/** What can change between trials: power source, thermal pressure, load. */
export function state() {
  const out = { at: new Date().toISOString(), loadAverage: os.loadavg().map(v => Math.round(v * 100) / 100), freeMemoryGB: Math.round(os.freemem() / 2 ** 28) / 4 };
  if (process.platform === 'darwin') {
    const battery = run('pmset', ['-g', 'batt']);
    out.power = battery?.includes('AC Power') ? 'ac' : battery?.includes('Battery Power') ? 'battery' : null;
    out.lowPowerMode = /lowpowermode\s+1/.test(run('pmset', ['-g']) ?? '');
    const thermal = run('pmset', ['-g', 'therm']) ?? '';
    out.thermalWarning = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(thermal)?.[1] ?? (/No thermal warning/.test(thermal) ? 'none' : null);
  }
  return out;
}

/** Share of all cores busy over `ms`, from the system's own CPU counters. */
export async function busyShare(ms = 1000) {
  const sum = () => os.cpus().reduce((total, cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    return { busy: total.busy + user + nice + sys + irq, all: total.all + user + nice + sys + idle + irq };
  }, { busy: 0, all: 0 });
  const a = sum();
  await new Promise(resolve => setTimeout(resolve, ms));
  const b = sum();
  return (b.busy - a.busy) / Math.max(1, b.all - a.all);
}

/** Waits until the machine is idle (under `share` of all cores busy for a second), up to `maxMs`; returns the share. */
export async function waitIdle({ share = 0.1, maxMs = 20_000 } = {}) {
  const started = Date.now();
  let busy = await busyShare();
  while (busy > share && Date.now() - started < maxMs) busy = await busyShare();
  return { busy: Math.round(busy * 1000) / 1000, waitedMs: Date.now() - started, idle: busy <= share };
}
