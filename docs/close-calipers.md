# CLOSE calipers

The sinus CT's pre-operative checklist (CLOSE) has a caliper for the four items that are geometry of a millimetre or
more: olfactory fossa depth, the anterior ethmoidal artery's distance below the skull base, sphenoid pneumatisation and
septal deviation. The reader starts one from the checklist, for an item and a side, and clicks its landmarks on the
image. The caliper draws its measurement, writes the answer its classification gives (the artery's caliper only
measures), and records the value, the points and the slice under that side. Whether a thin wall is intact (lamina papyracea, optic and carotid canals, a
dehiscent artery) stays the reader's call: those walls are mostly below what CT resolves.

Code: `src/imaging/calipers.ts`. Check: `tools/check-close-calipers.cjs` on the synthetic sinus CT of
`tools/fixtures/make-sinus-study.mjs`.

## The calipers

| Item | Plane | Points | Value | Answer |
| --- | --- | --- | --- | --- |
| Olfactory fossa depth (Keros) | coronal | the olfactory fossa's floor (cribriform plate), the ethmoid roof at the top of the lateral lamella (fovea ethmoidalis) | depth: the height between them, straight up | Keros type 1–3 |
| Floating (mesenteric) anterior ethmoid artery | coronal | middle of the artery's canal, ethmoid roof above it | vertical distance below the roof, El-Anwar type | none: the reader answers |
| Sphenoid pneumatisation | sagittal | tuberculum sellae, top of the dorsum sellae, sinus wall furthest back | the wall's place against the two sella lines | sellar or postsellar; none in front of the tuberculum line |
| Septal deviation / spur | coronal | maxillary crest, crista galli, most deviated point | angle at the crista galli, and the side it bows to | Yes on that side |

- **Keros** (Keros 1962): type 1 is 1–3 mm, 2 is 4–7 mm, 3 is 8–16 mm, read in whole millimetres as Keros measured. A
  depth within 0.5 mm of the 3–4 or 7–8 mm gaps is marked "near limit": a measurement error of about 0.5 mm (Reuter
  2026) or the other usual cut (below 4, 4–8, above 8 mm) could change its type. When both sides are measured, the
  report gives their difference. Two points are enough: the depth is a height. It is defined at the lamella, from its
  foot on the cribriform plate to its top at the fovea ethmoidalis; on a sloping plate, a floor marked further medially
  can read a few tenths of a millimetre differently. The Gera angle (the lamella against the plate) is not measured: it
  is rarely used, and the third point it needed made the order of the clicks unclear.
- **Anterior ethmoidal artery** (El-Anwar et al., J Neurol Surg B Skull Base 2021;82(S3):e259–e267): the artery's
  middle to the ethmoid roof on coronal CT; type 1 is 0–2 mm, 2 is 2–4 mm, 3 is 4–6 mm, 4 above 6 mm. The caliper
  gives the distance and the type and marks no answer: whether the artery is floating, in a mesentery below the skull
  base, is the reader's call on the image, made after finding it. Within 0.5 mm of the 2 mm limit it says "near limit".
- **Sphenoid pneumatisation** (Güldner et al., Acta Radiol 2012;53:214–219): lines through the tuberculum and the
  dorsum, square to the line joining them. Between them the sinus is sellar, behind the dorsum line postsellar. In
  front of the tuberculum line it is presellar or conchal, which the sinus's size decides, so the reader answers.
- **Septal angle**: mild below 9°, moderate 9–15°, severe above 15°. This is a common grading, not a standard one.
  Below 1° the septum is read as on the midline and no side is marked.

The points may be clicked in any order: each landmark is known by its height on the plane. Keros's lower point is the
fossa's floor; the artery lies below the roof; the sinus wall lies below the sella, under the tuberculum and the
dorsum (which the caliper tells apart from front to back); the maxillary crest is the septum's lowest point, the crista
galli its highest (the angle's corner), and the deviated point lies between them. Two points at one height say
"Unavailable".

Every value needs the image's pixel spacing (or a calibration), and the plane the caliper is read on: within 45° of
coronal or sagittal, upright. A drawing made on another plane says "Unavailable" with the reason.

## Setting the pane up

Starting a caliper sets up the pane it measures in. Another pane of the same series already on the caliper's plane
becomes the active one, so the three-plane MPR keeps its planes. Otherwise the active pane turns to the plain plane
through the point picked in that series, or through the middle of the plane it showed; a pane already on the plane,
tilted or not, keeps its slice. Its window becomes the bone preset, unless it is already at least as wide and as high.
The pane says what changed, with Undo, until the first point is placed. Undo puts the pane back and ends the caliper.
Finding the slice of the structure itself (the per-item jump of the CLOSE plan) needs segmentation and is not done
here. The checklist's button is unavailable, and says why, only when there is no CT in the active pane, the CT is a
scout (Image Type value 3 LOCALIZER, PS3.3 C.8.2.1.1.1: a projection, so no caliper measures on it), its pixel
spacing is unknown, it is still loading, or the series cannot be shown on the caliper's plane. A measurement drawn on
a scout or on another modality of the study (an MR) while a caliper waits stays a plain measurement, and such a pane's
hint says why.

Show, in the bar under the checklist, sets the pane up the same way for any sinus item, on the plane it is read on:
coronal for Keros, the lamina papyracea, the ethmoid artery, the septum, a concha bullosa and a Haller cell; coronal,
then sagittal for an Onodi cell; coronal, then axial for the optic nerve; axial, then coronal for the carotid artery
and the intersinus septum; sagittal for the sphenoid pneumatisation, through the middle of the pane, near the midline.
Its label names the plane it turns to next, so pressing it again shows an item's other plane. It goes to the slice
noted for the item on that plane (the side the keys are on first), else to the slice the item was last looked at there
(answered there, or left there for its other plane; kept per study while VEAcom is open), else as a caliper sets up.
A pane already at that place keeps it. The pane says what changed, with Undo; a caliper under way ends.

## Snapping onto bone

A point marked for bone moves, within its plane, to the nearest place within 2 mm whose interpolated value is 200 HU
or more, to 0.1 mm. Thin skull-base plates read well below cortical bone through partial volume, so the bound is low.
A point already on bone stays; so does one with no bone that near, and every point of a series not in HU (the hint
says so). The artery's canal and the septum's deviated point never move: one is soft tissue, the other may be
cartilage. Moving a point by hand afterwards does not snap.

## The checklist record

Each item takes one line of the checklist: its name and its answers. The bar under the list shows the row last clicked
or reached by the keys: what to look for, Show, and for each side its note or measurement, a button that notes the
slice on screen and, for the four items above, a caliper button. Notes are kept per item and side; a side holds one
note, whichever came last. A side answered Yes, with the active pane on one of the item's planes and nothing noted on
that side yet, notes the slice on screen by itself; its tooltip says so, and the note goes again when the answer is no
longer Yes. Keros and the pneumatisation, answered by type, note where they are measured instead. A caliper's note holds its points (patient
millimetres), the plane they were read on, its reading and the answer it gave. Moving a point of its drawing measures
again, and so does a change of the series' calibration; the answer follows until the reader picks another one. Deleting
the drawing leaves the record, and a calibration still measures it again from its points. "Copy for the report" gives
each side its answer, measurement and slice. It leaves out a row with nothing answered or measured on any side (a slice
noted alone included), so the checklist says how many rows that is above the item names, and pressing the count goes
to the first of them. A row answered on one side is copied, with "–" for the other.

Clear, and a slice note that replaces a side's measurement, say what they took away under the checklist, with Undo.
Undo puts it back while the checklist is still as that change left it; any later change ends the offer, so it never
overwrites newer work. The caliper drawings stay on the image either way. ⌘Z (Ctrl+Z) while focus is in the checklist
does the same, instead of undoing the last measurement on the image. Undo brings the caliper records back, so their
drawings feed them again, and a drawing moved while its record was gone measures again.

The checklist answers from the keyboard too, while focus is in it and no caliper waits for its points: ↑ and ↓ move
between rows, ← and → between the Right and Left columns as shown, and Alt (⌥ on a Mac) with a digit gives the row's
answer at that place (1 Yes, 2 No, 3 ?; Keros 1 to 3; pneumatisation 1 to 5), then moves on to the left side or the
next row. Alt+Shift with a digit gives both sides the same answer and goes to the next row. Answers are digits by place
so they mean the same in English and Turkish (Y would be yes in one and "Yok", no, in the other), and they take Alt
because a plain digit is a window preset on the image (the owner's choice, 10 November 2026): no key has two meanings.
AltGr, which Windows reports as Ctrl+Alt, answers nothing, and neither do the keypad's digits, which with Alt type
characters by their codes on Windows. Being chords, the answers stay on when single-key shortcuts are turned off. Each
answer's tooltip shows its keys, and Help lists them. Enter on a row shows its item (Show); on a button it presses the
button.

## The theatre card

"Theatre card" in the checklist prints it on one A4 page to take into theatre: the patient as the image corner gives
it (left out when the reader hides patient data), the series and when it was printed, then every item with its right
and left side: the answer, what a caliper measured, the plane and slice it was seen on, and how many sides are not
marked. It goes through the system print dialog, which asks first and offers a printer or a PDF; VEAcom writes no file
itself, so it does not save the checklist this way (the next section).

## Saving the answers (not written)

The checklist lives in memory while the viewer is open. Nothing is written to disk until the hospital's ethics
committee, its KVKK legal basis and its data protection officer approve it. The design for that opt-in:

- Off by default, switched on per installation, with the approval reference shown beside the switch.
- One JSON file per study in the user's data folder, mode 0600, named by an HMAC-SHA-256 of the Study Instance UID
  under a key kept only on that computer: the file name does not give the UID, and the same study finds its file again.
- Contents: `{ "version": 1, "study": "<hmac>", "kind": "pns", "items": { "<item>": { "<side>": { "answer", "slice",
  "plane", "oblique", "caliper": { "kind", "points", "reading", "given" } } } }, "suggestionShown": false }`. No name,
  patient ID, birth date, accession number or institution. `suggestionShown` is for the later AI suggestions: whether
  one was on screen when the answer was given.
- A control that forgets one study or every study. Exporting records for research goes through anonymisation first
  (DICOM PS3.15 Basic Profile), outside this file.
