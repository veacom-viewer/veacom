import { bodyWeightFactor } from '../imaging/quantity';
// A sphere VOI's row in the measurement list, on a PET in SUV: what it stands for (a lesion, or the liver or blood pool
// reference), and for a lesion the Deauville score its SUVmax suggests against the two references, with the basis. The
// reader confirms the score or chooses another; nothing is scored without them.
import { useState } from 'react';
import { useMeasuredSpheres } from '../imaging/useMeasuredSpheres';
import type { Annotation, DeauvilleScore, ReferenceRole, ViewVolume as Volume } from '../model';
import { quantitativeScale } from '../imaging/annotations';
import { DEAUVILLE_SCORES, isDeauvilleScore, NEAR_BOUND, type Suggestion } from '../imaging/deauville';
import { canAssessLymphoma, deauvilleReading } from '../imaging/deauvilleReading';
import { petTracer } from '../imaging/petTracer';
import { isSuv, isThresholdId, LIVER_REFERENCE_RADIUS_MM, measurableVolume, sphereOf, spherePoints } from '../imaging/voi';
import { useTranslation } from '../i18n/react';

type Role = ReferenceRole | 'lesion';
const ROLE_LABELS = { lesion: 'sphere.roleLesion', liver: 'sphere.roleLiver', bloodPool: 'sphere.roleBloodPool' } as const;

/** Whether a sphere on this volume can be a reference or be scored: a PET whose values are an SUV. */
export function scoresSuv(volume: Volume | undefined): volume is Volume {
  return !!volume && volume.series.modality === 'PT' && isSuv(quantitativeScale(volume.series).unit);
}

/** The series' spheres with `id` given `role`. A study has one liver and one blood pool reference: another sphere that
 * had the role becomes a lesion. A liver reference is made a 3 cm sphere about its centre. */
export function withRole(annotations: readonly Annotation[], id: string, role: Role): Annotation[] {
  return annotations.map(annotation => {
    if (annotation.type !== 'sphere') return annotation;
    if (annotation.id === id) {
      const { role: _role, fdgLymphoma: _context, deauville: _score, deauvilleBasis: _basis, ...rest } = annotation, sphere = sphereOf(annotation);
      if (role === 'lesion') return annotation.role ? rest : annotation;
      const points = role === 'liver' && sphere ? spherePoints(sphere.center, LIVER_REFERENCE_RADIUS_MM, annotation.points[1]) : annotation.points;
      return { ...rest, points, role };
    }
    if (role !== 'lesion' && annotation.role === role) { const { role: _role, ...rest } = annotation; return rest; }
    return annotation;
  });
}

const decimals = (value: number, digits: number, locale: string) => value.toLocaleString(locale, { useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits });
function liverRatio(value: number, locale: string) {
  for (let digits = 2; digits <= 6; digits++) {
    const rounded = Number(value.toFixed(digits));
    if (value === rounded || (rounded !== 1 && rounded !== 2)) return decimals(value, digits, locale);
  }
  const boundary = Math.round(value);
  return `${value < boundary ? '<' : '>'}${decimals(boundary, 6, locale)}`;
}
const percent = (value: number, locale: string) => locale === 'tr' ? `%${value}` : `${value}%`;

function Basis({ suggestion, lesion, references, unit }: { suggestion: Suggestion; lesion: number; references: Record<ReferenceRole, number>; unit: string }) {
  const { locale, t } = useTranslation();
  const values = { lesion: decimals(lesion, 2, locale), unit, bloodPool: decimals(references.bloodPool, 2, locale), liver: decimals(references.liver, 2, locale), ratio: liverRatio(suggestion.ratios.liver, locale) };
  const key = (['deauville.basis2', 'deauville.basis3', 'deauville.basis4', 'deauville.basis5'] as const)[suggestion.score - 2];
  return <>
    <p className="sphere-basis" data-deauville="basis">{t(key, values)}</p>
    {suggestion.score === 2 && <p className="field-help">{t('deauville.score1')}</p>}
    {suggestion.score === 5 && suggestion.ratios.liver <= 3 && <p className="field-help">{t('deauville.between')}</p>}
    {suggestion.near && <p className="field-help" data-deauville="near">{t('deauville.near', { percent: percent(NEAR_BOUND * 100, locale), score: suggestion.near.otherScore })}</p>}
    <p className="field-help">{t('deauville.method', { unit })}</p>
  </>;
}

function LesionName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const { t } = useTranslation();
  const [edit, setEdit] = useState<{ name: string; value: string } | null>(null);
  if (edit && edit.name !== name) setEdit(null);
  const commit = () => {
    const next = edit?.value.trim().slice(0, 24);
    setEdit(null);
    if (next && next !== name) onRename(next);
  };
  return <label className="sphere-field">{t('lesion.name')}
    <input data-action="lesion-name" value={edit?.value ?? name} maxLength={24} onChange={event => setEdit({ name, value: event.target.value })} onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } else if (event.key === 'Escape') { event.stopPropagation(); setEdit(null); } }} /></label>;
}

export function SphereDetails({ annotation, annotations, volume, onChange }: {
  annotation: Annotation; annotations: readonly Annotation[]; volume: Volume | undefined; onChange: (next: Annotation[]) => void;
}) {
  const { t } = useTranslation();
  const measured = useMeasuredSpheres(annotations, volume);
  if (annotation.type !== 'sphere' || !scoresSuv(volume) || !measurableVolume(volume)) return null;
  const role: Role = annotation.role ?? 'lesion';
  const choose = (next: Role) => onChange(withRole(annotations, annotation.id, next));
  const roleSelect = <label className="sphere-field">{t('sphere.role')}
    <select data-action="sphere-role" value={role} onChange={event => choose(event.target.value as Role)}>
      {(['lesion', 'liver', 'bloodPool'] as const).map(item => <option key={item} value={item}>{t(ROLE_LABELS[item])}</option>)}
    </select></label>;
  if (role !== 'lesion') return <div className="sphere-details" data-sphere-details>{roleSelect}
    <p className="field-help">{t(role === 'liver' ? 'sphere.liverHelp' : 'sphere.bloodPoolHelp')} {t('sphere.kept')}</p></div>;
  const reading = deauvilleReading(annotation, annotations, volume, item => measured.get(item)?.result ?? null);
  const basis = 'suggestion' in reading ? reading.basis : undefined;
  const confirmed = basis && annotation.deauvilleBasis === basis ? annotation.deauville : undefined;
  const update = (change: Partial<Annotation>) => onChange(annotations.map(item => item.id === annotation.id ? { ...item, ...change } : item));
  const score = (value: DeauvilleScore | undefined) => update({ deauville: value, deauvilleBasis: value === undefined ? undefined : basis });
  const unknown = petTracer(volume.series.petAcquisition) === 'unknown';
  const metabolic = measured.get(annotation)?.result?.metabolic;
  return <div className="sphere-details" data-sphere-details>{roleSelect}
    {annotation.label && <LesionName name={annotation.label} onRename={label => update({ label })} />}
    <label className="sphere-field">{t('sphere.threshold')}
      <select data-action="sphere-threshold" value={annotation.threshold ?? ''} onChange={event => update({ threshold: isThresholdId(event.target.value) ? event.target.value : undefined, regionSeeds: undefined })}>
        <option value="">{t('sphere.thresholdNone')}</option>
        <option value="max41">{t('sphere.thresholdMax41')}</option>
        <option value="suv2.5" disabled={!bodyWeightFactor(volume.series)}>{t('sphere.thresholdSuv')}</option>
      </select></label>
    {metabolic && metabolic.regions.length > 1 && <fieldset className="sphere-regions"><legend>{t('sphere.regions')}</legend>
      {metabolic.regions.map((region, i) => <label key={region.seed}><input type="checkbox" data-action="lesion-region"
        checked={annotation.regionSeeds?.includes(region.seed) ?? false} onChange={event => {
          const seeds = annotation.regionSeeds ?? [];
          update({ regionSeeds: event.target.checked ? [...seeds, region.seed] : seeds.filter(seed => seed !== region.seed) });
        }} />{t('sphere.region', { number: i + 1, count: region.count, position: region.at.map(value => value.toFixed(0)).join(', ') })}</label>)}</fieldset>}
    {annotation.threshold && <p className="field-help">{t('sphere.thresholdHelp')}</p>}
    {canAssessLymphoma(volume) && <label className="sphere-field"><input type="checkbox" data-action="deauville-context" checked={!!annotation.fdgLymphoma}
      onChange={event => update({ fdgLymphoma: event.target.checked, deauville: undefined, deauvilleBasis: undefined })} />
      {t(unknown ? 'deauville.verifyTracer' : 'deauville.verifyLymphoma')}</label>}
    {canAssessLymphoma(volume) && annotation.fdgLymphoma && <div className="deauville" data-deauville="helper">
      <strong>{confirmed !== undefined ? t('deauville.confirmed', { score: confirmed }) : t('deauville.title')}</strong>
      {'problem' in reading ? <p className="field-help" data-deauville="problem">{t(reading.problem === 'order' ? 'deauville.orderProblem' : reading.problem === 'coverage' ? 'deauville.coverage' : 'deauville.needsReferences')}</p>
        : <>
          <p className="sphere-suggestion" data-deauville="suggestion">{t('deauville.suggested', { score: reading.suggestion.score })}</p>
          <Basis suggestion={reading.suggestion} lesion={reading.lesion} references={reading.references} unit={reading.unit} />
          {confirmed !== reading.suggestion.score && <button type="button" className="secondary-button compact" data-action="deauville-confirm" onClick={() => score(reading.suggestion.score as DeauvilleScore)}>{t('deauville.confirm', { score: reading.suggestion.score })}</button>}
        </>}
      <label className="sphere-field">{t('deauville.choose')}
        <select data-action="deauville-score" disabled={!basis} value={confirmed === undefined ? '' : String(confirmed)} onChange={event => {
          const value = event.target.value === 'X' ? 'X' : event.target.value ? Number(event.target.value) : undefined;
          score(isDeauvilleScore(value) ? value : undefined);
        }}>
          <option value="">{t('deauville.unscored')}</option>
          {DEAUVILLE_SCORES.map(item => <option key={item} value={String(item)}>{item === 'X' ? t('deauville.scoreX') : String(item)}</option>)}
        </select></label>
    </div>}
  </div>;
}
