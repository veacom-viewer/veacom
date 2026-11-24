import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECKLISTS, checklistSummary, unmarkedItems, type Answers, type Notes, type SliceNote } from '../src/ui/preopChecklist';

const slice: SliceNote = { seriesId: 's', slice: 3, shown: '4/10', plane: 'axial', mode: 'source' };
const measured: SliceNote = { ...slice, caliper: { annotationId: 'a', kind: 'aea', points: [[0, 0, 0], [0, 0, 1]], up: [0, 0, 1], normal: [0, 1, 0],
  result: { reading: { kind: 'aea', distance: 1, type: 1, nearLimit: false }, side: 'left' } } };

describe('rows left out of the copy', () => {
  it('are exactly the rows the report text leaves out, in the list order', () => {
    // Answered on one side, measured without an answer, a slice noted alone, nothing at all.
    const answers: Answers = { keros: { right: '2' }, septum: { left: 'yes' }, pneumatisation: { both: 'sellar' } };
    const notes: Notes = { 'ethmoid-artery': { left: measured }, lamina: { right: slice } };
    for (const locale of ['en', 'tr'] as const) {
      const text = checklistSummary('pns', answers, notes, locale), left = unmarkedItems('pns', answers, notes);
      const items = CHECKLISTS.pns.groups.flatMap(group => group.items);
      assert.deepEqual(items.filter(item => !text.includes(`${item.label[locale]}:`)).map(item => item.id), left);
    }
    assert.deepEqual(unmarkedItems('pns', answers, notes), ['lamina', 'onodi', 'sphenoid-ica', 'sphenoid-optic', 'sphenoid-septum', 'concha-bullosa', 'haller'],
      'A slice noted alone is not in the copy; a row answered or measured on one side is.');
  });

  it('are none once every row has a mark, and every row of an empty list', () => {
    const all = CHECKLISTS.temporal.groups.flatMap(group => group.items);
    assert.equal(unmarkedItems('temporal', {}, {}).length, all.length);
    assert.deepEqual(unmarkedItems('temporal', Object.fromEntries(all.map(item => [item.id, { left: 'no' }])), {}), []);
  });
});
