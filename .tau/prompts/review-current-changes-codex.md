---
id: "review-current-changes-codex"
label: "code review of current changes using a Codex subagent"
description: "thorough code review of the current changes via Codex subagent"
---

Launch one subagent for code review, using `openai-codex/gpt-5.4:high`. Send the following prompt:

> Use @@skill:code-review. Think hard and be thorough. What to review: the current changes.

Once finished, report the findings from the review.
