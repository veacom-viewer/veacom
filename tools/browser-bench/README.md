# Browser viewer benchmark

Measures how fast DICOM viewers that run in the browser open a study from disk and respond while reading it. It runs VEAcom's browser build against pinned copies of other open-source browser viewers, on the same machine and in the same Chromium, and it runs one VEAcom build against another to catch regressions. Nothing needs an account or the internet once the viewers are fetched.

## The viewers

`viewers.json` pins every viewer the harness compares with VEAcom: where its files come from, their SHA-256 and the hash of the whole folder. `node tools/browser-bench/bench.mjs fetch` downloads them into `~/.cache/veacom-bench/viewers` and checks them, and every run checks them again. None needs an account.

| Viewer | Pinned | How the harness opens a study |
|---|---|---|
| OHIF Viewer | 3.13.14 (npm `@ohif/app`) with `viewers/ohif-app-config.js`, which keeps only the local-files source | folder dropped on `/localbasic` |
| Kitware VolView | 4.5.3 (npm `volview`) | the study's files given to the chooser behind "Click to open local files"; it ignores a dropped folder |
| DWV demo | 0.36.4 (`demo/stable` at a gh-pages commit) | the study's files set on its file input; it has no drop and no folder picker |
| NiiVue with dcm2niix | the official demo at `cce6c2a` (NiiVue 0.57.0) | folder set on its folder input; once dcm2niix has converted it, the volume is picked from the demo's list, as its user must |
| BlueLight | 1.1.0 (commit `79da73b`) | folder dropped on the page |
| PlexusMD | the live site, version 1.1.0 by its asset names | folder dropped on the page |

PlexusMD has no source or build to pin. It is timed over the internet, it loads Cloudflare's analytics and it sends usage statistics, so its numbers are not like the others'. Each trial records its live asset names, and `fetch` says when they have changed.

## What it measures

Every number comes from what the screen showed. Each slice of a bench study carries its own index in a band of black and white cells (`lib/marker.mjs`), and the harness reads Chromium's trace screenshots, one for every frame that changed, so it knows which slice was on screen and when. This works the same for every viewer, with no hooks inside any of them.

| Scenario | Metrics |
|---|---|
| Open | page load; first image after the drop and which slice it was; loading done (the window's processes quiet for 2 s); CPU seconds; peak and settled memory of all the window's processes, GPU included; every request sent after the drop |
| Paging | slices per notch and direction (from single notches); then 30, 60 and 120 notches a second for one second each: distinct slices drawn per second, notches kept, longest stall, and how long the picture kept moving after the last notch |
| Window/level | a 1.5 s drag with the viewer's window/level button: redraws per second, and how long the picture kept changing after the drag stopped |

MPR and 3D are planned next.

## Fair conditions

- One Chromium for every viewer: the repository's Electron, started afresh for every trial, with an empty profile. No trial inherits another's GPU process, caches or memory, and every page load is a first visit.
- Every viewer is served from localhost: VEAcom by `web/serve.mjs` with the site's headers, the others by `lib/serve.mjs`, cross-origin isolated only when their lockfile entry says they need it.
- The same window size (1280×800 by default) and device pixel ratio for all. The window stays on top, takes no focus and ignores the real mouse, so a hand on the trackpad cannot disturb a trial.
- Each viewer gets the study the way its own user would: a dropped folder where it takes one, otherwise its file input or file chooser (the table above). The clock starts the moment the files are handed over. Each viewer keeps its default settings and layout.
- Rounds rotate the order of the viewers, and every other full rotation reverses it, so each viewer goes first, last and after each of the others equally often. The first round is a warm-up and is not counted.
- Before each trial the harness waits, for up to 20 s, until the machine is idle. It records the load, power source and thermal state with every trial.
- Results are medians with bootstrap 95% intervals. With `--aa`, VEAcom runs twice as two viewers. The gap between the two is the run's own noise, and a difference smaller than that is reported as a tie.

## Where it runs

On GitHub Actions, not on a developer's computer: `.github/workflows/browser-bench.yml` runs on a hosted Linux runner.

- **Nightly on main:** every pinned viewer, `ct-300`, 5 rounds after a warm-up, with the VEAcom A/A pair.
- **By hand:** *Actions → Browser benchmark → Run workflow* chooses the viewers (add `plexusmd` for the live site), studies, rounds and scenarios. A `base` ref adds that ref's browser build as `veacom-base`, for an A/B of two VEAcom versions in the same run.
- **On pull requests that change `tools/browser-bench/`:** a one-round smoke check of VEAcom and OHIF.

Each run posts its tables on the run's summary page and keeps the results folder, report and screenshots as an artifact for 90 days. The runner has no GPU, so every viewer draws with Mesa's software rasterizer (llvmpipe), recorded in the report. Its timings say how the viewers compare on one machine without a GPU, not how fast any of them is on a workstation. Runners also differ from run to run, so compare viewers within a run, never across runs.

## Running it by hand

```sh
pnpm run setup:runtime                      # the Electron the harness runs in
pwsh -NoProfile -File web/build.ps1         # VEAcom's engine in WebAssembly
pnpm run build:browser                      # VEAcom's browser build, in dist-web
node tools/browser-bench/bench.mjs fetch                  # the other viewers, checked
node tools/browser-bench/bench.mjs run --viewers veacom,ohif,volview,dwv,niivue,bluelight,plexusmd --aa --studies ct-300 --rounds 5
node tools/browser-bench/bench.mjs report tools/browser-bench/results/<run>
```

- `--studies ct-300,ct-1000`: generated on first use into `~/.cache/veacom-bench/studies` and checked against their manifests before every run.
- `--base <dist-web>`: adds a second VEAcom build as `veacom-base`, for an A/B of two versions on the same machine.
- `--rates 30,60,120` and `--scenarios open,paging,wl`: what to run.
- Results go to `tools/browser-bench/results/<time>/`, which git ignores: `run.json` (machine and options), `results.jsonl` (one line per trial), `shots/` (the first image and the last screen of every trial, for checking) and `report.html`.
