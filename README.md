# VEAcom

VEAcom is a standalone DICOM viewer with an Electron and React interface and a Rust imaging engine. The first departmental beta is `0.1.0-beta.1`.

## Install

On an Apple Silicon Mac, run this in Terminal. Drag VEAcom Electron to Applications when the disk image opens.

```sh
curl -fsSL https://raw.githubusercontent.com/veacom-viewer/veacom/v0.1.0-beta.3/scripts/install.sh | bash
```

On Windows x64, run this in PowerShell and follow the installer.

```powershell
irm https://raw.githubusercontent.com/veacom-viewer/veacom/v0.1.0-beta.3/scripts/install.ps1 | iex
```

The scripts download the most recently published release, including betas, and verify its SHA-256 checksum before opening the installer. Public beta `0.1.0-beta.3` is unsigned and the Mac build is unnotarized. You can also download the installers and checksums from [GitHub Releases](https://github.com/veacom-viewer/veacom/releases).

## Layout

| Folder | Contents |
| --- | --- |
| `src/` | React interface, image rendering, measurements, and assessment |
| `electron/` | Desktop main process, preload, imaging broker, export, and updates |
| `native/` | Rust imaging engine (`veacom-core`) and third-party notices |
| `public/` | Bundled Inter font and app icons |
| `telemetry/` | Collector, ClickHouse, and Google Cloud configuration |
| `tests/` | Unit tests and synthetic test inputs |
| `tools/` | Desktop, GPU, security, performance, and Windows VM checks |
| `scripts/` | Development and runtime setup helpers |
| `docs/` | Architecture, design guidelines, security, recovery, updates, and the Turkish 1.x parity checklist |

The desktop app requires no Python runtime.

## Design

VEAcom is written largely by AI models. Every model, and every person, follows the [design guidelines](docs/design-guidelines.md) when changing the interface. Pull requests are reviewed against them, and `pnpm test` checks the rules that can be tested.

## Requirements

- Node.js **26.13.0**, pinned in `.nvmrc`, and [pnpm](https://pnpm.io/installation) **12.18.0**, pinned in `package.json`. With nvm, run `nvm install` and `nvm use`.
- Rust **1.99.1**, selected by `rust-toolchain.toml`; install it with `rustup toolchain install 1.99.1 --profile minimal`.
- Native compiler tools: Xcode Command Line Tools on macOS, a C/C++ compiler and CMake on Linux, or Visual Studio C++ Build Tools on Windows. See `native/README.md` for engine dependencies.
- Google Chrome for the browser GPU checks on macOS. Desktop checks use the installed Electron runtime.

## Build and run

```sh
pnpm install --frozen-lockfile
pnpm run setup:runtime
pnpm run build:core
pnpm run build:web
pnpm start
```

Runtime setup downloads Electron from its GitHub release, checks the zip against the SHA-256 sums in the `electron` package and keeps it in the cache for later installs. Behind a proxy, set `NODE_USE_ENV_PROXY=1` so the download uses `HTTPS_PROXY`. The Rust build can take several minutes on a fresh machine. `pnpm run dev` starts the renderer and desktop app for development.

## Checks

```sh
pnpm exec tsc --noEmit
pnpm test
pnpm run build:web
cargo test --release --locked --manifest-path native/Cargo.toml
```

Use generated synthetic studies stored outside this repository for desktop checks:

```sh
node tools/desktop-smoke.cjs /path/to/studies/ct-small test-results/smoke
node tools/check-file-drop.cjs --study /path/to/studies/ct-small --output test-results/file-drop
node tools/check-open-with.cjs --study /path/to/studies/ct-small --second /path/to/studies/petct --output test-results/open-with
node tools/check-engine-recovery.cjs /path/to/studies/ct-small test-results/recovery
node tools/check-security-boundary.cjs /path/to/studies/ct-small/S01 test-results/security
node tools/check-interface.cjs /path/to/studies/ct-small test-results/interface
node tools/check-gpu-startup.cjs /path/to/studies/ct-small test-results/gpu-startup.json
```

Run desktop checks in sequence, with one VEAcom Electron instance at a time. See `tools/README.md` for GPU and platform-specific checks.

For the full local checks, run `tools/verify.sh /path/to/studies/ct-small /path/to/evidence`. It verifies the input against the synthetic fixture fingerprint before launching the viewer, then checks the exported PNG against the committed reference. See [CONTRIBUTING.md](CONTRIBUTING.md) for the review process and fixture policy. CI runs on Linux and macOS for pull requests and pushes to `main`.

The development checks use synthetic studies. Independent engine verification remains a separate migration task.

## Data and releases

Only synthetic fixtures belong in source control, screenshots, CI artifacts, or issues. Never add patient images, identifiers, or other patient data. Keep test studies and generated evidence outside source control.

Optional usage collector configuration and all ingest tokens stay outside Git. Packaged viewers send [automatic crash reports](telemetry/TELEMETRY.md#automatic-crash-reports) to a separate public intake. Sending telemetry in release builds needs the owner's approval. Secrets belong in GitHub Secrets or Google Secret Manager.

The [first departmental beta](https://github.com/veacom-viewer/veacom-private/releases/tag/v0.1.0-beta.1) was distributed privately. Future releases belong on the [VEAcom releases page](https://github.com/veacom-viewer/veacom/releases). The beta makes no automatic update requests. See [installers and updates](docs/electron-updates.md) for signing and distribution requirements.

## Licence

Copyright © 2026 the VEAcom contributors. You may use, modify and redistribute VEAcom's own code under the GNU General Public License, version 3 or any later version (`GPL-3.0-or-later`). It comes without warranty. The full terms are in [LICENSE](LICENSE).

If your department or institution plans to deploy VEAcom, we would like to hear from you. This is voluntary. [Contact the maintainers](https://github.com/veacom-viewer/veacom/issues/new/choose).

Third-party components retain their own licences. See the notices for [Inter](public/fonts/Inter-LICENSE.txt), [Lucide and Feather](public/icons/lucide-LICENSE.txt), [native codecs](native/THIRD_PARTY_NOTICES.txt) and [third-party skills](.agents/THIRD-PARTY-NOTICES.md). The [contributor agreement](CLA.md) is a draft.
