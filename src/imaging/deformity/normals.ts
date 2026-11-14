// Normal values for the frontal-plane alignment of the lower limb, kept as data with their sources and shown with
// them. Where sources disagree, the range used for flags is the first one listed and the others are shown beside it.
// The values are those of the 2026 feasibility study's table (section 2.4), each checked there against its source.
export type ValueKey = 'mLPFA' | 'mLDFA' | 'aLDFA' | 'MPTA' | 'LDTA' | 'JLCA' | 'HKA' | 'MAD' | 'AMA';

export interface Normal {
  /** The usual value and the range flagged as normal; MAD in mm (medial positive), HKA in degrees (varus positive),
   * JLCA in degrees (positive when the joint lines converge medially). */
  typical: number; low: number; high: number;
  source: string;
  /** Other published values, as they are written. */
  others: string[];
}

export const NORMALS: Record<ValueKey, Normal> = {
  mLPFA: { typical: 90, low: 85, high: 95, source: 'POSNA 2020, Fig. 4', others: ['Schneider 2025: 90° (85–95)'] },
  mLDFA: { typical: 88, low: 85, high: 90, source: 'POSNA 2020, Fig. 4', others: ['Marques Luís 2021: 87 ± 3°', 'Da Cunha 2020: 88 ± 3°'] },
  aLDFA: { typical: 81, low: 79, high: 83, source: 'POSNA 2020, Fig. 4', others: ['Marques Luís 2021: 81 ± 2°'] },
  MPTA: { typical: 87, low: 85, high: 90, source: 'POSNA 2020, Fig. 4', others: ['Marques Luís 2021: 87 ± 3°'] },
  LDTA: { typical: 89, low: 86, high: 92, source: 'POSNA 2020, Fig. 4', others: ['Marques Luís 2021: 89 ± 3°'] },
  JLCA: { typical: 0, low: -2, high: 2, source: 'POSNA 2020, Fig. 4: 0 ± 2°', others: ['Schneider 2025: 0–2°', 'Fisher 2025: ≤ 2°', 'Marques Luís 2021: 0–1° medial'] },
  AMA: { typical: 6, low: 5, high: 7, source: 'Marques Luís 2021: 6 ± 1°', others: ['Fisher 2025: 7°'] },
  // Paley's 8 ± 7 mm medial, as Schneider 2025 and Da Cunha 2020 cite it.
  MAD: { typical: 8, low: 1, high: 15, source: 'Paley: 8 ± 7 mm medial', others: ['Marques Luís 2021: 4 ± 2 mm medial', 'Sinai (POSNA 2020): 0 ± 3 mm'] },
  // No single range is agreed. Within 3° of straight is used, the threshold Bellemans 2012 gives for constitutional
  // varus; Moreland 1987 found a mean 1.5° (right) and 1.1° (left) varus in 25 normal men.
  HKA: { typical: 0, low: -3, high: 3, source: 'Bellemans 2012: ≥ 3° varus', others: ['Moreland 1987: 1.5° R, 1.1° L varus'] },
};

export type Verdict = 'normal' | 'high' | 'low';
export function verdict(key: ValueKey, value: number): Verdict {
  const normal = NORMALS[key];
  return value < normal.low ? 'low' : value > normal.high ? 'high' : 'normal';
}

/** The target angles the CORA construction draws the joints' axes at (Paley): the usual values above. */
export const CORA_ANGLES = { mLPFA: NORMALS.mLPFA.typical, mLDFA: NORMALS.mLDFA.typical, MPTA: NORMALS.MPTA.typical, LDTA: NORMALS.LDTA.typical };
