const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { t } = require('./i18n.cjs');
const { checkDecoderConfig, checkSample, mp4Header } = require('./mp4.cjs');

const MAX_FRAMES = 60000;

function launch(command, args) {
  const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  child.stdin.on('error', () => {});
  const done = new Promise(resolve => {
    child.once('error', error => resolve({ code: -1, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, done, error: () => stderr.trim() };
}

function resultError(process, result, fallback) {
  return result.error ?? new Error(process.error() || `${fallback}${result.signal ? ` (${result.signal})` : ''}`);
}

/** Copies a finished file onto the end of an open one, a piece at a time. */
async function appendFile(target, source) {
  const input = await fs.open(source, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return;
      await target.writeFile(buffer.subarray(0, bytesRead));
    }
  } finally { await input.close(); }
}

/** Removes a temporary export folder. Windows can refuse for a moment while antivirus or the indexer still holds a
 * file just written, so it retries; a folder that still cannot go is reported and left for a later sweep
 * (sweepExportLeftovers) rather than turning a finished export into a failure or blocking the next one. */
async function removeFolder(directory) {
  try { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { process.stderr.write(`Could not remove the temporary export folder ${directory}: ${error.message}\n`); }
}

// Temporary folders of exports that never finished: an ISO's DICOM copy in the system's temporary folder, and the
// samples of a video or a partial ISO next to their destination. They can hold patient images.
const LEFTOVER = /^(?:veacom-dicom-|\.veacom-video-|\.veacom-iso-)[A-Za-z0-9]{6}$/;

/** Removes such folders left by a crash, a forced quit or a shutdown. Only folders older than `olderThanMs` go,
 * so an export still running in another VEAcom (one with its own user data folder) keeps its own. */
async function sweepExportLeftovers(folders, { olderThanMs = 6 * 60 * 60 * 1000, now = Date.now() } = {}) {
  for (const folder of new Set(folders.filter(Boolean))) {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !LEFTOVER.test(entry.name)) continue;
      const target = path.join(folder, entry.name);
      const stat = await fs.lstat(target).catch(() => null);
      if (stat?.isDirectory() && now - stat.mtimeMs >= olderThanMs) await removeFolder(target);
    }
  }
}

/** Waits for `promise` at most `milliseconds`. */
function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}

// The renderer encodes the frames with WebCodecs; this side keeps the samples on disk and writes the MP4.
function createVideoExporter({ chooseDestination, idleTimeoutMs = 120000, onSaved, onFolder }) {
  let job = null, starting = false, disposed = false;
  const getJob = id => {
    if (typeof id !== 'string' || !job || job.id !== id) throw new Error(t('video.inactive'));
    return job;
  };
  const remove = async current => {
    clearTimeout(current.timer);
    // An ended job never blocks the next one, even while its folder cannot be removed yet.
    if (job === current) job = null;
    await current.samples.close().catch(() => {});
    await removeFolder(current.directory);
  };
  const stop = async current => {
    if (!current.stopping) current.stopping = (async () => {
      current.cancelled = true;
      await remove(current);
    })();
    return current.stopping;
  };
  const touch = current => {
    clearTimeout(current.timer);
    current.timer = setTimeout(() => { stop(current).catch(() => {}); }, idleTimeoutMs);
    current.timer.unref?.();
  };

  return {
    get active() { return Boolean(job); },
    async beginVideo(suggestedName, fps) {
      if (disposed) throw new Error(t('app.closing'));
      if (job || starting) throw new Error(t('video.alreadyRunning'));
      if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error(t('video.frameRate'));
      if (typeof suggestedName !== 'string' || suggestedName.length > 512) throw new Error(t('video.invalidName'));
      starting = true;
      let directory;
      try {
        const destination = await chooseDestination(`${path.basename(suggestedName).replace(/\.mp4$/i, '')}.mp4`);
        if (!destination) return null;
        if (disposed) throw new Error(t('app.closing'));
        onFolder?.(path.dirname(destination));
        directory = await fs.mkdtemp(path.join(path.dirname(destination), '.veacom-video-'));
        const samplesPath = path.join(directory, 'samples');
        const samples = await fs.open(samplesPath, 'wx');
        const current = { id: randomUUID(), destination, directory, samplesPath, samples, fps, config: null, sizes: [], keyFrames: [],
          pending: false, finishing: false, cancelled: false, stopping: null, timer: null };
        job = current;
        touch(current);
        return { id: current.id };
      } catch (error) {
        if (directory) await fs.rm(directory, { recursive: true, force: true });
        throw error;
      } finally { starting = false; }
    },
    async configureVideo(id, settings) {
      const current = getJob(id);
      if (current.config) throw new Error('This video export is already configured.');
      const { width, height, description } = settings ?? {};
      if (![width, height].every(side => Number.isInteger(side) && side >= 16 && side <= 8192 && side % 2 === 0)
        || width * height > 36000000) throw new Error('Invalid video size.');
      current.config = { width, height, config: Buffer.from(checkDecoderConfig(description)) };
      touch(current);
    },
    async appendVideo(id, data, key) {
      const current = getJob(id);
      if (current.pending || current.finishing || current.cancelled) throw new Error('Wait for the current frame before sending another.');
      if (!current.config) throw new Error('This video export has no encoder settings.');
      if (current.sizes.length >= MAX_FRAMES) throw new Error(t('video.frameLimit', { count: MAX_FRAMES }));
      const bytes = checkSample(data);
      if (!current.sizes.length && key !== true) throw new Error('A video must start with a key frame.');
      current.pending = true;
      touch(current);
      try {
        await current.samples.writeFile(bytes);
        if (current.cancelled) throw new Error(t('video.cancelled'));
        if (key === true) current.keyFrames.push(current.sizes.length);
        current.sizes.push(bytes.length);
        touch(current);
      } catch (error) { await stop(current); throw error; }
      finally { current.pending = false; }
    },
    async finishVideo(id) {
      const current = getJob(id);
      if (current.pending || current.finishing || current.cancelled) throw new Error('A video frame is still being written.');
      current.finishing = true;
      // Copying a long video to a slow drive can outlast the idle deadline, and it isn't idle.
      clearTimeout(current.timer);
      try {
        if (!current.sizes.length) throw new Error(t('video.noFrames'));
        await current.samples.close();
        const partial = path.join(current.directory, 'video.mp4');
        const output = await fs.open(partial, 'wx');
        try {
          await output.writeFile(mp4Header({ ...current.config, fps: current.fps, sizes: current.sizes, keyFrames: current.keyFrames }));
          await appendFile(output, current.samplesPath);
        } finally { await output.close(); }
        if (current.cancelled) throw new Error(t('video.cancelled'));
        await fs.rename(partial, current.destination);
      } catch (error) { await stop(current); throw error; }
      // The video is in place: what is left is tidying up, which cannot fail the export.
      await remove(current);
      onSaved?.(current.destination);
      return current.destination;
    },
    async cancelVideo(id) {
      if (typeof id !== 'string') throw new Error('Invalid video export.');
      if (job?.id === id) await stop(job);
    },
    /** Stops the running job (its page crashed or reloaded); new jobs can still start. */
    async reset() { if (job) await stop(job); },
    async dispose() { disposed = true; if (job) await stop(job); },
  };
}

const isoScript = `param([string]$Source,[string]$Target,[string]$Label)
$ErrorActionPreference="Stop"
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class VeacomIso {
 public static void Save(object image,string path) {
  IStream stream=(IStream)image;
  byte[] buffer=new byte[1<<20];
  IntPtr readCount=Marshal.AllocHGlobal(4);
  try {
   using(FileStream file=File.Create(path)) {
    while(true) {
     stream.Read(buffer,buffer.Length,readCount);
     int read=Marshal.ReadInt32(readCount);
     if(read<=0) break;
     file.Write(buffer,0,read);
    }
   }
  } finally { Marshal.FreeHGlobal(readCount); }
 }
}
"@
$image=New-Object -ComObject IMAPI2FS.MsftFileSystemImage
$image.ChooseImageDefaultsForMediaType(13)
$image.FileSystemsToCreate=3
$image.VolumeName=$Label
$image.Root.AddTree($Source,$false)
$result=$image.CreateResultImage()
[VeacomIso]::Save($result.ImageStream,$Target)
`;

/** A file name from a series name: no path separators or characters Windows refuses, at most 80 long. */
const safeName = value => (String(value || 'VEAcom').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'VEAcom').slice(0, 80);

function registerMediaHandlers({ handle, getWindow, exportDicomDirectory, dialog: suppliedDialog, exportFolder, recordExport, sweepFolder, cancelStaging }) {
  const dialog = suppliedDialog ?? require('electron').dialog;
  const videos = createVideoExporter({
    onSaved: recordExport, onFolder: sweepFolder,
    chooseDestination: async name => {
      // Into the remembered export folder under a free name, as the other exports go; asked only without one.
      // The name comes with its extension already: it is added once.
      if (exportFolder) return exportFolder.freePath(safeName(String(name || '').replace(/\.mp4$/i, '')), '.mp4');
      const result = await dialog.showSaveDialog(getWindow(), { title: t('dialog.exportVideo'), defaultPath: name,
        filters: [{ name: t('dialog.mp4'), extensions: ['mp4'] }] });
      return result.canceled ? null : result.filePath;
    },
  });
  for (const operation of ['begin', 'configure', 'append', 'finish', 'cancel']) handle(`video:${operation}`, (...args) => videos[`${operation}Video`](...args));
  // `isoRun` is the export under way; reset() (its page crashed or reloaded) cancels it without closing the handler.
  let isoRunning = false, isoProcess = null, isoRun = null, disposed = false, isoFinished = Promise.resolve();
  handle('media:iso', async (selection, options) => {
    if (disposed) throw new Error(t('app.closing'));
    if (isoRunning) throw new Error(t('iso.alreadyRunning'));
    if (!['win32', 'darwin'].includes(process.platform)) throw new Error(t('iso.platform'));
    const seriesIds = typeof selection === 'string' ? [selection] : selection;
    if (!Array.isArray(seriesIds) || !seriesIds.length || seriesIds.length > 2000
      || seriesIds.some(id => typeof id !== 'string' || !id || id.length > 256) || !options || typeof options.anonymize !== 'boolean'
      || (options.label !== undefined && typeof options.label !== 'string')
      || (options.decompress !== undefined && typeof options.decompress !== 'boolean')
      || (options.openBurner !== undefined && typeof options.openBurner !== 'boolean')) throw new Error('Invalid ISO export options.');
    if (options.openBurner && process.platform !== 'win32') throw new Error(t('iso.burnerWindows'));
    const label = (options.label || 'VEACOM').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32) || 'VEACOM';
    isoRunning = true;
    const run = { cancelled: false };
    isoRun = run;
    const ended = () => disposed || run.cancelled;
    // A cancel from the status bar says so; closing the app says that.
    const stopIfEnded = closing => { if (run.cancelled) throw new Error(t('iso.cancelled')); if (disposed) throw new Error(closing); };
    let finishIso;
    isoFinished = new Promise(resolve => { finishIso = resolve; });
    let staging, outputDirectory, timer;
    try {
      const result = await dialog.showSaveDialog(getWindow(), { title: t('dialog.exportIso'), defaultPath: `${label}.iso`,
        filters: [{ name: t('dialog.isoFilter'), extensions: ['iso'] }] });
      if (result.canceled || !result.filePath) return null;
      stopIfEnded(t('app.closing'));
      sweepFolder?.(path.dirname(result.filePath));
      staging = await fs.mkdtemp(path.join(os.tmpdir(), 'veacom-dicom-'));
      const exported = await exportDicomDirectory([...new Set(seriesIds)], staging, options.anonymize, options.decompress ?? false, options.engineGeneration, options.full === true);
      if (exported === null) return null;
      if (!exported || typeof exported.directory !== 'string') throw new Error(t('iso.noFolder'));
      const source = await fs.realpath(exported.directory), stagingRoot = await fs.realpath(staging);
      const relative = path.relative(stagingRoot, source);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('DICOM export returned a folder outside its temporary workspace.');
      await fs.access(path.join(source, 'DICOMDIR'));
      stopIfEnded(t('app.closing'));
      outputDirectory = await fs.mkdtemp(path.join(path.dirname(result.filePath), '.veacom-iso-'));
      const partial = path.join(outputDirectory, 'study.iso');
      const script = path.join(outputDirectory, 'create-iso.ps1');
      if (process.platform === 'win32') await fs.writeFile(script, isoScript, 'utf8');
      // Checked again with nothing awaited before the launch: dispose() and reset() kill only a child that exists.
      stopIfEnded(t('app.closing'));
      isoProcess = process.platform === 'win32'
        ? launch('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', script, '-Source', source, '-Target', partial, '-Label', label])
        : launch('/usr/bin/hdiutil', ['makehybrid', '-iso', '-joliet', '-default-volume-name', label, '-o', partial, source]);
      const current = isoProcess;
      current.child.stdin.end();
      timer = setTimeout(() => current.child.kill('SIGKILL'), 30 * 60 * 1000);
      timer.unref?.();
      const completed = await current.done;
      stopIfEnded(t('iso.closed'));
      if (completed.code !== 0) throw resultError(current, completed, t('iso.failed'));
      if (!(await fs.stat(partial)).size) throw new Error(t('iso.emptyFile'));
      await fs.rename(partial, result.filePath);
      recordExport?.(result.filePath);
      const warnings = Array.isArray(exported.warnings) ? [...exported.warnings] : [];
      // The engine's warnings keep their notes for translation; this handler's own come after them.
      const warningNotes = Array.isArray(exported.warningNotes) ? exported.warningNotes : [];
      if (options.openBurner && !ended()) {
        const burner = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'isoburn.exe');
        try {
          await fs.access(burner);
          await new Promise((resolve, reject) => {
            const child = spawn(burner, [result.filePath], { windowsHide: false, detached: true, stdio: 'ignore' });
            child.once('error', reject);
            child.once('spawn', () => { child.unref(); resolve(); });
          });
        } catch (error) { warnings.push(t('iso.burnerFailed', { error: error.message })); }
      }
      return { path: result.filePath, warnings, warningNotes };
    } finally {
      clearTimeout(timer);
      isoProcess = null;
      if (isoRun === run) isoRun = null;
      // Both folders go whatever happened, and a folder that cannot go does not turn a saved ISO into an error.
      await Promise.all([staging, outputDirectory].filter(Boolean).map(removeFolder));
      isoRunning = false; finishIso();
    }
  });
  const dispose = async () => {
    disposed = true;
    isoProcess?.child.kill('SIGKILL');
    // An ISO export still waiting on its save dialog ends when the dialog does; quitting does not wait for that.
    await Promise.all([videos.dispose(), bounded(isoFinished, 5000)]);
  };
  // The page that started the exports is gone (it crashed or reloaded): stop them, and keep exporting possible.
  const cancelIso = () => { if (isoRun) { isoRun.cancelled = true; isoProcess?.child.kill('SIGKILL'); } };
  // The status bar's Cancel for a disc export: its DICOM copy stops in the engine, nothing is built from it, the burner
  // is not opened, and both temporary folders go.
  handle('media:cancel', async () => { const staging = Boolean(isoRun); cancelIso(); if (staging) await cancelStaging?.(); });
  const reset = async () => {
    cancelIso();
    await videos.reset();
  };
  return Object.assign(dispose, { reset, isExportingVideo: () => videos.active });
}

module.exports = { registerMediaHandlers, createVideoExporter, removeFolder, sweepExportLeftovers };
