---
name: anti-slop
description: Audit a VEAcom change for the slop that compilers and linters cannot judge, such as clinical values made up when metadata is missing, errors that vanish, defensive code that hides bugs, needless abstraction, narrating comments and AI voice in interface text. Use before opening or updating a pull request, after a large AI-written change, or when asked to check for slop.
---

# Anti-slop audit

Audit the branch's diff, fix what it finds, and report the rest. The patterns are in [references/patterns.md](references/patterns.md).

## Steps

1. **Scope.** Diff the branch against the main branch it will merge into. Use the remote that points at github.com/veacom-viewer/veacom, often `origin`:

   ```sh
   base=$(git merge-base HEAD origin/main)
   git diff --stat "$base"
   git diff "$base"
   ```

   Audit code in `src/`, `electron/`, `native/`, `web/`, `tools/` and `tests/`, and interface text in `src/i18n/`. Skip generated files and fixtures.

2. **Run the tools first.** Run the checks CONTRIBUTING.md lists and fix what they report. Do not repeat their findings here.

3. **Read each hunk in context.** Read the whole function around it and search for the callers of anything added or changed. A hunk on its own hides most slop.

4. **Check the patterns**, most severe group first. This search finds leads on added lines. Each lead still needs reading:

   ```sh
   git diff -U0 "$base" -- src electron native web tools tests \
     | grep -E '^\+.*(\?\? *[01]\b|\|\| *[01]\b|\.catch\(\(\) *=>|catch *(\([^)]*\))? *\{ *\}|as unknown as|\.unwrap\(\)|unsafe *\{)'
   ```

5. **Fix** high and medium findings in the same change unless the owner says otherwise. Do not edit code outside the diff; list what you saw there separately.

6. **Report** in the pull request or a review file, as CONTRIBUTING.md asks: the commit audited, the files audited, then the findings ranked by severity.

   | Severity | Where | Pattern | Problem | Fix |
   |---|---|---|---|---|
   | high | `path/to/file.ts:88` | A1 | Spacing falls back to 1 mm when the file has none, so a length in pixels is shown in mm | Show the length in pixels and say why |

   When nothing is found, write "No findings" with the commit and the files.

## What counts

- A finding names a concrete failure: this input gives this wrong result, or this change hides this failure. A style preference is not a finding.
- Before flagging a fallback, trace the value to its source (the engine's reply, a DICOM attribute, the user) to see whether it can be missing.
- Keep comments that give a reason the code cannot show: a DICOM section (PS3.x), a guideline, a measurement or an owner's decision. That is the comment style VEAcom wants.
- A fix adds no dependency, abstraction or fallback.
