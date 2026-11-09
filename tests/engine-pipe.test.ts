import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertFields } from './support';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';

const require = createRequire(import.meta.url);
const { EngineChannel, MessageReader, encode, decodeRequest, FROM_ENGINE, TO_ENGINE, PROTOCOL, WINDOW } = require('../electron/engine-pipe.cjs');
const MiB = 1024 * 1024;

// The channel against a stand-in engine in this process: what main writes is parsed into `sent`, and the test plays the
// engine's side with head(), data() and end().
function fixture(handshake = true, onFailure?: (error: Error, reason: string, work: string) => void) {
  const fromEngine = new PassThrough(), toEngine = new PassThrough();
  const channel = new EngineChannel(fromEngine, toEngine, { onFailure });
  const sent: Array<{ kind: number; id: number; op?: string; body?: unknown; data?: Buffer; credit?: number }> = [];
  const reader = new MessageReader((kind: number, id: number, payload: Buffer) => {
    if (kind === TO_ENGINE.request) { const call = decodeRequest(payload); sent.push({ kind, id, op: call.op, body: call.body, data: Buffer.from(call.data) }); }
    else sent.push({ kind, id, ...(kind === TO_ENGINE.credit ? { credit: payload.readUInt32LE(0) } : {}) });
  });
  toEngine.on('data', (chunk: Buffer) => reader.push(chunk));
  const write = (message: Buffer) => fromEngine.write(message);
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  const engine = {
    hello: (value: unknown = { protocol: PROTOCOL }) => write(encode(FROM_ENGINE.hello, 0, json(value))),
    head: (id: number, length: number, status = 200, headers: Record<string, string> = {}) => write(encode(FROM_ENGINE.head, id, json({ status, headers, length }))),
    data: (id: number, bytes: Buffer) => write(encode(FROM_ENGINE.data, id, bytes)),
    end: (id: number) => write(encode(FROM_ENGINE.end, id)),
    answer: (id: number, value: unknown, status = 200) => { const body = json(value); engine.head(id, body.length, status, { 'content-type': 'application/json' }); engine.data(id, body); },
  };
  if (handshake) engine.hello();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const requests = () => sent.filter(message => message.kind === TO_ENGINE.request);
  const of = (kind: number) => sent.filter(message => message.kind === kind);
  return { channel, engine, sent, settle, requests, of, fromEngine };
}
// Distinct contents per piece without a per-byte loop: a 1 MiB piece is a filled buffer with its offset written in.
const bytes = (length: number, seed = 0) => { const piece = Buffer.alloc(length, seed % 251); if (length >= 8) piece.writeDoubleLE(seed, 0); return piece; };

describe('the imaging engine channel (stdin and stdout)', () => {
  it('reports only sent work categories when the channel closes', async () => {
    for (const [ops, expected] of [
      [['pictureNext', 'health', 'progress', 'processCounters', 'importEarly'], 'idle'],
      [['frame', 'volume', 'warm', 'pictureNext'], 'pixels'],
      [['import', 'pictureNext'], 'import'],
      [['export', 'exportEstimate'], 'export'],
      [['SYNTHETIC_PRIVATE_OP'], 'other'],
      [['import', 'volume'], 'multiple'],
      [[...Array<string>(16).fill('tags'), 'export'], 'other'], // The export is queued behind the 16 sent requests.
    ] as const) {
      const faults: string[] = [];
      const f = fixture(true, (_error, _reason, work) => faults.push(work));
      const calls = Promise.allSettled(ops.map(op => f.channel.request(op, { path: 'SYNTHETIC_PRIVATE' })));
      f.channel.close(new Error('closed'), 'pipe-closed');
      await calls;
      assert.deepEqual(faults, [expected]);
    }
  });

  it('excludes the request whose pipe write threw', async () => {
    const faults: string[] = [];
    const f = fixture(true, (_error, _reason, work) => faults.push(work));
    const importing = f.channel.request('import');
    f.channel.output.write = () => { throw new Error('Pipe closed'); };
    const exporting = f.channel.request('export');
    await Promise.all([assert.rejects(importing, /Pipe closed/), assert.rejects(exporting, /Pipe closed/)]);
    assert.deepEqual(faults, ['import']);
  });

  it('counts a pixel stream until its body finishes or the caller cancels it', async () => {
    for (const state of ['open', 'finished', 'cancelled']) {
      const faults: string[] = [];
      const f = fixture(true, (_error, _reason, work) => faults.push(work));
      const pixels = f.channel.request('frame');
      f.engine.head(1, 1);
      const response: Response = await pixels;
      if (state === 'finished') {
        const read = response.arrayBuffer();
        await f.settle();
        f.engine.data(1, bytes(1));
        await read;
      } else if (state === 'cancelled') await response.body!.cancel();
      f.channel.close(new Error('stopped'));
      assert.deepEqual(faults, [state === 'open' ? 'pixels' : 'idle']);
    }
  });

  it('answers as fetch does: status, headers, Content-Length and body, request by request', async () => {
    const f = fixture(false);
    f.engine.hello({ protocol: PROTOCOL, version: '0.1.0' });
    assert.deepEqual(await f.channel.hello, { protocol: PROTOCOL, version: '0.1.0' });
    const first = f.channel.request('import', { paths: ['/a'], requestId: 'r' });
    const second = f.channel.request('progress');
    await f.settle();
    assert.deepEqual(f.requests().map(({ id, op, body }) => ({ id, op, body })), [{ id: 1, op: 'import', body: { paths: ['/a'], requestId: 'r' } }, { id: 2, op: 'progress', body: undefined }]);
    // Answers come in any order.
    f.engine.answer(2, { running: false });
    f.engine.answer(1, { error: 'No supported images' }, 422);
    const progress = await second, imported = await first;
    assert.deepEqual([progress.status, progress.ok, await progress.json()], [200, true, { running: false }]);
    assert.deepEqual([imported.status, imported.ok, imported.headers.get('Content-Type')], [422, false, 'application/json']);
    assert.equal(imported.headers.get('Content-Length'), String(JSON.stringify({ error: 'No supported images' }).length));
    assert.deepEqual(await imported.json(), { error: 'No supported images' });
  });

  it('passes raw bytes beside the call, and answers a status without a body', async () => {
    const f = fixture();
    const answered = f.channel.request('picture', { id: 3 }, { data: Buffer.from([1, 2, 3]) });
    await f.settle();
    assertFields(f.requests()[0], { op: 'picture', body: { id: 3 }, data: Buffer.from([1, 2, 3]) });
    f.engine.head(1, 0, 204);
    const response = await answered;
    assert.deepEqual([response.status, response.body], [204, null]);
  });

  it('reads split messages and grants one piece at a time as a pixel body is consumed', async () => {
    const f = fixture();
    const answered = f.channel.request('frame', { id: 's', index: 0 });
    const body = bytes(3 * MiB + 17);
    const head = encode(FROM_ENGINE.head, 1, Buffer.from(JSON.stringify({ status: 200, headers: { 'x-pixel-type': 'int16' }, length: body.length })));
    for (let at = 0; at < head.length; at++) f.fromEngine.write(head.subarray(at, at + 1));
    const response = await answered;
    assert.equal(response.headers.get('X-Pixel-Type'), 'int16');
    assert.deepEqual(f.of(TO_ENGINE.credit), []);
    const reading = response.arrayBuffer();
    for (let at = 0; at < body.length; at += MiB) {
      await f.settle();
      const piece = body.subarray(at, at + MiB);
      assert.equal(f.of(TO_ENGINE.credit).at(-1)?.credit, piece.length);
      const message = encode(FROM_ENGINE.data, 1, piece);
      for (let offset = 0; offset < message.length; offset += 65536) f.fromEngine.write(message.subarray(offset, offset + 65536));
    }
    assert.ok(Buffer.from(await reading).equals(body));
  });

  it('bounds all outstanding reads and reserves credit for control requests', async () => {
    const f = fixture();
    const answers = Array.from({ length: 12 }, () => f.channel.request('tags', { id: 's' }));
    for (const { id } of f.requests()) f.engine.head(id, 2 * MiB);
    const responses = await Promise.all(answers) as Response[];
    await f.settle();
    assert.deepEqual(f.of(TO_ENGINE.credit), [], 'no bytes for unread streams');
    const readers = responses.map(response => response.body!.getReader());
    const reads = readers.map(reader => reader.read());
    await f.settle();
    const credits = () => f.of(TO_ENGINE.credit).reduce((n, m) => n + m.credit!, 0);
    assert.equal(credits(), WINDOW - MiB);
    const control = f.channel.request('progress');
    f.engine.head(13, MiB);
    const controlRead = (await control).arrayBuffer();
    await f.settle();
    assert.equal(credits(), WINDOW);
    f.engine.data(13, bytes(MiB));
    assert.equal((await controlRead).byteLength, MiB);
    for (const reader of readers) await reader.cancel();
    await Promise.all(reads);
    assert.equal(f.channel.credit, 0);
  });

  it('bounds active volumes and lets frames through while volume readers are idle', async () => {
    const f = fixture();
    const abort = new AbortController();
    const volumes = Array.from({ length: 5 }, () => f.channel.request('volume', { id: 's' }, { signal: abort.signal }));
    const stopped = Promise.allSettled(volumes);
    assert.equal(f.requests().length, 4);
    const frame = f.channel.request('frame', { id: 's', index: 1 });
    f.engine.head(6, 0);
    assert.equal((await frame).status, 200);
    abort.abort();
    await stopped;
    assert.equal(f.requests().filter(r => r.id === 5).length, 0, 'a cancelled queued request never ran');
  });

  it('cancels an export still waiting for a local slot without sending it', async () => {
    const f = fixture();
    const other = Array.from({ length: 16 }, () => f.channel.request('tags'));
    const stopped = Promise.allSettled(other);
    const exporting = f.channel.request('export', { operation: 'queued' });
    const answer = await f.channel.request('exportCancel', { operation: 'queued' });
    assert.deepEqual(await answer.json(), { requested: true });
    assert.equal((await exporting).status, 422);
    assert.ok(f.requests().every(r => r.op === 'tags'));
    f.channel.close(new Error('done'));
    await stopped;
  });

  it('tells the engine when its caller gives up, before or during the answer, and drops what comes after', async () => {
    const f = fixture();
    const waiting = new AbortController(), reading = new AbortController();
    const before = f.channel.request('frame', { id: 's', index: 1 }, { signal: waiting.signal });
    const during = f.channel.request('volume', { id: 's' }, { signal: reading.signal });
    const consumer = f.channel.request('volume', { id: 't' });
    await f.settle();
    waiting.abort(new Error('paged on'));
    await assert.rejects(before, { message: /paged on/ });
    f.engine.head(2, 2 * MiB);
    const partial = await during;
    const partialRead = partial.arrayBuffer();
    await f.settle();
    f.engine.data(2, bytes(MiB));
    reading.abort(new Error('closed'));
    await assert.rejects(partialRead, { message: /closed/ });
    f.engine.head(3, MiB);
    await (await consumer).body!.cancel();
    await f.settle();
    assert.deepEqual(f.of(TO_ENGINE.cancel).map(message => message.id), [1, 2, 3]);
    // Late messages for cancelled requests are skipped; the next request is answered as usual.
    f.engine.head(1, 4); f.engine.data(1, bytes(4)); f.engine.data(2, bytes(MiB)); f.engine.end(3);
    const next = f.channel.request('progress');
    await f.settle();
    f.engine.answer(4, { running: true });
    assert.deepEqual(await (await next).json(), { running: true });
  });

  it('fails a body the engine ends short, and everything open when the engine stops', async () => {
    const f = fixture();
    const cut = f.channel.request('volume', { id: 's' });
    const waiting = f.channel.request('import', { paths: [] });
    await f.settle();
    f.engine.head(1, 2 * MiB);
    const response = await cut;
    const read = response.arrayBuffer();
    await f.settle();
    f.engine.data(1, bytes(MiB)); f.engine.end(1);
    await assert.rejects(read, { message: /stopped this answer/ });
    f.fromEngine.end();
    await assert.rejects(waiting, { message: /stopped/ });
    await assert.rejects(f.channel.request('series'), { message: /stopped/ });
    assert.equal((await f.channel.hello).protocol, PROTOCOL);
  });

  it('refuses an answer that claims more than it announced', async () => {
    const f = fixture();
    const answered = f.channel.request('frame', { id: 's', index: 0 });
    await f.settle();
    f.engine.head(1, 4);
    const response = await answered;
    f.engine.data(1, bytes(8));
    await assert.rejects(response.arrayBuffer(), { message: /length or credit/ });
    await f.settle();
    await assert.rejects(f.channel.request('health'), /length or credit/);
  });
  it('rejects DATA that fits the declared length but has no credit', async () => {
    const f = fixture();
    const call = f.channel.request('volume');
    f.engine.head(1, 4 * MiB);
    const answer = await call;
    f.engine.data(1, bytes(MiB));
    await assert.rejects(answer.arrayBuffer(), /length or credit/);
  });
  it('rejects malformed statuses even if constructing a Response already installed a controller', async () => {
    for (const status of [700, 204]) {
      const f = fixture();
      const call = f.channel.request('volume');
      f.engine.head(1, 1, status);
      await assert.rejects(call);
      assert.equal(f.channel.pending.size, 0);
    }
  });
});
