import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { assertFields } from './support';
import { createRequire } from 'node:module';
import { UsageTracker, changedFacets, modalityMix, sliceBucket, type UsageEvent, type UsageSnapshot } from '../src/usage/tracker';

const require = createRequire(import.meta.url);
const { sanitizeEvent } = require('../electron/usage.cjs') as { sanitizeEvent: (event: unknown) => UsageEvent | null };
const schema = require('../electron/usage-schema.json') as { spanAttributes: Record<string, unknown> };

function snapshot(patch: Partial<UsageSnapshot> = {}, facets: UsageSnapshot['facets'] = {}): UsageSnapshot {
  return { surface: 'viewer', layout: '1x1', tool: 'window', modality: 'CT', plane: 'source', window: 'stored', wl: '400/40', zoom: 1,
    seriesIndex: 1, slicePct: 0, ...patch, facets: { series: '1', plane: 'source', window: '400/40', zoom: '1.00', slice: '0', tool: 'window', ...facets } };
}

// Timers fire at their own time, and one a timer sets fires within the same advance if it falls due in it.
// advance(n) alone runs every due callback at the end time, so step through it a millisecond at a time.
const advance = (milliseconds: number) => { for (let step = 0; step < milliseconds; step++) mock.timers.tick(1); };

describe('usage tracker', () => {
  let state: UsageSnapshot;
  let tracker: UsageTracker;
  const actions = () => tracker.events().filter(event => event.name === 'ux.action');
  beforeEach(() => {
    // The tracker times actions with performance.now(), which mock.timers does not fake: it follows the faked Date.
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    mock.method(performance, 'now', () => Date.now());
    state = snapshot();
    tracker = new UsageTracker(true);
    tracker.setStateProvider(() => state);
  });
  afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

  it('reports an action with the state after it and what it changed', () => {
    tracker.action('preset-lung', 'mouse', { hoverMs: 640 });
    state = snapshot({ window: 'lung', wl: '1500/-600' }, { window: '1500/-600', menu: '' });
    advance(200);
    const [event] = actions();
    assertFields(event.attributes, { 'veacom.action': 'preset-lung', 'veacom.input': 'mouse', 'veacom.changed': 'window',
      'veacom.window': 'lung', 'veacom.wl': '1500/-600', 'veacom.modality': 'CT', 'veacom.hover_ms': 640 });
    assert.equal(event.duration, 0);
  });

  it('marks an action that changed nothing by leaving `changed` out', () => {
    tracker.action('tool-quick-window', 'key');
    advance(200);
    assert.equal(actions()[0].attributes['veacom.changed'], undefined);
  });

  it('counts an effect the state cannot show, such as a native dialog, as a change', () => {
    tracker.action('welcome-open-folder', 'mouse');
    tracker.touch('dialog');
    advance(200);
    assert.equal(actions()[0].attributes['veacom.changed'], 'dialog');
  });

  it('counts a wheel burst as one action, and a pause starts the next', () => {
    for (let tick = 0; tick < 6; tick++) { tracker.action('wheel-scroll', 'wheel', { burst: true }); state = snapshot({}, { slice: String(tick + 1) }); advance(50); }
    advance(500);
    tracker.action('wheel-scroll', 'wheel', { burst: true }); advance(500);
    const scrolls = actions();
    assert.equal(scrolls.length, 2);
    assertFields(scrolls[0].attributes, { 'veacom.steps': 6, 'veacom.changed': 'slice' });
    assert.equal(scrolls[0].duration, 250);
  });

  it('reports a drag from press to release, and a press without movement as a click', () => {
    const drag = tracker.begin('drag-window', 'drag');
    advance(300);
    state = snapshot({ window: 'manual' }, { window: '600/20' });
    drag.end();
    advance(200);
    const click = tracker.begin('drag-pan', 'drag');
    click.end({ id: 'click-pan', input: 'mouse' });
    advance(200);
    const [first, second] = actions();
    assertFields(first.attributes, { 'veacom.action': 'drag-window', 'veacom.input': 'drag', 'veacom.changed': 'window' });
    assert.equal(first.duration, 300);
    assertFields(second.attributes, { 'veacom.action': 'click-pan', 'veacom.input': 'mouse' });
  });

  it('records a measurement completed by the action as its result', () => {
    const draw = tracker.begin('draw-length', 'drag');
    tracker.markResult('ok');
    state = snapshot({}, { marks: '1' });
    draw.end(); advance(200);
    assertFields(actions()[0].attributes, { 'veacom.result': 'ok', 'veacom.changed': 'marks' });
  });

  it('reports a change nobody asked for once, as an auto event', () => {
    state = snapshot({ window: 'stored' }, { window: '350/50' });
    tracker.observe(); tracker.observe();
    advance(400);
    const auto = tracker.events().filter(event => event.name === 'ux.state');
    assert.equal(auto.length, 1);
    assertFields(auto[0].attributes, { 'veacom.input': 'auto', 'veacom.changed': 'window' });
    tracker.action('tool-link', 'mouse'); advance(200);
    assert.equal(actions()[0].attributes['veacom.changed'], undefined);
  });

  it('lets a double-click replace the click before it', () => {
    const first = tracker.begin('drag-window', 'drag');
    first.end({ id: 'click-window', input: 'mouse' });
    advance(250);
    tracker.action('dblclick-reset', 'mouse', { absorb: 'click-' });
    state = snapshot({}, { zoom: '1.00', pan: '0:0' });
    advance(200);
    assert.deepEqual(actions().map(event => event.attributes['veacom.action']), ['dblclick-reset']);
  });

  it('gives each study its own id and reports open, first image and close', () => {
    tracker.beginStudy('folder');
    advance(900);
    tracker.studyOpened({ modalities: ['PT', 'CT', 'SEG', 'CT', 'bad<value>'], series: 3, slices: 640, source: 'cd', result: 'ok' }, ['a', 'b']);
    tracker.frameShown('other-study-series');
    advance(100);
    tracker.frameShown('a'); tracker.frameShown('b');
    tracker.action('tool-mpr', 'key'); advance(200);
    tracker.beginStudy('drop');
    const events = tracker.events();
    const open = events.find(event => event.name === 'ux.study.open')!;
    const first = events.filter(event => event.name === 'ux.study.first_image');
    const close = events.find(event => event.name === 'ux.study.close')!;
    assertFields(open.attributes, { 'veacom.trigger': 'folder', 'veacom.study.modality': 'CT,OT,PT,SEG', 'veacom.study.series': 3,
      'veacom.study.slices': '500-999', 'veacom.study.source': 'cd', 'veacom.result': 'ok', 'veacom.session': tracker.session });
    assert.equal(open.duration, 900);
    assert.equal(first.length, 1);
    assert.equal(first[0].attributes['veacom.t_ms'], 1000);
    assert.equal(close.trace, open.trace);
    assertFields(close.attributes, { 'veacom.result': 'replaced', 'veacom.steps': 1 });
    assert.notEqual(open.trace, tracker.session);
  });

  it('sends nothing until the user agrees, then hands events over in batches', () => {
    const sink = mock.fn();
    tracker.setSink(sink);
    tracker.action('tool-help', 'mouse'); advance(3000);
    assert.equal(sink.mock.callCount(), 0);
    tracker.setSharing(true);
    tracker.action('tool-help', 'mouse'); advance(3000);
    assert.equal(sink.mock.callCount(), 1);
    assert.deepEqual(sink.mock.calls[0].arguments[0].map((event: UsageEvent) => event.attributes['veacom.action']), ['tool-help']);
  });

  it('only ever produces attributes the main process keeps unchanged', () => {
    tracker.beginStudy('startup', 0);
    tracker.studyOpened({ modalities: ['MR'], series: 12, slices: 2400, source: 'disk', result: 'ok' }, ['x']);
    tracker.frameShown('x');
    for (const [id, input] of [['series-pick', 'mouse'], ['key-slice', 'key'], ['files-drop', 'drop']] as const) { tracker.action(id, input); advance(200); }
    tracker.milestone('view3d-ready');
    tracker.closeStudy('quit');
    for (const event of tracker.events()) {
      for (const key of Object.keys(event.attributes)) assert.ok(key in schema.spanAttributes, key);
      assert.deepEqual(sanitizeEvent(event), event);
    }
  });
});

describe('usage helpers', () => {
  it('buckets image counts and never reports the exact count', () => {
    assert.deepEqual([0, 1, 7, 64, 300, 640, 1500, 9000].map(sliceBucket), ['0', '1', '2-9', '10-99', '100-499', '500-999', '1000-1999', '2000+']);
  });
  it('lists modalities as sorted codes, replacing anything that is not one', () => {
    assert.equal(modalityMix(['MR', 'CT', 'MR', 'Patient^Name']), 'CT,MR,OT');
  });
  it('names changed facets in a fixed order and within 100 characters', () => {
    const before = snapshot(), after = snapshot({}, { menu: 'preset', window: '1/1', series: '2' });
    assert.equal(changedFacets(before, after), 'series,window,menu');
    const all = snapshot({}, Object.fromEntries(['series', 'plane', 'window', 'zoom', 'layout', 'screen', 'slice', 'pan', 'tool', 'marks', 'scene', 'orient', 'color', 'cross', 'seg', 'fusion', 'link', 'overlay', 'panel', 'menu', 'dialog', 'lang', 'prefs'].map(facet => [facet, 'changed'])));
    assert.ok(changedFacets(before, all).length <= 100);
  });
});
