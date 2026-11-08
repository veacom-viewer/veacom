const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

// The main process passes the saved interface language (main.cjs, additionalArguments).
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || undefined;
const locale = argument('veacom-locale');
// The packaged version, for the status bar, help and update dialog (a sandboxed preload cannot ask the app).
const version = argument('veacom-version') ?? '';
let currentLocale = locale;
// A sandboxed preload cannot load electron/i18n.cjs: its own two messages are here.
const dropMessages = {
  tr: { none: 'Bu bilgisayardan dosya ya da klasör bırakın.', notLocal: 'Yalnızca bu bilgisayardaki dosyalar içe aktarılabilir.' },
  en: { none: 'Drop local files or folders.', notLocal: 'Only files selected from this computer can be imported.' },
};
const dropMessage = key => (dropMessages[currentLocale] ?? dropMessages.tr)[key];

// Electron prefixes a handler's error with "Error invoking remote method '<channel>': Error: ". That
// prefix is English and internal; the interface shows the handler's own (translated) message.
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(error => {
  throw new Error(String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, ''));
});

contextBridge.exposeInMainWorld('veacom', {
  locale, localUsageCheck: argument('veacom-local-usage-check') === '1',
  setLocale: value => { if (dropMessages[value]) currentLocale = value; return invoke('app:locale', value); },
  listSeries: () => invoke('imaging:series'),
  importSelected: capabilities => invoke('imaging:import', capabilities),
  getProgress: () => invoke('imaging:progress'),
  importEarly: (capabilities, after) => invoke('imaging:early', capabilities, after),
  cancelOperation: id => invoke('imaging:cancel', id),
  cancelExport: () => invoke('dicom:cancel'),
  measure: (id, generation, revision, operation) => invoke('imaging:measure', id, generation, revision, operation),
  getTags: (seriesId, generation, frame, revision) => invoke('imaging:tags', seriesId, generation, frame, revision),
  removeSeries: (ids, generation) => invoke('imaging:remove', ids, generation),
  getPixels: request => invoke('imaging:pixels', request),
  takeStartupPaths: () => invoke('files:startup'),
  getCoreState: () => invoke('core:state'),
  getGraphicsStatus: () => invoke('gpu:status'),
  // Page zoom (View > Zoom In/Out) shrinks a wheel notch's legacy units; wheelSliceSteps undoes it.
  zoomFactor: () => webFrame.getZoomFactor(),
  onCoreState: listener => { const notify = (_event, state) => listener(state); ipcRenderer.on('core:state', notify); return () => ipcRenderer.removeListener('core:state', notify); },
  openPaths: kind => invoke('files:open', kind),
  // The import window runs in a view of its own (import-view.cjs): this page cannot list folders or name paths.
  openImportWindow: start => invoke('files:import-window', start),
  onImportAction: listener => { const notify = (_event, id, input) => listener(id, input); ipcRenderer.on('import:action', notify); return () => ipcRenderer.removeListener('import:action', notify); },
  importFiles: files => {
    if (!Array.isArray(files) || !files.length || files.length > 4096) return Promise.reject(new Error(dropMessage('none')));
    const paths = files.map(file => webUtils.getPathForFile(file));
    if (paths.some(value => !value)) return Promise.reject(new Error(dropMessage('notLocal')));
    return invoke('files:drop-capabilities', paths);
  },
  openExternal: url => invoke('links:open', url),
  saveFile: (suggestedName, data) => invoke('files:save', suggestedName, data),
  exportDicom: (seriesId, options) => invoke('dicom:export', seriesId, options),
  sendFeedback: payload => invoke('feedback:send', payload),
  estimateExport: (seriesId, options) => invoke('dicom:estimate', seriesId, options),
  beginVideo: (name, fps) => invoke('video:begin', name, fps),
  configureVideo: (id, settings) => invoke('video:configure', id, settings),
  appendVideo: (id, sample, key) => invoke('video:append', id, sample, key),
  finishVideo: id => invoke('video:finish', id),
  cancelVideo: id => invoke('video:cancel', id),
  beginImages: (name, here) => invoke('images:begin', name, here),
  exportFolder: () => invoke('export:folder'),
  copyText: text => invoke('clipboard:write', text),
  chooseExportFolder: () => invoke('export:chooseFolder'),
  revealExport: target => invoke('export:reveal', target),
  appendImage: (id, name, data) => invoke('images:append', id, name, data),
  finishImages: id => invoke('images:finish', id),
  cancelImages: id => invoke('images:cancel', id),
  exportIso: (seriesId, options) => invoke('media:iso', seriesId, options),
  cancelIso: () => invoke('media:cancel'),
  getAiConfig: () => invoke('ai:config'),
  configureAi: settings => invoke('ai:configure', settings),
  askSecondOpinion: request => invoke('ai:ask', request),
  getVersion: () => version,
  getUpdateStatus: () => invoke('updates:status'),
  checkForUpdates: () => invoke('updates:check'),
  downloadUpdate: () => invoke('updates:download'),
  installUpdate: () => invoke('updates:install'),
  openUpdateNotes: () => invoke('updates:notes'),
  onUpdateStatus: listener => { const notify = (_event, status) => listener(status); ipcRenderer.on('updates:status', notify); return () => ipcRenderer.removeListener('updates:status', notify); },
  // Usage timings (electron/usage.cjs): consent, and events the main process checks again before keeping them.
  usageStatus: () => invoke('usage:status'),
  usageConsent: value => invoke('usage:consent', value),
  usageRecord: events => invoke('usage:record', events),
  usageFinal: events => ipcRenderer.send('usage:final', events),
  usageMachine: machine => invoke('usage:machine', machine),
});
