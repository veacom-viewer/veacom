// Usage timings, the main-process side: the user's consent, a second check of every event the
// renderer reports (electron/usage-schema.json), a bounded local copy in the settings folder, and
// sending to the telemetry collector as OpenTelemetry spans (OTLP/HTTP JSON with the ingest token).
//
// The renderer cannot reach the network (its Content-Security-Policy allows only the app itself), so
// everything goes through here. Nothing is recorded or sent until the user agrees; turning it off
// deletes the local copy and the install id. Without a collector address (VEACOM_TELEMETRY_ENDPOINT
// and VEACOM_TELEMETRY_TOKEN, or a telemetry-endpoint.json packaged beside this file) events are only
// kept locally, so a hospital whose network blocks the collector still has the copy to hand over.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const schema = require('./usage-schema.json');

const SPAN_NAMES = new Set(schema.spanNames);
const RULES = Object.fromEntries(Object.entries(schema.spanAttributes).map(([key, rule]) => [key, { ...rule, regex: rule.pattern ? new RegExp(rule.pattern) : null }]));
const ENVIRONMENTS = new Set(['field', 'dev', 'lab']);
const FILE_BYTES = 256 * 1024;
const TOTAL_BYTES = 8 * 1024 * 1024;
const BATCH = 400;
const SEND_INTERVAL = 20_000;

/** The attribute's value if the schema allows it, otherwise undefined. Lab-only names come from this process, never the renderer. */
function allowedValue(key, value) {
  const rule = Object.hasOwn(RULES, key) ? RULES[key] : undefined;
  if (!rule || rule.labOnly) return undefined;
  if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length > 100) return undefined;
    if (rule.enum && !rule.enum.includes(value)) return undefined;
    if (rule.listOf && !value.split(',').every(part => rule.listOf.includes(part))) return undefined;
    return rule.regex && !rule.regex.test(value) ? undefined : value;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) return undefined;
  if (rule.type === 'int') return Number.isSafeInteger(value) ? value : undefined;
  return Math.round(value * 1000) / 1000;
}

/** One event as the renderer sends it, checked field by field; null when it cannot be one. */
function sanitizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const { name, trace, span, start, duration, attributes } = event;
  if (!SPAN_NAMES.has(name) || typeof trace !== 'string' || !/^[0-9a-f]{32}$/.test(trace) || typeof span !== 'string' || !/^[0-9a-f]{16}$/.test(span)) return null;
  // Milliseconds since 1970, between 2017 and 2100; a span lasts at most a week.
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 1.5e12 || start > 4.1e12) return null;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 6.048e8) return null;
  const clean = {};
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    for (const [key, value] of Object.entries(attributes)) {
      const allowed = allowedValue(key, value);
      if (allowed !== undefined) clean[key] = allowed;
    }
  }
  return { name, trace, span, start: Math.round(start * 1000) / 1000, duration: Math.round(duration * 1000) / 1000, attributes: clean };
}

const nanos = milliseconds => (BigInt(Math.round(milliseconds * 1000)) * 1000n).toString();
function otlpValue(key, value) {
  const rule = RULES[key];
  if (typeof value === 'number' && rule?.type === 'int') return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: String(value) };
}
const otlpAttributes = values => Object.entries(values).map(([key, value]) => ({ key, value: otlpValue(key, value) }));

/** The OTLP/HTTP JSON body for stored events: one resource, one scope, one span per event. */
function otlpTraces(events, resource) {
  return { resourceSpans: [{ resource: { attributes: otlpAttributes(resource) }, scopeSpans: [{
    scope: { name: 'veacom.usage', version: '1' },
    spans: events.map(event => ({ traceId: event.trace, spanId: event.span, name: event.name, kind: 1,
      startTimeUnixNano: nanos(event.start), endTimeUnixNano: nanos(event.start + event.duration), attributes: otlpAttributes(event.attributes) })),
  }] }] };
}

/**
 * The local copy: numbered JSON-lines files of at most 256 KiB, 8 MiB in all (the oldest go first),
 * and a cursor saying how far the collector has received them.
 */
class UsageStore {
  constructor(directory) { this.directory = directory; this.cursorFile = path.join(directory, 'cursor.json'); }
  files() {
    let names = [];
    try { names = fs.readdirSync(this.directory); } catch { return []; }
    return names.flatMap(name => {
      const match = /^events-(\d{8})\.jsonl$/.exec(name);
      if (!match) return [];
      try { return [{ number: Number(match[1]), file: path.join(this.directory, name), size: fs.statSync(path.join(this.directory, name)).size }]; } catch { return []; }
    }).sort((a, b) => a.number - b.number);
  }
  cursor() {
    try {
      const value = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8'));
      if (Number.isSafeInteger(value.number) && Number.isSafeInteger(value.offset)) return value;
    } catch { /* No events sent yet. */ }
    return { number: 0, offset: 0 };
  }
  setCursor(value) { fs.writeFileSync(this.cursorFile, JSON.stringify(value), { mode: 0o600 }); }
  append(events) {
    if (!events.length) return;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    let files = this.files(), last = files.at(-1) ?? { number: 0, size: FILE_BYTES };
    let chunk = '', chunkBytes = 0;
    const write = () => { if (chunk) fs.appendFileSync(path.join(this.directory, `events-${String(last.number).padStart(8, '0')}.jsonl`), chunk, { mode: 0o600 }); chunk = ''; chunkBytes = 0; };
    for (const event of events) {
      const line = `${JSON.stringify(event)}\n`, bytes = Buffer.byteLength(line);
      // A file holds at most 256 KiB, so the oldest can be dropped in small steps.
      if (last.size + chunkBytes + bytes > FILE_BYTES && last.size + chunkBytes > 0) { write(); last = { number: last.number + 1, size: 0 }; }
      chunk += line; chunkBytes += bytes;
    }
    write();
    files = this.files();
    let total = files.reduce((sum, file) => sum + file.size, 0);
    while (total > TOTAL_BYTES && files.length > 1) {
      const oldest = files.shift(); total -= oldest.size;
      try { fs.rmSync(oldest.file, { force: true }); } catch { /* Removed next time. */ }
    }
  }
  /** Up to `limit` events the collector has not received, and the cursor after them. */
  unsent(limit) {
    const files = this.files();
    let { number, offset } = this.cursor();
    const events = [];
    for (const file of files) {
      if (file.number < number) continue;
      if (file.number > number) { number = file.number; offset = 0; }
      const text = fs.readFileSync(file.file, 'utf8');
      const bytes = Buffer.from(text);
      let position = Math.min(offset, bytes.length);
      while (events.length < limit && position < bytes.length) {
        const end = bytes.indexOf(10, position);
        if (end < 0) break;
        try {
          const stored = JSON.parse(bytes.subarray(position, end).toString('utf8')), event = sanitizeEvent(stored);
          if (event) events.push(withLab(event, stored));
        } catch { /* A damaged line is skipped. */ }
        position = end + 1;
      }
      offset = position;
      if (events.length >= limit) break;
    }
    return { events, cursor: { number, offset } };
  }
  pending() {
    const { number, offset } = this.cursor();
    return this.files().reduce((sum, file) => sum + (file.number < number ? 0 : file.number === number ? Math.max(0, file.size - offset) : file.size), 0);
  }
  clear() { fs.rmSync(this.directory, { recursive: true, force: true }); }
}

// Lab runs (scripted baselines on public studies) name the study and scenario on the open event. The
// stored line keeps them beside the checked event; nothing from the renderer can set them.
function withLab(event, stored) {
  const lab = stored?.lab;
  if (!lab || typeof lab !== 'object') return event;
  const extra = {};
  for (const key of ['veacom.study.name', 'veacom.scenario']) {
    if (typeof lab[key] === 'string' && RULES[key].regex.test(lab[key])) extra[key] = lab[key];
  }
  return { ...event, attributes: { ...event.attributes, ...extra } };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } }

/** The collector's address and ingest token: environment first, then a file packaged beside this one. */
function collectorConfig(env, directory) {
  let endpoint = env.VEACOM_TELEMETRY_ENDPOINT, token = env.VEACOM_TELEMETRY_TOKEN;
  if (!endpoint || !token) {
    const packaged = readJson(path.join(directory, 'telemetry-endpoint.json'));
    endpoint = packaged.endpoint; token = packaged.token;
  }
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return null;
    if (typeof token !== 'string' || token.length < 16) return null;
    return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}/v1/traces`, token };
  } catch { return null; }
}

class Usage {
  constructor({ userData, version, packaged, env = process.env, fetchImpl = fetch, platform = process.platform, release = os.release(), arch = process.arch, configDirectory = __dirname, resourceMonitor = null }) {
    Object.assign(this, { env, fetchImpl, packaged, resourceMonitor });
    this.epoch = 0; this.controller = null;
    this.preferencesFile = path.join(userData, 'preferences.json');
    this.store = new UsageStore(path.join(userData, 'usage'));
    this.collector = collectorConfig(packaged ? {} : env, configDirectory);
    this.choice = this.preferences().usageConsent;
    if (packaged && this.collector?.url !== 'https://otel-collector-5phqzw3wxq-nw.a.run.app/v1/traces') this.collector = null;
    // A packaged build takes one override, the lab label, so a release check on a package does not count as
    // real use. It is only a label: consent, the collector and study names stay out of the environment's reach.
    const requested = env.VEACOM_TELEMETRY_ENVIRONMENT;
    const environment = requested === 'lab' || (!packaged && ENVIRONMENTS.has(requested)) ? requested : packaged ? 'field' : 'dev';
    this.environment = environment;
    this.lab = environment === 'lab' && !packaged ? Object.fromEntries(['veacom.study.name', 'veacom.scenario']
      .map(key => [key, env[key === 'veacom.study.name' ? 'VEACOM_TELEMETRY_STUDY_NAME' : 'VEACOM_TELEMETRY_SCENARIO']])
      .filter(([key, value]) => typeof value === 'string' && RULES[key].regex.test(value))) : null;
    this.resourceBase = { 'service.name': 'veacom', 'service.version': String(version || '0'), 'deployment.environment': environment,
      'os.type': platform === 'win32' ? 'windows' : platform, 'os.version': String(release).slice(0, 40),
      'host.arch': arch === 'x64' ? 'amd64' : arch, 'telemetry.sdk.name': 'veacom-usage', 'telemetry.sdk.language': 'nodejs', 'telemetry.sdk.version': '1' };
    this.sending = null; this.failures = 0; this.retryAt = 0; this.timer = null;
  }
  preferences() { return readJson(this.preferencesFile); }
  savePreferences(patch) {
    const next = { ...this.preferences(), ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
    fs.mkdirSync(path.dirname(this.preferencesFile), { recursive: true });
    fs.writeFileSync(this.preferencesFile, JSON.stringify(next), { mode: 0o600 });
  }
  /** 'granted', 'denied' or null (not asked yet). VEACOM_TELEMETRY_CONSENT decides for scripted runs. */
  consent() {
    if (this.choice === 'granted' || this.choice === 'denied') return this.choice;
    const forced = this.packaged ? null : this.env.VEACOM_TELEMETRY_CONSENT;
    return forced === 'granted' || forced === 'denied' ? forced : null;
  }
  installId() {
    let id = this.preferences().usageInstallId;
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) { id = randomBytes(16).toString('hex'); this.savePreferences({ usageInstallId: id }); }
    return id;
  }
  /** How the renderer draws (WebGL renderer string, software or not): every duration depends on it. */
  setMachine(machine) {
    if (!machine || typeof machine !== 'object') return;
    if (this.consent() !== 'granted') return;
    const text = typeof machine.renderer === 'string' ? machine.renderer.slice(0, 200) : '';
    const vendor = ['swiftshader', 'llvmpipe', 'microsoft', 'apple', 'nvidia', 'intel', 'amd', 'radeon'].find(name => text.toLowerCase().includes(name));
    this.resourceBase['veacom.machine.renderer'] = ({ swiftshader: 'software', llvmpipe: 'software', radeon: 'amd' })[vendor] || vendor || 'other';
    if (typeof machine.software === 'boolean') this.resourceBase['veacom.machine.software_renderer'] = String(machine.software);
  }
  status() { return { consent: this.consent(), sending: this.consent() === 'granted' && Boolean(this.collector), environment: this.environment, pendingBytes: this.consent() === 'granted' ? this.store.pending() : 0 }; }
  setConsent(value) {
    if (value !== 'granted' && value !== 'denied') throw new Error('Invalid choice.');
    this.epoch++; this.controller?.abort(); this.retryAt = 0; this.failures = 0;
    this.choice = value;
    if (value === 'denied') { this.resourceMonitor?.stop(false); this.savePreferences({ usageConsent: 'denied', usageInstallId: undefined }); this.store.clear(); this.stop(); }
    else { this.savePreferences({ usageConsent: 'granted' }); this.installId(); this.start(); }
    return this.status();
  }
  /** Stores checked events (consent given) and sends them soon. Returns how many were kept. */
  record(events, fromMonitor = false) {
    if (this.consent() !== 'granted' || !Array.isArray(events) || events.length > 2000) return 0;
    const clean = events.map(sanitizeEvent).filter(event => event && (fromMonitor === (event.name === 'perf.resources')))
      .map(event => this.lab && event.name === 'ux.study.open' ? { ...event, lab: this.lab } : event);
    try { this.store.append(clean); if (!fromMonitor) this.resourceMonitor?.observe(clean); } catch { return 0; }
    this.start();
    if (this.store.pending() > 64 * 1024) void this.send();
    return clean.length;
  }
  start() {
    if (this.consent() !== 'granted') return;
    this.resourceMonitor?.start(events => this.record(events, true));
    if (this.timer || !this.collector) return;
    this.timer = setInterval(() => void this.send(), SEND_INTERVAL);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** Sends what the collector has not received, batch by batch; on failure waits longer each time. */
  send({ timeout = 15_000, force = false } = {}) {
    if (this.sending) return this.sending;
    if (!this.collector || this.consent() !== 'granted' || (!force && Date.now() < this.retryAt)) return Promise.resolve(0);
    const epoch = this.epoch;
    const active = () => epoch === this.epoch && this.consent() === 'granted';
    const controller = this.controller = new AbortController();
    this.sending = Promise.resolve().then(async () => {
      let sent = 0;
      try {
        for (let round = 0; round < 25 && active(); round++) {
          const batch = this.store.unsent(BATCH);
          if (!batch.events.length) break;
          const resource = { ...this.resourceBase, 'veacom.install_id': this.installId() };
          const response = await this.fetchImpl(this.collector.url, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.collector.token}` },
            body: JSON.stringify(otlpTraces(batch.events.map(({ lab, ...event }) => event), resource)) });
          // A malformed batch can never succeed: skip it rather than block the rest. Anything else is retried.
          if (!response.ok && response.status !== 400) throw new Error(`Collector answered ${response.status}`);
          if (!active()) break;
          this.store.setCursor(batch.cursor); if (response.ok) sent += batch.events.length;
        }
        this.failures = 0; this.retryAt = 0;
      } catch {
        if (!active()) return sent;
        this.failures++; this.retryAt = Date.now() + Math.min(600_000, 15_000 * 2 ** Math.min(this.failures, 6));
      }
      return sent;
    }).finally(() => { this.sending = null; this.controller = null; });
    return this.sending;
  }
  /** At quit: one last attempt, bounded so closing the app never waits long. */
  async flush(timeout = 3000) {
    this.resourceMonitor?.stop(this.consent() === 'granted');
    this.stop();
    await Promise.race([this.send({ timeout, force: true }), new Promise(resolve => setTimeout(resolve, timeout + 200))]);
  }
}

/** Where a selection came from, without its path: an archive, a network share, a read-only disc, or a disk. */
function classifySource(paths, { platform = process.platform, writable = isWritable } = {}) {
  if (!Array.isArray(paths) || !paths.length) return 'disk';
  if (paths.some(value => /\.(zip|rar|7z)$/i.test(value))) return 'zip';
  if (platform === 'win32' && paths.some(value => value.startsWith('\\\\'))) return 'network';
  const root = volumeRoot(paths[0], platform);
  if (root && !writable(root)) return 'cd';
  return 'disk';
}
function volumeRoot(value, platform) {
  if (platform === 'win32') { const match = /^([A-Za-z]:)[\\/]/.exec(value); return match && match[1].toUpperCase() !== 'C:' ? `${match[1]}\\` : null; }
  const match = platform === 'darwin' ? /^\/Volumes\/[^/]+/.exec(value) : /^\/(?:media|mnt|run\/media)\/(?:[^/]+\/)?[^/]+/.exec(value);
  return match ? match[0] : null;
}
function isWritable(directory) { try { fs.accessSync(directory, fs.constants.W_OK); return true; } catch { return false; } }

/** Registers the renderer's three requests and returns the instance (for the quit flush). */
function registerUsageHandlers({ handle, ipcMain, validateSender, ...options }) {
  const usage = new Usage(options);
  handle('usage:status', () => usage.status());
  handle('usage:consent', value => usage.setConsent(value));
  handle('usage:record', events => usage.record(events));
  handle('usage:machine', machine => { usage.setMachine(machine); });
  // The page's last events as it unloads (fire-and-forget, so the window is not held open).
  ipcMain?.on('usage:final', (event, events) => { try { validateSender(event); usage.record(events); } catch { /* Not the application page. */ } });
  usage.start();
  return usage;
}

module.exports = { Usage, UsageStore, sanitizeEvent, otlpTraces, collectorConfig, classifySource, registerUsageHandlers };
