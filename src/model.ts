import type { CoreNote } from './i18n/core';
export type Vec3 = [number, number, number];
export type PixelArray = Float64Array | Float32Array | Int16Array | Uint16Array | Uint8Array;
export type Plane = 'axial' | 'coronal' | 'sagittal';
/** SUV by body weight (SUVbw), lean body mass (SUL) or body surface area (SUVbsa). */
export type SuvNormalization = 'bw' | 'lbm' | 'bsa';
export type ViewMode = 'source' | 'mpr';
export type Tool = 'scroll' | 'window' | 'pan' | 'zoom' | 'rotate' | 'none' | 'length' | 'angle' | 'cobb' | 'rectangle' | 'ellipse' | 'polygon' | 'polyline' | 'probe' | 'arrow' | 'text' | 'crosshair' | 'sphere';
/** What a sphere VOI on a PET stands for besides a lesion: a reference region (src/imaging/deauville.ts). */
export type ReferenceRole = 'liver' | 'bloodPool';
/** A Deauville score the reader confirmed: 1–5, or X (new uptake unlikely to be lymphoma). */
export type DeauvilleScore = 1 | 2 | 3 | 4 | 5 | 'X';
export interface FrameMetadata {
  origin: Vec3; direction: number[]; spacing: Vec3;
  windowCenter?: number; windowWidth?: number;
  /** Inclusive padding range in the decoded pixel array's modality-value units. */
  paddingRange?: [number, number];
  paddingIsNaN?: boolean;
  orientationKnown?: boolean; positionKnown?: boolean; spacingKnown?: boolean;
  instanceNumber?: number; sopInstanceUid?: string; sourceFrameNumber?: number;
  /** Segmentation frames: the segment they hold and the source image they were drawn on. */
  segmentNumber?: number; referencedSopInstanceUid?: string; referencedFrameNumber?: number;
  /** The VOI LUT this frame is shown with in DICOM window mode, an index into `Series.voiLuts`. Frames with a window have none. */
  voiLut?: number;
  /** The stored window's curve when it is not LINEAR (VOI LUT Function). */
  voiFunction?: VoiFunction;
  /** A gamma camera frame: which detector took it, in which view, energy window and phase. */
  nm?: NmFrame;
}
/** What a gamma camera (NM) frame is, from its file's frame vectors. The view (ANT, POST, RAO, LAO, RPO, LPO, R LAT,
 * L LAT) comes from the detector's View Code Sequence; detector, energy window and phase are given only where the file
 * holds more than one of them. */
export interface NmFrame { view?: string; detector?: number; energyWindow?: string; phase?: number }
/**
 * One gate of a gated SPECT (Image Type RECON GATED TOMO): its time slot of the cardiac cycle and, where the file holds
 * several R-R interval windows, its window with the beat lengths that window accepted, in ms. `slotTime` is the Time
 * Slot Time (0054,0073): the time, in ms, the gate counted over all its beats, not where it lies in the cycle.
 */
export interface Gate { slot: number; slots: number; interval?: number; intervals?: number; beats?: [number, number]; slotTime?: number }
export type VoiFunction = 'SIGMOID' | 'LINEAR_EXACT';
/** A VOI LUT: modality values from `first` map to `data` (0 to 2^bits - 1), clamped at both ends. */
export interface VoiLut { first: number; bits: number; data: number[]; explanation?: string }
export interface Segment { number: number; label: string; color?: [number, number, number] }
/** A DICOM Segmentation: masks drawn over the image series it references, never shown as images. */
export interface Segmentation { kind: string; referencedSeriesUid?: string; referencedSeries?: [studyUid: string, seriesUid: string][]; referencedInstances?: [sopUid: string, frame: number | null][]; segments: Segment[] }
export interface Series {
  engineGeneration?: number;
  patientKey?: string;
  previousPetId?: string;
  catalogRevision?: number;
  sourceRevision?: number;
  id: string; uid: string; studyUid: string; patientId: string; patientName: string;
  studyDate: string; description: string; modality: string; seriesNumber: number;
  dimensions: Vec3; spacing: Vec3; origin: Vec3;
  /** Row-major matrix, columns are the image i, j, k directions in patient LPS. */
  direction: number[];
  windowCenter: number; windowWidth: number; valueUnit: string;
  /** The file stores no window; the core measured this one from the pixels. */
  windowFromPixels?: boolean;
  segmentation?: Segmentation;
  voiLuts?: VoiLut[];
  /** What stored PET values are multiplied by for SUVbw (1 for values already in SUV); for SUL and SUVbsa, where the
   * patient's height (and, for SUL, sex) are recorded. */
  suvFactor: number | null; sulFactor?: number | null; suvBsaFactor?: number | null;
  canReconstruct: boolean; warnings: string[];
  /** The same warnings as engine messages, for translation (src/i18n/core.ts). */
  warningNotes?: CoreNote[];
  photometricInterpretation: string;
  frameOfReferenceUid?: string;
  components?: 1 | 3;
  pixelType?: 'float64' | 'float32' | 'int16' | 'uint16' | 'uint8';
  spacingKnown?: boolean;
  orientationKnown?: boolean;
  positionKnown?: boolean;
  frameMetadata?: FrameMetadata[];
  /** Inclusive padding range in decoded modality values, shared by all frames. */
  paddingRange?: [number, number];
  paddingIsNaN?: boolean;
  measurementScale?: number;
  measurementUnits?: 'auto' | 'px';
  /** The SUV the reader chose for PET values (Units panel); body weight when unset. */
  suvNormalization?: SuvNormalization;
  sourceFramesOnly?: boolean;
  /** A phase of a series the engine parted, in order; one gate of a gated SPECT carries `gate` (kind `timeSlot`). */
  phase?: { kind: string; value: string; label: string; order: number; gate?: Gate };
  patientAge?: number; patientSex?: string;
  echoTime?: number; repetitionTime?: number; inversionTime?: number; diffusionBValue?: number;
  protocolName?: string; sequenceName?: string; scanningSequence?: string; sequenceVariant?: string;
  scanOptions?: string; mrAcquisitionType?: string; manufacturer?: string; imageType?: string;
  acquisitionTime?: string; acquisitionDateTime?: string; acquisitionContrast?: string;
  contrastBolusAgent?: string; contrastBolusRoute?: string; contrastBolusStartTime?: string;
  contrastBolusAdministered?: string; contrastBolusDetected?: string; contrastBolusPhase?: string;
  flipAngle?: number;
  /** For the image corners, as stored: Patient's Birth Date, Patient's Age (045Y), Study Time and so on. */
  patientBirthDate?: string; patientAgeText?: string; studyTime?: string; studyDescription?: string;
  institutionName?: string; accessionNumber?: string; magneticFieldStrength?: number; sliceThickness?: number;
  /** A PET's tracer, injection and patient, for its acquisition panel (imaging/petAcquisition.ts). */
  petAcquisition?: PetAcquisition;
  /** Blood glucose in mmol/l the reader typed for this PET's study (imaging/glucose.ts): a display setting, as
   * `suvNormalization` is, never read from the file. */
  typedGlucose?: number;
}
/** What a PET records of its tracer, the injection and the patient, as the engine reads it (native/src/model.rs). */
export interface PetAcquisition {
  /** Radiopharmaceutical (0018,0031), and the value and meaning of its code (0054,0304), e.g. C-B1031. */
  tracer?: string; tracerCode?: string; tracerCodeScheme?: string; tracerCodeMeaning?: string;
  /** The radionuclide's code meaning (0054,0300), e.g. "^18^Fluorine". */
  radionuclide?: string;
  /** Radionuclide Total Dose in Bq, and its half-life in seconds. */
  injectedActivity?: number; halfLife?: number;
  /** Radiopharmaceutical Start DateTime and Start Time, as stored. */
  injectionDateTime?: string; injectionTime?: string; injectionOffset?: string;
  multipleAdministrations?: boolean;
  /** Earliest recorded acquisition (DICOM DT with offset when known), and the seconds from injection to it. */
  scanStart?: string; uptakeSeconds?: number;
  /** Patient's Weight in kg and Size in m, as stored. */
  weight?: number; height?: number;
  /** Blood glucose in mmol/l (Acquisition Context, CP-1229). */
  glucose?: number;
  /** START, ADMIN or NONE. */
  decayCorrection?: string;
  /** Manufacturer's Model Name (0008,1090) and Reconstruction Method (0054,1103), as stored. */
  scannerModel?: string; reconstruction?: string;
}
/** One drawable frame of a DICOM Segmentation: where its plane lies and the outline of its mask. */
export interface MaskFrame {
  segment: number; label: string; color: string;
  /** The centre of the frame's first pixel and one pixel step along its rows (i) and columns (j), in patient mm. */
  origin: Vec3; i: Vec3; j: Vec3; normal: Vec3;
  /** Half the frame's slice thickness: how far from its plane a viewed slice still shows it. */
  reach: number;
  /** SVG paths in pixel-index units: the set pixels as row runs, and the edges between set and unset pixels. */
  fill: string; outline: string;
}
/** A segmentation's masks on one regular grid: 1-based indices into `segments`, 0 where no segment is set. */
export interface LabelVolume {
  dimensions: Vec3; origin: Vec3; i: Vec3; j: Vec3; k: Vec3; normal: Vec3;
  labels: Uint8Array;
  segments: Array<{ segment: number; label: string; color: string; rgb: [number, number, number] }>;
  /** Index bounds of the set voxels, inclusive. */
  min: Vec3; max: Vec3;
}
export interface SegmentationOverlay { id: string; series: Series; frames: MaskFrame[]; labels: LabelVolume | null }
export interface Volume {
  series: Series; data: PixelArray;
  /** When present, data contains only this acquired frame; series metadata remains complete. */
  sourceFrameIndex?: number;
}
export interface Annotation {
  id: string; type: Tool; points: Vec3[]; plane: Plane; slice: number;
  label?: string; color?: string;
  mode?: ViewMode; sourceFrame?: number;
  sourceSopInstanceUid?: string; sourceFrameNumber?: number;
  /** The tilt of the reconstructed plane it was drawn on (pitch, yaw in degrees); absent on a plain plane. `slice`
   * counts slices of that tilted plane. */
  oblique?: [number, number];
  /** Where the label sits once moved by hand: its top left corner from the last point, in patient mm. */
  labelShift?: Vec3;
  /** A sphere VOI (`sphere`: its centre, then a point on its surface) marked as a reference region. */
  role?: ReferenceRole;
  /** A sphere VOI's Deauville score, as the reader confirmed it. */
  fdgLymphoma?: boolean;
  deauville?: DeauvilleScore;
  /** Measurements and reference geometry the reader confirmed. */
  deauvilleBasis?: string;
  /** A sphere VOI's metabolic volume: its voxels at 41% of its SUVmax or above, or at SUVbw 2.5 or above. */
  threshold?: 'max41' | 'suv2.5';
  priorLesionId?: string;
  regionSeeds?: number[];
}
export type WheelAction = 'scroll' | 'zoom' | 'rotate' | 'none';
export interface ViewState {
  plane: Plane; slice: number; windowCenter: number; windowWidth: number;
  zoom: number; pan: [number, number]; rotation: number; flipX: boolean; flipY: boolean;
  inverted: boolean; oblique?: [number, number];
  /** Thick slab: each reconstructed slice shown as the MIP, MinIP or mean through this many millimetres. */
  slab?: { mode: 'mip' | 'minip' | 'mean'; thickness: number };
  /** A whole-volume projection (MIP) seen from the front and turned about the patient's long axis: the slice is the
   * turn, in steps of 10° (geometry.PROJECTION_STEPS). */
  projection?: 'mip';
  palette?: 'gray' | 'hot' | 'ge' | 'rainbow';
  mode?: ViewMode;
  windowMode?: 'dicom' | 'manual';
  /** Paired planar views use the same linear window even when the frames specify different VOI curves. */
  sharedWindow?: boolean;
  /** Set by `resolveView` while a displayed source frame is shown with its VOI LUT: an index into `Series.voiLuts`. */
  voiLut?: number;
  /** Set by `resolveView` from the displayed source frame: the curve its window follows, manual changes included. */
  voiFunction?: VoiFunction;
}
export interface FusionSettings { volume: Volume; opacity: number; upperSuv: number; palette: 'hot' | 'ge' | 'rainbow' | 'hot_metal' | 'red_yellow';
  /** uptake: low uptake fades out (as before); classic: the same share everywhere in the PET, as scanners draw it. */
  blend: 'uptake' | 'classic';
  /** For an overlay in a frame of reference of its own, aligned to the pane's (imaging/registration.ts): the row-major
   * 4 × 4 rigid transform from the pane's patient coordinates to the overlay's. */
  transform?: readonly number[]; }
export interface ViewportProps {
  volume: Volume; view: ViewState; tool: Tool; annotations: Annotation[];
  active: boolean; crosshair: Vec3 | null; fusion?: FusionSettings | null;
  /** Other panes' planes, drawn where they cut this one; `transform` takes a plane in a frame of reference of its own,
   * aligned to this pane's (imaging/registration.ts), into this pane's patient coordinates. */
  referencePlanes?: Array<{ id: string; series: Series; view: ViewState; color?: string; transform?: readonly number[] }>;
  /** A still left click sets the linked point (while 3D is open beside the panes). */
  clickPicksPoint?: boolean;
  mouseBindings?: Partial<Record<'left' | 'middle' | 'right', Tool>>;
  wheelSensitivity?: number;
  /** What the wheel does without Ctrl: page slices (the default), zoom, turn the image 5° a notch, or nothing. */
  wheelAction?: WheelAction;
  reverseWheel?: boolean;
  showOverlay?: boolean;
  /** The scale bar at the bottom right (off unless asked for). */
  showScale?: boolean;
  hidePatientData?: boolean;
  hideMeasurements?: boolean;
  /** Segmentations to outline wherever their masks lie in the displayed plane. */
  segmentations?: SegmentationOverlay[];
  onActivate: () => void; onViewChange: (patch: Partial<ViewState>) => void;
  onAnnotationsChange: (annotations: Annotation[]) => void;
  onCrosshairChange: (point: Vec3) => void;
  onFrame?: (milliseconds: number) => void;
  /** A click on the plane's name, bottom left: the next plane (axial, coronal, sagittal). */
  onCyclePlane?: () => void;
  /** Ctrl + drag on a fused image sets the PET's scale: the top of it and its opacity. */
  onFusionAdjust?: (next: { upperSuv: number; opacity: number }) => void;
  /** In the three-plane MPR: a handle on another pane's line was dragged; that pane's plane turns to `oblique`. */
  onRotateReference?: (id: string, oblique: [number, number]) => void;
  /** Shown in the accessible name when several panes are open, so they can be told apart. */
  paneNumber?: number;
  /** The pane's series, or its fused overlay, is placed by an alignment (imaging/registration.ts): its corner says so. */
  aligned?: 'automatic' | 'adjusted';
}
export interface VolumeViewProps {
  volume: Volume; crosshair: Vec3 | null;
  annotations?: Annotation[];
  initialView?: ViewState;
  viewportSize?: [number, number];
  /** Shown segmentations, drawn in their colours inside the volume. */
  segmentations?: SegmentationOverlay[];
  onCrosshairChange: (point: Vec3) => void;
  onClose: () => void;
}
/** Where the engine lays a moving series over a fixed one: `matrix` (row-major 4 × 4) takes the moving series' patient
 * coordinates to the fixed series'. `similarity` is normalised mutual information as the entropy correlation
 * coefficient (0 unrelated, 1 identical), at the result and with the two coordinates taken as one; `overlap` the share of
 * the fixed volume's points inside the moving one. */
export interface EngineRegistration {
  matrix: number[]; rotation: Vec3; shift: Vec3; centre: Vec3; angle: number;
  similarity: number; similarityBefore: number; overlap: number; evaluations: number; levels: number;
}
export interface CoreState {
  status: 'starting' | 'ready' | 'restarting' | 'failed' | 'stopping' | 'stopped';
  generation: number; restartCount: number; message?: string;
}
/** `source`: where the selection came from (usage timings), never its path. */
export interface ImportResult { series: Series[]; warnings: string[]; warningNotes?: CoreNote[]; source?: 'disk' | 'cd' | 'zip' | 'network'; }
/** Usage timings (electron/usage.cjs): the user's answer, and whether a collector is configured. */
export interface UsageStatus { consent: 'granted' | 'denied' | null; sending: boolean; environment: string; pendingBytes: number; }
export interface ExportResult { directory: string; warnings: string[]; warningNotes?: CoreNote[]; /** One ZIP per patient, when exported as ZIP. */ archives?: string[]; }
/** A ZIP export before it is made: its files, bytes now and after, seconds. */
export interface ExportEstimate { files: number; before: number; after: number; seconds: number; }
export interface IsoExportResult { path: string; warnings: string[]; warningNotes?: CoreNote[]; }
export interface UpdateStatus {
  phase: 'manual' | 'idle' | 'checking' | 'up-to-date' | 'unavailable' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string; message: string; version?: string; releaseNotes?: string; progress?: number;
  canDownload: boolean; canInstall: boolean; sourceBuild: boolean; signature?: string; checkedAt?: string;
}
export interface DesktopBridge {
  /** The saved interface language, passed by the main process ('tr' or 'en'). */
  locale?: string;
  /** Saves the interface language for the main process's own text and the next start. */
  setLocale?: (locale: 'tr' | 'en') => Promise<void>;
  takeStartupPaths(): Promise<string[]>;
  getCoreState(): Promise<CoreState>;
  /** Chromium's WebGL and compositing feature status, e.g. webgl: 'enabled' or 'unavailable_software'. */
  getGraphicsStatus?(): Promise<{ webgl?: string; gpuCompositing?: string }>;
  /** The page zoom (1 at 100%), which divides a wheel event's legacy notch units. */
  zoomFactor?(): number;
  onCoreState(listener: (state: CoreState) => void): () => void;
  listSeries(): Promise<ImportResult>;
  importSelected(capabilities: string[]): Promise<ImportResult>;
  getProgress(): Promise<{ id?: number; running: boolean; stage: string; completed: number; total: number; cancelled: boolean }>;
  /** Series this selection's import has already published, from the `after`th on. */
  importEarly(capabilities: string[], after: number): Promise<{ import: number; series: Series[] }>;
  cancelOperation(id?: number): Promise<{ requested: boolean }>;
  /** Stops the DICOM, USB or folder export under way. */
  cancelExport?: () => Promise<void>;
  /** The tags of the file holding frame `frame` (the slice shown), or of the series' first frame. */
  measure(id: string, generation: number, revision: number, operation: import('./imaging/nativeMeasurements').SamplingOperation): Promise<unknown>;
  /** The rigid transform laying one series over another acquired apart (native/src/registration.rs). */
  register?(request: { fixedId: string; movingId: string; generation: number; fixedRevision: number; movingRevision: number }): Promise<EngineRegistration>;
  getTags(seriesId: string, generation: number, frame?: number, revision?: number): Promise<Record<string, unknown>[]>;
  removeSeries(ids: string[], generation: number): Promise<{ removed: number; remaining?: number }>;
  getPixels(request: { seriesId: string; generation: number; index?: number; revision?: number }): Promise<{ url: string; generation: number }>;
  openPaths: (kind: 'files' | 'folder' | 'archive') => Promise<string[]>;
  /** The import window, in a view of its own that this page cannot reach (electron/import-view.cjs): import capabilities
   *  for what the user opened there, none if they closed it. `disc` starts at a disc drive. */
  openImportWindow?: (start?: 'disc') => Promise<string[]>;
  /** The import window's clicks, for usage timings. */
  onImportAction?: (listener: (id: string, input: 'mouse' | 'key' | 'touch') => void) => () => void;
  importFiles: (files: File[]) => Promise<string[]>;
  openExternal: (url: string) => Promise<void>;
  saveFile: (suggestedName: string, data: ArrayBuffer | string) => Promise<string | null>;
  exportDicom: (seriesId: string | string[], options: { anonymize: boolean; full?: boolean; dicomdir: boolean; decompress?: boolean; root?: boolean; here?: boolean; frame?: number; zip?: boolean; smallest?: boolean; engineGeneration?: number }) => Promise<ExportResult | null>;
  /** In-app feedback to the team (veacom.app), sent only once the user confirms it in main's own dialog. `reason` is the service's or main's short error code. */
  sendFeedback?: (payload: { kind: 'problem' | 'suggestion'; message: string; email: string; includeSystem: boolean }) => Promise<{ ok: boolean; cancelled?: boolean; status?: number; reason?: string }>;
  estimateExport?: (seriesId: string | string[], options: { anonymize: boolean; full: boolean; smallest: boolean; frame?: number; engineGeneration?: number }) => Promise<ExportEstimate>;
  /** The remembered export folder (the Desktop at first), choosing another, and showing an export in Explorer. */
  exportFolder?: () => Promise<string>;
  /** Text onto the system clipboard. */
  copyText?: (text: string) => Promise<void>;
  chooseExportFolder?: () => Promise<string | null>;
  revealExport?: (target: string) => Promise<void>;
  beginVideo: (suggestedName: string, fps: number) => Promise<{ id: string } | null>;
  configureVideo: (id: string, settings: { width: number; height: number; description: ArrayBuffer }) => Promise<void>;
  appendVideo: (id: string, sample: ArrayBuffer, key: boolean) => Promise<void>;
  finishVideo: (id: string) => Promise<string>;
  cancelVideo: (id: string) => Promise<void>;
  /** A series exported as pictures: a folder chosen once, a file per slice (electron/image-export.cjs). */
  beginImages?: (suggestedName: string, here?: boolean) => Promise<{ id: string; directory: string } | null>;
  appendImage?: (id: string, name: string, data: ArrayBuffer) => Promise<void>;
  finishImages?: (id: string) => Promise<string>;
  cancelImages?: (id: string) => Promise<void>;
  /** Stops the disc (ISO) export under way. */
  cancelIso?: () => Promise<void>;
  exportIso: (seriesId: string | string[], options: { anonymize: boolean; full?: boolean; label?: string; openBurner?: boolean; decompress?: boolean; engineGeneration?: number }) => Promise<IsoExportResult | null>;
  getAiConfig: () => Promise<{ enabled: boolean; configured: boolean; model: string }>;
  configureAi: (settings: { apiKey?: string; model: string; forget?: boolean }) => Promise<void>;
  askSecondOpinion: (request: { summary: string }) => Promise<string>;
  getVersion: () => string;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  openUpdateNotes(): Promise<void>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  localUsageCheck?: boolean;
  usageStatus?(): Promise<UsageStatus>;
  usageConsent?(value: 'granted' | 'denied'): Promise<UsageStatus>;
  usageRecord?(events: unknown[]): Promise<number>;
  /** While the page unloads: hands the last events over without waiting for an answer. */
  usageFinal?(events: unknown[]): void;
  usageMachine?(machine: { renderer: string; software: boolean }): Promise<void>;
}
declare global { interface Window { veacom?: DesktopBridge; } }
