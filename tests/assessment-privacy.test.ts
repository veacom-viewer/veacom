import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it, mock } from 'node:test';

const require = createRequire(import.meta.url);
const { registerAssessmentHandlers } = require('../electron/assessment.cjs');
type Dialog = { detail: string; defaultId: number; cancelId: number };

async function assessment(enabled: boolean, approve: (options: Dialog) => Promise<number>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veacom-synthetic-assessment-'));
  const handlers: Record<string, (input?: object) => Promise<unknown>> = {};
  const sent = mock.fn(async (_url: string, _options: RequestInit) => Response.json({ content: [{ type: 'text', text: 'Synthetic response' }] }));
  registerAssessmentHandlers((channel: string, handler: typeof handlers[string]) => { handlers[channel] = handler; }, {
    enabled, app: { getPath: () => dir }, getWindow: () => ({ isDestroyed: () => false }),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() },
    dialog: { showMessageBox: async (_window: unknown, options: Dialog) => ({ response: await approve(options) }) }, fetchImpl: sent,
  });
  return { handlers, sent, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const settings = { apiKey: 'synthetic-only', model: 'claude-synthetic' };
const summary = 'SYNTHETIC'.repeat(120) + '\nSYNTHETIC-TAIL';

it('refuses AI configuration and sends from the renderer when the build disables the feature', async t => {
  const f = await assessment(false, async () => { throw new Error('Unexpected dialog'); });
  t.after(f.cleanup);
  assert.equal((await f.handlers['ai:config']() as { enabled: boolean }).enabled, false);
  await assert.rejects(f.handlers['ai:configure'](settings), /disabled/);
  await assert.rejects(f.handlers['ai:ask']({ summary }), /disabled/);
  assert.equal(f.sent.mock.callCount(), 0);
});

it('shows the exact destination, instructions and clinical text before a single request', async t => {
  const pages: Dialog[] = [];
  const f = await assessment(true, async options => { assert.equal(f.sent.mock.callCount(), 0); pages.push(options); return 1; });
  t.after(f.cleanup);
  await f.handlers['ai:configure'](settings);
  assert.equal(await f.handlers['ai:ask']({ summary }), 'Synthetic response');
  const [url, options] = f.sent.mock.calls[0].arguments;
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(options.redirect, 'error');
  const body = JSON.parse(String(options.body));
  assert.equal(body.messages[0].content, summary);
  const prefix = url + '\n' + body.model + '\n\n';
  assert.ok(pages.length > 2 && pages.every(p => p.defaultId === 0 && p.cancelId === 0 && p.detail.startsWith(prefix)));
  assert.equal(pages.map(p => p.detail.slice(prefix.length)).join(''), body.system + summary);
  assert.equal(f.sent.mock.callCount(), 1);
});

it('cancelling any page or starting a second request during review sends nothing', async t => {
  let count = 0;
  let started!: () => void, resume!: () => void;
  const reviewing = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { resume = resolve; });
  const f = await assessment(true, async () => { if (++count === 1) { started(); await hold; return 1; } return 0; });
  t.after(f.cleanup);
  await f.handlers['ai:configure'](settings);
  const first = f.handlers['ai:ask']({ summary });
  await reviewing;
  await assert.rejects(f.handlers['ai:ask']({ summary }), /already running/);
  resume();
  await assert.rejects(first, /No assessment was sent/);
  await assert.rejects(f.handlers['ai:ask']({ summary: 'SYN\u0000THETIC' }));
  assert.equal(f.sent.mock.callCount(), 0);
});
