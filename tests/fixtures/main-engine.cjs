// A stand-in for veacom-core for tests that start electron/main.cjs, speaking its pipe protocol (electron/engine-pipe.cjs):
// answers the catalog and DICOM export (a folder with a DICOMDIR), and exits on shutdown or when stdin closes. An export
// named with an `operation` waits for exportCancel with that id (for up to 5 s), as the engine stops one between files.
const fs = require('node:fs');
const path = require('node:path');
const { MessageReader, encode, decodeRequest, FROM_ENGINE, TO_ENGINE, PROTOCOL } = require('../../electron/engine-pipe.cjs');

const waiting = new Map();
const answer = (id, status, value, done) => {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.from(JSON.stringify({ status, headers: { 'content-type': 'application/json' }, length: body.length }));
  process.stdout.write(Buffer.concat([encode(FROM_ENGINE.head, id, head), encode(FROM_ENGINE.data, id, body)]), done);
};
const reader = new MessageReader((kind, id, payload) => {
  if (kind !== TO_ENGINE.request) return;
  const { op, body } = decodeRequest(payload);
  if (op === 'shutdown') { answer(id, 200, {}, () => process.exit(0)); return; }
  if (op === 'series') { answer(id, 200, { series: [], warnings: [] }); return; }
  if (op === 'exportCancel') {
    const cancel = waiting.get(body.operation);
    cancel?.();
    answer(id, 200, { requested: Boolean(cancel) });
    return;
  }
  if (op === 'export') {
    const write = () => {
      const directory = path.join(body.directory, 'VEACOM_TEST');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'DICOMDIR'), 'synthetic');
      answer(id, 200, { directory, warnings: [] });
    };
    if (!body.operation) { write(); return; }
    const timer = setTimeout(() => { waiting.delete(body.operation); write(); }, 5000);
    waiting.set(body.operation, () => {
      clearTimeout(timer); waiting.delete(body.operation);
      answer(id, 422, { error: 'Export cancelled; nothing was kept', note: { code: 'export.cancelled', text: 'Export cancelled; nothing was kept' } });
    });
    return;
  }
  answer(id, 404, {});
});
process.stdin.on('data', chunk => reader.push(chunk));
process.stdin.on('end', () => process.exit(0));
process.stdout.write(encode(FROM_ENGINE.hello, 0, Buffer.from(JSON.stringify({ protocol: PROTOCOL, version: 'test' }))));
