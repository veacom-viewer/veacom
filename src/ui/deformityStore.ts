// The deformity plans of the films open in the viewer, kept in memory while it is open: nothing is written to disk
// unless the reader saves a plan (docs/deformity-planning.md, "Saving"). The planning panel and the panes read the
// same store. Each change the reader makes is one step of the viewer's own Undo: the store asks App to remember the
// state before it, and App's Undo puts a remembered state back (App.tsx, `remember` and `undo`).
import { useSyncExternalStore } from 'react';
import { usage } from '../usage/tracker';
import type { LandmarkName } from '../imaging/deformity/landmarks';
import type { Landmarks, Side } from '../imaging/deformity/measure';
import type { Osteotomy } from '../imaging/deformity/osteotomy';
import type { Point } from '../imaging/deformity/plane';
import type { Series } from '../model';
import { filmKey } from '../imaging/radiograph';

/** One plan of one leg: its landmarks with how each point came to be, and a planned osteotomy. */
export interface LegPlan {
  id: string; name: string; side: Side;
  points: Landmarks;
  provenance: Partial<Record<LandmarkName, Array<'placed' | 'moved'>>>;
  osteotomy: Osteotomy | null;
}

/** A ball or ruler on the film, as the reader marked it: the ball's edge points, or the ruler's two marks. Whether it
 * calibrates the film is the film's own state (App's film calibrations, radiograph.ts withFilmCalibrations), not the
 * plan's: Undo of a plan step never changes a calibration. */
export interface Marker { method: 'ball' | 'ruler'; points: Point[]; knownMm: number; depthConfirmed: boolean }

export interface FilmPlans {
  /** The pane's film: the series and its frame (the index when the plans were made), with the frame's SOP Instance UID
   * and frame number, which the plans are kept by (filmKey) and a saved plan is matched by (as a hash). */
  seriesId: string; frame: number; sopInstanceUid: string; frameNumber: number;
  plans: LegPlan[]; active: string;
  /** The reader's answer when the film has no Patient Orientation: which side of the image the patient's right is on. */
  patientRight?: 'left' | 'right';
  marker: Marker | null;
}

/** What a click on the film places next, on which film (`filmKey`). A cut takes two clicks: the cortex that opens or
 * closes, then the hinge's. */
export type Placing = { film: string } & ({ kind: 'landmark'; name: LandmarkName } | { kind: 'ball' } | { kind: 'ruler' } | { kind: 'cut'; bone: 'femur' | 'tibia'; first?: Point });

export interface DeformityState {
  open: boolean;
  films: Readonly<Record<string, FilmPlans | undefined>>;
  placing: Placing | null;
  /** The simulated fragments are shown moved (otherwise the plan shows the film as it is). */
  simulate: boolean;
}

export { filmKey };
export interface FilmSelection { seriesId: string; key: string }

let state: DeformityState = { open: false, films: {}, placing: null, simulate: true };
const listeners = new Set<() => void>();
let rememberHook: ((calibration?: FilmSelection) => void) | null = null;
let counter = 0;

function set(next: DeformityState) { state = next; for (const listener of [...listeners]) listener(); }

export const deformity = {
  get: () => state,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  /** App's Undo: called before each change the reader makes. */
  connectUndo(remember: typeof rememberHook) { rememberHook = remember; },
  setOpen(open: boolean) { if (state.open !== open) set({ ...state, open, placing: open ? state.placing : null }); },
  setPlacing(placing: Placing | null) { set({ ...state, placing }); },
  setSimulate(simulate: boolean) { set({ ...state, simulate }); },
  /** The film's plans, made with one plan per side the film shows when it has none yet (not an undo step). */
  ensure(series: Pick<Series, 'id' | 'uid' | 'frameMetadata'>, frame: number, sides: Side[]): FilmPlans {
    const key = filmKey(series, frame), existing = state.films[key];
    if (existing) return existing;
    const plans = sides.map(side => newPlan(side)), metadata = series.frameMetadata?.[frame];
    const film: FilmPlans = { seriesId: series.id, frame, sopInstanceUid: metadata?.sopInstanceUid ?? '', frameNumber: metadata?.sourceFrameNumber ?? 1,
      plans, active: plans[0].id, marker: null };
    set({ ...state, films: { ...state.films, [key]: film } });
    return film;
  },
  /** A change by the reader: remembered for Undo first unless `remember` is false (the moves of one drag). */
  change(key: string, update: (film: FilmPlans) => FilmPlans, remember: boolean | 'calibration' = true) {
    const film = state.films[key];
    if (!film) return;
    const next = update(film);
    if (next === film) return;
    if (remember) rememberHook?.(remember === 'calibration' ? { seriesId: film.seriesId, key } : undefined);
    set({ ...state, films: { ...state.films, [key]: next } });
    // The usage timings count that the plan changed, never what changed (telemetry/TELEMETRY.md).
    usage.touch('marks');
  },
  /** What Undo keeps: the plans only (the panel and what a click places are not undone). */
  snapshot: () => state.films,
  restore(films: DeformityState['films'] | undefined) { if (films && films !== state.films) set({ ...state, films, placing: null }); },
};

/** An empty plan. Its name is empty until the reader adds a second plan of the same side (the panel numbers them). */
export function newPlan(side: Side, name = ''): LegPlan {
  counter++;
  return { id: `plan-${Date.now().toString(36)}-${counter}`, name, side, points: {}, provenance: {}, osteotomy: null };
}

/** The active plan of a film. */
export const activePlan = (film: FilmPlans) => film.plans.find(plan => plan.id === film.active) ?? film.plans[0];

/** The plan with one plan replaced. */
export const withPlan = (film: FilmPlans, plan: LegPlan): FilmPlans => ({ ...film, plans: film.plans.map(item => item.id === plan.id ? plan : item) });

export function useDeformity(): DeformityState {
  return useSyncExternalStore(deformity.subscribe, deformity.get, deformity.get);
}
