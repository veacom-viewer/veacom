// Runs a lint tool from its pinned GitHub release instead of an npm package, so no install script or extra lockfile
// entry comes with it: node tools/pinned-tool.mjs <oxlint|actionlint> [arguments]. The archive's SHA-256 is checked
// against the digest below (GitHub's own for the release asset) before anything is unpacked, and the unpacked tool is
// kept per version in the user's cache folder. Behind a proxy, set NODE_USE_ENV_PROXY=1 so Node's fetch uses HTTPS_PROXY.
// To update a tool, change its version and every digest together (gh api repos/<repo>/releases/tags/<tag>).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLATFORM = `${process.platform}-${process.arch}`;
const TOOLS = {
  oxlint: {
    version: '1.84.0',
    url: name => `https://github.com/oxc-project/oxc/releases/download/apps_v1.84.0/${name}`,
    assets: {
      'darwin-arm64': ['oxlint-aarch64-apple-darwin.tar.gz', 'e45d663c25b14ce0c85a56802ec868610d17b0e3311a1f39fc7f2b6f31efda94'],
      'darwin-x64': ['oxlint-x86_64-apple-darwin.tar.gz', 'fcf84ccd6cba88e714c644f2c61efc6349a0b4a40a48d72b117d9aba9812117a'],
      'linux-x64': ['oxlint-x86_64-unknown-linux-gnu.tar.gz', '1839650aa43c7aafcd077134c1b3ad033893649a85a9a4cd1993c1a49c93468d'],
      'linux-arm64': ['oxlint-aarch64-unknown-linux-gnu.tar.gz', 'f0c68dab774f32e0a3f7225ecf18bbe28c112a8e57fc88f30e802115035321f7'],
      'win32-x64': ['oxlint-x86_64-pc-windows-msvc.zip', 'f3672f9ac9b33e1b7f66588f4401e463886f1667aa0a7a6686967754638064da'],
      'win32-arm64': ['oxlint-aarch64-pc-windows-msvc.zip', '0bfc2c65627930f1744c21843b246b3b083c6e5db8541d3d9073a445ecf4e98e'],
    },
    // The archive holds one executable named for its target.
    executable: archive => archive.replace(/\.(tar\.gz|zip)$/, process.platform === 'win32' ? '.exe' : ''),
  },
  actionlint: {
    version: '1.7.12',
    url: name => `https://github.com/rhysd/actionlint/releases/download/v1.7.12/${name}`,
    assets: {
      'darwin-arm64': ['actionlint_1.7.12_darwin_arm64.tar.gz', 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f'],
      'darwin-x64': ['actionlint_1.7.12_darwin_amd64.tar.gz', '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644'],
      'linux-x64': ['actionlint_1.7.12_linux_amd64.tar.gz', '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'],
      'linux-arm64': ['actionlint_1.7.12_linux_arm64.tar.gz', '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6'],
      'win32-x64': ['actionlint_1.7.12_windows_amd64.zip', '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9'],
      'win32-arm64': ['actionlint_1.7.12_windows_arm64.zip', 'cadcf7ea4efe3a68728893813643cebe1185e5b1d4be5b96245f65c9a4d5ea41'],
    },
    executable: () => (process.platform === 'win32' ? 'actionlint.exe' : 'actionlint'),
  },
};

const [name, ...args] = process.argv.slice(2);
const tool = TOOLS[name];
if (!tool) {
  console.error(`Usage: node tools/pinned-tool.mjs <${Object.keys(TOOLS).join('|')}> [arguments]`);
  process.exit(2);
}
const asset = tool.assets[PLATFORM];
if (!asset) throw new Error(`${name} ${tool.version} has no pinned build for ${PLATFORM}.`);
const [archive, digest] = asset;

const home = os.homedir();
const cacheRoot = process.platform === 'darwin' ? path.join(home, 'Library', 'Caches')
  : process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  : process.env.XDG_CACHE_HOME || path.join(home, '.cache');
const folder = path.join(cacheRoot, 'veacom-tools', `${name}-${tool.version}-${digest.slice(0, 12)}`);
const executable = path.join(folder, tool.executable(archive));

if (!fs.existsSync(executable)) {
  const response = await fetch(tool.url(archive));
  if (!response.ok) throw new Error(`${name} download failed: HTTP ${response.status} for ${response.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) throw new Error(`${archive} has SHA-256 ${actual}; tools/pinned-tool.mjs expects ${digest}.`);
  const staging = `${folder}.${process.pid}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const file = path.join(staging, archive);
  fs.writeFileSync(file, bytes);
  // bsdtar, which Windows has as tar.exe, unpacks a zip as well.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const unpacked = spawnSync(tar, ['-xf', file, '-C', staging], { stdio: 'inherit' });
  if (unpacked.status !== 0) throw new Error(`${tar} could not unpack ${archive}`);
  fs.rmSync(file);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.renameSync(staging, folder);
}

const run = spawnSync(executable, args, { stdio: 'inherit' });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
