---
id: "deep-review-branch"
label: "code review of current branch using parallel subagents"
description: "thorough code review of the current branch via parallel subagents"
---

Launch two subagents in parallel for code review, using `openai-codex/gpt-5.3-codex:high` and `anthropic/claude-opus-4-6:xhigh`. Send both the same prompt, verbatim:

> Use @@skill:code-review. Think hard and be thorough. What to review: the current branch.

Once both finish, synthesize their findings into a single unified review (see @@skill:code-review). Merge duplicate findings, keeping the stronger detail from each.
