---
name: "guided-review"
description: "Split large diffs or change sets into natural review chunks, then guide the user through focused diff_review sessions. Trigger: explicit."
---

## Goal

Turn an overwhelming review scope into a two-phase guided review:

1. An orientation brief that explains the change and prepares the reviewer.
2. A sequence of focused diff reviews, run in the review mode the user chooses.

Each review chunk should be small enough to understand in one sitting and large enough to preserve the relevant context.

Use this skill only when the user explicitly asks for guided review, to split a diff into reviewable pieces, or to walk through changes step by step.

## Determine the review scope

Infer the scope from the request. If no scope is given, default to uncommitted changes.

Use these defaults:

- Current changes or uncommitted changes: inspect `git status --short` and `git diff HEAD`.
- Current branch: inspect `git diff main...HEAD`.
- Most recent commit: inspect `git show HEAD`.
- A named branch, commit, range, or path: inspect that exact scope.

If the request contains conflicting scope signals, ask one clarifying question before doing review work.

## Determine the review mode

Phase 2 must run in one explicit mode. Honor the mode if the user already specified it. If the mode is not specified, ask the user to choose at the end of phase 1, before opening the first diff review.

Supported modes:

- `collect-only`: collect the user's review comments without editing files. Keep a running record of findings, open questions, and follow-up items for a final synthesis after all chunks are reviewed. Do not implement anything unless the user later asks.
- `apply-as-you-go`: address review comments immediately after each chunk, then have the user review the resulting net changes before moving to the next chunk.

Treat natural-language equivalents like "regular review," "collect comments," or "don't make changes" as `collect-only`. Treat requests like "make the changes right away" or "address comments as we go" as `apply-as-you-go`.

Do not infer `apply-as-you-go` just because feedback is actionable. If the user's intent is ambiguous, default to asking rather than editing.

## Understand intent before phase 1

Do not start by mechanically grouping files. Build enough understanding of what the change is trying to accomplish so the orientation and chunks reflect the author's intent.

Start with the full diff or change summary, then read surrounding code, relevant tests, types, call sites, and related patterns as needed. Identify the main behavior changes, supporting refactors, dependency order, and risk areas. Trace how changed files interact so each chunk preserves the context a reviewer needs.

Only create the orientation brief and chunk plan once you can explain the overall purpose of the change and the role each major file group plays. If the intent is still unclear after exploration, say what is unclear and ask a focused question before launching reviews.

## Phase 1: write the orientation brief

Phase 1 prepares the reviewer. Do not call `diff_review` during phase 1.

Write a concise reviewer briefing that tells the story of the change and gives the reviewer the mental model they need before looking at code. It should read like a well-written narrative, not a checklist or a file-by-file inventory. Use headings to make it skimmable. Do not paste large diffs or long file lists.

Choose the right medium for each piece of information. Use prose for intent, motivation, reasoning, and narrative flow. Use small code blocks (pseudo-code, type signatures, JSON shapes, and the like) to show concrete changes: a before/after of a response type, a stripped-down snippet of new control flow, how a lifecycle was reordered. Showing is often faster to absorb than the equivalent explanation in prose. Use bullets for compact enumerations like chunk names, risk items, or field additions. Mix these freely; the goal is that every piece of information appears in the form that makes it fastest to understand.

A useful structure is: start with the problem or intent, then show the main mechanics and how contracts or shapes change, then call out review focus areas and the chunk map. The chunk map can be a compact list when that is the clearest format.

The brief should cover:

- The overall intent and story of the change.
- Important changes in mechanics, such as data flow, state transitions, or lifecycle behavior.
- Any contract or shape changes, such as APIs, response types, schemas, or config formats.
- The most important behavior changes and user-visible effects.
- The riskiest areas or assumptions the reviewer should keep in mind.
- The chunk plan: each chunk's label, scope, relative importance, and why it belongs together.
- Any low-value noise you plan to skip or only summarize, such as generated output, mechanical formatting, lockfile churn, or repetitive renames.

End phase 1 by pausing. If the review mode is unknown, ask the user to choose `collect-only` or `apply-as-you-go`. If the mode is known, ask whether to start phase 2 in that mode. Do not open the first chunk unless the user explicitly tells you to start phase 2.

## Build a chunk plan

Group review chunks by coherent purpose. Prefer natural boundaries over equal sizes.

Good chunk boundaries include:

- One feature or behavior change and its tests.
- One subsystem or package.
- A migration or schema change with the code that consumes it.
- A UI surface and its state/model changes.
- Documentation or configuration changes that explain or enable the same behavior.
- A risky cross-cutting change isolated from low-risk mechanical edits.

Not every changed line deserves the same review attention. Rank chunks by review value and call out which ones are highest-risk or most important. You can skip or briefly summarize low-value noise as long as doing so does not hide meaningful net behavior changes.

Avoid these mistakes:

- Do not split implementation from its tests when they need to be reviewed together.
- Do not group unrelated files just because they are small.
- Do not create chunks so tiny that the user loses context.
- Do not hide risky files inside a large miscellaneous chunk.
- Do not force the user through noisy or low-value chunks when a summary is enough.

## Phase 2: launch focused diff reviews

Use the `diff_review` tool for each chunk when it is available.

Prefer `source: "git_diff"` when a chunk can be represented cleanly with `git diff` arguments, especially path-limited scopes such as `["main...HEAD", "--", "src/foo.ts", "test/foo.test.ts"]` or `["--", "src/foo.ts"]`.

Use `source: "patch_files"` only when path-limited `git diff` is not precise enough, such as selected hunks, hand-curated subsets, or multiple custom patches. Patch files must contain git unified diff sections with `diff --git` headers. If writing patch files would require read-write access that is not available, explain the limitation and either use a broader `git_diff` chunk or ask the user to switch risk level.

## Required preamble before each review

Immediately before every `diff_review` call, write a short user-facing preamble that orients the user for the chunk they are about to review. Keep it concise, but make sure the user has enough context before the review opens.

The preamble must state:

- Which chunk is being reviewed and how important it is.
- What the chunk is intended to accomplish in the broader change.
- Why this scope is coherent and what context connects the files or hunks.
- What the user should focus on while reviewing.

Example:

"Next I want you to review the session-runner chunk: `src/core/session/runner.ts` plus its focused tests. This is a high-value chunk because it changes the handoff point for phased tool UI events, so it controls whether progress events can interleave safely with final tool results and abort handling. Focus on whether the runner drains intermediate UI updates correctly without losing the final result."

Then call `diff_review` for exactly that chunk.

## Between chunks

After each review returns, inspect the feedback before moving on. Keep the review mode explicit and do not start the next chunk until the current chunk is complete, deferred, or explicitly skipped by the user.

In `collect-only` mode:

- Do not edit files.
- Record the comments, findings, and open questions for a final synthesis after all chunks are reviewed.
- Do not echo or summarize the user's feedback chunk-by-chunk unless an ambiguity blocks the next review.
- Between chunks, use only a terse transition and continue according to the agreed flow. Ask before continuing only when the user requested pauses or the feedback raises a blocking question.

At the end of `collect-only` mode, write a final review overview that draws the comments together across all chunks. Group related comments by theme, subsystem, or severity; call out duplicates, contradictions, open questions, and likely next actions. Do not just concatenate per-chunk notes.

In `apply-as-you-go` mode:

- Address clear review comments immediately.
- Ask a focused question before editing when feedback is ambiguous or sounds like discussion rather than a requested change.
- Run the smallest useful checks for the affected code when practical.
- Re-check the affected net diff after editing.
- Present the fix summary and have the user review the updated changes before moving on. Prefer a follow-up `diff_review` for the current chunk or a focused patch containing the fix.
- Repeat this loop until the user says the chunk is complete, explicitly defers remaining feedback, or asks to skip the follow-up review.

Never leave code changes unreviewed. Any file you edit while addressing feedback must be included in a follow-up review or explicitly deferred by the user before you launch the next chunk. If a fix touches files planned for a later chunk, update the chunk plan and tell the user how the scope changed.

Keep the sequence explicit. Tell the user which chunks are complete, which were skipped or summarized as low-value noise, and which chunks remain. In `apply-as-you-go` mode, also state which feedback was addressed before asking for the required follow-up review.
