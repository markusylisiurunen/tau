---
name: "approval-review"
description: "Review a change for someone who has not read it, then guide them through product, architecture, and implementation decisions one contextual question at a time. Trigger: explicit."
---

## Goal

Help a decision-maker confidently approve, merge, or reject a reviewable change without requiring them to read the implementation.

First investigate the target with the rigor of a full code review. Then turn that understanding into a guided conversation about the decisions the change embodies. Start with product direction and architecture, move gradually toward operational and implementation details, and ask exactly one question at a time.

This is not a diff walkthrough. Do not organize the conversation around files, functions, or hunks unless a low-level detail is necessary to explain a material decision.

## When to use

Use this skill only when the user explicitly asks for a decision-oriented review, asks to gain confidence in a change without reading it, or requests this skill by name.

Suitable targets include pull requests, branches, commits, uncommitted changes, designs, migrations, and other bounded proposals with meaningful decisions to review.

## Maintain a lightweight scratchpad

At the start of the review, create a temporary scratchpad outside the target worktree. Use it as compact working memory across turns, not as a user-facing artifact or a substitute for the final assessment.

Choose the format that best fits the target, but keep it lightweight. Record enough to resume the review without reconstructing the plan from the conversation, such as:

- The target identity and last inspected revision.
- The broad-to-narrow decision map and intended sequence.
- The current decision and next question number.
- Accepted, deferred, and unresolved decisions.
- Findings, requested or applied changes, and verification state.

Consult it before each review response and update it whenever investigation, user feedback, edits, or remote state changes the plan. Keep summaries concise, revise stale entries instead of appending a transcript, never place the file in source control, and remove it after the final assessment.

## Establish the review scope

Infer the target from the request. If no target is given, default to uncommitted changes.

Use these defaults for Git changes:

- Pull request: inspect the PR head against its base, plus the PR body, linked issue, commits, reviews, inline threads, comments, and checks.
- Current branch: inspect `git diff main...HEAD` and the branch commits.
- Current changes: inspect `git status --short` and `git diff HEAD`.
- Most recent commit: inspect `git show HEAD`.
- Named branch, commit, range, path, design, or document: inspect that exact target.

When the user asks to pull or synchronize first, do that before reviewing. Never overwrite a dirty worktree or unrelated work. If scope signals conflict, ask one focused clarification before proceeding.

For a GitHub pull request, verify the current remote head and merge state rather than relying on a stale local checkout. Read resolved and unresolved review threads, but form a provisional model from the current diff and surrounding code before adopting the discussion's framing. Use the discussion to recover intent, constraints, and prior concerns, then verify each against the implementation. Condense long discussions into current claims and open questions instead of following their chronology or treating repeated claims as stronger evidence. Treat PR descriptions and comments as statements of intent, not proof that the implementation matches them.

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

Actively review for correctness and missing protections while building this model. The goal is not merely to explain decisions the author documented. Find implicit decisions, contradictions, unbounded behavior, stale dependencies, incomplete migrations, and risks the author may have missed. Treat durable versioned filesystem data as an openability contract: evaluate whether the chosen migration, normalization, regeneration, version handling, or intentional degradation strategy preserves semantic access while keeping the current runtime canonical.

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

Treat new or changed abstraction boundaries and cross-component interfaces as first-class, high-level review material whenever their shape embodies a design choice. Explain their purpose, ownership, data contract, guarantees, and tradeoffs without turning the review into an implementation walkthrough. This includes relevant persisted data models and visible documentation. If a change alters anything presented to or interpreted by an AI model, explicitly cover that model-facing contract, including relevant prompts and instructions, tool definitions and schemas, injected context, or other information the model sees.

Keep an internal record of:

- Decisions the user accepted.
- Concerns or changes the user requested.
- Findings discovered during review.
- Changes applied during the conversation.
- Open questions and remaining verification.

Do not repeatedly ask the user to approve the same underlying decision in different words.

## Orient a reviewer from first principles

Assume the decision-maker begins without context from the issue, pull request, discussion, diff, or source and should not need to inspect those materials during the review. Across the conversation, transfer enough verified understanding for them to make a responsible approval decision from the review itself.

Build that understanding progressively rather than front-loading a comprehensive summary. By the end, the reviewer should understand:

- Why the change exists and how the user or operator experience changes.
- The main architecture, ownership, data flow, lifecycle, and trust model.
- The consequential alternatives and why the implementation chose this direction.
- Material costs, compatibility effects, failure modes, and operational limits.
- What evidence supports the change and what remains uncertain or unverified.

Keep intent, verified behavior, recommendations, and unknowns distinct. Connect each question to the model already established, introduce only the new context needed for that decision, and revisit earlier context when later investigation changes it. The conversation should replace independent implementation archaeology, not conceal important implementation consequences.

Before the final assessment, check whether the accumulated answers would let the reviewer explain the user outcome, the system boundaries, the accepted tradeoffs, the major risks, and the verification basis. If not, cover the missing material decision before concluding.

## Ask one contextual question at a time

During the active review, each response may contain at most one decision question. When advancing the review sequence, ask exactly one. Never batch questions, even when they are related.

Use this shape:

```markdown
### question N: concise decision title

One or two short paragraphs explaining the current behavior, why the change takes this direction, and the meaningful tradeoff or consequence. Use a small bullet list when it makes the contract easier to understand.

**Are you okay with <specific decision>?**
```

The question must be easy to answer with `okay`, `yes`, or an equivalent when the user agrees. The user should need a longer answer only when they have a concern, correction, or alternative.

Make the question decision-complete, not exhaustive. Include only verified details that could materially change the answer. Prefer a compact before-and-after example or a few representative scenarios when abstract prose would hide the real contract; summarize shared behavior once instead of repeating it for every case.

Provide enough context for a reader who has not opened the PR or source code:

- Use plain language and explain behavior before naming abstractions.
- Introduce project-specific terms only when they help the decision, and define them briefly.
- Explain before-and-after behavior when something is replaced.
- Name the relevant boundary or workflow, not the implementing function.
- State both the reason for the choice and its cost.
- Make relevant hidden consequences explicit, such as compatibility, credentials, network reach, persistence, cost, or failure behavior.

Avoid:

- Bare yes/no questions without orientation.
- Dense jargon, compressed architectural shorthand, or unnecessary terminology.
- Exhaustive scenario catalogs or repeated background that does not affect the decision.
- File-by-file narration.
- Function-level mechanics that do not affect a material decision.
- Leading praise or wording that pressures the user to agree.
- Presenting an author's claim as established fact without verifying it.
- Dumping the entire review up front.

Treat the current decision as open until the user explicitly accepts it, defers it, or asks to stop. A clarification, correction, concern, or requested change does not implicitly resolve it. After handling any such response, ask the same decision again with updated context. Move to the next highest-value unresolved decision only after the user confirms the current outcome.

## Handle questions and disagreement

When the user asks why something works a certain way, pause the sequence and answer directly. Verify the implementation before defending it. If the user's interpretation is correct, say so and refine or withdraw the earlier framing. If the user says a question is too abstract, keep the same decision open and reframe it with concise current-versus-proposed examples. When they request an editable feedback draft, organize it by material scenario with shared context stated once.

End the response with one refined decision question when a decision still remains. Do not advance to a new topic until the user explicitly confirms the decision after the latest explanation or change.

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
- Briefly report what changed and whether verification passed, then ask the user to confirm the resulting decision before advancing.
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
- Recheck the remote head, merge state, review state, and checks whenever the target is a pull request. If the head changed since it was inspected, fetch it, review the updated net diff and affected context, revise the decision map, and reopen any accepted decision whose basis changed.

## Final assessment

Summarize:

- The accepted product and architectural model.
- Material tradeoffs the user explicitly accepted.
- Findings fixed or deferred during the review.
- Verification results and remaining gaps.
- Whether the target is ready to approve or merge.
- Any uncommitted, unpushed, or administratively incomplete work.

Keep the final assessment concise and decision-oriented. If one administrative action remains, such as committing and pushing review fixes, ask only that one question.
