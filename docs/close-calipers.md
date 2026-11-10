# CLOSE calipers

The sinus CT's pre-operative checklist (CLOSE) has a caliper for the four items that are geometry of a millimetre or
more: olfactory fossa depth, the anterior ethmoidal artery's distance below the skull base, sphenoid pneumatisation and
septal deviation. The reader starts one from the checklist, for an item and a side, and clicks its landmarks on the
image. The caliper draws its measurement, writes the answer its classification gives, and records the value, the
points and the slice under that side. Whether a thin wall is intact (lamina papyracea, optic and carotid canals, a
dehiscent artery) stays the reader's call: those walls are mostly below what CT resolves.

Code: `src/imaging/calipers.ts`. Check: `tools/check-close-calipers.cjs` on the synthetic sinus CT of
`tools/fixtures/make-sinus-study.mjs`.

## The calipers

| Item | Plane | Points | Value | Answer |
| --- | --- | --- | --- | --- |
| Cribriform plate (Keros) | coronal | cribriform plate beside the crista galli, foot of the lateral lamella, its top at the fovea ethmoidalis | depth: the lamella's height, straight up; Gera angle: the lamella against the plate carried on past its foot | Keros type 1–3 |
| Anterior ethmoid artery | coronal | middle of the artery's canal, ethmoid roof above it | vertical distance below the roof | Yes from 2 mm; none below |
| Sphenoid pneumatisation | sagittal | tuberculum sellae, top of the dorsum sellae, sinus wall furthest back | the wall's place against the two sella lines | sellar or postsellar; none in front of the tuberculum line |
| Septal deviation / spur | coronal | maxillary crest, crista galli, most deviated point | angle at the crista galli, and the side it bows to | Yes on that side |

- **Keros** (Keros 1962): type 1 is 1–3 mm, 2 is 4–7 mm, 3 is 8–16 mm, read in whole millimetres as Keros measured. A
  depth within 0.5 mm of the 3–4 or 7–8 mm gaps is marked "near limit": a measurement error of about 0.5 mm (Reuter
  2026) or the other usual cut (below 4, 4–8, above 8 mm) could change its type. When both sides are measured, the
  report gives their difference.
- **Gera** (Gera et al., Rhinology 2018;56:65–72): class I above 80°, II 45–80°, III below 45°. The plate is read from
  the reader's own first two points, so a tilted head does not change the angle.
- **Anterior ethmoidal artery** (El-Anwar et al., J Neurol Surg B Skull Base 2021;82(S3):e259–e267): the artery's
  middle to the ethmoid roof on coronal CT; type 1 is 0–2 mm, 2 is 2–4 mm, 3 is 4–6 mm, 4 above 6 mm. Types 2 to 4
  answer yes (below the skull base). Type 1 gives no answer: the item's yes also covers a dehiscent artery, which the
  caliper cannot see.
- **Sphenoid pneumatisation** (Güldner et al., Acta Radiol 2012;53:214–219): lines through the tuberculum and the
  dorsum, square to the line joining them. Between them the sinus is sellar, behind the dorsum line postsellar. In
  front of the tuberculum line it is presellar or conchal, which the sinus's size decides, so the reader answers.
- **Septal angle**: mild below 9°, moderate 9–15°, severe above 15°. This is a common grading, not a standard one.
  Below 1° the septum is read as on the midline and no side is marked. The crista galli must lie above the crest:
  clicked the other way round, the angle's corner would move to the crest and the angle would grow, so the caliper
  says "Unavailable" instead.

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
a scout while a caliper waits stays a plain measurement.

## Snapping onto bone

A point marked for bone moves, within its plane, to the nearest place within 2 mm whose interpolated value is 200 HU
or more, to 0.1 mm. Thin skull-base plates read well below cortical bone through partial volume, so the bound is low.
A point already on bone stays; so does one with no bone that near, and every point of a series not in HU (the hint
says so). The artery's canal and the septum's deviated point never move: one is soft tissue, the other may be
cartilage. Moving a point by hand afterwards does not snap.

## The checklist record

Notes are kept per item and side. Every side has a button that notes the slice on screen, and the four items above
also have a caliper button; a side holds one note, whichever came last. A caliper's note holds its points (patient
millimetres), its reading and the answer it gave. Moving a point of its drawing measures again, and so does a change of
the series' calibration; the answer follows until the reader picks another one. Deleting
the drawing leaves the record. "Copy for the report" gives each side its answer, measurement and slice. It leaves out a
row with nothing answered or measured on any side (a slice noted alone included), so the checklist says how many rows
that is at the end of its help line, above Copy, and pressing the count goes to the first of them. A row answered on
one side is copied, with "–" for the other.

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
answer's tooltip shows its keys, and Help lists them.

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
