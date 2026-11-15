import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertClose } from './support';
import { canvasSize, CHANNELS, CROP_KINDS, cropCentre, cropToFilm, decodeStageA, kitSuggestions, mirroredChannel, modelLeg, percentile, readStageB, roundHalfEven,
  sampleCrop, stageACanvas, STAGE_B, UNCHECKED, windowed, windowRange, type ChannelPoint, type Channel } from '../src/imaging/deformity/suggest';
import { LANDMARKS } from '../src/imaging/deformity/landmarks';
import { fitCircle, type Point } from '../src/imaging/deformity/plane';

// A 37 × 61 synthetic film: a repeating ramp of 17 levels, and one bright outlier the percentiles leave out. The
// expected numbers below are what veacom-train's own functions give on the same film (stagea.window01, to_canvas;
// stageb.sample_crop), so the port is checked step for step against the code the model was trained with.
const COLUMNS = 37, ROWS = 61;
const film = Float32Array.from({ length: COLUMNS * ROWS }, (_, i) => ((i % COLUMNS) * 7 + Math.floor(i / COLUMNS) * 13) % 17 * 3 + 10);
film[0] = 400;
const windowedFilm = windowed(film, COLUMNS, ROWS, false);
const eightBit = (value: number) => roundHalfEven(value * 255) / 255;

describe('the model\'s view of the film', () => {
  it('rounds and takes percentiles as numpy does', () => {
    assert.deepEqual([0.5, 1.5, 2.5, 3.5, 2.4, 2.6].map(roundHalfEven), [0, 2, 2, 4, 2, 3]);
    assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
    assert.equal(percentile([10, 20], 99.5), 19.95);
  });

  it('windows on the 0.5th and 99.5th percentiles, inverting a MONOCHROME1 film', () => {
    assert.deepEqual(windowRange(film, COLUMNS, ROWS), [10, 58]);
    assert.equal(windowedFilm[0], 1);
    assertClose(windowedFilm[1], (31 - 10) / 48, 6);
    // MONOCHROME1: the stored values inverted, windowed as the model's training films were.
    const inverted = windowed(film, COLUMNS, ROWS, true), negated = windowed(film.map(value => -value), COLUMNS, ROWS, false);
    for (let i = 0; i < film.length; i += 97) assertClose(inverted[i], negated[i], 6);
  });

  it('averages areas onto the 2 mm canvas as torch\'s area resampling does', () => {
    // 61 × 37 pixels of 9 mm: 274.5 rows round to 274 (half to even), 166.5 columns to 166, each cell from one pixel.
    assert.deepEqual(canvasSize(COLUMNS, ROWS, [9, 9]), { width: 166, height: 274, fits: true });
    const up = stageACanvas(windowedFilm, COLUMNS, ROWS, [9, 9]);
    assert.deepEqual(up.scale, [166 / 37, 274 / 61]);
    for (const [[y, x], value] of [[[0, 0], 1], [[5, 7], 0.1875], [[100, 50], 0.375], [[273, 165], 0.75], [[150, 120], 1]] as const) assertClose(up.canvas[y * 256 + x], value, 6);
    // Pixels of 0.5 mm: 4 × 4 or so pixels to a cell, with overlapping ranges where the sizes do not divide.
    const down = stageACanvas(windowedFilm, COLUMNS, ROWS, [0.5, 0.5]);
    for (const [[y, x], value] of [[[0, 0], 0.5425], [[3, 4], 0.5075], [[14, 8], 0.5025], [[15, 9], 0], [[7, 2], 0.4875]] as const) assertClose(down.canvas[y * 256 + x], value, 6);
    assert.equal(canvasSize(2000, 6000, [0.25, 0.25]).fits, false, 'A film taller than 1408 mm does not fit.');
  });

  it('samples crops as stageb.sample_crop: pre-blurred when the film is finer, mirrored for the image\'s right leg', () => {
    const python = { blurred: [0.49557361, 0.51228899, 0.51057601, 0.49217591, 0.484923, 0.49826249, 0.51358718, 0.50868821],
      fine: [0.42453119, 0.64895838, 0.096875, 0.59578121, 0.67765617, 0.56562501, 0.3145833, 0.52395838] };
    const blurred = sampleCrop(windowedFilm, COLUMNS, ROWS, [18.3, 30.7], [0.1, 0.1], false, 8);
    const mirrored = sampleCrop(windowedFilm, COLUMNS, ROWS, [18.3, 30.7], [0.1, 0.1], true, 8);
    const fine = sampleCrop(windowedFilm, COLUMNS, ROWS, [18.3, 30.7], [0.3, 0.3], false, 8);
    python.blurred.forEach((value, column) => {
      // Crops are float32, as the model's input.
      assertClose(blurred[3 * 8 + column], eightBit(value), 6);
      assertClose(mirrored[3 * 8 + 7 - column], eightBit(value), 6);
    });
    python.fine.forEach((value, column) => assertClose(fine[5 * 8 + column], eightBit(value), 6));
  });
});

describe('reading the model', () => {
  it('finds stage A\'s peaks to a fraction of a cell, the image\'s left leg in the first three channels', () => {
    const height = 40, width = 20, logits = new Float32Array(6 * height * width).fill(-50);
    // A peak between cells: equal logits on two neighbours put the point on their shared edge.
    const peaks: Array<[number, number]> = [[3, 4], [5, 20], [6, 33], [14, 5], [15, 21], [13, 34]];
    peaks.forEach(([x, y], channel) => { logits[channel * height * width + y * width + x] = 10; logits[channel * height * width + y * width + x + 1] = 10; });
    const scale: [number, number] = [0.5, 0.25];
    const legs = decodeStageA(logits, height, width, scale);
    const expected = (x: number, y: number): Point => [(x + 1) * 2 / scale[0], (y + 0.5) * 2 / scale[1]];
    const got = [legs.left.hip, legs.left.knee, legs.left.ankle, legs.right.hip, legs.right.knee, legs.right.ankle];
    got.forEach((point, i) => { assertClose(point[0], expected(...peaks[i])[0], 6); assertClose(point[1], expected(...peaks[i])[1], 6); });
  });

  it('centres the hip crop 22 mm lateral, the shaft crops along the anchors, and maps crop pixels back, mirrored for the right leg', () => {
    const anchors = { hip: [100, 50] as Point, knee: [110, 400] as Point, ankle: [115, 800] as Point }, mm = [0.2, 0.25] as const;
    assert.deepEqual(cropCentre('hip', 'left', anchors, mm), [100 - 110, 50]);
    assert.deepEqual(cropCentre('hip', 'right', anchors, mm), [100 + 110, 50]);
    assert.deepEqual(cropCentre('ankle', 'right', anchors, mm), [115, 800]);
    // stageb.SHAFT: 30 % and 75 % of the way from hip to knee, 25 % and 80 % from knee to ankle, on either leg.
    for (const leg of ['left', 'right'] as const) {
      const [femurProximal, femurDistal, tibiaProximal, tibiaDistal] = (['femurProximal', 'femurDistal', 'tibiaProximal', 'tibiaDistal'] as const).map(kind => cropCentre(kind, leg, anchors, mm));
      assertClose(femurProximal[0], 103, 9); assertClose(femurProximal[1], 155, 9);
      assertClose(femurDistal[0], 107.5, 9); assertClose(femurDistal[1], 312.5, 9);
      assertClose(tibiaProximal[0], 111.25, 9); assertClose(tibiaProximal[1], 500, 9);
      assertClose(tibiaDistal[0], 114, 9); assertClose(tibiaDistal[1], 720, 9);
    }
    assert.deepEqual(cropToFilm([160, 160], [50, 60], mm, false), [50, 60]);
    const [x, y] = cropToFilm([170, 140], [50, 60], mm, true);
    assertClose(x, 50 - 10 * STAGE_B.pitch / 0.2, 9); assertClose(y, 60 - 20 * STAGE_B.pitch / 0.25, 9);
  });

  it('reads each crop\'s own channels, the head outline reversed in a mirrored crop', () => {
    assert.equal(mirroredChannel('femoralHeadContour0'), 'femoralHeadContour7');
    assert.equal(mirroredChannel('femoralHeadContour5'), 'femoralHeadContour2');
    assert.equal(mirroredChannel('kneeCentre'), 'kneeCentre');
    const crops = CROP_KINDS, count = crops.length, coords = new Float32Array(count * CHANNELS.length * 2), confidence = new Float32Array(count * CHANNELS.length);
    // Each crop puts every channel at (crop index, channel index), so a reading says where it came from.
    for (let crop = 0; crop < count; crop++) for (let channel = 0; channel < CHANNELS.length; channel++) {
      const index = crop * CHANNELS.length + channel;
      coords[index * 2] = 160 + crop; coords[index * 2 + 1] = 160 + channel; confidence[index] = channel / 100;
    }
    const centres: Point[] = crops.map(() => [0, 0]), mm = [0.35, 0.35] as const;
    const left = readStageB(coords, confidence, crops, centres, mm, false), right = readStageB(coords, confidence, crops, centres, mm, true);
    assert.deepEqual(crops, ['hip', 'knee', 'ankle', 'femurProximal', 'femurDistal', 'tibiaProximal', 'tibiaDistal']);
    assert.deepEqual(left.kneeCentre?.point, [1, CHANNELS.indexOf('kneeCentre')]);
    assert.deepEqual(left.femoralHeadContour1?.point, [0, CHANNELS.indexOf('femoralHeadContour1')]);
    assert.deepEqual(right.femoralHeadContour1?.point, [0, CHANNELS.indexOf('femoralHeadContour6')]);
    assert.deepEqual(right.ankleCentre?.point, [-2, CHANNELS.indexOf('ankleCentre')]);
    // A shaft point is the predicted x on the crop's centre row (stageb.infer_film), each from its own crop.
    for (const [point, x] of [[left.femoralShaftProximal?.point, 3], [left.femoralShaftDistal?.point, 4], [right.tibialShaftDistal?.point, -6]] as const) {
      assertClose(point![0], x, 9); assert.equal(point![1], 0);
    }
    assertClose(right.tibialShaftProximal!.confidence, CHANNELS.indexOf('tibialShaftProximal') / 100, 6);
    assert.equal(Object.keys(left).length, CHANNELS.length);
  });

  it('names the leg by its place on the image, only on an upright film', () => {
    assert.equal(modelLeg([-1, 0]), 'left');
    assert.equal(modelLeg([1, 0.2]), 'right');
    assert.equal(modelLeg([0.3, 1]), null, 'A film turned a quarter has the legs across it.');
    assert.equal(modelLeg(null), null);
  });
});

describe('the kit\'s suggestions', () => {
  const channels = (hip: Point, contour: Point[]): Partial<Record<Channel, ChannelPoint>> => ({
    hipCentre: { point: hip, confidence: 0.06 },
    ...Object.fromEntries(contour.map((point, i) => [`femoralHeadContour${i}`, { point, confidence: 0.05 }])),
    kneeCentre: { point: [120, 900], confidence: 0.07 }, femoralCondyleMedial: { point: [140, 920], confidence: 0.06 },
    tibialPlateauLateral: { point: [90, 930], confidence: 0.06 }, ankleCentre: { point: [130, 1800], confidence: 0.07 },
    greaterTrochanterTip: { point: [40, 80], confidence: 0.04 }, plafondMedial: { point: [140, 1790], confidence: 0.05 },
  });

  it('marks as unchecked the trochanter and the plafond, which nothing on real films checks yet', () => {
    assert.deepEqual([...UNCHECKED], ['greaterTrochanterTip', 'plafondMedial', 'plafondLateral']);
    assert.ok(UNCHECKED.every(name => LANDMARKS.includes(name)));
  });

  it('suggests each landmark its channels give, with the head as a ring around the checked hip centre', () => {
    // Pixels 0.2 mm wide and 0.25 mm high: the ring is round in millimetres, so its fitted centre is the hip centre.
    const mm = [0.2, 0.25] as const, hip: Point = [200, 150];
    const contour = [0, 40, 95, 140, 185, 230, 280, 320].map((degrees, i) => {
      const r = 110 + i * 3, a = degrees * Math.PI / 180;
      return [hip[0] + r * Math.cos(a) / mm[0], hip[1] + r * Math.sin(a) / mm[1]] as Point;
    });
    const suggested = kitSuggestions(channels(hip, contour), mm);
    assert.deepEqual(Object.keys(suggested).sort(), ['ankleCentre', 'femoralCondyleMedial', 'femoralHeadContour', 'greaterTrochanterTip', 'kneeCentre', 'plafondMedial', 'tibialPlateauLateral']);
    assert.deepEqual(suggested.plafondMedial, { points: [[140, 1790]], confidence: 0.05 });
    const ring = suggested.femoralHeadContour!.points, fitted = fitCircle(ring.map(p => [p[0] * mm[0], p[1] * mm[1]] as Point))!;
    assert.equal(ring.length, 8);
    assertClose(fitted.centre[0], hip[0] * mm[0], 9); assertClose(fitted.centre[1], hip[1] * mm[1], 9);
    // The median of the outline's distances: 110 + 3 × 3 and 110 + 4 × 3 mm, averaged.
    assertClose(fitted.radius, 120.5, 9);
    // Each ring point keeps the direction of its outline point.
    const direction = (p: Point) => Math.atan2((p[1] - hip[1]) * mm[1], (p[0] - hip[0]) * mm[0]);
    ring.forEach((p, i) => assertClose(direction(p), direction(contour[i]), 9));
  });

  it('suggests no head when the outline gives no circle', () => {
    const hip: Point = [200, 150], line = [1, 2, 3, 4].map(k => [hip[0] + 10 * k, hip[1]] as Point);
    assert.equal(kitSuggestions(channels(hip, line), [0.2, 0.2]).femoralHeadContour, undefined);
    assert.equal(kitSuggestions(channels(hip, [hip, hip, hip]), [0.2, 0.2]).femoralHeadContour, undefined);
  });
});
