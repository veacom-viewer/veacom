# Imaging engine recovery

Electron owns one Rust imaging-engine child. An unexpected exit or a fatal framing or pipe error invalidates its connection immediately. The app allows two replacement attempts per application session, after 250 ms and 1 second. The budget does not reset when a replacement becomes ready, so a repeated crash cannot create an endless restart loop.

The manager never replays requests or imports. The interrupted operation fails. A replacement starts with an empty catalog, and the user sees a notice. A fresh user import can then proceed. After the restart budget is exhausted, loaded images remain available and the notice asks the user to reopen the app.

The last displayed image, study entries, annotations, and undo history survive. On native GPU views, reopen the study to page or reconstruct additional frames after the engine restarts. Views with a decoded volume in the renderer can still page that volume. Native-dependent actions on an old study—loading additional frames, reading tags, or exporting DICOM—require reopening that study. Series and connections carry an engine generation; the API and export handlers reject mismatches. An export dialog left open across a restart cannot switch silently to the new engine.

`core:state` reports `starting`, `ready`, `restarting`, `failed`, `stopping`, or `stopped`, plus generation, restart count, and a message. It contains nothing that reaches the engine. Main's engine connection is current only while ready; the pipes of an engine that stopped answer nothing. Renderer requests are cancelled on a reset, and late decoded response bodies are rejected. The recovery hook clears transient work without replacing the retained catalog.

Startup failure and the 30-second readiness timeout clean up the owned child before returning an error. App shutdown disables recovery first, asks the engine to shut down and cancels active exports. After an acknowledged shutdown, main waits for export rollback before closing stdin and starting its forced-exit timer. An engine whose stdin closes (its app quit or crashed) stops on its own. Stale exit events cannot invalidate a replacement connection.

## Validation

- `node --import ./tests/setup.ts --test tests/engine-process.test.ts tests/engine-connection.test.ts`: actual fake-engine subprocesses plus renderer response races, covering crashes, fixed retry budget, failed replacements, an engine speaking another protocol, timeout, shutdown (also by closing stdin), stale events, and no import replay.
- `node tools/check-engine-recovery.cjs STUDY OUTPUT`: local macOS/Linux Electron probe. It kills only the engine whose parent is that isolated Electron process, checks the replacement catalog is empty, verifies identical rendered pixels and retained annotations, exercises paging and undo/redo, and performs a fresh import. The proof records the native binary SHA-256. This checks lifecycle behavior; it does not establish clinical correctness of that binary.
