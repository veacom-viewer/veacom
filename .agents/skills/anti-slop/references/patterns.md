# Slop patterns in VEAcom

Severity is **high** when a wrong clinical number or a hidden failure can reach the reader, **medium** when it makes bugs likely or the code harder to check, and **low** when it is only noise.

## A. Clinical values (high)

The design guidelines' rule is "Fail visibly, never wrongly": when VEAcom cannot compute something correctly, it shows "unavailable" and the reason.

- **A1 Made-up value.** A default for something the file must supply: pixel spacing, slice thickness or position, orientation, frame time, patient weight or height, injected dose, injection or scan time, decay or calibration factors. `spacing[0] || 1` turns pixels into millimetres. A default the standard defines is not a finding, such as identity when there is no Modality LUT.
- **A2 Wrong name or unit.** A value called SUV, SUL, HU or mm when its inputs are missing or were refused, or a number shown without its unit.
- **A3 Silent conversion.** Units mixed (mm and cm, s and min, Bq and MBq), or a value rounded before it is used in a calculation.
- **A4 Fallback for a case that cannot happen yet.** `factor[unit] ?? 1` over a closed set of units hides the day a new unit is added. Type the table over the set (`Record<Unit, number>`) so the compiler catches it.

## B. Errors that vanish (high in `src/`, `electron/` and `native/`; medium in `tools/`)

- **B1 Swallowed error.** `.catch(() => {})`, `catch {}`, or `let _ =` on a Result that matters, with no comment saying why losing the error is right. Best-effort cleanup of a temporary folder can be right; an engine request, a file read, an export or an IPC call is not.
- **B2 Error turned into an empty result.** Returning `[]`, `0`, `null` or an empty study on failure, so the screen shows nothing instead of the reason.
- **B3 Panic on input.** `unwrap()`, `expect()` or slicing with lengths from a file, the pipe or the renderer, in non-test Rust.
- **B4 Stale result.** Async work applied after the series, slice or selection it started from has changed, or after the user cancelled. The pull request template's "State and timing" questions list the cases.

## C. Defensive code that hides bugs (medium)

- **C1 A check the types rule out.** `?.`, `??` or `if (!x)` on a value the types say is always there. Either the type is wrong where the data enters (fix it there) or the check is dead (delete it).
- **C2 The same check at every layer.** Validate once where the data enters: the engine's reply, the IPC handler, the file parser.
- **C3 try/catch around code that cannot throw.**
- **C4 Resilience nobody asked for.** Retries, timeouts, fallbacks and "graceful" paths. Each one is behaviour to test.

## D. Over-engineering (medium)

- **D1 One-call helper** with a trivial body. Inline it.
- **D2 Wrapper that only forwards** its arguments.
- **D3 Options object, constant, factory or class** for one call site with fixed values.
- **D4 A new layer** (manager, service, registry, provider) where a function would do.
- **D5 Duplicate helper.** The same logic already exists in `src/imaging`, `src/ui` or `src/domain`.
- **D6 Export nobody imports.** Drop `export` when nothing outside the file, tests included, uses it.

## E. Comments and names (low; medium when misleading)

- **E1 Narration.** A comment that restates the next line, walks through steps ("First", "Then", "Finally"), or divides sections.
- **E2 History.** "Previously", "was", "removed", "new version": git keeps the history. A comment that describes old behaviour misleads: medium.
- **E3 Vague TODO** without an issue.
- **E4 AI voice.** Names with enhanced, optimized, improved, robust or comprehensive. Comments with ensure, gracefully, properly or safely and no concrete concern.
- **E5 Hedging.** "For now", "simplified", "should work".

## F. Types (medium)

- **F1 A cast instead of a check.** `as unknown as T`, `as any`, or `!` where a check or a better type would do; a cast of the engine's reply without validating it.
- **F2 A type widened to silence an error**, such as `| undefined` added everywhere or `Record<string, any>`.

## G. Interface text (medium in a clinical reading, low elsewhere)

- **G1 AI voice.** "Successfully", "Oops", "Please note", "seamless", exclamation marks, em dashes.
- **G2 Vague failure.** "Something went wrong" without what failed and what to do next (design guidelines, "Words").
- **G3 Overstated certainty.** A heuristic presented as a finding, or a caveat in a tooltip instead of beside the value.

## H. Rust (medium; high on input paths)

- **H1 `unsafe` without a `// SAFETY:` comment** stating the invariant that makes it sound.
- **H2 `clone()` of pixel buffers** to satisfy the borrow checker, or `Arc<Mutex<_>>` where ownership could move.
- **H3 A thread outside the engine's pools.** `native/clippy.toml` disallows spawning one; do not `#[allow]` around it.

## I. Tests (medium)

- **I1 A test that cannot fail:** no assertion, or it catches the error it should see.
- **I2 Expected values copied from the code under test** instead of taken from the standard, a hand calculation or a vendor workstation.
- **I3 Testing the implementation** (counting mock calls) where a real input and output would do.
- **I4 A skipped test** without an issue.
