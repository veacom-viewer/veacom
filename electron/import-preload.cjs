// The import window's preload (import-view.cjs): the only bridge to the folder browser. The application window's
// preload (preload.cjs) has none of these functions, so the application page cannot list folders or choose paths.
const { contextBridge, ipcRenderer } = require('electron');

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || undefined;
// The window shows the handler's own (translated) message, not Electron's English prefix.
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(error => {
  throw new Error(String(error?.message ?? error).replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, ''));
});

contextBridge.exposeInMainWorld('veacomImport', {
  locale: argument('veacom-locale'),
  start: argument('veacom-import-start'),
  places: () => invoke('importview:places'),
  browse: folder => invoke('importview:browse', folder),
  open: paths => invoke('importview:open', paths),
  close: () => invoke('importview:close'),
  action: (id, input) => ipcRenderer.send('importview:action', id, input),
});
