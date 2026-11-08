// A stand-in for veacom-core that speaks its pipe protocol (electron/engine-pipe.cjs), for the engine lifecycle tests.
// plan.json in the given folder says how each start behaves, in order: hang, ignoreTerm, exitBeforeReady, protocol (the
// one HELLO announces), crashImport, ignoreShutdown (and stdin closing), deafToShutdown (the request only). Each request's
// op is recorded in requests.jsonl.
const fs = require('node:fs');
const path = require('node:path');
const { MessageReader, encode, decodeRequest, FROM_ENGINE, TO_ENGINE, PROTOCOL } = require('../../electron/engine-pipe.cjs');
const directory = process.argv[2];
const counter = path.join(directory, 'count');
const index = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0);
fs.writeFileSync(counter, String(index + 1));
const plan = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8'))[index] || {};
const record = value => fs.appendFileSync(path.join(directory, 'requests.jsonl'), JSON.stringify({ index, pid: process.pid, ...value }) + '\n');
record({ op: 'spawn' });
const answer = (id, value, done) => {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.from(JSON.stringify({ status: 200, headers: { 'content-type': 'application/json' }, length: body.length }));
  process.stdout.write(Buffer.concat([encode(FROM_ENGINE.head, id, head), encode(FROM_ENGINE.data, id, body)]), done);
};
if (plan.ignoreTerm) process.on('SIGTERM', () => {});
if (plan.hang) setInterval(() => {}, 1000);
else if (plan.exitBeforeReady) process.exit(9);
else {
  let exporting;
  const reader = new MessageReader((kind, id, payload) => {
    if (kind !== TO_ENGINE.request) return;
    const { op } = decodeRequest(payload);
    record({ op });
    if (op === 'crash' || (op === 'import' && plan.crashImport)) { process.exit(17); return; }
    if (op === 'corrupt') {
      const header = Buffer.alloc(9);
      header[0] = FROM_ENGINE.data; header.writeUInt32LE(0xffffffff, 5);
      process.stdout.write(header);
      return;
    }
    if (op === 'export') { exporting = id; return; }
    if (op === 'shutdown' && exporting) {
      answer(id, { ok: true });
      setTimeout(() => answer(exporting, {}, () => process.exit(0)), 150);
      return;
    }
    if (op === 'shutdown') {
      if (!plan.ignoreShutdown && !plan.deafToShutdown) answer(id, {}, () => process.exit(0));
      return;
    }
    answer(id, { series: [], warnings: [], pid: process.pid });
  });
  process.stdin.on('data', chunk => reader.push(chunk));
  // As the engine: stdin closing (main quit or crashed) stops it, unless this start plays one that ignores shutdown.
  process.stdin.on('end', () => { if (!plan.ignoreShutdown) process.exit(0); });
  if (plan.ignoreShutdown) setInterval(() => {}, 1000);
  process.stdout.write(encode(FROM_ENGINE.hello, 0, Buffer.from(JSON.stringify({ protocol: 'protocol' in plan ? plan.protocol : PROTOCOL, version: 'test' }))));
}
