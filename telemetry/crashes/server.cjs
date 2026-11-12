'use strict';
const http = require('node:http');
const { validReport } = require('../../electron/crash-schema.cjs');

const path = '/v1/crashes';
const maxBytes = 1024;
const identityEndpoint = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const strings = fields => Object.entries(fields).map(([key, value]) => ({ key, value: { stringValue: value } }));

// Build a fresh trace. Only values checked by validReport enter either backend exporter.
function toTrace(r) {
  const time = (BigInt(r.at) * 1000000n).toString();
  return { resourceSpans: [{ resource: { attributes: strings({ 'service.name': 'veacom-crash', 'service.version': r.version,
    'deployment.environment': r.environment, 'os.type': r.platform, 'host.arch': r.arch,
    ...(r.build && r.build !== 'unknown' ? { 'veacom.commit': r.build } : {}) }) }, scopeSpans: [{
    scope: { name: 'veacom.crash', version: '1' }, spans: [{ traceId: r.id, spanId: r.id.slice(-16) === '0000000000000000' ? '0000000000000001' : r.id.slice(-16),
      name: 'crash.' + r.process, kind: 1, startTimeUnixNano: time, endTimeUnixNano: time,
      status: { code: 2, message: [r.signal, r.code === null ? null : 'exit ' + r.code].filter(Boolean).join(', ') },
      attributes: strings({ 'veacom.error_kind': r.reason, 'veacom.result': r.recovery,
        ...(r.stage ? { 'veacom.crash.stage': r.stage } : {}), ...(r.work ? { 'veacom.crash.work': r.work } : {}),
        ...(r.exception ? { 'veacom.crash.exception': r.exception } : {}) }) }],
  }] }] };
}
async function identityToken(audience, signal) {
  const url = new URL(identityEndpoint);
  url.searchParams.set('audience', audience);
  const response = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal });
  if (!response.ok) throw new Error('Storage identity unavailable.');
  return response.text();
}
function createServer({ storageUrl, fetchImpl = fetch, getToken = identityToken, log = console.log }) {
  const storage = new URL(storageUrl);
  if (storage.protocol !== 'https:' || storage.href !== storage.origin + '/') throw new Error('Expected an HTTPS service origin.');
  const endpoint = new URL('/v1/traces', storage);
  // A global limit per instance needs no IP address or installation identifier.
  let available = 60, last = Date.now();
  return http.createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    const finish = status => { res.writeHead(status, { 'cache-control': 'no-store' }); res.end(); };
    if (req.method !== 'POST' || req.url !== path) return finish(404);
    if (req.headers['content-type']?.split(';')[0] !== 'application/json' || req.headers['content-encoding']) return finish(415);
    const now = Date.now();
    available = Math.min(60, available + Math.max(0, now - last) / 100); last = now;
    if (available < 1) return finish(429);
    available--;
    if (Number(req.headers['content-length']) > maxBytes) return finish(413);
    const chunks = [];
    let size = 0, report;
    try {
      for await (const chunk of req) {
        size += chunk.length; if (size > maxBytes) return finish(413);
        chunks.push(chunk);
      }
      report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return finish(400); }
    if (!validReport(report)) return finish(400);
    try {
      const signal = AbortSignal.timeout(5000);
      const token = await getToken(storage.origin, signal);
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(toTrace(report)), signal });
      if (response.status !== 200) { await response.body?.cancel(); return finish(503); }
      const ack = await response.json();
      if (!ack || typeof ack !== 'object' || Array.isArray(ack) || Number(ack.partialSuccess?.rejectedSpans ?? 0) !== 0) return finish(503);
      if (report.environment === 'field') log('{"event":"veacom.field_fault_stored"}');
      finish(204);
    } catch { finish(503); }
  });
}
if (require.main === module) createServer({ storageUrl: process.env.CRASH_STORAGE_URL }).listen(Number(process.env.PORT || 8080), '0.0.0.0');
module.exports = { createServer, toTrace };
