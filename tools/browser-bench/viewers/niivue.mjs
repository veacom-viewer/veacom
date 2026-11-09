// NiiVue with dcm2niix (official demo): the folder goes to its folder input, which converts it to NIfTI first. The
// demo then selects the first file dcm2niix wrote, the JSON sidecar, so a user picks the volume from its list; the
// adapter does that the moment the list appears, so the time to the first image includes the conversion. The demo
// shows a multiplanar layout and has no window/level drag.
import { pinned } from './pinned.mjs';

export default pinned('niivue', {
  open: { type: 'input', selector: '#fileInput', folder: true },
  afterOpen: ({ js }) => js(`new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setInterval(() => {
      const select = document.getElementById('fileSelect'), option = [...select.options].find(o => /\\.nii(\\.gz)?$/.test(o.text));
      if (option) { clearInterval(timer); select.value = option.value; select.dispatchEvent(new Event('change')); resolve(option.text); }
      else if (performance.now() - started > 60000) { clearInterval(timer); reject(new Error('dcm2niix wrote no volume')); }
    }, 10);
  })`),
  windowLevel: null,
});
