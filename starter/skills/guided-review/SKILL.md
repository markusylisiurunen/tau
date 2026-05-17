---
name: "guided-review"
description: "Split large diffs or change sets into natural review chunks, then guide the user through focused diff_review sessions. Trigger: explicit."
---

## Goal

Turn an overwhelming review scope into a short sequence of coherent review chunks. Each chunk should be small enough to understand in one sitting and large enough to preserve the relevant context.

Use this skill only when the user explicitly asks for guided review, to split a diff into reviewable pieces, or to walk through changes step by step.

## Determine the review scope

Infer the scope from the request. If no scope is given, default to uncommitted changes.

Use these defaults:

- Current changes or uncommitted changes: inspect `git status --short` and `git diff HEAD`.
- Current branch: inspect `git diff main...HEAD`.
- Most recent commit: inspect `git show HEAD`.
- A named branch, commit, range, or path: inspect that exact scope.

If the request contains conflicting scope signals, ask one clarifying question before doing review work.

## Understand intent before chunking

Do not start by mechanically grouping files. Build enough understanding of what the change is trying to accomplish so the chunks reflect the author's intent.

Start with the full diff or change summary, then read surrounding code, relevant tests, types, call sites, and related patterns as needed. Identify the main behavior changes, supporting refactors, dependency order, and risk areas. Trace how changed files interact so each chunk preserves the context a reviewer needs.

Only create the chunk plan once you can explain the overall purpose of the change and the role each major file group plays. If the intent is still unclear after exploration, say what is unclear and ask a focused question before launching reviews.

## Build a chunk plan

Group review chunks by coherent purpose. Prefer natural boundaries over equal sizes.

Good chunk boundaries include:

- One feature or behavior change and its tests.
- One subsystem or package.
- A migration or schema change with the code that consumes it.
- A UI surface and its state/model changes.
- Documentation or configuration changes that explain or enable the same behavior.
- A risky cross-cutting change isolated from low-risk mechanical edits.

Not every changed line deserves the same review attention. Rank chunks by review value and call out which ones are highest-risk or most important. You can skip or briefly summarize low-value noise, such as generated output, mechanical formatting, lockfile churn, or repetitive renames, as long as doing so does not hide meaningful net behavior changes.

Avoid these mistakes:

- Do not split implementation from its tests when they need to be reviewed together.
- Do not group unrelated files just because they are small.
- Do not create chunks so tiny that the user loses context.
- Do not hide risky files inside a large miscellaneous chunk.
- Do not force the user through noisy or low-value chunks when a summary is enough.

Present a concise chunk plan with each chunk's label, scope, relative importance, and why it belongs together. Explicitly note any low-value noise you plan to skip or only summarize. If there are many chunks, start with the highest-risk or most foundational one.

## Launch focused diff reviews

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

After each review returns, inspect the feedback before moving on. If the review surfaces issues and the user expects implementation help, address them immediately, update the code, and re-check the affected net changes before launching the next chunk. Do not start the next chunk while feedback from the current chunk remains unresolved, unless the user explicitly defers it.

This keeps the review sequence honest: by the end, the user should have reviewed the final net changes, not an earlier version that was later modified by fixes from prior chunks.

If the user only wants guided review without implementation, summarize the returned feedback, mark the chunk as reviewed, and ask whether to continue.

Keep the sequence explicit. Tell the user which chunks are complete, which were skipped or summarized as low-value noise, which feedback was addressed, and which chunks remain.
