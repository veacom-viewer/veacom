// The pre-operative checklists (the user's design, 2026-11-06): what a surgeon wants looked at before sinus or ear
// surgery, each finding marked present, absent or not assessable, per side, with the slice it was seen on. A PNS CT
// opens the CLOSE checklist (cribriform plate, lamina papyracea, Onodi cell, sphenoid, ethmoid artery); a temporal
// bone CT the third-window, ossicle, facial canal, inner ear and tegmen checklist.
import type { Series } from '../model';
import { foldSearch } from './seriesNames';

export type ChecklistKind = 'pns' | 'temporal';
type Words = { tr: string; en: string };
export interface ChecklistItem { id: string; label: Words; hint: Words; sided: boolean; options?: Array<{ value: string } & Words> }
export interface ChecklistGroup { title: Words; items: ChecklistItem[] }
export type Side = 'right' | 'left' | 'both';
export type Answers = Record<string, Partial<Record<Side, string>>>;
export interface SliceNote { seriesId: string; slice: number; shown: string; plane: string; mode: string;
  /** A tilted reconstruction: its pitch and yaw, and the tilt from the plain plane in degrees. */
  oblique?: [number, number]; tilt?: number }
export type Notes = Record<string, SliceNote>;

/** Present, absent, not assessable: the default answers of a finding. */
export const FINDING: Array<{ value: string } & Words> = [
  { value: 'yes', tr: 'Var', en: 'Yes' }, { value: 'no', tr: 'Yok', en: 'No' }, { value: 'unknown', tr: '?', en: '?' },
];

export const CHECKLISTS: Record<ChecklistKind, { title: Words; groups: ChecklistGroup[] }> = {
  pns: {
    title: { tr: 'PNS BT · ameliyat öncesi', en: 'Sinus CT · before surgery' },
    groups: [{
      title: { tr: 'CLOSE', en: 'CLOSE' },
      items: [
        { id: 'keros', label: { tr: 'Kribriform plate (Keros)', en: 'Cribriform plate (Keros)' }, hint: { tr: 'Olfaktör fossa derinliği, asimetri', en: 'Olfactory fossa depth, asymmetry' }, sided: true,
          options: [{ value: '1', tr: '1', en: '1' }, { value: '2', tr: '2', en: '2' }, { value: '3', tr: '3', en: '3' }, { value: 'unknown', tr: '?', en: '?' }] },
        { id: 'lamina', label: { tr: 'Lamina papyracea', en: 'Lamina papyracea' }, hint: { tr: 'Dehisans, erozyon', en: 'Dehiscence, erosion' }, sided: true },
        { id: 'onodi', label: { tr: 'Onodi hücresi', en: 'Onodi cell' }, hint: { tr: 'Optik sinirle ilişki', en: 'Relation to the optic nerve' }, sided: true },
        { id: 'sphenoid-ica', label: { tr: 'Sfenoid: ICA', en: 'Sphenoid: ICA' }, hint: { tr: 'Dehisans / protrüzyon', en: 'Dehiscence / protrusion' }, sided: true },
        { id: 'sphenoid-optic', label: { tr: 'Sfenoid: optik sinir', en: 'Sphenoid: optic nerve' }, hint: { tr: 'Dehisans / protrüzyon', en: 'Dehiscence / protrusion' }, sided: true },
        { id: 'sphenoid-septum', label: { tr: 'İntersinüs septum ICA\'ya', en: 'Intersinus septum to ICA' }, hint: { tr: 'Septumun karotis kanalına yapışması', en: 'Septum inserting on the carotid canal' }, sided: true },
        { id: 'pneumatisation', label: { tr: 'Sfenoid pnömatizasyonu', en: 'Sphenoid pneumatisation' }, hint: { tr: 'Sella\'ya göre', en: 'Relative to the sella' }, sided: false,
          options: [{ value: 'conchal', tr: 'Konkal', en: 'Conchal' }, { value: 'presellar', tr: 'Preseller', en: 'Presellar' }, { value: 'sellar', tr: 'Seller', en: 'Sellar' }, { value: 'postsellar', tr: 'Postseller', en: 'Postsellar' }, { value: 'unknown', tr: '?', en: '?' }] },
        { id: 'ethmoid-artery', label: { tr: 'Ön etmoid arter', en: 'Anterior ethmoid artery' }, hint: { tr: 'Kafa tabanından ayrık (mezenterde), dehisans', en: 'Below the skull base (in a mesentery), dehiscent' }, sided: true },
      ],
    }, {
      title: { tr: 'Diğer', en: 'Other' },
      items: [
        { id: 'septum', label: { tr: 'Septum deviasyonu / spur', en: 'Septal deviation / spur' }, hint: { tr: 'Taraf: deviasyonun yönü', en: 'Side: the way it deviates' }, sided: true },
        { id: 'concha-bullosa', label: { tr: 'Konka bülloza', en: 'Concha bullosa' }, hint: { tr: 'Orta konka pnömatizasyonu', en: 'Pneumatised middle turbinate' }, sided: true },
        { id: 'haller', label: { tr: 'Haller hücresi', en: 'Haller cell' }, hint: { tr: 'İnfraorbital etmoid hücre', en: 'Infraorbital ethmoid cell' }, sided: true },
      ],
    }],
  },
  temporal: {
    title: { tr: 'Temporal BT · ameliyat öncesi', en: 'Temporal bone CT · before surgery' },
    groups: [{
      title: { tr: 'Üçüncü pencere', en: 'Third window' },
      items: [
        { id: 'sscd', label: { tr: 'Üst SSK dehisansı', en: 'Superior canal dehiscence' }, hint: { tr: 'Pöschl düzleminde bakın', en: 'Look in the Pöschl plane' }, sided: true },
        { id: 'pscd', label: { tr: 'Arka SSK dehisansı', en: 'Posterior canal dehiscence' }, hint: { tr: 'Juguler bulbusla ilişki', en: 'Relation to the jugular bulb' }, sided: true },
        { id: 'eva', label: { tr: 'Genişlemiş vestibüler akuadukt', en: 'Enlarged vestibular aqueduct' }, hint: { tr: 'Orta noktada > 1,5 mm', en: '> 1.5 mm at the midpoint' }, sided: true },
        { id: 'cochlea-carotid', label: { tr: 'Koklea–karotis dehisansı', en: 'Cochlear–carotid dehiscence' }, hint: { tr: 'Kemik bölme yok', en: 'No bony wall' }, sided: true },
      ],
    }, {
      title: { tr: 'Orta ve iç kulak', en: 'Middle and inner ear' },
      items: [
        { id: 'ossicles', label: { tr: 'Kemikçik zinciri bozukluğu', en: 'Ossicular chain disruption' }, hint: { tr: 'Malleus, inkus, stapes, eklemler', en: 'Malleus, incus, stapes, joints' }, sided: true },
        { id: 'facial', label: { tr: 'Fasiyal kanal dehisansı', en: 'Facial canal dehiscence' }, hint: { tr: 'Timpanik segment en sık', en: 'Tympanic segment most often' }, sided: true },
        { id: 'inner-ear', label: { tr: 'İç kulak anomalisi', en: 'Inner ear anomaly' }, hint: { tr: 'İnkomplet partisyon, koklear hipoplazi, LSSK displazisi', en: 'Incomplete partition, cochlear hypoplasia, LSCC dysplasia' }, sided: true },
        { id: 'tegmen', label: { tr: 'Tegmen defekti', en: 'Tegmen defect' }, hint: { tr: 'Timpani / mastoideum', en: 'Tympani / mastoideum' }, sided: true },
        { id: 'lscc-fistula', label: { tr: 'Lateral SSK fistülü', en: 'Lateral canal fistula' }, hint: { tr: 'Kolesteatomda', en: 'With cholesteatoma' }, sided: true },
      ],
    }, {
      title: { tr: 'Damarlar', en: 'Vessels' },
      items: [
        { id: 'jugular', label: { tr: 'Yüksek / dehisan juguler bulbus', en: 'High / dehiscent jugular bulb' }, hint: { tr: 'Orta kulağa uzanım', en: 'Reaching the middle ear' }, sided: true },
        { id: 'sigmoid', label: { tr: 'Öne yerleşik sigmoid sinüs', en: 'Anterior sigmoid sinus' }, hint: { tr: 'Mastoidektomi yolu', en: 'Mastoidectomy route' }, sided: true },
        { id: 'aberrant-ica', label: { tr: 'Aberan ICA / persistan stapedial arter', en: 'Aberrant ICA / persistent stapedial artery' }, hint: { tr: 'Orta kulakta damar', en: 'A vessel in the middle ear' }, sided: true },
      ],
    }],
  },
};

/** Which checklist a CT's descriptions suggest: sinuses or temporal bone; none for anything else. */
export function checklistKind(series: Series | undefined): ChecklistKind | null {
  if (!series || series.modality.toUpperCase() !== 'CT') return null;
  const text = foldSearch([series.studyDescription, series.description].filter(Boolean).join(' '));
  if (/\bpns\b|sinus|sinuz|paranaz|paranas|sinonaz|maksillofas/.test(text)) return 'pns';
  if (/temporal|kulak|mastoid|\biac\b|\bear\b|petroz|koklea|cochlea/.test(text)) return 'temporal';
  return null;
}

// A tilted plane's name in the summary, as the interface writes it (planeLower.* in src/i18n).
const PLANE_NAMES: Record<'tr' | 'en', Record<string, string>> = { tr: { axial: 'aksiyel', coronal: 'koronal', sagittal: 'sagittal' }, en: { axial: 'axial', coronal: 'coronal', sagittal: 'sagittal' } };
const SIDE_NAMES: Record<Side, Words> = { right: { tr: 'Sağ', en: 'Right' }, left: { tr: 'Sol', en: 'Left' }, both: { tr: '', en: '' } };

/** The checklist as text for the report: only what was marked, with the slice it was seen on. */
export function checklistSummary(kind: ChecklistKind, answers: Answers, notes: Notes, locale: 'tr' | 'en'): string {
  const list = CHECKLISTS[kind], lines = [list.title[locale]];
  for (const group of list.groups) for (const item of group.items) {
    const given = answers[item.id];
    if (!given || !Object.values(given).some(Boolean)) continue;
    const options = item.options ?? FINDING;
    const word = (value?: string) => options.find(option => option.value === value)?.[locale] ?? '–';
    const parts = item.sided ? (['right', 'left'] as const).map(side => `${SIDE_NAMES[side][locale]} ${word(given[side])}`) : [word(given.both)];
    const note = notes[item.id];
    const tilted = note?.tilt ? `, ${PLANE_NAMES[locale][note.plane] ?? note.plane} ${locale === 'tr' ? 'oblik' : 'oblique'} ${note.tilt}°` : '';
    lines.push(`${item.label[locale]}: ${parts.join(', ')}${note ? ` (${locale === 'tr' ? 'kesit' : 'slice'} ${note.shown}${tilted})` : ''}`);
  }
  return lines.join('\n');
}
