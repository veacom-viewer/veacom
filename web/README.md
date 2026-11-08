# VEAcom in the browser

The desktop application's interface running in a browser (`../web.html`), with the engine compiled to
WebAssembly in a Web Worker. A dropped or chosen folder, files or ZIP are read with `File.slice()`;
nothing leaves the computer. `src/web/` holds the browser's side of the `window.veacom` bridge
(`bridge.ts`), the engine Worker and the page's Trusted Types policy.

This folder also has the first prototype's measurement page (`index.html`): it lists the series as
thumbnails and draws the middle image of the first series, with timings. Findings and timings
(Turkish): [RAPOR.md](RAPOR.md).

The interface, built and served with the site's headers:

```powershell
web\build.ps1
pnpm run build:browser
node web\serve.mjs 5200 dist-web
```

`build:browser` builds `web.html` alone into `dist-web` (`vite.web.config.ts`, checked with `tsconfig.web.json`); the
desktop's `build:web` neither includes nor needs the engine's WebAssembly modules.

Open http://127.0.0.1:5200/ (it serves `web.html`). `web/tools/app-check.cjs` drops a folder or file
from disk onto it in a hidden window and saves a picture; `web/tools/viewports.cjs` shows a study at
common screen sizes and pixel densities and reports overflow, clipped controls and image sharpness. `web/tools/export-check.cjs`
exports DICOM, DICOMDIR (anonymized), pictures and video through the interface's export dialog and checks the
downloads.

## Publishing at viewer.veacom.app

`site/` holds what Cloudflare serves:

- `prepare.mjs` makes `site/public` from the browser build (`dist-web`): `web.html` as the home page and only the
  files it uses, with the licenses of the fonts and icons, of the bundled JavaScript packages
  (`THIRD_PARTY_JAVASCRIPT_LICENSES.md`) and of the engine's Rust crates (`engine/RUST_LICENSES.txt`). Help links
  to both, and to the source. After changing `engine/Cargo.lock`, regenerate the Rust notices with cargo-about 0.9.3
  (the command is in `engine/about.toml`).
- `worker.js` adds the headers to every response (cross-origin isolation for the threads, the content policy, a year's
  caching for the hashed files under `/assets/`, `no-cache` for the rest) and answers only GET and HEAD.
- `wrangler.jsonc`: the Worker `veacom-viewer` on the custom domain viewer.veacom.app, with no workers.dev address.

```sh
pwsh -NoProfile -File web/build.ps1
pnpm run build:browser
node web/site/prepare.mjs
cd web/site
wrangler dev --ip 127.0.0.1 --port 8788
wrangler login
wrangler deploy
```

`wrangler dev` runs the site in Cloudflare's runtime on this computer (http://127.0.0.1:8788/); `login` is needed once,
and `deploy` publishes. `VEACOM_URL` points `app-check`, `export-check` and `viewports` at another address, such as
the local copy or the published site.

## Layout

- `../native`: the engine, a library (`veacom_core`) with the desktop's engine process built on it. It
  reads files through `vfs`: the computer's file system on the desktop, `memory_fs` in WebAssembly,
  where the page's files are byte sources and extracted ZIP entries live in memory. Pixel data and
  volumes are limited to 1 GiB each. All open archives share a 1 GiB extraction budget, with a
  512 MiB limit per entry. Closing the last series from an archive frees its share of the budget.
- `engine/`: the WebAssembly crate. It uses the engine without its server and without the codecs
  written in C (`default-features = false`), and turns on the pure-Rust JPEG 2000 decoder. It is
  built twice: `pkg` on one thread with the repository's stable Rust, and `pkg-threads`, where a
  series is decoded on helper Workers sharing the module's memory, with a pinned nightly Rust. The
  engine's parallel runs (`native/src/parallel.rs`) go to the helpers the page lends it
  (`src/helpers.rs`, `../src/web/engine.helper.ts`) instead of threads of its own, which a browser
  cannot start. The page uses `pkg-threads` when it is cross-origin isolated; the engine Worker and
  its helpers take half the cores, at most 4, and if the helpers cannot start the engine falls back
  to `pkg`:
  - `src/blob.rs` lists the page's File objects in `memory_fs` and reads them with `Blob.slice()`.
    The engine Worker owns those File objects. For parallel decoding it reads up to 256 MiB of
    source files into shared memory for the helpers. It decodes larger series on its own thread.
  - `src/api.rs` exposes the Worker's calls and `src/session.rs` holds its catalog.
  - `src/libc_shim.rs` provides the C library calls of `openjp2` (JPEG 2000);
  - `src/allocator.rs` ignores freeing a null pointer, which openjp2 does and WebAssembly's
    allocator does not survive;
  - no JPEG-LS (charls), and no PNG, JPEG or BMP pictures yet: the desktop decodes those in its
    renderer process, which the browser build does not have.
- `index.html`, `style.css`, `main.js`: the page. `worker.js`: runs the engine; a crashed engine is
  replaced with a fresh Worker.
- `serve.mjs`: local server with the headers the site needs: COOP/COEP, and a Content-Security-Policy
  with Trusted Types (own scripts only, connections to the site only, no HTML from text). For
  development it serves the synthetic test studies under `/__testdata/`.
- `tools/measure.cjs`: times the page with files from disk in a hidden Electron window.
- `tools/hostile.cjs`: opens hostile files one by one in the same hidden window and records whether
  each opened, was refused, or crashed the engine.
- `tools/threads-check.cjs`: opens the test studies from disk with given thread counts and records
  the times, the CPU time the page spent and its memory.

## Build and run

```sh
rustup target add wasm32-unknown-unknown --toolchain 1.99.1
rustup toolchain install nightly-2026-11-01 --profile minimal --component rust-src --target wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
pwsh -NoProfile -File web/build.ps1
node web/serve.mjs
```

`build.ps1` runs with PowerShell 7 on Windows, macOS and Linux. `node web/serve.mjs 5199 dist-web` serves the browser
build (`pnpm run build:browser`) with the site's headers; add `--no-isolation` to serve it as a host without them would,
where the page runs the single-thread engine. CI's `browser` job builds both engines and opens a test study that way,
with and without the headers (`tools/browser-check.mjs`). The test studies for `?test=` are read from the folder
`VEACOM_TESTDATA` names.

Open http://127.0.0.1:5199/ and drop a folder or ZIP. `?test=petct|bigct|calisma|jtwok|jpegll&rounds=N`
opens a test study. `&prefetch=1` reads up to 64 KiB per file ahead of import, up to 16 MiB in total.
Files larger than 16 MiB are read on demand. `&checksum=1` adds a SHA-1 of every decoded series (lossless copies must match).
`&threads=N` picks the build (1: one thread; N > 1: the engine's thread and N − 1 helpers); `&hold=N` lowers the limit for
holding a series' files, to time the decoding of a series too large to hold.

The tools below run in Electron. A shell started from an Electron application may set
`ELECTRON_RUN_AS_NODE`, which makes Electron run as plain Node: remove it first
(`Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell, `unset ELECTRON_RUN_AS_NODE` elsewhere).

Timing with files from disk (server running):

```sh
pnpm exec electron web/tools/measure.cjs 5
```

One thread against a pool of 4 (results in `threads-check.jsonl`, or `THREADS_OUT`):

```sh
pnpm exec electron web/tools/threads-check.cjs 1,4
```

Hostile files (any folder of them, plus one good file to open afterwards):

```sh
pnpm exec electron web/tools/hostile.cjs <folder> <good.dcm>
```

The same engine code timed natively from disk:

```sh
cd web/engine
cargo run --release --example bench -- <folder or zip>
```

## Full cleanup in the browser

A full cleanup export keeps the pixels, so the reader first confirms that the selected series show no identifying text,
as on the desktop. The desktop asks in its own window, which the page cannot reach. The browser asks in its own
`confirm()` dialog, a page of 12 series at a time, so every selected series is shown, and the engine exports only the
catalog revisions confirmed (`export.pixelReview`).

That dialog is no approval from outside the page: nothing in a page can approve above the page itself. A page changed
to skip it (from the browser's developer tools, or by an attack) could as well export without any cleanup, which needs
no review. In the browser the dialog is a check for the reader, not a security boundary.
