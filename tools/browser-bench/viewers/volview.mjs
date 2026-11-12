// Kitware VolView 4.5.3. A folder dropped on it is ignored, and so is a drop from the DevTools protocol even of files,
// so the study's files are given to the chooser its "Click to open local files." opens. It shows a four-pane layout
// (three planes and 3D). The left button sets window/level.
import { pinned } from './pinned.mjs';

export default pinned('volview', {
  open: { type: 'chooser', clickText: 'Click to open local files.', folder: false },
  windowLevel: { button: 'left' },
});
