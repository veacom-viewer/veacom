const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { t } = require('./i18n.cjs');

const REPOSITORY = 'veacom-viewer/veacom';
const RELEASES = `https://github.com/${REPOSITORY}/releases`;
const API = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const CDN_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_INSTALLER = 2 * 1024 ** 3;
const exec = promisify(execFile);

function parseVersion(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value || '');
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number);
  const pre = match[4] ? match[4].split('.') : [];
  if (numbers.some(n => !Number.isSafeInteger(n)) || pre.some(p => /^\d+$/.test(p) && p.length > 1 && p[0] === '0')) return null;
  return { numbers, pre, text: value.replace(/^v/, '') };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function selectRelease(releases, currentVersion, platform, arch) {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error('The running application version is invalid.');
  if (!Array.isArray(releases)) throw new Error(t('update.invalidResponse'));
  const candidates = [];
  for (const release of releases) {
    if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v') || release.draft !== false) continue;
    const releaseVersion = release.tag_name.slice(1);
    const version = parseVersion(releaseVersion);
    if (!version || version.text !== releaseVersion || release.prerelease !== Boolean(version.pre.length)
      || (!current.pre.length && version.pre.length)) continue;
    const suffix = platform === 'win32' ? `win-${arch}-Installer.exe` : platform === 'darwin' ? `mac-${arch}.dmg` : null;
    if (!suffix) continue;
    const name = `VEAcom-Electron-${version.text}-${suffix}`;
    const asset = (release.assets || []).find(item => item.name === name && item.state === 'uploaded');
    if (!asset) continue;
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '');
    if (!digest || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER) continue;
    const url = `${RELEASES}/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`;
    if (asset.browser_download_url !== url) continue;
    candidates.push({ version: version.text, parsed: version, name, url, sha256: digest[1].toLowerCase(),
      size: asset.size, page: `${RELEASES}/tag/${encodeURIComponent(release.tag_name)}`,
      notes: String(release.body || '').slice(0, 50_000) });
  }
  candidates.sort((a, b) => compareVersions(b.parsed, a.parsed));
  return { latest: candidates[0] || null,
    update: candidates.find(candidate => compareVersions(candidate.parsed, current) > 0) || null };
}

async function responseFor(url, { fetchImpl, signal, api = false }) {
  let current = url;
  for (let redirect = 0; redirect < 6; redirect++) {
    const address = new URL(current);
    const allowed = api ? address.href === API : address.protocol === 'https:' && !address.port && CDN_HOSTS.has(address.hostname)
      && (address.hostname !== 'github.com' || address.pathname.startsWith(`/${REPOSITORY}/releases/download/`));
    if (!allowed || address.username || address.password) throw new Error(t('update.leftHosts'));
    const response = await fetchImpl(current, { redirect: 'manual', signal, credentials: 'omit',
      headers: { Accept: api ? 'application/vnd.github+json' : 'application/octet-stream', 'User-Agent': 'VEAcom-Electron-Updater' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get('location');
      await response.body?.cancel();
      if (!target || api) throw new Error(t('update.redirect'));
      current = new URL(target, current).href;
      continue;
    }
    if (!response.ok) throw new Error(t('update.httpStatus', { status: response.status }));
    return response;
  }
  throw new Error(t('update.tooManyRedirects'));
}

async function readReleases(fetchImpl, signal) {
  const response = await responseFor(API, { fetchImpl, signal, api: true });
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 6 * 1024 ** 2) throw new Error(t('update.responseTooLarge'));
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadVerified(candidate, directory, fetchImpl, signal, progress) {
  const destination = path.join(directory, candidate.name);
  const response = await responseFor(candidate.url, { fetchImpl, signal });
  const handle = await fs.open(destination, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > candidate.size || bytes > MAX_INSTALLER) throw new Error(t('update.tooLarge'));
      hash.update(chunk);
      await handle.writeFile(chunk);
      progress(Math.floor(bytes / candidate.size * 100));
    }
    if (bytes !== candidate.size || hash.digest('hex') !== candidate.sha256) throw new Error(t('update.checksum'));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(destination, { force: true });
    throw error;
  }
  await handle.close();
  return destination;
}

async function verifySignature(file, platform, execute = exec, installedExecutable = process.execPath) {
  if (platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
      "$s=Get-AuthenticodeSignature -LiteralPath $env:VEACOM_UPDATE_FILE; " +
      "$current=Get-AuthenticodeSignature -LiteralPath $env:VEACOM_INSTALLED_FILE; " +
      "@{status=[string]$s.Status;subject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{''};" +
      "installed_status=[string]$current.Status;installed_subject=if($current.SignerCertificate){$current.SignerCertificate.Subject}else{''}} | ConvertTo-Json -Compress";
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
        env: { ...process.env, VEACOM_UPDATE_FILE: file, VEACOM_INSTALLED_FILE: installedExecutable } });
    const signature = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (signature.status !== 'Valid' || typeof signature.subject !== 'string' || !signature.subject.trim()) {
      throw new Error(t('update.blockedSignature', { status: signature.status || t('update.signatureUnknown') }));
    }
    if (signature.installed_status !== 'Valid' || typeof signature.installed_subject !== 'string' || !signature.installed_subject.trim()) {
      throw new Error(t('update.blockedUnsigned'));
    }
    if (signature.subject !== signature.installed_subject) throw new Error(t('update.blockedPublisher'));
    return t('update.windowsPublisher', { subject: signature.subject });
  }
  if (platform === 'darwin') {
    try {
      await execute('/usr/bin/codesign', ['--verify', '--strict', file], { timeout: 30_000, maxBuffer: 64 * 1024 });
      await execute('/usr/bin/codesign', ['--verify', '--strict', installedExecutable], { timeout: 30_000, maxBuffer: 64 * 1024 });
      await execute('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', file], { timeout: 30_000, maxBuffer: 64 * 1024 });
      const identity = async target => {
        const details = await execute('/usr/bin/codesign', ['--display', '--verbose=4', target], { timeout: 30_000, maxBuffer: 64 * 1024 });
        return /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(String(details.stderr))?.[1];
      };
      const [downloadTeam, installedTeam] = await Promise.all([identity(file), identity(installedExecutable)]);
      if (!downloadTeam || downloadTeam !== installedTeam) throw new Error(t('update.macPublisherMismatch'));
      return t('update.macPublisher', { team: downloadTeam });
    } catch (error) {
      throw new Error(t('update.blockedMac', { details: error.message || '' }).trim());
    }
  }
  throw new Error(t('update.platform'));
}

async function markDownloadOrigin(file, url, platform) {
  if (platform === 'win32') {
    await fs.writeFile(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${url}\r\n`, 'utf8');
  } else if (platform === 'darwin') {
    await exec('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${Math.floor(Date.now() / 1000).toString(16)};VEAcom;`, file], { timeout: 10_000 });
  }
}

async function cleanupCache(cache, now = Date.now()) {
  let entries;
  try { entries = await fs.readdir(cache, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^installer-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const directory = path.join(cache, entry.name);
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(directory, '.veacom-update.json'), 'utf8')); }
    catch { continue; }
    const created = Date.parse(metadata.createdAt);
    if (metadata.product === 'VEAcom-Electron' && Number.isFinite(created) && now - created >= 7 * 24 * 60 * 60_000) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
}

function createUpdateController({ app, dialog, shell, getWindow, notify = () => {}, fetchImpl = globalThis.fetch,
  publicUpdates = require('../package.json').veacomPublicUpdates === true,
  platform = process.platform, arch = process.arch, signatureCheck = verifySignature, markOrigin = markDownloadOrigin }) {
  const currentVersion = app.getVersion();
  const sourceBuild = !app.isPackaged;
  let status = { phase: publicUpdates ? 'idle' : 'manual', currentVersion,
    message: !publicUpdates ? t('update.department') : sourceBuild ? t('update.sourceBuild') : t('update.notChecked'),
    sourceBuild, canDownload: false, canInstall: false };
  let candidate = null, downloaded = null, directory = null, pending = null, abort = null, disposed = false;
  const publish = patch => { status = { ...status, ...patch }; if (!disposed) notify({ ...status }); return { ...status }; };
  const snapshot = () => ({ ...status });
  const run = work => {
    if (pending) return pending;
    pending = Promise.resolve().then(work).catch(error => publish({ phase: 'error', message: error.message, canInstall: false,
      canDownload: Boolean(candidate && !sourceBuild) })).finally(() => { pending = null; });
    return pending;
  };
  const check = () => run(async () => {
    if (!publicUpdates) return snapshot();
    candidate = null; downloaded = null;
    publish({ phase: 'checking', message: t('update.checking'), canDownload: false, canInstall: false,
      version: undefined, releaseNotes: undefined, signature: undefined, progress: undefined });
    abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20_000);
    let releases;
    try { releases = await readReleases(fetchImpl, abort.signal); } finally { clearTimeout(timeout); }
    const selected = selectRelease(releases, currentVersion, platform, arch);
    const checkedAt = new Date().toISOString();
    if (!selected.latest) return publish({ phase: 'unavailable', checkedAt,
      message: t('update.noInstaller', { platform, arch }) });
    if (!selected.update) return publish({ phase: 'up-to-date', checkedAt, message: t('update.upToDate', { version: currentVersion }) });
    candidate = selected.update;
    return publish({ phase: 'available', checkedAt, version: candidate.version, releaseNotes: candidate.notes,
      canDownload: !sourceBuild, message: sourceBuild ? t('update.availableSource', { version: candidate.version }) : t('update.available', { version: candidate.version }) });
  });
  const download = () => run(async () => {
    if (!publicUpdates) return snapshot();
    if (sourceBuild || !candidate) throw new Error(t('update.chooseAvailable'));
    if (directory) await fs.rm(directory, { recursive: true, force: true });
    const cache = path.join(app.getPath('userData'), 'updates');
    await fs.mkdir(cache, { recursive: true, mode: 0o700 });
    await cleanupCache(cache);
    directory = await fs.mkdtemp(path.join(cache, 'installer-'));
    await fs.writeFile(path.join(directory, '.veacom-update.json'), JSON.stringify({ product: 'VEAcom-Electron', createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    downloaded = null;
    publish({ phase: 'downloading', message: t('update.downloading', { version: candidate.version }), progress: 0, signature: undefined, canDownload: false, canInstall: false });
    abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10 * 60_000);
    try {
      downloaded = await downloadVerified(candidate, directory, fetchImpl, abort.signal, progress => {
        if (progress !== status.progress) publish({ progress });
      });
      await markOrigin(downloaded, candidate.url, platform);
      const signature = await signatureCheck(downloaded, platform);
      return publish({ phase: 'ready', message: t('update.verified'), signature, progress: 100, canInstall: true });
    } finally { clearTimeout(timeout); }
  });
  const install = () => run(async () => {
    if (!publicUpdates) return snapshot();
    if (sourceBuild || !candidate || !downloaded || !status.canInstall) throw new Error(t('update.noInstallerReady'));
    if (await hashFile(downloaded) !== candidate.sha256) throw new Error(t('update.installerChanged'));
    const signature = await signatureCheck(downloaded, platform);
    const parent = getWindow();
    const options = { type: 'question', buttons: [t('update.dialogCancel'), t('update.dialogConfirm')],
      defaultId: 0, cancelId: 0, noLink: true, title: t('update.dialogTitle'),
      message: t('update.dialogMessage', { version: candidate.version }),
      detail: t('update.dialogDetail', { signature }) };
    const confirmation = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (confirmation.response !== 1) return snapshot();
    // Recheck after the user prompt, then let the OS open the visible installer. No silent flags.
    if (await hashFile(downloaded) !== candidate.sha256) throw new Error(t('update.changedWhileWaiting'));
    await signatureCheck(downloaded, platform);
    const failure = await shell.openPath(downloaded);
    if (failure) throw new Error(t('update.openFailed', { error: failure }));
    publish({ phase: 'installing', message: t('update.installing'), canInstall: false, canDownload: false });
    app.quit();
    return snapshot();
  });
  const notes = async () => { await shell.openExternal(candidate?.page || RELEASES); };
  const dispose = () => { disposed = true; abort?.abort(); };
  const cleanup = () => cleanupCache(path.join(app.getPath('userData'), 'updates'));
  return { status: snapshot, check, download, install, notes, dispose, cleanup };
}

function registerUpdateHandlers({ handle, app, getWindow, dialog, shell }) {
  const controller = createUpdateController({ app, getWindow, dialog, shell, notify: status => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('updates:status', status);
  } });
  for (const [channel, method] of Object.entries({ status: 'status', check: 'check', download: 'download', install: 'install', notes: 'notes' })) {
    handle(`updates:${channel}`, () => controller[method]());
  }
  const startup = app.isPackaged ? setTimeout(() => {
    void controller.cleanup().catch(error => process.stderr.write(`Update cache cleanup failed: ${error.message}\n`));
    if (controller.status().phase !== 'manual') void controller.check();
  }, 4000) : null;
  startup?.unref?.();
  return () => { if (startup) clearTimeout(startup); controller.dispose(); };
}

module.exports = { registerUpdateHandlers, createUpdateController, selectRelease, parseVersion, compareVersions,
  responseFor, downloadVerified, verifySignature, hashFile, cleanupCache };
