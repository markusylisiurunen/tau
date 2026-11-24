---
label: "implement"
---

Implement what we've agreed in this conversation, or the issue I name below. If it points to an issue, read the issue and all of its comments, and follow the direction they settled on. Make reasonable decisions where the discussion leaves room, and tell me about the ones that matter.

Before you change anything, read the code the change touches and the repository's guidance, such as AGENTS.md. Use existing behavior, tests, and patterns to understand where the change belongs. Use skill `design-afresh` for how to reason about it: form your own design for what's needed, then compare it with the existing code to decide what to reuse and what to change. Don't just fit the change into the nearest extension point, and don't turn this into a design write-up or unrelated cleanup.

Implement it completely and leave the code coherent. Follow existing patterns when they fit, and change them when they no longer serve the new behavior. Fix bugs you run into when they affect the result, leave unrelated cleanup alone, and tell me about any work beyond what I asked for. Follow the repository's testing policy in AGENTS.md. Often the right change adds no test. Before you finish, review your own diff for correctness, security problems, and changes you didn't intend.

If skill `delegate-ui` is available, use it for the frontend part when that part needs design judgment, that is, when you'd otherwise decide how part of the interface looks, behaves, or is worded, and neither I nor the existing interface already settle it. Make mechanical frontend changes yourself. Leave the interface design to the UI peer, and tell it what you're implementing so it can read the context itself. The peer must not commit, push, or change anything on GitHub. If it can't run or finish, do the frontend work yourself with skill `ui-design` and tell me it didn't get the Opus pass.

After the functional changes are done, use skill `delegate-prose` for substantive prose changes in repository files, such as documentation and instructions. If the writing peer can't run or finish, make the prose changes yourself with skill `clear-writing` and tell me they didn't get the Opus pass.

Then, if skill `tau-workflows` is available, run its `review-and-improve` workflow on the result. It needs committed changes, so commit everything as a temporary commit first, and pass the commit before it as the base and the temporary commit as the head, with a context, written as the skill describes, that says what I asked for and what we decided. You still own the change as a whole. Read the workflow's edits against what I asked for. Keep them unless an edit conflicts with my request or introduces a problem. Don't review the whole change again. Then undo the temporary commit with `git reset --soft HEAD~1`. If there were uncommitted changes before you started, ask me before making the temporary commit.

Leave everything uncommitted, and tell me what you built, the decisions that matter, what the review changed, and anything still open. Don't commit, push, or post anything on GitHub.
