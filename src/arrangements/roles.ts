import { studyKey } from '../domain/patient';
import { comparisonTracer } from '../imaging/petTracer';
// Roles: which series of a study fill an arrangement, said as data (src/arrangements/builtin.ts). A role is a filter and
// a ranking over a few shared primitives, never code of its own.
import type { Series } from '../model';
import type { SequenceRole } from '../domain/clinical';
import { indexToWorld } from '../imaging/geometry';
import { samePatient, shareFrame } from '../imaging/linking';
import { sequenceGuess } from '../ui/seriesNames';
import { counterpart } from './counterpart';

/** Ranking keys, compared in order: not one gate of a gated SPECT (the summed reconstruction holds all the counts),
 * attenuation-corrected (by description, not NAC), the anchor's slice grid, the most head-to-feet range shared with the
 * anchor, the most slices, the highest b-value. */
export type RoleRank = 'ungated' | 'corrected' | 'sameGrid' | 'overlap' | 'slices' | 'highB';
export const ROLE_RANKS: readonly RoleRank[] = ['ungated', 'corrected', 'sameGrid', 'overlap', 'slices', 'highB'];

export interface RoleSpec {
  /** The DICOM modality, such as CT, PT or MR, or any of several. */
  modality?: string | readonly string[];
  /** For MR: the likely sequence (src/ui/seriesNames.ts). */
  sequence?: SequenceRole;
  /** A volume: slices with a known place, so the series reconstructs (planes, MIP, fusion). */
  volume?: true;
  /** A value of Image Type (0008,0008), such as `WHOLE BODY` for a gamma camera scan. */
  imageType?: string;
  /** Gamma camera views (`ANT`, `POST`) the series holds a frame in, each of them. */
  views?: readonly string[];
  /** The anchor: another role, or `picked`, the series the reader picked or shows in the active pane. */
  of?: string;
  /** `same` study as the anchor (the default when there is one); `prior`: the same patient's most recent earlier
   * study; `later`: the same patient's next later study. */
  study?: 'same' | 'prior' | 'later';
  /** The anchor's counterpart: a series of the anchor's own kind, the best such first (src/arrangements/counterpart.ts). */
  alike?: true;
  /** `same`: drawn together with the anchor (one frame of reference, a reconstructable volume, a known orientation). */
  frame?: 'same';
  prefer?: readonly RoleRank[];
}

function zRange(series: Series): [number, number] {
  const first = indexToWorld(series, [0, 0, 0])[2], last = indexToWorld(series, [0, 0, Math.max(0, series.dimensions[2] - 1)])[2];
  return [Math.min(first, last), Math.max(first, last)];
}

const RANK: Record<RoleRank, (item: Series, anchor: Series | null) => number> = {
  ungated: item => Number(!item.phase?.gate),
  corrected: item => {
    const words = item.description.toUpperCase();
    return Number(!(words.includes('NO-AC') || words.includes('NOAC') || words.split(/[\s_]+/).includes('NAC')));
  },
  sameGrid: (item, anchor) => Number(!!anchor && item.dimensions[2] === anchor.dimensions[2] && Math.abs(item.spacing[2] - anchor.spacing[2]) < 1e-3),
  overlap: (item, anchor) => {
    if (!anchor) return 0;
    const [low, high] = zRange(anchor), [a, b] = zRange(item);
    return Math.max(0, Math.min(high, b) - Math.max(low, a));
  },
  slices: item => item.dimensions[2],
  highB: item => item.diffusionBValue ?? 0,
};

/** An earlier study of the same patient, or with `later` a later one. */
function otherStudy(anchor: Series, item: Series, later = false): boolean {
  if (item.studyUid === anchor.studyUid || !samePatient(anchor, item) || !/^\d{8}$/.test(item.studyDate) || !/^\d{8}$/.test(anchor.studyDate)
    || (later ? item.studyDate <= anchor.studyDate : item.studyDate >= anchor.studyDate)) return false;
  if (anchor.modality !== 'PT' || item.modality !== 'PT') return true;
  const tracer = comparisonTracer(anchor.petAcquisition);
  return !!anchor.patientId.trim() && !!item.patientId.trim() && !!tracer && tracer === comparisonTracer(item.petAcquisition);
}

/** The frame of a series taken in `view` (a gamma camera's ANT or POST), or -1. */
export const frameInView = (series: Series, view: string) => series.frameMetadata?.findIndex(frame => frame.nm?.view === view) ?? -1;

/** Whether a series is of the kind a role asks for (modality, sequence, volume, image type, views), whatever its anchor. */
export function ofKind(spec: RoleSpec, item: Series): boolean {
  const modalities = typeof spec.modality === 'string' ? [spec.modality] : spec.modality;
  return !item.segmentation && (!modalities || modalities.includes(item.modality)) && (!spec.sequence || sequenceGuess(item)?.role === spec.sequence)
    && (!spec.volume || item.canReconstruct)
    && (!spec.imageType || (item.imageType ?? '').split('\\').some(value => value.trim() === spec.imageType))
    && (!spec.views || spec.views.every(view => frameInView(item, view) >= 0));
}

/** The series that best fills `spec` among `candidates`, beside `anchor`; ties go to the one listed first. `fits` can
 * narrow the candidates further. */
export function findRole(spec: RoleSpec, candidates: readonly Series[], anchor: Series | null, fits?: (item: Series) => boolean): Series | null {
  const elsewhere = spec.study === 'prior' || spec.study === 'later';
  const found = candidates.filter(item => ofKind(spec, item) && (!anchor || item.id !== anchor.id)
    && (!anchor || (elsewhere ? otherStudy(anchor, item, spec.study === 'later') : studyKey(item) === studyKey(anchor)))
    && (!anchor || spec.frame !== 'same' || shareFrame(anchor, item)) && (!anchor || !spec.alike || counterpart(anchor, item, candidates) !== null)
    && (!fits || fits(item)));
  if (!found.length) return null;
  const ranks = spec.prefer ?? [];
  // Of other studies, the nearest in time first: the latest earlier one, or the earliest later one.
  const score = (item: Series) => [...(elsewhere ? [spec.study === 'later' ? -Number(item.studyDate) : Number(item.studyDate)] : []),
    ...(anchor && spec.alike ? counterpart(anchor, item, candidates) ?? [] : []), ...ranks.map(rank => RANK[rank](item, anchor))];
  return found.reduce((best, item) => {
    const a = score(item), b = score(best);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? item : best;
    return best;
  });
}
