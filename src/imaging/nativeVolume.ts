import { sampleSeries } from '../api';
import type { CropBounds } from './volume3d';
import type { Series, Vec3 } from '../model';
import type { SegmentationTexture } from './segmentation';
import { newTargetId, targetId, type NativeFrame } from './nativeRender';

export interface SurfaceRequest {
  target: string; layerRevision: number; origin: Vec3; direction: Vec3; threshold: number;
  crop: CropBounds; radius?: number; strokeDepth?: number;
}
export interface TouchResult { point: Vec3; depth: number | null; strokeDepth: number; changed: number[] }
export interface NativeScene {
  seriesId:string; revision:number; target:string; layerRevision:number; width:number; height:number;
  center:Vec3; eye:Vec3; inverseVp:number[]; cropMin:Vec3; cropMax:Vec3;
  threshold:number; ramp:number; step:number; indexStep:number;
}
type Camera = Omit<NativeScene,'seriesId'|'revision'|'target'|'layerRevision'|'width'|'height'>;

// Runs refer to the target voxel grid. Adjacent equal labels share one span even across source rows.
export function packLayers(dimensions:Vec3, mask:Uint8Array | undefined, labels:SegmentationTexture | null):Uint8Array {
  const header=[1,labels?.colors.length ?? 0,0,0];
  const palette=labels?.colors.map(([r,g,b])=>(r<<16)|(g<<8)|b) ?? [];
  const runs:number[]=[];
  const [nx,ny]=dimensions;
  let start=-1, last=-1, value=0;
  const flush=()=>{
    if(start>=0) {
      if(runs.length>=16_000_000) throw new Error('Volume mask exceeds the layer memory budget');
      runs.push(start,last-start+1,value);
    }
    start=-1;
  };
  const add=(i:number,v:number)=>{
    if(!v) {if(start>=0) flush();return;}
    if(start>=0 && value===v && last+1===i) {last=i;return;}
    flush();start=i;last=i;value=v;
  };
  if(mask) for(let i=0;i<mask.length;i++) add(i,mask[i]===1 || mask[i]===2 ? mask[i] : 0);
  flush();header[2]=runs.length/3;
  if(labels) {
    const [w,h,d]=labels.size, [a,b,c]=labels.min;
    for(let z=0;z<d;z++) for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      add(((z+c)*ny+y+b)*nx+x+a,labels.labels[(z*h+y)*w+x]);
    }
    flush();header[3]=runs.length/3-header[2];
  }
  const result=new Uint32Array(header.length+palette.length+runs.length);
  result.set(header);result.set(palette,4);result.set(runs,4+palette.length);
  return new Uint8Array(result.buffer);
}

// A brush stroke changes a small sorted set of voxel indices, including zeroes for undo.
function packMaskPatch(previous: number, changed: Set<number>, mask: Uint8Array): Uint8Array {
  const indices = [...changed].sort((a,b) => a-b);
  const words = new Uint32Array(3 + indices.length * 2);
  words.set([2, previous, indices.length]);
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i], value = mask[index];
    words[3 + 2*i] = index;
    words[4 + 2*i] = value === 1 || value === 2 ? value : 0;
  }
  return new Uint8Array(words.buffer);
}

export class NativeVolumeView {
  private readonly target:string;
  private revision=0;
  private desiredLayer=0;
  private sentLayer=0;
  private uploaded=false;
  private upload?: Promise<void>;
  private disposed=false;
  private running=false;
  private next?:{revision:number;camera:Camera};
  private mask?:Uint8Array;
  private fullUpload = false;
  private maskChanges = new Set<number>();
  private labels:SegmentationTexture | null=null;
  constructor(privateCanvas: HTMLCanvasElement, series:Series, onFrame:(result:NativeFrame)=>void, onError:(reason:unknown)=>void) {
    this.canvas=privateCanvas; this.series=series; this.onFrame=onFrame; this.onError=onError; this.target=targetId(privateCanvas,true);
  }
  private readonly canvas:HTMLCanvasElement;
  private readonly series:Series;
  private readonly onFrame:(result:NativeFrame)=>void;
  private readonly onError:(reason:unknown)=>void;
  setMask(mask: Uint8Array, changes?: readonly Uint32Array[]) {
    this.mask = mask;
    this.desiredLayer++;
    if (changes && !this.fullUpload) {
      for (const part of changes) {
        if (this.maskChanges.size + part.length > 2_000_000) { this.fullUpload = true; break; }
        for (const index of part) this.maskChanges.add(index);
      }
    } else { this.fullUpload = true; }
    if (this.fullUpload) this.maskChanges.clear();
  }
  setLabels(labels:SegmentationTexture | null) {
    if (this.labels !== labels) { this.labels = labels; this.fullUpload = true; this.maskChanges.clear(); this.desiredLayer++; }
  }
  render(camera:Camera) {
    if(this.disposed) return;
    const revision=++this.revision;
    this.next={revision,camera};
    this.canvas.dataset.nativeRevision=String(revision);
    if(!this.running) void this.paint();
  }
  private async paint() {
    this.running=true;
    const {series,target,canvas}=this;
    try {
      while(this.next && !this.disposed) {
        const {revision,camera}=this.next;this.next=undefined;
        const layer=this.desiredLayer;
        try {
          await this.syncLayers();
          if(this.disposed || revision!==this.revision) continue;
          const frame=await window.veacom!.renderVolume(target,revision,series.engineGeneration!,{
            ...camera,seriesId:series.id,revision:series.sourceRevision!,target,layerRevision:layer,width:canvas.width,height:canvas.height});
          if (!this.disposed && revision===this.revision && canvas.dataset.nativePresented===String(revision)) this.onFrame(frame);
        }catch(error){if(!this.disposed && revision===this.revision) { if(this.uploaded)this.sentLayer=-1; this.onError(error); }}
      }
    }finally{this.running=false;if(this.disposed) this.release();}
  }
  private async syncLayers() {
    if (this.upload) await this.upload;
    const layer = this.desiredLayer;
    if (layer === this.sentLayer || this.disposed) return;
    const bytes = !this.fullUpload && this.mask && this.sentLayer >= 0
      ? packMaskPatch(this.sentLayer, this.maskChanges, this.mask)
      : packLayers(this.series.dimensions, this.mask, this.labels);
    this.maskChanges.clear();
    this.fullUpload = false;
    this.upload = window.veacom!.volumeLayers(this.series.id, this.series.sourceRevision!, this.series.engineGeneration!,
      this.target, layer, bytes).then(() => { this.sentLayer = layer; this.uploaded = true; });
    try { await this.upload; } catch (error) { this.fullUpload = true; throw error; } finally { this.upload = undefined; }
  }
  async touch(ray: Omit<SurfaceRequest, 'target' | 'layerRevision'>): Promise<TouchResult | null> {
    await this.syncLayers();
    if (this.disposed) return null;
    const result = await sampleSeries(this.series, { kind: 'surface', ...ray, target: this.target, layerRevision: this.sentLayer });
    if (result === null || this.disposed) return null;
    const hit = result as TouchResult;
    const size = this.series.dimensions.reduce((a,b)=>a*b,1);
    if (!Array.isArray(hit.point) || hit.point.length !== 3 || !hit.point.every(Number.isFinite)
      || !Number.isFinite(hit.strokeDepth) || (hit.depth !== null && !Number.isFinite(hit.depth))
      || !Array.isArray(hit.changed) || hit.changed.length > 2_000_000
      || !hit.changed.every(i => Number.isSafeInteger(i) && i >= 0 && i < size)) throw new Error('Invalid surgical sample.');
    return hit;
  }
  async refineSelection(mask: Uint8Array, crop: CropBounds, signal: AbortSignal) {
    const {series} = this;
    const target = newTargetId() + '-selection';
    const upload = (bytes: Uint8Array) => window.veacom!.volumeLayers(series.id, series.sourceRevision!, series.engineGeneration!, target, 1, bytes);
    await upload(packLayers(series.dimensions, mask, null));
    try {
      signal.throwIfAborted();
      const result = await sampleSeries(series, { kind: 'selection', target, layerRevision: 1, crop }) as CropBounds & { insideCount: number };
      signal.throwIfAborted();
      if (!result || !Number.isSafeInteger(result.insideCount) || result.insideCount <= 0
        || ![result.min, result.max].every(v => Array.isArray(v) && v.length === 3 && v.every((n, i) => Number.isInteger(n) && n >= crop.min[i] && n <= crop.max[i]))
        || result.min.some((n,i) => n > result.max[i])) throw new Error('Invalid selection bounds.');
      return { mask, crop: { min: result.min, max: result.max }, insideCount: result.insideCount };
    } finally { await upload(new Uint8Array()); }
  }
  async mesh(threshold: number, crop: CropBounds, signal: AbortSignal) {
    await this.syncLayers();
    signal.throwIfAborted();
    const invoke = (body: Parameters<NonNullable<typeof window.veacom>['surfaceMesh']>[4]) =>
      window.veacom!.surfaceMesh(this.series.id, this.series.engineGeneration!, this.series.sourceRevision!, this.target, body);
    const cancel = () => { void invoke(null).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const data = await invoke({ layerRevision: this.sentLayer, threshold, crop });
      signal.throwIfAborted();
      if (!(data instanceof ArrayBuffer) || data.byteLength < 84) throw new Error('Invalid STL result.');
      return data;
    } finally { signal.removeEventListener('abort', cancel); }
  }
  private release() {
    if(!this.uploaded) return;
    this.uploaded=false;
    void window.veacom!.volumeLayers(this.series.id,this.series.sourceRevision!,this.series.engineGeneration!,this.target,this.sentLayer,new Uint8Array()).catch(()=>{});
  }
  dispose(){this.disposed=true;if(this.canvas.id===this.target) this.canvas.dataset.nativeRevision=String(++this.revision);if(!this.running) this.release();}
}
