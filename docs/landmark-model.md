# Landmark model

Suggest landmarks, in the deformity plan (docs/deformity-planning.md), runs a landmark model on the film and suggests
all 14 of the kit's landmarks. Eleven were checked on real films; the other three were not, and the kit says so
wherever they or the values measured from them appear. It is off until the reader presses the button, and the
reader confirms every point: a suggestion is drawn apart from the landmarks and nothing is measured from it until the
reader accepts or moves it. The model was trained and checked in veacom-train (`docs/synthetic.md` §7 and §8, `docs/round4-status.md`); this page
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
  parameters). VEAcom runs the seven crops of the plan's leg: the hip (centred 22 mm lateral of its centre), the knee,
  the ankle, and two on each shaft, 30 % and 75 % of the way from hip to knee and 25 % and 80 % from knee to ankle. A
  shaft point is the middle between the cortices on its crop's centre row: where it lies along the bone is that
  definition, not something the model finds (veacom-train `stageb.py`).
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

The shaft points were checked in veacom-train's round 4 (`docs/round4-status.md`), on the same 69 films, with the
shipped graphs (seed 0). A shaft point's error is across the shaft, at the point's own level, with stage B run as
VEAcom runs it, except against F, where the crop is centred at F's row.

| Shaft point | Checked against | Error across the shaft |
| --- | --- | --- |
| Femoral shaft, lower | the reader's point (BMPLE's F), the crop at F's row | 0.45 mm; 0.26 mm against the shaft midline, run as VEAcom runs it |
| Femoral shaft, upper | an edge-traced shaft midline: the middle between the cortices, traced on each film | 0.56 mm |
| Tibial shaft, upper and lower | an edge-traced shaft midline | 0.35 and 0.39 mm |

- **The femoral midline** passes within the reader's own spread of F on 134 of 138 legs; the upper femoral level has no
  reader point. **The tibial midline** has no reader point at all: it is checked only for consistency (it passes 1.3 mm
  from the reader's ankle centre).
- **Their axes and values:** the femoral anatomic axis is 0.17° off the midline's, the tibial 0.16°. End to end, aLDFA is
  0.84° off (sd 1.42) and AMA 0.27°.
- **Where along the shaft.** BMPLE's reader put F 76 to 87 % of the way from hip to knee (mean 83 %, over the reader's
  hip, knee and shaft points of the 138 test legs). VEAcom reads the point at 75 %, where veacom-train's own inference
  (`stageb.infer_film`) puts the crop and where the synthetic films label it, on the same shaft.

| Value | Error | Legs within 2° (MAD: 2 mm) |
| --- | --- | --- |
| mLDFA | 0.76° | 94 % |
| MPTA | 1.09° | 88 % |
| JLCA | 1.32° | 82 % |
| HKA | 0.36° | 99 % |
| MAD | 1.12 mm | 88 % |

## What is suggested

All 14 landmarks.

| Checked on real films (BMPLE test) | Unchecked |
| --- | --- |
| Femoral head, knee centre, both condyles, both plateau edges and ankle centre (the reader's points); femoral shaft lower (the reader's point) and upper, tibial shaft upper and lower (edge-traced midlines) | Greater trochanter, plafond medial and lateral |

- **Unchecked** points have no check on real films (`suggest.ts` `UNCHECKED`). BMPLE does not label them, and round 4
  found no reference on its films reliable enough to check them:
  - **Trochanter.** An edge-traced tip was found on only 43 % of legs. Against it, indicatively, the model's tip is about
    4.7 mm off, and mLPFA reads 2.8° low.
  - **Plafond.** Against a traced plafond line, the medial and lateral points are 2.85 and 4.25 mm off, LDTA 2.45° (sd
    3.8). The model sits about 1 mm above the traced line, possibly a difference of convention.
  - So mLPFA, LDTA and the CORA of each bone have no real-film number.
- **How the kit says so.** An unchecked suggestion is a dashed diamond, not a ring. Its row says "suggested ·
  unchecked", and one line under the button says what each shaft point was checked against and that the trochanter and
  plafond are unchecked. Accepted as it was, the row still says "unchecked", and every value, malalignment step and CORA
  measured from it says "from an unchecked point" beside it, in the panel and in the report, and "unchecked point" in
  its label on the image (the Paley rule says so in the panel), until the reader moves that point or places it again. A
  file from another model may mark any landmark unchecked; the same rule then marks whatever is measured from it.
- **Saved,** the label's `confidence` names the model and says `unchecked` (docs/deformity-labels.md), so these labels
  are never mistaken for checked ones when the files are used for training.
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

- the film is greyscale (MONOCHROME1 or MONOCHROME2) and has a pixel spacing or a calibration (the model works in
  millimetres; it never assumes one);
- the patient's right is known (Patient Orientation, or the reader's answer), and the film is upright: its rows run
  across the patient and its columns towards the feet, as the model was trained;
- the film fits stage A's canvas, 512 × 1408 mm (a standard 14 × 51 inch long-leg film does);
- a landmark the model suggests is still unplaced.

Each run suggests the active plan's leg: the leg on the patient's side of the image. A MONOCHROME1 film is inverted, so
bone is bright as in training (checked: an inverted MONOCHROME1 copy of a BMPLE film gives the same values). Nothing is
suggested when the model did not find two legs: the leg's hip, knee and ankle must come down the film in that order, and
the image's left leg must lie left of its right leg, their hips more than 50 mm apart (two femoral heads lie a pelvis
apart; closer, the model put both legs' points on one leg). A BMPLE film with one leg blanked out gave no suggestions;
real films of one leg are not checked. A point that falls off the film is not suggested. While the osteotomy's simulation shows,
suggestions are not drawn and cannot be accepted, and they never appear in pictures, reports or videos.

Nothing is suggested, either, when stage A is not sure of the leg. For each of the leg's hip, knee and ankle, its peak is
the largest value of the softmax over that heatmap; under 0.02 for any of the three, the panel says the model is not
sure and suggests nothing (a message of its own, apart from the legs not found). Stage A's least peak per leg, at each
film's stated spacing; on the films marked CI, the desktop check asserts which side of 0.02 it falls and records it:

| Film | Least peak |
| --- | --- |
| BMPLE's test films | 0.041 and above |
| [Mendeley Data's High Tibial Osteotomy](https://doi.org/10.17632/bpvj6xczm2.3) film 49_0, both legs hip to ankle (CI) | 0.050 and 0.053 |
| Film 10_0 of the same set, which stops mid-tibia (CI) | 0.004 and 0.006, the ankles |
| The synthetic long-leg drawing: its variants, measured in Node; CI checks the left leg of one | 0.007 to 0.016 |

The two Mendeley films are real standing long-leg films from another hospital (ORTOTOP, Poland) that the model never
saw. CI fetches them from Mendeley Data with their SHA-256 pinned (`tools/fixtures/fetch-mendeley-films.mjs`) and keeps
them only in its cache between runs: they are not in the repository, a release or CI's evidence. Their stated spacing
comes from the ruler on each film.

Stage B's heatmap peak probability (its confidence) is not used to hold single points back: on BMPLE test it does not
separate good points from bad. The largest errors, 12 to 20 mm, had peaks of 0.06 to 0.07, as high as most correct
points.

## Limits

- The model has seen adults with varus osteoarthritis, without hardware. It cannot tell a child's film, an external
  fixator or an implant from what it knows, and will suggest points on them anyway; the panel says so beside the button.
  Its numbers on synthetic children, fixators and implants are not validation, and no real film of these
  was labelled.
- Two hospitals' films only: other detectors, stitching and positioning are untested.
- A film flipped left to right gives the same suggestions for the same leg (checked on a mirrored BMPLE film: angles
  within 0.05°).

## Where it runs

On the reader's computer only. The film's pixels go to a Worker in the page, as a copy, and the points come back; the
only request is for the model's two files, the first time.

| | Files from | Kept in | Runtime |
| --- | --- | --- | --- |
| Browser | `models/` on the site itself, which CI fills from the release and checks against the hashes (`web/site/prepare.mjs`); the page checks each file's hash before keeping it | Cache Storage | onnxruntime-web 1.31.1, WebAssembly with SIMD, on 4 threads where the page is cross-origin isolated (viewer.veacom.app is), one otherwise |
| Desktop | the release, through GitHub's release download path and file hosts only (as updates are) | `userData/landmark-model`, checked again before use | the same, on one thread |

The files are assets of release v0.1.0-beta.3, next to its installers. The installer scripts and the update check
choose files by their exact names, so these two cannot be taken for an update. GitHub's release downloads send no
cross-origin headers, so the page could not read them from GitHub directly.

**Speed** on an Apple M4 Pro (BMPLE test film 1061, 2396 × 5628 pixels), all seven crops: in headless Chromium, from a
local server with the site's headers, 0.54 s a run on 4 threads and 0.92 s the first time (the Worker and the graphs
starting); in the desktop app, on one thread, 1.4 s and 1.8 s the first time. On one thread each crop takes about 0.12 s
in onnxruntime-web's WebAssembly, run one at a time or together, so the four shaft crops add about 0.5 s there. The
first press also downloads the model's 18 MB (and, in the browser, the 14.8 MB runtime, which the progress does not
count). Most of a run is the two graphs; windowing and cropping take about 0.2 s. Safari and Firefox are not checked
yet.

**Port.** On six BMPLE test films the TypeScript port agrees with veacom-train's Python and onnxruntime: stage A to
0.00001 mm, stage B within 0.1 mm on all seven crops, the four shaft points within 0.02 mm.
