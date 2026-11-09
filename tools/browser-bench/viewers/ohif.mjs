// OHIF 3.13.14, its local-files page (/localbasic): drop a folder on the page. The left button sets window/level.
import { pinned } from './pinned.mjs';

export default pinned('ohif', {
  open: { type: 'drop' },
  windowLevel: { button: 'left' },
});
