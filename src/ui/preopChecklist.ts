// The pre-operative checklists (the user's design, 2026-11-06): what a surgeon wants looked at before sinus or ear
// surgery, each finding marked present, absent or not assessable, per side, with the slice it was seen on. A PNS CT
// opens the CLOSE checklist (cribriform plate, lamina papyracea, Onodi cell, sphenoid, ethmoid artery); a temporal
// bone CT the third-window, ossicle, facial canal, inner ear and tegmen checklist.
import type { CaliperKind, Series, Vec3 } from '../model';
import { caliperReport, type CaliperResult } from '../imaging/calipers';
import { translate } from '../i18n';
import { foldSearch } from './seriesNames';

export type ChecklistKind = 'pns' | 'temporal';
type Words = { tr: string; en: string };
export interface ChecklistItem { id: string; label: Words; hint: Words; sided: boolean; options?: Array<{ value: string } & Words> }
export interface ChecklistGroup { title: Words; items: ChecklistItem[] }
export type Side = 'right' | 'left' | 'both';
export type Answers = Partial<Record<string, Partial<Record<Side, string>>>>;
/** What a caliper measured for an item and side (src/imaging/calipers.ts). The note keeps the points and the reading,
 * so deleting the drawing on the image leaves the checklist's record. */
export interface CaliperNote {
  /** The measurement it was drawn as, on the note's series; an edit to it measures again. */
  annotationId: string;
  kind: CaliperKind;
  /** Patient coordinates (mm), in the caliper's order. */
  points: Vec3[];
  result: CaliperResult;
  /** The answer it gave: it follows the drawing's edits until the reader picks another answer. */
  given?: string;
}
export interface SliceNote { seriesId: string; slice: number; shown: string; plane: string; mode: string;
  /** A tilted reconstruction: its pitch and yaw, and the tilt from the plain plane in degrees. */
  oblique?: [number, number]; tilt?: number;
  caliper?: CaliperNote }
/** Where each finding was seen, per item and side (`both` for an item with one answer). */
export type Notes = Partial<Record<string, Partial<Record<Side, SliceNote>>>>;
export interface ChecklistState { kind: ChecklistKind; answers: Answers; notes: Notes }

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

const sidesOf = (item: ChecklistItem): Side[] => item.sided ? ['right', 'left'] : ['both'];

/** One side of an item as the report and the theatre card give it. */
export interface CheckedSide {
  side: Side;
  /** The answer's word in the language asked for, or – when nothing is marked. */
  word: string;
  marked: boolean;
  /** What a caliper measured there, as the report says it. */
  measured?: string;
  nearLimit: boolean;
  /** Where it was seen: "slice 41/141", with the tilt of a tilted plane. */
  slice?: string;
  /** The plane it was seen on, in lower case. */
  plane?: string;
}
export interface CheckedItem { id: string; label: string; hint: string; sided: boolean; sides: CheckedSide[];
  /** Both olfactory fossae measured: "right–left difference 2.5 mm". */
  difference?: string }

/** Every item of the checklist with its sides as marked, measured and noted, group by group, in one language. */
export function checklistRows(kind: ChecklistKind, answers: Answers, notes: Notes, locale: 'tr' | 'en'): Array<{ title: string; items: CheckedItem[] }> {
  return CHECKLISTS[kind].groups.map(group => ({ title: group.title[locale], items: group.items.map(item => {
    const given = answers[item.id] ?? {}, seen = notes[item.id] ?? {}, options = item.options ?? FINDING, sides = sidesOf(item);
    const checked = sides.map((side): CheckedSide => {
      const note = seen[side], result = note?.caliper?.result, value = given[side];
      const tilted = note?.tilt ? `, ${PLANE_NAMES[locale][note.plane] ?? note.plane} ${locale === 'tr' ? 'oblik' : 'oblique'} ${note.tilt}°` : '';
      return { side, word: options.find(option => option.value === value)?.[locale] ?? '–', marked: Boolean(value),
        nearLimit: Boolean(result && 'reading' in result && 'nearLimit' in result.reading && result.reading.nearLimit),
        ...(result ? { measured: caliperReport(result, locale) } : {}),
        ...(note ? { slice: `${locale === 'tr' ? 'kesit' : 'slice'} ${note.shown}${tilted}`, plane: PLANE_NAMES[locale][note.plane] ?? note.plane } : {}) };
    });
    const depths = sides.map(side => { const result = seen[side]?.caliper?.result; return result && 'reading' in result && result.reading.kind === 'keros' ? result.reading.depth : null; });
    const difference = depths.length === 2 && depths[0] !== null && depths[1] !== null
      ? translate(locale, 'checklist.difference', { value: Math.abs(depths[0] - depths[1]).toFixed(1) }) : undefined;
    return { id: item.id, label: item.label[locale], hint: item.hint[locale], sided: item.sided, sides: checked, ...(difference ? { difference } : {}) };
  }) }));
}

/** Whether a row goes into the report: a side answered or measured. A slice noted alone does not take it there. */
const inReport = (item: CheckedItem) => item.sides.some(side => side.marked || side.measured);

/** The ids of the rows "Copy for the report" leaves out, in the list's order: nothing on any side answered or measured.
 * A row with one side answered is copied, the other side as "–". */
export function unmarkedItems(kind: ChecklistKind, answers: Answers, notes: Notes): string[] {
  return checklistRows(kind, answers, notes, 'en').flatMap(group => group.items).filter(item => !inReport(item)).map(item => item.id);
}

/** The checklist as text for the report: what was marked or measured, each side with its measurement and the slice it
 * was seen on. Both olfactory fossae measured give their difference. */
export function checklistSummary(kind: ChecklistKind, answers: Answers, notes: Notes, locale: 'tr' | 'en'): string {
  const lines = [CHECKLISTS[kind].title[locale]];
  for (const group of checklistRows(kind, answers, notes, locale)) for (const item of group.items) {
    if (!inReport(item)) continue;
    const parts = item.sides.map(side => {
      const details = [side.measured, side.slice].filter(Boolean).join('; ');
      const answer = side.side === 'both' ? side.word : `${SIDE_NAMES[side.side][locale]} ${side.word}`;
      return details ? `${answer} (${details})` : answer;
    });
    lines.push(`${item.label}: ${parts.join(', ')}${item.difference ? `; ${item.difference}` : ''}`);
  }
  return lines.join('\n');
}

/** A side of a row, where the checklist's keys act: `row` indexes the list's items in order. */
export interface ChecklistCell { row: number; side: Side }
/** What a key does inside the checklist: move between rows (↑ ↓) or sides (← →), or answer with the row's first to ninth
 * answer (Alt with 1–9, by position, so the keys mean the same in every language), on both sides with Shift too. */
export type ChecklistKey = { move: 'up' | 'down' | 'left' | 'right' } | { answer: number; both: boolean };

const MOVES: Partial<Record<string, 'up' | 'down' | 'left' | 'right'>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** The checklist's meaning of a key press, or null. An answer is Alt (⌥) with a digit: a plain digit is a window preset
 * on the image, and keeps that one meaning. The digit is read from the key's place (`code`), since Alt, Shift and the
 * layout change the character it types. ⌘ and Ctrl combinations belong to the app; so does AltGr, which Windows reports
 * as Ctrl+Alt and which types characters on a Turkish keyboard. Only the top-row digits answer: with Alt, the keypad's
 * digits type characters by their codes on Windows. */
export function checklistKey(event: { key: string; code: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): ChecklistKey | null {
  if (event.metaKey || event.ctrlKey) return null;
  const move = MOVES[event.key];
  if (move) return event.shiftKey || event.altKey ? null : { move };
  const digit = event.altKey ? /^Digit([1-9])$/.exec(event.code) : null;
  return digit ? { answer: Number(digit[1]) - 1, both: event.shiftKey } : null;
}

/** The cell a move goes to. ← and → go to the Right and Left columns as the checklist shows them (patient's right on
 * the left, as on the image); a one-answer row has neither. ↑ and ↓ keep the column, or take `column` (the last one
 * used) when leaving a one-answer row; they stop at the first and last rows. */
export function moveCell(items: readonly ChecklistItem[], at: ChecklistCell, move: 'up' | 'down' | 'left' | 'right', column: 'right' | 'left'): ChecklistCell {
  if (move === 'left' || move === 'right') return items.at(at.row)?.sided ? { row: at.row, side: move === 'left' ? 'right' : 'left' } : at;
  const row = Math.max(0, Math.min(items.length - 1, at.row + (move === 'up' ? -1 : 1)));
  return { row, side: items[row].sided ? (at.side === 'both' ? column : at.side) : 'both' };
}

/** The checklist after answering `at` by key with the row's answer `index` (on both sides of a sided row with `both`),
 * and the cell the keys move on to: the left side after the right, else the next row's right side; the last cell stays.
 * A key sets its answer and never clears it, unlike a second click. Null when the row has no such answer. */
export function answerByKey(state: ChecklistState, items: readonly ChecklistItem[], at: ChecklistCell, index: number, both: boolean): { state: ChecklistState; next: ChecklistCell } | null {
  const item = items.at(at.row), option = item && (item.options ?? FINDING).at(index);
  if (!option) return null;
  const sides = both ? sidesOf(item) : [at.side];
  const answers = { ...state.answers, [item.id]: { ...state.answers[item.id], ...Object.fromEntries(sides.map(side => [side, option.value])) } };
  const following = items.at(at.row + 1);
  const next: ChecklistCell = !both && at.side === 'right' ? { row: at.row, side: 'left' }
    : following ? { row: at.row + 1, side: following.sided ? 'right' : 'both' } : at;
  return { state: { ...state, answers }, next };
}

/** The checklist after a caliper drawing measured `item` on `side`: its note, and the answer it gives. A new drawing
 * sets its answer. An edited one moves its note (a septum can change side) and its answer, unless the reader picked
 * another answer since. The answer an earlier drawing gave on that side goes with that drawing. */
export function recordCaliper(state: ChecklistState, item: string, side: Side, note: SliceNote & { caliper: CaliperNote }): ChecklistState {
  const notes = { ...state.notes[item] }, answers = { ...state.answers[item] };
  const id = note.caliper.annotationId, earlier = (Object.keys(notes) as Side[]).find(where => notes[where]?.caliper?.annotationId === id);
  let follows = true;
  if (earlier) {
    follows = answers[earlier] === notes[earlier]?.caliper?.given;
    if (follows) delete answers[earlier];
    delete notes[earlier];
  }
  const replaced = notes[side]?.caliper;
  if (replaced && answers[side] === replaced.given) delete answers[side];
  notes[side] = note;
  if (follows && note.caliper.given !== undefined) answers[side] = note.caliper.given;
  return { ...state, notes: { ...state.notes, [item]: notes }, answers: { ...state.answers, [item]: answers } };
}
