import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { assertFields } from './support';

const require = createRequire(import.meta.url);
const { createUpdateController, selectRelease, parseVersion, compareVersions, responseFor, verifySignature, cleanupCache } = require('../electron/updates.cjs');
const directories: string[] = [];
const payload = Buffer.from('synthetic installer bytes; never executed');
const digest = createHash('sha256').update(payload).digest('hex');
const releases = 'https://github.com/veacom-viewer/veacom/releases';

function release(version = '0.1.0-beta.2', platform = 'win-x64-Installer.exe') {
  const name = `VEAcom-Electron-${version}-${platform}`;
  return { tag_name: `v${version}`, draft: false, prerelease: version.includes('-'), body: 'Release notes', assets: [
    { name, state: 'uploaded', size: payload.length, digest: `sha256:${digest}`, browser_download_url: `${releases}/download/v${version}/${name}` },
  ] };
}

async function fixture(packaged = true, publicFeed = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'veacom-updates-test-'));
  directories.push(directory);
  const app = { getVersion: () => '0.1.0-beta.1', isPackaged: packaged, getPath: () => directory, quit: mock.fn() };
  const dialog = { showMessageBox: mock.fn(async (..._args: unknown[]) => ({ response: 0 })) };
  const shell = { openPath: mock.fn(async (_file: string) => ''), openExternal: mock.fn(async (_url: string) => {}) };
  const signatureCheck = mock.fn(async () => 'Verified Windows publisher: CN=VEAcom Developer');
  const markOrigin = mock.fn(async () => {});
  const fetchImpl = mock.fn(async (url: string) => url.startsWith('https://api.github.com/')
    ? new Response(JSON.stringify([release()])) : new Response(payload));
  const controller = createUpdateController({ app, dialog, shell, getWindow: () => null, fetchImpl,
    ...(publicFeed ? { publicUpdates: true } : {}), platform: 'win32', arch: 'x64', signatureCheck, markOrigin });
  return { controller, app, dialog, shell, fetchImpl, signatureCheck, markOrigin, directory };
}

afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('compatible VEAcom releases', () => {
  it('does not contact an update service in the private beta', async () => {
    const f = await fixture(true, false);
    assertFields(f.controller.status(), { currentVersion: '0.1.0-beta.1', phase: 'manual', canDownload: false, canInstall: false });
    assert.equal((await f.controller.check()).phase, 'manual');
    assert.equal((await f.controller.download()).phase, 'manual');
    assert.equal((await f.controller.install()).phase, 'manual');
    assert.equal(f.fetchImpl.mock.callCount(), 0);
    assert.equal(f.shell.openPath.mock.callCount(), 0);
    assert.equal(f.shell.openExternal.mock.callCount(), 0);
    await f.controller.notes();
    assert.ok(f.shell.openExternal.mock.calls.some(call => isDeepStrictEqual(call.arguments, [releases])));
  });
  it('requires the exact product, architecture, checksum and repository download URL', () => {
    const otherProduct = release(); otherProduct.assets[0].name = 'OtherViewer-0.1.0-beta.2.exe';
    const noChecksum = release(); noChecksum.assets[0].digest = '';
    const external = release(); external.assets[0].browser_download_url = 'https://github.com/other/viewer/releases/download/v0.1.0-beta.2/installer.exe';
    assert.equal(selectRelease([otherProduct, release('0.1.0-beta.2', 'win-arm64-Installer.exe'), noChecksum, external], '0.1.0-beta.1', 'win32', 'x64').latest, null);
  });
  it('compares beta numbers numerically and keeps stable users off prereleases', () => {
    assert.equal(compareVersions(parseVersion('0.1.0-beta.10'), parseVersion('0.1.0-beta.2')), 1);
    assert.equal(compareVersions(parseVersion('0.1.0'), parseVersion('0.1.0-beta.10')), 1);
    assert.equal(parseVersion('0.1.0-beta.01'), null);
    assert.equal(selectRelease([release('0.2.0-beta.1')], '0.1.0', 'win32', 'x64').update, null);
    assert.equal(selectRelease([release('0.1.0-beta.2')], '0.1.0-beta.1', 'win32', 'x64').update.version, '0.1.0-beta.2');
    assert.equal(selectRelease([release('0.1.0')], '0.1.0-beta.1', 'win32', 'x64').update.version, '0.1.0');
  });
  it('rejects drafts, nonstandard tags and a release flag that disagrees with the version', () => {
    const wrongTag = release(); wrongTag.tag_name = 'other-v0.1.0-beta.2';
    const draft = release(); draft.draft = true;
    const betaMarkedStable = release(); betaMarkedStable.prerelease = false;
    const stableMarkedBeta = release('0.1.0'); stableMarkedBeta.prerelease = true;
    assert.equal(selectRelease([wrongTag, draft, betaMarkedStable, stableMarkedBeta], '0.1.0-beta.1', 'win32', 'x64').latest, null);
  });
  it('reports no compatible installer instead of claiming the viewer is up to date', async () => {
    const f = await fixture(false); f.fetchImpl.mock.mockImplementationOnce(async () => new Response('[]'));
    const status = await f.controller.check();
    assert.equal(status.phase, 'unavailable');
    assert.ok(status.message.includes('No VEAcom installer'));
  });
  it('source builds can check a configured public feed but cannot download or launch an installer', async () => {
    const f = await fixture(false);
    assert.equal((await f.controller.check()).canDownload, false);
    assert.equal((await f.controller.download()).phase, 'error');
    assert.equal(f.fetchImpl.mock.callCount(), 1);
    assert.equal(f.shell.openPath.mock.callCount(), 0);
  });
  it('opens the matching release page only on request', async () => {
    const f = await fixture(); await f.controller.check(); await f.controller.notes();
    assert.ok(f.shell.openExternal.mock.calls.some(call => isDeepStrictEqual(call.arguments, [`${releases}/tag/v0.1.0-beta.2`])));
  });
});

describe('installer verification and user consent', () => {
  it('rejects a changed download before signature checks or installation', async () => {
    const f = await fixture(); await f.controller.check();
    f.fetchImpl.mock.mockImplementationOnce(async () => new Response(Buffer.alloc(payload.length)));
    const status = await f.controller.download();
    assert.equal(status.phase, 'error'); assert.equal(status.canInstall, false);
    assert.ok(status.message.includes('checksum')); assert.equal(f.signatureCheck.mock.callCount(), 0);
    const folders = await readdir(path.join(f.directory, 'updates'));
    assert.deepEqual((await readdir(path.join(f.directory, 'updates', folders[0]))).filter(name => name.endsWith('.exe')), []);
  });
  it('keeps a verified installer idle until explicit confirmation, then opens it without silent flags', async () => {
    const f = await fixture(); await f.controller.check();
    assert.equal((await f.controller.download()).phase, 'ready');
    assert.equal(f.markOrigin.mock.callCount(), 1);
    assert.equal(f.shell.openPath.mock.callCount(), 0);
    assert.equal((await f.controller.install()).phase, 'ready');
    assert.equal(f.shell.openPath.mock.callCount(), 0); assert.equal(f.app.quit.mock.callCount(), 0);
    f.dialog.showMessageBox.mock.mockImplementationOnce(async () => ({ response: 1 }));
    assert.equal((await f.controller.install()).phase, 'installing');
    assert.equal(f.shell.openPath.mock.callCount(), 1);
    assert.equal(f.shell.openPath.mock.calls[0].arguments.length, 1);
    assert.equal(f.app.quit.mock.callCount(), 1);
  });
  it('rechecks the installer after the confirmation dialog', async () => {
    const f = await fixture(); await f.controller.check(); await f.controller.download();
    const folders = await readdir(path.join(f.directory, 'updates'));
    const installer = path.join(f.directory, 'updates', folders[0], release().assets[0].name);
    f.dialog.showMessageBox.mock.mockImplementationOnce(async () => { await writeFile(installer, 'changed'); return { response: 1 }; });
    assert.equal((await f.controller.install()).phase, 'error');
    assert.equal(f.shell.openPath.mock.callCount(), 0); assert.equal(f.app.quit.mock.callCount(), 0);
  });
  it('rejects a failed OS signature check', async () => {
    const f = await fixture(); await f.controller.check();
    f.signatureCheck.mock.mockImplementationOnce(async () => { throw new Error('Windows rejected the installer signature (HashMismatch).'); });
    assert.equal((await f.controller.download()).phase, 'error');
    assert.equal(f.controller.status().canInstall, false);
    assert.equal(f.shell.openPath.mock.callCount(), 0);
  });
  it('cannot offer or open an unsigned installer even when its checksum matches', async () => {
    const f = await fixture(); await f.controller.check();
    f.signatureCheck.mock.mockImplementation(async () => verifySignature('file.exe', 'win32', async () => ({ stdout: '{"status":"NotSigned"}' })));
    assert.equal((await f.controller.download()).phase, 'error');
    assert.equal(f.controller.status().canInstall, false);
    await f.controller.install();
    assert.equal(f.dialog.showMessageBox.mock.callCount(), 0);
    assert.equal(f.shell.openPath.mock.callCount(), 0);
  });
  it('checks signature trust again after confirmation', async () => {
    const f = await fixture(); await f.controller.check(); await f.controller.download();
    f.dialog.showMessageBox.mock.mockImplementationOnce(async () => ({ response: 1 }));
    const next = f.signatureCheck.mock.callCount();
    f.signatureCheck.mock.mockImplementationOnce(async () => 'Verified publisher', next);
    f.signatureCheck.mock.mockImplementationOnce(async () => { throw new Error('Signature trust changed'); }, next + 1);
    assert.equal((await f.controller.install()).phase, 'error');
    assert.equal(f.shell.openPath.mock.callCount(), 0);
  });
  it('rejects redirected downloads outside the official asset hosts', async () => {
    const fetchImpl = mock.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/installer.exe' } }));
    await assert.rejects(responseFor(release().assets[0].browser_download_url, { fetchImpl }), { message: /approved GitHub hosts/ });
    assert.equal(fetchImpl.mock.callCount(), 1);
  });
  it('accepts a signed GitHub asset CDN redirect', async () => {
    const fetchImpl = mock.fn(async () => new Response(payload));
    fetchImpl.mock.mockImplementationOnce(async () => new Response(null, { status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/file?temporary=signed' } }));
    const response = await responseFor(release().assets[0].browser_download_url, { fetchImpl });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
  });
});

it('cleans expired owned downloads after a restart while retaining recent or unrelated files', async () => {
  const f = await fixture();
  const now = Date.now();
  const cache = path.join(f.directory, 'updates');
  for (const [name, age, owned] of [['installer-old123', 8, true], ['installer-new123', 1, true], ['installer-usr123', 8, false]] as const) {
    const directory = path.join(cache, name); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '.veacom-update.json'), JSON.stringify({ product: owned ? 'VEAcom-Electron' : 'Other', createdAt: new Date(now - age * 86400_000).toISOString() }));
    await writeFile(path.join(directory, 'installer.exe'), payload);
  }
  await cleanupCache(cache, now);
  assert.deepEqual((await readdir(cache)).sort(), ['installer-new123', 'installer-usr123']);
});

describe('Windows signature inspection', () => {
  it('reports a valid signer and uses a system PowerShell with a literal path via environment', async () => {
    const execute = mock.fn(async () => ({ stdout: JSON.stringify({ status: 'Valid', subject: 'CN=VEAcom Developer', installed_status: 'Valid', installed_subject: 'CN=VEAcom Developer' }) }));
    assert.ok((await verifySignature('C:\\file with spaces.exe', 'win32', execute)).includes('CN=VEAcom Developer'));
    const call = execute.mock.calls[0].arguments as unknown as [string, string[], { env: Record<string, string> }];
    assert.match(call[0], /WindowsPowerShell\\v1.0\\powershell.exe$/);
    assert.equal(call[2].env.VEACOM_UPDATE_FILE, 'C:\\file with spaces.exe');
    assert.equal(call[2].env.VEACOM_INSTALLED_FILE, process.execPath);
    assert.ok(Buffer.from(call[1].at(-1)!, 'base64').toString('utf16le').includes('[Text.UTF8Encoding]'));
  });
  for (const status of ['NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError']) it(`blocks installer signature status ${status}`, async () => {
    await assert.rejects(verifySignature('file.exe', 'win32', async () => ({ stdout: JSON.stringify({ status }) })), { message: /Update blocked/ });
  });
  it('blocks a different valid publisher or an unsigned installed application', async () => {
    for (const current of [{ installed_status: 'NotSigned', installed_subject: '' }, { installed_status: 'Valid', installed_subject: 'CN=Other Publisher' }]) {
      await assert.rejects(verifySignature('file.exe', 'win32', async () => ({ stdout: JSON.stringify({ status: 'Valid', subject: 'CN=VEAcom Developer', ...current }) })), { message: /Update blocked/ });
    }
  });
});

// The installed folder itself is checked by the hosted Windows job's silent install (tools/check-windows-package.ps1):
// electron-builder installs apart from the root, in packaging/. An assisted installer is what lets NSIS use the
// product name, not the package name, for that folder.
it('keeps the VEAcom release identity, installation directory and signing requirements', () => {
  const config = require('../electron-builder.release.cjs');
  assert.equal(config.productName, 'VEAcom Electron');
  assert.equal(config.appId, 'com.veacom.electron');
  assert.equal(config.forceCodeSigning, true);
  assert.equal(config.dmg.sign, true);
  assert.equal(config.nsis.oneClick, false);
});

describe('macOS signature inspection', () => {
  it('blocks unsigned and ad-hoc updates instead of offering a warning override', async () => {
    await assert.rejects(verifySignature('update.dmg', 'darwin', async () => { throw Object.assign(new Error('unsigned'), { stderr: 'code object is not signed at all' }); }), { message: /Update blocked/ });
    await assert.rejects(verifySignature('update.dmg', 'darwin', async () => ({ stderr: 'TeamIdentifier=not set' })), { message: /Update blocked/ });
  });
  it('accepts only matching signed Apple teams after Gatekeeper acceptance', async () => {
    const execute = mock.fn(async (_command: string, args: string[]) => ({ stderr: args.includes('--display') ? 'TeamIdentifier=ABCDE12345\n' : '' }));
    assert.ok((await verifySignature('update.dmg', 'darwin', execute)).includes('ABCDE12345'));
    assert.equal(execute.mock.calls.some(({ arguments: [command] }) => command === '/usr/sbin/spctl'), true);
  });
  it('rejects a different signed Apple team', async () => {
    const execute = async (_command: string, args: string[]) => ({ stderr: args.includes('--display')
      ? `TeamIdentifier=${args.at(-1) === 'update.dmg' ? 'ABCDE12345' : 'ZYXWV98765'}\n` : '' });
    await assert.rejects(verifySignature('update.dmg', 'darwin', execute), { message: /Update blocked/ });
  });
});
