// Window/level presets (CT Hounsfield units) and how the interface names the current one: VEAcom 1.x's set,
// on the keys 2-9 (1 is the slice's full range, 0 the series' own window, Shift+A the automatic one).
/** The bone window, which the CLOSE calipers also read bone in (imaging/calipers.ts). */
export const BONE_WINDOW = { width: 1500, center: 300 } as const;
export const PRESETS = [
  { key: 'abdomen', digit: '2', width: 400, center: 60 }, { key: 'angiography', digit: '3', width: 600, center: 300 },
  { key: 'bone', digit: '4', ...BONE_WINDOW }, { key: 'brain', digit: '5', width: 80, center: 40 },
  { key: 'thorax', digit: '6', width: 400, center: 40 }, { key: 'lung', digit: '7', width: 1500, center: -400 },
  { key: 'liver', digit: '8', width: 150, center: 30 }, { key: 'temporalBone', digit: '9', width: 2800, center: 600 },
] as const;
export type Preset = typeof PRESETS[number];

/** The preset whose window equals the displayed one (to the whole unit shown on screen), if any. */
export function presetFor(width: number, center: number): Preset | undefined {
  return PRESETS.find(preset => preset.width === Math.round(width) && preset.center === Math.round(center));
}

/** The platform's primary shortcut modifier, as printed on its keyboards. */
export function modifierKey(platform: string): '⌘' | 'Ctrl' {
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl';
}
