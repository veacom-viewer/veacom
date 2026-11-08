// Emission images, PET and gamma camera (NM): which they are and what they are called on screen. Kept apart from
// fusion.ts so that the ROI worker reads them without the arrangements.
import type { Series } from '../model';

/** An emission image, PET or gamma camera (NM): never the base of a fusion, and panes showing one share its scale. */
export const isEmission = (series: Series) => series.modality === 'PT' || series.modality === 'NM';

/** Ingest supplies a positive factor for calibrated PET, including 1 for stored SUV. */
export const petHasSuv = (series: Series): series is Series & { suvFactor: number } => series.modality === 'PT' && series.suvFactor != null && Number.isFinite(series.suvFactor) && series.suvFactor > 0;

/** What a fused series is called on screen: PET, SPECT, or its modality (an MR over an MR). */
export const overlayKind = (series: Series) => series.modality === 'NM' ? 'SPECT' : series.modality === 'PT' ? 'PET' : series.modality;
