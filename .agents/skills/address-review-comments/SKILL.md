---
name: "address-review-comments"
description: "Work through unresolved pull request review comments, one at a time by default or in batches when asked. Agree on each fix before editing, then implement the fixes and close the threads. Use only when the user explicitly names this skill or when active repository or skill instructions explicitly require it. Do not activate just because a task is related. Trigger: explicit."
---

## Goal

Turn unresolved pull request comments into an agreed, verified set of changes. The user should not have to decode reviewer shorthand or implementation jargon. Use the `clear-writing` skill for all communication with the user.

The workflow has four phases, and each one waits for the user before the next begins:

1. Load the review.
2. Discuss each comment and agree on an outcome.
3. Implement the accepted fixes when the user asks.
4. Close the review when the user asks.

## 1. Load the review

This workflow needs an installed, authenticated `gh` with access to the target repository. If it is unavailable, report the blocker. Do not install it or authenticate on the user's behalf.

Identify the pull request from the request or the current branch. Use `gh` to read the complete pull request discussion and to fetch the review threads, including whether each is resolved or outdated. Work on unresolved, current threads, and read the surrounding discussion to understand intent.

Before presenting a comment, read enough of the source and surrounding code to verify it. Do not assume every comment is valid. When a reviewer has misunderstood something, say so directly.

## 2. Discuss the comments

### Pace

Present one unresolved comment per response by default. If the user explicitly asks for batches of N, present at most N per response, and keep that batch size for the rest of the discussion unless the user changes it. Batching changes only how many comments appear together.

After each response, wait for the user. They may ask questions, challenge the premise, ask for more evidence, or explore alternatives. Answer directly, inspect more source or discussion when needed, and keep refining the explanation and proposal until the user understands the issue and is satisfied with the solution. A follow-up question is never acceptance, and a reasonable proposal is no reason to move on. Move to the next comment or batch only after the user has accepted, rejected, or deferred every comment in the current one.

Do not edit code during this phase unless the user explicitly asks to change that behavior.

### How to present a comment

Assume the user has not read the diff and does not have the relevant subsystem in mind. Explain any term or part of the code they would need that context to understand. Use this shape:

```markdown
### Comment N/T: plain-language consequence

<Brief narrative: what the code is trying to do, the condition that breaks it, and the concrete result.>

<Optional: a short snippet, pseudo-code, or example input and output that shows the problem.>

**Proposed solution:** <specific fix and any meaningful tradeoff.>
```

The heading states what goes wrong in terms the user cares about. It does not describe where in the code the reviewer left the comment.

Show the problem when prose alone would make the user rebuild it in their head. Useful forms include:

- A few lines of the relevant code, trimmed to what matters.
- Pseudo-code that shows the logic without unrelated details.
- A concrete input, date, or sequence of events, with what happens and what should happen.
- A before-and-after snippet for the proposed fix.

Keep these short and use real values from the code where possible.

### How many solutions to propose

When investigation shows a clear, proportionate fix, propose that one solution as a direct recommendation. Do not invent alternatives or make an obvious correction sound undecided.

Offer alternatives only when two or three materially different solutions are worth considering, meaning the user could reasonably decide differently. Options that differ only cosmetically do not count. In that case:

- Say explicitly that the comment exposes a product, architecture, compatibility, or implementation choice, and that there is no single mechanically correct fix.
- Present at most three options, each with its practical consequence and meaningful tradeoff.
- Recommend one when the evidence favors it. If none is clearly best, say what the choice depends on and help the user decide.

Use this variation:

```markdown
**Options worth considering:**

1. **Option:** <approach, consequence, and tradeoff.>
2. **Option:** <approach, consequence, and tradeoff.>

**Recommendation:** <preferred option and why, or the decision criterion when there is no clear winner.>
```

## 3. Implement after agreement

When every unresolved comment has been discussed, summarize the accepted, rejected, and deferred outcomes. Do not start implementing until the user explicitly asks.

When asked to implement:

- Apply all accepted fixes together, preserving repository ownership and contracts.
- Update affected tests, migrations, consumers, configuration, and stable documentation when needed.
- Verify the changes as the project's own guidance describes.
- Re-read the final diff against the agreed outcomes.

The instruction to implement covers local code changes and verification only. Do not commit, push, reply on GitHub, or resolve threads yet.

## 4. Close the review

Wait until the user asks to close, finish, or wrap up the review. That request authorizes the normal close-review steps without separate approval for each one:

1. Commit the agreed fixes.
2. Push the branch.
3. Reply briefly on each fully addressed thread with what changed.
4. Resolve those threads.

An explicit restriction such as “do not commit,” “do not push,” or “leave the threads open” overrides these defaults.

Do not resolve threads that were rejected, deferred, outdated without action, or only partly addressed.

Finish by reporting the commit and push state, the verification results, and which threads were resolved and which remain.
