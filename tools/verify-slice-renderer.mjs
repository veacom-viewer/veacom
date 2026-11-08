import { sliceRenderer, sourceFrameOnly } from '../src/imaging/sliceRenderer.ts';
import { t } from '../src/i18n/index.ts';

// Run in a browser served by Vite; renderer-check.html provides a standalone entry point.
export function verifySliceRenderer() {
  const renderer = sliceRenderer(), gl = renderer.gl;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const runId = `gpu-check-${performance.now()}`;
  const series = { id: '', uid: '', studyUid: '', patientId: '', patientName: '', studyDate: '', description: '',
    modality: 'CT', seriesNumber: 1, dimensions: [2, 2, 2], spacing: [1, 1, 1], origin: [0, 0, 0],
    direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], windowCenter: 0, windowWidth: 401, valueUnit: 'HU',
    suvFactor: null, canReconstruct: true, warnings: [], photometricInterpretation: 'MONOCHROME2', components: 1 };
  const view = { mode: 'mpr', plane: 'axial', slice: 0, windowCenter: 0, windowWidth: 401, zoom: 1, pan: [0, 0],
    rotation: 0, flipX: false, flipY: false, inverted: false };
  const calibratedPet = { modality: 'PT', valueUnit: 'SUVbw', suvFactor: 1 };
  const types = [
    ['float64', Float64Array, 42.25000000001, 0, 401, gl.R32F],
    ['float32', Float32Array, 42.25, 0, 401, gl.R32F],
    ['int16', Int16Array, -100, 0, 401, gl.R16I],
    ['uint16', Uint16Array, 60000, 32768, 65536, gl.R16UI],
    ['uint8', Uint8Array, 200, 128, 256, gl.R8UI],
  ];
  const results = [], expectedUploads = new WeakMap(), expectedFloat64Copies = [], expectedFrameViews = [], uploads = [], voiUploads = [];
  const originalUpload3D = gl.texImage3D, originalUpload2D = gl.texImage2D;
  const recordUpload = (dimension, args) => {
    // Padding metadata has its own small RGBA32F texture; these assertions cover image pixels.
    if (args[2] === gl.RGBA32F) return;
    // VOI LUT tables use their own texture unit and are checked separately.
    if (gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE4) { voiUploads.push({ internalFormat: args[2], dimensions: [args[3], args[4]], array: args[8]?.constructor.name }); return; }
    const data = args[dimension === '3d' ? 9 : 8], expectedFormat = expectedUploads.get(data);
    const frameSource = expectedFrameViews.find(frame => data.buffer === frame.source.buffer
      && data.constructor === frame.source.constructor && data.byteOffset === frame.source.byteOffset + frame.offset * frame.source.BYTES_PER_ELEMENT
      && data.length === frame.length);
    const convertedSource = data instanceof Float32Array ? expectedFloat64Copies.find(copy => !copy.uploaded
      && copy.source.length === data.length && data.every((value, index) => Object.is(value, Math.fround(copy.source[index])))) : undefined;
    if (convertedSource) convertedSource.uploaded = true;
    uploads.push({ target: dimension, array: data.constructor.name, bytes: data.byteLength,
      dimensions: dimension === '3d' ? [args[3], args[4], args[5]] : [args[3], args[4]], internalFormat: args[2],
      originalBuffer: expectedFormat !== undefined && !(data instanceof Float64Array),
      sourceFrameView: frameSource !== undefined && !(data instanceof Float64Array),
      convertedFloat64: convertedSource !== undefined,
      correctFormat: (expectedFormat ?? frameSource?.format ?? convertedSource?.format) === args[2] });
  };
  gl.texImage3D = function (...args) { recordUpload('3d', args); return originalUpload3D.apply(this, args); };
  gl.texImage2D = function (...args) { recordUpload('2d', args); return originalUpload2D.apply(this, args); };
  const volume = (name, data, meta = {}, format = gl.R32F) => {
    expectedUploads.set(data, format);
    if (data instanceof Float64Array && (meta.dimensions?.[2] ?? 2) <= renderer.info.max3DTextureSize) expectedFloat64Copies.push({ source: data, format, uploaded: false });
    return { series: { ...series, ...meta, id: `${runId}:${name}` }, data };
  };
  const check = (name, expected, x = Math.floor(canvas.width / 2), y = Math.floor(canvas.height / 2)) => {
    const actual = [...canvas.getContext('2d').getImageData(x, y, 1, 1).data], error = gl.getError();
    const passed = error === gl.NO_ERROR && actual.every((v, i) => Math.abs(v - expected[i]) <= 1);
    results.push({ name, passed, actual, expected, glError: error });
  };
  const rejects = (name, action, text) => {
    let error = '';
    try { action(); } catch (e) { error = String(e.message); }
    results.push({ name, passed: error.includes(text), error });
  };
  try {
    for (const [kind, Ctor, value, center, width, format] of types) {
      const main = volume(`main-${kind}`, new Ctor(8).fill(value), { pixelType: kind }, format);
      renderer.render(canvas, main, { ...view, windowCenter: center, windowWidth: width });
      const grey = Math.round(255 * Math.min(1, Math.max(0, (value - (center - 0.5)) / (width - 1) + 0.5)));
      check(`${kind}: windowed scalar`, [grey, grey, grey, 255]);
      for (const [petKind, PetCtor, , , , petFormat] of types) {
        const pet = volume(`pet-${petKind}`, new PetCtor(8).fill(2), { pixelType: petKind, ...calibratedPet }, petFormat);
        renderer.render(canvas, main, view, { volume: pet, opacity: 1, upperSuv: 4, palette: 'hot' });
        check(`${kind}/${petKind}: fusion shader`, [255, 153, 0, 255]);
      }
    }
    canvas.width = canvas.height = 1;
    for (const [kind, Ctor, , , , format] of types) {
      const offset = kind === 'int16' ? -112 : kind === 'float32' || kind === 'float64' ? 0.25 : 0;
      const main = volume(`gradient-${kind}`, new Ctor([0, 16, 32, 48, 64, 80, 96, 112].map(n => n + offset)), { pixelType: kind }, format);
      // At the cube centre, the eight known corner values average to 56 + offset.
      renderer.render(canvas, main, { ...view, slice: 0.5, windowCenter: 128 + offset, windowWidth: 256 });
      check(`${kind}: trilinear interpolation`, [56, 56, 56, 255]);
    }
    const preciseValue = 42.25000000001;
    const preciseSource = new Float64Array(8).fill(preciseValue);
    const precise = volume('float64-cache', preciseSource, { pixelType: 'float64' });
    const uploadsBefore = uploads.length;
    renderer.render(canvas, precise, view);
    check('Float64 display approximation', [155, 155, 155, 255]);
    renderer.render(canvas, precise, { ...view, inverted: true });
    check('Float64 cached display updates without another upload', [100, 100, 100, 255]);
    const preciseUploads = uploads.slice(uploadsBefore);
    results.push({ name: 'Float64 quantitative source remains exact',
      passed: preciseSource.every(value => value === preciseValue) && preciseSource[0] !== Math.fround(preciseValue) });
    results.push({ name: 'Float64 display uploads four bytes per pixel once and reuses the texture for presentation changes',
      passed: preciseUploads.length === 1 && preciseUploads[0].target === '3d' && preciseUploads[0].convertedFloat64
        && preciseUploads[0].bytes === preciseSource.length * 4 && preciseUploads[0].internalFormat === gl.R32F,
      uploads: preciseUploads });
    const scalar = volume('fusion-patient-space', new Int16Array(8), { pixelType: 'int16' }, gl.R16I);
    const displacedPet = volume('displaced-pet', new Float32Array(8).fill(2), { origin: [20, 0, 0], ...calibratedPet });
    renderer.render(canvas, scalar, view, { volume: displacedPet, opacity: 1, upperSuv: 4, palette: 'hot' });
    check('PET outside patient-space extent does not overlay', [128, 128, 128, 255]);
    const mono1 = volume('mono1', new Int16Array(8).fill(-100), { pixelType: 'int16', photometricInterpretation: 'MONOCHROME1' }, gl.R16I);
    renderer.render(canvas, mono1, view);
    check('MONOCHROME1 presentation', [191, 191, 191, 255]);
    for (const [palette, expected] of [['hot',[255,153,0,255]],['ge',[255,128,0,255]],['rainbow',[128,255,128,255]]]) {
      renderer.render(canvas, scalar, { ...view, windowCenter:0.5, palette });
      check(`Standalone ${palette} palette`, expected);
    }
    // A PET without SUV is drawn on its own values (src/imaging/fusion.ts): its 99.5th percentile, here 2 Bq/ml, sits
    // where SUV 5 would, so a scale top of 10 puts it halfway up the palette.
    const uncalibratedPet = volume('uncalibrated-pet', new Float32Array(8).fill(2), { modality: 'PT', valueUnit: 'BQML', suvFactor: null });
    renderer.render(canvas, scalar, view, { volume: uncalibratedPet, opacity: 1, upperSuv: 10, palette: 'hot' });
    check('PET without SUV fuses on its own relative scale', [255, 153, 0, 255]);
    const refusedGml = volume('uncalibrated-gml', new Float32Array(8).fill(2), { ...calibratedPet, suvFactor: null });
    renderer.render(canvas, scalar, view, { volume: refusedGml, opacity: 1, upperSuv: 10, palette: 'hot' });
    check('A GML label without a calibration factor also uses the relative scale', [255, 153, 0, 255]);

    const longDepth = renderer.info.max3DTextureSize + 1;
    for (const [kind, Ctor, format] of [['int16', Int16Array, gl.R16I], ['float64', Float64Array, gl.R32F]]) {
      const data = new Ctor(4 * longDepth).fill(100);
      data.fill(25, 0, 4);
      data.fill(200, data.length - 4);
      const long = volume(`long-${kind}`, data, { pixelType: kind, dimensions: [2, 2, longDepth],
        origin: [10, 20, 30], spacing: [1, 1, 2], direction: [1, 0, 0, 0, 0, -1, 0, 1, 0] }, format);
      const before = uploads.length;
      for (const [slice, expected] of [[0, 25], [longDepth - 1, 200]]) {
        const frame = { source: data, offset: slice * 4, length: 4, format };
        expectedFrameViews.push(frame);
        if (data instanceof Float64Array) expectedFloat64Copies.push({ source: data.subarray(frame.offset, frame.offset + frame.length), format, uploaded: false });
        renderer.render(canvas, long, { ...view, mode: 'source', slice, windowCenter: 128, windowWidth: 256 });
        check(`${kind}: oversized stack source frame ${slice}`, [expected, expected, expected, 255]);
      }
      renderer.render(canvas, long, { ...view, mode: 'source', slice: longDepth - 1, windowCenter: 128, windowWidth: 256, inverted: true });
      check(`${kind}: oversized stack cached source frame`, [55, 55, 55, 255]);
      const frameUploads = uploads.slice(before);
      const expectedBytes = 4 * (kind === 'float64' ? 4 : Ctor.BYTES_PER_ELEMENT);
      results.push({ name: `${kind}: long stack uploads only two requested frames and reuses the current frame`,
        passed: sourceFrameOnly(long) && sourceFrameOnly(long, renderer.info.max3DTextureSize) && frameUploads.length === 2
          && frameUploads.every(upload => upload.target === '2d' && upload.dimensions.join(',') === '2,2' && upload.bytes === expectedBytes)
          && data.slice(0, 4).every(value => value === 25) && data.slice(-4).every(value => value === 200),
        uploads: frameUploads });
      rejects(`${kind}: long-stack MPR refused`, () => renderer.render(canvas, long, { ...view, plane: 'coronal' }), t('gpu.mprLimit', { limit: renderer.info.max3DTextureSize }));
      rejects(`${kind}: long-stack oblique refused`, () => renderer.render(canvas, long, { ...view, oblique: [5, 0] }), t('gpu.mprLimit', { limit: renderer.info.max3DTextureSize }));
      rejects(`${kind}: long-stack volume fusion refused`, () => renderer.render(canvas, long, view, { volume: displacedPet, opacity: 1, upperSuv: 4, palette: 'hot' }), t('gpu.mprLimit', { limit: renderer.info.max3DTextureSize }));
      const longPet = { ...long, series: { ...long.series, ...calibratedPet } };
      rejects(`${kind}: oversized PET fusion refused`, () => renderer.render(canvas, scalar, view, { volume: longPet, opacity: 1, upperSuv: 4, palette: 'hot' }), t('gpu.fusionLimit', { limit: renderer.info.max3DTextureSize }));
    }

    for (const [kind, Ctor] of [['float32', Float32Array], ['float64', Float64Array]]) {
      const values = [128, NaN, Infinity, -Infinity], data = new Ctor(values);
      const padded = volume(`padding-${kind}`, data, { pixelType: kind, dimensions: [2, 2, 1] });
      const paddingView = { ...view, windowCenter: 128, windowWidth: 256 };
      canvas.width = canvas.height = 2;
      renderer.render(canvas, padded, paddingView);
      for (let i = 0; i < 4; i++) {
        const grey = i === 0 ? 128 : 0;
        check(`${kind}: native padding pixel ${i}`, [grey, grey, grey, 255], i % 2, Math.floor(i / 2));
      }
      canvas.width = canvas.height = 8;
      renderer.render(canvas, padded, paddingView);
      for (const [x, y, grey] of [[3, 3, 128], [4, 3, 0], [3, 4, 0], [4, 4, 0]]) {
        check(`${kind}: scaled padding region ${x},${y}`, [grey, grey, grey, 255], x, y);
      }
      results.push({ name: `${kind}: source NaN and infinities stay unchanged`, passed: data.every((value, i) => Object.is(value, values[i])) });

      const gradient = volume(`padding-gradient-${kind}`, new Ctor([0, 100, NaN, 200]), { pixelType: kind, dimensions: [2, 2, 1] });
      canvas.width = canvas.height = 4;
      renderer.render(canvas, gradient, paddingView);
      // At (.25,.25), valid weights are .5625, .1875, .0625: (100*.1875+200*.0625)/.8125 = 38.4615.
      check(`${kind}: finite interpolation weights are renormalized`, [38, 38, 38, 255], 1, 1);

      const paddedPet = volume(`padding-pet-${kind}`, new Ctor([2, NaN, Infinity, -Infinity]),
        { pixelType: kind, dimensions: [2, 2, 1], ...calibratedPet });
      canvas.width = canvas.height = 2;
      renderer.render(canvas, scalar, view, { volume: paddedPet, opacity: 1, upperSuv: 4, palette: 'hot' });
      check(`${kind}: finite PET pixel survives invalid neighbors`, [255, 153, 0, 255], 0, 0);
      check(`${kind}: invalid nearest PET pixel leaves base image visible`, [128, 128, 128, 255], 1, 0);
    }

    // VOI LUTs on a source frame: the nearest entry, clamped at both ends, over 2^bits - 1; tables longer than
    // one 4096-entry texture row continue on the next row.
    canvas.width = canvas.height = 2;
    const voiData = new Int16Array([-5, 0, 1, 9]);
    const long = Array(5000).fill(0); long[4500] = 255; long[4501] = 128;
    const voiVolume = volume('voi-lut', voiData, { pixelType: 'int16', dimensions: [2, 2, 1],
      voiLuts: [{ first: -1, bits: 8, data: [10, 20, 200, 250] }, { first: 4500, bits: 16, data: [0, 65535] }, { first: 0, bits: 8, data: long }] }, gl.R16I);
    expectedFrameViews.push({ source: voiData, offset: 0, length: 4, format: gl.R16I });
    renderer.render(canvas, voiVolume, { ...view, mode: 'source', slice: 0, voiLut: 0 });
    [10, 20, 200, 250].forEach((grey, i) => check(`VOI LUT pixel ${i}`, [grey, grey, grey, 255], i % 2, Math.floor(i / 2)));
    renderer.render(canvas, voiVolume, { ...view, mode: 'source', slice: 0, voiLut: 0, inverted: true });
    check('Inverted VOI LUT pixel', [245, 245, 245, 255], 0, 0);
    renderer.render(canvas, voiVolume, { ...view, mode: 'source', slice: 0, windowCenter: 2, windowWidth: 8 });
    check('Window without a VOI LUT', [0, 0, 0, 255], 0, 0);
    const shifted = volume('voi-lut-rows', new Int16Array([4500, 4501, 0, 4999]), { pixelType: 'int16', dimensions: [2, 2, 1], voiLuts: voiVolume.series.voiLuts }, gl.R16I);
    expectedFrameViews.push({ source: shifted.data, offset: 0, length: 4, format: gl.R16I });
    renderer.render(canvas, shifted, { ...view, mode: 'source', slice: 0, voiLut: 2 });
    [255, 128, 0, 0].forEach((grey, i) => check(`VOI LUT second texture row pixel ${i}`, [grey, grey, grey, 255], i % 2, Math.floor(i / 2)));
    renderer.render(canvas, shifted, { ...view, mode: 'source', slice: 0, voiLut: 1 });
    [0, 255, 0, 255].forEach((grey, i) => check(`16-bit VOI LUT pixel ${i}`, [grey, grey, grey, 255], i % 2, Math.floor(i / 2)));
    // Window curves (VOI LUT Function) on a source frame: SIGMOID 1/(1+exp(-4(x-c)/w)) and LINEAR_EXACT
    // ((x-c)/w+0.5), against the same window drawn LINEAR; reconstructed planes ignore the curve.
    const curve = volume('voi-function', new Int16Array([0, 100, 150, 400]), { pixelType: 'int16', dimensions: [2, 2, 1] }, gl.R16I);
    expectedFrameViews.push({ source: curve.data, offset: 0, length: 4, format: gl.R16I });
    const sigmoid = value => Math.round(255 / (1 + Math.exp(-4 * (value - 100) / 200)));
    renderer.render(canvas, curve, { ...view, mode: 'source', slice: 0, windowCenter: 100, windowWidth: 200, voiFunction: 'SIGMOID' });
    [0, 100, 150, 400].forEach((value, i) => check(`SIGMOID window pixel ${i}`, [sigmoid(value), sigmoid(value), sigmoid(value), 255], i % 2, Math.floor(i / 2)));
    renderer.render(canvas, curve, { ...view, mode: 'source', slice: 0, windowCenter: 100, windowWidth: 200, voiFunction: 'LINEAR_EXACT' });
    [0, 128, 191, 255].forEach((grey, i) => check(`LINEAR_EXACT window pixel ${i}`, [grey, grey, grey, 255], i % 2, Math.floor(i / 2)));
    renderer.render(canvas, curve, { ...view, mode: 'source', slice: 0, windowCenter: 100, windowWidth: 200 });
    check('LINEAR window pixel', [129, 129, 129, 255], 1, 0);

    results.push({ name: 'VOI LUT tables upload as R16UI rows of at most 4096 entries',
      passed: voiUploads.length > 0 && voiUploads.every(u => u.internalFormat === gl.R16UI && u.array === 'Uint16Array' && u.dimensions[0] <= 4096)
        && voiUploads.some(u => u.dimensions.join(',') === '4096,2'), voiUploads });

    const colors = [[0, 255, 255], [255, 0, 255], [255, 255, 0], [255, 255, 255]];
    const rgb = volume('rgb-source', new Uint8Array([...Array(12).fill(0), ...colors.flat()]), {
      components: 3, pixelType: 'uint8', origin: [10, 20, 30], spacing: [1.3, 1.3, 2.2],
      direction: [1, 0, 0, 0, 0, -1, 0, 1, 0],
    }, gl.RGB8);
    expectedFrameViews.push({ source: rgb.data, offset: 12, length: 12, format: gl.RGB8 });
    renderer.render(canvas, rgb, { ...view, mode: 'source', slice: 1, inverted: true, windowWidth: 1 });
    for (let i = 0; i < 4; i++) check(`RGB original rotated source frame pixel ${i}`, [...colors[i], 255], i % 2, Math.floor(i / 2));
    rejects('RGB coronal MPR refused', () => renderer.render(canvas, rgb, { ...view, plane: 'coronal' }), t('gpu.colorMpr'));
    rejects('RGB oblique refused', () => renderer.render(canvas, rgb, { ...view, oblique: [1, 0] }), t('gpu.colorMpr'));
    rejects('RGB fusion refused', () => renderer.render(canvas, rgb, { ...view, mode: 'source' }, { volume: displacedPet, opacity: 1, upperSuv: 4, palette: 'hot' }), t('gpu.colorFusion'));
  } finally {
    gl.texImage3D = originalUpload3D; gl.texImage2D = originalUpload2D;
  }
  const uploadCheck = { name: 'GPU uploads keep compact buffers, permit only intentional Float64 display conversion, and use exact texture formats',
    passed: uploads.length > 0 && uploads.every(u => (u.originalBuffer || u.sourceFrameView || u.convertedFloat64) && u.correctFormat), uploads };
  results.push(uploadCheck);
  return { passed: results.every(r => r.passed), renderer: renderer.info,
    checks: results.length, failures: results.filter(r => !r.passed), results };
}
