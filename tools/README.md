# Video export check

```sh
node tools/check-video-encoder.cjs /path/to/results
node tools/check-video-encoder.cjs /path/to/results --no-gpu
```

This exports a synthetic stack through the real path (the H.264 encoder built into Electron, the app's preload and its MP4 writer), then decodes the file with a `<video>` element and compares gray levels, colours, overlays and frame order with what was drawn. It needs no study. `--no-gpu` turns hardware acceleration off, as on a computer without a graphics driver. Run it on Windows as well as macOS when video export or Electron changes.

# Renderer and viewport checks

Start Vite from the repository:

```sh
pnpm exec vite --host 127.0.0.1 --port 5188 --strictPort
```

Run the real browser checks in a second terminal:

```sh
node tools/check-viewport.mjs
node tools/check-gestures.mjs
node tools/check-measurement-races.mjs
node tools/check-panel-sessions.mjs
```

`check-measurement-races.mjs` presses a measurement before a paged frame is drawn, hides measurements while one is selected, and leaves a list pick unresolved. `check-panel-sessions.mjs` mounts the slice bar, the 3D view and the assessment panel: an arrow held while its bar goes away, undo in the middle of a burr stroke, and assessment input across a re-import. They guard the fixes for issues #37 and #39. `node tools/check-harness.mjs` serves the page and runs all four; with `VEACOM_HARNESS_ELECTRON=1` it drives VEAcom's own Electron instead of Chrome, which is how Linux CI runs them on llvmpipe (the engine must be built). Its window then keeps out the computer's own mouse and keyboard, like the desktop checks below. A check still running after `VEACOM_HARNESS_TIMEOUT_S` seconds (default 240) is stopped and fails the run, and a failed check is not run again. `check-browser-gpu.mjs` runs them after its GPU pixel checks.

The runner uses installed Google Chrome. Set `VEACOM_BROWSER_CHANNEL=msedge` to use installed Edge, or `VEACOM_TEST_URL` to change the complete fixture URL. The default URL is `http://127.0.0.1:5188/tools/viewport-check.html`.

`renderer-check.html` checks exact GPU pixels for compact scalar formats, trilinear sampling, PET fusion, source RGB, inversion and palettes. Its machine-readable result is `window.rendererCheckResult`. Unsupported color MPR and uncalibrated SUV fusion must fail explicitly.

Float64 source values remain exact for measurements; GPU display uses a cached Float32 copy. NaN/Inf padding stays unchanged in the source and displays as background. Stacks deeper than the GPU3D texture limit still page through source frames using one frame upload at a time; MPR and fusion remain unavailable for those stacks.

`viewport-check.html` mounts the actual React viewport against a known mathematical scalar field. The runner checks scrolling, window/level, zoom/pan, every annotation tool, MPR, oblique and reference planes, mouse settings, touch gestures and 25 simultaneous panes. These fixtures are test inputs, not example patient images.

CPU geometry and measurement checks:

```sh
node --import ./tests/setup.ts --test tests/geometry.test.ts tests/annotations.test.ts tests/interaction.test.ts
```

The `veacom:frame` event and `onFrame` callback measure CPU render submission and canvas composition. They do **not** measure GPU completion, display latency or input-to-photon latency. Use the screen/QR benchmark kit for those comparisons.

The interaction unit tests include a captured Windows wheel pattern:120 physical detents at240Hz were combined into32 browser events. The normalized input preserves all120 detents. Live Windows SendInput checks remain necessary when changing event handling.

## Interface language in the desktop checks

The interface opens in Turkish by default (English is the alternative; `src/i18n`, `electron/i18n.cjs`).
The desktop and browser checks find controls by `data-testid` and other attributes, never by their
visible text, so they pass in either language. A fresh profile starts in Turkish; set
`VEACOM_LOCALE=en` to run a check against the English interface. `desktop-smoke.cjs` also checks
the language switch and that the choice is saved in the profile's `preferences.json`.

## Using the computer while the desktop checks run

On macOS and Linux, every tool here that opens the desktop app keeps its window from taking the computer's own mouse
and keyboard (`tools/lib/outside-input.cjs`): the desktop checks in `tools/verify.sh`, the other `check-*.cjs` and the
`profile-*.cjs`. Only `windows-vm/ui-windows-checks.cjs`, which needs real Windows input, goes without. The window shows
without making the app the active one, so typing goes to the app in front, clicks and scrolls go through to the window
below, and it keeps drawing while covered. On macOS, if the app becomes active all the same, it is hidden at once and
keeps drawing, and `capturePage()` still returns the current frame. The checks' own input comes through Playwright, which
needs neither. A new desktop check calls `ignoreOutsideInput(desktop)` straight after `firstWindow()`. On Windows the
windows still take real input, as when the Windows checks last passed.

## Drawing without a graphics driver

On a PC without a usable graphics driver (Microsoft's basic display driver, some remote sessions, drivers Chromium blocklists) Chromium still provides WebGL, drawn in software: on Windows through Direct3D WARP, whose renderer string names the "Microsoft Basic Render Driver". The viewer then shows a notice that drawing is slow and a "Software drawing" marker in the status bar.

- `node tools/check-software-rendering.cjs <study> <output> --expect software|hardware [-- <app switches>]` records the renderer, Chromium's GPU feature status, a PNG and pixel statistics of the viewport, the notice and redraw timings (`software-rendering.json`). `VEACOM_SMOKE_EXECUTABLE` selects a packaged app.
- `tools/desktop-smoke.cjs` fails on software drawing, WARP included; `VEACOM_SMOKE_RENDERER=software` runs it on a machine without a driver and then requires the notice.
- `node tools/check-renderer-suite.cjs <output> [-- <app switches>]` runs `renderer-check.html`'s exact pixel checks inside the desktop app, on whatever renderer the app gets. Start Vite first.
- `VEACOM_BROWSER_ARGS=--disable-gpu node tools/check-viewport.mjs` runs the browser checks on SwiftShader.

On macOS, `--disable-gpu` leaves Electron 45 without WebGL even with `--enable-unsafe-swiftshader`: SwiftShader needs a Vulkan loader (`libvulkan.dylib`) that Electron's macOS build does not include, so the software path cannot be exercised with the stock app there.

## Click budgets

How many actions each canonical task takes, counted by the app's own usage timings (`src/usage`)
while a check drives it with real mouse and keyboard input (`click-budget.cjs`). Today's counts are in
`click-budgets.json`; a change that makes a path longer fails the check, like a performance budget, and
a shorter path asks for the budget to come down. A control without a `data-testid` or `data-action`
reports `other` and fails too, and so does a step that changes nothing.

```sh
node tools/desktop-smoke.cjs ~/veacom-bench/studies/ct-small/S01
node tools/check-click-budget.cjs ~/veacom-bench/studies/ct-small
```

`desktop-smoke.cjs` budgets its own steps and checks the usage-timings consent (asked once on a fresh
profile, saved, and switched off in the display panel). On a CT the assessment button opens the pre-op
checklist, which the smoke test budgets. `check-click-budget.cjs` runs the canonical tasks on the
synthetic CT, including a scripted "wanted view" (lung window at mid-chest), and opens a generated
synthetic MR (`make-smoke-study.mjs --modality MR`) through the real menu. On an MR the button opens
the lesion pre-diagnosis, which is switched off while its knowledge base is out of the repository: the
check makes sure the disabled button says why and skips opening and closing it, which have no budget.
Once it is back, those two tasks run again and fail until their budgets are recorded. `tools/verify.sh` runs both, and
`check-budget-coverage.cjs` then fails if any budget went unmeasured. Set `VEACOM_RECORD_BUDGETS=1` to
write the counts of a run as the new budgets. On macOS and Linux the checks' windows ignore the computer's own mouse and keyboard (see "Using the computer while the desktop checks run"); on Windows, using the computer while they run is counted and fails the budget.

## Arrangements

`check-arrangements.cjs` opens the synthetic PET/CT from `fixtures/make-petct-study.mjs`. It has a CT, an
attenuation-corrected PET in Bq/ml with what SUV needs, and the same PET without attenuation correction. The check
covers [arrangements](../docs/arrangements.md) on that study:

- The study opens as CT · PET · fused · MIP with no click. A note names the screen, and no action is recorded.
- A click on the MIP sends the linked panes to a lesion.
- A pane moved and kept changes how the next PET/CT opens.
- Undo restores the screen from before, and can be kept too.
- Forget brings back VEAcom's own screen.
- A PET opened by hand is inverted grey, with its window in SUV.

CI's desktop job, the Windows job and `tools/verify.sh` run it.

```sh
node tools/fixtures/make-petct-study.mjs /tmp/petct-study
node tools/check-arrangements.cjs /tmp/petct-study test-results/arrangements
```

## PET quantification

`check-pet-voi.cjs` opens the current study of the synthetic follow-up from `fixtures/make-pet-followup.mjs`. That
fixture has one patient with a prior and a current study, each a CT and an attenuation-corrected PET. The PET has no
noise or blur, so its values are known: uniform liver (SUV 2), descending aorta (1.5) and two lesions whose SUV falls
from the prior study to the current one. The prior was scanned at another table position, over more slices, in its own
frame of reference.
The check covers [PET quantification](../docs/pet-quantification.md):

- A sphere dragged on the lesion gives SUVmax, SUVpeak, mean and volume, in the image and in the list, and shows on the MIP.
- On a coronal reconstruction it reads the same, and its row in the list sends the pane to its centre.
- Spheres marked as the liver (made 3 cm across) and blood pool references read 2.00 and 1.50.
- The lesion's Deauville suggestion shows its basis, and the reader confirms it.
- A sphere on the fused CT also gives the PET's SUVmax and SUVpeak.
- At 41% of its SUVmax the lesion gives MTV and TLG, drawn on its slices and listed in the lesion table.
- The references are kept by digest, with no UID, and the actions are recorded by id.
- In a new session on the same computer the references and the lesion table come back.
- Opened after its prior, the study lays out as the PET follow-up screen. Linked by hand with the link button, the two
  studies page together, and the lesion table gives each value's change against the prior lesion selected by the reader.
- With the current study alone, that change comes from what was kept for the prior.

CI's desktop job, the Windows job and `tools/verify.sh` run it.

```sh
node tools/fixtures/make-pet-followup.mjs /tmp/pet-followup
node tools/check-pet-voi.cjs /tmp/pet-followup test-results/pet-voi
```

## PET validation against the vendor workstation

`pet-validation.cjs` is VEAcom's side of the [PET validation protocol](../docs/pet-validation.md), which compares VEAcom's PET
numbers with the scanner vendor's workstation on real, anonymised studies. Given a folder of studies and a JSON file of
sphere centres and radii per study, it:

- opens each study in the desktop app with a fresh profile, as `check-pet-voi.cjs` does, and finds its PET;
- draws each sphere on the PET's axial slices, one at a time, where the file says, and checks it against where VEAcom
  kept it;
- gives each its role: liver reference (3 cm across), blood pool reference, or lesion at 41% of its SUVmax for MTV;
- writes what VEAcom shows in SUVbw and, with height and sex, SUL (`readings.csv`), and the SUV factors with what they
  come from (`factors.csv`);
- given the vendor's readings (`--vendor`), writes them side by side (`comparison.csv`). It flags SUVmax beyond 1%,
  SUVpeak beyond 5%, and any difference in the SUV factor or its parameters, and notes the likely cause;
- records the commit, the build's fingerprints and the inputs in `run.json`.

Real studies, both JSON files and the output stay outside the repository; the tool refuses paths inside it unless the
studies are synthetic. Its window ignores the computer's own mouse and keyboard (`lib/outside-input.cjs`). It exits
unsuccessfully when a value is beyond its limit or missing. `make-pet-validation-inputs.mjs` writes both JSON files for
the synthetic follow-up, with its known values as the vendor's: the tool must reproduce liver 2, blood pool 1.5 and the
lesions' 10 then 7 and 4.5 then 3, in SUVbw and SUL. CI's desktop job and `tools/verify.sh` run that. It has not run on
Windows.

```sh
node tools/fixtures/make-pet-followup.mjs /tmp/pet-followup
node tools/fixtures/make-pet-validation-inputs.mjs /tmp/pet-followup
node tools/pet-validation.cjs /tmp/pet-followup /tmp/pet-followup/pet-validation-spheres.json test-results/pet-validation --vendor /tmp/pet-followup/pet-validation-expected.json
```

On real studies, with `--screenshots` for a picture of each sphere (patient details hidden):

```sh
node tools/pet-validation.cjs ~/pet-validation/studies ~/pet-validation/spheres.json ~/pet-validation/results --vendor ~/pet-validation/vendor.json
```

## Gamma camera studies

`fixtures/make-nm-study.mjs` writes two synthetic gamma camera (NM) studies of one patient. The first is a bone SPECT/CT:
a CT, a reconstructed SPECT in Bq/ml (one NM multi-frame file, Real World Value Mapping, slices stacked by a negative
Spacing Between Slices), the raw projections of its two detectors and a gated SPECT (`RECON GATED TOMO`: 8 gates of a
generic ellipsoid shell that contracts and thickens, a positive Spacing Between Slices, each gate's Time Slot Time). The
gated SPECT is numbered before the summed one. The second is a whole-body scan: one NM file whose two frames are the
anterior and posterior views, named by their detectors' View Code Sequence.
`check-gamma-camera.cjs` covers them:

- The SPECT/CT opens as CT · SPECT · fused · MIP with no click. The SPECT is placed from its detector geometry, fused on
  its own scale, and nothing on it is called SUV.
- A click on the SPECT MIP sends the linked panes to the vertebral lesion.
- The whole body opens with ANT and POST side by side. Each pane names its frame's view and detector, both share one
  window, and each pages on its own. Undo puts the linking back.
- The projections name their detector.
- The gated SPECT opens as 8 placed series in gate order, each named "Gate n/8 · … s acquired" with its own Time Slot
  Time, placed from the detector geometry and sharing one window. The SPECT/CT screen still takes the summed SPECT. A
  gate in the SPECT pane follows the CT's height, a gate in the MIP pane shows its MIP, and a gate picked in the fusion
  strip fuses over the CT, named there and in the pane, never in SUV. The export window says a gate exports with every
  gate of its file.

CI's desktop job, the Windows job and `tools/verify.sh` run it.

```sh
node tools/fixtures/make-nm-study.mjs /tmp/nm-study
node tools/check-gamma-camera.cjs /tmp/nm-study test-results/gamma-camera
```

## Pictures

`node tools/check-pictures.cjs <DICOM series folder> <output>` checks picture imports in the desktop app.
It compares opaque 8-bit PNG and BMP samples exactly, checks 16-bit PNG rounding, and allows a difference of three
levels for the solid-colour JPEG fixture. It tests EXIF orientation and print density, the sandbox, the pixel limits,
and cancellation while a header is pending. It also checks every pixel of a picture whose RGBA reply exceeds the pipe's
16 MiB request limit. CI, the Windows job and `tools/verify.sh` run it.

## Memory and load profiles

`node tools/profile-memory.cjs --study=<study> --output=<file.json> [--runs=3]` opens the desktop app with a study, waits for the full volume, and records each process's memory 3 s and 20 s later and after paging through 100 slices, with the renderer's and engine's peaks. macOS reports physical footprint (Activity Monitor's Memory column), Windows private bytes (Task Manager's) and peak working sets, Linux resident size. `--app` or `--executable` selects another build and `VEACOM_CORE_PATH` another engine. Use a large synthetic study such as a 1,000-slice CT (about 500 MiB): on `ct-small` the differences are smaller than the run-to-run noise. Expect the renderer to hold the volume once, at load and at its peak, and the engine to fall back to tens of MiB after sending it.

`node tools/profile-load.cjs --study=<study> --output=<file.json>` times one load step by step: pixel headers and bodies, texture uploads and the first preview and full-volume frames.

The profiles open the app's window without making the app the active one (see "Using the computer while the desktop
checks run"). On macOS that leaves out the time the system takes to make an app active as its window opens: measured
on an M4 Pro with `ct-small`, launch-to-ready and first-image times are about 50 ms (a tenth) lower than with an active
window, as in a launch from the Finder or the Dock and in profiles taken before this change. Paging and slice timings,
the load steps after start-up and memory stay the same within run-to-run noise.

The memory report identifies the running build by its engine and either its loaded renderer entry or its packaged `app.asar`. It checks those hashes across repeated runs. Use a built viewer with `VEACOM_DEV_URL` unset.

## Windows scripts

`pwsh -NoProfile -File tools/check-powershell.ps1` parses every PowerShell script in the repository and rejects what Windows PowerShell 5.1 cannot run: syntax errors, PowerShell 7 operators and parameters, and non-ASCII characters. CI runs it on Linux. `tools/check-windows-package.ps1 -Action Package|Install|Uninstall` checks the packaged engine and runtime, then a silent install and uninstall, for the hosted Windows job. `tools/windows-vm/README.md` describes that job and the Tesla T4 checks on the Windows VM.
