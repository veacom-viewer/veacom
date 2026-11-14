import { petScale } from './fusion';
import { MAX_PROJECTION_HALF, MAX_SLAB_HALF, slabSampling } from './slab';
import { usesSourceFrames } from './viewState';
import type { FusionSettings, PixelArray, Series, Vec3, ViewState, VoiLut, Volume } from '../model';
import { isProjection, screenMapping, screenToWorld, sourceFrameSeries, sub, worldToIndex, worldToIndexMatrix } from './geometry';
import { LocalizedError, t } from '../i18n';
import { isSoftwareRenderer } from './rendererInfo';

type TextureKind = 'float32' | 'int16' | 'uint16' | 'uint8' | 'rgb8';
type TextureDimension = '2d' | '3d';
interface CachedTexture { texture: WebGLTexture; padding: WebGLTexture | null; data: WeakRef<PixelArray>; touched: number; bytes: number; }
interface Program { key: string; program: WebGLProgram; shaders: [WebGLShader, WebGLShader] | null;
  preparation?: Promise<void>; uniforms: Map<string, WebGLUniformLocation | null>; }
/** `software` is true when WebGL draws on the CPU because no usable graphics driver is available. */
export interface RendererInfo { vendor: string; renderer: string; version: string; maxTextureSize: number; max3DTextureSize: number; software: boolean; }

function readRendererInfo(gl: WebGL2RenderingContext): RendererInfo {
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  return { vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR)), renderer,
    version: String(gl.getParameter(gl.VERSION)), maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    max3DTextureSize: Number(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)), software: isSoftwareRenderer(renderer) };
}

const VOI_ROW = 4096;
const VOI_UNIT = 4;

const vertex = `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

function textureKind(volume: Volume): TextureKind {
  if (volume.series.components === 3) {
    if (!(volume.data instanceof Uint8Array)) throw new Error('RGB source frames require an interleaved 8-bit RGB buffer.');
    return 'rgb8';
  }
  if (volume.data instanceof Int16Array) return 'int16';
  if (volume.data instanceof Uint16Array) return 'uint16';
  if (volume.data instanceof Uint8Array) return 'uint8';
  if (volume.data instanceof Float32Array || volume.data instanceof Float64Array) return 'float32';
  throw new Error('Unsupported volume pixel type.');
}

function samplerType(kind: TextureKind, dimension: TextureDimension): string {
  const prefix = kind === 'int16' ? 'i' : kind === 'uint16' || kind === 'uint8' ? 'u' : '';
  return `${prefix}sampler${dimension === '2d' ? '2D' : '3D'}`;
}

function scalarSampling(prefix: 'image' | 'pet', sampler: string, dimensions: string, floating: boolean, dimension: TextureDimension): string {
  // Integer texture fetches are converted per sample in the shader, preserving compact GPU storage.
  const voxel = `
uniform sampler2D ${prefix}Padding;
uniform bool ${prefix}HasPadding;
float ${prefix}Voxel(ivec3 p) {
  p=clamp(p,ivec3(0),ivec3(${dimensions})-1);
  float value=float(texelFetch(${sampler}, ${dimension === '2d' ? 'p.xy' : 'p'}, 0).r);
  if (${prefix}HasPadding) {
    vec3 padding=texelFetch(${prefix}Padding,ivec2(${dimension === '2d' ? '0' : 'p.z'},0),0).rgb;
    if (padding.x>0.5&&value>=padding.y&&value<=padding.z) return uintBitsToFloat(0x7fc00000u);
  }
  return value;
}`;
  // Acquired frames use exact texel fetches; their shader never calls trilinear sampling.
  if (dimension === '2d') return voxel;
  return `${voxel}
float ${prefix}Linear(vec3 p) {
  if (${floating ? 'true' : `${prefix}HasPadding`}) {
  float nearest=${prefix}Voxel(ivec3(floor(p+vec3(0.5))));
  if (nonFinite(nearest)) return nearest;
  ivec3 b=ivec3(floor(p)); vec3 f=fract(p);
  float weighted=0.0, totalWeight=0.0;
  for (int z=0;z<2;z++) for (int y=0;y<2;y++) for (int x=0;x<2;x++) {
    float weight=(x==0 ? 1.0-f.x : f.x)*(y==0 ? 1.0-f.y : f.y)*(z==0 ? 1.0-f.z : f.z);
    if (weight<=0.0) continue;
    float value=${prefix}Voxel(b+ivec3(x,y,z));
    if (nonFinite(value)) continue;
    weighted+=value*weight; totalWeight+=weight;
  }
  return totalWeight>0.0 ? weighted/totalWeight : nearest;
  } else {
  ivec3 b=ivec3(floor(p)); vec3 f=fract(p);
  float x00=mix(${prefix}Voxel(b),${prefix}Voxel(b+ivec3(1,0,0)),f.x);
  float x10=mix(${prefix}Voxel(b+ivec3(0,1,0)),${prefix}Voxel(b+ivec3(1,1,0)),f.x);
  float x01=mix(${prefix}Voxel(b+ivec3(0,0,1)),${prefix}Voxel(b+ivec3(1,0,1)),f.x);
  float x11=mix(${prefix}Voxel(b+ivec3(0,1,1)),${prefix}Voxel(b+ivec3(1,1,1)),f.x);
  return mix(mix(x00,x10,f.y),mix(x01,x11,f.y),f.z);
  }
}`;
}

/** A whole-volume projection gets a program of its own, with a longer sampling loop; every other program's source is
 * as it was. */
function fragment(main: TextureKind, dimension: TextureDimension, pet?: TextureKind, projection = false): string {
  const color = main === 'rgb8';
  return `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp isampler3D;
precision highp usampler3D;
precision highp sampler2D;
precision highp isampler2D;
precision highp usampler2D;
uniform ${samplerType(main, dimension)} uImage;
uniform vec3 uDimensions;
uniform vec3 uIndexTopLeft;
uniform vec3 uIndexRight;
uniform vec3 uIndexDown;
uniform float uScreenHeight;
${dimension === '2d' ? 'uniform vec3 uFull;\nuniform vec4 uTile;\nuniform vec2 uTileOrigin;' : ''}
${color || dimension !== '3d' ? '' : 'uniform int uSlabMode;\nuniform int uSlabHalf;\nuniform vec3 uSlabStep;'}
${color ? '' : 'uniform vec2 uWindow;\nuniform bool uInvert;\nuniform int uBasePalette;\nuniform int uVoiFunction;\nuniform bool uVoi;\nuniform usampler2D uVoiLut;\nuniform float uVoiFirst;\nuniform int uVoiCount;\nuniform float uVoiMax;'}
${pet ? `uniform ${samplerType(pet, '3d')} uPet;
uniform vec3 uPetDimensions;
uniform vec3 uPetIndexTopLeft;
uniform vec3 uPetIndexRight;
uniform vec3 uPetIndexDown;
uniform float uSuvFactor;
uniform float uPetOpacity;
uniform float uPetUpper;
uniform int uPalette;
uniform int uPetBlend;` : ''}
out vec4 outColor;
bool outside(vec3 p,vec3 size) { return any(lessThan(p,vec3(-0.5))) || any(greaterThan(p,size-vec3(0.5))); }
// Padding and missing values are NaN. Test the exponent bits, not GLSL's isnan or isinf: on Windows, ANGLE's
// Direct3D shader compiler may optimise those away, which drew padding white in inverted images and
// darkened float pixels next to padding.
bool nonFinite(float v) { return (floatBitsToUint(v)&0x7f800000u)==0x7f800000u; }
${color ? '' : scalarSampling('image', 'uImage', 'uDimensions', main === 'float32', dimension)}
${pet ? scalarSampling('pet', 'uPet', 'uPetDimensions', pet === 'float32', '3d') : ''}
${color || dimension !== '3d' ? '' : `
// Thick slab: the brightest, darkest or mean value of the samples either side of the slice, along its normal.
float slabValue(vec3 p,float centre) {
  bool found=!nonFinite(centre);
  float best=centre, sum=found ? centre : 0.0; int count=found ? 1 : 0;
  for (int k=1;k<=${projection ? MAX_PROJECTION_HALF : MAX_SLAB_HALF};k++) {
    if (k>uSlabHalf) break;
    for (int side=-1;side<=1;side+=2) {
      vec3 q=p+uSlabStep*float(k*side);
      if (outside(q,uDimensions)) continue;
      float v=imageLinear(q);
      if (nonFinite(v)) continue;
      if (!found) { best=v; found=true; } else if (uSlabMode==1) best=max(best,v); else if (uSlabMode==2) best=min(best,v);
      sum+=v; count++;
    }
  }
  return uSlabMode==3 ? (count>0 ? sum/float(count) : centre) : best;
}`}
${color ? '' : `
vec3 palette(float t,int selected) {
  // Siemens' hot metal and a red-yellow scale (VEAcom Next's colour stops).
  if (selected==3) return vec3(clamp(2.0*t,0.0,1.0),clamp((t-0.25)*4.0/3.0,0.0,1.0),clamp((t-0.75)*4.0,0.0,1.0));
  if (selected==4) {
    if (t<0.3) return mix(vec3(0.5,0.0,0.0),vec3(0.95,0.05,0.0),t/0.3);
    if (t<0.65) return mix(vec3(0.95,0.05,0.0),vec3(1.0,0.55,0.0),(t-0.3)/0.35);
    return mix(vec3(1.0,0.55,0.0),vec3(1.0,0.92,0.1),(t-0.65)/0.35);
  }
  if (selected==2) return clamp(vec3(1.5)-abs(4.0*t-vec3(3.0,2.0,1.0)),0.0,1.0);
  if (selected==1) return clamp(vec3(t*3.0,t*3.0-1.0,t*3.0-2.0),0.0,1.0);
  return clamp(vec3(t*3.0,t*2.8-0.8,t*3.2-2.2),0.0,1.0);
}`}
void main() {
  vec3 p=uIndexTopLeft+uIndexRight*gl_FragCoord.x+uIndexDown*(uScreenHeight-gl_FragCoord.y);
  ${dimension === '2d' ? `// A frame over the GPU's 2D limit is drawn as tiles (frameTiles): each draw keeps its own part of the frame.
  if (outside(p,uFull)) { outColor=vec4(0.0,0.0,0.0,1.0); return; }
  if (p.x<uTile.x||p.x>=uTile.z||p.y<uTile.y||p.y>=uTile.w) discard;
  p.xy-=uTileOrigin;` : 'if (outside(p,uDimensions)) { outColor=vec4(0.0,0.0,0.0,1.0); return; }'}
  ${color ? `
  ivec3 sourcePixel=clamp(ivec3(floor(p+vec3(0.5))),ivec3(0),ivec3(uDimensions)-1);
  outColor=vec4(texelFetch(uImage,${dimension === '2d' ? 'sourcePixel.xy' : 'sourcePixel'},0).rgb,1.0);
  ` : `
  float value=${dimension === '2d' ? 'imageVoxel(ivec3(floor(p+vec3(0.5))))' : 'imageLinear(p);\n  if (uSlabMode>0) value=slabValue(p,value)'};
  if (nonFinite(value)) { outColor=vec4(0.0,0.0,0.0,1.0); return; }
  float grey;
  if (uVoi) {
    // The VOI LUT entry for the nearest input value, clamped at both ends; rows of ${VOI_ROW} entries.
    int entry=int(clamp(floor(value+0.5)-uVoiFirst,0.0,float(uVoiCount-1)));
    grey=float(texelFetch(uVoiLut,ivec2(entry%${VOI_ROW},entry/${VOI_ROW}),0).r)/uVoiMax;
  } else if (uVoiFunction==2) grey=1.0/(1.0+exp(-4.0*(value-uWindow.x)/uWindow.y));
  else if (uVoiFunction==1) grey=clamp((value-uWindow.x)/uWindow.y+0.5,0.0,1.0);
  else grey=uWindow.y<=1.0 ? step(uWindow.x-0.5,value) : clamp((value-(uWindow.x-0.5))/(uWindow.y-1.0)+0.5,0.0,1.0);
  if (uInvert) grey=1.0-grey;
  vec3 rgb=uBasePalette<0 ? vec3(grey) : palette(grey,uBasePalette);
  ${pet ? `
  vec3 q=uPetIndexTopLeft+uPetIndexRight*gl_FragCoord.x+uPetIndexDown*(uScreenHeight-gl_FragCoord.y);
  if (!outside(q,uPetDimensions)) {
    float sampled=petLinear(q);
    if (!nonFinite(sampled)) {
      float uptake=max(0.0,sampled*uSuvFactor);
      float t=clamp(uptake/max(0.001,uPetUpper),0.0,1.0);
      rgb=mix(rgb,palette(t,uPalette),clamp(uPetOpacity,0.0,1.0)*(uPetBlend==1 ? 1.0 : smoothstep(0.0,0.08,t)));
    }
  }` : ''}
  outColor=vec4(rgb,1.0);
  `}
}`;
}

/** A part of a source frame drawn on its own: `core` is the part it draws, in pixels [x0, y0, x1, y1), and the texture
 * holds it with `TILE_HALO` pixels more on each side where the frame has them, for sampling that reads beyond a pixel. */
export interface FrameTile { x: number; y: number; width: number; height: number; core: [number, number, number, number] }
/** Pixels each tile's texture holds beyond the part it draws. */
export const TILE_HALO = 64;
/**
 * The tiles of a source frame of `width` × `height` pixels for a GPU whose 2D textures hold `limit` pixels a side: one
 * tile, the whole frame, when it fits. Feasibility study gap G4: a long film may exceed the limit (16,384 on most GPUs,
 * WARP and llvmpipe; 8,192 on SwiftShader).
 */
export function frameTiles(width: number, height: number, limit: number): FrameTile[] {
  if (width <= limit && height <= limit) return [{ x: 0, y: 0, width, height, core: [0, 0, width, height] }];
  const step = limit - 2 * TILE_HALO;
  if (step < 1) throw new Error(t('gpu.frameTextureLimit', { limit }));
  const cuts = (size: number) => { const list: Array<[number, number]> = []; for (let at = 0; at < size; at += step) list.push([at, Math.min(size, at + step)]); return list; };
  return cuts(height).flatMap(([y0, y1]) => cuts(width).map(([x0, x1]) => {
    const x = Math.max(0, x0 - TILE_HALO), y = Math.max(0, y0 - TILE_HALO);
    return { x, y, width: Math.min(width, x1 + TILE_HALO) - x, height: Math.min(height, y1 + TILE_HALO) - y, core: [x0, y0, x1, y1] as [number, number, number, number] };
  }));
}

/** One GPU context and texture cache is shared by all 2D panes, including 5×5 layouts. */
class SharedSliceRenderer {
  readonly canvas = document.createElement('canvas');
  readonly gl: WebGL2RenderingContext;
  info: RendererInfo;
  /** A smaller 2D texture limit than the GPU's, for checks that exercise tiling on any GPU (frameTiles). */
  private forcedTextureLimit: number | null = null;
  private programs = new Map<string, Program>();
  private current: Program | null = null;
  private textures = new Map<string, CachedTexture>();
  private identities = new WeakMap<object, number>();
  private nextIdentity = 1;
  private visible = new Set<string>();
  private emptyPadding: WebGLTexture | null = null;
  private parallel: KHR_parallel_shader_compile | null;
  private voiTextures = new Map<VoiLut | null, WebGLTexture>();
  private lost = false;
  constructor() {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new LocalizedError('gpu.webglUnavailable');
    this.gl = gl;
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.textures.clear(); this.programs.clear(); this.voiTextures.clear(); this.current = null; this.emptyPadding = null; this.lost = false;
      this.parallel = gl.getExtension('KHR_parallel_shader_compile');
      // A restored context can run on a different renderer, for example after the GPU process fell back to software.
      this.info = readRendererInfo(gl);
      window.dispatchEvent(new Event('veacom-gpu-restored'));
    });
    this.info = readRendererInfo(gl);
  }
  private startProgram(main: TextureKind, dimension: TextureDimension, pet?: TextureKind, projection = false): Program {
    const key = `${main}:${dimension}:${pet ?? 'none'}${projection ? ':projection' : ''}`;
    const cached = this.programs.get(key);
    if (cached) return cached;
    const gl = this.gl;
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type); if (!shader) throw new Error('Could not create GPU shader');
      gl.shaderSource(shader, source); gl.compileShader(shader);
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, vertex);
    let fs: WebGLShader;
    try { fs = compile(gl.FRAGMENT_SHADER, fragment(main, dimension, pet, projection)); } catch (error) { gl.deleteShader(vs); throw error; }
    const program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    const compiled: Program = { key, program, shaders: [vs, fs], uniforms: new Map() };
    this.programs.set(key, compiled);
    return compiled;
  }
  private finishProgram(compiled: Program): void {
    if (!compiled.shaders) return;
    const gl = this.gl, shaders = compiled.shaders;
    try {
      if (!gl.getProgramParameter(compiled.program, gl.LINK_STATUS)) {
        for (const shader of shaders) {
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(t('gpu.shaderFailed', { error: String(gl.getShaderInfoLog(shader)) }));
        }
        throw new Error(t('gpu.programFailed', { error: String(gl.getProgramInfoLog(compiled.program)) }));
      }
      for (const shader of shaders) gl.detachShader(compiled.program, shader);
    } catch (error) {
      this.programs.delete(compiled.key);
      gl.deleteProgram(compiled.program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
      compiled.shaders = null;
    }
  }
  prepareSource(volume: Volume): Promise<void> {
    if (this.lost || this.gl.isContextLost()) return Promise.resolve();
    const compiled = this.startProgram(textureKind(volume), '2d');
    if (!compiled.shaders || !this.parallel) return Promise.resolve();
    if (compiled.preparation) return compiled.preparation;
    const gl = this.gl, completion = this.parallel.COMPLETION_STATUS_KHR, started = performance.now();
    compiled.preparation = new Promise(resolve => {
      const poll = () => {
        // A slow or faulty extension falls back to the normal checked draw after one second.
        try {
          if (this.lost || gl.isContextLost() || this.programs.get(compiled.key) !== compiled
            || performance.now() - started >= 1000 || gl.getProgramParameter(compiled.program, completion)) resolve();
          else setTimeout(poll, 4);
        } catch { resolve(); } // The normal draw reports GPU errors through the viewport.
      };
      poll();
    });
    return compiled.preparation;
  }
  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.current) throw new Error('No active GPU program');
    if (!this.current.uniforms.has(name)) this.current.uniforms.set(name, this.gl.getUniformLocation(this.current.program, name));
    return this.current.uniforms.get(name) ?? null;
  }
  private identity(object: object): number {
    let id = this.identities.get(object);
    if (id === undefined) { id = this.nextIdentity++; this.identities.set(object, id); }
    return id;
  }
  /** Draws source frames as if the GPU's 2D textures held at most `limit` pixels a side (null: the GPU's own limit). */
  limitTexturesForTesting(limit: number | null): void { this.forcedTextureLimit = limit; }
  private get textureLimit(): number { return Math.min(this.info.maxTextureSize, this.forcedTextureLimit ?? Infinity); }
  private textureKey(volume: Volume, kind: TextureKind, sourceFrame?: number): string {
    const series = volume.series;
    const range = sourceFrame === undefined ? series.paddingRange : series.frameMetadata?.[sourceFrame]?.paddingRange ?? series.paddingRange;
    const metadata = sourceFrame === undefined && series.frameMetadata ? this.identity(series.frameMetadata) : 0;
    return `${this.identity(volume.data)}:${kind}:${series.dimensions.join(',')}:${sourceFrame ?? 'volume'}:${metadata}:${range?.join(',') ?? ''}`;
  }
  private dropTexture(key: string, cached: CachedTexture): void {
    this.gl.deleteTexture(cached.texture); if (cached.padding) this.gl.deleteTexture(cached.padding); this.textures.delete(key);
  }
  private prune(requiredBytes = 0, protectedKeys = new Set<string>()): void {
    let total = [...this.textures.values()].reduce((sum, value) => sum + value.bytes, 0);
    const candidates = [...this.textures.entries()].sort((a, b) => Number(this.visible.has(a[0])) - Number(this.visible.has(b[0])) || a[1].touched - b[1].touched);
    for (const [key, cached] of candidates) {
      if (protectedKeys.has(key)) continue;
      if (cached.data.deref() && total + requiredBytes <= 1024 ** 3 && this.textures.size < 64) continue;
      this.dropTexture(key, cached); total -= cached.bytes;
    }
    if (total + requiredBytes > 1024 ** 3) throw new Error(t('gpu.textureBudget'));
  }
  /** A VOI LUT as an R16UI texture in rows of VOI_ROW entries; null gives a one-entry placeholder. Recent tables stay cached. */
  private voiTexture(lut: VoiLut | null): WebGLTexture {
    const cached = this.voiTextures.get(lut);
    if (cached) { this.voiTextures.delete(lut); this.voiTextures.set(lut, cached); return cached; }
    const gl = this.gl, texture = gl.createTexture();
    const count = Math.max(1, lut?.data.length ?? 1), width = Math.min(count, VOI_ROW), height = Math.ceil(count / VOI_ROW);
    const data = new Uint16Array(width * height); if (lut) data.set(lut.data);
    gl.activeTexture(gl.TEXTURE0 + VOI_UNIT); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, width, height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
    this.voiTextures.set(lut, texture);
    for (const [key, old] of this.voiTextures) {
      if (this.voiTextures.size <= 16) break;
      if (key !== null && key !== lut) { gl.deleteTexture(old); this.voiTextures.delete(key); }
    }
    return texture;
  }
  private blankPadding(): WebGLTexture {
    if (this.emptyPadding) return this.emptyPadding;
    const gl = this.gl, texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    this.emptyPadding = texture; return texture;
  }
  private sourceFrame(volume: Volume, view: ViewState): number | undefined {
    const source = view.mode === 'source' || volume.sourceFrameIndex !== undefined || volume.series.sourceFramesOnly
      || !volume.series.canReconstruct || volume.series.components === 3 || (view.mode !== 'mpr' && sourceFrameOnly(volume, this.info.max3DTextureSize));
    if (!source) return undefined;
    if (!Number.isFinite(view.slice)) throw new Error('Invalid source frame index.');
    return Math.max(0, Math.min(volume.series.dimensions[2] - 1, Math.round(view.slice)));
  }
  setVisibleViews(views: Array<{ volume: Volume; view: ViewState; fusion?: FusionSettings | null }>): void {
    this.visible.clear();
    if (!views.length) {
      for (const [key, cached] of this.textures) this.dropTexture(key, cached);
      this.canvas.width = 1; this.canvas.height = 1;
      return;
    }
    for (const { volume, view, fusion } of views) {
      this.visible.add(this.textureKey(volume, textureKind(volume), this.sourceFrame(volume, view)));
      if (fusion) this.visible.add(this.textureKey(fusion.volume, textureKind(fusion.volume)));
      // Start linking while the panes lay out and resize; validate before the first draw.
      const { mainKind, sourceFrame, petKind } = this.configuration(volume, view, fusion);
      this.startProgram(mainKind, sourceFrame === undefined ? '3d' : '2d', petKind, sourceFrame === undefined && isProjection(volume.series, view));
    }
  }
  private bind(volume: Volume, unit: number, kind: TextureKind, sourceFrame?: number, protectedKeys = new Set<string>(), tile?: FrameTile): string {
    const gl = this.gl, series = volume.series;
    if (series.dimensions.some(d => !Number.isInteger(d) || d < 1)) throw new Error('Invalid volume dimensions');
    const limit = sourceFrame === undefined ? this.info.max3DTextureSize : this.textureLimit;
    const [tileWidth, tileHeight] = tile ? [tile.width, tile.height] : [series.dimensions[0], series.dimensions[1]];
    if (tileWidth > limit || tileHeight > limit || (sourceFrame === undefined && series.dimensions[2] > limit)) {
      throw new Error(t(sourceFrame === undefined ? 'gpu.volumeTextureLimit' : 'gpu.frameTextureLimit', { limit }));
    }
    const components = kind === 'rgb8' ? 3 : 1;
    const frameLength = series.dimensions[0] * series.dimensions[1] * components;
    const partial = volume.sourceFrameIndex !== undefined;
    if (volume.data.length !== frameLength * (partial ? 1 : series.dimensions[2])) throw new Error('Incomplete pixel buffer');
    if (partial && (sourceFrame === undefined || volume.sourceFrameIndex !== sourceFrame)) throw new Error(t('gpu.frameNotLoaded'));
    const target = sourceFrame === undefined ? gl.TEXTURE_3D : gl.TEXTURE_2D;
    gl.activeTexture(gl.TEXTURE0 + unit);
    const tiled = tile && (tile.width !== series.dimensions[0] || tile.height !== series.dimensions[1]) ? tile : undefined;
    const key = this.textureKey(volume, kind, sourceFrame) + (tiled ? `:tile:${tiled.x},${tiled.y},${tiled.width},${tiled.height}` : '');
    let cached = this.textures.get(key);
    if (!cached) {
      const texels = tileWidth * tileHeight * (sourceFrame === undefined ? series.dimensions[2] : 1);
      // Drivers may store RGB8 as RGBA8; reserve four bytes per colour texel.
      const byteCount = texels * (kind === 'float32' || kind === 'rgb8' ? 4 : kind === 'int16' || kind === 'uint16' ? 2 : 1);
      this.prune(byteCount + (sourceFrame === undefined ? series.dimensions[2] : 1) * 16, protectedKeys);
      const sourceData = sourceFrame === undefined || partial ? volume.data : volume.data.subarray(sourceFrame * frameLength, (sourceFrame + 1) * frameLength);
      // Double-precision source values remain intact for quantitative tools; WebGL stores a display approximation.
      let displayData = sourceData;
      if (sourceData instanceof Float64Array) {
        const copy = new Float32Array(sourceData.length);
        for (let frame = 0; frame < (sourceFrame === undefined ? series.dimensions[2] : 1); frame++) {
          const range = series.frameMetadata?.[sourceFrame ?? frame]?.paddingRange ?? series.paddingRange;
          if (range && !range.every(Number.isFinite)) throw new Error('Invalid pixel padding range.');
          const low = range ? Math.min(...range) : NaN, high = range ? Math.max(...range) : NaN;
          for (let i = frame * frameLength; i < (frame + 1) * frameLength; i++) {
            const value = sourceData[i];
            copy[i] = range && value >= low && value <= high ? NaN : value;
            if (Number.isFinite(value) && !Number.isFinite(copy[i]) && !(range && value >= low && value <= high)) {
              throw new Error(t('gpu.float64Range'));
            }
          }
        }
        displayData = copy;
      }
      const texture = gl.createTexture();
      gl.bindTexture(target, texture); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (sourceFrame === undefined) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      const [w, h] = [tileWidth, tileHeight], d = sourceFrame === undefined ? series.dimensions[2] : 1;
      const format: [number, number, number] = kind === 'int16' ? [gl.R16I, gl.RED_INTEGER, gl.SHORT]
        : kind === 'uint16' ? [gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT]
          : kind === 'uint8' ? [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE]
            : kind === 'rgb8' ? [gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE] : [gl.R32F, gl.RED, gl.FLOAT];
      if (sourceFrame === undefined) gl.texImage3D(target, 0, format[0], w, h, d, 0, format[1], format[2], displayData);
      else if (tiled) {
        // A tile is read from the frame in place: rows of the whole frame, from the tile's corner.
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, series.dimensions[0]); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, tiled.x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, tiled.y);
        try { gl.texImage2D(target, 0, format[0], w, h, 0, format[1], format[2], displayData); }
        finally { gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0); }
      } else gl.texImage2D(target, 0, format[0], w, h, 0, format[1], format[2], displayData);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error(t('gpu.uploadFailed', { code: error })); }
      let padding: WebGLTexture | null = null;
      const ranges = kind === 'rgb8' || sourceData instanceof Float64Array ? [] : Array.from({ length: d }, (_, index) => series.frameMetadata?.[sourceFrame ?? index]?.paddingRange ?? series.paddingRange);
      if (ranges.some(Boolean)) {
        const data = new Float32Array(d * 4);
        for (let i = 0; i < ranges.length; i++) {
          const range = ranges[i]; if (!range) continue;
          if (!range.every(Number.isFinite)) { gl.deleteTexture(texture); throw new Error('Invalid pixel padding range.'); }
          const low = kind === 'float32' ? Math.min(...range) : Math.ceil(Math.min(...range));
          const high = kind === 'float32' ? Math.max(...range) : Math.floor(Math.max(...range));
          if (low <= high) data.set([1, low, high, 0], i * 4);
        }
        padding = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit + 2); gl.bindTexture(gl.TEXTURE_2D, padding);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, d, 1, 0, gl.RGBA, gl.FLOAT, data);
        if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(texture); gl.deleteTexture(padding); throw new Error(t('gpu.paddingUploadFailed')); }
      }
      cached = { texture, padding, data: new WeakRef(volume.data), bytes: byteCount + (padding ? d * 16 : 0), touched: 0 };
      this.textures.set(key, cached);
    } else gl.bindTexture(target, cached.texture);
    if (kind !== 'rgb8') {
      const prefix = unit === 0 ? 'image' : 'pet';
      gl.activeTexture(gl.TEXTURE0 + unit + 2); gl.bindTexture(gl.TEXTURE_2D, cached.padding ?? this.blankPadding());
      gl.uniform1i(this.uniform(`${prefix}Padding`), unit + 2); gl.uniform1i(this.uniform(`${prefix}HasPadding`), Number(!!cached.padding));
    }
    cached.touched = performance.now();
    return key;
  }
  private indexMapping(prefix: string, series: Series, origin: Vec3, right: Vec3, down: Vec3): void {
    const matrix = worldToIndexMatrix(series);
    const vector = (p: Vec3) => [matrix[0] * p[0] + matrix[1] * p[1] + matrix[2] * p[2], matrix[3] * p[0] + matrix[4] * p[1] + matrix[5] * p[2], matrix[6] * p[0] + matrix[7] * p[1] + matrix[8] * p[2]];
    this.gl.uniform3fv(this.uniform(`${prefix}IndexTopLeft`), worldToIndex(series, origin));
    this.gl.uniform3fv(this.uniform(`${prefix}IndexRight`), vector(right));
    this.gl.uniform3fv(this.uniform(`${prefix}IndexDown`), vector(down));
  }
  private configuration(volume: Volume, view: ViewState, fusion?: FusionSettings | null) {
    if (this.lost || this.gl.isContextLost()) throw new Error(t('gpu.contextLost'));
    const frameOnly = sourceFrameOnly(volume, this.info.max3DTextureSize);
    if (volume.sourceFrameIndex !== undefined && (view.mode === 'mpr' || fusion)) throw new Error(t('gpu.completeVolume'));
    if ((frameOnly || volume.series.sourceFramesOnly) && (view.mode === 'mpr' || (view.mode !== 'source' && (view.plane !== 'axial' || view.oblique?.some(n => n !== 0))))) {
      throw new Error(t('gpu.mprLimit', { limit: this.info.max3DTextureSize }));
    }
    if (fusion && (fusion.volume.sourceFrameIndex !== undefined || sourceFrameOnly(fusion.volume, this.info.max3DTextureSize))) {
      throw new Error(t('gpu.fusionLimit', { limit: this.info.max3DTextureSize }));
    }
    const sourceFrame = this.sourceFrame(volume, view);
    const mainKind = textureKind(volume);
    if (mainKind === 'rgb8') {
      if (view.mode === 'mpr' || (view.mode !== 'source' && (view.plane !== 'axial' || view.oblique?.some(n => n !== 0)))) throw new Error(t('gpu.colorMpr'));
      if (fusion) throw new Error(t('gpu.colorFusion'));
    }
    if (!volume.series.canReconstruct && (view.mode === 'mpr' || (view.mode !== 'source' && (view.plane !== 'axial' || view.oblique?.some(n => n !== 0))))) throw new Error(t('gpu.unverifiedGeometry'));
    const petKind = fusion ? textureKind(fusion.volume) : undefined;
    if (petKind === 'rgb8') throw new Error(t('gpu.scalarPet'));
    return { sourceFrame, mainKind, petKind };
  }
  render(target: HTMLCanvasElement, volume: Volume, view: ViewState, fusion?: FusionSettings | null): number {
    const { sourceFrame, mainKind, petKind } = this.configuration(volume, view, fusion);
    const start = performance.now(), gl = this.gl, w = target.width, h = target.height;
    if (!w || !h) return 0;
    const program = this.startProgram(mainKind, sourceFrame === undefined ? '3d' : '2d', petKind, sourceFrame === undefined && isProjection(volume.series, view));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.finishProgram(program);
    this.current = program;
    gl.viewport(0, 0, w, h); gl.useProgram(this.current.program);
    const tiles = sourceFrame === undefined ? [] : frameTiles(volume.series.dimensions[0], volume.series.dimensions[1], this.textureLimit);
    const pinned = new Set([this.bind(volume, 0, mainKind, sourceFrame, undefined, tiles[0])]); gl.uniform1i(this.uniform('uImage'), 0);
    if (fusion && petKind) { pinned.add(this.bind(fusion.volume, 1, petKind, undefined, pinned)); gl.uniform1i(this.uniform('uPet'), 1); }
    const ratio = target.width / Math.max(1, target.getBoundingClientRect().width || target.clientWidth || target.width);
    const cssWidth = w / ratio, cssHeight = h / ratio;
    const mapping = screenMapping(volume.series, sourceFrame === undefined ? view : { ...view, mode: 'source', slice: sourceFrame }, cssWidth, cssHeight);
    const topLeft = screenToWorld(mapping, 0, 0);
    const right = sub(screenToWorld(mapping, 1 / ratio, 0), topLeft), down = sub(screenToWorld(mapping, 0, 1 / ratio), topLeft);
    const imageSeries = sourceFrame === undefined ? volume.series : sourceFrameSeries(volume.series, sourceFrame);
    this.indexMapping('u', imageSeries, topLeft, right, down);
    gl.uniform1f(this.uniform('uScreenHeight'), h);
    gl.uniform3fv(this.uniform('uDimensions'), sourceFrame === undefined ? volume.series.dimensions : [volume.series.dimensions[0], volume.series.dimensions[1], 1]);
    if (sourceFrame === undefined && mainKind !== 'rgb8') {
      const slab = usesSourceFrames(volume.series, view) ? slabSampling(volume.series, { ...view, slab: undefined }) : slabSampling(volume.series, view);
      gl.uniform1i(this.uniform('uSlabMode'), slab.mode); gl.uniform1i(this.uniform('uSlabHalf'), slab.half); gl.uniform3fv(this.uniform('uSlabStep'), slab.step);
    }
    if (mainKind !== 'rgb8') {
      gl.uniform2f(this.uniform('uWindow'), view.windowCenter, Math.max(1, view.windowWidth));
      const monochrome1 = volume.series.photometricInterpretation.toUpperCase() === 'MONOCHROME1';
      gl.uniform1i(this.uniform('uInvert'), Number(view.inverted !== monochrome1));
      gl.uniform1i(this.uniform('uBasePalette'), ['hot', 'ge', 'rainbow'].indexOf(view.palette ?? 'gray'));
      // A VOI LUT applies to one acquired frame, as DICOM window mode resolves it.
      const lut = view.voiLut !== undefined && sourceFrame !== undefined ? volume.series.voiLuts?.[view.voiLut] ?? null : null;
      gl.activeTexture(gl.TEXTURE0 + VOI_UNIT); gl.bindTexture(gl.TEXTURE_2D, this.voiTexture(lut));
      gl.uniform1i(this.uniform('uVoiLut'), VOI_UNIT);
      gl.uniform1i(this.uniform('uVoi'), Number(!!lut));
      // SIGMOID and LINEAR_EXACT shape an acquired frame's window (VOI LUT Function); MPR stays LINEAR.
      gl.uniform1i(this.uniform('uVoiFunction'), sourceFrame === undefined ? 0 : view.voiFunction === 'SIGMOID' ? 2 : view.voiFunction === 'LINEAR_EXACT' ? 1 : 0);
      gl.uniform1f(this.uniform('uVoiFirst'), lut?.first ?? 0);
      gl.uniform1i(this.uniform('uVoiCount'), Math.max(1, lut?.data.length ?? 1));
      gl.uniform1f(this.uniform('uVoiMax'), 2 ** (lut?.bits ?? 16) - 1);
    }
    if (fusion) {
      gl.uniform3fv(this.uniform('uPetDimensions'), fusion.volume.series.dimensions);
      this.indexMapping('uPet', fusion.volume.series, topLeft, right, down);
      // A PET without SUV is scaled by its own high activity (src/imaging/fusion.ts).
      gl.uniform1f(this.uniform('uSuvFactor'), petScale(fusion.volume));
      gl.uniform1i(this.uniform('uPetBlend'), fusion.blend === 'classic' ? 1 : 0);
      gl.uniform1f(this.uniform('uPetOpacity'), fusion.opacity);
      gl.uniform1f(this.uniform('uPetUpper'), fusion.upperSuv);
      gl.uniform1i(this.uniform('uPalette'), ['hot', 'ge', 'rainbow', 'hot_metal', 'red_yellow'].indexOf(fusion.palette));
    }
    if (sourceFrame === undefined) gl.drawArrays(gl.TRIANGLES, 0, 3);
    else {
      // Every pixel of the frame lies in one tile's part; the screen outside the frame is black in each draw.
      const [fullWidth, fullHeight] = volume.series.dimensions;
      gl.uniform3fv(this.uniform('uFull'), [fullWidth, fullHeight, 1]);
      if (tiles.length > 1) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
      tiles.forEach((tile, index) => {
        if (index) pinned.add(this.bind(volume, 0, mainKind, sourceFrame, pinned, tile));
        const [x0, y0, x1, y1] = tile.core;
        // A part's edges in pixel-centre coordinates; the frame's own edges stay open, as outside() leaves them.
        gl.uniform4f(this.uniform('uTile'), x0 ? x0 - 0.5 : -1e9, y0 ? y0 - 0.5 : -1e9, x1 < fullWidth ? x1 - 0.5 : 1e9, y1 < fullHeight ? y1 - 0.5 : 1e9);
        gl.uniform2f(this.uniform('uTileOrigin'), tile.x, tile.y);
        gl.uniform3fv(this.uniform('uDimensions'), [tile.width, tile.height, 1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      });
    }
    const context = target.getContext('2d', { alpha: false });
    if (!context) throw new Error(t('gpu.compositorFailed'));
    context.drawImage(this.canvas, 0, 0);
    target.dataset.textureTarget = sourceFrame === undefined ? 'TEXTURE_3D' : 'TEXTURE_2D';
    if (sourceFrame === undefined) delete target.dataset.sourceFrame; else target.dataset.sourceFrame = String(sourceFrame);
    this.prune(0, pinned);
    return performance.now() - start;
  }
}

let shared: SharedSliceRenderer | null = null;
export function clearSliceTextureCache(): void {
  shared?.setVisibleViews([]);
}
export function sliceRenderer(): SharedSliceRenderer {
  if (!shared) shared = new SharedSliceRenderer();
  return shared;
}

export function prepareSourceProgram(volume: Volume): Promise<void> {
  try { return sliceRenderer().prepareSource(volume); }
  catch { return Promise.resolve(); } // Loading pixels must still succeed when the viewport cannot use the GPU.
}

export function sourceFrameOnly(volume: Volume, maxTextureSize = sliceRenderer().info.max3DTextureSize): boolean {
  return volume.series.dimensions.some(dimension => dimension > maxTextureSize);
}
