// The browser build's entry (web.html): the page's Trusted Types policy first, then the bridge to the engine Worker,
// then the same application the desktop window runs.
import { installTrustedTypes } from './trusted-types';
import { createWebBridge, watchDrops } from './bridge';

installTrustedTypes();
watchDrops();
window.veacom = createWebBridge();
performance.mark('veacom:bridge-ready');
await import('../main');
performance.mark('veacom:application-loaded');
