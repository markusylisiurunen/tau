---
name: "decision-review"
description: "Review a change for someone who has not read it, then guide them through product, architecture, and implementation decisions one contextual question at a time. Trigger: explicit."
---

## Goal

Help a decision-maker confidently approve, merge, or reject a reviewable change without requiring them to read the implementation.

First investigate the target with the rigor of a full code review. Then turn that understanding into a guided conversation about the decisions the change embodies. Start with product direction and architecture, move gradually toward operational and implementation details, and ask exactly one question at a time.

This is not a diff walkthrough. Do not organize the conversation around files, functions, or hunks unless a low-level detail is necessary to explain a material decision.

## When to use

Use this skill only when the user explicitly asks for a decision-oriented review, asks to gain confidence in a change without reading it, or requests this skill by name.

Suitable targets include pull requests, branches, commits, uncommitted changes, designs, migrations, and other bounded proposals with meaningful decisions to review.

## Establish the review scope

Infer the target from the request. If no target is given, default to uncommitted changes.

Use these defaults for Git changes:

- Pull request: inspect the PR head against its base, plus the PR body, linked issue, commits, reviews, inline threads, comments, and checks.
- Current branch: inspect `git diff main...HEAD` and the branch commits.
- Current changes: inspect `git status --short` and `git diff HEAD`.
- Most recent commit: inspect `git show HEAD`.
- Named branch, commit, range, path, design, or document: inspect that exact target.

When the user asks to pull or synchronize first, do that before reviewing. Never overwrite a dirty worktree or unrelated work. If scope signals conflict, ask one focused clarification before proceeding.

For a GitHub pull request, verify the current remote head and merge state rather than relying on a stale local checkout. Read resolved and unresolved review threads. Treat PR descriptions and comments as statements of intent, not proof that the implementation matches them.

## Understand the change before asking questions

Do not begin the guided conversation after reading only a summary or diff stat. Build an end-to-end mental model first.

Read the full change and enough surrounding code, tests, documentation, configuration, protocol definitions, and call sites to understand:

- The problem being solved and the intended user outcome.
- What behavior is replaced, added, removed, or made default.
- The main data flow, ownership boundaries, and lifecycle.
- Public contracts, configuration, storage, protocol, and compatibility changes.
- Trust boundaries, credentials, authorization, isolation, and network access.
- Defaults, limits, costs, failure behavior, and operational assumptions.
- User-visible UX, observability, documentation, and migration effects.
- Dependencies and external services introduced or removed.
- What tests prove, what they do not prove, and the current verification state.

Actively review for correctness and missing protections while building this model. The goal is not merely to explain decisions the author documented. Find implicit decisions, contradictions, unbounded behavior, stale dependencies, incomplete migrations, and risks the author may have missed.

Do not claim the change is safe, complete, or merge-ready until the evidence supports it.

## Build a decision map

Before asking the first question, organize the material decisions from broadest to narrowest. A useful ordering is:

1. Product goal, replacement strategy, availability, and intentional breaking changes.
2. User-visible workflows, defaults, policy, and business behavior.
3. Architecture, data flow, ownership, trust, and security boundaries.
4. Public APIs, provider choices, configuration, persistence, and protocol compatibility.
5. Lifecycle, cancellation, concurrency, cost, performance, and resource limits.
6. UX, output contracts, observability, attribution, and documentation.
7. Lower-level implementation choices that materially affect reliability or future design.

Adapt the order to the target. Do not ask about low-value implementation trivia. Skip decisions already dictated unambiguously by the user's request or repository policy unless an important consequence still needs confirmation.

Keep an internal record of:

- Decisions the user accepted.
- Concerns or changes the user requested.
- Findings discovered during review.
- Changes applied during the conversation.
- Open questions and remaining verification.

Do not repeatedly ask the user to approve the same underlying decision in different words.

## Ask one contextual question at a time

During the active review, each response may contain at most one decision question. When advancing the review sequence, ask exactly one. Never batch questions, even when they are related.

Use this shape:

```markdown
### question N: concise decision title

Two or more short paragraphs of context explaining the current behavior, why the change takes this direction, and the meaningful tradeoff or consequence. Use a small bullet list when it makes the contract easier to understand.

**Are you okay with <specific decision>?**
```

The question must be easy to answer with `okay`, `yes`, or an equivalent when the user agrees. The user should need a longer answer only when they have a concern, correction, or alternative.

Provide enough context for a reader who has not opened the PR or source code:

- Define project-specific terms before using them.
- Explain before-and-after behavior when something is replaced.
- Name the relevant boundary or workflow, not the implementing function.
- State both the reason for the choice and its cost.
- Make hidden consequences explicit, especially compatibility, credentials, network reach, persistence, cost, and failure behavior.

Avoid:

- Bare yes/no questions without orientation.
- File-by-file narration.
- Function-level mechanics that do not affect a material decision.
- Leading praise or wording that pressures the user to agree.
- Presenting an author's claim as established fact without verifying it.
- Dumping the entire review up front.

When the user accepts a question, move directly to the next highest-value unresolved decision.

## Handle questions and disagreement

When the user asks why something works a certain way, pause the sequence and answer directly. Verify the implementation before defending it. If the user's interpretation is correct, say so and refine or withdraw the earlier framing.

End the response with one refined decision question when a decision still remains. Do not advance to a new topic until the current one is resolved.

When the user disagrees or proposes another direction:

1. Restate the concern in concrete terms.
2. Investigate the relevant code or external contract as needed.
3. Explain the viable choices and their consequences.
4. Recommend one direction when the evidence supports it.
5. Ask one focused question that resolves the decision.

Accuracy matters more than preserving the reviewer's original framing.

## Surface review findings as decisions

When investigation reveals a real gap, do not hide it inside neutral explanation. Distinguish it from an intentional design choice.

Use this shape:

```markdown
### question N: current behavior leaves <risk> unbounded

Explain what is currently bounded, what remains unbounded, and the concrete failure or abuse mode. Give a proportionate recommendation with a proposed value or contract when possible.

**Should the change add <specific protection> before approval?**
```

Only surface findings that are actionable, introduced by the target, and supported by evidence. Do not manufacture questions from speculative concerns.

For external APIs or infrastructure contracts, inspect authoritative documentation when practical. Say when a conclusion depends on an external assumption.

## Apply feedback during the review

Default to conversational review without changing files merely because a question was asked. Once the user clearly requests a change or accepts a concrete recommendation to change the target, implement it without asking for another permission round.

When applying feedback:

- Update all owning contracts, tests, model-facing documentation, repository guidance, and user-facing docs affected by the change.
- Prefer canonical changes over compatibility scaffolding unless compatibility is explicitly required.
- Run the smallest useful verification immediately.
- Briefly report what changed and whether verification passed before asking the next question.
- Keep uncommitted changes visible in the final summary.

Do not commit, push, merge, or open a pull request unless the user explicitly asks. If they did ask as part of the original task, carry that through after verification.

If the user requests a read-only review, collect requested changes instead of editing and summarize them at the end.

## Know when to stop

Continue until all material product, architecture, business, trust, compatibility, lifecycle, and operational decisions have been covered, plus any lower-level choice that could reasonably change the approval decision.

Do not keep asking questions merely to be exhaustive. Stop when the remaining details are routine implementation mechanics that are already tested and consistent with accepted decisions.

Before the final assessment:

- Re-read the net change, including edits made during the review.
- Confirm removed systems left no dependencies, configuration, protocol values, documentation, or tests behind.
- Run project-required formatting, checks, build, and tests when changes were applied.
- Recheck remote PR status and CI when the target is a pull request and the branch was pushed.

## Final assessment

Summarize:

- The accepted product and architectural model.
- Material tradeoffs the user explicitly accepted.
- Findings fixed or deferred during the review.
- Verification results and remaining gaps.
- Whether the target is ready to approve or merge.
- Any uncommitted, unpushed, or administratively incomplete work.

Keep the final assessment concise and decision-oriented. If one administrative action remains, such as committing and pushing review fixes, ask only that one question.
