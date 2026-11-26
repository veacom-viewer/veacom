import { petScale } from './fusion';
import { applyPoint, applyVector } from './rigid';
import { MAX_PROJECTION_HALF, MAX_SLAB_HALF, slabSampling } from './slab';
import { usesSourceFrames } from './viewState';
import type { FusionSettings, PixelArray, Series, Vec3, ViewState, VoiLut, Volume } from '../model';
import { isProjection, multiply, screenMapping, screenToWorld, sourceFrameSeries, sub, worldToIndex, worldToIndexMatrix } from './geometry';
import { reduceFrame, reducedTile } from './frameReduction';
import { planePixels, planeTexture, type PlaneTexture } from './planeTexture';
import { LocalizedError, t } from '../i18n';
import { isSoftwareRenderer } from './rendererInfo';

type TextureKind = 'float32' | 'int16' | 'uint16' | 'uint8' | 'rgb8';
type TextureDimension = '2d' | '3d';
type Sampling = 'native' | 'area' | 'reduced' | 'reduced-grey' | 'window-samples' | 'reduced-with-mask';
interface CachedTexture { owner: string; texture: WebGLTexture; padding: WebGLTexture | null; data: WeakRef<PixelArray>; touched: number; bytes: number;
  /** An acquired frame's padding range as its shader compares it: enabled, low and high, as `padding` holds them. */
  frameRange?: Float32Array; }
interface WindowSamples {
  key: string; geometry: string; lastPan: [number, number];
  anchor: [number, number]; origin: Vec3;
}
interface SampleDraw { state: WindowSamples; build: boolean; same: boolean; shift: [number, number] }
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

const TEXTURE_BUDGET = 1024 ** 3;
const SAMPLE_BUDGET = 64 * 1024 ** 2;
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

function texturePixels(volume: Volume, kind: TextureKind, frame?: number): PixelArray {
  const [width, height, depth] = volume.series.dimensions, frameLength = width * height * (kind === 'rgb8' ? 3 : 1);
  if (volume.series.dimensions.some(d => !Number.isInteger(d) || d < 1)) throw new Error('Invalid volume dimensions');
  const partial = volume.sourceFrameIndex !== undefined;
  if (volume.data.length !== frameLength * (partial ? 1 : depth)) throw new Error('Incomplete pixel buffer');
  if (partial && volume.sourceFrameIndex !== frame) throw new Error(t('gpu.frameNotLoaded'));
  return frame === undefined || partial ? volume.data : volume.data.subarray(frame * frameLength, (frame + 1) * frameLength);
}

function bytesPerTexel(kind: TextureKind): number {
  // RGB8 can occupy four bytes on the driver.
  return kind === 'float32' || kind === 'rgb8' ? 4 : kind === 'uint8' ? 1 : 2;
}

function samplerType(kind: TextureKind, dimension: TextureDimension): string {
  const prefix = kind === 'int16' ? 'i' : kind === 'uint16' || kind === 'uint8' ? 'u' : '';
  return `${prefix}sampler${dimension === '2d' ? '2D' : '3D'}`;
}

function scalarSampling(prefix: 'image' | 'pet', sampler: string, dimensions: string, floating: boolean, dimension: TextureDimension): string {
  // Integer texture fetches are converted per sample in the shader, preserving compact GPU storage.
  const mainVolume = prefix === 'image' && dimension === '3d';
  const voxel = `
${mainVolume ? 'uniform highp ivec3 imageTextureStart;' : ''}
uniform sampler2D ${prefix}Padding;
uniform bool ${prefix}HasPadding;
float ${prefix}Voxel(ivec3 p) {
  p=clamp(p,ivec3(0),ivec3(${dimensions})-1);
  ${mainVolume ? 'p-=imageTextureStart;' : ''}
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

/** Average across a screen pixel in the reconstruction plane, without thickening the slice. */
function planeAverage(prefix: 'image' | 'pet', coordinates: string): string {
  return `
uniform ivec2 ${prefix}Grid;
float ${prefix}Plane(vec3 p,float centre) {
  if (nonFinite(centre) || all(equal(${prefix}Grid,ivec2(1)))) return centre;
  float total=0.0, count=0.0;
  for (int y=0;y<${prefix}Grid.y;y++) for (int x=0;x<${prefix}Grid.x;x++) {
    vec2 offset=(vec2(x,y)+0.5)/vec2(${prefix}Grid)-0.5;
    vec3 q=p+offset.x*${coordinates}IndexRight+offset.y*${coordinates}IndexDown;
    if (outside(q,${coordinates}Dimensions)) continue;
    float v=${prefix}Linear(q);
    if (!nonFinite(v)) { total+=v/float(${prefix}Grid.x*${prefix}Grid.y); count+=1.0; }
  }
  return count>0.0 ? total*(float(${prefix}Grid.x*${prefix}Grid.y)/count) : centre;
}`;
}

function frameSampling(color: boolean, cachedFrame: boolean, hardwareLinear: boolean): string {
  return `
uniform vec2 uFootprint;
${cachedFrame ? `uniform sampler2D uReduced;
uniform vec2 uReducedScale;
uniform vec2 uReducedOrigin;
${hardwareLinear ? `vec4 readReduced(vec2 coord) {
  return texture(uReduced,(coord+0.5)/vec2(textureSize(uReduced,0)));
}` : ''}` : ''}
vec4 frameAverage(vec2 framePixel) {
  vec2 edge=framePixel+0.5;
  ${cachedFrame ? 'edge*=uReducedScale;' : ''}
  vec2 start=edge-0.5*uFootprint;
  vec2 base=floor(start);
  vec2 first=min(uFootprint,1.0-fract(start)), second=min(vec2(1.0),uFootprint-first);
  vec2 last=max(vec2(0.0),uFootprint-first-second);
  ${hardwareLinear ? `
  // One bilinear fetch integrates the first two cells on each axis. Only a fractional third cell needs another fetch.
  base-=uReducedOrigin;
  vec2 sampleAt=base+second/(first+second), tail=last/uFootprint;
  vec4 top=readReduced(sampleAt);
  if (last.x>0.0) top=mix(top,readReduced(vec2(base.x+2.0,sampleAt.y)),tail.x);
  if (last.y<=0.0) return top;
  vec4 bottom=readReduced(vec2(sampleAt.x,base.y+2.0));
  if (last.x>0.0) bottom=mix(bottom,readReduced(base+2.0),tail.x);
  return mix(top,bottom,tail.y);` : `
  vec3 wx=vec3(first.x,second.x,last.x)/uFootprint.x, wy=vec3(first.y,second.y,last.y)/uFootprint.y;
  vec4 sum=vec4(0.0);
  for (int y=0;y<3;y++) for (int x=0;x<3;x++) {
    float weight=wx[x]*wy[y]; if (weight<=0.0) continue;
    ${cachedFrame ? `
    ivec2 at=ivec2(base-uReducedOrigin)+ivec2(x,y);
    sum+=weight*texelFetch(uReduced,clamp(at,ivec2(0),textureSize(uReduced,0)-1),0);` : `
    ivec2 at=ivec2(base-uTileOrigin)+ivec2(x,y);
    ${color ? 'sum.rgb+=weight*texelFetch(uImage,clamp(at,ivec2(0),ivec2(uDimensions.xy)-1),0).rgb;' : `
    float v=imageVoxel(ivec3(at,0));
    if (!nonFinite(v)) sum.rg+=weight*vec2(v,1.0);`}`}
  }
  return sum;`}
}`;
}

/** An acquired frame shown larger, or turned, between its stored values: the four pixels nearest to the screen pixel,
 * weighted by distance (bilinear), as reconstructed planes are between eight. Shown at one screen pixel to one stored
 * pixel along the frame's own axes, each screen pixel shows its stored pixel as it is. */
function frameInterpolation(color: boolean, floating: boolean): string {
  // The pixel at or left of and above the screen pixel's centre q, the next one each way, and q's place between them.
  const corners = `ivec2 edge=ivec2(uDimensions.xy)-1, b=ivec2(floor(q));
  vec2 f=q-vec2(b);
  ivec2 b0=clamp(b,ivec2(0),edge), b1=clamp(b+1,ivec2(0),edge);`;
  if (color) return `
uniform bool uStoredPixels;
vec3 colourPixel(vec2 q) {
  if (uStoredPixels) return texelFetch(uImage,clamp(ivec2(floor(q+0.5)),ivec2(0),ivec2(uDimensions.xy)-1),0).rgb;
  ${corners}
  return mix(mix(texelFetch(uImage,b0,0).rgb,texelFetch(uImage,ivec2(b1.x,b0.y),0).rgb,f.x),
    mix(texelFetch(uImage,ivec2(b0.x,b1.y),0).rgb,texelFetch(uImage,b1,0).rgb,f.x),f.y);
}`;
  return `
uniform bool uStoredPixels;
uniform vec3 uFramePadding;
float imagePixel(vec2 q) {
  if (uStoredPixels) return imageVoxel(ivec3(floor(q+0.5),0.0));
  ${corners}
  vec4 v=vec4(texelFetch(uImage,b0,0).r,texelFetch(uImage,ivec2(b1.x,b0.y),0).r,texelFetch(uImage,ivec2(b0.x,b1.y),0).r,texelFetch(uImage,b1,0).r);
  vec4 w=vec4((1.0-f.x)*(1.0-f.y),f.x*(1.0-f.y),(1.0-f.x)*f.y,f.x*f.y);
  ${floating ? '' : 'if (!imageHasPadding) return dot(w,v);'}
  // Padding and missing values are left out as in imageLinear: a screen pixel whose nearest stored pixel is one stays
  // empty, and otherwise the remaining weights are renormalized, so padding never darkens its neighbours.
  vec4 bad=${floating ? 'vec4(equal(floatBitsToUint(v)&uvec4(0x7f800000u),uvec4(0x7f800000u)))' : 'vec4(0.0)'};
  // The frame's padding range, as imagePadding holds it, read once for the four pixels.
  if (uFramePadding.x>0.5) bad=max(bad,vec4(greaterThanEqual(v,vec4(uFramePadding.y)))*vec4(lessThanEqual(v,vec4(uFramePadding.z))));
  vec2 near=step(vec2(0.5),f);
  if (mix(mix(bad.x,bad.y,near.x),mix(bad.z,bad.w,near.x),near.y)>0.5) return uintBitsToFloat(0x7fc00000u);
  w*=1.0-bad;
  return dot(w,mix(v,vec4(0.0),greaterThan(bad,vec4(0.5))))/(w.x+w.y+w.z+w.w);
}`;
}

function fragment(main: TextureKind, dimension: TextureDimension, pet: TextureKind | undefined, projection: boolean,
  sampling: Sampling, floatLinear: boolean): string {
  const retained = sampling === 'window-samples', plain = sampling === 'reduced-grey' || retained;
  const filtered = sampling !== 'native', reducedOnly = sampling === 'reduced' || plain;
  const linearWindow = 'uWindow.y<=1.0 ? step(uWindow.x-0.5,value) : clamp((value-(uWindow.x-0.5))/(uWindow.y-1.0)+0.5,0.0,1.0)';
  const cachedFrame = reducedOnly || sampling === 'reduced-with-mask';
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
${retained ? 'uniform highp sampler2D uWindowSamples; uniform int uSamplePass; uniform ivec2 uSampleShift; uniform vec3 uSampleOrigin;' : ''}
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
${filtered && dimension === '3d' ? planeAverage('image', 'u') : ''}
${filtered && pet ? planeAverage('pet', 'uPet') : ''}
${filtered && dimension === '2d' ? frameSampling(color, cachedFrame, cachedFrame && !color && floatLinear) : ''}
${!filtered && dimension === '2d' ? frameInterpolation(color, main === 'float32') : ''}
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
  vec2 framePixel=p.xy;
  if (outside(p,uFull)) { outColor=vec4(0.0,0.0,0.0,${retained ? 'uSamplePass==1 ? 0.0 : 1.0' : '1.0'}); return; }
  ${plain ? '' : `if (p.x<uTile.x||p.x>=uTile.z||p.y<uTile.y||p.y>=uTile.w) discard;
  p.xy-=uTileOrigin;`}` : 'if (outside(p,uDimensions)) { outColor=vec4(0.0,0.0,0.0,1.0); return; }'}
  ${color ? `
  ivec3 sourcePixel=clamp(ivec3(floor(p+vec3(0.5))),ivec3(0),ivec3(uDimensions)-1);
  outColor=vec4(${filtered ? 'frameAverage(framePixel).rgb' : dimension === '2d' ? 'colourPixel(p.xy)' : 'texelFetch(uImage,sourcePixel,0).rgb'},1.0);
  ` : `
  ${retained ? `if (uSamplePass==1) { outColor=vec4(frameAverage(framePixel).r,0.0,0.0,1.0); return; }
  float value;
  if (uSamplePass==3) value=texelFetch(uWindowSamples,ivec2(gl_FragCoord.xy),0).r;
  else if (uSamplePass==2) {
    ivec2 at=ivec2(gl_FragCoord.xy)+uSampleShift, size=textureSize(uWindowSamples,0);
    vec2 centre=vec2(at)+0.5;
    vec3 old=uSampleOrigin+uIndexRight*centre.x+uIndexDown*(uScreenHeight-centre.y);
    // Small pans can differ by one floating-point step. Reuse only the exact source position.
    if (all(lessThan(uvec2(at),uvec2(size)))&&!outside(old,uFull)&&all(equal(old.xy,framePixel)))
      value=texelFetch(uWindowSamples,at,0).r;
    else value=frameAverage(framePixel).r;
  } else value=frameAverage(framePixel).r;` : `float value=${reducedOnly ? 'frameAverage(framePixel).r' : dimension === '2d' ? filtered ? 'imageVoxel(ivec3(floor(p+vec3(0.5))))' : 'imagePixel(p.xy)' : 'imageLinear(p);\n  if (uSlabMode>0) value=slabValue(p,value)'};`}
  ${plain ? '' : 'if (nonFinite(value)) { outColor=vec4(0.0,0.0,0.0,1.0); return; }'}
  ${reducedOnly ? '' : filtered && dimension === '2d' ? `vec2 mean=frameAverage(framePixel).rg;
  if (mean.y<=0.0) { outColor=vec4(0.0,0.0,0.0,1.0); return; }
  value=mean.x/mean.y;` : filtered ? 'if (uSlabMode==0) value=imagePlane(p,value);' : ''}
  ${plain ? `float grey=${linearWindow};` : `float grey;
  if (uVoi) {
    // The VOI LUT entry for the nearest input value, clamped at both ends; rows of ${VOI_ROW} entries.
    int entry=int(clamp(floor(value+0.5)-uVoiFirst,0.0,float(uVoiCount-1)));
    grey=float(texelFetch(uVoiLut,ivec2(entry%${VOI_ROW},entry/${VOI_ROW}),0).r)/uVoiMax;
  } else if (uVoiFunction==2) grey=1.0/(1.0+exp(-4.0*(value-uWindow.x)/uWindow.y));
  else if (uVoiFunction==1) grey=clamp((value-uWindow.x)/uWindow.y+0.5,0.0,1.0);
  else grey=${linearWindow};`}
  if (uInvert) grey=1.0-grey;
  vec3 rgb=${plain ? 'vec3(grey)' : 'uBasePalette<0 ? vec3(grey) : palette(grey,uBasePalette)'};
  ${pet ? `
  vec3 q=uPetIndexTopLeft+uPetIndexRight*gl_FragCoord.x+uPetIndexDown*(uScreenHeight-gl_FragCoord.y);
  if (!outside(q,uPetDimensions)) {
    float sampled=petLinear(q);
    ${filtered ? 'sampled=petPlane(q,sampled);' : ''}
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

/** Clear a letterbox once instead of shading it. The shader still decides which boundary samples are inside. */
function sourceClip(origin: Vec3, right: Vec3, down: Vec3, nx: number, ny: number, w: number, h: number): [number, number, number, number] | undefined {
  if (right[1] !== 0 || down[0] !== 0 || !right[0] || !down[1]) return;
  const span = (start: number, step: number, length: number, dimension: number) => {
    start = Math.fround(start); step = Math.fround(step);
    // Allow for GPU rounding of the input coordinate and its step across the viewport.
    const error = (Math.abs(start) + Math.abs(step) * length + dimension) * 2 ** -21;
    const a = (-0.5 - error - start) / step, b = (dimension - 0.5 + error - start) / step;
    return [Math.max(0, Math.min(length, Math.floor(Math.min(a, b)) - 1)), Math.max(0, Math.min(length, Math.ceil(Math.max(a, b)) + 1))];
  };
  const [left, end] = span(origin[0], right[0], w, nx), [top, bottom] = span(origin[1], down[1], h, ny);
  if ((end - left) * (bottom - top) < w * h * 0.8) return [left, h - bottom, end - left, bottom - top];
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
  private floatLinear: boolean;
  private sampleSupport: boolean | undefined;
  private sampleTarget: WebGLFramebuffer | null = null;
  private sampleViews = new WeakMap<HTMLCanvasElement, WindowSamples>();
  constructor() {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new LocalizedError('gpu.webglUnavailable');
    this.gl = gl;
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.sampleTarget = null; this.sampleSupport = undefined; this.sampleViews = new WeakMap();
      this.textures.clear(); this.programs.clear(); this.voiTextures.clear(); this.current = null; this.emptyPadding = null; this.lost = false;
      this.parallel = gl.getExtension('KHR_parallel_shader_compile');
      this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
      // A restored context can run on a different renderer, for example after the GPU process fell back to software.
      this.info = readRendererInfo(gl);
      window.dispatchEvent(new Event('veacom-gpu-restored'));
    });
    this.info = readRendererInfo(gl);
  }
  private startProgram(main: TextureKind, dimension: TextureDimension, pet?: TextureKind, projection = false, sampling: Sampling = 'native'): Program {
    const key = `${main}:${dimension}:${pet ?? 'none'}${projection ? ':projection' : ''}:${sampling}`;
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
    try { fs = compile(gl.FRAGMENT_SHADER, fragment(main, dimension, pet, projection, sampling, this.floatLinear)); } catch (error) { gl.deleteShader(vs); throw error; }
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
  prepareSource(source: Volume | Series): Promise<void> {
    if (this.lost || this.gl.isContextLost()) return Promise.resolve();
    const kind = 'data' in source ? textureKind(source) : source.components === 3 ? 'rgb8'
      : source.pixelType === 'float64' ? 'float32' : source.pixelType;
    if (!kind) return Promise.resolve();
    const compiled = this.startProgram(kind, '2d');
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
    const candidates = [...this.textures.entries()].sort((a, b) => Number(this.visible.has(a[1].owner)) - Number(this.visible.has(b[1].owner)) || a[1].touched - b[1].touched);
    for (const [key, cached] of candidates) {
      if (protectedKeys.has(key)) continue;
      if (cached.data.deref() && total + requiredBytes <= TEXTURE_BUDGET && this.textures.size < 64) continue;
      this.dropTexture(key, cached); total -= cached.bytes;
    }
    if (total + requiredBytes > TEXTURE_BUDGET) throw new Error(t('gpu.textureBudget'));
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
      this.sampleViews = new WeakMap(); this.gl.deleteFramebuffer(this.sampleTarget); this.sampleTarget = null;
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
  private bind(volume: Volume, unit: number, kind: TextureKind, sourceFrame?: number, protectedKeys = new Set<string>(), tile?: FrameTile, region?: PlaneTexture): string {
    const gl = this.gl, series = volume.series;
    const sourceData = texturePixels(volume, kind, sourceFrame);
    const limit = sourceFrame === undefined ? this.info.max3DTextureSize : this.textureLimit;
    const [tileWidth, tileHeight] = tile ? [tile.width, tile.height] : region?.size ?? series.dimensions;
    const d = sourceFrame === undefined ? region?.size[2] ?? series.dimensions[2] : 1;
    if (tileWidth > limit || tileHeight > limit || d > limit) {
      throw new Error(t(sourceFrame === undefined ? 'gpu.volumeTextureLimit' : 'gpu.frameTextureLimit', { limit }));
    }
    const components = kind === 'rgb8' ? 3 : 1;
    const frameLength = series.dimensions[0] * series.dimensions[1] * components;
    const target = sourceFrame === undefined ? gl.TEXTURE_3D : gl.TEXTURE_2D;
    gl.activeTexture(gl.TEXTURE0 + unit);
    const tiled = tile && (tile.width !== series.dimensions[0] || tile.height !== series.dimensions[1]) ? tile : undefined;
    const owner = this.textureKey(volume, kind, sourceFrame);
    const key = owner + (region ? `:region:${region.start}:${region.size}` : tiled ? `:tile:${tiled.x},${tiled.y},${tiled.width},${tiled.height}` : '');
    let cached = this.textures.get(key);
    if (!cached) {
      const texels = tileWidth * tileHeight * d;
      const byteCount = texels * bytesPerTexel(kind);
      this.prune(byteCount + d * 16, protectedKeys);
      // Double-precision source values remain intact for quantitative tools; WebGL stores a display approximation.
      let displayData = region ? planePixels(sourceData, series.dimensions, region) : sourceData;
      if (sourceData instanceof Float64Array) {
        const depth = sourceFrame === undefined ? series.dimensions[2] : 1;
        const copy = new Float32Array(texels);
        let output = 0;
        for (let frame = 0; frame < depth; frame++) {
          const range = series.frameMetadata?.[sourceFrame ?? frame]?.paddingRange ?? series.paddingRange;
          if (range && !range.every(Number.isFinite)) throw new Error('Invalid pixel padding range.');
          const low = range ? Math.min(...range) : NaN, high = range ? Math.max(...range) : NaN;
          for (let row = 0; row < tileHeight; row++) {
            const start = frame * frameLength + (row + (tiled?.y ?? 0)) * series.dimensions[0] + (tiled?.x ?? 0);
            for (let i = start; i < start + tileWidth; i++) {
              const value = sourceData[i];
              const padding = value >= low && value <= high;
              const displayed = padding ? NaN : Math.fround(value);
              if (!padding && Number.isFinite(value) && !Number.isFinite(displayed)) throw new Error(t('gpu.float64Range'));
              copy[output++] = displayed;
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
      const [w, h] = [tileWidth, tileHeight];
      const format: [number, number, number] = kind === 'int16' ? [gl.R16I, gl.RED_INTEGER, gl.SHORT]
        : kind === 'uint16' ? [gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT]
          : kind === 'uint8' ? [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE]
            : kind === 'rgb8' ? [gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE] : [gl.R32F, gl.RED, gl.FLOAT];
      if (sourceFrame === undefined) gl.texImage3D(target, 0, format[0], w, h, d, 0, format[1], format[2], displayData);
      else if (tiled && !(sourceData instanceof Float64Array)) {
        // A tile is read from the frame in place: rows of the whole frame, from the tile's corner.
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, series.dimensions[0]); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, tiled.x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, tiled.y);
        try { gl.texImage2D(target, 0, format[0], w, h, 0, format[1], format[2], displayData); }
        finally { gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0); }
      } else gl.texImage2D(target, 0, format[0], w, h, 0, format[1], format[2], displayData);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error(t('gpu.uploadFailed', { code: error })); }
      let padding: WebGLTexture | null = null, frameRange: Float32Array | undefined;
      const ranges = kind === 'rgb8' || sourceData instanceof Float64Array ? [] : Array.from({ length: d }, (_, index) => series.frameMetadata?.[sourceFrame ?? index + (region?.start[2] ?? 0)]?.paddingRange ?? series.paddingRange);
      if (ranges.some(Boolean)) {
        const data = new Float32Array(d * 4);
        for (let i = 0; i < ranges.length; i++) {
          const range = ranges[i]; if (!range) continue;
          if (!range.every(Number.isFinite)) { gl.deleteTexture(texture); throw new Error('Invalid pixel padding range.'); }
          const low = kind === 'float32' ? Math.min(...range) : Math.ceil(Math.min(...range));
          const high = kind === 'float32' ? Math.max(...range) : Math.floor(Math.max(...range));
          if (low <= high) data.set([1, low, high, 0], i * 4);
        }
        if (sourceFrame !== undefined) frameRange = data.slice(0, 3);
        padding = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit + 2); gl.bindTexture(gl.TEXTURE_2D, padding);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, d, 1, 0, gl.RGBA, gl.FLOAT, data);
        if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(texture); gl.deleteTexture(padding); throw new Error(t('gpu.paddingUploadFailed')); }
      }
      cached = { owner, texture, padding, frameRange, data: new WeakRef(volume.data), bytes: byteCount + (padding ? d * 16 : 0), touched: 0 };
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
  private bindReduction(volume: Volume, frame: number, grid: [number, number], tile: FrameTile, sourceKey: string,
    pinned: Set<string>, reducedOnly: boolean): string {
    const gl = this.gl, [width, height] = volume.series.dimensions, full: [number, number] = [width, height];
    const data = texturePixels(volume, textureKind(volume), frame);
    const reduced = reducedTile(tile.core, full, grid), color = volume.series.components === 3;
    const owner = this.textures.get(sourceKey)?.owner ?? sourceKey;
    const key = `${owner}:reduced:${grid}:${reduced.origin}:${reduced.size}`;
    gl.activeTexture(gl.TEXTURE5);
    let cached = this.textures.get(key);
    if (!cached) {
      const [w, h] = reduced.size, bytes = w * h * (reducedOnly ? 4 : 8);
      this.prune(bytes, pinned);
      const range = volume.series.frameMetadata?.[frame]?.paddingRange ?? volume.series.paddingRange;
      const pixels = reduceFrame(data, 0, full, grid, reduced, color, range);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const filter = color || this.floatLinear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, color ? gl.RGB8 : reducedOnly ? gl.R32F : gl.RG32F, w, h, 0,
        color ? gl.RGB : reducedOnly ? gl.RED : gl.RG, color ? gl.UNSIGNED_BYTE : gl.FLOAT, pixels);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error(t('gpu.uploadFailed', { code: error })); }
      cached = { owner, texture, padding: null, bytes, data: new WeakRef(volume.data), touched: 0 };
      this.textures.set(key, cached);
    } else gl.bindTexture(gl.TEXTURE_2D, cached.texture);
    cached.touched = performance.now();
    gl.uniform1i(this.uniform('uReduced'), 5);
    gl.uniform2f(this.uniform('uReducedScale'), grid[0] / width, grid[1] / height);
    gl.uniform2fv(this.uniform('uReducedOrigin'), reduced.origin);
    return key;
  }
  private planSamples(target: HTMLCanvasElement, owner: string, origin: Vec3, right: Vec3, down: Vec3,
    grid: [number, number], footprint: [number, number], pan: [number, number]): SampleDraw | undefined {
    const { width, height } = target, gl = this.gl;
    if (width * height < 8192 || width * height * 4 > SAMPLE_BUDGET || Math.max(width, height) > this.textureLimit ||
      !(this.sampleSupport ??= !!gl.getExtension('EXT_color_buffer_float'))) return;
    const geometry = [owner, width, height, ...right.map(Math.fround), ...down.map(Math.fround), ...footprint.map(Math.fround), ...grid].join(':');
    const state = this.sampleViews.get(target);
    if (!state || state.geometry !== geometry) {
      const key = 'window:' + this.identity(target), old = this.textures.get(key);
      if (old) this.dropTexture(key, old);
      this.sampleViews.set(target, { key, geometry, lastPan: pan, anchor: pan, origin });
      return;
    }
    const present = this.textures.has(state.key), previous = present ? state.anchor : state.lastPan;
    const dx = pan[0] - previous[0], dy = pan[1] - previous[1];
    const whole = Number.isInteger(dx) && Number.isInteger(dy) && Math.abs(dx) < width / 2 && Math.abs(dy) < height / 2;
    const stationary = state.lastPan[0] === pan[0] && state.lastPan[1] === pan[1];
    state.lastPan = pan;
    if (present && whole) return { state, build: false, shift: [-dx, dy], same: !dx && !dy && origin.every((v, i) => v === state.origin[i]) };
    if (!stationary && (present || !whole)) return;
    state.anchor = pan; state.origin = origin;
    return { state, build: true, shift: [0, 0], same: true };
  }

  private drawSamples(plan: SampleDraw, owner: string, volume: Volume, width: number, height: number, pinned: Set<string>): void {
    const gl = this.gl, key = plan.state.key;
    let entry = this.textures.get(key);
    gl.activeTexture(gl.TEXTURE6);
    gl.uniform1i(this.uniform('uWindowSamples'), 6);
    const pass = this.uniform('uSamplePass');
    if (plan.build) {
      const blank = this.blankPadding();
      gl.bindTexture(gl.TEXTURE_2D, blank);
      gl.uniform1i(pass, 0);
      // This optional copy can always be replaced by the ordinary area-filtered draw.
      const unavailable = () => {
        if (entry) this.dropTexture(key, entry);
        this.sampleSupport = false;
        gl.getError();
        gl.bindTexture(gl.TEXTURE_2D, blank);
        gl.uniform1i(pass, 0);
      };
      this.sampleTarget ??= gl.createFramebuffer();
      if (!entry) {
        const bytes = width * height * 4;
        const required = [...pinned].reduce((sum, id) => sum + (this.textures.get(id)?.bytes ?? 0), bytes);
        if (required > TEXTURE_BUDGET) return;
        const samples = [...this.textures].filter(([id]) => id.startsWith('window:')).sort((a, b) => a[1].touched - b[1].touched);
        let total = samples.reduce((sum, [, cached]) => sum + cached.bytes, bytes);
        for (const [id, old] of samples) {
          if (total <= SAMPLE_BUDGET) break;
          this.dropTexture(id, old); total -= old.bytes;
        }
        this.prune(bytes, pinned);
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null);
        entry = { owner, texture, padding: null, data: new WeakRef(volume.data), bytes, touched: 0 };
        this.textures.set(key, entry);
        if (gl.getError() !== gl.NO_ERROR) { unavailable(); return; }
        gl.bindTexture(gl.TEXTURE_2D, blank);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sampleTarget);
      if (!gl.getParameter(gl.FRAMEBUFFER_BINDING)) { unavailable(); return; }
      try {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, entry.texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { unavailable(); return; }
        gl.uniform1i(pass, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (gl.getError() !== gl.NO_ERROR) { unavailable(); return; }
      } finally {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }
    if (entry) {
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.uniform1i(pass, plan.same ? 3 : 2);
      gl.uniform2iv(this.uniform('uSampleShift'), plan.shift);
      gl.uniform3fv(this.uniform('uSampleOrigin'), plan.state.origin);
      entry.touched = performance.now(); pinned.add(key);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.blankPadding());
      gl.uniform1i(pass, 0);
    }
  }

  private indexMapping(prefix: string, series: Series, origin: Vec3, indexRight: Vec3, indexDown: Vec3): void {
    this.gl.uniform3fv(this.uniform(`${prefix}IndexTopLeft`), worldToIndex(series, origin));
    this.gl.uniform3fv(this.uniform(`${prefix}IndexRight`), indexRight);
    this.gl.uniform3fv(this.uniform(`${prefix}IndexDown`), indexDown);
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
  render(target: HTMLCanvasElement, volume: Volume, view: ViewState, fusion?: FusionSettings | null,
    pane?: { width: number; height: number; x: number; y: number; ratio: number }): number {
    const { sourceFrame, mainKind, petKind } = this.configuration(volume, view, fusion);
    const start = performance.now(), gl = this.gl, w = target.width, h = target.height;
    if (!w || !h) return 0;
    const ratio = pane?.ratio ?? target.width / Math.max(1, target.getBoundingClientRect().width || target.clientWidth || target.width);
    const cssWidth = pane?.width ?? w / ratio, cssHeight = pane?.height ?? h / ratio;
    const mapping = screenMapping(volume.series, sourceFrame === undefined ? view : { ...view, mode: 'source', slice: sourceFrame }, cssWidth, cssHeight);
    const x = pane?.x ?? 0, y = pane?.y ?? 0, topLeft = screenToWorld(mapping, x, y);
    const right = sub(screenToWorld(mapping, x + 1 / ratio, y), topLeft), down = sub(screenToWorld(mapping, x, y + 1 / ratio), topLeft);
    const imageSeries = sourceFrame === undefined ? volume.series : sourceFrameSeries(volume.series, sourceFrame);
    const matrix = worldToIndexMatrix(imageSeries), indexRight = multiply(matrix, right), indexDown = multiply(matrix, down);
    const [nx, ny] = volume.series.dimensions;
    const footprintX = Math.max(1, Math.hypot(indexRight[0], indexDown[0]));
    const footprintY = Math.max(1, Math.hypot(indexRight[1], indexDown[1]));
    const reduced = sourceFrame !== undefined && Math.max(footprintX, footprintY) > 1.00001;
    // One screen pixel to one stored pixel along the frame's own axes: each screen pixel shows a stored pixel as it is.
    const unit = (step: Vec3) => Math.abs(Math.hypot(step[0], step[1]) - 1) < 1e-5 && Math.min(Math.abs(step[0]), Math.abs(step[1])) < 1e-5;
    const storedPixels = unit(indexRight) && unit(indexDown);
    // Keep at most three cells across the residual footprint. Pans, windows and nearby zoom levels reuse these means.
    const grid: [number, number] = [
      Math.max(1, Math.floor(nx / Math.ceil(footprintX / 2 - 1e-6))),
      Math.max(1, Math.floor(ny / Math.ceil(footprintY / 2 - 1e-6))),
    ];
    const cachedFrame = reduced && (grid[0] < nx || grid[1] < ny);
    const reducedOnly = cachedFrame && (mainKind === 'rgb8' || (mainKind !== 'float32' && !imageSeries.paddingRange));
    const projection = sourceFrame === undefined && isProjection(volume.series, view);
    const petMatrix = fusion && worldToIndexMatrix(fusion.volume.series), transform = fusion?.transform;
    const petRight = petMatrix && multiply(petMatrix, transform ? applyVector(transform, right) : right);
    const petDown = petMatrix && multiply(petMatrix, transform ? applyVector(transform, down) : down);
    // Thin reconstructions integrate in their own plane. Bound work per output pixel at extreme zoom-out.
    const samples = (step: Vec3) => Math.min(8, Math.max(1, Math.ceil(Math.hypot(...step) - 1e-5)));
    const mprX = samples(indexRight), mprY = samples(indexDown);
    const petX = petRight ? samples(petRight) : 1, petY = petDown ? samples(petDown) : 1;
    const filtered = reduced || (sourceFrame === undefined && !projection && ((!view.slab && (mprX > 1 || mprY > 1)) || petX > 1 || petY > 1));
    let limit = this.textureLimit;
    if (cachedFrame) {
      const overlayBytes = fusion && petKind ? fusion.volume.data.length * bytesPerTexel(petKind) + fusion.volume.series.dimensions[2] * 16 : 0;
      const tileBytes = (reducedOnly ? 0 : bytesPerTexel(mainKind)) + (reducedOnly ? 4 : 8);
      // A raw validity mask and a reduced tile must fit alongside the fused volume, even on very large films.
      const available = Math.max(0, TEXTURE_BUDGET - overlayBytes - 32);
      if (nx * ny * tileBytes > available) {
        limit = Math.min(limit, Math.max(2 * TILE_HALO + 1, Math.floor(Math.sqrt(available / tileBytes))));
      }
    }
    const tiles = sourceFrame === undefined ? [] : frameTiles(nx, ny, limit);
    const plain = this.info.software && tiles.length === 1 && reducedOnly && mainKind !== 'rgb8' && !petKind && view.voiLut === undefined
      && !view.voiFunction && (!view.palette || view.palette === 'gray');
    const footprint: [number, number] = [Math.min(grid[0], Math.max(1, footprintX * grid[0] / nx)), Math.min(grid[1], Math.max(1, footprintY * grid[1] / ny))];
    // On the CPU, the letterbox around a frame shown at full size or larger is cleared too, not shaded.
    const unreduced = sourceFrame !== undefined && !reduced && this.info.software && tiles.length === 1;
    const origin = plain || unreduced ? worldToIndex(imageSeries, topLeft).map(Math.fround) as Vec3 : undefined;
    const clip = origin ? sourceClip(origin, indexRight, indexDown, nx, ny, w, h) : undefined;
    const sample = plain && origin ? this.planSamples(target, this.textureKey(volume, mainKind, sourceFrame),
      origin, indexRight, indexDown, grid, footprint,
      [view.pan[0] * ratio, view.pan[1] * ratio]) : undefined;
    const sampling: Sampling = sample ? 'window-samples' : plain ? 'reduced-grey' : reducedOnly ? 'reduced' : cachedFrame ? 'reduced-with-mask' : filtered ? 'area' : 'native';
    const program = this.startProgram(mainKind, sourceFrame === undefined ? '3d' : '2d', petKind, projection, sampling);
    // Adjacent panes can differ by one physical pixel. Share their backing surface and draw each at its exact size.
    const surfaceSize = (size: number) => this.info.software && size <= this.info.maxTextureSize
      ? Math.min(this.info.maxTextureSize, Math.ceil(size / 8) * 8) : size;
    const surfaceWidth = surfaceSize(w), surfaceHeight = surfaceSize(h);
    if (this.canvas.width !== surfaceWidth) this.canvas.width = surfaceWidth;
    if (this.canvas.height !== surfaceHeight) this.canvas.height = surfaceHeight;
    this.finishProgram(program);
    this.current = program;
    gl.viewport(0, 0, w, h); gl.useProgram(this.current.program);
    const region = sourceFrame === undefined && view.mode === 'mpr' && !view.slab && !fusion && !projection && !view.oblique?.some(v => v !== 0)
      && mainKind !== 'float32' && volume.data.byteLength >= 32 * 1024 * 1024 && !this.textures.has(this.textureKey(volume, mainKind))
      ? planeTexture(volume.series.dimensions, worldToIndex(imageSeries, topLeft), indexRight, indexDown, w, h) : undefined;
    let sourceKey = reducedOnly ? this.textureKey(volume, mainKind, sourceFrame) : this.bind(volume, 0, mainKind, sourceFrame, undefined, tiles[0], region);
    const pinned = new Set(reducedOnly ? [] : [sourceKey]);
    gl.uniform1i(this.uniform('uImage'), 0);
    if (sourceFrame === undefined) gl.uniform3i(this.uniform('imageTextureStart'), region?.start[0] ?? 0, region?.start[1] ?? 0, region?.start[2] ?? 0);
    if (fusion && petKind) { pinned.add(this.bind(fusion.volume, 1, petKind, undefined, pinned)); gl.uniform1i(this.uniform('uPet'), 1); }
    this.indexMapping('u', imageSeries, topLeft, indexRight, indexDown);
    if (reduced) gl.uniform2fv(this.uniform('uFootprint'), footprint);
    else if (sourceFrame !== undefined) {
      gl.uniform1i(this.uniform('uStoredPixels'), Number(storedPixels));
      gl.uniform3fv(this.uniform('uFramePadding'), this.textures.get(sourceKey)?.frameRange ?? [0, 0, 0]);
    }
    if (filtered && sourceFrame === undefined) gl.uniform2i(this.uniform('imageGrid'), mprX, mprY);
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
      // An overlay aligned from a frame of its own is read where the pane's points lie in its coordinates.
      this.indexMapping('uPet', fusion.volume.series, transform ? applyPoint(transform, topLeft) : topLeft, petRight!, petDown!);
      if (filtered) gl.uniform2i(this.uniform('petGrid'), petX, petY);
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
      let reductionKey: string | undefined;
      tiles.forEach((tile, index) => {
        if (reductionKey) pinned.delete(reductionKey);
        if (index && !reducedOnly) {
          pinned.delete(sourceKey);
          sourceKey = this.bind(volume, 0, mainKind, sourceFrame, pinned, tile); pinned.add(sourceKey);
        }
        if (cachedFrame) {
          reductionKey = this.bindReduction(volume, sourceFrame, grid, tile, sourceKey, pinned, reducedOnly);
          pinned.add(reductionKey);
        }
        const [x0, y0, x1, y1] = tile.core;
        // A part's edges in pixel-centre coordinates; the frame's own edges stay open, as outside() leaves them.
        gl.uniform4f(this.uniform('uTile'), x0 ? x0 - 0.5 : -1e9, y0 ? y0 - 0.5 : -1e9, x1 < fullWidth ? x1 - 0.5 : 1e9, y1 < fullHeight ? y1 - 0.5 : 1e9);
        gl.uniform2f(this.uniform('uTileOrigin'), tile.x, tile.y);
        gl.uniform3fv(this.uniform('uDimensions'), [tile.width, tile.height, 1]);
        if (sample) this.drawSamples(sample, sourceKey, volume, w, h, pinned);
        if (clip) {
          gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.SCISSOR_TEST); gl.scissor(...clip);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (clip) gl.disable(gl.SCISSOR_TEST);
      });
    }
    const context = target.getContext('2d', { alpha: false });
    if (!context) throw new Error(t('gpu.compositorFailed'));
    if (surfaceWidth === w && surfaceHeight === h) context.drawImage(this.canvas, 0, 0);
    else context.drawImage(this.canvas, 0, surfaceHeight - h, w, h, 0, 0, w, h);
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

export function prepareSourceProgram(source: Volume | Series): Promise<void> {
  try { return sliceRenderer().prepareSource(source); }
  catch { return Promise.resolve(); } // Loading pixels must still succeed when the viewport cannot use the GPU.
}

export function sourceFrameOnly(volume: Volume, maxTextureSize = sliceRenderer().info.max3DTextureSize): boolean {
  return volume.series.dimensions.some(dimension => dimension > maxTextureSize);
}
