import type { ViewVolume as Volume } from '../model';

/**
 * The viewer shows each volume with its display settings attached (calibration, units, whether it can only be shown
 * frame by frame), which makes a new object. A decorated volume is kept for as long as its volume and settings stay
 * the same, so a component whose work belongs to one volume (the 3D view's carving, crop and exports) starts again
 * only when the volume really changes, not whenever another series finishes loading.
 */
export function createVolumeDecorator<Settings, V extends Volume>(decorate: (volume: V, settings: Settings) => V, same: (a: Settings, b: Settings) => boolean) {
  const decorated = new WeakMap<V, { settings: Settings; value: V }>();
  return (volume: V, settings: Settings): V => {
    const known = decorated.get(volume);
    if (known && same(known.settings, settings)) return known.value;
    const value = decorate(volume, settings);
    decorated.set(volume, { settings, value });
    return value;
  };
}
