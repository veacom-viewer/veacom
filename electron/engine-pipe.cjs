'use strict';
// One private connection to the child. Wire format and limits match native/src/pipe.rs.
const FROM_ENGINE = { hello: 0, head: 1, data: 2, end: 3 };
const TO_ENGINE = { request: 1, credit: 2, cancel: 3 };
const PROTOCOL = 2, HEADER = 9;
const CHUNK = 1024 * 1024, INLINE = 16 * 1024, WINDOW = 8 * CHUNK;
const MAX_REQUEST = 16 * CHUNK, MAX_QUEUED = 32;
const controlOps = new Set(['shutdown', 'progress', 'cancel', 'exportCancel', 'health', 'processCounters']);

function workCategory(op) {
  // pictureNext waits even on an idle viewer; importEarly polls the catalog during an import.
  if (controlOps.has(op) || op === 'pictureNext' || op === 'importEarly') return null;
  switch (op) {
    case 'import': return 'import';
    case 'volume': case 'frame': case 'warm': case 'sample': case 'measure': case 'pictureAnswer': return 'pixels';
    case 'export': case 'exportEstimate': return 'export';
    default: return 'other';
  }
}

function encodeRequest(op, body, data) {
  const json = Buffer.from(JSON.stringify(body === undefined ? { op } : { op, body }));
  const length = 4 + json.length + (data?.length ?? 0);
  if (length > MAX_REQUEST) throw new Error('Engine request too large.');
  const payload = Buffer.allocUnsafe(length);
  payload.writeUInt32LE(json.length);
  json.copy(payload, 4);
  if (data) payload.set(data, 4 + json.length);
  return payload;
}
function decodeRequest(payload) {
  const length = payload.readUInt32LE(0);
  return { ...JSON.parse(payload.subarray(4, 4 + length).toString('utf8')), data: payload.subarray(4 + length) };
}
function encode(kind, id, payload = Buffer.alloc(0)) {
  const message = Buffer.allocUnsafe(HEADER + payload.length);
  message[0] = kind;
  message.writeUInt32LE(id, 1);
  message.writeUInt32LE(payload.length, 5);
  message.set(payload, HEADER);
  return message;
}
function responseLimit(kind) {
  switch (kind) {
    case FROM_ENGINE.hello: case FROM_ENGINE.head: return 64 * 1024;
    case FROM_ENGINE.data: return CHUNK;
    case FROM_ENGINE.end: return 0;
    default: throw new Error('Unknown imaging engine message.');
  }
}

class MessageReader {
  constructor(onMessage, limit = () => MAX_REQUEST) {
    this.onMessage = onMessage; this.limit = limit;
    this.header = Buffer.alloc(HEADER); this.fill = 0; this.payload = null; this.got = 0;
  }
  push(chunk) {
    let at = 0;
    while (at < chunk.length) {
      if (this.fill < HEADER) {
        const n = Math.min(HEADER - this.fill, chunk.length - at);
        chunk.copy(this.header, this.fill, at, at + n);
        this.fill += n; at += n;
        if (this.fill < HEADER) return;
        const length = this.header.readUInt32LE(5);
        if (length > this.limit(this.header[0])) throw new Error('The imaging engine sent a message that is too long.');
        if (chunk.length - at >= length) {
          this.fill = 0;
          this.onMessage(this.header[0], this.header.readUInt32LE(1), chunk.subarray(at, at + length));
          at += length; continue;
        }
        this.payload = Buffer.allocUnsafe(length); this.got = 0;
      }
      const n = Math.min(this.payload.length - this.got, chunk.length - at);
      chunk.copy(this.payload, this.got, at, at + n);
      this.got += n; at += n;
      if (this.got === this.payload.length) {
        const payload = this.payload;
        this.fill = 0; this.payload = null;
        this.onMessage(this.header[0], this.header.readUInt32LE(1), payload);
      }
    }
  }
}

class EngineChannel {
  constructor(input, output, { stopped = () => new Error('The imaging engine stopped.'), onFailure } = {}) {
    this.output = output; this.onFailure = onFailure;
    this.pending = new Map();
    this.nextId = 0; this.requestBytes = 0; this.credit = 0;
    this.groups = Object.fromEntries(Object.entries({ volume: 4, frame: 4, control: 8, picture: 8, other: 16 })
      .map(([name, limit]) => [name, { name, limit, active: 0, waiting: new Set() }]));
    this.readers = new Set();
    this.failure = null; this.ready = false;
    this.hello = new Promise((resolve, reject) => { this.helloSettled = { resolve, reject }; });
    this.hello.catch(() => {});
    this.reader = new MessageReader((kind, id, payload) => this.message(kind, id, payload), responseLimit);
    input.on('data', chunk => {
      if (!this.failure) try { this.reader.push(chunk); } catch (error) { this.close(error); }
    });
    input.on('end', () => this.close(stopped(), 'pipe-closed'));
    input.on('error', error => this.close(error, 'pipe-error'));
    output.on('error', error => this.close(error, 'pipe-error'));
  }
  async request(op, body, { signal, data } = {}) {
    if (this.failure) throw this.failure;
    signal?.throwIfAborted();
    if (op === 'exportCancel' && body?.operation) {
      const queued = [...this.pending.values()].find(e => !e.sent && e.exportId === body.operation);
      if (queued) {
        const error = 'Export cancelled; nothing was kept';
        queued.resolve(Response.json({ error, note: { code: 'export.cancelled', text: error } }, { status: 422 }));
        this.finish(queued);
        return Response.json({ requested: true });
      }
    }
    let group = this.groups.other;
    if (op === 'volume' || op === 'frame') group = this.groups[op];
    else if (op === 'pictureNext' || op === 'pictureAnswer') group = this.groups.picture;
    else if (controlOps.has(op)) group = this.groups.control;
    const payload = encodeRequest(op, body, data);
    // A catalog or frame request can be waiting for the decoder. Leave room for its polls and answers.
    const byteLimit = (group === this.groups.picture ? 3 : 2) * MAX_REQUEST;
    // Admission lasts through the final body byte or cancellation. One slow volume cannot occupy a frame/control slot.
    if (group.waiting.size >= MAX_QUEUED || (group.name !== 'control' &&
        this.requestBytes + this.output.writableLength + payload.length > byteLimit)) {
      return Response.json({ error: 'Imaging engine is busy' }, { status: 503 });
    }
    do { this.nextId = this.nextId === 0xffffffff ? 1 : this.nextId + 1; } while (this.pending.has(this.nextId));
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      const entry = { id, group, work: workCategory(op), payload, size: payload.length, signal, resolve, reject, sent: false,
        exportId: op === 'export' ? body?.operation : undefined, controller: null, length: 0, received: 0, credit: 0, pulled: null };
      this.pending.set(id, entry);
      this.requestBytes += entry.size;
      group.waiting.add(entry);
      if (signal) {
        entry.onAbort = () => this.abandon(entry, signal.reason);
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.dispatch(group);
    });
  }
  dispatch(group) {
    for (const entry of group.waiting) {
      if (this.failure || group.active >= group.limit) break;
      if (entry.signal?.aborted) continue; // Its abort listener may be next on the same signal.
      group.waiting.delete(entry);
      group.active++;
      entry.sent = true;
      this.send(TO_ENGINE.request, entry.id, entry.payload);
      entry.payload = null;
    }
  }
  send(kind, id, payload) {
    if (!this.failure) try { this.output.write(encode(kind, id, payload)); } catch (error) {
      this.close(error, 'pipe-error', kind === TO_ENGINE.request ? id : undefined);
    }
  }
  message(kind, id, payload) {
    if (kind === FROM_ENGINE.hello) {
      if (this.ready || id !== 0) throw new Error('Invalid imaging engine handshake.');
      const hello = JSON.parse(payload.toString('utf8'));
      this.ready = true;
      this.helloSettled.resolve(hello);
      return;
    }
    if (!this.ready) throw new Error('Missing imaging engine handshake.');
    const entry = this.pending.get(id);
    if (!entry) return; // A late reply after local cancellation.
    if (!entry.sent) throw new Error('Unexpected imaging engine request ID.');
    if (kind === FROM_ENGINE.head) this.head(entry, payload);
    else if (kind === FROM_ENGINE.data) this.piece(entry, payload);
    else this.fail(entry, new Error('The imaging engine stopped this answer.'));
  }
  head(entry, payload) {
    const head = JSON.parse(payload.toString('utf8'));
    if (entry.controller || !Number.isSafeInteger(head?.length) || head.length < 0 ||
        !Number.isInteger(head.status) || head.status < 200 || head.status > 599) throw new Error('Invalid imaging engine answer.');
    const headers = new Headers(head.headers);
    headers.set('Content-Length', String(head.length));
    entry.length = head.length;
    if (entry.length === 0) {
      const noBody = [204, 205, 304].includes(head.status);
      entry.resolve(new Response(noBody ? null : new Uint8Array(0), { status: head.status, headers }));
      this.finish(entry);
      return;
    }
    const inline = entry.inline = headers.get('content-type') === 'application/json' && entry.length <= INLINE;
    // Zero high-water mark: pixel bytes enter main only when a consumer is waiting for them. Each pending read
    // grants one chunk. Small JSON replies may arrive with their heads, including the shutdown acknowledgement.
    const stream = new ReadableStream({
      start: controller => { entry.controller = controller; },
      pull: inline ? undefined : () => new Promise(done => {
        entry.pulled = done;
        this.readers.add(entry);
        this.grant();
      }),
      cancel: reason => this.abandon(entry, reason),
    }, { highWaterMark: 0 });
    entry.resolve(new Response(stream, { status: head.status, headers }));
  }
  grant() {
    for (const entry of this.readers) {
      const limit = entry.group.name === 'control' ? WINDOW : WINDOW - CHUNK;
      const bytes = Math.min(CHUNK, entry.length - entry.received);
      if (this.credit + bytes > limit) continue;
      this.readers.delete(entry);
      entry.credit = bytes;
      this.credit += bytes;
      const credit = Buffer.allocUnsafe(4);
      credit.writeUInt32LE(bytes);
      this.send(TO_ENGINE.credit, entry.id, credit);
    }
  }
  piece(entry, piece) {
    if (!entry.controller || !piece.length || entry.received + piece.length > entry.length ||
        (!entry.inline && piece.length !== entry.credit)) throw new Error('The imaging engine exceeded its body length or credit.');
    entry.received += piece.length;
    entry.controller.enqueue(piece);
    this.releaseRead(entry);
    if (entry.received === entry.length) {
      entry.controller.close();
      this.finish(entry);
    } else this.grant();
  }
  releaseRead(entry) {
    this.readers.delete(entry);
    this.credit -= entry.credit;
    entry.credit = 0;
    entry.pulled?.();
    entry.pulled = null;
  }
  abandon(entry, reason) {
    if (!this.pending.has(entry.id)) return;
    if (entry.sent) this.send(TO_ENGINE.cancel, entry.id);
    this.fail(entry, reason);
  }
  fail(entry, error) {
    entry.reject(error);
    entry.controller?.error(error);
    this.finish(entry);
  }
  finish(entry) {
    if (!this.pending.delete(entry.id)) return;
    this.releaseRead(entry);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    this.requestBytes -= entry.size;
    if (entry.sent) entry.group.active--;
    else entry.group.waiting.delete(entry);
    if (!this.failure) {
      this.dispatch(entry.group);
      this.grant();
    }
  }
  close(error, reason = 'protocol-error', unsentId) {
    if (this.failure) return;
    this.failure = error;
    this.helloSettled.reject(error);
    const active = new Set();
    for (const entry of this.pending.values()) {
      if (entry.sent && entry.id !== unsentId && entry.work) active.add(entry.work);
      this.fail(entry, error);
    }
    const work = active.size > 1 ? 'multiple' : active.values().next().value ?? 'idle';
    this.onFailure?.(error, reason, work);
  }
}

module.exports = { EngineChannel, MessageReader, encode, encodeRequest, decodeRequest, FROM_ENGINE, TO_ENGINE, PROTOCOL, WINDOW, CHUNK, INLINE, HEADER };
