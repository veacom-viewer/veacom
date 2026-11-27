# Landmark model

Suggest landmarks, in the deformity plan (docs/deformity-planning.md), runs a landmark model on the film and suggests
all 14 of the kit's landmarks. Eleven were checked on real films; the other three were not, and the kit says so
wherever they or the values measured from them appear. It is off until the reader presses the button, and the
reader confirms every point: a suggestion is drawn apart from the landmarks and nothing is measured from it until the
reader accepts or moves it. The model was trained and checked in veacom-train (`docs/round7-status.md`,
`docs/round6-viewer-contract.md`); this page is its card.

Code: `src/imaging/deformity/suggest.ts` (the v3 input contract and decoding), `suggest.worker.ts` (onnxruntime-web in a
Worker), `src/ui/landmarkSuggestions.ts` (when it may run, OOD presence gate, loading the files),
`electron/landmark-model.cjs` and `src/web/landmarkModel.ts` (download and cache). Tests:
`tests/landmark-model.test.ts`, `tests/landmark-download.test.ts`, `tests/deformity-plan.test.ts`.

## The model (`veacom-landmarks-r7`, v3 contract)

| Graph | File | Size | SHA-256 |
| --- | --- | --- | --- |
| Stage A v3, whole film (`hgnetv2_b1` + Transformer + presence head, `wfp16`) | `veacom-landmarks-r7-stagea.onnx` | 8.15 MB | `9cf71c37…48320e` |
| Stage B v3, crops (single-graph fused `ZoomRefiner` `hgnetv2_b0` + `hgnetv2_b1`, `wfp16`) | `veacom-landmarks-r7-stageb.onnx` | 10.17 MB | `65aa7966…95d191` |

The full hashes and exact byte sizes are in `electron/landmark-model.json`. Both graphs are self-contained Opset 17
single-file ONNX graphs with weight-only FP16 compression (`float32` I/O) and strictly commercial-safe backbones
(Apache 2.0).

- **Stage A v3** finds the hip, knee and ankle centres of both legs on the film resampled to 2 mm per pixel on an
  864 × 288 canvas (576 × 1,728 mm, accommodating tall standing cassettes up to 172.8 cm) and outputs six calibrated
  per-joint visibility logits (`presence_logits`) alongside the 432 × 144 stride-2 heatmaps.
- **Stage B v3** finds 26 landmarks plus per-landmark RLE Laplace uncertainty (`sigma_px`, scaled by 0.35 mm/px to
  `sigmaMm`) on 320 × 320 crops at 0.35 mm per pixel around those centres, conditioned on `crop_type` (`int64[N]`,
  `0..6`). VEAcom runs the seven crops of the plan's leg: hip (centred 22 mm lateral of its centre), knee, ankle, and
  two on each shaft (30 % and 75 % from hip to knee; 25 % and 80 % from knee to ankle). A shaft point is the middle
  between the cortices on its crop's centre row.
- **Training data.** Distilled from a 5-teacher multi-paradigm ensemble trained across 14 commercial-safe datasets:
  BMPLE (100 train films, 20 dev films; 69 test films held out strictly for final evaluation), HFValid femur CTs,
  KISTI DataON `10.22711/idr/1473` + `1472` (CC BY 4.0, 40 full-leg sub-mm 3D CTs with 3D AP-depth subchondral
  projections), TotalSegmentator CT DRRs (native and prosthetic hips), Keast ankle CT DRRs, paediatric CT and pelvic
  radiographs, HipRay, PlaTiF, CGMH knee/pelvis, and 1,258 strict-consensus real clinical radiographs (severe OA,
  paediatric open physis, fracture/hardware).

## Results on real films

BMPLE test, 69 unseen films (138 legs), end to end: stage A's centres anchor stage B's crops. Point errors are radial,
in millimetres. Angles are the kit's own measurement from the predicted points against the reader's.

| Point | Error (mean / median) | Within 2 mm / 5 mm |
| --- | --- | --- |
| Hip centre | 1.13 / 0.94 mm | 94.9 % / 99.3 % |
| Knee centre | 1.03 / 0.70 mm | 92.7 % / 97.1 % |
| Ankle centre | 0.95 / 0.66 mm | 94.2 % / 98.6 % |
| Condyles, medial and lateral | 1.46 and 1.79 mm | 79.7 % and 70.1 % |
| Plateau, medial and lateral | 2.27 and 1.75 mm | 51.8 % and 73.7 % |

The shaft points were checked on the same 69 unseen BMPLE test films using Round-4 midlines and reader points.

| Shaft point | Checked against | Error across the shaft |
| --- | --- | --- |
| Femoral shaft, lower | the reader's point (BMPLE's F) / edge-traced midline | 0.42 mm at F; 0.11 mm against the shaft midline |
| Femoral shaft, upper | edge-traced shaft midline | 0.10 mm (bias -0.001 mm) |
| Tibial shaft, upper and lower | edge-traced shaft midline | 0.16 and 0.27 mm |

- **Axes and values:** femoral anatomic axis 0.05°, tibial anatomic axis 0.13°, aLDFA 0.46°, AMA 0.19°.
- **Uncertainty calibration (`sigma_px`):** on 1,237 unseen BMPLE test landmarks, Spearman ρ = 0.522 (76.6 % within 2σ).

| Value | Error (MAE / median) | Legs within 1° / 2° (MAD: 1 / 2 mm) |
| --- | --- | --- |
| mLDFA | 0.51° / 0.26° | 91.9 % / 94.9 % |
| MPTA | 1.00° / 0.62° | 68.1 % / 85.9 % |
| JLCA | 1.10° / 0.66° | 62.5 % / 85.3 % |
| HKA | 0.32° / 0.20° | 95.6 % / 99.3 % |
| MAD | 0.99 mm / 0.63 mm | 67.9 % / 89.1 % |

- **External hospital site (Mendeley Data High Tibial Osteotomy, 70 unseen films / 107 limbs, Poland):** reader-definition
  HKA SD **0.260°** (MAE 0.339°, max 0.98°, **0 / 107** limbs over 1°) at 0.15 mm/px, inside the human specialist
  inter-observer range (0.27° to 0.33°). Spacing invariance across 0.12 / 0.15 / 0.18 mm/px: 107 / 107 limbs pass with
  SD 0.252° / 0.260° / 0.305° and 0 / 107 over 2°.

## What is suggested

All 14 landmarks.

| Checked on real films (BMPLE test) | Unchecked |
| --- | --- |
| Femoral head, knee centre, both condyles, both plateau edges and ankle centre (the reader's points); femoral shaft lower (the reader's point) and upper, tibial shaft upper and lower (edge-traced midlines) | Greater trochanter, plafond medial and lateral |

- **Unchecked** points remain marked in `UNCHECKED` (`suggest.ts`) until prospective standing-film clinician ground truth
  is collected, despite large improvements on edge-traced checks and 3D CT DRRs:
  - **Trochanter:** 2.08 mm / mLPFA 1.63° against BMPLE test edge traces; 3.44 mm / mLPFA 2.13° on held-out HFValid CTs.
  - **Plafond:** 1.23 and 1.24 mm / LDTA 1.62° (bias +0.04°) against BMPLE test edge traces; 1.997 mm overall on held-out
    KISTI full-leg 3D CTs.
- **How the kit says so.** An unchecked suggestion is a dashed diamond, not a ring. Its row says "suggested ·
  unchecked", and one line under the button says what each shaft point was checked against and that the trochanter and
  plafond are unchecked. Accepted as it was, the row still says "unchecked", and every value, malalignment step and CORA
  measured from it says "from an unchecked point" beside it, in the panel and in the report, and "unchecked point" in
  its label on the image, until the reader moves that point or places it again.
- **Saved,** the label's `confidence` names `veacom-landmarks-r7`, its SHA-256 hashes, and `unchecked` where applicable
  (docs/deformity-labels.md).
- **The femoral head.** VEAcom suggests the outline as points on a circle around the checked hip centre, in the
  directions of the model's outline points and at their median distance in millimetres, so the fitted circle reproduces
  the checked hip centre exactly.
- **The plateau.** BMPLE's readers put the plateau points a few millimetres inside the rim, on the joint line; the kit
  asks for the edges. While a plateau point stays where the model put it, the panel notes that WBL and joint offset are
  short.

## When it runs

The button is off, with the reason on hover, unless:

- the film is greyscale (MONOCHROME1 or MONOCHROME2) and has a pixel spacing or a calibration (the model works in
  millimetres; it never assumes one);
- the patient's right is known (Patient Orientation, or the reader's answer), and the film is upright: its rows run
  across the patient and its columns towards the feet;
- the film fits stage A v3's canvas, 576 × 1,728 mm (tall standing cassettes fit cleanly without clipping ankles);
- a landmark the model suggests is still unplaced.

Nothing is suggested when stage A did not find two legs (`hip_y < knee_y < ankle_y` and hip separation > 50 mm), or when
stage A v3 is not sure of the leg. On v3 graphs, each leg's `presence` is the minimum `sigmoid(presence_logits)` across
its hip, knee and ankle; below `UNSURE_PRESENCE = 0.15` (or heatmap peak below `UNSURE_PEAK_V3 = 0.005`), the panel says
the model is not sure and suggests nothing:

| Film | Min presence | Min peak | Decision |
| --- | ---: | ---: | --- |
| BMPLE test (69 films / 138 legs) | 0.995 to 1.000 | 0.074+ | Accepted (100 %) |
| [Mendeley Data HTO](https://doi.org/10.17632/bpvj6xczm2.3) film 49_0, both whole legs (CI) | 0.998 and 0.999 | 0.111 and 0.118 | Accepted |
| Mendeley HTO all 107 valid limbs @ 0.15 mm/px | 0.836+ | 0.073+ | Accepted (100 %) |
| Mendeley HTO chest film 71_0 (all spacings) | 0.000017 | 0.000027 | Rejected (unsure) |
| Mendeley HTO film 10_0, stops mid-tibia (CI) | 0.0044 and 0.0047 | 0.0002 and 0.0004 | Rejected (unsure) |
| Synthetic long-leg drawing `ips-equal` (CI) | 0.0013 | 0.0061 | Rejected (unsure) |
| 50 non-long-leg real radiographs (FracAtlas/BTXRD) | 0.0000 | 0.0000 | Rejected (100 %, AUROC 1.0000) |

## Limits

- Clinical standing-film ground-truth validation covers adult films without hardware. Although Version 7 incorporates
  paediatric radiographs, CT DRRs with hip prostheses, and consensus hardware/fracture cases in training, prospective
  multi-centre clinical validation on children, implants, and external fixators has not yet been completed; the panel
  retains its explicit clinician-verification caution beside the button.
- Every suggestion is editable and unmeasured until accepted or moved; this is a clinician-reviewed aid, not an
  autonomous diagnostic device.

## Where it runs

On the reader's computer only. The film's pixels go to a Worker in the page, as a copy, and the points come back; the
only request is for the model's two files, the first time.

| | Files from | Kept in | Runtime |
| --- | --- | --- | --- |
| Browser | `models/` on the site itself (`web/site/prepare.mjs` downloads from the release and verifies SHA-256) | Cache Storage | onnxruntime-web 1.31.1, WebAssembly SIMD, 4 threads when cross-origin isolated (`viewer.veacom.app`), 1 otherwise |
| Desktop | GitHub release `v0.1.0-beta.3`, verified against SHA-256 before caching and before use | `userData/landmark-model` | onnxruntime-web 1.31.1, WebAssembly SIMD, 1 thread |

**Speed** on Apple Silicon (Mendeley HTO 49_0, 2,860 × 9,289 pixels, all seven crops):
- **Browser (`viewer.veacom.app`, 4 threads, cross-origin isolated):** **0.59 s** warm (window 57 ms, Stage A 144 ms,
  crops 125 ms, Stage B 268 ms) and **1.10 s** on the first run in a tab (including Worker start and graph init).
- **1-thread WASM SIMD (`onnxruntime-web 1.31.1`):** 1.59 s model inference (~1.79 s total including JS preprocessing),
  0.000064 mm max coordinate difference vs native ONNX Runtime 1.32.0.
