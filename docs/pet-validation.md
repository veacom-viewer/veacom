# PET validation against the vendor workstation

A consultant will trust VEAcom's PET numbers once they match the scanner vendor's own workstation on the department's studies. This protocol compares the two on real FDG PET/CT studies. It covers SUVbw and SUL, SUVmax, SUVpeak, the liver and blood pool references, MTV and the SUV factor. [PET quantification](pet-quantification.md) describes what VEAcom measures; every check before this one used synthetic studies.

`tools/pet-validation.cjs` does VEAcom's side. It draws the spheres where a JSON file says, writes VEAcom's readings and SUV factors to CSV, and puts the vendor's readings beside them.

**No real data enters the repository.** The studies, both JSON files and the results stay in the department, outside the repository. They never go into a commit, a pull request, an issue or a screenshot attached to one. The tool refuses paths inside the repository unless the studies are the synthetic ones. A defect found here is reported with a synthetic study that reproduces it.

## Studies

Choose 10–20 anonymised FDG PET/CT studies across the department's GE, Siemens and Philips scanners. Take at least three from each vendor where the department has them. Include:

- **A GE series reconstructed later.** Its Series Time (0008,0031) is after its Acquisition Time (0008,0032). Decay correction must then use the scan start, not the reconstruction time. VEAcom takes it from GE's private scan date and time (0009,xx0D), or works it back from the frame's timing (QIBA).
- **A Philips series in counts.** Its Units (0054,1001) are CNTS. VEAcom uses the SUV Scale Factor (7053,1000) that Philips writes.
- **A study with the patient's height (0010,1020) and sex (0010,0040).** SUL needs both. Most studies will have them; include at least one, ideally with a body mass index over 30, where lean body mass formulas disagree most.

Read 2–3 lesions in each study. Cover a range: SUVmax above 10, between 2.5 and 5, and a lesion under 2 cm.

### Anonymising without losing SUV

Anonymisers often strip what SUV needs. Keep these elements, or SUV changes or becomes unavailable:

| Elements | Needed for |
|---|---|
| Patient's Weight (0010,1030), Size (0010,1020), Sex (0010,0040) | SUVbw, SUL |
| Radiopharmaceutical Information Sequence (0054,0016): Radionuclide Total Dose, Half Life, Start Time and Start DateTime | Injected activity and decay |
| Series, Acquisition and Study Date and Time, Acquisition DateTime, Timezone Offset From UTC (0008,0201) | The decay interval |
| Units (0054,1001), Decay Correction (0054,1102), Corrected Image (0028,0051), SUV Type (0054,1006), Rescale Slope and Intercept | What the values are |
| Frame Reference Time (0054,1300), Actual Frame Duration (0018,1242) | The scan start of a later reconstruction |
| GE private group 0009 (creator GEMS_PETD_01), Philips private group 7053 | GE's scan start, Philips' SUV and activity scale factors |
| Manufacturer, model and Software Versions (0018,1020) | The record of what was compared |

- Remove names, IDs, birth date, accession number, institution and operators. Replace UIDs consistently. If dates must change, shift every date in a study by the same number of days and keep the times of day.
- Name each study's folder with a code, such as `GE-01`, `SIE-01` or `PHI-01`, never the patient's name.
- After anonymising, open each study in VEAcom. The PET acquisition panel must show the weight, activity, injection, scan start and uptake. The PET must read in SUVbw, not in Bq/ml or counts.

## Readings

Make the same readings in both tools, in SUVbw. Repeat them in SUL where height and sex are recorded.

| Region | Sphere | Record |
|---|---|---|
| Liver | 3 cm across, in normal right-lobe liver (PERCIST) | SUVmean |
| Blood pool | 1.5 cm across (radius 7.5 mm), in the descending thoracic aorta, clear of its wall. PERCIST uses a 1 cm cylinder 2 cm long; any shape will do if both tools use the same. | SUVmean |
| 2–3 lesions | Around the whole lesion with at least 5 mm to spare, holding no other uptake: bladder, kidney, heart, bowel, another lesion | SUVmax, SUVpeak, MTV at 41% of SUVmax |

- Draw each sphere at the same centre and radius in both tools. Record the centre in DICOM patient coordinates (LPS, mm): x towards the patient's left, y towards the back, z towards the head. A workstation that shows R, A or I values gives them as negative x, y and z. VEAcom puts the centre on the nearest slice; its output says where.
- Where the vendor shows them, also record:
  - the hottest voxel of each lesion in Bq/ml, which shows that both tools took the same voxel;
  - the SUV parameters it used: weight, height, sex, injected activity and injection time;
  - its SUV factor (SUVbw per Bq/ml);
  - its definitions of SUVpeak, of MTV (all voxels in the sphere, or the region connected to the hottest) and of lean body mass, from its manual.
- VEAcom's MTV counts the voxels at or above 41% of the sphere's SUVmax whose centres lie inside it. When those voxels form separate parts, the tool takes the largest and says so.

## Running VEAcom's side

Build VEAcom from a clean checkout of the commit under test, as [CONTRIBUTING](../CONTRIBUTING.md) describes (`pnpm run build`). The tool records the commit and fingerprints of the engine and interface it ran.

```sh
node tools/pet-validation.cjs ~/pet-validation/studies ~/pet-validation/spheres.json ~/pet-validation/results-2026-11 --vendor ~/pet-validation/vendor.json
```

`STUDIES_DIR` holds one folder per study. The output folder must be new or empty. `--screenshots` adds a picture of each sphere, with the patient's details hidden (Shift+F12); leave it out unless needed.

For each study the tool opens the folder in the desktop app with a fresh profile, finds the PET and draws each sphere, one at a time. It gives the sphere its role, reads its values in SUVbw and SUL, and deletes it. It checks each sphere against where VEAcom kept it and stops that sphere if it is out of place. While it runs, the app's window ignores the computer's own mouse and keyboard (macOS and Linux).

### The spheres file

```json
{
  "studies": [
    {
      "study": "GE-01",
      "series": { "number": 4 },
      "spheres": [
        { "name": "liver", "role": "liver", "center": [-75.2, 10.4, -1180.0] },
        { "name": "blood pool", "role": "bloodPool", "center": [18.0, 32.5, -1052.0], "radius": 7.5 },
        { "name": "L1", "center": [-80.1, -20.3, -1001.5], "radius": 20 }
      ]
    }
  ]
}
```

| Field | |
|---|---|
| `study` | The study's folder inside `STUDIES_DIR` |
| `series` | Optional. The PET by Series Number (`number`) or part of its Series Description (`description`). Without it, the study's only calibrated PET that VEAcom can reconstruct. |
| `name` | 1–24 characters, unique in the study. Lesions take this name in VEAcom. |
| `role` | `lesion` (the default), `liver` or `bloodPool`. VEAcom makes the liver sphere 3 cm across. |
| `center` | [x, y, z] in mm, DICOM patient coordinates (LPS) |
| `radius` | In mm. Leave it out for the liver. |

### The vendor file

```json
{
  "software": "GE AW Server 3.2 Ext. 4.0, PET VCAR",
  "studies": [
    {
      "study": "GE-01",
      "suv": { "factor": 0.000346, "weightKg": 70, "heightM": 1.75, "sex": "M", "doseMBq": 200, "injectionTime": "10:48:00" },
      "spheres": {
        "liver": { "SUVbw": { "mean": 2.08 }, "SUL": { "mean": 1.66 } },
        "blood pool": { "SUVbw": { "mean": 1.52 } },
        "L1": { "SUVbw": { "max": 7.02, "peak": 6.45, "mtv": 14.1 }, "SUL": { "max": 5.61, "peak": 5.15 }, "maxBqml": 20280 }
      }
    }
  ]
}
```

- `software` names the workstation, application and version. It can be given per study as well.
- `suv` holds what the vendor shows of its SUV factor; every field is optional. `factor` is SUVbw per Bq/ml. For a reading with SUV and Bq/ml, it is the SUV divided by the Bq/ml.
- Each sphere, by its name in the spheres file, gives `SUVbw` and `SUL` readings: `max`, `peak`, `mean`, `sd`, `mtv` (mL at 41%) and `tlg`. `maxBqml` is the hottest voxel in Bq/ml.
- `tolerances` (optional, in per cent) changes the limits below.

`node tools/fixtures/make-pet-validation-inputs.mjs <folder>` writes both files for the synthetic follow-up. Use them as templates.

### What it writes

| File | |
|---|---|
| `readings.csv` | One row per sphere and quantity: max, peak, mean, σ, voxels, MTV at 41%, TLG, the hottest voxel in Bq/ml, and where VEAcom placed the sphere beside where it was asked |
| `factors.csv` | One row per study: the PET series, its units and decay correction, VEAcom's SUVbw, SUL and SUVbsa factors, and what they come from. That is weight, height, sex, activity, half-life, the injection, series and acquisition times, GE's scan start, Philips' scale factors, the uptake time and the decay interval VEAcom's factor implies. |
| `comparison.csv` | With `--vendor`: each value side by side with its difference in per cent and a status, and a note on the likely cause of a difference |
| `run.json` | VEAcom's commit and version, whether the checkout had changes, fingerprints of the engine and interface, the platform, fingerprints of both JSON files, the vendor's software and the limits used |

The statuses are `within` and `beyond` a limit, `reported` (no limit applies) and `missing` (VEAcom gave no value, with the reason). The tool exits unsuccessfully when anything is beyond its limit or missing, or a study or sphere could not be measured.

## Acceptance

| | Limit |
|---|---|
| SUVmax, where both tools take the same voxel | Within 1% |
| SUVpeak | Within 5%: the methods may differ |
| SUV factor, and the weight, height, activity and injection time behind it | Any difference explained. The tool flags a factor or value more than 0.2% apart, and an injection time a second apart (a minute if the vendor shows minutes); smaller differences are rounding. |

- **The same voxel.** The hottest voxel's activity concentration is independent of the SUV factor. When both tools read the same Bq/ml within 0.5%, they took the same voxel. Then any SUVmax difference is the SUV factor's. When the Bq/ml differ, move or widen the spheres until both hold the same hottest voxel, and read again.
- **SUVpeak.** VEAcom gives the highest mean of a 1 cm³ sphere anywhere inside the VOI, partial voxels weighted (Practical PERCIST). Some workstations centre the 1 cm³ sphere on the hottest voxel instead, or average a cube of voxels. Record the vendor's definition.
- **The SUV factor.** The comparison gives the difference in per cent, and the minutes of decay that would explain it. Known causes:
  - the decay reference of a later reconstruction: the scan start, or the Series Time;
  - a residual activity the vendor subtracts from the injected activity;
  - weight or height typed differently on the workstation;
  - the half-life constant (a 0.01% effect);
  - an injection before midnight or a timezone offset;
  - Philips' own scale factors for a series in counts.
- **SUL.** VEAcom computes lean body mass by Janmahasatian et al. (2005), as recommended for SUL. Some workstations use James (1976), which gives a lower lean body mass in obese patients. The comparison notes when SUL by James would match the vendor. `factors.csv` gives both ratios.
- **Without a limit.** Liver and blood pool means, MTV and TLG are reported, not accepted or rejected. The same SUV factor applies to them, and tools include edge voxels differently. A large difference usually means the spheres are not in the same place.

A study passes when every SUVmax and SUVpeak is within its limit and every SUV factor difference is explained. A difference VEAcom causes is a defect. Report it with a synthetic study that reproduces it, never with the real one. A difference the vendor causes, for example by decaying a later reconstruction to its Series Time, is recorded as explained. VEAcom keeps to QIBA and EANM rather than copy it.

## What to record

- For each scanner: manufacturer, model and software version (in `factors.csv`).
- For each workstation: its name, application and version (in the vendor file, copied to `run.json`).
- VEAcom's commit, version and fingerprints (in `run.json`). Run from a clean checkout so the commit is the build.
- Who made the readings, and when.
- The result for each study: pass, or what failed and why.
- Keep `run.json`, the three CSV files, both JSON files and the vendor's own screenshots or reports together in the department.

## Known limits

- The tool reads values as VEAcom's measurement list shows them: two decimals for SUV, MTV in mL to two decimals below 10 mL and one above. A lesion's hottest voxel in Bq/ml comes from VEAcom's unrounded SUVbw and its factor.
- It draws on axial slices only, with no rotation or flips; a sphere's centre lies on the nearest slice or plane.
- It finds VEAcom's controls by their `data-action` and `data-testid` attributes, as the desktop checks do.
- It has run on macOS. It has not run on Windows, where the app's window still takes the computer's own input.
- `tools/fixtures/make-pet-validation-inputs.mjs` and the synthetic follow-up check the tool itself. It reproduces the known values: liver 2, blood pool 1.5, and lesions 10 then 7 and 4.5 then 3, in SUVbw and SUL.

## Sources

- QIBA. Standardized Uptake Value (SUV): vendor-neutral pseudo-code for SUV calculation, 2018.
- Boellaard R et al. [EANM FDG PET/CT procedure guidelines for tumour imaging, version 3.0](https://doi.org/10.1016/j.eanmj.2025.100006).
- O JH, Lodge MA, Wahl RL. Practical PERCIST: a simplified guide to PET Response Criteria in Solid Tumors 1.0. Radiology 2016;280:576–584.
- Janmahasatian S et al. Quantification of lean bodyweight. Clin Pharmacokinet 2005;44:1051–1065.
- James WPT. Research on obesity. London: Her Majesty's Stationery Office; 1976.
- Tahari AK et al. Optimum lean body formulation for correction of standardized uptake value in PET imaging. J Nucl Med 2014;55:1481–1484.
