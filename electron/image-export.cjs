'use strict';
// A series exported as pictures (src/export-video.ts, exportViewportImages): a folder is chosen once, a subfolder
// named after the patient and series is made in it, and each slice the viewer captured is written there as a PNG
// or JPEG file, as VEAcom Next exports them.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_PICTURE_BYTES = 64 * 1024 * 1024;
// A slice number, after an optional prefix of letters, digits, spaces, dots, dashes or underscores (no path).
const NAME = /^[\p{L}\p{N} _.-]{0,40}?\d{1,6}\.(png|jpg)$/u;
/** A folder name from the patient and series: no path separators or characters Windows refuses, at most 80 long. */
const folderName = value => (String(value || 'VEAcom').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'VEAcom').slice(0, 80);

function registerImageExport({ handle, dialog, getWindow, t, exportFolder, recordExport, sweepFolder }) {
  const jobs = new Map();
  // An export that does not finish takes away what it wrote, and its folder once empty (the folder is its own: a
  // fresh name was found for it). No folder named after the patient and series is left looking like a full export.
  const discard = async job => {
    await Promise.all([...job.written].map(name => fs.rm(path.join(job.directory, name), { force: true }).catch(() => {})));
    await fs.rmdir(job.directory).catch(() => {});
  };
  handle('images:begin', async (suggestedName, here) => {
    // Into the remembered export folder, or (asked for) a folder chosen now.
    let parent;
    if (here === true && exportFolder) parent = await exportFolder.folder();
    else {
      const selected = await dialog.showOpenDialog(getWindow(), { title: t('dialog.exportFolder'), properties: ['openDirectory', 'createDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) return null;
      parent = selected.filePaths[0];
    }
    sweepFolder?.(parent);
    const base = folderName(suggestedName);
    let directory = path.join(parent, base);
    // An earlier export of the same series is not overwritten: the new one gets a number.
    for (let n = 2; await fs.stat(directory).then(() => true, () => false); n++) directory = path.join(parent, `${base} (${n})`);
    await fs.mkdir(directory, { recursive: true });
    const id = randomUUID();
    jobs.set(id, { directory, written: new Set() });
    return { id, directory };
  });
  handle('images:append', async (id, name, data) => {
    const job = jobs.get(id);
    if (!job) throw new Error('Unknown picture export.');
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Invalid picture name.');
    if (!(data instanceof ArrayBuffer || ArrayBuffer.isView(data)) || data.byteLength > MAX_PICTURE_BYTES) throw new Error('Invalid picture.');
    job.written.add(name);
    try {
      const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      await fs.writeFile(path.join(job.directory, name), bytes);
    } catch (error) {
      if (jobs.get(id) === job) throw error;
    }
    // Cancelled while this picture was being written: it goes too.
    if (jobs.get(id) !== job) { await discard(job); throw new Error('Unknown picture export.'); }
  });
  handle('images:finish', id => {
    const job = jobs.get(id);
    jobs.delete(id);
    if (!job) throw new Error('Unknown picture export.');
    recordExport?.(job.directory);
    return job.directory;
  });
  handle('images:cancel', async id => {
    const job = jobs.get(id);
    jobs.delete(id);
    if (job) await discard(job);
  });
  return {
    /** The page that started the exports is gone (it crashed or reloaded): what they wrote goes. */
    reset: async () => { const open = [...jobs.values()]; jobs.clear(); await Promise.all(open.map(discard)); },
  };
}

module.exports = { registerImageExport, folderName };
