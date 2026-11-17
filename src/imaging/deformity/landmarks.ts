// The landmarks of one leg on a standing AP long-leg film, in the order the kit asks for them (Paley, Principles of
// Deformity Correction, ch. 1; POSNA 2020). Names are stable: they are the keys of the plan file and of the training
// labels (docs/deformity-labels.md), so a name is never reused for another point.
import type { MessageKey } from '../../i18n';

export const LANDMARKS = [
  'femoralHeadContour', 'greaterTrochanterTip', 'femoralShaftProximal', 'femoralShaftDistal', 'kneeCentre',
  'femoralCondyleMedial', 'femoralCondyleLateral', 'tibialPlateauMedial', 'tibialPlateauLateral',
  'tibialShaftProximal', 'tibialShaftDistal', 'plafondMedial', 'plafondLateral', 'ankleCentre',
] as const;
export type LandmarkName = typeof LANDMARKS[number];

/** Points a landmark takes: the femoral head's outline takes three or more (a circle is fitted), the others one. */
export const CONTOUR_MINIMUM = 3;
export const CONTOUR_MAXIMUM = 12;
export const isContour = (name: LandmarkName) => name === 'femoralHeadContour';

/** The interface name of each landmark, and what to click. */
export const LANDMARK_TEXT: Record<LandmarkName, { name: MessageKey; hint: MessageKey }> = {
  femoralHeadContour: { name: 'deformity.landmark.femoralHead', hint: 'deformity.hint.femoralHead' },
  greaterTrochanterTip: { name: 'deformity.landmark.greaterTrochanter', hint: 'deformity.hint.greaterTrochanter' },
  femoralShaftProximal: { name: 'deformity.landmark.femoralShaftProximal', hint: 'deformity.hint.shaftMidpoint' },
  femoralShaftDistal: { name: 'deformity.landmark.femoralShaftDistal', hint: 'deformity.hint.shaftMidpoint' },
  kneeCentre: { name: 'deformity.landmark.kneeCentre', hint: 'deformity.hint.kneeCentre' },
  femoralCondyleMedial: { name: 'deformity.landmark.condyleMedial', hint: 'deformity.hint.condyle' },
  femoralCondyleLateral: { name: 'deformity.landmark.condyleLateral', hint: 'deformity.hint.condyle' },
  tibialPlateauMedial: { name: 'deformity.landmark.plateauMedial', hint: 'deformity.hint.plateau' },
  tibialPlateauLateral: { name: 'deformity.landmark.plateauLateral', hint: 'deformity.hint.plateau' },
  tibialShaftProximal: { name: 'deformity.landmark.tibialShaftProximal', hint: 'deformity.hint.shaftMidpoint' },
  tibialShaftDistal: { name: 'deformity.landmark.tibialShaftDistal', hint: 'deformity.hint.shaftMidpoint' },
  plafondMedial: { name: 'deformity.landmark.plafondMedial', hint: 'deformity.hint.plafond' },
  plafondLateral: { name: 'deformity.landmark.plafondLateral', hint: 'deformity.hint.plafond' },
  ankleCentre: { name: 'deformity.landmark.ankleCentre', hint: 'deformity.hint.ankleCentre' },
};

/** The short mark drawn beside a landmark on the image. */
export const LANDMARK_MARK: Record<LandmarkName, string> = {
  femoralHeadContour: '', greaterTrochanterTip: 'GT', femoralShaftProximal: '', femoralShaftDistal: '', kneeCentre: 'K',
  femoralCondyleMedial: '', femoralCondyleLateral: '', tibialPlateauMedial: '', tibialPlateauLateral: '',
  tibialShaftProximal: '', tibialShaftDistal: '', plafondMedial: '', plafondLateral: '', ankleCentre: 'A',
};

/** Medial and lateral pairs: their order on the film is checked against the side (measure.ts). */
export const PAIRS: ReadonlyArray<[LandmarkName, LandmarkName]> = [
  ['femoralCondyleMedial', 'femoralCondyleLateral'], ['tibialPlateauMedial', 'tibialPlateauLateral'], ['plafondMedial', 'plafondLateral'],
];
