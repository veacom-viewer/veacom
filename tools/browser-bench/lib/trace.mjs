// Records what a window drew through Chromium's own trace: the DevTools "Screenshots" track gives a small JPEG of
// every frame that changed, timed on the trace clock, and `performance.mark()` calls from the harness land on the same
// clock. Measured on this Mac (8 Nov 2026): 120 slice changes paged at 60 notches/s gave 189 screenshots, all 120
// changes among them, the marker read in every one. Electron's frame subscription stops at 30 frames/s and missed half.
import { findMarkers } from './marker.mjs';

const CATEGORIES = ['disabled-by-default-devtools.screenshot', 'blink.user_timing'];

/** Starts a trace on a window's DevTools connection; `stop()` ends it and returns its events. */
export async function startTrace(devtools, extraCategories = []) {
  const events = [];
  let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const listener = (_event, method, params) => {
    if (method === 'Tracing.dataCollected') events.push(...params.value);
    if (method === 'Tracing.tracingComplete') finish();
  };
  devtools.on('message', listener);
  await devtools.sendCommand('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: [...CATEGORIES, ...extraCategories], excludedCategories: ['*'] } });
  return {
    async stop() {
      await devtools.sendCommand('Tracing.end');
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('The trace did not complete in 30 s.')), 30_000));
      try { await Promise.race([complete, timeout]); } finally { devtools.removeListener('message', listener); }
      return events;
    },
  };
}

/**
 * Reads a trace: the harness's marks (name → ms) and the frames (ms, the main marker's slice and cell size, and the
 * mean grey of tissue just above the marker). `decode(base64Jpeg)` returns { width, height, pixels } with 4 bytes a
 * pixel; in Electron that is nativeImage.
 */
export function readTrace(events, decode) {
  const marks = {}, frames = [];
  for (const event of events) {
    // The harness's own marks, and VEAcom's steps of opening a study (src/web/bridge.ts): the first of each name.
    if (event.cat === 'blink.user_timing' && /^(bench|veacom):/.test(event.name ?? '') && marks[event.name] === undefined) marks[event.name] = event.ts / 1000;
  }
  const shots = events.filter(event => event.name === 'Screenshot' && event.args?.snapshot).sort((a, b) => a.ts - b.ts);
  for (const shot of shots) frames.push({ ts: shot.ts / 1000, expectedDisplayTime: shot.args.expected_display_time,
    sequence: shot.args.frame_sequence, ...readPicture(decode(shot.args.snapshot)), jpeg: shot.args.snapshot });
  return { marks, frames };
}

/** The main (largest) marker in a picture, and the grey of the tissue above it. */
export function readPicture({ width, height, pixels }) {
  const [main] = findMarkers(pixels, width, height, { step: 2 });
  if (!main) return { index: null, unit: 0, grey: null, width, height };
  // Three to six cells above the band's top row lies tissue in every bench study (tools/browser-bench/make-study.mjs).
  const x0 = Math.max(0, Math.round(main.x)), x1 = Math.min(width, Math.round(main.x + main.width));
  const y0 = Math.max(0, Math.round(main.y - 6 * main.unit)), y1 = Math.max(0, Math.round(main.y - 3 * main.unit));
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += pixels[(y * width + x) * 4 + 1]; count++; }
  return { index: main.index, unit: main.unit, x: main.x, y: main.y, bandWidth: main.width, mirrored: main.mirrored, grey: count ? sum / count : null, width, height };
}

/** Bound the diagnostic to startup. Keep task names and timings, and omit trace arguments and image data. */
export function openingTrace(events, frames, marks, first) {
  const start = marks['bench:drop'], end = first.ts + 40;
  const thread = event => event.pid + '/' + event.tid;
  const names = new Map(events.filter(e => e.ph === 'M' && e.name === 'thread_name').map(e => [thread(e), e.args.name]));
  const groups = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || e.dur < 1000 || e.ts / 1000 > end || (e.ts + e.dur) / 1000 < start) continue;
    const id = thread(e), tasks = groups.get(id) ?? [];
    tasks.push({ at: Math.round(e.ts / 1000 - start), ms: Math.round(e.dur / 100) / 10, name: e.name });
    groups.set(id, tasks);
  }
  return {
    dropTraceMs: start,
    marks: Object.fromEntries(Object.entries(marks).filter(([name]) => name.startsWith('veacom:')).map(([name, at]) => [name, Math.round(at - start)])),
    screenshots: frames.filter(f => f.ts >= start && f.ts <= end).map(f => ({
      at: Math.round(f.ts - start), expectedDisplayTime: f.expectedDisplayTime, sequence: f.sequence,
      slice: f.index, cell: f.unit, width: f.width, height: f.height,
    })),
    threads: [...groups].map(([id, tasks]) => ({ id, name: names.get(id),
      tasks: tasks.sort((a, b) => b.ms - a.ms).slice(0, 25).sort((a, b) => a.at - b.at) })),
  };
}
