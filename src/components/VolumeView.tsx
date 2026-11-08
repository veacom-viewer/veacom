import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import type { Annotation, Plane, Vec3, ViewState, Volume, VolumeViewProps } from '../model';
import { segmentationTexture, type SegmentationTexture } from '../imaging/segmentation';
import { storedUnit } from '../imaging/annotations';
import Viewport from './Viewport';
import { getPlaneFrame, screenMapping, screenToWorld, sliceAtWorld, sliceCount, sourceFrameSeries, worldToScreen } from '../imaging/geometry';
import {
  carveSphere, createPaddingMask, extractStlAsync, fullCrop, indexToPatient, patientToIndex,
  pickSurface, restoreCarve, annotationToVoiKey, buildVoiMaskAsync, buildVisibleRegionMaskAsync, interpolateVoiOutline,
  type CropBounds, type VoiSelection, type VoiKey,
} from '../imaging/volume3d';
import { X } from './icons';
import { errorMessage } from '../i18n';
import { useTranslation } from '../i18n/react';
import { focusOnMount } from '../ui/navigation';
import { warningTexts } from '../i18n/core';
import { usage, type GestureHandle } from '../usage/tracker';

type InteractionMode = 'orbit' | 'burr' | 'pick';
type Stroke = Uint32Array[];
interface Marker { x: number; y: number; visible: boolean; outsideCrop: boolean; }
interface SurgerySession {
  mask: Uint8Array;
  crop: CropBounds;
  threshold: number;
  ramp: number;
  fine: boolean;
  mode: InteractionMode;
  diameter: number;
  undo: () => void;
  restore: () => void;
  requestRender: (interactive?: boolean) => void;
  resetCamera: (position?: 'front' | 'side' | 'top') => void;
  applySelection: (mask: Uint8Array | null, crop: CropBounds) => void;
  showSegmentations: (texture: SegmentationTexture | null) => void;
  /** Aims the camera at the middle of the crop, at a distance that shows all of it. */
  frameCrop: () => void;
}
const MAX_SEGMENT_COLORS = 64;

const vertexShader = /* glsl */ `
  out vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp sampler3D;
  precision highp isampler3D;
  precision highp usampler3D;
  uniform sampler3D uVolume;
  uniform sampler3D uMask;
  uniform vec3 uDimensions;
  uniform vec3 uCropMin;
  uniform vec3 uCropMax;
  uniform mat4 uInverseViewProjection;
  uniform mat4 uWorldToIndex;
  uniform vec3 uCameraPosition;
  uniform float uThreshold;
  uniform float uRamp;
  uniform float uStep;
  uniform float uIndexStep;
  uniform bool uLinear;
  uniform bool uHasPadding;
  uniform sampler3D uLabels;
  uniform bool uHasLabels;
  uniform vec3 uLabelMin;
  uniform vec3 uLabelSize;
  uniform vec3 uLabelColors[${MAX_SEGMENT_COLORS}];
  in vec2 vNdc;
  out vec4 outColor;

  int labelAt(ivec3 q) {
    ivec3 r = q - ivec3(uLabelMin);
    if (any(lessThan(r, ivec3(0))) || any(greaterThanEqual(r, ivec3(uLabelSize)))) return 0;
    return int(texelFetch(uLabels, r, 0).r * 255.0 + 0.5);
  }
  float occupied(ivec3 q) { return labelAt(q) > 0 ? 1.0 : 0.0; }

  float scalarAt(ivec3 p) {
    ivec3 q=clamp(p, ivec3(0), ivec3(uDimensions) - 1);
    if (uHasPadding && texelFetch(uMask,q,0).r>2.5/255.0) return uintBitsToFloat(0x7fc00000u);
    return float(texelFetch(uVolume,q,0).r);
  }
  // Exponent bits, not GLSL's isnan or isinf: ANGLE's Direct3D shader compiler on Windows may optimise those away.
  bool finiteValue(float value) { return (floatBitsToUint(value) & 0x7f800000u) != 0x7f800000u; }
  bool emptyAt(vec3 p) {
    if (texture(uMask, (p + 0.5) / uDimensions).r > 0.0) return true;
    return uHasPadding && !finiteValue(scalarAt(ivec3(floor(p + 0.5))));
  }
  float valueAt(vec3 p, out bool valid) {
    vec3 uvw = (p + 0.5) / uDimensions;
    float emptyValue = max(-3.402823e38, uThreshold - max(uRamp, 1.0));
    valid = !emptyAt(p);
    if (!valid) return emptyValue;
    if (uLinear && !uHasPadding) {
      float interpolated = float(texture(uVolume, uvw).r);
      if (finiteValue(interpolated)) return interpolated;
    }
    ivec3 q = ivec3(floor(p));
    vec3 f = fract(p);
    if (uHasPadding) {
      float total = 0.0, weight = 0.0;
      for (int z = 0; z < 2; z++) for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
        float value = scalarAt(q + ivec3(x,y,z));
        float w = (x == 0 ? 1.0-f.x : f.x) * (y == 0 ? 1.0-f.y : f.y) * (z == 0 ? 1.0-f.z : f.z);
        if (finiteValue(value) && w > 0.0) { total += value * w; weight += w; }
      }
      return weight > 0.0 && finiteValue(total) ? total / weight : emptyValue;
    }
    float a = mix(scalarAt(q), scalarAt(q + ivec3(1,0,0)), f.x);
    float b = mix(scalarAt(q + ivec3(0,1,0)), scalarAt(q + ivec3(1,1,0)), f.x);
    float c = mix(scalarAt(q + ivec3(0,0,1)), scalarAt(q + ivec3(1,0,1)), f.x);
    float d = mix(scalarAt(q + ivec3(0,1,1)), scalarAt(q + ivec3(1,1,1)), f.x);
    return mix(mix(a,b,f.y), mix(c,d,f.y), f.z);
  }
  float valueAt(vec3 p) { bool valid; return valueAt(p, valid); }
  bool intersectBox(vec3 origin, vec3 direction, out float entry, out float exitAt) {
    entry = 0.0;
    exitAt = 1e20;
    for (int axis = 0; axis < 3; axis++) {
      if (abs(direction[axis]) < 1e-10) {
        if (origin[axis] < uCropMin[axis] || origin[axis] > uCropMax[axis]) return false;
      } else {
        float a = (uCropMin[axis] - origin[axis]) / direction[axis];
        float b = (uCropMax[axis] - origin[axis]) / direction[axis];
        entry = max(entry, min(a,b));
        exitAt = min(exitAt, max(a,b));
      }
    }
    return entry <= exitAt;
  }
  void main() {
    vec4 farPoint = uInverseViewProjection * vec4(vNdc, 1.0, 1.0);
    vec3 direction = normalize(farPoint.xyz / farPoint.w - uCameraPosition);
    vec3 originIndex = (uWorldToIndex * vec4(uCameraPosition, 1.0)).xyz;
    vec3 directionIndex = mat3(uWorldToIndex) * direction;
    float entry, exitAt;
    if (!intersectBox(originIndex, directionIndex, entry, exitAt)) {
      outColor = vec4(0.025, 0.035, 0.045, 1.0);
      return;
    }
    float fastestAxis = max(max(abs(directionIndex.x), abs(directionIndex.y)), abs(directionIndex.z));
    float stepSize = max(min(uStep, uIndexStep / fastestAxis), (exitAt - entry) / 2047.0);
    vec4 accumulated = vec4(0.0);
    for (int i = 0; i < 2048; i++) {
      float at = entry + (float(i) + 0.5) * stepSize;
      if (at > exitAt || accumulated.a > 0.985) break;
      vec3 p = originIndex + at * directionIndex;
      if (uHasLabels) {
        // A shown segmentation is drawn opaque in its colour where the ray first enters it.
        ivec3 q = ivec3(floor(p + 0.5));
        int label = labelAt(q);
        if (label > 0) {
          vec3 inward = vec3(occupied(q - ivec3(1,0,0)) - occupied(q + ivec3(1,0,0)),
            occupied(q - ivec3(0,1,0)) - occupied(q + ivec3(0,1,0)), occupied(q - ivec3(0,0,1)) - occupied(q + ivec3(0,0,1)));
          vec3 worldNormal = transpose(mat3(uWorldToIndex)) * inward;
          vec3 normal = length(worldNormal) > 0.0001 ? normalize(worldNormal) : -direction;
          vec3 color = uLabelColors[min(label, ${MAX_SEGMENT_COLORS - 1})] * (0.35 + 0.65 * abs(dot(normal, direction)));
          accumulated.rgb += (1.0 - accumulated.a) * color;
          accumulated.a = 1.0;
          break;
        }
      }
      bool valid;
      float value = valueAt(p, valid);
      if (!valid || !finiteValue(value)) continue;
      float density = smoothstep(uThreshold - 10.0, uThreshold + uRamp, value);
      if (density > 0.001) {
        float alpha = 1.0 - exp(-density * stepSize * 0.8);
        vec3 gradient = vec3(
          valueAt(p + vec3(1,0,0)) - valueAt(p - vec3(1,0,0)),
          valueAt(p + vec3(0,1,0)) - valueAt(p - vec3(0,1,0)),
          valueAt(p + vec3(0,0,1)) - valueAt(p - vec3(0,0,1))
        );
        vec3 worldGradient = transpose(mat3(uWorldToIndex)) * gradient;
        bool finiteGradient = finiteValue(worldGradient.x) && finiteValue(worldGradient.y) && finiteValue(worldGradient.z);
        vec3 normal = finiteGradient && length(worldGradient) > 0.0001 ? normalize(worldGradient) : -direction;
        float light = 0.23 + 0.77 * abs(dot(normal, direction));
        float level = clamp((value - uThreshold) / max(3.0 * uRamp, 1.0), 0.0, 1.0);
        vec3 color = mix(vec3(0.66,0.50,0.35), vec3(0.98,0.95,0.85), level) * light;
        accumulated.rgb += (1.0 - accumulated.a) * color * alpha;
        accumulated.a += (1.0 - accumulated.a) * alpha;
      }
    }
    outColor = vec4(accumulated.rgb + (1.0 - accumulated.a) * vec3(0.025,0.035,0.045), 1.0);
  }
`;


function scalarRange(volume: Volume, mask: Uint8Array): [number, number, boolean] {
  let min = Infinity, max = -Infinity, hasPadding = false;
  for (let i = 0; i < volume.data.length; i++) {
    const value = volume.data[i];
    if (Number.isFinite(value) && mask[i] !== 3) { min = Math.min(min, value); max = Math.max(max, value); }
    else hasPadding = true;
  }
  return Number.isFinite(min) ? [min, Math.max(min + 1, max), hasPadding] : [0, 1, hasPadding];
}

function affineFor(volume: Volume, center: THREE.Vector3) {
  const { direction: d, spacing: s, origin: o } = volume.series;
  return new THREE.Matrix4().set(
    d[0] * s[0], d[1] * s[1], d[2] * s[2], o[0] - center.x,
    d[3] * s[0], d[4] * s[1], d[5] * s[2], o[1] - center.y,
    d[6] * s[0], d[7] * s[1], d[8] * s[2], o[2] - center.z,
    0, 0, 0, 1,
  );
}

function voxelDiagonal(volume: Volume) {
  const matrix = affineFor(volume, new THREE.Vector3(...volume.series.origin));
  let diagonal = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const point = new THREE.Vector3(...([0, 1, 2].map(axis => (corner & (1 << axis)) ? 1 : -1) as Vec3));
    diagonal = Math.max(diagonal, point.applyMatrix4(matrix).length());
  }
  return diagonal;
}

function VoiEditor({ volume, initialView, annotations, disabled, onApply }: {
  volume: Volume; initialView?: ViewState; annotations: Annotation[]; disabled: boolean;
  onApply: (selection: VoiSelection) => Promise<void>;
}) {
  const { t } = useTranslation();
  const initialPlane = initialView?.plane ?? 'axial';
  const initialMode = initialView?.mode ?? 'mpr';
  const [view, setView] = useState<ViewState>(() => ({ plane: initialPlane, slice: initialView?.slice ?? 0, mode: initialMode, windowMode: initialView?.windowMode ?? 'dicom',
    windowCenter: initialView?.windowCenter ?? volume.series.windowCenter, windowWidth: initialView?.windowWidth ?? volume.series.windowWidth,
    zoom: 1, pan: [0, 0], rotation: 0, flipX: false, flipY: false, inverted: false }));
  const [selection, setSelection] = useState<VoiSelection>({ plane: initialPlane, mode: initialMode, keys: [] });
  const [tool, setTool] = useState<'rectangle' | 'ellipse' | 'polygon' | 'freehand' | 'window'>('ellipse');
  const [message, setMessage] = useState('');
  const [importId, setImportId] = useState('');
  const previewRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([1, 1]);
  const freehand = useRef<Vec3[] | null>(null);
  const [freehandDraft, setFreehandDraft] = useState<Vec3[]>([]);
  const count = sliceCount(volume.series, view);
  const mapping = screenMapping(volume.series, view, ...size);
  const preview = selection.keys.length ? interpolateVoiOutline(volume, selection, view.slice) : null;
  const outline = freehandDraft.length ? freehandDraft : preview?.outline ?? [];
  const pointString = outline.map(point => worldToScreen(mapping, point).join(',')).join(' ');
  const planeMode = view.mode ?? 'mpr';
  const available = annotations.filter(annotation => (annotation.mode ?? 'mpr') === planeMode && annotation.plane === view.plane && ['rectangle', 'ellipse', 'polygon'].includes(annotation.type));
  const patchView = (patch: Partial<ViewState>) => setView(previous => {
    const next = { ...previous, ...patch };
    if (next.mode === 'source' && next.windowMode !== 'manual' && patch.slice !== undefined) {
      const frame = sourceFrameSeries(volume.series, next.slice);
      next.windowCenter = frame.windowCenter; next.windowWidth = frame.windowWidth;
    }
    return next;
  });

  useEffect(() => {
    const host = previewRef.current;
    if (!host) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) setSize(previous => previous[0] === rect.width && previous[1] === rect.height ? previous : [rect.width, rect.height]);
      });
    });
    observer.observe(host); return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  const addKey = (key: VoiKey) => {
    setSelection(previous => ({ plane: view.plane, mode: view.mode, keys: [...previous.keys.filter(other => other.slice !== key.slice), key].sort((a, b) => a.slice - b.slice) }));
    setMessage(t('voi.keyConfirmed', { number: key.slice + 1 }));
  };
  const acceptDrawing = (annotation: Annotation) => {
    try { addKey(annotationToVoiKey(volume, annotation)); }
    catch (caught) { setMessage(errorMessage(caught)); }
  };
  const changePlane = (plane: Plane | 'source') => {
    const point = getPlaneFrame(volume.series, view).center;
    const next: ViewState = { ...view, mode: plane === 'source' ? 'source' : 'mpr', plane: plane === 'source' ? 'axial' : plane, oblique: undefined, zoom: 1, pan: [0, 0] };
    next.slice = sliceAtWorld(volume.series, next, point);
    if (next.mode === 'source' && next.windowMode !== 'manual') {
      const frame = sourceFrameSeries(volume.series, next.slice); next.windowCenter = frame.windowCenter; next.windowWidth = frame.windowWidth;
    }
    setSelection({ plane: next.plane, mode: next.mode, keys: [] }); setImportId(''); setView(next);
    setMessage(t('voi.newPlane'));
  };
  const confirm = () => { if (preview && preview.kind !== 'key') addKey({ slice: view.slice, outline: preview.outline, plane: view.plane, mode: view.mode, sourceFrame: view.mode === 'source' ? view.slice : undefined }); };
  const eventPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(); return screenToWorld(mapping, event.clientX - rect.left, event.clientY - rect.top);
  };
  const startFreehand = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== 'freehand' || disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    freehand.current = [eventPoint(event)]; setFreehandDraft(freehand.current);
  };
  const moveFreehand = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!freehand.current) return;
    event.preventDefault(); event.stopPropagation(); const point = eventPoint(event);
    const previous = worldToScreen(mapping, freehand.current.at(-1)!); const next = worldToScreen(mapping, point);
    if (Math.hypot(next[0] - previous[0], next[1] - previous[1]) < 2) return;
    freehand.current.push(point); setFreehandDraft([...freehand.current]);
  };
  const finishFreehand = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!freehand.current) return;
    event.preventDefault(); event.stopPropagation();
    const points = freehand.current; freehand.current = null; setFreehandDraft([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type !== 'pointercancel' && points.length >= 3) acceptDrawing({ id: 'voi-freehand', type: 'polygon', plane: view.plane, slice: view.slice, points, mode: view.mode, sourceFrame: view.mode === 'source' ? view.slice : undefined });
  };
  return <aside aria-label={t('voi.editor')} className="v3d-editor">
    <div className="v3d-toolbar compact">
      <strong>{t('voi.title')}</strong>
      <select data-action="voi-plane" aria-label={t('voi.plane')} value={view.mode === 'source' ? 'source' : view.plane} disabled={disabled} onChange={event => changePlane(event.target.value as Plane | 'source')}>
        <option value="source">{t('voi.acquiredFrames')}</option>
        {(['axial', 'coronal', 'sagittal'] as const).map(plane => <option key={plane} value={plane}>{t(`planeLower.${plane}` as const)}</option>)}
      </select>
      <select data-action="voi-shape" aria-label={t('voi.shape')} value={tool} disabled={disabled} onChange={event => setTool(event.target.value as typeof tool)}>
        <option value="ellipse">{t('voi.ellipse')}</option><option value="rectangle">{t('voi.rectangle')}</option><option value="polygon">{t('voi.polygon')}</option><option value="freehand">{t('voi.freehand')}</option><option value="window">{t('voi.windowLevel')}</option>
      </select>
    </div>
    <div ref={previewRef} data-testid="voi-slice-preview" style={{ position: 'relative', flex: '1 1 auto', minHeight: 190, pointerEvents: disabled ? 'none' : 'auto' }}
      onPointerDownCapture={startFreehand} onPointerMoveCapture={moveFreehand} onPointerUpCapture={finishFreehand} onPointerCancelCapture={finishFreehand}
      onKeyDownCapture={event => { if (event.key === 'Enter' && tool !== 'polygon' && preview?.kind !== 'key') { event.preventDefault(); event.stopPropagation(); confirm(); } }}>
      <Viewport volume={volume} view={view} tool={tool === 'freehand' ? 'pan' : tool} annotations={[]} active crosshair={null}
        onActivate={() => {}} onViewChange={patchView}
        onAnnotationsChange={items => { const drawn = items.at(-1); if (drawn) acceptDrawing(drawn); }} onCrosshairChange={() => {}} />
      <svg width="100%" height="100%" viewBox={`0 0 ${size[0]} ${size[1]}`} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {outline.length > 1 && <polygon data-testid="voi-outline" points={pointString} fill="#44cde415" stroke="#54dbec" strokeWidth={2}
          strokeDasharray={!freehandDraft.length && preview?.kind !== 'key' ? '6 4' : undefined} />}
      </svg>
    </div>
    <div className="v3d-toolbar compact">
      <label>{t('voi.slice')} <input data-action="voi-slice-input" aria-label={t('voi.sliceInput')} type="number" min={1} max={count} value={view.slice + 1} disabled={disabled}
        onChange={event => patchView({ slice: Math.max(0, Math.min(count - 1, Math.round(Number(event.target.value)) - 1)) })} style={{ width: 65 }} /> / {count}</label>
      <input data-action="voi-slice-slider" aria-label={t('voi.sliceSlider')} type="range" min={0} max={count - 1} value={view.slice} disabled={disabled} onChange={event => patchView({ slice: Number(event.target.value) })} style={{ flex: 1, minWidth: 60 }} />
      <button data-action="voi-confirm" type="button" className="secondary-button compact" disabled={disabled || !preview || preview.kind === 'key'} onClick={confirm}>{t('voi.confirmSlice')}</button>
      <button data-action="voi-remove-key" type="button" className="secondary-button compact" disabled={disabled || preview?.kind !== 'key'} onClick={() => setSelection(previous => ({ ...previous, keys: previous.keys.filter(key => key.slice !== view.slice) }))}>{t('voi.removeKey')}</button>
    </div>
    <div className="v3d-hint">{t('voi.legend')}{tool === 'polygon' ? t('voi.polygonHint') : tool === 'freehand' ? t('voi.freehandHint') : t('voi.dragHint')}</div>
    <div className="v3d-toolbar compact" style={{ maxHeight: 75, overflow: 'auto' }}>
      {selection.keys.map(key => <button data-action="voi-key" key={key.slice} className="secondary-button compact" onClick={() => patchView({ slice: key.slice })}>{t('voi.keyButton', { number: key.slice + 1 })}</button>)}
      {!selection.keys.length && <span className="v3d-muted">{t('voi.noKeys')}</span>}
    </div>
    {!!available.length && <div className="v3d-toolbar compact">
      <select data-action="voi-roi" aria-label={t('voi.existingRoi')} value={importId} onChange={event => setImportId(event.target.value)} disabled={disabled} style={{ flex: 1, minWidth: 0 }}>
        <option value="">{t('voi.chooseRoi')}</option>{available.map(annotation => <option key={annotation.id} value={annotation.id}>{t('voi.roiOption', { type: t(`assessment.roiType.${annotation.type as 'ellipse' | 'rectangle' | 'polygon'}` as const), number: annotation.slice + 1 })}</option>)}
      </select>
      <button data-action="voi-use-roi" type="button" className="secondary-button compact" disabled={disabled || !importId} onClick={() => { const annotation = available.find(item => item.id === importId); if (annotation) { acceptDrawing(annotation); patchView({ slice: annotation.sourceFrame ?? annotation.slice }); } }}>{t('voi.useRoi')}</button>
    </div>}
    <div className="v3d-toolbar compact">
      <button data-action="voi-reconstruct" className="primary-button compact" disabled={disabled || selection.keys.length < 2} onClick={() => void onApply(selection)}>{t('voi.reconstruct')}</button>
      <button data-action="voi-clear" type="button" className="secondary-button compact" disabled={disabled || !selection.keys.length} onClick={() => { setSelection({ plane: view.plane, mode: view.mode, keys: [] }); setMessage(t('voi.keysCleared')); }}>{t('voi.clearKeys')}</button>
      <span className="v3d-muted">{message}</span>
    </div>
  </aside>;
}

/** The burr's pointer: a ring with an empty middle, so the spot being cut is not covered. */
const BURR_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="7" fill="none" stroke="#000" stroke-width="3.5" stroke-opacity=".7"/><circle cx="12" cy="12" r="7" fill="none" stroke="#fff" stroke-width="1.5"/></svg>')}") 12 12, crosshair`;

export default function VolumeView({ volume, crosshair, onCrosshairChange, onClose, annotations = [], initialView, viewportSize, segmentations }: VolumeViewProps) {
  const { locale, t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SurgerySession | null>(null);
  // The 2D chrome becomes inert while this view is open, so focus moves here (and back to the 3D button on close).
  const exportRef = useRef<AbortController | null>(null);
  const readCrosshair = useEffectEvent(() => crosshair);
  const pickPoint = useEffectEvent(onCrosshairChange);
  const [mode, setMode] = useState<InteractionMode>('orbit');
  const [threshold, setThreshold] = useState(volume.series.modality === 'CT' ? 300 : volume.series.windowCenter);
  const [range, setRange] = useState<[number, number]>([-1000, 3000]);
  const [diameter, setDiameter] = useState(2);
  const [fine, setFine] = useState(false);
  const [crop, setCrop] = useState<CropBounds>(() => ({ min: [0, 0, 0], max: volume.series.dimensions.map(n => Math.max(0, n - 1)) as Vec3 }));
  const [showCrop, setShowCrop] = useState(false);
  const [showSelection, setShowSelection] = useState(false);
  const [selectionLabel, setSelectionLabel] = useState('');
  const [undoCount, setUndoCount] = useState(0);
  const [removedCount, setRemovedCount] = useState(0);
  const [depth, setDepth] = useState<number | null>(null);
  const [marker, setMarker] = useState<Marker>({ x: 0, y: 0, visible: false, outsideCrop: false });
  const [rendererName, setRendererName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState('');
  const minimumDiameter = voxelDiagonal(volume);
  const segmentTexture = segmentations?.length ? segmentationTexture(volume.series, segmentations) : null;
  const legend = (segmentations ?? []).flatMap(overlay => segmentTexture && overlay.labels ? overlay.labels.segments : []);
  const canRender = volume.series.canReconstruct && (volume.series.components ?? 1) === 1;

  useEffect(() => {
    const canvas = canvasRef.current, host = hostRef.current;
    if (!canvas || !host || !canRender) return;
    let disposed = false, requestId = 0, settledTimer = 0, firstFrame = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let observer: ResizeObserver | null = null;
    let scalarTexture: THREE.Data3DTexture | null = null;
    let maskTexture: THREE.Data3DTexture | null = null;
    let maskUploadSource: THREE.Data3DTexture | null = null;
    let material: THREE.ShaderMaterial | null = null;
    let geometry: THREE.PlaneGeometry | null = null;
    let labelTexture: THREE.Data3DTexture | null = null;
    let removeEvents = () => {};
    delete canvas.dataset.renderer; delete canvas.dataset.renderBackend; delete canvas.dataset.displayPrecision;
    setRendererName(null);
    setError(null); setStatus(''); setDepth(null); setUndoCount(0); setRemovedCount(0); setExporting(false); setSelectionLabel('');
    setMode('orbit'); setFine(false); setDiameter(2); setMarker({ x: 0, y: 0, visible: false, outsideCrop: false });
    function initializeScene(canvas: HTMLCanvasElement, host: HTMLDivElement) {
      const selectedCrop = fullCrop(volume);
      setCrop(selectedCrop);
      const dimensions = volume.series.dimensions;
      if ((volume.series.components ?? 1) !== 1) throw new Error(t('view3d.rgb'));
      if (dimensions.some(n => !Number.isInteger(n) || n < 2) || volume.data.length !== dimensions[0] * dimensions[1] * dimensions[2]) {
        throw new Error(t('view3d.minimumSamples'));
      }
      if (volume.series.spacing.some(n => !Number.isFinite(n) || n <= 0) || volume.series.direction.length !== 9 || volume.series.direction.some(n => !Number.isFinite(n))) {
        throw new Error(t('view3d.invalidGeometry'));
      }
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const maxTexture = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
      if (dimensions.some(n => n > maxTexture)) throw new Error(t('view3d.gpuLimit', { limit: maxTexture }));
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      const reportedRenderer = String(debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      setRendererName(reportedRenderer);
      canvas.dataset.renderer = reportedRenderer;
      canvas.dataset.renderBackend = 'webgl2-volume-raymarch';
      renderer.debug.onShaderError = (context, program, vertex, fragment) => {
        const message = context.getProgramInfoLog(program) || context.getShaderInfoLog(fragment) || context.getShaderInfoLog(vertex) || t('view3d.unknownShaderError');
        setError(t('view3d.shaderError', { message }));
      };
      const mask = createPaddingMask(volume);
      const isDouble = volume.data instanceof Float64Array;
      const isFloat = volume.data instanceof Float32Array || isDouble;
      const isSigned = volume.data instanceof Int16Array;
      const linear = isFloat && !!gl.getExtension('OES_texture_float_linear');
      let displayPixels = volume.data;
      if (isDouble) {
        const copy = new Float32Array(volume.data.length);
        for (let i = 0; i < copy.length; i++) {
          const value = volume.data[i];
          copy[i] = Number.isFinite(value) && mask[i] !== 3 ? value : NaN;
          if (mask[i] !== 3 && Number.isFinite(value) && !Number.isFinite(copy[i])) throw new Error(t('view3d.float64Range'));
        }
        displayPixels = copy;
      }
      canvas.dataset.displayPrecision = isDouble ? 'float32-display-float64-source' : volume.data.constructor.name;
      scalarTexture = new THREE.Data3DTexture(displayPixels, ...dimensions);
      scalarTexture.format = isFloat ? THREE.RedFormat : THREE.RedIntegerFormat;
      scalarTexture.type = isFloat ? THREE.FloatType : isSigned ? THREE.ShortType : volume.data instanceof Uint16Array ? THREE.UnsignedShortType : THREE.UnsignedByteType;
      scalarTexture.internalFormat = isFloat ? 'R32F' : isSigned ? 'R16I' : volume.data instanceof Uint16Array ? 'R16UI' : 'R8UI';
      scalarTexture.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
      scalarTexture.magFilter = scalarTexture.minFilter;
      scalarTexture.unpackAlignment = 1;
      scalarTexture.needsUpdate = true;
      maskTexture = new THREE.Data3DTexture(mask, ...dimensions);
      maskTexture.format = THREE.RedFormat;
      maskTexture.type = THREE.UnsignedByteType;
      maskTexture.minFilter = THREE.NearestFilter;
      maskTexture.magFilter = THREE.NearestFilter;
      maskTexture.unpackAlignment = 1;
      maskTexture.needsUpdate = true;
      // An unbound source lets Three upload a box from the existing CPU mask,
      // without copying the mask or sending the full volume after every touch.
      maskUploadSource = new THREE.Data3DTexture(mask, ...dimensions);
      const center = new THREE.Vector3(...indexToPatient(volume.series, dimensions.map(n => (n - 1) / 2) as Vec3));
      const affine = affineFor(volume, center);
      if (Math.abs(affine.determinant()) < 1e-12) throw new Error(t('view3d.singular'));
      let radius = 1;
      for (let corner = 0; corner < 8; corner += 1) {
        const index = dimensions.map((n, axis) => (corner & (1 << axis)) ? n - 0.5 : -0.5) as Vec3;
        radius = Math.max(radius, new THREE.Vector3(...index).applyMatrix4(affine).length());
      }
      const camera = new THREE.PerspectiveCamera(35, 1, Math.max(0.01, radius / 1000), radius * 50);
      camera.up.set(0, 0, 1);
      let distance = radius * 3.2, azimuth = 0, elevation = 0;
      const target = new THREE.Vector3();
      const scene = new THREE.Scene();
      const [scalarMin, scalarMax, hasPadding] = scalarRange(volume, mask);
      setRange(volume.series.modality === 'CT' ? [Math.min(-1000, scalarMin), Math.max(1000, Math.min(3000, scalarMax))] : [scalarMin, scalarMax]);
      const initialThreshold = volume.series.modality === 'CT' ? Math.min(scalarMax, 300) : scalarMin + (scalarMax - scalarMin) * 0.3;
      setThreshold(initialThreshold);
      const uniforms = {
        uVolume: { value: scalarTexture }, uMask: { value: maskTexture },
        uDimensions: { value: new THREE.Vector3(...dimensions) },
        uCropMin: { value: new THREE.Vector3() }, uCropMax: { value: new THREE.Vector3() },
        uInverseViewProjection: { value: new THREE.Matrix4() },
        uWorldToIndex: { value: affine.clone().invert() },
        uCameraPosition: { value: new THREE.Vector3() },
        uThreshold: { value: initialThreshold }, uRamp: { value: 150 },
        uStep: { value: Math.min(...volume.series.spacing) }, uIndexStep: { value: 1 }, uLinear: { value: linear }, uHasPadding: { value: hasPadding },
        uLabels: { value: null as THREE.Data3DTexture | null }, uHasLabels: { value: false },
        uLabelMin: { value: new THREE.Vector3() }, uLabelSize: { value: new THREE.Vector3(1, 1, 1) },
        uLabelColors: { value: Array.from({ length: MAX_SEGMENT_COLORS }, () => new THREE.Vector3()) },
      };
      function showSegmentations(texture: SegmentationTexture | null) {
        labelTexture?.dispose();
        labelTexture = new THREE.Data3DTexture(texture?.labels ?? new Uint8Array(1), ...(texture?.size ?? [1, 1, 1]));
        labelTexture.format = THREE.RedFormat;
        labelTexture.type = THREE.UnsignedByteType;
        labelTexture.minFilter = THREE.NearestFilter;
        labelTexture.magFilter = THREE.NearestFilter;
        labelTexture.unpackAlignment = 1;
        labelTexture.needsUpdate = true;
        uniforms.uLabels.value = labelTexture;
        uniforms.uHasLabels.value = Boolean(texture);
        uniforms.uLabelMin.value.set(...(texture?.min ?? [0, 0, 0]));
        uniforms.uLabelSize.value.set(...(texture?.size ?? [1, 1, 1]));
        texture?.colors.slice(0, MAX_SEGMENT_COLORS - 1).forEach((rgb, index) => uniforms.uLabelColors.value[index + 1].set(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255));
      }
      const scalarSampler = isFloat ? 'sampler3D' : isSigned ? 'isampler3D' : 'usampler3D';
      material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader,
        fragmentShader: fragmentShader.replace('uniform sampler3D uVolume;', `uniform ${scalarSampler} uVolume;`), depthTest: false, depthWrite: false });
      geometry = new THREE.PlaneGeometry(2, 2);
      const quad = new THREE.Mesh(geometry, material);
      quad.frustumCulled = false;
      scene.add(quad);
      const history: Stroke[] = [];
      let historyBytes = 0, removed = 0, interactive = false;
      let stroke: Stroke | null = null, strokeDepth: number | null = null, strokeBytes = 0;
      const inverseViewProjection = new THREE.Matrix4();
      const worldPoint = new THREE.Vector3();
      let renderWidth = 0, renderHeight = 0, renderRatio = 0;

      function updateCamera() {
        camera.position.set(
          target.x + Math.sin(azimuth) * Math.cos(elevation) * distance,
          target.y - Math.cos(azimuth) * Math.cos(elevation) * distance,
          target.z + Math.sin(elevation) * distance,
        );
        camera.lookAt(target); camera.updateMatrixWorld();
        inverseViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
        uniforms.uInverseViewProjection.value.copy(inverseViewProjection);
        uniforms.uCameraPosition.value.copy(camera.position);
      }

      function updateMarker(width: number, height: number) {
        const point = readCrosshair();
        if (!point) { setMarker(previous => previous.visible ? { ...previous, visible: false } : previous); return; }
        const index = patientToIndex(volume.series, point);
        const outsideCrop = index.some((v, axis) => v < session.crop.min[axis] - 0.5 || v > session.crop.max[axis] + 0.5)
          || mask[(Math.round(index[2]) * dimensions[1] + Math.round(index[1])) * dimensions[0] + Math.round(index[0])] === 2;
        worldPoint.set(...point).sub(center).project(camera);
        const next = { x: (worldPoint.x + 1) * width / 2, y: (1 - worldPoint.y) * height / 2,
          visible: !outsideCrop && worldPoint.z >= -1 && worldPoint.z <= 1 && Math.abs(worldPoint.x) < 1 && Math.abs(worldPoint.y) < 1, outsideCrop };
        setMarker(previous => previous.x === next.x && previous.y === next.y && previous.visible === next.visible && previous.outsideCrop === next.outsideCrop ? previous : next);
      }

      function render() {
        requestId = 0;
        if (disposed || !renderer) return;
        try { drawFrame(renderer); } catch (caught) { setError(errorMessage(caught)); }
      }

      function drawFrame(renderer: THREE.WebGLRenderer) {
        const { width, height } = host!.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
        if (width < 1 || height < 1) return;
        if (width !== renderWidth || height !== renderHeight || ratio !== renderRatio) {
          renderWidth = width; renderHeight = height; renderRatio = ratio;
          renderer.setPixelRatio(ratio); renderer.setSize(Math.floor(width), Math.floor(height), false);
          camera.aspect = width / height; camera.updateProjectionMatrix();
        }
        updateCamera();
        uniforms.uCropMin.value.set(...session.crop.min.map(n => n - 0.5) as Vec3);
        uniforms.uCropMax.value.set(...session.crop.max.map(n => n + 0.5) as Vec3);
        uniforms.uThreshold.value = session.threshold;
        uniforms.uRamp.value = session.ramp;
        uniforms.uIndexStep.value = interactive ? 1.5 : session.fine ? 0.5 : 1;
        uniforms.uStep.value = Math.min(...volume.series.spacing) * uniforms.uIndexStep.value;
        renderer.render(scene, camera);
        updateMarker(width, height);
        // The end of the "open 3D" task in usage timings: the first frame of the volume is on screen.
        if (!firstFrame) { firstFrame = true; usage.milestone('view3d-ready'); }
      }

      function requestRender(isInteractive = false) {
        interactive = isInteractive;
        if (!requestId) requestId = requestAnimationFrame(render);
        clearTimeout(settledTimer);
        if (isInteractive) settledTimer = window.setTimeout(() => requestRender(false), 120);
      }

      function finishStroke() {
        if (stroke?.length) {
          history.push(stroke);
          historyBytes += stroke.reduce((sum, part) => sum + part.byteLength, 0);
          while (history.length > 100 || (historyBytes > 32 * 1024 * 1024 && history.length > 1)) {
            historyBytes -= history.shift()!.reduce((sum, part) => sum + part.byteLength, 0);
          }
          setUndoCount(history.length);
        }
        stroke = null; strokeDepth = null; strokeBytes = 0;
      }

      function uploadMask(changes: Stroke) {
        const min = new THREE.Vector3(...dimensions), max = new THREE.Vector3(-1, -1, -1);
        const row = dimensions[0], plane = row * dimensions[1];
        for (const part of changes) for (const index of part) {
          const z = Math.floor(index / plane), y = Math.floor(index / row) % dimensions[1], x = index % row;
          min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
          max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
        }
        if (max.x < 0) return;
        renderer!.copyTextureToTexture(maskUploadSource!, maskTexture!, new THREE.Box3(min, max.addScalar(1)), min);
      }

      const session: SurgerySession = {
        mask, crop: selectedCrop, threshold: initialThreshold,
        ramp: volume.series.modality === 'CT' ? 150 : Math.max(1, (scalarMax - scalarMin) * 0.12),
        fine: false, mode: 'orbit', diameter: 2,
        requestRender,
        undo() {
          if (exportRef.current) return;
          // Undo while the burr is held takes back the stroke so far; what the burr removes after it is a stroke of
          // its own, so it can be undone too.
          const carving = stroke !== null;
          finishStroke();
          if (carving) stroke = [];
          const last = history.pop();
          if (!last) return;
          for (const part of last) { restoreCarve(mask, part); removed -= part.length; historyBytes -= part.byteLength; }
          uploadMask(last); setUndoCount(history.length); setRemovedCount(removed); setDepth(null); requestRender();
        },
        restore() {
          if (exportRef.current) return;
          for (let i = 0; i < mask.length; i++) if (mask[i] === 1) mask[i] = 0;
          history.length = 0; historyBytes = 0; removed = 0; stroke = null; strokeDepth = null; strokeBytes = 0;
          maskTexture!.needsUpdate = true; setUndoCount(0); setRemovedCount(0); setDepth(null); requestRender();
        },
        applySelection(selectionMask, selectedBounds) {
          for (let i = 0; i < mask.length; i++) if (mask[i] !== 3) mask[i] = selectionMask?.[i] ? 2 : 0;
          history.length = 0; historyBytes = 0; removed = 0; stroke = null; strokeDepth = null; strokeBytes = 0;
          session.crop = selectedBounds; setCrop(selectedBounds);
          maskTexture!.needsUpdate = true; setUndoCount(0); setRemovedCount(0); setDepth(null); requestRender();
        },
        showSegmentations(texture) { showSegmentations(texture); requestRender(); },
        resetCamera(position = 'front') {
          usage.touch('scene');
          azimuth = position === 'side' ? Math.PI / 2 : 0;
          elevation = position === 'top' ? Math.PI / 2 - 0.001 : 0;
          session.frameCrop();
        },
        frameCrop() {
          // The whole volume frames as before; a crop, such as the region around a segmentation, fills the view.
          const { min, max } = session.crop;
          const middle = new THREE.Vector3(...indexToPatient(volume.series, min.map((value, axis) => (value + max[axis]) / 2) as Vec3));
          let half = 1;
          for (let corner = 0; corner < 8; corner += 1) {
            const index = [0, 1, 2].map(axis => (corner & (1 << axis)) ? max[axis] + 0.5 : min[axis] - 0.5) as Vec3;
            half = Math.max(half, new THREE.Vector3(...indexToPatient(volume.series, index)).distanceTo(middle));
          }
          target.copy(middle).sub(center); distance = Math.max(radius * 0.15, Math.min(radius * 3.2, half * 3.2));
          requestRender();
        },
      };
      sessionRef.current = session;

      function pointerRay(event: PointerEvent) {
        updateCamera();
        const rect = canvas!.getBoundingClientRect();
        const point = new THREE.Vector3(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height, 1).unproject(camera);
        const direction = point.sub(camera.position).normalize();
        const origin = camera.position.clone().add(center);
        return { origin: origin.toArray() as Vec3, direction: direction.toArray() as Vec3 };
      }

      function touchSurface(event: PointerEvent, carve: boolean) {
        if (exportRef.current && carve) return;
        const ray = pointerRay(event);
        const hit = pickSurface(volume, ray.origin, ray.direction, session.threshold, session.crop, mask);
        if (!hit) { setDepth(null); return; }
        const original = pickSurface(volume, ray.origin, ray.direction, session.threshold, session.crop, mask, 2);
        setDepth(original ? Math.max(0, hit.distance - original.distance) : null);
        if (!carve) { pickPoint(hit.point); return; }
        const brushRadius = Math.max(session.diameter, minimumDiameter) / 2;
        if (strokeDepth === null) strokeDepth = hit.distance;
        if (hit.distance > strokeDepth + brushRadius) return;
        const reach = Math.min(hit.distance, strokeDepth) + brushRadius * 0.5;
        const centerPoint = ray.origin.map((n, axis) => n + ray.direction[axis] * reach) as Vec3;
        const changed = carveSphere(volume, mask, centerPoint, brushRadius, session.crop);
        if (changed.length) {
          if (strokeBytes + changed.byteLength > 32 * 1024 * 1024) {
            restoreCarve(mask, changed); setStatus(t('view3d.strokeLimit')); return;
          }
          stroke?.push(changed); strokeBytes += changed.byteLength; removed += changed.length;
          uploadMask([changed]); setRemovedCount(removed);
          const after = pickSurface(volume, ray.origin, ray.direction, session.threshold, session.crop, mask);
          setDepth(original && after ? Math.max(0, after.distance - original.distance) : null);
        }
        pickPoint(centerPoint);
        requestRender(true);
      }

      let pointer: { id: number; x: number; y: number; button: number; burrX: number; burrY: number } | null = null;
      let pickFrame = 0;
      // Usage timings: each press to release is one action (a burr stroke, a pick, a rotation or a pan).
      let gesture: { handle: GestureHandle; id: string; moved: boolean; startX: number; startY: number } | null = null;
      const pointerDown = (event: PointerEvent) => {
        if (pointer) return;
        event.preventDefault(); canvas!.focus(); canvas!.setPointerCapture(event.pointerId);
        const id = event.button === 0 && session.mode === 'burr' ? 'view3d-burr' : event.button === 0 && session.mode === 'pick' ? 'view3d-pick'
          : event.button === 1 || event.shiftKey ? 'view3d-pan' : 'view3d-rotate';
        gesture = { handle: usage.begin(id, event.pointerType === 'touch' ? 'touch' : 'drag'), id, moved: false, startX: event.clientX, startY: event.clientY };
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, button: event.button, burrX: event.clientX, burrY: event.clientY };
        if (event.button === 0 && session.mode === 'burr') { stroke = []; strokeDepth = null; strokeBytes = 0; touchSurface(event, true); }
        else if (event.button === 0 && session.mode === 'pick') touchSurface(event, false);
      };
      const pointerMove = (event: PointerEvent) => {
        if (!pointer || pointer.id !== event.pointerId) return;
        const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
        if (gesture && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 2) gesture.moved = true;
        if (pointer.button === 0 && session.mode === 'burr') {
          if (Math.hypot(event.clientX - pointer.burrX, event.clientY - pointer.burrY) >= 3) {
            touchSurface(event, true); pointer.burrX = event.clientX; pointer.burrY = event.clientY;
          }
        } else if (pointer.button === 0 && session.mode === 'pick') {
          // Held down, the picked point follows the pointer, at most once a frame, as clicks would place it.
          const at = { clientX: event.clientX, clientY: event.clientY };
          if (!pickFrame) pickFrame = requestAnimationFrame(() => { pickFrame = 0; if (pointer?.button === 0 && session.mode === 'pick') touchSurface(at as PointerEvent, false); });
        } else if (pointer.button === 1 || event.shiftKey) {
          updateCamera();
          const scale = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, canvas!.clientHeight);
          const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
          target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale); requestRender(true); usage.touch('scene');
        } else if (pointer.button === 2 || session.mode === 'orbit') {
          azimuth -= dx * 0.008; elevation = Math.max(-1.55, Math.min(1.55, elevation + dy * 0.008)); requestRender(true); usage.touch('scene');
        }
        pointer.x = event.clientX; pointer.y = event.clientY;
      };
      const pointerUp = (event: PointerEvent) => {
        if (pointer?.id !== event.pointerId) return;
        if (canvas!.hasPointerCapture(event.pointerId)) canvas!.releasePointerCapture(event.pointerId);
        pointer = null; finishStroke(); requestRender(false);
        // Without movement a rotation or pan is just a click; a pick or a burr touch is the action itself.
        if (gesture) gesture.handle.end(gesture.moved ? {} : { input: event.pointerType === 'touch' ? 'touch' : 'mouse', ...(gesture.id === 'view3d-rotate' || gesture.id === 'view3d-pan' ? { id: 'view3d-click' } : {}) });
        gesture = null;
      };
      const wheel = (event: WheelEvent) => {
        event.preventDefault(); usage.action('view3d-zoom', 'wheel', { burst: true }); usage.touch('scene');
        distance = Math.max(radius * 0.15, Math.min(radius * 20, distance * Math.exp(event.deltaY * 0.001))); requestRender(true);
      };
      const keyDown = (event: KeyboardEvent) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); usage.action('volume-undo', 'key'); session.undo(); }
        if (event.key.toLowerCase() === 'r') { usage.action('view3d-reset-camera', 'key'); session.resetCamera(); }
      };
      const contextMenu = (event: Event) => event.preventDefault();
      const contextLost = (event: Event) => { event.preventDefault(); setError(t('view3d.contextLost')); };
      canvas.addEventListener('pointerdown', pointerDown);
      canvas.addEventListener('pointermove', pointerMove);
      canvas.addEventListener('pointerup', pointerUp);
      canvas.addEventListener('pointercancel', pointerUp);
      canvas.addEventListener('wheel', wheel, { passive: false });
      canvas.addEventListener('keydown', keyDown);
      canvas.addEventListener('contextmenu', contextMenu);
      canvas.addEventListener('webglcontextlost', contextLost);
      removeEvents = () => {
        canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove); cancelAnimationFrame(pickFrame);
        canvas.removeEventListener('pointerup', pointerUp); canvas.removeEventListener('pointercancel', pointerUp);
        canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('keydown', keyDown);
        canvas.removeEventListener('contextmenu', contextMenu); canvas.removeEventListener('webglcontextlost', contextLost);
      };
      observer = new ResizeObserver(() => requestRender());
      observer.observe(host);
      requestRender();
    }
    try { initializeScene(canvas, host); } catch (caught) { setError(errorMessage(caught)); }
    return () => {
      exportRef.current?.abort(); exportRef.current = null;
      disposed = true; sessionRef.current = null; cancelAnimationFrame(requestId); clearTimeout(settledTimer);
      observer?.disconnect(); removeEvents();
      scalarTexture?.dispose(); maskTexture?.dispose(); maskUploadSource?.dispose(); labelTexture?.dispose(); material?.dispose(); geometry?.dispose(); renderer?.dispose();
    };
  }, [volume]);

  // The scene changed, so an action here is not reported as one that changed nothing (src/usage).
  useEffect(() => { usage.touch('scene'); }, [mode, threshold, diameter, fine, crop, showCrop, showSelection, removedCount, undoCount, exporting]);
  useEffect(() => { sessionRef.current?.requestRender(); }, [crosshair]);
  useEffect(() => { sessionRef.current?.showSegmentations(segmentTexture); }, [volume, segmentTexture]);

  function changeMode(value: InteractionMode) {
    setMode(value);
    if (sessionRef.current) sessionRef.current.mode = value;
  }
  function changeDiameter(value: number) {
    setDiameter(value);
    if (sessionRef.current) sessionRef.current.diameter = value;
  }
  function changeThreshold(value: number) {
    setThreshold(value);
    const session = sessionRef.current;
    if (session && session.threshold !== value) { session.threshold = value; session.requestRender(); }
  }
  function changeFine(value: boolean) {
    setFine(value);
    const session = sessionRef.current;
    if (session && session.fine !== value) { session.fine = value; session.requestRender(); }
  }
  function changeCrop(bounds: CropBounds, frame = false) {
    setCrop(bounds);
    const session = sessionRef.current;
    if (!session) return;
    session.crop = bounds;
    if (frame) session.frameCrop(); else session.requestRender();
  }

  function runVolumeOperation(errorKey: 'view3d.stlFailed' | 'view3d.selectionFailed', work: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    exportRef.current = controller; setExporting(true);
    return work(controller.signal).catch(error => {
      if (!controller.signal.aborted) setStatus(t(errorKey, { error: errorMessage(error) }));
    }).finally(() => {
      if (exportRef.current === controller) { exportRef.current = null; setExporting(false); }
    });
  }

  const exportSurface = async () => {
    const session = sessionRef.current;
    if (!session || exportRef.current) return;
    setStatus(t('view3d.extracting'));
    await runVolumeOperation('view3d.stlFailed', async signal => {
      const data = await extractStlAsync(volume, session.threshold, session.crop, session.mask, {
        signal, onProgress: (fraction: number) => setStatus(t('view3d.extractingPercent', { percent: Math.round(fraction * 100) })),
      });
      if (signal.aborted) return;
      if (data.byteLength === 84) { setStatus(t('view3d.noSurface')); return; }
      const filename = `veacom-${volume.series.modality.toLowerCase()}-surface.stl`;
      if (window.veacom) {
        const path = await window.veacom.saveFile(filename, data);
        setStatus(path ? t('view3d.saved', { count: (data.byteLength - 84) / 50 }) : t('view3d.exportCancelled'));
      } else {
        const url = URL.createObjectURL(new Blob([data], { type: 'model/stl' }));
        const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus(t('view3d.exported', { count: (data.byteLength - 84) / 50 }));
      }
    });
  };

  const applyVoi = async (selection: VoiSelection | null) => {
    const session = sessionRef.current;
    if (!session || exportRef.current) return;
    if (!selection && (!initialView || !viewportSize)) return;
    await runVolumeOperation('view3d.selectionFailed', async signal => {
      const options = { signal, onProgress: (fraction: number) => setStatus(t('view3d.building', { percent: Math.round(fraction * 100) })) };
      const result = selection ? await buildVoiMaskAsync(volume, selection, options)
        : await buildVisibleRegionMaskAsync(volume, initialView!, viewportSize!, options);
      if (signal.aborted) return;
      session.applySelection(result.mask, result.crop);
      setSelectionLabel(t('view3d.selectionLabel', { source: selection ? t('view3d.keySlices', { count: selection.keys.length }) : t('view3d.visibleRegion'), count: result.insideCount.toLocaleString() }));
      setStatus(t('view3d.reconstructed'));
    });
  };


  const clearSelection = () => {
    if (exportRef.current) return;
    sessionRef.current?.applySelection(null, fullCrop(volume)); setSelectionLabel('');
    setStatus(t('view3d.wholeRestored'));
  };

  const setCropBound = (axis: number, bound: 'min' | 'max', raw: string) => {
    const value = Math.round(Number(raw));
    if (!Number.isFinite(value)) return;
    const previous = sessionRef.current?.crop ?? crop;
    const next = { min: [...previous.min] as Vec3, max: [...previous.max] as Vec3 };
    next[bound][axis] = Math.max(0, Math.min(volume.series.dimensions[axis] - 1, value));
    if (next.min[axis] > next.max[axis]) next[bound === 'min' ? 'max' : 'min'][axis] = next[bound][axis];
    changeCrop(next);
  };
  const cropAroundPoint = () => {
    if (!crosshair) return;
    const index = patientToIndex(volume.series, crosshair).map((v, a) => Math.max(0, Math.min(volume.series.dimensions[a] - 1, v))) as Vec3;
    changeCrop({
      min: index.map((v, a) => Math.max(0, Math.floor(v - 30 / volume.series.spacing[a]))) as Vec3,
      max: index.map((v, a) => Math.min(volume.series.dimensions[a] - 1, Math.ceil(v + 30 / volume.series.spacing[a]))) as Vec3,
    }, true);
    setShowCrop(true);
  };
  const isCropped = crop.min.some(v => v !== 0) || crop.max.some((v, a) => v !== volume.series.dimensions[a] - 1);

  return <section ref={focusOnMount} tabIndex={-1} className="volume-view" aria-label={t('view3d.region')} data-testid="volume-view">
    <div className="v3d-toolbar">
      <strong className="v3d-title">{t('view3d.title')} <span>· {volume.series.description}</span></strong>
      <div className="v3d-group" role="group" aria-label={t('view3d.title')}>
        <button type="button" className="secondary-button compact" data-testid="volume-view-front" onClick={() => sessionRef.current?.resetCamera('front')}>{t('view3d.front')}</button>
        <button type="button" className="secondary-button compact" data-testid="volume-view-side" onClick={() => sessionRef.current?.resetCamera('side')}>{t('view3d.side')}</button>
        <button type="button" className="secondary-button compact" data-testid="volume-view-top" onClick={() => sessionRef.current?.resetCamera('top')}>{t('view3d.top')}</button>
      </div>
      <button type="button" className="secondary-button compact v3d-close" onClick={onClose} aria-label={t('view3d.close')} data-testid="volume-close"><X size={15} aria-hidden="true" />{t('view3d.closeButton')}<kbd className="button-kbd">Esc</kbd></button>
    </div>
    {!canRender ? <div role="alert" style={{ padding: 24 }}>
      {(volume.series.components ?? 1) !== 1 ? t('view3d.rgb') : t('view3d.noGeometry')}
      {warningTexts(volume.series, locale).map(warning => <p key={warning}>{warning}</p>)}
    </div> : <>
      <div className="v3d-toolbar">
        {(['orbit', 'pick', 'burr'] as const).map(value => <button key={value} data-testid={`volume-mode-${value}`} className="secondary-button compact" aria-pressed={mode === value} onClick={() => changeMode(value)}>{value === 'orbit' ? t('view3d.rotate') : value === 'pick' ? t('view3d.pick') : t('view3d.burr')}</button>)}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{t('view3d.burrDiameter')}
          <select aria-label={t('view3d.burrDiameterLabel')} data-testid="volume-burr-diameter" value={diameter} onChange={event => changeDiameter(Number(event.target.value))}>
            {[1, 2, 3, 5, 8].map(value => <option key={value} value={value}>{value} mm</option>)}
          </select>
        </label>
        <button type="button" className="secondary-button compact" data-testid="volume-undo" data-undo-count={undoCount} disabled={!undoCount || exporting} onClick={() => sessionRef.current?.undo()}>{undoCount ? t('view3d.undoCount', { count: undoCount }) : t('view3d.undo')}</button>
        <button data-action="volume-restore" type="button" className="secondary-button compact" disabled={!removedCount || exporting} onClick={() => sessionRef.current?.restore()}>{t('view3d.restoreBone')}</button>
        {mode === 'burr' && diameter < minimumDiameter && <span className="v3d-warning">{t('view3d.minimumBurr', { diameter: minimumDiameter.toFixed(1) })}</span>}
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontSize: 12 }} aria-live="polite">{t('view3d.depth', { depth: depth === null ? '—' : `${depth.toFixed(1)} mm` })}</span>
      </div>
      <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 260 }}>
      <div style={{ display: showSelection ? 'block' : 'none', width: '42%', minWidth: 330, maxWidth: 560 }}>
        <VoiEditor key={volume.series.id} volume={volume} initialView={initialView} annotations={annotations} disabled={exporting} onApply={applyVoi} />
      </div>
      <div ref={hostRef} style={{ position: 'relative', flex: '1 1 auto', minWidth: 0, minHeight: 260, overflow: 'hidden', background: '#06090c' }}>
        <canvas ref={canvasRef} data-testid="volume-3d-canvas" tabIndex={0} aria-label={t('view3d.canvas')} style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: mode === 'orbit' ? 'grab' : mode === 'burr' ? BURR_CURSOR : 'crosshair' }} />
        {marker.visible && mode !== 'burr' && <svg data-testid="volume-linked-marker" aria-label={t('view3d.marker')} width="34" height="34" style={{ position: 'absolute', left: marker.x - 17, top: marker.y - 17, pointerEvents: 'none', overflow: 'visible' }}>
          <circle cx="17" cy="17" r="8" fill="#06100c" fillOpacity="0.65" stroke="#000" strokeWidth="5" />
          <circle cx="17" cy="17" r="8" fill="none" stroke="#4dff8b" strokeWidth="2.5" />
          <path d="M17 0v10M17 24v10M0 17h10M24 17h10" stroke="#4dff8b" strokeWidth="2" />
        </svg>}
        <div className="v3d-canvas-hint">
          {mode === 'burr' ? t('view3d.burrHint') : t('view3d.orbitHint')}
          {legend.length > 0 && <div data-testid="volume-segment-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 9px', marginTop: 3 }}>{legend.map((segment, index) =>
            <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: segment.color }} />{segment.label}</span>)}</div>}
          {crosshair && <div>{marker.outsideCrop ? t('view3d.outsideCrop') : t('view3d.markerHint')}</div>}
        </div>
        {error && <div role="alert" className="v3d-error">{error}</div>}
      </div>
      </div>
      <div className="v3d-toolbar">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 240px' }}>{t('view3d.threshold')}
          <input data-action="volume-threshold" aria-label={t('view3d.thresholdLabel')} type="range" disabled={exporting} min={range[0]} max={range[1]} step={1} value={threshold} onChange={event => changeThreshold(Number(event.target.value))} style={{ flex: 1 }} />
          <output style={{ minWidth: 65, fontSize: 12 }}>{Math.round(threshold)} {storedUnit(volume.series)}</output>
        </label>
        {volume.series.modality === 'CT' && <>
          <button data-action="volume-threshold-bone" type="button" className="secondary-button compact" aria-pressed={Math.round(threshold) === 300} disabled={exporting} onClick={() => changeThreshold(300)}>{t('view3d.bone')}</button>
          <button data-action="volume-threshold-soft" type="button" className="secondary-button compact" aria-pressed={Math.round(threshold) === 50} disabled={exporting} onClick={() => changeThreshold(50)}>{t('view3d.softTissue')}</button>
        </>}
        <label style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}><input data-action="volume-fine" type="checkbox" checked={fine} onChange={event => changeFine(event.target.checked)} />{t('view3d.fineSampling')}</label>
        <button type="button" className="secondary-button compact" data-testid="volume-crop" aria-expanded={showCrop} onClick={() => setShowCrop(value => !value)}>{t('view3d.crop')}{isCropped ? ' •' : ''}</button>
        <button data-action="volume-select" type="button" className="secondary-button compact" aria-expanded={showSelection} onClick={() => setShowSelection(value => !value)}>{t('view3d.selectVolume')}</button>
        <button data-action="volume-visible-region" type="button" className="secondary-button compact" disabled={exporting || !initialView || !viewportSize} onClick={() => void applyVoi(null)}>{t('view3d.visibleRegionButton')}</button>
        {!!selectionLabel && <button data-action="volume-clear-selection" type="button" className="secondary-button compact" disabled={exporting} onClick={clearSelection}>{t('view3d.clearSelection')}</button>}
        <button type="button" className="secondary-button compact" data-testid="volume-export-stl" disabled={exporting || !!error} onClick={exportSurface}>{exporting ? t('view3d.extractingButton') : t('view3d.exportStl')}</button>
      </div>
      {showCrop && <div className="v3d-toolbar" style={{ fontSize: 12 }}>
        <span>{t('view3d.voxelBounds')}</span>
        {(['I', 'J', 'K'] as const).map((axis, i) => <label key={axis} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>{axis}
          <input data-action="volume-crop-bound" aria-label={t('view3d.cropMinimum', { axis })} type="number" disabled={exporting} value={crop.min[i]} min={0} max={volume.series.dimensions[i] - 1} onChange={event => setCropBound(i, 'min', event.target.value)} style={{ width: 62 }} />
          {t('view3d.to')} <input data-action="volume-crop-bound" aria-label={t('view3d.cropMaximum', { axis })} type="number" disabled={exporting} value={crop.max[i]} min={0} max={volume.series.dimensions[i] - 1} onChange={event => setCropBound(i, 'max', event.target.value)} style={{ width: 62 }} />
        </label>)}
        <button data-action="volume-crop-reset" type="button" className="secondary-button compact" disabled={exporting} onClick={() => changeCrop(fullCrop(volume))}>{selectionLabel ? t('view3d.resetCrop') : t('view3d.wholeVolume')}</button>
        <button type="button" className="secondary-button compact" data-testid="volume-crop-around-point" disabled={!crosshair || exporting} onClick={cropAroundPoint}>{t('view3d.aroundPoint')}</button>
        {isCropped && <span className="v3d-warning">{t('view3d.openBoundaries')}</span>}
      </div>}
      <div role="status" className="v3d-status">
        <span data-tooltip={rendererName || undefined} tabIndex={rendererName ? 0 : undefined}>{status || (rendererName ? '' : t('view3d.initializing'))}</span>
        {!!selectionLabel && <span>{selectionLabel}</span>}
        <span style={{ marginLeft: 'auto' }} data-testid="volume-removed" data-removed-voxels={removedCount}>{t('view3d.removed', { count: removedCount.toLocaleString() })}</span>
      </div>
    </>}
  </section>;
}

export { VolumeView };
