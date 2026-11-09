// PlexusMD, the live site (not pinned: see tools/browser-bench/viewers.json). Drop the folder on the page; W picks window/level.
import { pinned } from './pinned.mjs';

export default pinned('plexusmd', {
  open: { type: 'drop' },
  windowLevel: { button: 'left', key: 'W' },
});
