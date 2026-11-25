// The browser build's entry (web.html): the page's Trusted Types policy first, then the bridge to the engine Worker,
// then the same application the desktop window runs.
import { installTrustedTypes } from './trusted-types';
import { createWebBridge, watchDrops } from './bridge';

performance.mark('startup:bridge-start');
installTrustedTypes();
watchDrops();
window.veacom = createWebBridge();
performance.mark('startup:bridge-created');
let sawOpenControl = false;
const observeOpening = new MutationObserver(() => {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="welcome-open-folder"]');
  if (!button) return;
  if (!sawOpenControl) { sawOpenControl = true; performance.mark('startup:opener-mounted'); }
  if (!button.disabled) {
    performance.mark('startup:opener-enabled');
    observeOpening.disconnect();
    requestAnimationFrame(() => performance.mark('startup:next-paint-opportunity'));
  }
});
observeOpening.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
await import('../main');
performance.mark('startup:reader-imported');
