import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { assertFields } from './support';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Usage, UsageStore, sanitizeEvent, otlpTraces, collectorConfig, classifySource } = require('../electron/usage.cjs');

const event = (patch: Record<string, unknown> = {}, attributes: Record<string, unknown> = {}) => ({
  name: 'ux.action', trace: 'a'.repeat(32), span: 'b'.repeat(16), start: 1.8e12, duration: 12.5,
  attributes: { 'veacom.action': 'tool-mpr', 'veacom.input': 'mouse', 'veacom.seq': 3, 'veacom.t_ms': 1200, ...attributes }, ...patch,
});
const collector = { VEACOM_TELEMETRY_ENDPOINT: 'https://collector.example.test', VEACOM_TELEMETRY_TOKEN: 'x'.repeat(40) };

describe('usage events in the main process', () => {
  it('keeps only schema attributes with allowed values', () => {
    const clean = sanitizeEvent(event({}, {
      'veacom.window': 'lung', 'veacom.zoom': 1.23456, 'veacom.wl': '1500/-600',
      'patient.name': 'DOE^JANE', 'veacom.study.name': 'from-the-renderer', 'veacom.modality': 'ct', 'veacom.input': 'voice',
      'veacom.action': 'C:\\Users\\doe\\study', 'veacom.changed': 'window,menu', 'veacom.seq': 1.5,
    }));
    assert.deepEqual(clean.attributes, { 'veacom.window': 'lung', 'veacom.zoom': 1.235, 'veacom.wl': '1500/-600', 'veacom.changed': 'window,menu', 'veacom.t_ms': 1200 });
  });
  it('rejects events that are not usage spans', () => {
    assert.equal(sanitizeEvent(event({ name: 'study.open' })), null);
    assert.equal(sanitizeEvent(event({ trace: 'not-hex' })), null);
    assert.equal(sanitizeEvent(event({ start: Date.parse('2001-01-01') })), null);
    assert.equal(sanitizeEvent(event({ duration: -1 })), null);
    assert.equal(sanitizeEvent('ux.action'), null);
  });
  it('writes OTLP/HTTP JSON spans with nanosecond times and typed values', () => {
    const body = otlpTraces([sanitizeEvent(event({}, { 'veacom.zoom': 2 }))], { 'service.name': 'veacom' });
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    assertFields(span, { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'ux.action', kind: 1,
      startTimeUnixNano: '1800000000000000000', endTimeUnixNano: '1800000000012500000' });
    const attribute = (key: string) => span.attributes.find((item: { key: string }) => item.key === key);
    assert.deepEqual(attribute('veacom.seq'), { key: 'veacom.seq', value: { intValue: '3' } });
    assert.deepEqual(attribute('veacom.zoom'), { key: 'veacom.zoom', value: { doubleValue: 2 } });
    assert.deepEqual(body.resourceSpans[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'veacom' } }]);
  });
  it('accepts only an https collector (or a local one) with a real token', () => {
    assert.equal(collectorConfig(collector, '/nowhere')?.url, 'https://collector.example.test/v1/traces');
    assert.equal(collectorConfig({ ...collector, VEACOM_TELEMETRY_ENDPOINT: 'http://collector.example.test' }, '/nowhere'), null);
    assert.equal(collectorConfig({ VEACOM_TELEMETRY_ENDPOINT: 'http://127.0.0.1:4318', VEACOM_TELEMETRY_TOKEN: 'y'.repeat(20) }, '/nowhere')?.url, 'http://127.0.0.1:4318/v1/traces');
    assert.equal(collectorConfig({ ...collector, VEACOM_TELEMETRY_TOKEN: 'short' }, '/nowhere'), null);
    assert.equal(collectorConfig({}, '/nowhere'), null);
  });
  it('drops text that looks like valid action, modality or changed-field names', () => {
    const a = sanitizeEvent(event({}, { 'veacom.action':'patient-smith', 'veacom.modality':'SMITH', 'veacom.study.modality':'CT,SMITH', 'veacom.changed':'menu,smith' })).attributes;
    assert.doesNotMatch(JSON.stringify(a), /smith/i);
    assert.equal(collectorConfig({ ...collector, VEACOM_TELEMETRY_ENDPOINT:'https://u:p@collector.example.test' }, '/nowhere'), null);
  });
  it('says where a study came from without its path', () => {
    const readOnly = (root: string) => !root.startsWith('/Volumes/DISC') && root !== 'D:\\';
    assert.equal(classifySource(['/Users/doe/Downloads/study.zip'], { platform: 'darwin', writable: readOnly }), 'zip');
    assert.equal(classifySource(['\\\\pacs\\share\\study'], { platform: 'win32', writable: readOnly }), 'network');
    assert.equal(classifySource(['/Volumes/DISC/DICOMDIR'], { platform: 'darwin', writable: readOnly }), 'cd');
    assert.equal(classifySource(['D:\\DICOM'], { platform: 'win32', writable: readOnly }), 'cd');
    assert.equal(classifySource(['/Volumes/USB/study'], { platform: 'darwin', writable: readOnly }), 'disk');
    assert.equal(classifySource(['C:\\Users\\doe\\study'], { platform: 'win32', writable: () => false }), 'disk');
  });
});

describe('usage consent, local copy and sending', () => {
  let userData: string;
  beforeEach(() => { userData = fs.mkdtempSync(path.join(os.tmpdir(), 'veacom-usage-test-')); });
  afterEach(() => { fs.rmSync(userData, { recursive: true, force: true }); });
  const create = (env: Record<string, string> = {}, fetchImpl: Function = mock.fn(), packaged = false) =>
    new Usage({ userData, version: '2.0.0-test', packaged, env, fetchImpl, platform: 'win32', release: '10.0.26100', arch: 'x64', configDirectory: '/nowhere' });

  it('records nothing before the user agrees', () => {
    const usage = create();
    assert.equal(usage.status().consent, null);
    assert.equal(usage.record([event()]), 0);
    assert.equal(fs.existsSync(path.join(userData, 'usage')), false);
  });
  it('keeps a local copy once agreed, and deletes it and the install id when turned off', () => {
    fs.writeFileSync(path.join(userData, 'preferences.json'), JSON.stringify({ locale: 'en' }));
    const usage = create();
    usage.setConsent('granted');
    assert.equal(usage.record([event(), event({ name: 'bogus' })]), 1);
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8'));
    assertFields(saved, { locale: 'en', usageConsent: 'granted' });
    assert.match(saved.usageInstallId, /^[0-9a-f]{32}$/);
    assert.equal((new UsageStore(path.join(userData, 'usage')).unsent(10).events).length, 1);
    usage.setConsent('denied');
    assert.equal(fs.existsSync(path.join(userData, 'usage')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8')), { locale: 'en', usageConsent: 'denied' });
    usage.stop();
  });
  it('ignores forced consent and endpoint overrides in a packaged app', () => {
    const usage = create({ ...collector, VEACOM_TELEMETRY_CONSENT:'granted' }, mock.fn(), true);
    assertFields(usage.status(), {consent:null, environment:'field', sending:false});
    assert.equal(usage.record([event()]), 0);
  });
  it('lets a packaged app take the lab label and nothing else with it', () => {
    const usage = create({ ...collector, VEACOM_TELEMETRY_ENVIRONMENT:'lab', VEACOM_TELEMETRY_CONSENT:'granted', VEACOM_TELEMETRY_STUDY_NAME:'ct-small', VEACOM_TELEMETRY_SCENARIO:'release' }, mock.fn(), true);
    assertFields(usage.status(), {consent:null, environment:'lab', sending:false});
    assert.equal(usage.lab, null);
    assert.equal(usage.record([event()]), 0);
    assert.equal(create({ VEACOM_TELEMETRY_ENVIRONMENT:'dev' }, mock.fn(), true).status().environment, 'field');
    assert.equal(create({ VEACOM_TELEMETRY_ENVIRONMENT:'staging' }, mock.fn(), true).status().environment, 'field');
  });
  it('sends new events after an empty send and stops an in-flight send on revoke', async () => {
    const fetchImpl = mock.fn((_url: string, request: RequestInit) => new Promise((_resolve, reject) => {
      assert.equal(request.redirect, 'error');
      request.signal!.addEventListener('abort', () => reject(new Error('revoked')));
    }));
    const usage = create(collector, fetchImpl);
    usage.setConsent('granted'); assert.equal(await usage.send(), 0);
    usage.record([event()]); const flight = usage.send(); await Promise.resolve();
    assert.equal(fetchImpl.mock.callCount(), 1); usage.setConsent('denied'); await flight;
    assertFields(usage.status(), {consent:'denied',sending:false,pendingBytes:0});
    assert.equal(fs.existsSync(path.join(userData,'usage')), false);
    assert.ok(!fs.readFileSync(path.join(userData,'preferences.json'),'utf8').includes('usageInstallId'));
  });
  it('bounds the local copy to 8 MiB, dropping the oldest events first', () => {
    const store = new UsageStore(path.join(userData, 'usage'));
    const batch = Array.from({ length: 2000 }, (_, index) => event({}, { 'veacom.seq': index }));
    const line = JSON.stringify(sanitizeEvent(batch[0])).length;
    const rounds = Math.ceil(12 * 1024 * 1024 / (line * batch.length));
    for (let round = 0; round < rounds; round++) store.append(batch.map(sanitizeEvent));
    const files = store.files();
    const total = files.reduce((sum: number, file: { size: number }) => sum + file.size, 0);
    assert.ok(total <= (8 * 1024 * 1024));
    assert.ok(total > (7 * 1024 * 1024));
    assert.ok(Math.max(...files.map((file: { size: number }) => file.size)) <= 256 * 1024);
    assert.ok(files[0].number > 1);
    // The oldest unsent events went first; reading resumes at the oldest file still kept.
    const { events } = store.unsent(5);
    assert.equal(events.length, 5);
  });
  it('sends stored events to the collector with the ingest token, then only new ones', async () => {
    const fetchImpl = mock.fn(async () => new Response('{}', { status: 200 }));
    const usage = create({ ...collector, VEACOM_TELEMETRY_CONSENT: 'granted' }, fetchImpl);
    usage.setMachine({ renderer: 'ANGLE (Apple, Apple M2)\u0000', software: false });
    usage.record([event(), event({ span: 'c'.repeat(16) })]);
    assert.equal(await usage.send({ force: true }), 2);
    assert.equal(await usage.send({ force: true }), 0);
    usage.stop();
    const [url, request] = fetchImpl.mock.calls[0].arguments as unknown as [string, RequestInit];
    assert.equal(url, 'https://collector.example.test/v1/traces');
    assert.equal((request.headers as Record<string, string>).Authorization, `Bearer ${'x'.repeat(40)}`);
    const body = JSON.parse(String(request.body));
    assert.equal(body.resourceSpans[0].scopeSpans[0].spans.length, 2);
    const resource = Object.fromEntries(body.resourceSpans[0].resource.attributes.map((item: { key: string; value: { stringValue: string } }) => [item.key, item.value.stringValue]));
    assertFields(resource, { 'service.name': 'veacom', 'service.version': '2.0.0-test', 'deployment.environment': 'dev', 'os.type': 'windows',
      'host.arch': 'amd64', 'veacom.machine.renderer': 'apple', 'veacom.machine.software_renderer': 'false' });
    assert.match(resource['veacom.install_id'], /^[0-9a-f]{32}$/);
  });
  it('keeps events when the collector cannot be reached, and waits longer before trying again', async () => {
    const fetchImpl = mock.fn(async () => { throw new Error('blocked by the hospital network'); });
    const usage = create({ ...collector, VEACOM_TELEMETRY_CONSENT: 'granted' }, fetchImpl);
    usage.record([event()]);
    assert.equal(await usage.send({ force: true }), 0);
    assert.equal(await usage.send(), 0);
    assert.equal(fetchImpl.mock.callCount(), 1);
    assert.ok(usage.status().pendingBytes > 0);
    usage.stop();
  });
  it('names lab studies only in lab runs, and only on the open event', async () => {
    const fetchImpl = mock.fn(async () => new Response('{}', { status: 200 }));
    const lab = create({ ...collector, VEACOM_TELEMETRY_CONSENT: 'granted', VEACOM_TELEMETRY_ENVIRONMENT: 'lab', VEACOM_TELEMETRY_STUDY_NAME: 'ct-chest-lidc', VEACOM_TELEMETRY_SCENARIO: 'baseline' }, fetchImpl);
    lab.record([event({ name: 'ux.study.open' }), event()]);
    await lab.send({ force: true }); lab.stop();
    const spans = JSON.parse(String((fetchImpl.mock.calls[0].arguments as unknown as [string, RequestInit])[1].body)).resourceSpans[0].scopeSpans[0].spans;
    const names = spans.map((span: { attributes: { key: string; value: { stringValue?: string } }[] }) => span.attributes.find(item => item.key === 'veacom.study.name')?.value.stringValue);
    assert.deepEqual(names, ['ct-chest-lidc', undefined]);
    const field = create({ VEACOM_TELEMETRY_CONSENT: 'granted', VEACOM_TELEMETRY_STUDY_NAME: 'ct-chest-lidc' });
    assert.equal(field.lab, null); field.stop();
  });
});
