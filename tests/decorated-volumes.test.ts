import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createVolumeDecorator } from '../src/domain/decoratedVolumes';
import type { Volume } from '../src/model';

type Settings = { scale?: number; units: 'auto' | 'px' };
const volume = (id: string) => ({ series: { id }, data: new Int16Array(8) }) as unknown as Volume;

describe('decorated volumes', () => {
  it('keeps one decorated object per volume and settings, so the 3D view does not start again when another series loads', () => {
    const decorate = mock.fn((item: Volume, settings: Settings) => ({ ...item, series: { ...item.series, measurementScale: settings.scale, measurementUnits: settings.units } }) as Volume);
    const decorated = createVolumeDecorator(decorate, (a: Settings, b: Settings) => a.scale === b.scale && a.units === b.units);
    const ct = volume('ct'), mr = volume('mr');
    const first = decorated(ct, { units: 'auto' });
    // Another series arrives: App decorates every volume again, with the same settings for this one.
    decorated(mr, { units: 'auto' });
    assert.equal(decorated(ct, { units: 'auto' }), first);
    assert.equal(decorate.mock.callCount(), 2);
  });

  it('decorates again when the volume or its settings change', () => {
    const decorated = createVolumeDecorator((item: Volume, settings: Settings) => ({ ...item, settings }) as unknown as Volume,
      (a: Settings, b: Settings) => a.scale === b.scale && a.units === b.units);
    const ct = volume('ct');
    const first = decorated(ct, { units: 'auto' });
    assert.notEqual(decorated(ct, { units: 'px' }), first);
    assert.notEqual(decorated(ct, { units: 'px', scale: 0.5 }), first);
    assert.notEqual(decorated(volume('ct'), { units: 'px', scale: 0.5 }), decorated(ct, { units: 'px', scale: 0.5 }));
  });
});
