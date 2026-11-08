import { sliceRenderer } from '../src/imaging/sliceRenderer.ts';
import { t } from '../src/i18n/index.ts';

// Run before the pixel suites, with a fresh renderer and real WebGL compilation.
export async function verifyShaderSetup() {
  const renderer = sliceRenderer(), gl = renderer.gl, results = [], calls = [], shaders = [], programs = [];
  const originals = new Map();
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  let fault = null, holdCompletion = false, linkChecks = 0;
  const record = (name, passed, detail) => results.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  const count = method => calls.filter(call => call === method).length;
  const metadata = { id: 'shader-setup', uid: '', studyUid: '', patientId: 'SYNTHETIC', patientName: 'Shader setup',
    studyDate: '', description: '', modality: 'CT', seriesNumber: 1, dimensions: [2, 2, 1], spacing: [1, 1, 1],
    origin: [0, 0, 0], direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 128, windowWidth: 256,
    valueUnit: 'HU', suvFactor: null, canReconstruct: true, warnings: [], components: 1, photometricInterpretation: 'MONOCHROME2' };
  const volume = Constructor => ({ series: { ...metadata }, data: new Constructor([0, 64, 128, 255]) });
  const view = { mode: 'source', plane: 'axial', slice: 0, windowCenter: 128, windowWidth: 256,
    zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false };
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
  const pixels = () => [...canvas.getContext('2d').getImageData(0, 0, 2, 2).data];
  const exact = () => pixels().every((value, index) => value === (index % 4 === 3 ? 255 : [0, 64, 128, 255][Math.floor(index / 4)]));
  const errorFrom = action => { try { action(); return ''; } catch (error) { return String(error.message); } };
  const event = name => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { renderer.canvas.removeEventListener(name, done); reject(new Error(`Timed out waiting for ${name}`)); }, 5000);
    const done = () => { clearTimeout(timer); resolve(); };
    renderer.canvas.addEventListener(name, done, { once: true });
  });
  for (const method of ['createShader', 'createProgram', 'shaderSource', 'compileShader', 'linkProgram', 'getShaderParameter', 'getProgramParameter', 'drawArrays']) {
    const original = gl[method]; originals.set(method, original);
    gl[method] = function (...args) {
      calls.push(method);
      if (method === 'getProgramParameter') {
        if (args[1] === gl.LINK_STATUS) linkChecks++;
        if (holdCompletion && args[1] === parallel?.COMPLETION_STATUS_KHR) return false;
      }
      if (method === 'shaderSource' && args[1].includes('out vec4 outColor;')) {
        if (fault === 'compile') args[1] += '\ninvalid_shader_syntax';
        if (fault === 'link') args[1] = args[1].replace('void main() {', 'in vec4 missingVarying;\nvoid main() {').replaceAll('outColor=', 'outColor=missingVarying+');
      }
      const result = original.apply(this, args);
      if (method === 'createShader') shaders.push(result);
      if (method === 'createProgram') programs.push(result);
      return result;
    };
  }
  try {
    const source = volume(Uint8Array);
    renderer.setVisibleViews([{ volume: source, view }, { volume: source, view }]);
    record('Visible panes share one program and start both shaders before linking', count('compileShader') === 2 && count('linkProgram') === 1
      && calls.lastIndexOf('compileShader') < calls.indexOf('linkProgram'));
    record('Preparing visible programs does not wait on status or draw unchecked pixels', count('getShaderParameter') === 0 && count('getProgramParameter') === 0 && count('drawArrays') === 0);
    renderer.render(canvas, source, view);
    record('The first draw follows a successful link check', count('getProgramParameter') === 1 && calls.indexOf('getProgramParameter') < calls.indexOf('drawArrays'));
    record('Successful linking needs no separate shader-status waits', count('getShaderParameter') === 0);
    record('Prepared source pixels are exact', exact());
    record('Successful linking releases both shader objects', shaders.length === 2 && shaders.every(shader => !gl.isShader(shader)));
    renderer.render(canvas, source, view);
    record('Subsequent frames reuse the validated program', count('compileShader') === 2 && count('getProgramParameter') === 1 && exact());

    for (const [kind, Constructor, message] of [['compile', Float32Array, 'gpu.shaderFailed'], ['link', Uint16Array, 'gpu.programFailed']]) {
      const input = volume(Constructor), firstShader = shaders.length, firstProgram = programs.length, draws = count('drawArrays');
      const previous = pixels();
      fault = kind;
      renderer.setVisibleViews([{ volume: input, view }]);
      const error = errorFrom(() => renderer.render(canvas, input, view));
      record(`${kind} failure reports the original diagnostic`, error.startsWith(t(message, { error: '' })) && error.length > t(message, { error: '' }).length, error);
      record(`${kind} failure never draws an unchecked frame`, count('drawArrays') === draws && pixels().every((value, index) => value === previous[index]));
      record(`${kind} failure deletes shaders and the failed program`, shaders.slice(firstShader).every(shader => !gl.isShader(shader))
        && programs.slice(firstProgram).every(program => !gl.isProgram(program)));
      fault = null;
      renderer.setVisibleViews([{ volume: input, view }]); renderer.render(canvas, input, view);
      record(`${kind} failure can be retried with a fresh program`, exact() && programs.length === firstProgram + 2);
    }

    const asyncInput = volume(Int16Array), checksBeforePreparation = linkChecks;
    holdCompletion = true;
    const preparing = renderer.prepareSource(asyncInput);
    if (parallel) {
      record('Concurrent loads share one preparation promise', preparing === renderer.prepareSource(asyncInput));
      let settled = false; preparing.then(() => { settled = true; });
      for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
      record('Animation frames continue while shader readiness is pending', !settled);
    }
    holdCompletion = false;
    await preparing;
    record('Preparation defers link validation until drawing', linkChecks === checksBeforePreparation);
    renderer.render(canvas, asyncInput, view);
    record('Prepared program is validated and draws exact pixels', linkChecks === checksBeforePreparation + 1 && exact());

    const loss = gl.getExtension('WEBGL_lose_context');
    record('GPU context-loss probe is available', loss);
    if (loss) {
      const input = { series: { ...metadata, components: 3 }, data: new Uint8Array([0, 0, 0, 64, 64, 64, 128, 128, 128, 255, 255, 255]) };
      holdCompletion = true;
      const pending = renderer.prepareSource(input);
      const lost = event('webglcontextlost'); loss.loseContext();
      record('Context loss between setup and drawing rejects the frame', errorFrom(() => renderer.render(canvas, input, view)) === t('gpu.contextLost'));
      await lost;
      await pending;
      holdCompletion = false;
      record('Context loss settles pending preparation', gl.isContextLost());
      // Restoration is permitted only after the entire lost-event dispatch has finished.
      await new Promise(resolve => setTimeout(resolve, 0));
      const restored = event('webglcontextrestored'); loss.restoreContext(); await restored;
      const before = count('createProgram');
      renderer.setVisibleViews([{ volume: input, view }]); renderer.render(canvas, input, view);
      record('Restored context rebuilds the program and preserves exact pixels', count('createProgram') === before + 1 && exact());
      record('Recovery leaves no WebGL error', gl.getError() === gl.NO_ERROR);
    }
    if (parallel) {
      const input = volume(Float32Array), started = performance.now();
      holdCompletion = true;
      await renderer.prepareSource(input);
      record('A stalled completion query falls back after a bounded wait', performance.now() - started >= 1000);
      holdCompletion = false;
      renderer.render(canvas, input, view);
      record('The bounded fallback still validates and renders exact pixels', exact());
    }
    renderer.setVisibleViews([]);
  } finally {
    for (const [method, original] of originals) gl[method] = original;
  }
  return { passed: results.every(result => result.passed), checks: results.length, failures: results.filter(result => !result.passed), results };
}
