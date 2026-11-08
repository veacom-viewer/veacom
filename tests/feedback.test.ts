import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { assertFields } from './support';

const require = createRequire(import.meta.url);
const { ENDPOINT, createFeedbackSender, describeFeedback, feedbackEndpoint, registerFeedback } = require('../electron/feedback.cjs');
const i18n = require('../electron/i18n.cjs');

const request = { kind: 'problem', message: 'The slice bar jumps after an import.', email: 'radiology@example.org', includeSystem: false };
const accepted = () => ({ status: 204, json: async () => ({}) });

function sender(options: Record<string, unknown> = {}) {
  const fetch = mock.fn(async () => accepted());
  const confirm = mock.fn(async (_body: Record<string, unknown>) => true);
  const send = createFeedbackSender({ fetch, confirm, version: '0.1.0-beta.1', locale: () => 'en', endpoint: ENDPOINT, system: () => 'darwin 25.0.0 arm64', ...options });
  return { send, fetch, confirm };
}

describe('feedback sending', () => {
  it('sends nothing until the user confirms in main, and sends exactly what was confirmed', async () => {
    const declined = sender({ confirm: mock.fn(async (_body: Record<string, unknown>) => false) });
    assert.deepEqual(await declined.send(request), { ok: false, cancelled: true });
    assert.equal(declined.fetch.mock.callCount(), 0);

    const { send, fetch, confirm } = sender();
    assert.deepEqual(await send({ ...request, locale: 'tr' }), { ok: true });
    const shown = confirm.mock.calls[0].arguments[0];
    assert.deepEqual(shown, { kind: 'problem', message: request.message, email: request.email, locale: 'en' });
    const [url, options] = fetch.mock.calls[0].arguments as unknown as [string, RequestInit & { headers: Record<string, string> }];
    assert.equal(url, 'https://veacom.app/api/feedback');
    assert.deepEqual(JSON.parse(String(options.body)), shown);
    assertFields(options, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'User-Agent': 'VEAcom-Feedback', 'Accept-Language': 'en' });
  });

  it('adds the version and system only when the box is ticked', async () => {
    const { send, fetch } = sender();
    await send({ ...request, includeSystem: true });
    assertFields(JSON.parse(String((fetch.mock.calls[0].arguments as unknown as [string, RequestInit])[1].body)), { app: 'VEAcom 0.1.0-beta.1', system: 'darwin 25.0.0 arm64' });
  });

  it('refuses malformed requests and addresses that could inject mail headers', async () => {
    const { send, confirm } = sender();
    for (const bad of [null, { ...request, kind: 'other' }, { ...request, message: '   ' }, { ...request, message: 'x'.repeat(5001) },
      { ...request, message: 'visible\0HIDDEN' }, { ...request, message: 'broken\ud800' }]) {
      await assert.rejects(send(bad), { message: /Invalid feedback\./ });
    }
    for (const email of ['not-an-address', 'a@b.org\nBcc: someone@example.org', `${'a'.repeat(250)}@b.org`]) {
      assert.deepEqual(await send({ ...request, email }), { ok: false, status: 400, reason: 'email' });
    }
    assert.equal(confirm.mock.callCount(), 0);
  });

  it('allows one confirmation at a time and ten an hour', async () => {
    let now = 0;
    let answer: (value: boolean) => void = () => {};
    const confirm = mock.fn((_body: Record<string, unknown>) => new Promise<boolean>(resolve => { answer = resolve; }));
    const { send, fetch } = sender({ confirm, now: () => now });
    const first = send(request);
    assert.deepEqual(await send(request), { ok: false, status: 409, reason: 'busy' });
    answer(true);
    assert.deepEqual(await first, { ok: true });
    for (let index = 1; index < 10; index++) { const pending = send(request); answer(false); await pending; }
    assert.deepEqual(await send(request), { ok: false, status: 429, reason: 'local' });
    now += 60 * 60 * 1000;
    const later = send(request); answer(true);
    assert.deepEqual(await later, { ok: true });
    assert.equal(fetch.mock.callCount(), 2);
  });

  it('passes on the service refusal and its reason', async () => {
    const { send } = sender({ fetch: mock.fn(async () => ({ status: 429, json: async () => ({ error: 'rate' }) })) });
    assert.deepEqual(await send(request), { ok: false, status: 429, reason: 'rate' });
  });

  it('sends nothing from a development run unless an endpoint is named', async () => {
    assert.equal(feedbackEndpoint({ packaged: true, env: { VEACOM_FEEDBACK_ENDPOINT: 'https://elsewhere.example' } }), ENDPOINT);
    assert.equal(feedbackEndpoint({ packaged: false, env: {} }), null);
    assert.equal(feedbackEndpoint({ packaged: false, env: { VEACOM_FEEDBACK_ENDPOINT: 'http://example.org/feedback' } }), null);
    assert.equal(feedbackEndpoint({ packaged: false, env: { VEACOM_FEEDBACK_ENDPOINT: 'http://127.0.0.1:8787/feedback' } }), 'http://127.0.0.1:8787/feedback');
    const { send, confirm } = sender({ endpoint: null });
    assert.deepEqual(await send(request), { ok: false, status: 503, reason: 'off' });
    assert.equal(confirm.mock.callCount(), 0);
  });

  it('shows each supplied field without shortening the message', () => {
    const t = (key: string, params?: Record<string, unknown>) => { i18n.setLocale('en'); return i18n.t(key, params); };
    const short = describeFeedback({ kind: 'suggestion', message: 'Add a {placeholder} key.', email: '', locale: 'en' }, t);
    assert.ok(short.includes('Type: Suggestion'));
    assert.ok(short.includes('Reply address: none'));
    assert.ok(short.includes('App and system: not included'));
    assert.ok(short.includes('Add a {placeholder} key.'));
    const long = describeFeedback({ kind: 'problem', message: 'y'.repeat(900), email: 'a@b.org', locale: 'en', app: 'VEAcom 1', system: 'win32 10 x64' }, t);
    assert.ok(long.includes('App and system: VEAcom 1, win32 10 x64'));
    assert.ok(long.includes('y'.repeat(900)));
  });
  it('requires native approval for every part of the exact message before sending', async () => {
    const message = 'x'.repeat(599) + '🔬' + 'SYNTHETIC-PATIENT-42';
    for (const cancelAt of [0, 1, -1]) {
      const parts: string[] = [];
      const fetch = mock.fn(async (_url: string, _options: RequestInit) => accepted());
      let submit!: (payload: typeof request) => Promise<{ ok: boolean }>;
      i18n.setLocale('en');
      registerFeedback({
        handle: (_: string, handler: typeof submit) => { submit = handler; },
        getWindow: () => ({}), t: i18n.t, locale: () => 'en', net: { fetch },
        app: { isPackaged: true, getVersion: () => 'test' },
        dialog: { showMessageBox: async (_: unknown, prompt: { buttons: string[]; detail: string }) => {
          assert.equal(fetch.mock.callCount(), 0);
          const index = parts.length;
          assert.equal(prompt.buttons[1], index === 0 ? 'Read next part' : 'Send');
          parts.push(prompt.detail.split('\n\n').at(-1)!);
          return { response: index === cancelAt ? 0 : 1 };
        } },
      });
      const result = await submit({ ...request, message });
      if (cancelAt >= 0) {
        assert.equal(result.ok, false);
        assert.equal(fetch.mock.callCount(), 0);
      } else {
        assert.deepEqual(parts, ['x'.repeat(599), '🔬SYNTHETIC-PATIENT-42']);
        assert.equal(JSON.parse(String(fetch.mock.calls[0].arguments[1].body)).message, parts.join(''));
      }
    }
  });

});
