# PET quantification

The nuclear medicine review's third step, in shared primitives rather than a PET module: a sphere VOI any pane can draw, reference roles a sphere can take, and a score helper whose scale is data. There is no PET button; the sphere is one more measuring tool, and on a CT or an MR it measures HU or the series' own values.

It covers the sphere VOI, SUVpeak, the liver and blood pool references, the Deauville helper, the metabolic volume (MTV and TLG), the lesion table with its change against the prior study, the PET follow-up screen, the checks of a repeat study against its prior, and glucose-corrected SUL (SULglu).

## Sphere VOI

Choose **Sphere VOI** in the measuring tools (key V), press at the centre of a lesion and drag out its radius. Click, move and click works too. A sphere can be drawn on any plane: acquired slices, a reconstructed plane or an oblique one. It is a region in three dimensions, so:

- every pane of its series shows the circle its plane cuts from it, dashed where the plane misses its centre;
- a whole-volume MIP shows it whole, dashed and without a label, where its centre projects;
- its centre handle and its circle move it within the plane (its depth stays), and the handle on its circle sets the radius;
- choosing it in the measurement list sends every linked pane to its centre.

It reports the statistics of the voxels whose centres lie inside it: max, mean, min (except on a PET), SD and the voxel count. It also gives its own volume and diameter. Values are in the quantity of the Units panel's **PET values** setting (from #53): SUVbw, SUL or SUVbsa, each named by its unit. A PET without SUV keeps its stored unit, and nothing on it is called SUV. A sphere is measured once the whole volume has loaded, on a series that can be reconstructed. One whose bounding box spans more than 16 million voxels is not measured.

Drawn on a CT with a PET fused over it, the label adds the PET's max, peak and mean, from the PET's own voxels inside the sphere.

### SUVpeak

On a PET in SUV, the sphere also gives SUVpeak: the highest mean of a 1 cm³ sphere, wherever that mean is highest. This is the definition in Practical PERCIST (O, Lodge and Wahl, Radiology 2016), where the small sphere need not sit on, or contain, the hottest voxel.

- The 1 cm³ sphere has a radius of 6.20 mm. Each voxel is weighted by the share of its box inside it, so the weights make up 1 cm³ (within 0.1%) on any voxel grid, including anisotropic and oblique ones.
- This viewer reports the highest mean among complete 1 cm³ spheres contained in the drawn VOI. Every contributing voxel must be inside the VOI and have a finite value outside padding.
- A dotted circle shows the sampled 1 cm³ sphere on slices that intersect it. Selecting a VOI limits this outline to that lesion. When no sample fits, the row shows why SUVpeak is unavailable. Lean-body-mass normalization displays SULpeak.
- The search is exact. A candidate is skipped only when the hottest voxel its small sphere could reach is no hotter than the best mean already found, and the search starts at the hottest voxel. Unit tests compare it with a brute-force search.

## Reference regions

In the measurement list, a sphere on a PET in SUV has a **Role**: lesion (the default), **liver reference** or **mediastinal blood pool reference**.

- **Liver.** The sphere has a fixed 3 cm diameter. Move its centre into normal right-lobe liver. The row shows the mean and standard deviation as well as the maximum.
- **Blood pool.** Its size stays as drawn. Place it inside the aorta, clear of the wall.
- Each series has one of each. Giving the role to another sphere makes the previous one a lesion again.

Reference spheres are kept with their study, for this user on this computer. They are stored in `localStorage` under `veacom:pet-studies:v1`, by PET series, and come back when the study is opened again.

- Each study and reconstructed series has its own SHA-256 digest. Phases and stacks with the same DICOM Series Instance UID keep separate references. For older records saved by UID alone, the reader chooses which reconstruction should receive them.
- What is read back is validated, as the workspace settings are.
- At most 300 studies are kept. The ones saved longest ago go first.
- Deleting a reference sphere, or changing its role, removes it from the store.
- A series is saved only after its kept references have been put back, so opening a study cannot overwrite them. A series that Undo takes back to before it was loaded is not saved either.

## Deauville helper

Select the FDG-avid lymphoma reading context on the lesion to enable Deauville. An unknown tracer requires the reader to confirm FDG. A known different tracer or multiple administrations disable the helper. The intensity suggestion compares the lesion SUVmax with the SUVmax of both reference spheres on the same PET.

| Score | Lesion SUVmax | Basis |
|---|---|---|
| 2 | ≤ blood pool | Not above the mediastinum |
| 3 | > blood pool, ≤ liver | Above the mediastinum, not above the liver |
| 4 | > liver, < 2 × liver | Moderately above the liver |
| 5 | ≥ 2 × liver | Markedly above the liver |

- The helper uses the PRoLoG 2× liver rule on unrounded values. Some protocols use 3× liver. A new focus consistent with lymphoma can also warrant score 5 on visual review.
- Scores 1 and X require visual assessment. X marks a focus the reader considers unlikely to be lymphoma. The helper records individual lesion findings.
- A note identifies lesions within 10% of an intensity boundary. A suggestion requires complete, valid lesion and reference measurements and a liver reference at least as intense as the blood pool.
- The ratios are independent of the selected SUV normalization when all three measurements use the same normalization.

**Confirm** records the reader's score and the measured basis. Moving the lesion, moving or replacing a reference, or changing the measured basis requires a fresh confirmation. Undo restores the measurements and score together.

## Metabolic volume: MTV and TLG

A lesion sphere on a PET in SUV has a **Metabolic volume** choice in its row:

- **41% of its max** (EANM): the level is 41% of the sphere's SUVmax. It is relative, so it counts the same voxels in SUVbw, SUL or SUVbsa.
- **SUVbw 2.5 and above**: the level is SUV 2.5 as it is defined, in SUVbw, even when SUL or SUVbsa is shown.

The viewer outlines thresholded uptake inside the sphere. When it contains disconnected regions, the reader selects which belong to the lesion. Region controls give voxel counts and peak locations in patient coordinates. MTV uses the selected voxel volume. TLG is available for identified FDG and equals MTV times the selected mean uptake. The fixed 2.5 option requires a valid SUVbw conversion.

## Lesion table

- A lesion sphere on a PET is named as it is drawn: L1, L2 and so on, after the highest name in use. Names stay put when a lesion is deleted, and the reader can rename a lesion in its row.
- The Findings panel of a PET lists its lesions:

| Column | |
|---|---|
| Max, Peak | SUVmax and SUVpeak, in the SUV shown |
| MTV, TLG | At the lesion's threshold, if it has one |
| DS | The Deauville score the reader confirmed |

- Select the corresponding prior lesion in the Findings table. Lesion names are display labels. A match uses the saved lesion ID and survives renaming and reopening.
- Comparison requires an identified patient and matching radiopharmaceutical. The viewer chooses the most recent eligible open study, then its preferred reconstruction. When the prior is closed, it uses a saved study only when it identifies one comparable reconstruction.
- MTV and TLG changes require the same threshold on both studies. The score column validates the confirmation against the current lesion, references and units.
- Each reconstruction keeps its references, lesions, region selections, matches and measurable SUVbw values. For measurements saved before issuer-aware patient keys, Findings offers a recovery button for the matching study and reconstruction. The reader confirms the patient before the viewer restores the measurements. The viewer reports local storage failures in Findings.
- Each reconstruction keeps the acquisition fields used in follow-up, even without any measurements. These are its uptake time, scanner model, reconstruction method and the blood glucose in its files. Weight, height and times of day are not kept.

## PET follow-up screen

`pet-follow-up` in `src/arrangements/builtin.ts` applies when a PET study opens while an earlier PET of the same patient is loaded:

- This study's PET and the prior's sit side by side, each over its MIP, inverted grey at SUV 0–10 when both have SUVbw calibration.
- The four panes keep one SUV scale (`scale: 'shared'`), as EANM 2025 asks for response assessment (section 14): windowing one PET gives the other the same SUV range, converted through each study's own values per SUV, and inverting it inverts both. The notice says so.
- It is listed before the PET/CT screen, so a study without a loaded prior still opens as PET/CT.
- The `prior` role is found among every series in the session (`MatchContext.session`), not only the study that opened.

The two studies lie in their own frames of reference, so their panes do not follow each other's position. The reader brings both to the same level and presses the link button, which anchors them there (`linkHere`). From then on they page together slice for slice from those anchors, scaled by slice spacing. Each study's own panes follow its crosshair as usual. A prior with the same slice count as the current study pages in step from where it is, without anchors, as the viewer does for any such pair.

## Comparing a repeat study with its prior

The acquisition panel shows the date, uptake interval, scanner model, reconstruction and glucose for both PETs. It uses the same patient, tracer and prior as the lesion table. A caution beside a percentage links it to the reasons below the table. The box of reasons has a dismiss button, as every warning box does. The table and the acquisition panel say the same, so dismissing one dismisses both. The cautions beside the percentages stay, and the box comes back when the reasons change or in the next session.

| Measurement | When the viewer flags a difference |
|---|---|
| FDG uptake interval | More than 10 min between scan-start uptake intervals. When the reader marks the follow-up **Lesion region only**, the limit is 5 min. The viewer keeps this choice per reconstruction. EANM specifies both tolerances. |
| Scanner model | Both DICOM files give a Manufacturer’s Model Name (0008,1090) and the names differ after normalizing case and whitespace. |
| Reconstruction | Both files give a Reconstruction Method (0054,1103) and the methods differ. |
| Fasting glucose | More than 50% higher or lower than the earlier value. UPICT gives this threshold for reviewing baseline and follow-up oncology trial scans. Here the earlier scan in the selected pair supplies the denominator. |

The comparison uses the scan start recorded for each series. In a multi-bed acquisition the lesion itself can be imaged later. The reader confirms a lesion-region follow-up because slice count and a static image type do not establish its coverage. If a field is missing the panel shows it as unrecorded. For a lesion comparison, the viewer prefers a saved prior with measured lesions. Equally recent eligible reconstructions require opening the intended prior. Earlier lesion records remain readable. Reopening an earlier PET fills in its acquisition fields.

## Glucose-corrected SUL (SULglu)

For an FDG PET displayed in SUL, the lesion table and sphere measurements show **SULglu = SUL × glucose in mmol/l ÷ 5.0** alongside SUL. A change in SULglu uses each scan’s own glucose and the reader’s lesion match.

The viewer uses the glucose recorded in DICOM Acquisition Context. When it is missing, the reader can enter or clear a fasting pre-injection measurement in mmol/l or mg/dl. A typed measurement stays with the study on this computer. The panel identifies its source. EANM calls for a calibrated, validated glucose measurement and says the benefit of correction for response assessment is unproven. [EANM guideline, §§9.4 and 13](https://doi.org/10.1016/j.eanmj.2025.100006)

## Copy for the report

**Copy for the report**, under a PET's lesions in Findings, puts the PET's findings on the clipboard as text in the interface language, so the reader pastes them into the report instead of retyping them. It works as the pre-operative checklist's copy does, with no toolbar button. The text has:

- **Technique**: tracer, injected activity, uptake time, weight, height and blood glucose, as the acquisition panel shows them. A glucose the reader typed says so, and a field the files do not record is left out. The last line names the SUV chosen under **PET values**.
- **Reference regions**: the liver and blood pool spheres' max and mean.
- **Lesions**: one line per lesion of the lesion table. Each line gives SUVmax and SUVpeak, and MTV and TLG with their threshold. In SUL with a glucose it adds SULglu, followed by its formula and caveat. Each value is followed by its change against the prior lesion the reader matched. The line names that lesion and both dates, and says when no change can be told against it, and why. The reader's confirmed Deauville score comes last.
- **Cautions**: why the PET has no SUV, if it has none, the acquisition panel's checks before reading SUV, and what limits the comparison with the prior. When the comparison is limited, every lesion with a change also says it may not be comparable.

Numbers are written as the lesion table writes them, with a decimal point in both languages, and every number names its unit. What limits a value sits beside it, as it does in Findings: a sphere partly outside the image, padding or non-finite voxels left out, and a contour whose regions the reader has not selected yet, which has no MTV. A value that cannot be measured is written "values unavailable", and the cautions say why.

A value is called SUV only when the engine calibrated the PET in SUV. A file can store SUV that the engine refuses, for example without attenuation correction. Such a PET, like any PET without SUV, gives its technique and says it has no SUV. The engine's reason follows, and no lesion or reference value is given.

The copy waits while the PET is loading. If the clipboard refuses the text, the panel says so, and the clipboard keeps what it held before.

## Known limits

- Roles, thresholds and the Deauville helper are offered on spheres drawn on the PET itself. A sphere on a fused CT reports the PET's values, but takes no role.
- The synthetic follow-up has no noise, so every value is known. Nothing here has been tried with real PET data.

## Checks

- `tests/voi.test.ts`: the 1 cm³ weights, SUVpeak against brute force, a hotter single voxel beside a plateau, coverage at the image edge, quantities, and no SUV or SUVpeak on a CT or a PET without SUV. Also MTV and TLG at both thresholds, the same 41% volume in SUL, and SUV 2.5 read in SUVbw when SUL is shown.
- `tests/lesions.test.ts`: names that stay put, values kept in SUVbw and read in SUL, and per cent change.
- `tests/arrangements.test.ts`: the follow-up screen with a loaded prior, and the PET/CT screen without one, with another patient's or with a later study.
- `tests/deauville.test.ts`: every band boundary, the same score in any SUV, the basis and near-bound notes, and missing or misplaced references.
- `tests/pet-studies.test.ts`: the kept records, read back, validated and limited, with digests only. Lesions round trip, older records read, and the prior is found by patient and date. The prior's acquisition and a typed glucose round trip; malformed ones are dropped.
- `tests/pet-comparison.test.ts`: the 5 and 10 min boundaries in both directions, the strict 50% glucose-change boundary, FDG only, scanner and reconstruction alike but for case and spacing, the prior's glucose limits, a kept prior compared as a loaded one, and the flags' text in both languages.
- `tests/glucose.test.ts`: SULglu's formula, its label after SULpeak, nothing without a glucose, outside SUL or for another tracer, DICOM glucose taking precedence over typed glucose, and typed values in mmol/l and mg/dl.
- `tests/pet-report.test.ts`: the report text in English and Turkish on a PET whose every value is known. It covers every unit, the changes and their caution, a matched prior with no change, SULglu, the cautions, a typed glucose, partly measured spheres, a contour waiting for its regions, unavailable values, a PET without SUV and one whose SUV the engine refused.
- `tools/check-pet-voi.cjs`: the desktop check on `tools/fixtures/make-pet-followup.mjs`, whose prior was scanned 72 min after its injection (12 min more than the current study) on another scanner model and reconstruction, with no glucose; the current study's files record 5.4 mmol/l. It checks the comparison's flags, the one SUV scale, and SULglu, live and with the prior kept. It also copies the report in English and Turkish, reads it back and checks the message when the clipboard refuses it, on a clipboard in memory.

## Sources

- UPICT Oncologic FDG-PET/CT v2.0 gives the fasting glucose criterion on page 15. [UPICT §4.2.2](https://qibawiki.rsna.org/images/7/71/UPICT_Oncologic_FDG-PETCTProtocol_Dec-2014a.pdf#page=15)
- Boellaard R et al. [EANM FDG PET/CT procedure guidelines for tumour imaging, version 3.0](https://doi.org/10.1016/j.eanmj.2025.100006), sections 8.2, 9.4, 13, 14 and 16–17, and Supplemental Files 3–5.
- O JH, Lodge MA, Wahl RL. Practical PERCIST: a simplified guide to PET Response Criteria in Solid Tumors 1.0. Radiology 2016;280:576–584.
- Wahl RL, Jacene H, Kasamon Y, Lodge MA. From RECIST to PERCIST. J Nucl Med 2009;50(Suppl 1):122S–150S.
- Barrington SF et al. Role of imaging in the staging and response assessment of lymphoma: consensus of the International Conference on Malignant Lymphomas Imaging Working Group. J Clin Oncol 2014;32:3048–3058.

- [PRoLoG clinical consensus on lymphoma response assessment](https://pmc.ncbi.nlm.nih.gov/articles/PMC9841255/)
- [PRoLoG technical recommendations for reference measurements](https://pmc.ncbi.nlm.nih.gov/articles/PMC9902846/)
