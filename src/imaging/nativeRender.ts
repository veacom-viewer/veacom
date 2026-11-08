import type { FusionSettings, Series, Vec3, ViewState, ViewVolume as Volume } from '../model';
import { screenMapping, screenToWorld, sub } from './geometry';
import { usesSourceFrames } from './viewState';
import { sourceFrameRef } from './nativeMeasurements';
import { petScale } from './fusion';
import { DISPLAY_CURVES, LOG_CURVE_K } from './displayCurve';
import { slabSampling } from './slab';

export interface NativeView {
  seriesId: string; revision: number; width: number; height: number;
  frame?: ReturnType<typeof sourceFrameRef>; top: Vec3; right: Vec3; down: Vec3;
  center: number; widthValue: number; inverted: boolean; palette: number; curve: number; logCurveK: number; voiFunction: number; voiLut?: number;
  slabMode: number; slabHalf: number; slabStep: Vec3;
  fusion?: {seriesId: string; revision: number; factor?: number; opacity: number; upper: number; palette: number; classic: boolean};
}
export interface NativeFrame { lease: number; adapter: string; gpuCompleteMs: number }
export function nativeRendering(): boolean {
  return typeof window !== 'undefined' && window.veacom?.nativeRendering === true;
}
function revision(series: Series): number {
  if (!series.sourceRevision) throw new Error('Source revision unavailable');
  return series.sourceRevision;
}
const paletteIndex = (name: string | undefined) => ['hot','ge','rainbow','hot_metal','red_yellow'].indexOf(name ?? 'gray');

export function nativeView(volume: Volume, view: ViewState, width: number, height: number, cssWidth: number, fusion?: FusionSettings | null): NativeView {
  const series = volume.series;
  const index = volume.sourceFrameIndex ?? (usesSourceFrames(series,view) ? Math.round(view.slice) : undefined);
  const ratio = width / Math.max(1,cssWidth);
  const mapping = screenMapping(series, index === undefined ? view : { ...view, mode:'source', slice:index }, width/ratio,height/ratio);
  const top = screenToWorld(mapping,0,0);
  const slab = index === undefined ? slabSampling(series,view) : {mode:0,half:0,step:[0,0,0] as Vec3};
  return {seriesId:series.id,revision:revision(series),width,height,top,right:sub(screenToWorld(mapping,1/ratio,0),top),down:sub(screenToWorld(mapping,0,1/ratio),top),
    frame:index===undefined ? undefined : sourceFrameRef(series,index), center:view.windowCenter,widthValue:Math.max(1,view.windowWidth),inverted:view.inverted,palette:paletteIndex(view.palette),
    curve:DISPLAY_CURVES[view.curve ?? 'linear'],logCurveK:LOG_CURVE_K,
    voiFunction:index===undefined?0:view.voiFunction==='SIGMOID'?2:view.voiFunction==='LINEAR_EXACT'?1:0,voiLut:index===undefined?undefined:view.voiLut,
    slabMode:slab.mode,slabHalf:slab.half,slabStep:slab.step, fusion:fusion ? {seriesId:fusion.volume.series.id, revision:revision(fusion.volume.series),
      factor:petScale(fusion.volume),upper:fusion.upperSuv,opacity:fusion.opacity,palette:paletteIndex(fusion.palette),classic:fusion.blend==='classic'} : undefined};
}

interface Draw {
  revision: number; body: NativeView; generation: number;
  resolve(result: NativeFrame | null): void; reject(error: unknown): void;
}
interface State { next: number; busy: boolean; waiting?: Draw }
const views = new WeakMap<HTMLCanvasElement,State>();
let nextTarget = 0;
export function newTargetId(): string { return 'veacom-native-' + (++nextTarget); }
export function targetId(canvas:HTMLCanvasElement, fresh = false):string {
  if (fresh || !canvas.id) canvas.id=newTargetId();
  return canvas.id;
}
export function drawNativeView(canvas: HTMLCanvasElement, volume: Volume, view: ViewState, fusion: FusionSettings | null | undefined, width: number, height: number): Promise<NativeFrame | null> {
  const body=nativeView(volume,view,width,height,canvas.getBoundingClientRect().width,fusion);
  targetId(canvas);
  let state=views.get(canvas);
  if (!state) {state={next:0,busy:false};views.set(canvas,state);}
  const revision=++state.next;
  canvas.dataset.nativeRevision=String(revision);
  canvas.dataset.nativeWidth=String(width);
  canvas.dataset.nativeHeight=String(height);
  state.waiting?.resolve(null);
  return new Promise((resolve,reject)=>{
    state.waiting={revision,body,generation:volume.series.engineGeneration!,resolve,reject};
    if (!state.busy) void paint(canvas,state);
  });
}
async function paint(canvas:HTMLCanvasElement,state:State) {
  state.busy=true;
  try {
    while (state.waiting) {
      const draw=state.waiting; state.waiting=undefined;
      if (!canvas.isConnected) {draw.resolve(null);continue;}
      try {
        const result=await window.veacom!.renderView(canvas.id,draw.revision,draw.generation,draw.body);
        draw.resolve(draw.revision===state.next && canvas.dataset.nativePresented===String(draw.revision) ? result : null);
      } catch(error) {if(draw.revision===state.next) draw.reject(error);else draw.resolve(null);}
    }
  } finally {state.busy=false;}
}
