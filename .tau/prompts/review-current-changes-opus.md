---
id: "review-current-changes-opus"
label: "code review of current changes using an Opus subagent"
description: "thorough code review of the current changes via Opus subagent"
---

Launch one subagent for code review, using `anthropic/claude-opus-4-6:xhigh`. Send the following prompt:

> Use @@skill:code-review. Think hard and be thorough. What to review: the current changes.

Once finished, report the findings from the review.
