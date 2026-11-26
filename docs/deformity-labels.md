# Deformity plan files and landmark labels

A deformity plan saved by the reader (docs/deformity-planning.md) is one JSON file per film. The same file is the label
set a landmark model can later learn from: every landmark the reader placed, in the film's own pixels, with its name,
how far it can be trusted, the calibration it was measured with, the side and the software that made it. Code:
`src/ui/deformityFile.ts`; tests: `tests/deformity-plan.test.ts`.

The file is written only when the reader saves it: through the save dialog, or with Save and next while labelling a
folder, beside its film as `<film's file name>.veacom-plan.json` (docs/deformity-planning.md, "Labelling a folder"). VEAcom has no path that uploads it and keeps it apart from the usage
timings, which never carry a plan, a landmark or a value. Gathering files for training is the institution's work, under
its own approvals, after anonymisation (feasibility study, section 6.9).

## Coordinates

Points are image pixels in DICOM's image-relative coordinates, as SR spatial coordinates use them (PS3.3 C.18.6.1.1): x to
the right along a row, y down along a column, (0, 0) at the top left corner of the top left pixel, so the centre of the
pixel in column c and row r is (c + 0.5, r + 0.5). They are the stored pixel grid, whatever the view's zoom, turn or
flip, and they do not change when the calibration does.

## The file

```json
{
  "schema": "veacom.deformity-plan",
  "version": 1,
  "software": { "name": "VEAcom", "version": "0.1.0-beta.3", "kernel": 1 },
  "savedAt": "2026-11-14T15:20:00.000Z",
  "coordinates": "dicom-image-relative",
  "film": { "sopInstanceSha256": "…64 hex…", "frame": 1, "columns": 1300, "rows": 3500, "modality": "DX",
            "patientOrientation": ["L", "F"], "laterality": "B" },
  "calibration": { "state": "detector", "mmPerPixel": [0.33, 0.33], "imagerPixelSpacing": [0.33, 0.33], "marker": null },
  "active": 0,
  "plans": [
    { "name": "", "side": "R",
      "landmarks": [
        { "name": "kneeCentre", "points": [[443.9, 1880.2]], "confidence": "manual", "provenance": ["placed"],
          "spacing": "detector", "side": "R", "software": "0.1.0-beta.3", "suggestionShown": false },
        { "name": "ankleCentre", "points": [[461.2, 3390.4]],
          "confidence": { "model": "veacom-landmarks-r2", "sha256": { "stageA": "51e9…1099", "stageB": "c0ad…cfdd" } },
          "provenance": ["accepted"], "spacing": "detector", "side": "R", "software": "0.1.0-beta.3", "suggestionShown": true },
        { "name": "plafondMedial", "points": [[478.6, 3376.0]],
          "confidence": { "model": "veacom-landmarks-r2", "sha256": { "stageA": "51e9…1099", "stageB": "c0ad…cfdd" }, "unchecked": true },
          "provenance": ["moved"], "spacing": "detector", "side": "R", "software": "0.1.0-beta.3", "suggestionShown": true },
        { "name": "hipCentre", "points": [[307.0, 416.7]], "confidence": "manual", "provenance": ["derived"],
          "spacing": "detector", "side": "R", "software": "0.1.0-beta.3", "suggestionShown": false,
          "derivedFrom": "femoralHeadContour" }
      ],
      "osteotomy": null,
      "values": { "MPTA": { "value": 80.89, "unit": "°" } } }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `schema`, `version` | Always `veacom.deformity-plan` and 1. A later change that alters what a field means raises the version; VEAcom opens only the versions it knows. |
| `software.version`, `software.kernel` | The VEAcom that saved the file, and the version of its geometry kernel (`KERNEL_VERSION`), raised when a value's definition changes. |
| `film.sopInstanceSha256` | SHA-256 of the film's SOP Instance UID, in hex: it finds the film again without naming it. The same film gives the same hash on every computer, so files of one film can be linked; anonymisation for research replaces it. |
| `film.frame` | The frame number in a multi-frame file, 1 otherwise. |
| `film.columns`, `film.rows` | The pixel grid the points are on. |
| `film.patientOrientation`, `film.laterality`, `film.patientRight` | What set medial and lateral: the file's Patient Orientation and laterality, or the reader's answer where the patient's right is, as the side of the stored image (`left` for −x, `right` for +x) after the pane's turn and flip. |
| `calibration.state` | The source of spacing, including `calibrated`, `magnification`, `detector`, `scanned`, `unstated`, `manual` or `pixels` (`src/imaging/radiograph.ts`). |
| `calibration.mmPerPixel` | Millimetres per pixel along x and y, null in pixels only; with the stored Pixel Spacing, Imager Pixel Spacing, ERMF and calibration type. |
| `calibration.marker` | The editable ball or ruler, its points, size and depth confirmation. |
| `calibration.appliedMarker` | The ball or ruler that set the saved scale, with its size and depth confirmation at the time. Older version 1 files restore their recorded mm per pixel with the generic manual label. |
| `plans[].side` | R or L: the leg. |
| `plans[].landmarks[]` | One label per landmark (below). |
| `plans[].osteotomy` | The first simulated osteotomy (or null), retained for backward compatibility with single-level version 1 files: bone, cut and hinge (pixels), wedge, angle and direction, shifts and lengthening (mm), the fragment's outline (pixels). |
| `plans[].osteotomies` | Present when a plan has multiple cuts (up to 6): the full list of osteotomies in the same shape as `osteotomy`. Opening a file reads `osteotomies` when present and falls back to `osteotomy` otherwise. |
| `plans[].values` | The values as measured when saved, to read the file without VEAcom; VEAcom measures again when it opens a file and ignores them. |

The file holds no name, patient ID, birth date, accession number, institution, date of the study or UID.

## Labels

| Field | Meaning |
| --- | --- |
| `name` | One of the names in `src/imaging/deformity/landmarks.ts`, or `hipCentre`. A name is never reused for another point. |
| `points` | One point; `femoralHeadContour` has 3 to 12, on the head's outline. |
| `confidence` | `manual`: the reader placed every point. Otherwise the landmark model the points came from (docs/landmark-model.md): its name and the SHA-256 of its two graphs, and `unchecked: true` where the model's channel for this landmark has no check against a reader on real films (it learnt it from synthetic films only). A landmark keeps its model, and the mark, while a point the model gave remains; placed again by hand, it is `manual`. Read the mark with the model's own list of unchecked channels (Opening a file, below). |
| `provenance` | Per point: `placed` (by the reader), `accepted` (the model's suggestion, accepted as it was), `moved` (dragged after it was placed or suggested) or `derived` (computed). `accepted` comes only with a model. |
| `spacing` | The calibration state when it was saved, as above. |
| `side`, `software` | The leg and the VEAcom version, repeated on each label so a label stands on its own. |
| `suggestionShown` | Whether the model's suggestion of this landmark has been on screen while its points were made (CLOSE checklist design, PR #31): true for an accepted or moved suggestion, and for a point placed by hand over one, also after the suggestion was undone. False where the reader placed the landmark with no suggestion of it shown. |
| `derivedFrom` | For `hipCentre`: the fitted circle's centre of `femoralHeadContour`. Its confidence and `suggestionShown` are the outline's. |
| `construction` | `hipCentreRing` on a `femoralHeadContour` from the model: its `accepted` points lie on a circle around the model's hip centre, not on the head's outline as a reader would trace it (docs/landmark-model.md). Its `moved` points are where the reader put them. Do not learn the outline from its accepted points. |

| Name | Point |
| --- | --- |
| `femoralHeadContour` | points on the femoral head's outline |
| `greaterTrochanterTip` | the tip of the greater trochanter |
| `femoralShaftProximal`, `femoralShaftDistal` | the middle of the femoral shaft between the cortices, upper and lower |
| `kneeCentre` | the top of the intercondylar notch |
| `femoralCondyleMedial`, `femoralCondyleLateral` | the condyles' most distal points |
| `tibialPlateauMedial`, `tibialPlateauLateral` | the plateau's edges on the joint line |
| `tibialShaftProximal`, `tibialShaftDistal` | the middle of the tibial shaft between the cortices, upper and lower |
| `plafondMedial`, `plafondLateral` | the plafond's edges on the joint line |
| `ankleCentre` | the middle of the talar dome |

## Opening a file

VEAcom treats an opened file as untrusted: at most 2 MB; the schema and version must match; the film's hash, frame,
columns and rows must be the film on screen; every point must lie within the film or half its size around it; a
contour has at most 12 points, an outline 32; an angle is within 45° and a shift within 200 mm; names are cut to 64
characters; unknown landmarks and fields are left out. A model is read only with its name and two 64-digit hashes;
otherwise the landmark is the reader's, and an `accepted` point without a model is `placed`. `unchecked` is read only
with a model. A label of the model this VEAcom ships is unchecked wherever that model's channel is, whatever the file
says: VEAcom before `unchecked` existed leaves the field out when it saves a file again, so a reader of these files
should do the same (`src/imaging/deformity/suggest.ts` `UNCHECKED` lists the channels). Anything else refuses the
file and says why. Suggestions not yet accepted or moved are not labels and are not saved.
