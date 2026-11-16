---
description: "implement"
disable-model-invocation: true
---

Implement what we've agreed in this conversation, or the issue I name below. If it points to an issue, read the issue and all of its comments, and follow the direction they settled on. Make reasonable decisions where the discussion leaves room, and tell me about the ones that matter.

Before you change anything, read the code the change touches and the repository's guidance, such as AGENTS.md. Use existing behavior, tests, and patterns to understand where the change belongs. Use skill `design-afresh` for how to reason about it: form your own design for what's needed, then compare it with the existing code to decide what to reuse and what to change. Don't just fit the change into the nearest extension point, and don't turn this into a design write-up or unrelated cleanup.

Implement it completely and leave the code coherent. Follow existing patterns when they fit, and change them when they no longer serve the new behavior. Fix bugs you run into when they affect the result, leave unrelated cleanup alone, and tell me about any work beyond what I asked for. Follow the repository's testing policy in AGENTS.md. Often the right change adds no test.

If skill `ui-design` is available, use it for the frontend part when that part needs design judgment, that is, when you'd otherwise decide how part of the interface looks, behaves, or is worded, and neither I nor the existing interface already settle it. Use skill `clear-writing` for substantive prose changes in repository files, such as documentation and instructions.

When the change is done, have a subagent review the whole diff with skill `code-review`, so the review gets a fresh context instead of yours. Tell it what I asked for and what we decided, and fix the findings worth fixing.

Leave everything uncommitted, and tell me what you built, the decisions that matter, what the review changed, and anything still open. Don't commit, push, or post anything on GitHub.
