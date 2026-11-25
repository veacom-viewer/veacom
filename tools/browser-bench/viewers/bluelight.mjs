// BlueLight 1.1.0: drop the folder on the page. Window/level is a tool to pick first (#WindowRevision).
import { pinned } from './pinned.mjs';

export default pinned('bluelight', {
  open: { type: 'drop', files: 'list' },
  navigationDrop: { control: '#openFile', bodyDropHandler: true, firstSlice: 0 },
  windowLevel: { button: 'left', select: '#WindowRevision' },
});
