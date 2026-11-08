// VEAcom's own arrangements: data, not code (docs/arrangements.md). Each one says which series it takes (roles), the
// panes it makes, how they link and the notice it shows. src/arrangements/index.ts matches and applies them.
import type { Arrangement } from './index';

/** Four views for reporting, available in the layout picker. Both layouts use the same kept preferences. */
export const PET_CT_READING: Arrangement = {
  id: 'pet-ct', when: 'open', name: 'arrangement.petCt',
  roles: {
    pet: { modality: 'PT', prefer: ['corrected', 'slices'] },
    ct: { modality: 'CT', of: 'pet', frame: 'same', prefer: ['corrected', 'sameGrid', 'overlap', 'slices'] },
  },
  grid: [2, 2],
  panes: [
    { role: 'ct', plane: 'axial', show: 'plain' },
    { role: 'pet', plane: 'axial', show: 'plain', display: { palette: 'gray', invert: true, window: { unit: 'SUV', from: 0, to: 5 } } },
    { role: 'ct', plane: 'axial', show: 'fused', over: 'pet' },
    { role: 'pet', plane: 'coronal', show: 'mip', display: { palette: 'gray', invert: true, window: { unit: 'SUV', from: 0, to: 5 } } },
  ],
  link: 'crosshair',
  notice: { key: 'arrangement.petCt.notice' },
};

export const PET_CT: Arrangement = {
  ...PET_CT_READING,
  grid: [1, 1],
  panes: [{ role: 'ct', plane: 'axial', show: 'fused', over: 'pet' }],
  notice: { key: 'arrangement.petCt.fused' },
};

/** A PET study opened with an earlier PET of the same patient loaded: this study's PET and the prior's side by side,
 * each with its MIP below, as PET is read (inverted grey, SUV 0–10). Response is read on one fixed scale (EANM 2025,
 * section 14), so the four panes keep one SUV window: windowing one windows all. The two studies lie in their own
 * frames of reference, so the reader brings both to one level and links them by hand (the link button's anchors); each
 * study's own panes follow its crosshair. Listed before the PET/CT screen, which a study without a prior opens as. */
export const PET_FOLLOW_UP: Arrangement = {
  id: 'pet-follow-up', when: 'open', name: 'arrangement.petFollowUp',
  roles: {
    pet: { modality: 'PT', prefer: ['corrected', 'slices'] },
    prior: { modality: 'PT', of: 'pet', study: 'prior', prefer: ['corrected', 'slices'] },
  },
  grid: [2, 2],
  panes: [
    { role: 'pet', plane: 'axial', show: 'plain', display: { palette: 'gray', invert: true, window: { unit: 'SUV', from: 0, to: 10 } } },
    { role: 'prior', plane: 'axial', show: 'plain', display: { palette: 'gray', invert: true, window: { unit: 'SUV', from: 0, to: 10 } } },
    { role: 'pet', plane: 'coronal', show: 'mip', display: { palette: 'gray', invert: true, window: { unit: 'SUV', from: 0, to: 10 } } },
    { role: 'prior', plane: 'coronal', show: 'mip', display: { palette: 'gray', invert: true, window: { unit: 'SUV', from: 0, to: 10 } } },
  ],
  link: 'crosshair',
  scale: 'shared',
  notice: { key: 'arrangement.petFollowUp.notice' },
};

/** A bone scan's whole body, applied when one opens: the anterior and posterior views side by side, inverted grey, one
 * scale for both, each paging on its own. */
export const WHOLE_BODY: Arrangement = {
  id: 'whole-body', when: 'open', name: 'arrangement.wholeBody',
  roles: { body: { modality: 'NM', imageType: 'WHOLE BODY', views: ['ANT', 'POST'] } },
  grid: [1, 2],
  panes: [
    { role: 'body', view: 'ANT', display: { palette: 'gray', invert: true } },
    { role: 'body', view: 'POST', display: { palette: 'gray', invert: true } },
  ],
  link: 'none',
  notice: { key: 'arrangement.wholeBody.notice' },
};

/** The SPECT/CT screen, applied when a reconstructed SPECT opens with the CT acquired with it: CT · SPECT (inverted grey)
 * · fused · MIP, linked by the crosshair. A SPECT has no SUV here, so every pane keeps its own window. Of a gated SPECT's
 * reconstructions it takes the summed one, which holds all the counts, and a gate only when there is no other. */
export const SPECT_CT: Arrangement = {
  id: 'spect-ct', when: 'open', name: 'arrangement.spectCt',
  roles: {
    spect: { modality: 'NM', volume: true, prefer: ['ungated', 'corrected', 'slices'] },
    ct: { modality: 'CT', of: 'spect', frame: 'same', prefer: ['corrected', 'sameGrid', 'overlap', 'slices'] },
  },
  grid: [2, 2],
  panes: [
    { role: 'ct', plane: 'axial', show: 'plain' },
    { role: 'spect', plane: 'axial', show: 'plain', display: { palette: 'gray', invert: true } },
    { role: 'ct', plane: 'axial', show: 'fused', over: 'spect' },
    { role: 'spect', plane: 'coronal', show: 'mip', display: { palette: 'gray', invert: true } },
  ],
  link: 'crosshair',
  notice: { key: 'arrangement.spectCt.notice' },
};

/** With two panes, a DWI picked into one brings its study's ADC into the other, linked slice for slice. */
export const DWI_ADC: Arrangement = {
  id: 'dwi-adc', when: 'pick',
  roles: { picked: { sequence: 'dwi' }, adc: { sequence: 'adc', of: 'picked', prefer: ['highB'] } },
  grid: 'keep',
  panes: [{ role: 'picked' }, { role: 'adc' }],
  link: 'crosshair',
  notice: { key: 'pair.placed', params: { kind: 'ADC' } },
};

/** With two panes, an ADC picked into one brings its study's DWI with the highest b-value into the other. */
export const ADC_DWI: Arrangement = {
  id: 'adc-dwi', when: 'pick',
  roles: { picked: { sequence: 'adc' }, dwi: { sequence: 'dwi', of: 'picked', prefer: ['highB'] } },
  grid: 'keep',
  panes: [{ role: 'picked' }, { role: 'dwi' }],
  link: 'crosshair',
  notice: { key: 'pair.placed', params: { kind: 'DWI' } },
};

/** Several series picked together: a pane for each, in the order picked, at most six (VEAcom 1.x). */
export const SIDE_BY_SIDE: Arrangement = {
  id: 'side-by-side', when: 'pick-several', max: 6,
  roles: { picked: {} },
  grid: { 2: [1, 2], 3: [1, 3], 4: [2, 2], 5: [2, 3], 6: [2, 3] },
  panes: [{ role: 'picked' }],
};

/** The fusion button: for the series in the active pane, the PET or reconstructed SPECT to fuse (summed rather than one
 * gate, attenuation-corrected, covering it), and for one of those, the CT acquired with it. A gate shown in the pane is
 * fused itself. */
export const FUSION: Arrangement = {
  id: 'fusion', when: 'fuse',
  roles: {
    overlay: { modality: ['PT', 'NM'], of: 'picked', frame: 'same', prefer: ['ungated', 'corrected', 'sameGrid', 'overlap', 'slices'] },
    ct: { modality: 'CT', of: 'overlay', frame: 'same', prefer: ['corrected', 'sameGrid', 'overlap', 'slices'] },
  },
  panes: [{ role: 'ct', show: 'fused', over: 'overlay' }],
};

/** Tried in this order; the first whose roles are all found applies. A bone scan holding both a whole body and a
 * SPECT/CT opens on the whole body, as it is read first. */
export const BUILTIN_ARRANGEMENTS: readonly Arrangement[] = [PET_FOLLOW_UP, PET_CT, WHOLE_BODY, SPECT_CT, DWI_ADC, ADC_DWI, SIDE_BY_SIDE, FUSION];
