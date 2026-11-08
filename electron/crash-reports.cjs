'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { REASONS, SIGNALS, buildInfo, isCode, validReport } = require('./crash-schema.cjs');

const ENDPOINT = 'https://veacom-crashes-5phqzw3wxq-nw.a.run.app/v1/crashes';
const LIMIT = 64;
function crashEndpoint(packaged, env) {
  if (packaged || env.VEACOM_CRASH_ENDPOINT === ENDPOINT) return ENDPOINT;
  try {
    const url = new URL(env.VEACOM_CRASH_ENDPOINT);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) &&
        url.pathname === '/v1/crashes' && !url.username && !url.password && !url.search && !url.hash) return url.href;
  } catch { /* Source builds send only when a test supplies an endpoint. */ }
  return null;
}
class CrashReports {
  constructor({ userData, info, endpoint, fetchImpl = fetch }) {
    this.file = path.join(userData, 'crash-reports', 'queue.json');
    this.info = info; this.endpoint = endpoint; this.fetchImpl = fetchImpl;
    this.events = []; this.running = null; this.timer = null; this.sending = null;
    this.backoff = 1000; this.closed = false;
  }
  start() {
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isFile() && stat.size <= 65536) {
        const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(state.events)) this.events = state.events.slice(-LIMIT).filter(r => validReport(r, true))
          .map(r => r.recovery === 'pending' ? { ...r, recovery: 'unknown' } : r);
        // The previous process could not tell us why it disappeared. Date this at detection and keep its build.
        if (validReport(state.running) && state.running.process === 'main' && state.running.reason === 'unclean-exit') {
          this.events.push({ ...state.running, at: Date.now() });
        }
      }
    } catch { /* First launch or an unreadable queue. */ }
    this.running = this.make('main', 'unclean-exit');
    this.save(); this.schedule();
  }
  make(role, reason, { code, signal, recovery = 'unknown' } = {}) {
    return { ...this.info, id: randomBytes(16).toString('hex'), at: Date.now(), process: role,
      reason: REASONS.includes(reason) ? reason : 'unknown', code: isCode(code) ? code : null,
      signal: SIGNALS.has(signal) ? signal : null, recovery };
  }
  save() {
    if (this.events.length > LIMIT) this.events.splice(0, this.events.length - LIMIT);
    const temp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.rmSync(temp, { force: true });
      fs.writeFileSync(temp, JSON.stringify({ running: this.running, events: this.events }), { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temp, this.file);
    } catch { /* A read-only or full disk still permits sending from memory. */ }
  }
  record(role, reason, details) {
    if (this.closed) return;
    const report = this.make(role, reason, details);
    if (!validReport(report, true)) return;
    this.events.push(report); this.save(); this.schedule();
  }
  mainException(reason) {
    if (this.closed) return;
    // If the exception terminates the process now, its queued reason replaces the generic unclean exit.
    // Electron can also keep running after an exception. Arm the marker again if the event loop survives.
    this.running = null;
    this.record('main', reason);
    if (!this.rearm) this.rearm = setImmediate(() => {
      this.rearm = null;
      if (!this.closed) { this.running = this.make('main', 'unclean-exit'); this.save(); }
    }).unref();
  }
  settleEngine(recovery) {
    const pending = this.events.filter(r => r.process === 'engine' && r.recovery === 'pending');
    if (!pending.length) return;
    for (const event of pending) event.recovery = recovery;
    this.save(); this.schedule();
  }
  schedule(delay = 0) {
    if (this.closed || this.timer || this.sending || !this.events.some(r => r.recovery !== 'pending')) return;
    this.timer = setTimeout(() => { this.timer = null; void this.send(); }, delay);
    this.timer.unref();
  }
  send() {
    if (this.sending) return this.sending;
    let retry = 0;
    this.sending = Promise.resolve().then(async () => {
      while (!this.closed) {
        const report = this.events.find(r => r.recovery !== 'pending');
        if (!report) return;
        try {
          const res = await this.fetchImpl(this.endpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'VEAcom-Crash' },
            body: JSON.stringify(report), signal: AbortSignal.timeout(6000) });
          await res.body?.cancel();
          if (res.status !== 204 && ![400, 413, 415].includes(res.status)) throw new Error('Retry');
          this.events = this.events.filter(r => r.id !== report.id);
          this.backoff = 1000; this.save();
        } catch {
          retry = this.backoff; this.backoff = Math.min(300_000, retry * 2); return;
        }
      }
    }).finally(() => { this.sending = null; this.schedule(retry); });
    return this.sending;
  }
  finish() {
    this.closed = true; clearTimeout(this.timer); clearImmediate(this.rearm);
    this.running = null; this.settleEngine('unknown'); this.save();
  }
}
function registerCrashReports(app, env = process.env) {
  const endpoint = crashEndpoint(app.isPackaged, env);
  if (!endpoint) return null;
  const environment = env.VEACOM_CRASH_ENVIRONMENT === 'lab' ? 'lab' : app.isPackaged ? 'field' : 'dev';
  const reports = new CrashReports({ userData: app.getPath('userData'), endpoint,
    info: buildInfo(app.getVersion(), process.platform, process.arch, environment, require('../package.json').veacomBuildCommit) });
  reports.start();
  let quitting = false;
  const gone = (role, details) => {
    if (!quitting && details.reason !== 'clean-exit') reports.record(role, details.reason, { code: details.exitCode });
  };
  app.on('render-process-gone', (_event, _contents, details) => gone('renderer', details));
  app.on('child-process-gone', (_event, details) => gone(details.type === 'GPU' ? 'gpu' : details.type === 'Utility' ? 'utility' : 'helper', details));
  const exception = (_error, origin) => reports.mainException(origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception');
  process.on('uncaughtExceptionMonitor', exception);
  app.on('will-quit', () => { quitting = true; });
  app.once('quit', () => { process.off('uncaughtExceptionMonitor', exception); reports.finish(); });
  return reports;
}
module.exports = { CrashReports, ENDPOINT, crashEndpoint, registerCrashReports };
