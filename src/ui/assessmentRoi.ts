import type { Annotation, Joined, Series } from '../model';
import type { Translator } from '../i18n';
import { measuredSlice } from '../imaging/paging';

export function assessmentRoiLocation(series: Series, annotation: Pick<Annotation, 'mode' | 'plane' | 'slice' | 'oblique'>, frame: number | null, t: Translator, joined?: Joined | null): string {
  if (annotation.mode !== 'source') return `${t(`planeLower.${annotation.plane}`)} ${measuredSlice(series, annotation)}`;
  if (frame === null) return t('assessment.sourceUnavailable');
  const number = measuredSlice(series, annotation, frame, joined);
  const source = series.frameMetadata?.[frame];
  let label = t('assessment.imageNumber', { number });
  if (source?.instanceNumber !== undefined && source.instanceNumber !== number) label += t('assessment.instanceNumber', { number: source.instanceNumber });
  if (source?.sourceFrameNumber !== undefined) label += t('assessment.frameNumber', { number: source.sourceFrameNumber });
  return label;
}
