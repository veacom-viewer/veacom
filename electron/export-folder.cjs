'use strict';
// Where exports go, as VEAcom 1.x kept it: one folder, chosen once and remembered (the Desktop at first), so
// exporting writes there without asking again. Only this module's choice is ever written to: the renderer never
// passes a path.
const fs = require('node:fs/promises');
const path = require('node:path');

function createExportFolder({ app, dialog, getWindow, t }) {
  const file = path.join(app.getPath('userData'), 'export-folder.json');
  let current = null;
  const usable = async folder => typeof folder === 'string' && folder.length > 0
    && await fs.stat(folder).then(stat => stat.isDirectory(), () => false);
  async function folder() {
    if (current && await usable(current)) return current;
    try {
      const saved = JSON.parse(await fs.readFile(file, 'utf8')).folder;
      if (await usable(saved)) return (current = saved);
    } catch { /* first use, or the folder has gone: the Desktop */ }
    return (current = app.getPath('desktop'));
  }
  async function choose() {
    const selected = await dialog.showOpenDialog(getWindow(), { title: t('dialog.exportFolder'), defaultPath: await folder(), properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    current = selected.filePaths[0];
    await fs.writeFile(file, JSON.stringify({ folder: current })).catch(() => {});
    return current;
  }
  /** A free name in the folder: "name.ext", else "name (2).ext" and so on; nothing is overwritten. */
  async function freePath(name, extension = '') {
    const base = await folder();
    let candidate = path.join(base, `${name}${extension}`);
    for (let n = 2; await fs.stat(candidate).then(() => true, () => false); n++) candidate = path.join(base, `${name} (${n})${extension}`);
    return candidate;
  }
  /** True for a path inside the export folder (what "open the folder" may show). */
  async function holds(target) {
    if (typeof target !== 'string' || !target) return false;
    const relative = path.relative(await folder(), target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
  return { folder, choose, freePath, holds };
}

module.exports = { createExportFolder };
