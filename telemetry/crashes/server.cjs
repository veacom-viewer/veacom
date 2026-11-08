'use strict';
const http = require('node:http');
const { validReport } = require('../../electron/crash-schema.cjs');

const path = '/v1/crashes';
const maxBytes = 1024;
const collector = 'https://otel-collector-5phqzw3wxq-nw.a.run.app/v1/traces';
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
      attributes: strings({ 'veacom.error_kind': r.reason, 'veacom.result': r.recovery }) }],
  }] }] };
}
function createServer({ token, endpoint = collector, fetchImpl = fetch }) {
  if (!token) throw new Error('Missing collector credential.');
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
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(toTrace(report)), signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel(); return finish(503); }
      const ack = await response.json();
      if (Number(ack.partialSuccess?.rejectedSpans ?? 0) !== 0) return finish(503);
      finish(204);
    } catch { finish(503); }
  });
}
if (require.main === module) createServer({ token: process.env.INGEST_TOKEN }).listen(Number(process.env.PORT || 8080), '0.0.0.0');
module.exports = { createServer, toTrace };
