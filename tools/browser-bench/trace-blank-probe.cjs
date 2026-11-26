const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
const blankFirst = process.argv.at(-1) === 'blank-first';
let stage = 'start';
const mark = name => { stage = name; console.log('trace-probe', blankFirst, name); };
const timer = setTimeout(() => { console.log('trace-probe timeout', blankFirst, stage); app.exit(3); }, 12000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, focusable: false, skipTaskbar: true,
    webPreferences: {backgroundThrottling:false, partition:'trace-probe'} });
  win.setAlwaysOnTop(true, 'floating'); win.setIgnoreMouseEvents(true); win.showInactive();
  if (blankFirst) {mark('load initial blank'); await win.loadURL('about:blank');}
  const debug=win.webContents.debugger;
  mark('attach'); debug.attach('1.3');
  mark('register script'); await debug.sendCommand('Page.addScriptToEvaluateOnNewDocument', {source:'window.traceProbe=17'});
  mark('start trace'); await debug.sendCommand('Tracing.start', {transferMode:'ReportEvents',traceConfig:{includedCategories:['blink.user_timing','disabled-by-default-devtools.screenshot'],excludedCategories:['*']}});
  mark('navigate'); await win.loadURL('data:text/html,<p>trace probe</p>');
  mark('evaluate'); const answer=await win.webContents.executeJavaScript('window.traceProbe');
  if(answer!==17) throw new Error('Initialization script was missing.');
  mark('stop'); const finished=new Promise(resolve=>debug.on('message',(_event,method)=>{if(method==='Tracing.tracingComplete')resolve();}));
  await debug.sendCommand('Tracing.end'); await finished;
  mark('complete'); clearTimeout(timer); win.destroy(); app.exit(0);
}).catch(error=>{console.error(String(error)); app.exit(1);});
