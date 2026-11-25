// The browser build's entry (web.html): the page's Trusted Types policy first, then the bridge to the engine Worker,
// then the same application the desktop window runs.
import { installTrustedTypes } from './trusted-types';
import { createWebBridge, watchDrops } from './bridge';

performance.mark('startup:bridge-start');
installTrustedTypes();
watchDrops();
window.veacom = createWebBridge();
performance.mark('startup:bridge-created');
await import('../main');
performance.mark('startup:reader-imported');
