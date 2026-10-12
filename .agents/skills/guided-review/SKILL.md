---
name: "guided-review"
description: "Split large diffs or change sets into natural review chunks, then guide the user through focused review sessions, one per chunk. Uses an interactive diff review tool (for example diff_review) when the harness provides one, and an in-conversation review otherwise. Use only when the user explicitly names this skill or active repository or skill instructions explicitly require it; do not activate merely because a task is related. Trigger: explicit."
---

## Goal

Turn a review scope that is too large to take in at once into a guided review with two phases:

1. **Orientation.** A brief that explains the change and prepares the reviewer.
2. **Focused reviews.** A sequence of diff reviews, one per chunk. You collect the user's comments without editing files and bring them together in a final overview.

Each chunk should be small enough to understand in one sitting and large enough to keep the context it needs.

Use the `clear-writing` skill for all communication with the user. This includes the orientation brief, clarifying questions, chunk preambles, transitions between chunks, and the final overview.

## Before phase 1

### Determine the review scope

Infer the scope from the request. If the request names no scope, review the current uncommitted changes. If it names a branch, commit, range, or path, review exactly that.

If the request points to conflicting scopes, ask one clarifying question before doing any review work.

### Understand the change

Do not start by grouping files mechanically. Understand what the change is trying to do, so that the brief and the chunks follow the author's intent.

Get an overview of the whole change first, in whatever way suits its size. Then read the surrounding code, tests, types, call sites, and related patterns as needed. Identify the main behavior changes, the supporting refactors, the dependency order, and the risk areas. Trace how the changed files interact, so each chunk keeps the context a reviewer needs.

Pay special attention to changed boundaries: anything that users, tools, or other components use to call or depend on this code, such as an API route, a command-line flag, a database schema, or a config key. A change to a wrapper or declaration may not be obvious from the implementation chunk alone. If such a change affects how another component calls the feature, cover it in the orientation brief.

Trace any trust or safety model that is central to the change, for example how credentials are handled, what input is validated, or what happens when two operations run at once. Understand who can do what, how access is granted and revoked, and which failure modes the reviewer should keep in mind.

Write the brief and the chunk plan only when you can explain:

- the overall purpose of the change,
- the role of each major file group,
- the caller-facing surfaces that changed,
- the core safety and lifecycle assumptions.

If the intent is still unclear after exploring, say what is unclear and ask a focused question before starting any reviews.

## Phase 1: plan the chunks and write the orientation brief

Do not open any chunk review during phase 1. If the harness provides an interactive diff review tool, do not call it yet.

### Plan the chunks

Group chunks by a shared purpose. Prefer natural boundaries over equal sizes. Examples of good chunks:

- One behavior change together with its tests.
- One module, package, or subsystem.
- A change to stored data or its format, together with the code that reads and writes it.
- A risky cross-cutting change, kept apart from low-risk mechanical edits.

When a change affects data that must stay readable across versions, such as saved files or database records, review the format change, how existing data is still read or migrated, and the tests that cover existing data together, as one high-risk chunk.

Rank chunks by review value and mark which are the riskiest or most important. Low-value noise, such as generated output or mechanical formatting, can be skipped or only summarized, as long as this does not hide meaningful net behavior changes.

Avoid these mistakes:

- Splitting an implementation from its tests when they need to be reviewed together.
- Grouping unrelated files just because they are small, when they would be clearer reviewed with the chunks they relate to. A separate chunk of small, unrelated, low-risk leftovers is fine when it keeps the main chunks focused.
- Making chunks so small that the user loses context.
- Hiding risky files inside a large miscellaneous chunk.
- Making the user review noisy, low-value chunks when a summary is enough.

### Write the brief

Write a concise brief that tells the story of the change and gives the reviewer a mental model before they look at code. It should read as a narrative, without turning into a checklist or a file-by-file inventory. Use headings so it is easy to skim. Do not paste large diffs or long file lists.

Present each piece of information in the form that is fastest to understand, and mix forms freely:

- **Prose** for intent, motivation, reasoning, and the flow of the story.
- **Small code blocks** for concrete contracts and mechanics, such as a type signature, a data shape, or stripped-down control flow. Use minimal real syntax. When the source form is compact enough, prefer it over an invented table. A short code example is often faster to absorb than a prose explanation.
- **Bullets** for short enumerations, such as changed entry points, risk items, or chunk names.

A useful order is: the problem or intent, then the main mechanics and lifecycle, then the concrete caller-facing contract changes, then the review focus areas and the chunk map. The chunk map can be a short list when that is clearest.

The brief should give the reviewer what they need to understand the change and to know where to look. Every brief needs the overall intent of the change and the chunk plan: the total number of chunks, and each chunk's number, label, scope, relative importance, and why its parts belong together. Beyond that, include what matters for this particular change and leave out what does not apply. Depending on the change, that may include:

- Changes in mechanics, such as how data, state, and failures move through the system.
- Changes to contracts or shapes that callers or other components depend on, such as an API response or a storage format.
- The trust and safety model and how the change affects it.
- Important behavior changes and their user-visible effects.
- The riskiest areas or assumptions.
- Low-value noise you plan to skip or only summarize.
- Named entry points that were added or modified, each with one brief explanation. An entry point is any surface that a caller or another component must know about, such as a command, an exported function, or an event. Keep this list selective and leave out boilerplate.

A small refactor may need only a few sentences of intent and a two-item chunk map. A change to authentication or a storage format needs much more. Be concrete about whatever you include: name the actual functions, fields, and failure cases instead of describing them in general terms.

### Pause

End phase 1 by pausing and asking whether to start phase 2. Do not open the first chunk until the user explicitly tells you to start.

## Phase 2: review each chunk

### Open the review

How you open a chunk review depends on the harness. Check which tools you have before you start phase 2. The preamble, the feedback collection, and the final overview are the same in every harness.

#### When an interactive diff review tool is available

An interactive diff review tool shows the user a diff, lets them comment on it, and returns their feedback to you. The harness may provide it as a built-in tool, through MCP, or by some other mechanism, and its name can be anything. Judge it by its purpose. If you have such a tool, use it once for each chunk.

A tool named `diff_review` is likely to be an interactive diff review tool, but check its interface before using it. If it accepts a `source` input with `git_diff` and `patch_files` options, use these inputs:

- Prefer `source: "git_diff"` when `git diff` arguments can represent the chunk cleanly, especially path-limited scopes such as `["main...HEAD", "--", "src/foo.ts", "test/foo.test.ts"]` or `["--", "src/foo.ts"]`.
- Use `source: "patch_files"` only when a path-limited `git diff` is not precise enough, such as for selected hunks, hand-picked subsets, or several custom patches. Patch files must contain git unified diff sections with `diff --git` headers. If the available tools cannot write patch files, explain the limitation and use a broader `git_diff` chunk.

For any other interactive diff review tool, including a `diff_review` tool with a different interface, follow its own interface. Limit each call to the chunk's scope, preferring path-limited diffs as above.

#### When no interactive diff review tool is available

Ask the user to review the chunk themselves, in whatever tool they prefer:

1. Tell the user exactly which diff to review, as a path-limited command they can run, such as `git diff main...HEAD -- src/foo.ts test/foo.test.ts`.
2. Ask them to come back with their comments, referring to the file and line where possible, or to say that the chunk is done or should be skipped.
3. Wait for the reply before moving on.

Immediately before every review, write a short preamble for the user. It must state:

- Which chunk is being reviewed, its position in the sequence (for example "chunk 2 of 5"), and how important it is.
- What the chunk does in the broader change.
- Why the scope belongs together and what context connects its files or hunks.
- What the user should focus on.

Example:

"Chunk 2 of 5: next I want you to review the session-runner chunk: `src/core/session/runner.ts` plus its focused tests. This is a high-value chunk because it changes the handoff point for phased tool UI events, so it controls whether progress events can interleave safely with final tool results and abort handling. Focus on whether the runner drains intermediate UI updates correctly without losing the final result."

Then open the review for exactly that chunk, using the interactive diff review tool if one is available. Otherwise, ask the user to review it in their own tool.

### Collect feedback

After each review returns, read the feedback before moving on. Do not start the next chunk until the current one is complete, deferred, or explicitly skipped by the user.

- Do not edit files. Implement nothing unless the user later asks.
- Keep track of the comments, findings, open questions, and follow-up items in your working context for the final overview. You do not need to write them to a file.
- Do not repeat or summarize the user's feedback after each chunk, unless an ambiguity blocks the next review.
- Move to the next chunk with a short transition. Ask before continuing only if the user asked for pauses or the feedback raises a blocking question.

Keep the sequence visible. Tell the user which chunks are complete, which were skipped or only summarized as low-value noise, and which remain.

### Write the final overview

When all chunks are done, write a final overview that brings the comments together. Group related comments by theme, subsystem, or severity, and point out duplicates, contradictions, open questions, and likely next actions. Do not just join the per-chunk notes together.
