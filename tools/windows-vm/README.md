# Windows checks

Windows evidence for a pull request comes from two places, both driven by files in this repository only.

| Where | What runs | How |
| --- | --- | --- |
| Hosted Windows job ([`.github/workflows/windows.yml`](../../.github/workflows/windows.yml)), Windows Server 2022, no GPU | Frozen pnpm install, desktop runtimes, locked Rust release build with `dumpbin /dependents`, Rust release tests, web build, unit tests (`node --test`, JUnit report; the ISO test has a normal PATH), app-local Visual C++ runtime, a frozen install of `packaging/` (electron-builder, kept out of the root install), `electron-builder --dir`, the packaged engine and runtime check, the NSIS installer built `--prepackaged`. Then, drawing through WARP: the video encoder check, packaged desktop smoke with `VEACOM_SMOKE_RENDERER=software`, `check-software-rendering --expect software`, the padding pixels, file drop and the security boundary. Silent install into a folder named after the product, smoke and file drop on the installed app, then silent uninstall with the folder, registration and processes checked. | Add the `windows` label to the pull request. It runs once then, not on every push: to test a later push, remove the label and add it again, or run the workflow by hand on the branch. Release tags (`v*`) run it too. Evidence is the run's `windows-<run id>` artifact. |
| Windows VM (Google Cloud, Windows Server 2022, Tesla T4; named in your local settings file, below) | The build again, then the T4 plan: the video encoder with the GPU on, packaged desktop smoke drawing on the T4, the click budgets and their coverage on the fingerprinted `ct-small`, `check-software-rendering --expect hardware`, the padding pixels on the T4, GPU startup, and real Windows mouse input on the frameless window (`ui-windows-checks.cjs`). | `tools/windows-vm/vm.sh`, below. Evidence is a zip downloaded to `test-results/windows-vm/`. |

The hosted job also runs the interface check and GPU startup on WARP. Window chrome with real mouse input runs on the VM only. The runner's screen is 1024 x 768, and at 150 % zoom the check's 1200 x 720 window puts Help's close button off-screen.

Renderer and window-chrome changes need the VM run. Engine and packaging changes need the hosted job. The VM costs money while it runs, so start it only with the owner's go-ahead.

## Not covered by either

- Independent engine checks (codecs, colour, export, shutdown, cancel, Modality LUT, codec guard, HTTP, byte order, watchdog, adversarial files), the source-display check, study workflows and the archive force-quit cleanup proof. They need Python tools that stay in the old repository, and this repository takes no Python.
- The PNG export golden: it was captured on Apple Silicon and is not compared on Windows.
- Engine crash recovery: the probe is POSIX-only and runs on macOS.
- Scroll and window/level latency: the VM composes at about 30 Hz while a viewer redraws. Use a real PC.
- Windows 10 or 11 on a real or hospital PC, and signed builds.
- Generating `ct-small` itself: it is made by `bench/studies.py` in the old repository. The VM already holds it at `C:\veacom\bench-data\studies\ct-small`, and the build checks it against `tests/golden/ct-small.json`.

## The VM sequence

Once per computer: install and sign in to `gcloud`, then name the VM and its SSH files in `~/.config/veacom/vm.env`. That file stays outside the repository, so the project, zone, instance and key paths are never committed:

```sh
VEACOM_VM_PROJECT=your-project
VEACOM_VM_ZONE=your-zone
VEACOM_VM_INSTANCE=your-windows-vm
VEACOM_VM_SSH_KEY=~/path/to/id_ed25519
VEACOM_VM_KNOWN_HOSTS=~/path/to/known_hosts
# Optional: VEACOM_VM_ACCOUNT=you@example.com (a gcloud account other than the default)
# Optional: VEACOM_VM_PORT=22338 (the local end of the IAP tunnel)
```

`vm.sh` reads only these `KEY=value` lines and never runs the file. The same names set in the environment take precedence, and `VEACOM_VM_CONFIG` points at a different file. The VM needs a `veacom` Windows user that is logged in to the desktop and OpenSSH Server on port 22, reached only through IAP. Then, from a clean checkout of the commit to test:

```sh
tools/windows-vm/vm.sh start 90     # fixed stop time 90 minutes ahead, then start the VM (costs money)
tools/windows-vm/vm.sh tunnel       # IAP tunnel to the VM's SSH port on localhost (VEACOM_VM_PORT)
tools/windows-vm/vm.sh run pr27     # stage HEAD, build, run the T4 plan, download the evidence
tools/windows-vm/vm.sh stop pr27    # clean up, stop the VM, confirm TERMINATED, close the tunnel
```

`run` is `stage`, `build`, `checks` and `collect`, which also work one at a time. `vm.sh stage pr27 <ref>` stages another commit; `vm.sh status pr27` prints every phase. A full run took about ten minutes with warm caches for pull request 25, and 16 minutes from a cold build for pull request 29. The commit must contain this kit, so merge `main` into an older branch first.

What each phase does on the VM:

1. **Stage** (`stage.ps1`). `vm.sh` makes `git archive --format=zip` of the commit, uploads it with `stage.ps1` from the same archive, and runs that script with the archive's SHA-256 and the instance's `terminationTime`. It writes the deadline file, checks the hash and the commit stored in the zip comment, rejects unsafe paths, refuses to replace a folder something still runs from, and replaces `C:\veacom\<name>` with exactly the archive's files. Only `node_modules` and `native\target` carry over from an earlier staging of the same name, so a deleted file cannot linger and `release-electron` is always rebuilt. Extracted files get the staging time, because `git archive` stamps them with the commit time and cargo would otherwise keep an engine built from newer sources. Earlier evidence moves to `C:\veacom\<name>-evidence.previous-<time>`.
2. **Build** (`launch-build.ps1`, `build.ps1`). Runs as the logged-in `veacom` user in an interactive scheduled task, so it outlives SSH: pnpm through `get-pnpm.ps1` (checksum-pinned), frozen installs of the root and of `packaging\` (electron-builder), desktop runtimes, the `ct-small` fingerprint, the locked Rust release build with vcvars, the web build, `scripts\windows-runtime.ps1` and `electron-builder --dir`. Each step records its result and the others still run, but a step whose inputs failed is skipped rather than run on stale output. The engine must be newer than the staging and identical in the package. A Node version that differs from `.nvmrc` is reported as a warning.
3. **T4 checks** (`launch-checks.ps1`, `launch-fallback.ps1`, `run-fallback.ps1`). Writes the plan to `C:\veacom\<name>-evidence\t4\plan.json` and runs it in the desktop session with only System32 and Windows on PATH. Each step runs even when an earlier one fails. A check whose tool is not in the commit (such as `tools/check-video-encoder.cjs` before pull request 25) or whose build step failed is recorded as skipped, with the reason. The plan stops before any step if the T4 is missing or disabled.
4. **Collect** (`collect.ps1`). Writes `summary.json` with the verdict, the commit, the hashes, the machine and what is not covered, then zips the evidence entry by entry with forward slashes, leaving out videos over 5 MB, crash dumps and PNGs over 2 MB. `vm.sh` downloads the zip and checks its SHA-256.
5. **Stop** (`cleanup.ps1`). Removes finished `VEAcom-*` tasks, turns the T4 back on if something left it disabled, and lists kit processes still running. Then `vm.sh` stops the instance, confirms `TERMINATED` and closes the tunnel.

`status.ps1` ends with `VEACOM-STATUS: running|passed|failed|error`, and `vm.sh` waits on that line. A phase with no result and no running task, or whose task ended while its result still says running, is an error, so a wait never runs to its limit on a dead task.

## Fixed stop deadline and budget

- Every session gets a fixed GCP stop time before the VM starts: `vm.sh start <minutes>` sets `--termination-time` with `--instance-termination-action=STOP` on the stopped instance, and refuses to touch a running one.
- `vm.sh stage` reads that `terminationTime` from the instance, never from the local clock, and `stage.ps1` writes it to `C:\veacom\vm-stop-deadline.txt`. Every kit script reads the file and stops launching work 5 minutes before the deadline. Nothing in the kit extends it. If time runs short, stop the VM and start a new session.
- Always finish with `vm.sh stop`, and check the console if it reports a problem. The VM must end `TERMINATED` with the tunnel closed.
- Budget: US$100 authorised in total for this VM, about US$1.50 an hour while it runs. Check the VM project's billing report before a session, and add a line here after it.

| Date | Run | Time | Cost |
| --- | --- | --- | --- |
| 2026-11-07 | veacom-viewer/veacom-private#25 | 78 min | about US$2 |
| 2026-11-07 | veacom-viewer/veacom-private#29 merged with veacom-viewer/veacom-private#27, the kit's first run (cold build, all 8 T4 checks passed) | 16 min | about US$0.40 |

Earlier sessions, from 2026-11-03 to 2026-11-06, are not itemised here; the billing report has them.

## Traps this kit designs out

- `remote.py` (outside the repository) prepends a line to a script's text, so a script that starts with `param()` failed silently. `vm.sh` sends only an invocation line, `$ProgressPreference = 'SilentlyContinue'; & '<script>' -Name '<value>'`, and every script runs from its file.
- A status script that printed nothing kept a wait loop running to its limit, about 50 idle VM minutes once. See `status.ps1` above, and test a status command once before looping on it.
- The desktop runner limits PATH to System32 and Windows, where `powershell.exe` is missing and the ISO test fails. `Assert-Plan` refuses the unit tests (`node --test`) in a plan; they run in the hosted job.
- Windows PowerShell 5.1 runs these scripts. `tools/check-powershell.ps1`, run in CI, rejects parse errors, PowerShell 7 syntax and non-ASCII characters.
- A T4 left disabled survives reboots and silently puts the app on WARP. `RequireGpu` stops the T4 plan, and `cleanup.ps1` re-enables the adapter. `display-adapter.ps1 -Action Status|Enable|Disable` does it by hand.
- After a restart the desktop can come back at 1280 x 800. `fallback.json` records the screen size; `ui-windows-checks.cjs` is sized for 1280 x 800.

## Files

| File | Runs on | Purpose |
| --- | --- | --- |
| `vm.sh` | Mac or Linux | Start, tunnel, stage, build, checks, status, collect, stop |
| `check-vm-sh.sh` | CI (Linux) | Runs `vm.sh`'s invocation line through PowerShell without a VM: every parameter binds by name |
| `stage.ps1` | VM, over SSH | Deadline, archive checks, swap of the source folder |
| `Common.ps1` | VM | Deadline guard, JSON, plan check, scheduled tasks, logged processes |
| `get-pnpm.ps1` | VM | Checksum-pinned Windows pnpm |
| `launch-build.ps1`, `build.ps1` | VM | Build in the desktop session |
| `launch-checks.ps1` | VM, over SSH | Writes the T4 plan and starts it |
| `launch-fallback.ps1`, `run-fallback.ps1` | VM | Runs any plan of desktop checks in the desktop session |
| `status.ps1`, `collect.ps1`, `cleanup.ps1` | VM, over SSH | Progress, evidence, end of session |
| `display-adapter.ps1` | VM | Turns the T4 on or off and records the adapters |
| `ui-windows-checks.cjs` | VM | Real mouse input on the frameless window, with screen captures |

The Python-based scripts of the old kit (`unpack.ps1` with `stage.py`, `independent-native.ps1`, `setup-python313.ps1`, `run-gui.ps1`, the archive force-quit proof, the screen benchmarks) are gone from this repository; they still run from the old one.
