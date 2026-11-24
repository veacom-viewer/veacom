// The landmark model's two graphs for the deformity kit's suggestions (docs/landmark-model.md). The first time the
// reader asks, each is downloaded from the GitHub release named in landmark-model.json, only through the release
// download path and GitHub's file hosts (updates.cjs responseFor), checked against its size and SHA-256, and kept in
// userData/landmark-model under its hash. A kept file is checked again before use. The request for the file is all
// that is sent: the film never leaves the computer.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const defaultManifest = require('./landmark-model.json');
const { responseFor } = require('./updates.cjs');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function createLandmarkModel({ userData, fetchImpl = globalThis.fetch, notify = () => {}, manifest = defaultManifest }) {
  const folder = path.join(userData, 'landmark-model');
  let controller = new AbortController();
  const pending = new Map();

  async function kept(entry) {
    // No kept file, or one that cannot be read or does not match: it is downloaded again.
    const bytes = await fs.readFile(path.join(folder, `${entry.sha256}.onnx`)).catch(() => null);
    return bytes && bytes.length === entry.bytes && sha256(bytes) === entry.sha256 ? bytes : null;
  }

  async function download(part, entry, signal) {
    const response = await responseFor(manifest.release + entry.file, { fetchImpl, signal });
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > entry.bytes) throw new Error('The model file is larger than expected.');
      chunks.push(Buffer.from(chunk));
      notify(part, received);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error('checksum');
    // Written beside its place and renamed into it, so a half-written file is never kept. A folder that cannot be
    // written (full, read-only) costs a download next time; the checked bytes are used now.
    const target = path.join(folder, `${entry.sha256}.onnx`), partial = `${target}.${process.pid}.part`;
    try {
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(partial, bytes, { mode: 0o600 });
      await fs.rename(partial, target);
    } catch (error) {
      await fs.rm(partial, { force: true }).catch(() => {});
      process.stderr.write(`The landmark model was not kept: ${error.message}\n`);
    }
    return bytes;
  }

  return {
    /** The graph `part` ('stageA' or 'stageB'), kept or downloaded. */
    get(part) {
      if (typeof part !== 'string' || !Object.hasOwn(manifest.files, part)) return Promise.reject(new Error('Unknown model file.'));
      if (pending.has(part)) return pending.get(part);
      const entry = manifest.files[part], signal = controller.signal;
      const result = kept(entry).then(bytes => bytes ?? download(part, entry, signal)).finally(() => { if (pending.get(part) === result) pending.delete(part); });
      pending.set(part, result);
      return result;
    },
    /** Stops the downloads under way; the next request starts again rather than joining a stopped one. */
    cancel() { controller.abort(); controller = new AbortController(); pending.clear(); },
  };
}

function registerLandmarkModel({ handle, userData, getWindow }) {
  const model = createLandmarkModel({ userData, notify: (part, received) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('landmarks:progress', part, received);
  } });
  handle('landmarks:model', part => model.get(part));
  handle('landmarks:cancel', () => model.cancel());
}

module.exports = { createLandmarkModel, registerLandmarkModel };
