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
  files it uses, with the licenses of the fonts and icons.
- `worker.js` adds the headers to every response (cross-origin isolation for the threads, the content policy, a year's
  caching for the hashed files under `/assets/`, `no-cache` for the rest) and answers only GET and HEAD.
- `wrangler.jsonc`: the Worker `veacom-viewer` on the custom domain viewer.veacom.app, with no workers.dev address.

```powershell
. D:\veacom-dev\veacom-viewer-env.ps1
web\build.ps1
pnpm run build:browser
node web\site\prepare.mjs
cd web\site
D:\veacom-dev\tools\wrangler\node_modules\.bin\wrangler dev --ip 127.0.0.1 --port 8788
D:\veacom-dev\tools\wrangler\node_modules\.bin\wrangler login
D:\veacom-dev\tools\wrangler\node_modules\.bin\wrangler deploy
```

`wrangler dev` runs the site in Cloudflare's runtime on this computer (http://127.0.0.1:8788/); `login` is needed once,
and `deploy` publishes. `VEACOM_URL` points `app-check`, `export-check` and `viewports` at another address, such as
the local copy or the published site.

## Layout

- `../native`: the engine, a library (`veacom_core`) with the desktop's engine process built on it. It
  reads files through `vfs`: the computer's file system on the desktop, `memory_fs` in WebAssembly,
  where the page's files are byte sources and extracted ZIP entries live in memory. In WebAssembly
  its size limits are lower (pixel data and volumes 1 GiB, extracted ZIP data 1 GiB, 512 MiB per
  entry), since everything shares 4 GB.
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
    A File can be read only by the Worker that received it, so before a series is decoded on the
    helpers its files are held whole in shared memory (up to 256 MiB; a larger series is decoded on
    the engine's own thread, as is everything else that reads the page's files);
  - `src/api.rs` is what the Worker calls; `src/view.rs` the session behind it;
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

```powershell
. D:\veacom-dev\veacom-viewer-env.ps1
rustup target add wasm32-unknown-unknown
rustup toolchain install nightly-2026-11-01 --component rust-src --target wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
web\build.ps1
node web\serve.mjs
```

Open http://127.0.0.1:5199/ and drop a folder or ZIP. `?test=petct|bigct|calisma|jtwok|jpegll&rounds=N`
opens a test study; `&prefetch=1` reads every file's first 64 KiB in parallel before the engine
starts; `&checksum=1` adds a SHA-1 of every decoded series (lossless copies must match);
`&threads=N` picks the build (1: one thread; N > 1: the engine's thread and N − 1 helpers); `&hold=N` lowers the limit for
holding a series' files, to time the decoding of a series too large to hold.

The tools below run in Electron. A shell started from an Electron application may set
`ELECTRON_RUN_AS_NODE`, which makes Electron run as plain Node: remove it first
(`Remove-Item Env:ELECTRON_RUN_AS_NODE`).

Timing with files from disk (server running):

```powershell
D:\veacom-dev\veacom-viewer\node_modules\electron\dist\electron.exe web\tools\measure.cjs 5
```

One thread against a pool of 4 (results in `threads-check.jsonl`, or `THREADS_OUT`):

```powershell
D:\veacom-dev\veacom-viewer\node_modules\electron\dist\electron.exe web\tools\threads-check.cjs 1,4
```

Hostile files (any folder of them, plus one good file to open afterwards):

```powershell
D:\veacom-dev\veacom-viewer\node_modules\electron\dist\electron.exe web\tools\hostile.cjs <folder> <good.dcm>
```

The same engine code timed natively from disk:

```powershell
cd web\engine
cargo run --release --example bench -- <folder or zip>
```
