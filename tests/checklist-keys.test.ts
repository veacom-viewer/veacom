import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECKLISTS, answerByKey, checklistKey, moveCell, type ChecklistState } from '../src/ui/preopChecklist';

const items = CHECKLISTS.pns.groups.flatMap(group => group.items);
const row = (id: string) => items.findIndex(item => item.id === id);
const press = (key: string, code = '', modifiers: Partial<Record<'repeat' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) =>
  checklistKey({ key, code, repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
const empty: ChecklistState = { kind: 'pns', answers: {}, notes: {} };

describe('the checklist keys', () => {
  it('reads arrows as moves, and Alt with a digit as an answer by the digit\'s place, whatever the layout types', () => {
    assert.deepEqual(press('ArrowDown'), { move: 'down' });
    assert.deepEqual(press('ArrowLeft'), { move: 'left' });
    assert.deepEqual(press('2', 'Digit2', { altKey: true }), { answer: 1, both: false });
    assert.equal(press('1', 'Digit1', { altKey: true, repeat: true }), null);
    assert.equal(press('!', 'Digit1', { altKey: true, shiftKey: true, repeat: true }), null);
    assert.deepEqual(press('ArrowDown', '', { repeat: true }), { move: 'down' });
    // ⌥2 types ™ on a Mac, and Alt+Shift+2 another character on each layout: still the second answer, both sides with Shift.
    assert.deepEqual(press('™', 'Digit2', { altKey: true }), { answer: 1, both: false });
    assert.deepEqual(press('€', 'Digit2', { altKey: true, shiftKey: true }), { answer: 1, both: true });
    assert.deepEqual(press('9', 'Digit9', { altKey: true }), { answer: 8, both: false });
    // A plain digit is a window preset on the image, and Shift with one zooms there on a Turkish keyboard (Shift+4 is +).
    assert.equal(press('2', 'Digit2'), null);
    assert.equal(press('+', 'Digit4', { shiftKey: true }), null);
    // AltGr, which Windows reports as Ctrl+Alt, types characters (AltGr+2 is £ on a Turkish keyboard).
    assert.equal(press('£', 'Digit2', { ctrlKey: true, altKey: true }), null);
    // With Alt, the keypad's digits type characters by their codes on Windows.
    assert.equal(press('3', 'Numpad3', { altKey: true }), null);
    // The app's own combinations, and arrows with a modifier (Shift+arrows pan the image).
    assert.equal(press('z', 'KeyZ', { metaKey: true }), null);
    assert.equal(press('1', 'Digit1', { metaKey: true, altKey: true }), null);
    assert.equal(press('ArrowUp', '', { shiftKey: true }), null);
    assert.equal(press('ArrowUp', '', { altKey: true }), null);
    assert.equal(press('0', 'Digit0', { altKey: true }), null);
    assert.equal(press('y', 'KeyY', { altKey: true }), null, 'No letters: Y is yes in English and Yok (no) in Turkish.');
  });

  it('reads Enter as Show, once a press and without a modifier', () => {
    assert.deepEqual(press('Enter', 'Enter'), { show: true });
    assert.deepEqual(press('Enter', 'NumpadEnter'), { show: true });
    assert.equal(press('Enter', 'Enter', { repeat: true }), null, 'Holding Enter does not turn the pane plane after plane.');
    for (const modifier of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey'] as const) assert.equal(press('Enter', 'Enter', { [modifier]: true }), null, modifier);
  });

  it('moves between rows in a column and between the columns as shown, right first', () => {
    const keros = row('keros'), pneumatisation = row('pneumatisation');
    assert.deepEqual(moveCell(items, { row: keros, side: 'right' }, 'right', 'right'), { row: keros, side: 'left' });
    assert.deepEqual(moveCell(items, { row: keros, side: 'left' }, 'left', 'left'), { row: keros, side: 'right' });
    assert.deepEqual(moveCell(items, { row: keros, side: 'left' }, 'down', 'left'), { row: keros + 1, side: 'left' });
    // A one-answer row has one cell; leaving it, the keys go back to the column last used.
    assert.deepEqual(moveCell(items, { row: pneumatisation - 1, side: 'left' }, 'down', 'left'), { row: pneumatisation, side: 'both' });
    assert.deepEqual(moveCell(items, { row: pneumatisation, side: 'both' }, 'right', 'left'), { row: pneumatisation, side: 'both' });
    assert.deepEqual(moveCell(items, { row: pneumatisation, side: 'both' }, 'down', 'left'), { row: pneumatisation + 1, side: 'left' });
    // The first and last rows stop the keys.
    assert.deepEqual(moveCell(items, { row: 0, side: 'right' }, 'up', 'right'), { row: 0, side: 'right' });
    assert.deepEqual(moveCell(items, { row: items.length - 1, side: 'left' }, 'down', 'left'), { row: items.length - 1, side: 'left' });
  });

  it('answers the side by the answer\'s place, then moves on: left after right, then the next row', () => {
    const lamina = row('lamina');
    const right = answerByKey(empty, items, { row: lamina, side: 'right' }, 1, false);
    assert.deepEqual(right?.state.answers.lamina, { right: 'no' });
    assert.deepEqual(right?.next, { row: lamina, side: 'left' });
    const left = answerByKey(right.state, items, right.next, 0, false);
    assert.deepEqual(left?.state.answers.lamina, { right: 'no', left: 'yes' });
    assert.deepEqual(left?.next, { row: lamina + 1, side: 'right' });
    // Keros answers are its types: 2 is type 2.
    assert.deepEqual(answerByKey(empty, items, { row: row('keros'), side: 'left' }, 1, false)?.state.answers.keros, { left: '2' });
    // Sphenoid pneumatisation has five answers, on one side; the next row starts on the right.
    const sellar = answerByKey(empty, items, { row: row('pneumatisation'), side: 'both' }, 2, false);
    assert.deepEqual(sellar?.state.answers.pneumatisation, { both: 'sellar' });
    assert.deepEqual(sellar?.next, { row: row('pneumatisation') + 1, side: 'right' });
    assert.equal(answerByKey(empty, items, { row: lamina, side: 'right' }, 3, false), null, 'A finding has three answers.');
  });

  it('with Shift sets both sides to the same answer, even where one side had it already, and goes to the next row', () => {
    const onodi = row('onodi');
    const before: ChecklistState = { ...empty, answers: { onodi: { right: 'no' }, lamina: { left: 'yes' } } };
    const both = answerByKey(before, items, { row: onodi, side: 'left' }, 1, true);
    assert.deepEqual(both?.state.answers, { onodi: { right: 'no', left: 'no' }, lamina: { left: 'yes' } }, 'A key sets; it never clears a side as a second click does.');
    assert.deepEqual(both?.next, { row: onodi + 1, side: 'right' });
    const last = items.length - 1;
    assert.deepEqual(answerByKey(empty, items, { row: last, side: 'right' }, 2, true)?.next, { row: last, side: 'right' }, 'The last row keeps the keys.');
  });
});
