// Puts the Electron runtime where require('electron') looks for it. Electron's own downloader (@electron/get and an
// unzip package with a native binding) is overridden away in pnpm-workspace.yaml, so this script does that job: it
// fetches the zip from Electron's GitHub release, checks its SHA-256 against the checksums.json in the electron
// package from the lockfile, and unpacks it with the operating system's own tool. Checked zips are kept in the cache
// folder @electron/get used, and checked again before each use. Behind a proxy, set NODE_USE_ENV_PROXY=1 so Node's
// fetch uses HTTPS_PROXY.
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const packageDir = path.dirname(require.resolve('electron/package.json'));
const { version } = require('electron/package.json');
const executable = { darwin: 'Electron.app/Contents/MacOS/Electron', linux: 'electron', win32: 'electron.exe' }[process.platform];
const zipName = `electron-v${version}-${process.platform}-${process.arch}.zip`;
const release = `https://github.com/electron/electron/releases/download/v${version}`;

function installed() {
  const read = file => { try { return fs.readFileSync(path.join(packageDir, file), 'utf8'); } catch { return null; } };
  return read('dist/version')?.replace(/^v/, '') === version && read('path.txt') === executable
    && fs.existsSync(path.join(packageDir, 'dist', executable));
}

function cachedZip() {
  const home = os.homedir();
  const root = process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'electron')
    : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'electron', 'Cache')
    : path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'electron');
  // @electron/get names each folder for the SHA-256 of the release URL.
  return path.join(root, createHash('sha256').update(release).digest('hex'), zipName);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(zip, expected) {
  console.log(`Downloading Electron ${version} for ${process.platform}-${process.arch}.`);
  const response = await fetch(`${release}/${zipName}`);
  if (!response.ok) throw new Error(`Electron download failed: HTTP ${response.status} for ${response.url}`);
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  const partial = `${zip}.${process.pid}.partial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  const actual = await sha256(partial);
  if (actual !== expected) {
    fs.rmSync(partial, { force: true });
    throw new Error(`${zipName} has SHA-256 ${actual}; electron@${version}'s checksums.json expects ${expected}.`);
  }
  fs.renameSync(partial, zip);
}

function unpack(zip) {
  const dist = path.join(packageDir, 'dist'), staging = `${dist}.${process.pid}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging);
  const [command, args] = process.platform === 'darwin' ? ['ditto', ['-x', '-k', zip, staging]]
    : process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', staging]]
    : ['unzip', ['-q', zip, '-d', staging]];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} could not unpack ${zip}${result.error ? `: ${result.error.message}` : ''}`);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.renameSync(staging, dist);
  // As Electron's installer does, type definitions in the zip replace the package's.
  if (fs.existsSync(path.join(dist, 'electron.d.ts'))) fs.renameSync(path.join(dist, 'electron.d.ts'), path.join(packageDir, 'electron.d.ts'));
  fs.writeFileSync(path.join(packageDir, 'path.txt'), executable);
}

async function main() {
  if (!executable) throw new Error(`Electron has no build for ${process.platform}.`);
  if (!installed()) {
    const expected = require('electron/checksums.json')[zipName];
    if (!expected) throw new Error(`electron@${version} lists no ${zipName} in its checksums.json.`);
    const zip = cachedZip();
    if (!fs.existsSync(zip) || await sha256(zip) !== expected) await download(zip, expected);
    unpack(zip);
  }
  const electron = require('electron');
  if (!fs.existsSync(electron)) throw new Error('Electron runtime is missing.');
  console.log(`Desktop runtime ready for ${process.platform}/${process.arch}.`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
