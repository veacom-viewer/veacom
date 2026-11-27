// VEAcom's browser build. `dist` is a dist-web folder (pnpm run build:browser); tools/browser-bench/run.mjs takes it from --veacom,
// or from the repository's own dist-web.
import { serveVeacom } from '../lib/serve.mjs';

export default {
  name: 'veacom',
  serve: ({ dist, isolation = true }) => serveVeacom(dist, { isolation }),
  // A dropped folder lands anywhere on the page.
  drop: null,
  navigationDrop: { control: '[data-testid="welcome-open-folder"]', firstSlice: 0 },
  // The left button sets the window by default; dragging right widens it.
  windowLevel: { button: 'left' },
  mpr: { open: '[data-testid="tool-mpr"]', ready: 'canvas[data-mode="mpr"]', panes: 3 },
};
