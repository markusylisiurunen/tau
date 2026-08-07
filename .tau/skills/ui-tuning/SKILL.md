---
name: "ui-tuning"
description: "Refine subjective UI details through small, production-faithful iterations, then finish the chosen design with cleanup and verification. Trigger: balanced."
---

# UI tuning

## Goal

Help the user settle visual and interaction details through focused, buildable changes. Keep experiments cheap without leaving unfinished engineering work in the accepted result.

Use this skill for substantial subjective tuning such as color, spacing, animation, glyphs, wrapping, density, and interaction feel. Do not use it for routine UI bug fixes with one objectively correct result.

## Establish the boundary

Inspect the real rendering path, state updates, theme tokens, shared primitives, and relevant tests before recommending or changing a design. Do not infer production behavior from a nearby component or an isolated render.

Follow the scope stated in the request:

- **Proposal-only:** explain current behavior and concrete options without editing.
- **Preview-only:** change only the authorized isolated preview or experiment.
- **Production iteration:** make narrow production edits for the user to evaluate.
- **Closeout:** integrate the accepted choices within the authorized scope, remove experiments, and complete verification.

These are possible boundaries, not mandatory stages. A direct implementation request should produce a finished change without an extra approval round. Use the lighter iteration workflow below only when the user has explicitly asked to try alternatives or iterate before closeout. Accepting a preview settles the design choice, not permission to change production, commit, or publish.

## Iterate minimally

While the user is choosing details:

- Change only the values or behavior needed to evaluate the current idea. Keep adjustments related and easy to reverse.
- Reuse production tokens, dimensions, timing, and rendering rules. Respect repository theme and ownership conventions.
- Preserve approved details while changing the next one. Do not silently revisit earlier choices.
- Keep affected production code buildable and run focused checks for meaningful behavior changes. Do not defer correctness, security, or state-transition regression coverage.
- Defer tests, snapshots, and documentation that merely encode unsettled visual choices until closeout, unless the user asks for them sooner. Avoid unrelated cleanup.

Do not create a preview by default. Use one only when it materially helps compare alternatives, keep it isolated and faithful to production, and obey repository restrictions on interactive tools and development servers.

## Finish the chosen design

When the user asks to finish, or accepts the direction within an already authorized production task:

1. Integrate only the accepted choices into the canonical production path. For preview-only work, finish the preview without transferring it into production.
2. Remove disposable experimental code created for the task within the authorized scope. Preserve unrelated work and follow repository safeguards for destructive operations.
3. Re-read the cumulative diff for inconsistent values, duplicated paths, temporary controls, and accidental scope growth. Do not leave an experimental implementation as a parallel production path.
4. Update focused tests and existing documentation where the accepted change affects supported behavior. When behavior depends on updates over time, cover the relevant transition rather than only an isolated render.
5. Run the repository's required formatting, checks, build, and tests. Report any verification or visual evaluation that could not be performed.

## Output

During iteration, briefly describe the visible change, focused verification, and deferred closeout work. At closeout, summarize the accepted result and final verification without replaying the experiment history. Do not claim visual confirmation from compilation or automated tests alone.
