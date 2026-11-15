// Labelling a folder of long-leg films one after another (docs/deformity-planning.md, "Labelling a folder"): the folder's
// films and the state of the plan beside each, the film shown, and the run's settings. Kept outside the deformity panel,
// which closes while a film is replaced by the next. The files are the platform's (window.veacom.labelFolder): main
// on the desktop, src/web/labelFolder.ts in the browser. A plan is written only by Save and next.
import { useSyncExternalStore } from 'react';
import type { LabelFilm, LabelFolder } from '../model';
import type { Side } from '../imaging/deformity/measure';
import { PLAN_SCHEMA, PLAN_VERSION } from './deformityFile';

/** A film's plan file: none, saved, saved with a suggestion of some landmark shown (suggestionShown), saved with no
 * landmark, or one that cannot be read as a plan of this version. */
export type PlanState = 'none' | 'saved' | 'shown' | 'empty' | 'unreadable';

export function planState(film: LabelFilm): PlanState {
  if (film.unreadable) return 'unreadable';
  if (film.plan === null) return 'none';
  let value: unknown;
  try { value = JSON.parse(film.plan); } catch { return 'unreadable'; }
  if (!isObject(value) || value.schema !== PLAN_SCHEMA || value.version !== PLAN_VERSION || !Array.isArray(value.plans)) return 'unreadable';
  const labels = (value.plans as unknown[]).flatMap(plan => isObject(plan) && Array.isArray(plan.landmarks) ? plan.landmarks as unknown[] : []);
  if (!labels.length) return 'empty';
  return labels.some(label => isObject(label) && label.suggestionShown === true) ? 'shown' : 'saved';
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface QueueState {
  folder: LabelFolder | null;
  /** The film shown, and its series once imported: a plan is saved only for these. */
  index: number;
  seriesIds: string[];
  /** The film whose plan file has been put on it (or that had none to put); `refused`: the file did not open, and why. */
  loaded: { index: number; refused?: string } | null;
  /** A film is being opened or its plan written: the queue's buttons wait. */
  busy: boolean;
  /** Suggestions may be asked for on this run; off, the reader labels blind (suggestionShown stays false). */
  suggestions: boolean;
  /** The legs a film gets a plan for when it has none. */
  sides: Side[];
  status: string | null;
}

const EMPTY: QueueState = { folder: null, index: 0, seriesIds: [], loaded: null, busy: false, suggestions: true, sides: ['R', 'L'], status: null };
let state = EMPTY;
const listeners = new Set<() => void>();
function set(patch: Partial<QueueState>) { state = { ...state, ...patch }; for (const listener of [...listeners]) listener(); }

export const labelQueue = {
  get: () => state,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  /** A folder chosen: its films, none shown yet. The settings carry over from the last run. */
  start(folder: LabelFolder) { set({ folder, index: 0, seriesIds: [], loaded: null, busy: false, status: null }); },
  stop() { set({ ...EMPTY, suggestions: state.suggestions, sides: state.sides }); },
  /** Waits (true) while a film opens or a plan is written; refused (false) when the queue already waits. */
  begin(): boolean { if (state.busy || !state.folder) return false; set({ busy: true }); return true; },
  /** Done waiting, with what the reader should read, or keeping what is shown. */
  end(status?: string | null) { set({ busy: false, ...(status === undefined ? {} : { status }) }); },
  say(status: string | null) { set({ status }); },
  shown(index: number, seriesIds: string[]) { set({ index, seriesIds, loaded: null }); },
  loaded(index: number, refused?: string) { if (index === state.index) set({ loaded: { index, ...(refused ? { refused } : {}) } }); },
  /** A plan written for a film: the list shows its new state. */
  saved(index: number, text: string) {
    if (!state.folder) return;
    set({ folder: { ...state.folder, films: state.folder.films.map((film, i) => i === index ? { name: film.name, plan: text } : film) } });
  },
  setSuggestions(suggestions: boolean) { set({ suggestions }); },
  setSides(sides: Side[]) { if (sides.length) set({ sides }); },
};

export function useLabelQueue(): QueueState {
  return useSyncExternalStore(labelQueue.subscribe, labelQueue.get, labelQueue.get);
}

/** The legs a film shows: the one its laterality names, else both. */
export const filmSides = (laterality: string | undefined): Side[] => laterality === 'R' ? ['R'] : laterality === 'L' ? ['L'] : ['R', 'L'];

/** The legs to plan on a film that has no plan yet: the run's, among those the film shows, or the run's when the film
 * shows none of them. */
export function sidesFor(run: readonly Side[], laterality: string | undefined): Side[] {
  const shows = filmSides(laterality), both = run.filter(side => shows.includes(side));
  return both.length ? both : [...run];
}
