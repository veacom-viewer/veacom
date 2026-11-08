import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { it, mock } from 'node:test';

const require = createRequire(import.meta.url);
const { reviewExportPixels } = require('../electron/export-review.cjs');
const selected = [{ id: 'synthetic-A', catalogRevision: 7, patientId: 'TEST-A', uid: '2.25.7' }, { id: 'synthetic-B', catalogRevision: 8, patientId: 'TEST-B', uid: '2.25.8' }];

it('only native approval of the open window authorizes the exact selected revisions', async () => {
  const parent = { isDestroyed: () => false };
  for (const response of [0, 1]) {
    const showMessageBox = mock.fn(async (_window: unknown, _options: { defaultId: number; cancelId: number; detail: string }) => ({ response }));
    const approved = await reviewExportPixels({ showMessageBox }, parent, selected, (key: string) => key);
    assert.deepEqual(approved, response ? { 'synthetic-A': 7, 'synthetic-B': 8 } : null);
    const [owner, options] = showMessageBox.mock.calls[0].arguments;
    assert.equal(owner, parent);
    assert.ok(options.detail.includes('TEST-A · 2.25.7') && options.detail.includes('TEST-B · 2.25.8'));
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
  }
  assert.equal(await reviewExportPixels({}, { isDestroyed: () => true }, selected, () => ''), null);
});
