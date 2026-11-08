import assert from 'node:assert/strict';
import { it } from 'node:test';
import { dismiss, isDismissed } from '../src/ui/dismissed';
import { compared, comparisonKey, type PetPrior } from '../src/imaging/petComparison';

it('dismisses a warning box until what it says changes', () => {
  const current = compared({ tracer: 'FDG', uptakeSeconds: 3600, glucose: 5.4 });
  const prior: PetPrior = { date: '19991001', kept: false, acquisition: compared({ tracer: 'FDG', uptakeSeconds: 4320, glucose: 10.9 }) };
  const box = comparisonKey('pet', prior, current, false);
  assert.equal(isDismissed(box), false);
  dismiss(box);
  assert.equal(isDismissed(comparisonKey('pet', prior, current, false)), true);
  assert.equal(isDismissed(comparisonKey('pet', prior, current, true)), false);
  assert.equal(isDismissed(comparisonKey('pet', { ...prior, date: '19980101' }, current, false)), false);
  assert.equal(isDismissed(comparisonKey('another', prior, current, false)), false);
  assert.equal(isDismissed(comparisonKey('pet', prior, { ...current, uptakeSeconds: 3700 }, false)), false);
});
