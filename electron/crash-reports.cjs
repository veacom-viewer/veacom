'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { exceptionClass } = require('./crash-exception.mjs');
const { REASONS, SIGNALS, STAGES, ENGINE_WORK, JS_EXCEPTIONS, buildInfo, isCode, validReport } = require('./crash-schema.cjs');

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
    this.stage = 'startup'; this.engineStartupIncident = false;
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
  setStage(stage) {
    if (this.closed || this.stage === 'shutdown' || this.stage === stage || !STAGES.includes(stage)) return;
    this.stage = stage;
    if (this.running) { this.running.stage = stage; this.save(); }
  }
  make(role, reason, { code, signal, work, exception, recovery = 'unknown' } = {}) {
    const report = { ...this.info, id: randomBytes(16).toString('hex'), at: Date.now(), process: role,
      stage: this.stage,
      reason: REASONS.includes(reason) ? reason : 'unknown', code: isCode(code) ? code : null,
      signal: SIGNALS.has(signal) ? signal : null, recovery };
    if (role === 'engine' && ENGINE_WORK.includes(work)) report.work = work;
    if (JS_EXCEPTIONS.includes(exception)) report.exception = exception;
    return report;
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
    if (role === 'engine' && this.stage === 'engine-start') this.engineStartupIncident = true;
    this.events.push(report); this.save(); this.schedule();
  }
  startupFailed(error) {
    if (this.closed || this.stage === 'shutdown' || !this.running) return;
    this.running = null;
    // The engine already reported its startup failure with the OS status when available.
    if (this.stage === 'engine-start' && this.engineStartupIncident) this.save();
    else this.record('main', 'startup-failed', { exception: exceptionClass(error) });
  }
  mainException(reason, exception) {
    if (this.closed) return;
    // If the exception terminates the process now, its queued reason replaces the generic unclean exit.
    // Electron can also keep running after an exception. Arm the marker again if the event loop survives.
    this.running = null;
    this.record('main', reason, { exception });
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
      // A receiver running an older schema can reject one report and accept the next.
      for (const report of this.events.slice()) {
        if (this.closed) break;
        if (report.recovery === 'pending' || !this.events.includes(report)) continue;
        try {
          const res = await this.fetchImpl(this.endpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'VEAcom-Crash' },
            body: JSON.stringify(report), signal: AbortSignal.timeout(6000) });
          await res.body?.cancel();
          if (res.status === 204) {
            this.events = this.events.filter(r => r.id !== report.id);
            this.save();
          } else {
            retry = this.backoff;
            if (![400, 413, 415].includes(res.status)) break;
          }
        } catch { retry = this.backoff; break; }
      }
      this.backoff = retry ? Math.min(300_000, retry * 2) : 1000;
    }).finally(() => { this.sending = null; this.schedule(retry); });
    return this.sending;
  }
  async flush() {
    if (this.closed || !this.events.length) return;
    let timer;
    try {
      await Promise.race([this.send(), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    } finally { clearTimeout(timer); }
  }
  finish() {
    if (this.closed) return;
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
  const exception = (error, origin) => reports.mainException(
    origin === 'unhandledRejection' ? 'unhandled-rejection' : 'uncaught-exception', exceptionClass(error));
  process.on('uncaughtExceptionMonitor', exception);
  app.on('will-quit', () => { quitting = true; reports.setStage('shutdown'); });
  const finish = () => { process.off('uncaughtExceptionMonitor', exception); reports.finish(); };
  // Windows can exit without emitting quit. Only session-end confirms that logout or shutdown will proceed.
  app.on('browser-window-created', (_event, window) => window.once('session-end', finish));
  app.once('quit', finish);
  return reports;
}
module.exports = { CrashReports, ENDPOINT, crashEndpoint, registerCrashReports };
