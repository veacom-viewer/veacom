// One sample at a time, only while sharing. Keep one small window per process role.
const { randomBytes } = require('node:crypto');
const WINDOW = 60_000, MIB = 1024 * 1024;
const roleOf = type => ({ Browser: 'main', Tab: 'renderer', GPU: 'gpu' })[type] || 'utility';
const usable = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function electronRows(metrics) {
  return metrics.map(p => ({
    key: `e:${p.pid}:${p.creationTime}`, role: roleOf(p.type), cpu: p.cpu?.cumulativeCPUUsage,
    rss: usable(p.memory?.workingSetSize) ? p.memory.workingSetSize * 1024 : null,
    hwm: usable(p.memory?.peakWorkingSetSize) && p.memory.peakWorkingSetSize > 0 ? p.memory.peakWorkingSetSize * 1024 : null,
  }));
}

class ResourceWindow {
  constructor() { this.prev = new Map(); this.roles = new Map(); this.hot = new Map(); this.start = null; }
  sample(rows, now, context) {
    this.start ??= now;
    const next = new Map(), groups = new Map();
    for (const row of rows) {
      const prior = this.prev.get(row.key), elapsed = prior ? now - prior.at : 0;
      next.set(row.key, { ...row, at: now });
      const g = groups.get(row.role) || { rss: 0, seenRam: false, cpu: 0, seenCpu: false, hwm: 0, rise: 0 };
      if (usable(row.rss)) { g.rss += row.rss; g.seenRam = true; }
      if (usable(row.hwm)) {
        g.hwm = Math.max(g.hwm, row.hwm);
        // A higher process high-water mark catches some allocations freed between polls.
        if (prior && usable(prior.hwm)) g.rise = Math.max(g.rise, row.hwm - prior.hwm);
      }
      if (elapsed > 0 && elapsed <= 7500 && usable(row.cpu) && usable(prior.cpu) && row.cpu >= prior.cpu) {
        g.cpu += (row.cpu - prior.cpu) * 100_000 / elapsed; g.seenCpu = true;
      }
      groups.set(row.role, g);
    }
    this.prev = next;
    for (const role of this.hot.keys()) if (!groups.has(role)) this.hot.delete(role);
    for (const [role, g] of groups) {
      const a = this.roles.get(role) || { samples: 0, low: Infinity, ram: null, cpu: null, hwm: 0, rise: 0, hotMs: 0, peakAt: now, rank: -1 };
      a.samples++;
      if (g.seenRam) { a.low = Math.min(a.low, g.rss); a.ram = Math.max(a.ram ?? 0, g.rss); }
      const growth = Math.max(g.rise, g.seenRam ? g.rss - a.low : 0);
      a.rise = Math.max(a.rise, growth); a.hwm = Math.max(a.hwm, g.hwm);
      if (g.seenCpu) a.cpu = Math.max(a.cpu ?? 0, g.cpu);
      const hot = this.hot.get(role);
      const continuous = g.seenCpu && g.cpu >= 90 && hot && now - hot.at <= 7500;
      const duration = g.seenCpu && g.cpu >= 90 ? (continuous ? hot.ms + now - hot.at : 0) : 0;
      if (g.seenCpu && g.cpu >= 90) this.hot.set(role, { at: now, ms: duration }); else this.hot.delete(role);
      a.hotMs = Math.max(a.hotMs, duration);
      const rank = Math.max(g.seenCpu ? g.cpu / 90 : 0, growth / (256 * MIB));
      if (rank > a.rank) { a.rank = rank; a.peakAt = now; a.context = context; }
      this.roles.set(role, a);
    }
  }
  drain(now, wall, fallbackTrace) {
    if (this.start == null) return [];
    const duration = Math.min(90_000, Math.max(0, now - this.start)), events = [];
    for (const [role, a] of [...this.roles]) {
      const ram = a.rise >= 256 * MIB, cpu = a.hotMs >= 2000;
      const attrs = { 'veacom.perf.role': role, 'veacom.perf.signal': cpu ? (ram ? 'cpu-ram' : 'cpu') : (ram ? 'ram' : 'baseline'),
        'veacom.perf.samples': a.samples, 'veacom.perf.peak_offset_ms': Math.min(duration, Math.round(a.peakAt - this.start)),
        'veacom.perf.cpu_hot_ms': Math.min(90_000, Math.round(a.hotMs)), 'veacom.perf.ram_rise_mib': Math.round(a.rise / MIB) };
      if (a.ram != null) attrs['veacom.perf.ram_mib'] = Math.round(a.ram / MIB);
      if (a.cpu != null) attrs['veacom.perf.cpu_pct'] = Math.round(a.cpu);
      if (a.hwm) attrs['veacom.perf.process_hwm_mib'] = Math.round(a.hwm / MIB);
      if (a.context?.action) attrs['veacom.action'] = a.context.action;
      events.push({ name: 'perf.resources', trace: a.context?.trace || fallbackTrace, span: randomBytes(8).toString('hex'),
        start: wall - duration, duration, attributes: attrs });
      // Carry the last current resident set into the next interval, not its lifetime high-water mark.
      let last = 0, seen = false;
      for (const r of this.prev.values()) if (r.role === role && usable(r.rss)) { last += r.rss; seen = true; }
      this.roles.delete(role);
      if (seen) this.roles.set(role, { samples: 0, low: last, ram: null, cpu: null, hwm: 0, rise: 0, hotMs: 0, peakAt: now, rank: -1 });
    }
    this.start = now;
    return events.filter(e => e.attributes['veacom.perf.samples']);
  }
}

class ResourceMonitor {
  constructor({ read, visible = () => true }) { this.read = read; this.visible = visible; this.active = null; }
  start(emit) {
    if (this.active) return;
    const run = this.active = { window: new ResourceWindow(), emit, trace: randomBytes(16).toString('hex'), controller: new AbortController() };
    const tick = async () => {
      try {
        const rows = await this.read(run.controller.signal);
        if (this.active !== run) return;
        const now = performance.now(), wall = Date.now();
        if (run.window.start !== null && now - run.window.start > WINDOW * 2) run.window = new ResourceWindow(); // sleep/resume
        run.window.sample(rows, now, run.context && wall - run.context.at < 10000 ? run.context : undefined);
        if (now - run.window.start >= WINDOW) run.emit(run.window.drain(now, wall, run.trace));
      } catch { /* Missing counters must not interrupt viewing. */ }
      if (this.active === run) { run.timer = setTimeout(tick, this.visible() ? 1000 : 5000); run.timer.unref?.(); }
    };
    run.timer = setTimeout(tick, 1000); run.timer.unref?.();
  }
  observe(events) {
    const run = this.active;
    if (!run) return;
    for (const e of events) {
      const action = e.attributes['veacom.action'];
      if (action || e.name === 'ux.study.open' || e.name === 'ux.study.first_image') {
        const at = e.start + e.duration;
        if (!run.context || at >= run.context.at) run.context = { trace: e.trace, action, at };
      }
    }
  }
  stop(flush) {
    const run = this.active;
    if (!run) return;
    clearTimeout(run.timer); run.controller.abort();
    if (flush) { try { run.emit(run.window.drain(performance.now(), Date.now(), run.trace)); } catch { /* best effort at quit */ } }
    this.active = null;
  }
}
function forViewer(app, engine, visible) {
  return new ResourceMonitor({ visible, read: async signal => {
    const rows = electronRows(app.getAppMetrics());
    try {
      const c = engine.connection();
      const res = await c.request('processCounters', undefined, { signal: AbortSignal.any([signal, AbortSignal.timeout(700)]) });
      if (res.ok) {
        const v = await res.json();
        rows.push({ key: `engine:${c.generation}`, role: 'engine', cpu: v.cpuSeconds, rss: v.residentBytes, hwm: v.peakResidentBytes });
      }
    } catch { /* The engine can be starting, restarting, or busy. */ }
    return rows;
  } });
}
module.exports = { ResourceWindow, ResourceMonitor, electronRows, forViewer };
