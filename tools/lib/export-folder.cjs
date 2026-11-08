// Exports go to the remembered export folder (electron/export-folder.cjs), which starts as the real Desktop. A check
// that can export points it at a folder inside its temporary profile before the app starts, so a run leaves nothing
// behind and its files can be found.
const fs = require('node:fs/promises');
const path = require('node:path');

/** Makes `<userData>/exports` the export folder of the profile `userData`; returns its path. */
async function temporaryExportFolder(userData) {
  const folder = path.join(userData, 'exports');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(userData, 'export-folder.json'), JSON.stringify({ folder }));
  return folder;
}

module.exports = { temporaryExportFolder };
