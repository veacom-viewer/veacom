// DWV 0.36.4's demo page: no drop and no folder picker, so the study's files go to its file input. Its default tool
// scrolls with the left button; window/level is a tool to pick first.
import { pinned } from './pinned.mjs';

export default pinned('dwv', {
  open: { type: 'input', selector: '#fileinput', folder: false },
  windowLevel: { button: 'left', select: 'input[name=tools][title=WindowLevel]' },
});
