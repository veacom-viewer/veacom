const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { t, coreErrorText } = require('./i18n.cjs');
const { classifySource } = require('./usage.cjs');

const pixelHeaders = ['Content-Type', 'Content-Length', 'Cache-Control', 'X-Pixel-Type', 'X-Components',
  'X-Source-Frame-Index', 'X-SOP-Instance-UID', 'X-Source-Frame-Number'];

class ImagingBroker {
  // The engine is reached only through engine.connection().request (its pipes, engine-pipe.cjs), which answers with a
  // Response whose body streams as the engine sends it.
  constructor({ engine, realpath = fs.realpath, now = Date.now, devOrigin, beforePixel, afterImport, preparePictures }) {
    Object.assign(this, { engine, realpath, now, devOrigin, beforePixel, afterImport, preparePictures });
    this.imports = new Map(); this.activeImports = new Map(); this.pixels = new Map(); this.series = new Map();
    this.prefetched = new Map();
    this.epoch = new AbortController();
    this.generation = engine.state().generation;
    this.stateChanged = state => {
      if (state.status !== 'ready' || state.generation !== this.generation) {
        this.epoch.abort(new Error(t('broker.restarted')));
        this.epoch = new AbortController(); this.activeImports.clear(); this.pixels.clear(); this.series.clear(); this.prefetched.clear();
      }
      this.generation = state.generation;
    };
    engine.on('state', this.stateChanged);
  }
  dispose() { this.epoch.abort(); this.imports.clear(); this.activeImports.clear(); this.pixels.clear(); this.series.clear(); this.prefetched.clear(); this.engine.off('state', this.stateChanged); }
  async authorizeImportPaths(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 4096 || paths.some(value => typeof value !== 'string' || !path.isAbsolute(value))) throw new Error('Invalid selected files.');
    const selected = [...new Set(await Promise.all(paths.map(value => this.realpath(value))))];
    this.expire(this.imports);
    if (this.imports.size + selected.length > 4096) throw new Error(t('broker.tooManySelections'));
    this.preparePictures?.(selected);
    return selected.map(value => {
      const capability = `import:${randomUUID()}`;
      this.imports.set(capability, { path: value, expires: this.now() + 10 * 60_000 });
      return capability;
    });
  }
  expire(entries) { for (const [key, value] of entries) if (value.expires <= this.now()) entries.delete(key); }
  async requestJson(op, body, generation) {
    const connection = this.engine.connection(generation), epoch = this.epoch;
    const response = await connection.request(op, body, { signal: epoch.signal });
    epoch.signal.throwIfAborted();
    // The engine answers { error, note }: show its message, translated, not the JSON.
    if (!response.ok) throw new Error(coreErrorText(await response.text()));
    const value = await response.json(); epoch.signal.throwIfAborted(); this.engine.connection(connection.generation);
    return { value, generation: connection.generation };
  }
  catalog(result) {
    const series = result.value.series.map(value => ({ ...value, engineGeneration: result.generation }));
    for (const value of series) {
      const previous = this.series.get(value.id);
      if (previous?.catalogRevision > value.catalogRevision) continue;
      if (previous && previous.catalogRevision !== value.catalogRevision) this.revokePixels(value.id);
      this.series.set(value.id, value);
    }
    return { ...result.value, series };
  }
  revokePixels(seriesId) {
    for (const [nonce, entry] of this.pixels) if (entry.seriesId === seriesId) this.pixels.delete(nonce);
  }
  async listSeries() { return this.catalog(await this.requestJson('series')); }
  // Starts a launch-time import (a study given on the command line) while the window is still loading, and
  // has the engine decode its first series, which the viewer opens first. The window's own request for the
  // same capabilities then receives this result instead of importing again.
  prefetchImport(capabilities) {
    const pending = this.importSelected(capabilities);
    this.prefetched.set(importKey(capabilities), pending);
    pending.then(result => {
      // The series the viewer opens first: a segmentation is drawn over another series and is not opened itself.
      const first = result.series.find(series => !series.segmentation && series.dimensions[2] > 0);
      if (first) this.requestJson('warm', { id: first.id }, first.engineGeneration).catch(() => {});
    }, () => {});
  }
  async importSelected(capabilities) {
    if (Array.isArray(capabilities)) {
      const key = importKey(capabilities), pending = this.prefetched.get(key);
      if (pending) { this.prefetched.delete(key); return pending; }
    }
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.length > 4096 || capabilities.some(value => typeof value !== 'string')) throw new Error('Choose files through Open study or drop local files.');
    this.expire(this.imports);
    const unique = [...new Set(capabilities)], paths = unique.map(value => this.imports.get(value)?.path);
    if (paths.some(value => !value)) throw new Error('This file selection is invalid or expired. Choose it again.');
    for (const value of unique) this.imports.delete(value);
    const key = importKey(capabilities), requestId = randomUUID();
    this.activeImports.set(key, requestId);
    try {
      const result = this.catalog(await this.requestJson('import', { paths, requestId }));
      this.afterImport?.(paths, result);
      // Where the study came from (disk, disc, archive, network) for usage timings; the path stays here.
      return { ...result, source: classifySource(paths) };
    } finally { this.activeImports.delete(key); }
  }
  requireSeries(id, generation) {
    if (typeof id !== 'string' || !id || id.length > 1024 || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid series request.');
    this.engine.connection(generation);
    const series = this.series.get(id);
    if (!series || series.engineGeneration !== generation) throw new Error(t('broker.seriesNotOpen'));
    return series;
  }
  /** Series taken off the list: the engine forgets them and frees their memory. Only series this
   * broker handed out, from the given engine generation, can be named. */
  async removeSeries(ids, generation) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100_000 || ids.some(id => typeof id !== 'string' || !id || id.length > 1024)
      || !Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid series request.');
    const known = [...new Set(ids)].filter(id => this.series.get(id)?.engineGeneration === generation);
    if (!known.length) return { removed: 0 };
    const result = (await this.requestJson('removeSeries', { ids: known }, generation)).value;
    for (const id of known) { this.series.delete(id); this.revokePixels(id); }
    return result;
  }
  async getProgress() { return (await this.requestJson('progress')).value; }
  /** The series this selection's import has published, from the `after`th on (the engine's importEarly).
   * They are registered like a catalogue's, so their frames can be asked for before the import ends. */
  async importEarly(capabilities, after) {
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.length > 4096 || capabilities.some(value => typeof value !== 'string')) throw new Error('Invalid request.');
    if (!Number.isSafeInteger(after) || after < 0 || after > 100_000) throw new Error('Invalid request.');
    const key = importKey(capabilities), requestId = this.activeImports.get(key);
    if (!requestId) return { import: 0, series: [] };
    const result = await this.requestJson('importEarly', { after, requestId });
    // A late preview must not overwrite the final catalogue or revive a failed import.
    if (this.activeImports.get(key) !== requestId) return { import: result.value.import, series: [] };
    return { import: result.value.import, series: this.catalog({ value: { series: result.value.series }, generation: result.generation }).series };
  }
  /** Cancels the engine job `id` names (from getProgress): what the progress bar showed, not a job begun since. */
  async cancelOperation(id) {
    if (id !== undefined && (!Number.isSafeInteger(id) || id < 0)) throw new Error('Invalid operation.');
    return (await this.requestJson('cancel', id === undefined ? undefined : { id })).value;
  }
  async getTags(id, generation, frame, revision) {
    const series = this.requireSeries(id, generation);
    if (revision !== undefined && series.catalogRevision !== revision) throw new Error(t('broker.seriesNotOpen'));
    if (frame !== undefined && (!Number.isSafeInteger(frame) || frame < 0)) throw new Error('Invalid frame.');
    const result = await this.requestJson('tags', { id, frame, revision: series.catalogRevision }, generation);
    if (this.requireSeries(id, generation).catalogRevision !== series.catalogRevision) throw new Error(t('broker.seriesNotOpen'));
    return result.value;
  }
  async measure(id, generation, revision, operation) {
    const series = this.requireSeries(id, generation);
    if (!Number.isSafeInteger(revision) || revision < 1 || series.sourceRevision !== revision) throw new Error('Source series changed.');
    if (!operation || !['sourceRegion', 'window'].includes(operation.kind)) throw new Error('Invalid sampling operation.');
    if (operation.kind === 'sourceRegion' && (!Array.isArray(operation.points) || operation.points.length > 10_000)) throw new Error('Invalid region points.');
    if (JSON.stringify(operation).length > 512 * 1024) throw new Error('Measurement request is too large.');
    return (await this.requestJson('sample', { id, sourceRevision: revision, operation }, generation)).value;
  }
  /** Lays `movingId` over `fixedId` (the engine's register): two different series this broker handed out, from one
   * engine generation, at the source revisions the page shows. Answers the rigid transform and how well they match. */
  async register(request) {
    const keys = ['fixedId', 'movingId', 'generation', 'fixedRevision', 'movingRevision'];
    if (!request || typeof request !== 'object' || Object.keys(request).some(key => !keys.includes(key))) throw new Error('Invalid registration request.');
    const { fixedId, movingId, generation, fixedRevision, movingRevision } = request;
    const fixed = this.requireSeries(fixedId, generation), moving = this.requireSeries(movingId, generation);
    if (fixedId === movingId) throw new Error('Invalid registration request.');
    for (const [series, revision] of [[fixed, fixedRevision], [moving, movingRevision]]) {
      if (!Number.isSafeInteger(revision) || revision < 1 || series.sourceRevision !== revision) throw new Error('Source series changed.');
    }
    const result = (await this.requestJson('register', { fixedId, movingId, fixedRevision, movingRevision }, generation)).value;
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    if (!result || !Array.isArray(result.matrix) || result.matrix.length !== 16 || !result.matrix.every(finite)
      || !['similarity', 'similarityBefore', 'overlap', 'angle'].every(key => finite(result[key]))) throw new Error('Invalid registration result.');
    return result;
  }
  getPixels(request) {
    if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['seriesId', 'generation', 'index', 'revision'].includes(key))) throw new Error('Invalid pixel request.');
    const series = this.requireSeries(request.seriesId, request.generation);
    if (request.revision !== undefined && series.catalogRevision !== request.revision) throw new Error(t('broker.seriesNotOpen'));
    const frame = request.index !== undefined;
    if (frame && (!Number.isSafeInteger(request.index) || request.index < 0 || request.index >= series.dimensions[2])) throw new Error('Source frame index is out of range.');
    this.expire(this.pixels);
    if (this.pixels.size >= 512) throw new Error(t('broker.tooManyImages'));
    const nonce = randomUUID(), kind = frame ? 'frame' : 'volume';
    this.pixels.set(nonce, { kind, index: request.index, seriesId: request.seriesId, generation: request.generation, expires: this.now() + 60_000,
      body: { id: request.seriesId, ...(frame ? { index: request.index } : {}), ...(series.catalogRevision === undefined ? {} : { revision: series.catalogRevision }) } });
    return { url: `veacom://app/_imaging/${kind}/${nonce}`, generation: request.generation };
  }
  async pixelResponse(request) {
    const url = new URL(request.url), origin = request.headers.get('Origin');
    const allowedOrigin = !origin || origin === 'veacom://app' || (this.devOrigin && origin === this.devOrigin);
    const match = /^\/_imaging\/(frame|volume)\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (request.method !== 'GET' || url.protocol !== 'veacom:' || url.host !== 'app' || url.search || url.hash || !allowedOrigin || !match) return new Response('Forbidden', { status: 403 });
    this.expire(this.pixels);
    const entry = this.pixels.get(match[2]);
    if (!entry || entry.kind !== match[1]) return new Response('Image request expired', { status: 404 });
    this.pixels.delete(match[2]);
    try {
      const connection = this.engine.connection(entry.generation);
      const signal = AbortSignal.any([request.signal, this.epoch.signal]);
      if (this.beforePixel) await this.beforePixel(entry, signal);
      signal.throwIfAborted();
      const current = () => this.series.get(entry.seriesId)?.catalogRevision === entry.body.revision && this.series.has(entry.seriesId);
      if (!current()) return new Response('Series replaced', { status: 409 });
      const response = await connection.request(entry.kind, entry.body, { signal });
      if (!current()) { await response.body?.cancel(); return new Response('Series replaced', { status: 409 }); }
      signal.throwIfAborted(); this.engine.connection(entry.generation);
      const headers = new Headers();
      for (const key of pixelHeaders) if (response.headers.has(key)) headers.set(key, response.headers.get(key));
      headers.set('Cache-Control', 'no-store');
      if (origin === this.devOrigin) headers.set('Access-Control-Allow-Origin', origin);
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return new Response('The image request was interrupted. Reopen this study if the engine restarted.', { status: 503 });
    }
  }
}

function importKey(capabilities) { return [...new Set(capabilities)].sort().join('\n'); }

function validateApplicationSender(event, window, devOrigin) {
  if (!window || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted application frame.');
  const url = new URL(event.senderFrame.url);
  if (!(url.protocol === 'veacom:' && url.host === 'app') && !(devOrigin && url.origin === devOrigin)) throw new Error('Untrusted application origin.');
}

module.exports = { ImagingBroker, validateApplicationSender };
