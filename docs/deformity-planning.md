# Lower-limb deformity planning

The deformity plan measures the frontal-plane alignment of a leg on a standing long-leg radiograph, runs Paley's
malalignment test, finds the CORA of each bone and simulates an osteotomy that the film measures again as it moves. It is
Phase 0 and Phase 1 of the November 2026 feasibility study: correct calibration and side on every radiograph, and the
manual planning kit. Every point the reader places is also a training label (docs/deformity-labels.md).

Code: `native/src/projection.rs` (calibration, side and orientation in the engine), `src/imaging/radiograph.ts` (their
names in the interface), `src/imaging/deformity/` (the geometry kernel), `src/ui/deformity*.ts` (plans, files, report)
and `src/components/Deformity*.tsx` (panel and drawing). Checks: `tests/radiograph.test.ts`, `tests/deformity.test.ts`,
`tests/deformity-plan.test.ts`, the engine's `projection` tests, and `tools/check-deformity-plan.cjs` on the synthetic films
of `tools/fixtures/make-longleg-study.mjs`.

## Calibration of every radiograph

A projection radiograph (CR, DX, MG, IO, PX, RG, XA, RF, or any image with Imager Pixel Spacing) measures with the spacing
PS3.3 10.7.1.1 and C.8.11.4 give, and the engine says which with each frame:

| Tags | Spacing used | Named |
| --- | --- | --- |
| Pixel Spacing that differs from Imager Pixel Spacing, or a Pixel Spacing Calibration Type of GEOMETRY or FIDUCIAL (other text is kept and claims nothing) | Pixel Spacing | "Calibrated for magnification (GEOMETRY)", "Calibrated on an object (FIDUCIAL)" or "Calibrated, method not stated"; after a length "calibrated" |
| Imager Pixel Spacing alone, with an Estimated Radiographic Magnification Factor of at least 1 | Imager Pixel Spacing ÷ ERMF | "Detector ÷ ERMF 1.10: table depth"; "ERMF ×1.10" |
| Imager Pixel Spacing alone, or equal to Pixel Spacing (with or without an ERMF) | Imager Pixel Spacing | "Detector plane, not corrected"; "detector plane" |
| Pixel Spacing alone | Pixel Spacing | "Pixel Spacing: correction not stated"; "calibration not stated" |
| None | pixels | "Pixels only"; lengths in px |

- Imager Pixel Spacing is at the detector's front plane and is never adjusted for magnification (C.8.11.4): lengths
  measured with it are magnified, about 5% on a standing film (Sabharwal 2006).
- The ERMF is SID/SOD with SOD measured to the table or bucky (C.8.11.5), so it corrects to that depth, not the bone's.
  Where Imager Pixel Spacing is the only spacing it is applied, as the IHE Mammography Image profile asks, and named;
  those films measured in pixels only before. Pixel Spacing equal to Imager Pixel Spacing keeps its own millimetres, as
  before, now named the detector plane: applying the factor there too would change existing numbers, which waits for
  the owner. A factor below 1 or not a number is left out with a note.
- Pixel Spacing alone on a radiograph cannot say whether it was corrected (10.7.1.1): it is used and says so.
- CT, MR, PET and the other cross-sections keep their Pixel Spacing; their labels do not change.

The pane names the film's side and calibration bottom left ("Both sides · Detector plane, not corrected"). The side
comes from the frame's, the image's or the series' laterality, in that order (C.7.3.1). Patient Orientation gives the
edge letters where Image Orientation is absent, following the view's flips and turns. Every length, polyline and ROI area
on a projection film carries its calibration after the number.

### Manual calibration

In the plan, Ball and Ruler calibrate the film on an object on it:

- **Ball**: three or more points on the ball's edge (up to eight), a circle fitted to them (Kåsa, refined on the geometric
  distance), and its diameter: 25.0 mm, 25.4 mm (1 inch), 30.0 mm or typed. The panel gives the diameter in pixels, the
  millimetres per pixel, the magnification against Imager Pixel Spacing where the film has it, and how far the points lie
  off the circle. The reader confirms the ball lay at the bones' depth; until then the calibration says it is not
  confirmed. Ball depth dominates the error (5 cm in front or behind shifted a 900 mm length by about 15 mm, Ahrend 2022).
- **Ruler**: two marks and the length between them. A ruler is assumed at the bones' depth like the ball: one lying on
  the detector needs its own factor, which the kit does not supply.

Calibrate sets the film's measurement scale, so every measurement on that film uses it and names it ("ball 25.0 mm").
It holds for that film only (series and frame): the object stands at that film's magnification, so the series' other
films, such as a repeat or a lateral, keep their own spacing and name it. On its film it outranks the Units panel's
known-length scale, which is the series'. It is announced like any calibration, and the inspector's pixel spacing
names it for the film shown. The plan's Remove takes it away; the Units panel's Remove takes away only the series'
scale. Like the Units panel's, it is not an Undo step: ⌘Z takes back the marker's points, never the calibration. A
known-length calibration made later sets the whole series' scale, replaces the films' ball and ruler calibrations, and
is named as a scale set by hand. A plan saved on a ball or ruler calibration calibrates the film again when it is
opened.

## Opening the plan

The assessment button opens the plan on a DX or CR whose Body Part Examined names the leg (LEG, LOWER LIMB, LOWEXM,
LOWER EXTREMITY), or whose image is at least twice as tall as it is wide, in the place it opens the pre-op checklist on a
CT. No toolbar button or mode is added. A film without a leg body part opens with a caution to check both hips and both
ankles are in the field, never a block (study step S0).

## The plan

A film gets a plan for each leg it shows (one when its laterality names one side); + adds another plan of the same leg,
to compare corrections. Each plan holds one leg's landmarks and an osteotomy.

### Landmarks

| Landmark | Points | Used for |
| --- | --- | --- |
| Femoral head | 3 to 12 on its outline; the hip centre is the fitted circle's centre | mechanical axes, mLPFA, MAD |
| Greater trochanter | its tip | mLPFA |
| Femoral shaft, upper and lower | the middle between the cortices | femoral anatomic axis, aLDFA, AMA |
| Knee centre | the top of the intercondylar notch | mechanical axes, MAD |
| Medial and lateral condyle | their most distal points | distal femoral joint line |
| Medial and lateral plateau | their edges on the joint line | proximal tibial joint line |
| Tibial shaft, upper and lower | the middle between the cortices | tibial anatomic axis |
| Plafond, medial and lateral | its edges on the joint line | distal tibial joint line |
| Ankle centre | the middle of the talar dome | mechanical axes, MAD |

Place points asks for them in this order; a click on the film places the one asked for and moves on. Every point is then a
handle to drag. A row's button places that landmark again, or adds a point to the head's outline. Esc stops. A medial
and lateral pair placed the wrong way round is a warning; the values use the film's side, so they do not turn into their
supplements.

### Side

Medial and lateral come from the leg's side and the film's Patient Orientation. A film without it asks where the
patient's right is (image left or right) before any medial or lateral value; the usual AP convention is never assumed.
The reader answers from the film's R/L marker as the pane shows it, so the answer goes through the pane's turn and
left-right flip to the side of the stored image; while the pane is turned near a quarter it cannot be given.

### Values

All values are computed in the film's plane in millimetres (pixels need not be square), or in pixels without a
calibration, when angles assume square pixels and say so.

| Value | Definition | Normal (flagged range) |
| --- | --- | --- |
| mLPFA | at the hip centre, between the femoral mechanical axis and the line to the trochanter's tip | 90° (85–95), POSNA 2020 |
| mLDFA | lateral, between the femoral mechanical axis and the condyle line | 88° (85–90), POSNA; 87 ± 3° Marques Luís; 88 ± 3° Da Cunha |
| aLDFA | lateral, between the femoral anatomic axis and the condyle line | 81° (79–83), POSNA |
| MPTA | medial, between the tibial mechanical axis and the plateau line | 87° (85–90), POSNA |
| LDTA | lateral, between the tibial mechanical axis and the plafond line | 89° (86–92), POSNA |
| JLCA | between the condyle and plateau lines, positive converging medially | 0 ± 2°, POSNA |
| AMA | between the femoral anatomic and mechanical axes | 6 ± 1°, Marques Luís; 7° Fisher |
| HKA | between the femoral and tibial mechanical axes, varus positive | within 3° (Bellemans 2012); Moreland 1987 mean 1.5° R, 1.1° L varus |
| MAD | the knee centre's distance from the hip–ankle line, medial positive | 8 ± 7 mm medial (Paley); 4 ± 2 Marques Luís |
| WBL on plateau | where the hip–ankle line crosses the plateau, % from medial (needs no calibration) | |
| Femur, tibia, limb length | hip to knee, knee to ankle, hip to ankle | |

A value outside its range is written in the caution colour with the word "high" or "low". A value that cannot be given
says what it needs: the landmarks, the patient's right, or a calibration. The normal values are data
(`src/imaging/deformity/normals.ts`), with their sources on the row's tooltip.

### Malalignment test and CORA

Paley's test, as a checklist: the MAD says whether the limb is malaligned (outside 1–15 mm medial: varus or valgus; it
needs a calibration), then mLDFA for the femur, MPTA for the tibia, JLCA beyond 2° for the joint, and the femoral and
tibial joint midpoints more than 3 mm apart across the leg for subluxation. "Not assessable" is an answer, with what it
needs.

The CORA of each bone: the proximal axis drawn from the proximal joint at its normal angle (mLPFA 90° at the hip, MPTA
87° at the knee), the distal axis from the distal joint at its normal angle (mLDFA 88°, LDTA 89°), both mechanical.
They cross at the CORA; the angle between them is the deformity, drawn with the bisector. The panel gives its distance
below the joint, or says it lies outside the bone (a multiapical deformity or one at the joint). Under 1.5° it is within
the joints' normal variation and is not drawn.

### Osteotomy

Place the cut takes two clicks: the cortex that opens (or closes), then the hinge's. The hinge starts at the second
click and can be dragged. The fragment is a polygon around the leg below the cut (the cut carried 40% further each side,
25 mm at least, down to 60 mm past the ankle), never a half-plane, so a film of both legs moves one leg only; its
corners can be dragged. Then:

- Opening or closing wedge, the angle and its direction (valgus turns the distal end laterally). Which wedge a cut
  makes follows from the hinge's side and the direction: the first cortex moving away from the proximal fragment opens
  the cut, moving into it closes it. The panel says so when that differs from the wedge chosen, and the report and the
  drawing give the wedge the geometry makes.
- Solve for MAD 0, or for the weight-bearing line at 62.5% of the plateau (Fujisawa), between 45° of varus and valgus,
  on the leg measured again: a femoral cut moves the knee and the plateau too.
- Shift lateral and distal, and lengthen along the bone, in mm.
- The wedge height at the opening (or closing) cortex, 2 w sin(θ/2) with w the distance from the hinge to that cortex
  (Rolim 2016), and the limb's change in length.
- Paley's rule: 1 with the cut through the CORA and the hinge on its bisector; 2 with the hinge on the bisector away
  from the CORA; 3 with the hinge off it, and the translation it leaves, 2 d tan(θ/2) (Barksfield 2015).

Every landmark beyond the cut's line, distally along the bone, moves with the fragment and the leg is measured again at
once (the outline says only which pixels are drawn moved); the panel lists now and planned
side by side. The pane shows the fragment moved and the place it left dimmed, and says "Simulated". The fragment is the
film itself, drawn by the pane's renderer with the fragment's turn and shift as its view and cut to its outline: no
pixel is changed or copied into a new image, and the fragment can move past the film's edge. Show simulation turns this
off to edit the landmarks it moved.

### Undo, plans and saving

Every change is a step of the viewer's Undo (⌘Z, Ctrl+Z), with the measurements; a drag is one step. Plans stay in
memory while VEAcom is open. Nothing is written to disk unless the reader asks:

- **Save** writes the film's plans as a versioned JSON file (docs/deformity-labels.md) through the system's save dialog,
  or a download in the browser. **Open** reads one back onto the same film, through the page's file input: the reader
  picks the file in the system's dialog and the page receives its contents, never a path. A file for another film, from
  another version, or with a point or value out of range is refused and says why (docs/deformity-labels.md).
- **Report** saves the plan as one A4 picture (PNG): the pane as measured and as simulated, every value with its normal
  range, the calibration and the side, the malalignment test, the CORA and the osteotomy, the patient unless the reader
  hides patient data, and that the correction is simulated.

Autosave waits for the approvals the CLOSE checklist records (docs/close-calipers.md, PR #31): the hospital's ethics
committee, its KVKK legal basis and its data protection officer. The plan file has the shape that opt-in would store.
No plan, landmark or value goes to the usage timings: they record only which control was used.

## Platforms

The kit is page code and runs the same in the desktop app and the browser build; the calibration rules run in the
engine, native or WebAssembly. Drawing uses the shared WebGL2 renderer, so it draws where the viewer draws, including
software rendering (llvmpipe on Linux CI, WARP on Windows): the fragment is one more draw of the film per frame.

A film taller or wider than the GPU's 2D texture limit (16,384 pixels on most GPUs, WARP and llvmpipe; 8,192 on
SwiftShader) is drawn in tiles, never downsampled: each tile's texture holds at most the limit, with 64 pixels more
around the part it draws for sampling that reads beyond a pixel, and the tiles give exactly the pixels one texture
would (`tests/source-renderer.browser.mjs`). Before, such a film failed to draw with the limit named.

## Not done yet

- DICOM SR (TID 1500) for the plan, GSPS, Secondary Capture and an Encapsulated PDF report: the plan is a JSON file and
  the report a PNG for now.
- Opt-in autosave, after the approvals above.
- A keyboard way to place and nudge points: they are placed and moved with the mouse, pen or touch only.
- Snapping points to bone edges, automatic ball detection, stitched films, implant templates, double-level and dome
  osteotomies, sagittal analysis and printing the report through the system print dialog (PR #31's path).
