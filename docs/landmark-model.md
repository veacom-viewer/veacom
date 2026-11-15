# Landmark model

Suggest landmarks, in the deformity plan (docs/deformity-planning.md), runs a landmark model on the film and suggests
the points behind mLDFA, MPTA, JLCA, HKA and MAD. It is off until the reader presses the button, and the reader
confirms every point: a suggestion is drawn apart from the landmarks and nothing is measured from it until the reader
accepts or moves it. The model was trained and checked in veacom-train (`docs/synthetic.md` §7 and §8 there); this page
is its card.

Code: `src/imaging/deformity/suggest.ts` (the input contract and decoding, ported from veacom-train's `stagea.py` and
`stageb.py`), `suggest.worker.ts` (onnxruntime-web in a Worker), `src/ui/landmarkSuggestions.ts` (when it may run,
loading the files), `electron/landmark-model.cjs` and `src/web/landmarkModel.ts` (download and cache). Tests:
`tests/landmark-model.test.ts`, `tests/landmark-download.test.ts`, `tests/deformity-plan.test.ts`.

## The model

| Graph | File | Size | SHA-256 |
| --- | --- | --- | --- |
| Stage A, whole film (A8, seed 0) | `veacom-landmarks-r2-stagea.onnx` | 8.3 MB | `51e9f821…75821099` |
| Stage B, crops (`ft_maskplateau`, seed 0) | `veacom-landmarks-r2-stageb.onnx` | 9.5 MB | `c0adab05…cadfcfdd` |

The full hashes are in `electron/landmark-model.json`.

- **Stage A** finds the hip, knee and ankle centres of both legs on the film resampled to 2 mm per pixel (a U-Net, 704 ×
  256 input).
- **Stage B** finds 26 points on 320 × 320 crops at 0.35 mm per pixel around those centres (a small HRNet, 2.36 M
  parameters). VEAcom runs only the hip, knee and ankle crops of the plan's leg.
- **Training data.** BMPLE (leg): 190 standing long-leg radiographs of adults from two hospitals, labelled by one senior
  orthopaedic surgeon. Qingsong Yao, Zhen Huang, Ao Wang, Rongsheng Wang, Hanxue Zhang, Jiangji Wang and S. Kevin Zhou,
  *Structure-Guided Self-Supervised Matching for One-Shot Medical Landmark Detection*, arXiv:2203.01687. 100 films
  trained the model, 20 chose between its variants and 69 tested it. Stage B was first trained on synthetic films that veacom-train renders from
  open bone meshes. BMPLE states no licence for its images.

## Results on real films

BMPLE test, 69 films, end to end: stage A's centres anchor stage B's crops. Point errors are radial, in millimetres.
Angles are the kit's own measurement from the predicted points against the reader's. Mean over three seeds; the shipped
graphs are seed 0.

| Point | Error |
| --- | --- |
| Hip centre | 1.37 mm |
| Knee centre | 1.17 mm |
| Ankle centre | 1.19 mm |
| Condyles, medial and lateral | 1.76 and 1.77 mm |
| Plateau, medial and lateral | 2.39 and 1.87 mm |

| Value | Error | Legs within 2° (MAD: 2 mm) |
| --- | --- | --- |
| mLDFA | 0.76° | 94 % |
| MPTA | 1.09° | 88 % |
| JLCA | 1.32° | 82 % |
| HKA | 0.36° | 99 % |
| MAD | 1.12 mm | 88 % |

## What is suggested

| Suggested | Not suggested |
| --- | --- |
| Femoral head, knee centre, both condyles, both plateau edges, ankle centre | Greater trochanter, femoral and tibial shafts, plafond |

- The points not suggested have **no check on real films**: BMPLE does not label them. So mLPFA, aLDFA, AMA and LDTA have
  no real-film number, and the panel says these points are not suggested. The reader places them as before.
- **The femoral head.** The kit takes the hip centre as the circle fitted to the head's outline. The model's checked point
  is the hip centre itself; its outline points are unchecked. VEAcom suggests the outline as points on a circle around
  the checked centre, in the directions of the model's outline points and at their median distance, in millimetres. The
  circle the kit fits through them has the checked centre exactly. Its size uses no value; it is the model's estimate of
  the head. Saved, the outline says it was made this way (docs/deformity-labels.md).
- **The plateau.** BMPLE's readers put the plateau points a few millimetres inside the rim, on the joint line; the kit
  asks for the edges. The joint line's angle (MPTA, JLCA) is unaffected, but the plateau's width is short, which moves
  WBL and the joint offset of the subluxation step. While a plateau point stays where the model put it, the panel says so.

## When it runs

The button is off, with the reason on hover, unless:

- the film is greyscale and has a pixel spacing or a calibration (the model works in millimetres; it never assumes one);
- the patient's right is known (Patient Orientation, or the reader's answer), and the film is upright: its rows run
  across the patient and its columns towards the feet, as the model was trained;
- the film fits stage A's canvas, 512 × 1408 mm;
- a landmark the model suggests is still unplaced.

Each run suggests the active plan's leg: the leg on the patient's side of the image. A MONOCHROME1 film is inverted, so
bone is bright as in training. When stage A's hip, knee and ankle are not in that order down the film, the model did not
find the leg (a film of one leg, or not a long-leg film) and nothing is suggested.

The heatmap peak probability (stage B's confidence) is not used to hold points back: on BMPLE test it does not separate
good points from bad. The largest errors, 12 to 20 mm, had peaks of 0.06 to 0.07, as high as most correct points.

## Limits

- The model has seen adults with varus osteoarthritis, without hardware. It cannot tell a child's film, an external
  fixator or an implant from what it knows, and will suggest points on them anyway; the panel says so beside the button.
  Its numbers on synthetic children, fixators and implants are not validation, and no real film of these was labelled.
- Two hospitals' films only: other detectors, stitching and positioning are untested.
- A film flipped left to right gives the same suggestions for the same leg (checked on a mirrored BMPLE film: angles
  within 0.05°).

## Where it runs

On the reader's computer only. The film's pixels go to a Worker in the page, as a copy, and the points come back; the
only request is for the model's two files, the first time.

| | Files from | Kept in | Runtime |
| --- | --- | --- | --- |
| Browser | `models/` on the site itself, which CI fills from the release and checks against the hashes (`web/site/prepare.mjs`); the browser checks each file's integrity as it arrives | Cache Storage | onnxruntime-web 1.31.1, WebAssembly with SIMD, on 4 threads where the page is cross-origin isolated (viewer.veacom.app is), one otherwise |
| Desktop | the release, through GitHub's release download path and file hosts only (as updates are) | `userData/landmark-model`, checked again before use | the same, on one thread |

The files are assets of release v0.1.0-beta.3, next to its installers. The installer scripts and the update check
choose files by their exact names, so these two cannot be taken for an update. GitHub's release downloads send no
cross-origin headers, so the page could not read them from GitHub directly.

**Speed** on an Apple M4 Pro (BMPLE test film 1061, 2396 × 5628 pixels): in Chromium from the site's own headers, 0.22 s
a run, 0.48 s the first time (the Worker and the graphs starting); in the desktop app, 0.54 s, 0.79 s the first time,
plus the download. Most of a run is the two graphs; windowing and cropping take about 0.1 s.

**Port.** On six BMPLE test films the TypeScript port agrees with veacom-train's Python and onnxruntime: stage A to
0.00001 mm, stage B within 0.1 mm.
