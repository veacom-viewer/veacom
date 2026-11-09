# AGENTS.md

Instructions for coding agents working on VEAcom. [CONTRIBUTING.md](CONTRIBUTING.md) is the full process; this file adds what agents most often get wrong.

## Working rules

- Write plain technical English in code, comments, commits and pull requests. Avoid em dashes in new text.
- Build the smallest complete change. Remove the code it makes obsolete and test the behaviour that replaces it.
- Read the changed path, its callers and its tests before editing. Look for an existing helper in `src/imaging`, `src/ui` and `src/domain` before writing one.
- Start from the standard answer: what the DICOM standard, the clinical guideline or a reference viewer does. Cite the source in a comment when the reason is not obvious from the code.
- Use a separate worktree for an independent change when the checkout holds other work, and stage explicit paths.
- Before pushing, and again after a rebase, run the checks CONTRIBUTING.md lists.

## Imaging safety

- Fail visibly, never wrongly ([design guidelines](docs/design-guidelines.md#patient-safety)). When a value needs metadata the file does not give, show it as unavailable with the reason. Never substitute a default for pixel spacing, slice position, patient weight, injected dose, times or calibration factors. A default the DICOM standard itself defines is fine, such as identity when there is no Modality LUT.
- A value is called SUV only when the engine calibrated the PET in SUV ([PET quantification](docs/pet-quantification.md)). Every number shows its unit.
- Pixels are displayed, never altered, and every measurement keeps the image it was made on.
- Synthetic data only. No patient data in code, fixtures, screenshots, logs, artifacts or issues.
- Never overwrite the export golden to make a test pass.

## Repository rules

- `tools/check-repository.mjs` rejects DICOM files, archives, keys, `.env` files, Python, symlinks, and editor or agent settings folders such as `.claude/` and `.vscode/`. Do not work around it.
- Prefer no new dependency. A new package or crate name goes into `tools/dependency-names.txt` in the same pull request, after checking who publishes it and why it arrived. Do not replace a mature parser of a hostile format (DICOM, JPEG 2000, ZIP) with hand-written code to drop a dependency.
- The React Compiler memoizes: no `useMemo`, `useCallback` or `memo` (`tools/check-react-memo.mjs`).
- `src/` and `tests/` use erasable TypeScript only: no enums, namespaces or constructor parameter properties.
- Interface text goes into both `src/i18n/en.ts` and `src/i18n/tr.ts`. An interface change follows the design guidelines and shows before and after screenshots in every language.
- Signing, publishing and release telemetry need the owner's approval.

## Skills

When the task matches, read the skill's `SKILL.md` and follow it:

- Before opening or updating a pull request: `.agents/skills/anti-slop/SKILL.md`, on the branch's diff.
- File parsing, IPC, file access, updates, the engine pipe or anything else at a trust boundary: `.agents/skills/security-audit/SKILL.md`.
- React components: `.agents/skills/vercel-react-best-practices/SKILL.md`. Its server and data-fetching rules do not apply to this desktop app.

## Read when the task needs it

- Checks, CI, Windows evidence, review and merge: [CONTRIBUTING.md](CONTRIBUTING.md).
- Interface: [design guidelines](docs/design-guidelines.md).
- Engine, its pipe protocol and API: [native/README.md](native/README.md).
- Desktop checks, click budgets and opening speed: [tools/README.md](tools/README.md).
- The Electron boundary around the engine: [imaging security](docs/imaging-security.md).
- PET numbers: [PET quantification](docs/pet-quantification.md) and [PET validation](docs/pet-validation.md).
- Browser version: [web/README.md](web/README.md).
- Usage data: [telemetry/TELEMETRY.md](telemetry/TELEMETRY.md).
