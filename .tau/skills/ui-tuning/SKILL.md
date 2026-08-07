---
name: "ui-tuning"
description: "Refine subjective UI details through small, production-faithful iterations, then finish the chosen design with cleanup and verification. Trigger: balanced."
---

# UI tuning

## Goal

Help the user settle visual and interaction details without turning every experiment into a finished production change. Keep iteration narrow and reversible, then complete the engineering work once the direction is accepted.

Use this skill for substantial subjective tuning such as color, spacing, animation, glyphs, wrapping, density, and interaction feel. Do not use it for routine UI bug fixes with one objectively correct result.

## Establish the boundary

Before editing, inspect the real rendering path, state updates, theme tokens, shared primitives, and relevant tests. Do not infer production behavior from a nearby component or an isolated render.

Identify the phase from the user's request:

- **Proposal-only:** explain current behavior and concrete options without editing.
- **Preview-only:** change only an isolated preview or experiment.
- **Production iteration:** make narrow production edits so the user can evaluate them.
- **Closeout:** transfer the accepted result, clean up, update coverage and documentation, and verify.

Treat an explicit phase as a hard scope boundary. Do not move preview work into production or turn preparation into publishing without a clear instruction. Ordinary production-editing requests do not require another permission round.

## Iterate minimally

When the shape is still being decided:

- Change only the smallest set of values or behavior needed to evaluate the current idea.
- Prefer one or a few related adjustments over a broad redesign.
- Keep each step easy to reverse and describe the visible difference plainly.
- Reuse production tokens, dimensions, timing, and rendering rules. If a disposable preview would materially help comparison, keep it isolated and faithful to production.
- Do not update tests, snapshots, documentation, or unrelated cleanup while the user is still choosing details, unless they explicitly ask or the experiment cannot proceed without it.
- Keep the affected code buildable. Run the smallest useful compile or check after meaningful production edits rather than the full closeout suite after every tweak.
- Preserve approved details while changing the next one. Do not silently revisit earlier choices.

Do not create a preview by default. A preview earns its cost when the user needs to compare subjective alternatives that are awkward to judge through repeated production edits.

## Finish the chosen design

When the user accepts the direction or asks to finish:

1. Transfer only the approved choices into the canonical production path.
2. Remove disposable previews and experimental code unless the user explicitly wants to keep them.
3. Re-read the cumulative diff for inconsistent values, duplicated paths, temporary controls, and accidental scope growth.
4. Update focused tests and existing documentation that describe the changed behavior.
5. When behavior depends on updates over time, test the relevant creation-to-update path rather than only an isolated component.
6. Run the repository's required formatting, checks, build, and tests.

Do not preserve both the experiment and production implementation as parallel paths. The accepted result should have one clear owner.

## Output

During iteration, report only what visibly changed and the smallest useful verification result. At closeout, summarize the accepted result, cleanup, and final verification without replaying the full experiment history.
