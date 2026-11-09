// VEAcom's browser build. `dist` is a dist-web folder (pnpm run build:browser); tools/browser-bench/run.mjs takes it from --veacom,
// or from the repository's own dist-web.
import { serveVeacom } from '../lib/serve.mjs';

export default {
  name: 'veacom',
  serve: ({ dist, isolation = true }) => serveVeacom(dist, { isolation }),
  // A dropped folder lands anywhere on the page.
  drop: null,
  // The left button sets the window by default; dragging right widens it.
  windowLevel: { button: 'left' },
};
