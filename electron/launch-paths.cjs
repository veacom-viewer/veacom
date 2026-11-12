'use strict';
const path = require('node:path');

// What a launch asks VEAcom to open. `--study <path>` names it outright, as the Explorer entries the installer adds
// do ("Open with VEAcom" on a folder, a drive, a ZIP or a DICOMDIR). An installed app also takes paths given as
// arguments of their own, as Windows passes them for "Open with" on a file and for files dropped on the program's
// icon. A source run takes only `--study`: its own arguments (the app folder, Electron's switches) are not studies.

/** A path as it was meant: Windows parses `"E:\"` (a drive in quotes) as `E:"`, and a path can arrive still quoted. */
function unquoted(text) {
  const drive = /^([A-Za-z]:)"$/.exec(text);
  if (drive) return `${drive[1]}\\`;
  return text.replace(/^"+|"+$/g, '');
}

/**
 * The paths a launch names, absolute, in the order given and without repeats.
 * - `argv`: the launch's arguments, the program first (`process.argv`, or a second launch's `argv`).
 * - `packaged`: an installed app; only then are bare arguments read as paths.
 * - `cwd`: the folder relative paths are read from.
 * - `isFile`: tells whether a path is a file. A file named DICOMDIR stands for the disc it indexes: its folder opens.
 */
function launchPaths(argv, { packaged = false, cwd = process.cwd(), isFile = () => false } = {}) {
  const args = Array.isArray(argv) ? argv.slice(1).filter(arg => typeof arg === 'string') : [];
  const named = [];
  const flag = args.indexOf('--study');
  if (flag >= 0) {
    const value = args[flag + 1];
    if (value && !value.startsWith('--')) named.push(value);
  } else if (packaged) {
    named.push(...args.filter(arg => arg && !arg.startsWith('-')));
  }
  const paths = [];
  for (const given of named) {
    const text = unquoted(given);
    if (!text) continue;
    let resolved = path.resolve(cwd, text);
    if (path.basename(resolved).toUpperCase() === 'DICOMDIR' && isFile(resolved)) resolved = path.dirname(resolved);
    if (!paths.includes(resolved)) paths.push(resolved);
  }
  return paths;
}

module.exports = { launchPaths };
