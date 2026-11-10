# Arrangements

An arrangement defines which series fill the panes, how they link and which image is fused or projected. It can open with the study or when the reader selects a screen.

## The PET/CT screen, as data

```json
{
  "id": "pet-ct", "name": "arrangement.petCt", "when": "open",
  "roles": {
    "pet": { "modality": "PT", "prefer": ["corrected", "slices"] },
    "ct": { "modality": "CT", "of": "pet", "frame": "same", "prefer": ["corrected", "sameGrid", "overlap", "slices"] }
  },
  "grid": [1, 1],
  "panes": [
    { "role": "ct", "plane": "axial", "show": "fused", "over": "pet" }
  ],
  "link": "crosshair",
  "notice": { "key": "arrangement.petCt.fused" }
}
```

PET/CT opens in one axial pane with PET uptake over the matching CT. Layout offers a four-pane reading view with CT, PET, fusion and MIP. It also offers follow-up when a suitable prior is loaded. The menu beside Fusion opens the applicable nuclear medicine screen for the active patient and study. A PET layout the reader previously kept still takes precedence on import.

## Vocabulary

**Roles** say which series fill an arrangement. A role is a filter plus a ranking, never code:

- `modality` (one, or a list such as `["PT", "NM"]`), or `sequence` for MR: `dwi`, `adc` (the existing sequence guess);
- `volume`: `true` for a series whose slices have a known place, so it reconstructs (planes, MIP, fusion). A SPECT reconstructed from gamma camera data is one; its projections and planar images are not;
- `imageType`: a value of Image Type (0008,0008), such as `WHOLE BODY`;
- `views`: gamma camera views the series holds a frame in, each of them, such as `["ANT", "POST"]`;
- `of`: another role, or the series the reader picked. That series is the role's anchor;
- `study`: `same` as the anchor (the default); `prior`, the same patient's most recent earlier study; or `later`, the next later one. Other studies are found among every loaded series;
- `alike`: `true` for the anchor's counterpart, a series of the anchor's own kind ([the comparison screen](#the-comparison-screen));
- `frame`: `same`, meaning the series can be drawn with its anchor (one frame of reference, known orientation, reconstructable);
- `prefer`: ranking keys, compared in order: `ungated` (not one gate of a gated SPECT), `corrected` (not NAC), `sameGrid` (slice count and spacing of the anchor), `overlap` (z-range shared with the anchor), `slices`, `highB`.

A required role that finds no series means no match. An anchor takes the best series it ranks that leaves every role found beside it filled: a SPECT with no CT in its frame of reference gives way to the next SPECT, as a PET without its CT gives way to the next PET.

**Panes** give each role a `plane` (`axial`, `coronal`, `sagittal`; the acquired plane shows the series' own slices) and a `show`: `plain`; `fused` (this pane's series with `over` drawn on it); or `mip` (a whole-volume projection). For gamma camera frames, `view` opens the pane on the frame taken in that view (`ANT`, `POST`, `RAO`, `LAO`, `RPO`, `LPO`, `R LAT`, `L LAT`). The `display` sets `palette`, `invert` and a `window` in the series' own quantity. A unit the series lacks is skipped: a PET without SUV keeps its own window, and nothing on it is called SUV. `link` is `crosshair` (linking on: positions and the crosshair follow across one frame of reference) or `none` (linking off: each pane pages on its own); without `link` the linking stays as it is. Undo puts the linking back. `scale: "shared"` keeps the arrangement's PETs on one SUV scale: windowing one gives the others the same SUV range, converted through each PET's own values per SUV, and inverting or recolouring one does the same to them. The PET follow-up screen uses it, since response is read on one fixed scale. `notice` is the message key of the pane notice.

The comparison screen adds four words. A pane `asShown` keeps the series of the active pane as the reader has it. `link: "level"` is for two studies, which share no frame of reference. `view: "shared"` makes the panes zoom and pan together. `lead` leaves that many panes empty before the listed ones.

## Where arrangements apply

| Trigger | Arrangement | Behaviour kept from today |
|---|---|---|
| A study opens (`importStudies`) | Kept PET follow-up, then `pet-ct` | A matching PET/CT opens in 1×1 fusion unless the reader has kept a different layout. Other studies open their first image in the active pane. |
| Nuclear medicine screen beside Fusion | PET follow-up, four-pane PET/CT, whole body or SPECT/CT | The reader’s active patient and study supply the screen. Only a follow-up prior is drawn from the wider session and must match patient and tracer. [PET quantification](pet-quantification.md) |
| **Compare with the earlier study** in Layout | `compare-prior`, `compare-later` and their `-empty` forms | Offered when another study of the same patient is loaded, for the series in the active pane. Not offered between two PET studies or in the three-plane MPR. [The comparison screen](#the-comparison-screen) |
| One series picked into a pane (`selectSeries`, `dropSeries`) | `dwi-adc`, `adc-dwi` | Only with exactly two panes and no three-plane MPR. The partner goes into the other pane, linking turns on, and the pane says "ADC added to this pane" with Undo. |
| Several series picked together (`openSideBySide`) | `side-by-side` | `grid` by count: 2 → 1×2, 3 → 1×3, 4 → 2×2, 5–6 → 2×3. The first picked goes first, at most six, with no notice. |
| The fusion button (`startFusion`, `fuseInActive`) | `fusion` | Its `overlay` role (a PET or a reconstructed SPECT) and `ct` role replace `bestPartner`'s callback and scoring. They give the same ranking, and `tests/fusion.test.ts` stays as it is. For a CT, `ungated` picks a summed SPECT over its gates; a gate shown in the pane is fused itself. |

An automatic arrangement records no usage action. The pane notice names it, such as “PET/CT fusion (1 × 1)”, and offers **Undo** until the reader's next action. Undo restores the previous panes, layout, active pane, linking, fusion and crosshair and opens the study's first image in the active pane.

## Keep this

Automatic and requested screens can be kept. VEAcom offers **Keep this** after a reader changes an arranged screen:

- a pane moved by its grip;
- a pane's plane changed;
- its look changed: a window preset, invert or palette.

Keep derives a variant from the current panes. It records the order and each pane's role, plane and `show`. It also records each pane's look: palette, invert, and a window set by hand, in the series' quantity (SUV or HU). SUV is normalised to the patient, so a kept SUV window means the same on the next study.

Undo of an automatic layout offers **Keep this** to turn automatic opening off. Undo of a requested screen restores the previous view. The reading screen remains available on request.

Variants are stored in `localStorage` under `veacom:arrangements:v1` (per user, per computer) and validated on read, as `readSettings` does. The next matching study opens with the variant; its notice reads "Your PET/CT layout" and still offers Undo. The display panel's Workspace section lists what was kept, and **Forget kept layouts** brings VEAcom's own arrangements back.

## The comparison screen

Layout offers **Compare with the earlier study** when another study of the same patient is loaded. The earlier study goes on the left and the later one on the right.

```json
{
  "id": "compare-prior", "name": "arrangement.compare", "when": "screen",
  "roles": {
    "picked": {},
    "prior": { "of": "picked", "study": "prior", "alike": true }
  },
  "grid": [1, 2],
  "panes": [{ "role": "prior" }, { "role": "picked", "asShown": true }],
  "link": "level",
  "view": "shared",
  "notice": { "key": "arrangement.comparePrior.notice" }
}
```

- **The reader's pane stays.** The series in the active pane goes to the right with its slice, window, zoom, pan and fusion.
- **The counterpart.** The left pane takes that series' counterpart in the most recent earlier study that has one (`src/arrangements/counterpart.ts`). A counterpart is of the same kind, never merely the nearest series:
  - always the same modality, both volumes or neither, and the same acquired plane;
  - never another part of the body, where both series record Body Part Examined (0018,0015). HEAD and BRAIN, CHEST and CHESTABDPELVIS, and SPINE and LSPINE are one part. A part one of the two does not record decides nothing;
  - MR: the same likely sequence, so T1 with contrast is not T1. Names do not matter: "AX T2 TSE" pairs with "t2_tse_tra". A series whose sequence cannot be told pairs only with one of the same description;
  - CT: ranked by the same contrast state, the same description, the same stored window (a lung reconstruction with a lung reconstruction), the nearer slice thickness, then the most slices;
  - any other modality: only a series of the same description.
- **No counterpart.** The earlier study's side stays empty and the note says so (`compare-prior-empty`). VEAcom puts no series of another kind there.
- **From the earlier study.** With the earlier study in the active pane, the entry reads **Compare with the later study**, and the later study's counterpart comes on the right (`compare-later`).
- **Level and linking.** The counterpart opens as far through its stack as the reader's pane is through its own, going the same way in the patient. The two are linked there, as the link button links panes by hand, and page by the distance gone. The level is a first guess, not a registration, and the note says to check it. To correct it, turn linking off, page one pane to the matching level and turn linking on again.
- **The same kind of view.** Beside a reconstructed plane the counterpart opens in that plane, with its tilt and slab; beside a MIP, as a MIP at the same turn.
- **One view.** While linked, the two panes zoom and pan together. CT beside CT takes one window, since Hounsfield units are one scale. An MR keeps its own window on each side.
- **A series put in one pane** changes that pane only. A series of the study the pane showed opens where the reader was; any other opens level with the other pane. Either way it is linked to the other pane there. The other pane offers that series' counterpart, named as the series list names it ("Open the earlier AX T2 TSE here?"), for five seconds, and one click opens it. The DWI/ADC pairing does not apply in this screen.
- **Another patient.** A series of another patient put in a pane is shown and linked like any other, and a warning says that the patient details in the two panes differ ([design guidelines](design-guidelines.md), "Patient safety"): an ID, a name or a birth date that both series record is not the same. The warning has its own bar, so no other message takes its place: it stays until the reader dismisses it or the panes show one patient again. A field one of the two does not record brings no warning: a missing ID beside a matching name is not a mismatch.
- **Ctrl+→ and Ctrl+←** (⌘ on macOS) step both panes to the next and previous series that has a counterpart in the other pane's study, each pane staying at its level. Outside this screen they open the next and previous series of the active pane's study.
- **PET.** Two studies that both hold a PET are compared on the PET follow-up screen, which keeps this study on the left; the comparison is not offered between them. A PET/CT is compared with an earlier CT alone.
- **Not kept.** The screen starts from what the reader shows, so there is nothing to keep.

## The two new primitives

**Projection pane (`mip`).** A whole-volume maximum intensity projection, seen from the front, that turns about the patient's long axis.

- **Rendering.** It reuses the slab shader as a program variant of its own, so the existing shader source and the export golden stay unchanged. It samples at half a voxel along the ray (at most 256 samples either side), so a lesion of one voxel is not read low.
- **Turning.** The pane's slice is its turn: 36 steps of 10°. The wheel, the slice bar and the arrow keys turn it, and the cine button spins it.
- **Clicks.** A click goes to the hottest voxel within 4 mm of the ray, and the linked panes go there. Measuring tools pick points here instead of drawing.
- **Linking.** It never follows, or drives, the other panes' slices.
- **Loading.** While its volume loads, it shows the preview frame.

**PET look and SUV window.** PET panes open in inverted grey. The PET/CT screen uses SUV 0–5 and the PET follow-up screen uses SUV 0–10 when both studies have SUVbw calibration.

- **Scale.** The window is computed through the series' `suvFactor` (SUVbw, the same as the fusion scale). It is the exact inverse of the renderer's linear window, so "SUV 0–5" in the overlay is what is drawn.
- **Presets.** With a PET active, the window presets menu offers SUV 0–5, 0–7 and 0–10 instead of the CT windows.
- **Shared scale.** Panes showing the same PET share its window, inversion and palette: one scale across the PET pane and its MIP.
- **Without SUV.** A PET without SUV is inverted grey with its own window, and nothing on it is called SUV.

## Gamma camera (NM) studies

A gamma camera file says what each frame is outside the frames, and the engine reads it (`native/src/gamma_camera.rs`):

- **Reconstructed SPECT.** When Image Type says `RECON TOMO`, the first item of the Detector Information Sequence (0054,0022) gives the first slice's position and orientation. The slices follow along row × column, Spacing Between Slices apart; a negative spacing, as Siemens writes it, stacks them the other way (PS3.3 C.8.4.15). The Slice Vector says which slice each frame is. The SPECT is then a volume like a CT: planes, linking, the crosshair, the MIP and fusion. Without Spacing Between Slices nothing is guessed: the frames stay a stack, as before.
- **Frames named.** The Frame Increment Pointer (0028,0009) names the vectors that give each frame its detector, energy window and phase. A detector's View Code Sequence gives its view, by CID 26 code value (SNOMED CT or SNOMED RT): `ANT`, `POST`, the obliques and the laterals. The image corner reads, for example, "NM · ANT · Detector 1". The detector, energy window and phase are named only where a file holds more than one of them. A view is never guessed from Patient Orientation or a description. Planar frames lie in no slice stack by nature, so they carry no geometry warning.
- **Gated SPECT.** When Image Type says `RECON GATED TOMO`, the file holds one volume per gate. Its frames go by R-R Interval Vector, Time Slot Vector and Slice Vector, the slice fastest (PS3.3 Table C.8-8). Each gate becomes a phase of its file (`GroupKey.temporal` in `native/src/ingest.rs`, with the file's SOP Instance UID in the key), so it is its own series, placed as a reconstructed SPECT is: planes, linking, the crosshair, the MIP and fusion. The series list and the corner name it "Gate 3/8 · 118 s acquired" ("Kapı 3/8 · 118 sn çekim"). The time is the gate's Time Slot Time (0054,0073), the time it counted over all its beats (C.8.4.13.1.2), never a delay after the R wave. Without it a gate is named by number only. All gates of a file share one window, the span of each gate's own, so a gate that counted more looks brighter, as NM workstations show them. Fused over a CT, a gate tops the colour scale at that shared window's top, so the difference stays. The gates of another file, in the same series or gated otherwise, are another set of gates, never part of these volumes. DICOM export copies files whole, so a gate exports with every gate of its file; the export window says so.
  - **Several R-R windows.** An R-R window is a range of beat lengths: normal beats in one, ectopic ones in another (C.8.4.8.1.6). Each window's beats are cut into the same Number of Time Slots, so its gates are a cardiac cycle of their own. The gates are numbered window by window, as the file orders them, and never merged across windows. Where a file holds several windows, a gate is named after its window first, with the beat lengths it took from the window's Low and High R-R Value: "R-R 2 (300–640 ms) · Gate 3/4". A file without an R-R Interval Vector, neither named by the Frame Increment Pointer nor held, has one window, but only if Number of R-R Intervals is absent or 1. A vector the file holds must give every frame a window within that count.
  - **Nothing guessed.** A gated file is split only when its gates are whole volumes that can be placed: every time slot and window within their counts, each gate holding each slice once, Number of Slices × Number of Time Slots × Number of R-R Intervals equal to Number of Frames, the counts checked against the frames before any gate is made, and the slice geometry of a reconstructed SPECT. Otherwise its frames stay one stack, as before. Gated planar frames (`GATED`, a MUGA) and gated projections (`GATED TOMO`) stay planar, unsplit.
  - **No cardiac analysis.** No LVEF, polar maps or reorientation. The SPECT/CT screen and the fusion button prefer a summed SPECT (`ungated`), which holds all the counts; when only gates have a matching CT, the requested SPECT/CT screen uses the first matching gate.
- **Activity, never SUV.** A SPECT reads in Bq/ml when a Real World Value Mapping item maps its stored values to Bq/ml (UCUM), as the NM Image Module stores it, or when it gives PET's Units `BQML`. A gamma camera image never has an SUV here: NM records the dose in MBq, not Bq as PET does, and nothing in the file says what the values are decay-corrected to.

### The SPECT/CT screen, as data

```json
{
  "id": "spect-ct", "name": "arrangement.spectCt", "when": "screen",
  "roles": {
    "spect": { "modality": "NM", "volume": true, "prefer": ["ungated", "corrected", "slices"] },
    "ct": { "modality": "CT", "of": "spect", "frame": "same", "prefer": ["corrected", "sameGrid", "overlap", "slices"] }
  },
  "grid": [2, 2],
  "panes": [
    { "role": "ct", "plane": "axial", "show": "plain" },
    { "role": "spect", "plane": "axial", "show": "plain", "display": { "palette": "gray", "invert": true } },
    { "role": "ct", "plane": "axial", "show": "fused", "over": "spect" },
    { "role": "spect", "plane": "coronal", "show": "mip", "display": { "palette": "gray", "invert": true } }
  ],
  "link": "crosshair",
  "notice": { "key": "arrangement.spectCt.notice" }
}
```

The SPECT is fused as a PET without SUV is: on its own scale, its 99.5th percentile at the top of the default scale. The scale is called "Scale max", the corner says "On its own values", and a region or probe on the fused CT reads "SPECT … Bq/ml", the hottest SPECT voxel as for PET. A SPECT has no scanner look; until the reader changes the fusion it is shown in hot metal, uptake only, at 70% opacity.

### The whole body, as data

```json
{
  "id": "whole-body", "name": "arrangement.wholeBody", "when": "screen",
  "roles": { "body": { "modality": "NM", "imageType": "WHOLE BODY", "views": ["ANT", "POST"] } },
  "grid": [1, 2],
  "panes": [
    { "role": "body", "view": "ANT", "display": { "palette": "gray", "invert": true } },
    { "role": "body", "view": "POST", "display": { "palette": "gray", "invert": true } }
  ],
  "link": "none",
  "notice": { "key": "arrangement.wholeBody.notice" }
}
```

Both panes show the one series, each on its own frame. Panes showing one PET or gamma camera image share its window, inversion and palette, so the two views keep one scale. With linking off, paging one view leaves the other where it is. Keep records each pane's view, so a whole body kept with POST on the left opens so.

## Decisions

- PET look on every PET pane, not only arranged ones. The nuclear medicine review asks for inverted grey PET by default and one scale across panes.
- A MIP click picks the hottest voxel near the ray, as PET workstations do, with 4 mm of tolerance for a click slightly off a small lesion.
- The fused pane takes the scanner's look, as the fusion button does, so one fusion never looks two ways.
- Routine PET/CT uses one fused axial pane. For reporting, choose the four-pane reading view in Layout. To keep a custom view, change a pane’s plane and choose Keep.

- SPECT/CT is the PET/CT screen with the SPECT's own window, as a PET without SUV has. Inverted grey matches the PET panes and a bone scan's planar views.
- Log or square-root display for bone scans is not offered. It does not fit the window and palette primitives: the VOI function comes from the file, not from the reader, and the palettes are fixed colour scales in the shader. A curve would need a renderer change. Saturation is the window's upper end.

Known limits:

- A SPECT or planar image opens in the window measured from one frame's pixels (1st to 99th percentile), as any series without a calibrated default does. In the SPECT MIP the hottest bone can saturate; the shared window widens it in every SPECT pane at once. NM readers usually start from zero to near the maximum.
- The gates of a gated SPECT do not play as a cine at the acquisition rate: cine pages slices, not series. Paging from gate to gate is done by picking each gate.
- SUV 0–5 suits FDG. Readers of other tracers widen it with the presets, and Keep remembers it.
- Outside the PET's field of view the image stays black, as no data is drawn today, even in an inverted pane.
- The comparison's level is a share of the way through each stack. Two studies that cover different lengths of the body open at different levels until the reader links them again.
- Body Part Examined is compared as text. Two names of one part outside the head and trunk, such as EXTREMITY and KNEE, do not match, and the side stays empty. Laterality is not compared: a left knee can be put beside a right knee.
- Nothing here has been tried with real PET or gamma camera data.
