---
description: "review and improve current branch"
disable-model-invocation: true
---

Review the current branch against `main`, then improve it without changing what the branch is meant to do. Run the review in a subagent with skill `code-review`, so it judges the change with a fresh context. Tell it what the diff can't show, such as why I'm making this change and what I've decided about it.

Then fix the findings worth fixing yourself, and use skill `design-afresh` to reconsider the design and skill `deslop` for the details in the code.

Leave your changes uncommitted, and tell me which findings you fixed and which you left and why, what else changed and why it's better, and what's still open. Don't commit, push, or post anything on GitHub.
