# Design guidelines

VEAcom is written largely by AI models. This page is the design brief that every model, and every person, follows when changing the interface. Read it before doing interface work. Reviewers check pull requests against it. A rule marked **(tested)** fails `pnpm test` when broken; a rule marked **(type-checked)** fails `pnpm exec tsc --noEmit`.

## The bar

VEAcom's users are clinicians, mostly doctors, deciding about patients. They are often tired, interrupted and short of time. Hold the interface to the standard of a flight deck: a trained user never has to wonder what VEAcom is doing, what state it is in, or whether a number is right, and a first-time user gets through the common tasks without help. It should also feel like the best modern software: instant, calm and exact.

The image is the work. The chrome around it is dark, quiet and flat, and nothing decorative competes with the pixels. It is one app for every specialty: a surgeon and a nuclear medicine doctor open the same VEAcom, and each finds their own screen.

## Principles

1. **Use the routine view when a study opens.** PET/CT opens in one fused axial pane. Four-pane PET reporting, SPECT/CT and whole-body reading screens are available on request. A layout the reader explicitly kept for PET/CT takes precedence. [Arrangements](arrangements.md)
2. **A specialty is data, not chrome.** A new specialty adds an arrangement, or a better default for a kind of pane. Its screen goes in the menu of the control it belongs to, as the nuclear medicine screen sits beside the fusion button. It does not add a toolbar button, a mode or a module. If it seems to need one, ask the owner first.
3. **Every automatic action says what it did and can be undone.** Use a notice in the pane with Undo, as arrangements and the DWI/ADC pairing do.
4. **Every number says what it is.** It carries its unit and says when it is approximate. Never call a value SUV unless it is one, and write "sample max" for an interpolated maximum.
5. **Fewer controls.** Before adding a control, show that it cannot be a better default, part of an arrangement, or part of an existing control.
6. **Nothing covers the image unless the reader asks.** Information goes in notices and panels beside the image, not in modal dialogs.

## Flight-deck rules

These come from aviation human factors, where interfaces are designed for tired experts under pressure.

- **Dark and quiet.** When everything is normal, the interface adds nothing: no "loaded successfully", no green ticks, no confirmations of what the reader can already see. Only what needs attention lights up, so that anything lit means something.
- **Three alert levels, each with one meaning.** Colour never carries the level on its own; a word or an icon always does too.

  | Level | Meaning | Look | Stays |
  | --- | --- | --- | --- |
  | Warning | The image or a number may be wrong for this patient: series from two patients in one comparison, a measurement on an uncalibrated image, a value that cannot be computed | `--danger*` | until the reader dismisses it |
  | Caution | Something limits how far a value can be trusted: approximate, interpolated or missing metadata | `--warning*` | next to the value, while it is shown |
  | Advisory | Information only | neutral | clears itself, but never while the reader is reading or using it |

  A box in a panel that lists warnings or cautions always has a dismiss button (X) at its top right: use `WarningBox` **(tested)**. Dismissed, it stays hidden for the session until what it says changes, and the marks beside the values it explains stay.
- **Mode awareness.** The left-button tool, whether panes are linked, the arrangement in use, and anything else that changes what a click does are visible at a glance, and named in the status bar. A mode changes only because the reader changed it, or through an announced arrangement with Undo.
- **No automation surprises.** Anything VEAcom does by itself answers three questions, in the pane where it happened: what it did, why, and how to undo it.
- **Same place, same meaning.** A control never moves between studies, specialties or window sizes. When space runs out, controls fold into the overflow in a fixed order. A word means the same thing everywhere, and a shortcut never changes meaning.
- **Sterile moments.** While the reader is scrolling, measuring or windowing, nothing pops up, moves or asks a question. Notices wait until the gesture ends.
- **Checklists, not memory.** A clinical task with several steps, such as a pre-operative check or PET acquisition quality control, is a checklist the app keeps. "Not assessable" is a valid answer.
- **Prevent errors instead of reporting them.**
  - Disable what cannot work, and say why on hover.
  - Constrain inputs to valid units and ranges rather than rejecting them afterwards.
  - Never offer an action that will fail.
- **Read back before the irreversible.** An action that cannot be undone or that leaves the machine (exporting with patient data, writing a disc) states in one line exactly what will happen before it runs. Everything that can be undone uses Undo instead.

## Patient safety

- **Who and which side, always.** Every image pane, including fused and reconstructed ones, shows the orientation markers, and shows the patient's identity unless the reader has hidden it. Every exported picture carries the orientation markers too.
  - When studies of two different patients are on screen together, a warning says so.
  - A prior study shows its date.
- **Never silently change clinical data.** Pixels are only ever displayed, never altered. Every measurement remembers the image it was made on. Any change of calibration or scale is announced.
- **The image is shown as DICOM defines it.** Use the modality and VOI LUTs and the stored window. No sharpening, smoothing or contrast curve is applied to make it prettier.
- **Show uncertainty next to the number.** If a value is approximate, interpolated, or depends on missing metadata, the caveat sits beside the value, not in a log or a tooltip alone.
- **Fail visibly, never wrongly.** When VEAcom cannot compute something correctly, it shows "unavailable" and the reason, never a plausible-looking guess.
- **Nothing is lost.** What the reader creates (measurements, notes, layouts) survives a crash, an update or a closed window.

## Premium feel

- **Instant.** The image responds to input within one frame, and the rest of the interface within 100 ms. Anything that takes longer than a second shows its progress, what it is doing, and Cancel. Loading never blocks what is already available: show the first slices while the rest arrive.
- **Stable.** Nothing jumps. Panels keep their space while content loads, and numbers use tabular figures so they don't jitter while they change.
- **Calm.** Use one accent colour and at most one primary action per view. Use three font weights: 400 for text, 500 for labels and controls, 600 for headings and emphasis.
- **Exact.**
  - Lines sit on whole pixels and icons share one grid.
  - Corner radii come from the tokens.
  - Truncated text always has a tooltip with the full text.
- **Fast for experts.** Every frequent action has a shortcut. The shortcut is shown in its tooltip and in the keyboard help.
- **Motion with a reason.** Motion only shows where something came from or went. It takes at most 150 ms and stops when the system asks for reduced motion. VEAcom makes no sounds.
- **Empty states teach.** An empty pane or panel says, in one line, what to do next.
- **Short words.**
  - Labels are at most three words.
  - Sentences are at most 20 words and start with the verb or the news.
  - No "please", no "successfully".

## Banned

- **Side stripes.** No coloured or thick border down one side of a card, panel, notice, row or chip. That means:
  - no `border-left`, `border-right`, `border-inline-start` or `border-inline-end` except a 1px divider in a `--line` token **(tested)**;
  - no inset `box-shadow` that draws a bar **(tested)**;
  - no bar drawn with a `::before` or `::after` element.

  A one-sided border is only ever a 1px divider between panes or between segmented buttons. Show state with a full border, a background token, an icon or a word instead.
- **Decorative effects.** Don't add gradients, glows, glass or blur effects, or text shadows to the interface. The palette swatches show palettes, which is data, not decoration.
- **Decorative icons.** No emoji as icons, no decorative icon beside every heading, and no sparkle or "AI" iconography.
- **Nesting.** No cards inside cards, and no badges or pills where a word would do.
- **Hype.** No exclamation marks, marketing words, or claims such as "AI-powered" or "smart".
- **Distractions.** No spinners over the image, no toasts while the reader works on the image, no tours or tips that pop up unasked.

## Visual language

Everything comes from the tokens in [`src/theme.css`](../src/theme.css). Every `var(--…)` an interface file uses must be defined there **(tested)**. Add a token there rather than putting a raw colour or size in a component.

- **Colour.** Dark only.
  - Surfaces use `--bg-*`, lines `--line*` and text `--text*`.
  - There is one accent, `--accent*`, for selection, focus and the primary action.
  - The status colours (`--danger*`, `--warning*`, `--success*`) are only for the alert levels above.
  - `--measure` is only for drawings on the image.
  - Text keeps at least 4.5:1 contrast on the surface it sits on. Recompute contrast when changing a token.
- **Type.** Inter, bundled in `public/`, at the `--text-xs` to `--text-2xl` sizes. Use sentence case.
- **Space and shape.**
  - Spacing uses the 4px steps `--space-1` to `--space-6`.
  - Corners use `--radius-sm`, `--radius` and `--radius-lg`.
  - Controls are `--control-sm`, `--control` or `--control-lg` high, and nothing clickable is smaller than 24px.
- **Depth.** Only what floats has a shadow (`--shadow-popover`, `--shadow-dialog`). Panels are flat and separated by 1px lines.
- **Motion.** State changes take `--motion-fast` or happen instantly. Only the reader and cine move the image.
- **Icons.** Use the Lucide shapes in [`src/components/icons.tsx`](../src/components/icons.tsx) and the toolbar glyphs in `src/assets/glyphs.json`. Add a missing shape from lucide.dev. Every icon-only control has an accessible name and a tooltip.

## Words

- Every string exists in every interface language: `src/i18n/en.ts` and `src/i18n/tr.ts` today **(type-checked)**. Write each language as its clinicians speak it, rather than translating word for word.
- Say what happened and what to do next, in plain words.
- Always show units: HU, mm, SUVbw, SUL, SUVbsa, Bq/ml. A PET without SUV calibration is shown "on its own values".

## Interaction and accessibility

- Every control works from the keyboard, shows the `:focus-visible` ring, and has an accessible name. Prefer native `button`, `select` and `input` elements.
- Single-key shortcuts go through the existing setting that turns them off.
- Every control has a stable `data-action` id listed in `electron/usage-schema.json` **(tested)**.
- Prefer Undo to a confirmation dialog.

## Measuring ease of use

- **Click budgets.** Common tasks have click budgets in `tools/click-budgets.json`. A change must not make them longer, and a new common task gets a budget.
- **Usage timings.** Where readers hesitate, repeat or undo, the usage data shows it. Look there before guessing.
- **Critical tasks.** These must succeed for a first-time user without help:
  - confirm the patient and the side;
  - open the right series;
  - measure a length;
  - read a value with its unit;
  - compare with a prior;
  - export anonymised.

  Test every interface change that touches them with someone who has not seen it before, as medical device usability engineering requires.

## Before opening a pull request

- **Show the change.** For every changed screen, put a before and an after screenshot side by side in the PR summary, in every interface language. Add a short screen recording (MP4 or GIF) when the change involves motion, timing, or a flow of more than one step, such as an arrangement appearing, a drag, Undo, or a gesture. Use synthetic studies only. Keep the files out of the code change: upload them with `gh pr create --attach <file>` or `gh pr edit <number> --attach <file>` (gh 2.99.0 or later), repeating the flag for each file. Where the summary already references a file, as in `![Before](./before-en.png)`, `gh` points that reference at the upload. Don't host screenshots on a branch: their links stop working once the branch is deleted.
- Run `pnpm test`, which includes the rules marked tested.
- If a rule blocks something the owner asked for, ask the owner. Don't work around the test.

Changing these guidelines needs the owner's approval.

## Where these rules come from

- Flight-deck alerting levels and colour: FAA Advisory Circular 25.1322-1, *Flightcrew Alerting*.
- Dark and quiet cockpit: Airbus's "dark cockpit" philosophy.
- Mode awareness and automation surprises: Sarter and Woods's research on flight-deck automation.
- Sterile moments: the FAA's sterile flight deck rule, 14 CFR 121.542.
- Usability engineering for medical devices: IEC 62366-1, and the FDA's *Applying Human Factors and Usability Engineering to Medical Devices* (2016).
- Patient identity: The Joint Commission's National Patient Safety Goal on using two patient identifiers.
- Response times: Jakob Nielsen's limits of 0.1 s for instant, 1 s for keeping flow, and 10 s for keeping attention.
