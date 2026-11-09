## Change

Describe the problem and resulting behaviour. Link the migration item or issue.

## Verification

List exact commands, results, platforms, and the commit tested. Link local/macOS and required Windows evidence. Identify checks not run.

## Imaging correctness

For each, state **unchanged** or describe the evidence:

- Pixels and window/level:
- Geometry and orientation:
- Measurements:
- Decoding:
- Export:

## State and timing

For anything that waits (engine requests, workers, timers, dialogs, child processes, exports), say what happens when:

- it is started again while it runs, or retried after a failure:
- the user cancels, or the page, window or engine goes away while it runs:
- what it read when it started (series, slice, catalog entry, selection) has changed by the time it finishes:
- the object that ends it (timer cleanup, job permit, temporary folder) goes away before the work does:

Write "not applicable" when nothing waits.

## Accessibility and interface

- Keyboard path, focus, and accessible names:
- Before and after screenshots of every changed screen, in every interface language:
- Screen recording, when the change involves motion, timing or a flow of more than one step:
- Checked against [the design guidelines](../docs/design-guidelines.md):

## Review

- [ ] Synthetic data only; no patient data, endpoints, or tokens in this PR or evidence.
- [ ] Contributor agreement checked for each author, if in effect (see `CLA.md`).
- [ ] Claude reviewed the current commit; blocking findings resolved.
- [ ] Anti-slop audit (`.agents/skills/anti-slop/SKILL.md`) of the current commit; high and medium findings fixed.
- [ ] CI and local verification passed; Windows checks passed where required.
- [ ] Owner approval recorded for any signing, publishing, or release telemetry.
