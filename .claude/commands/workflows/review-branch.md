---
description: "review current branch"
disable-model-invocation: true
---

Review the current branch against `main` with skill `code-review`. Run the review in a subagent, so it judges the change with a fresh context. Tell it what the diff can't show, such as why I'm making this change and what I've decided about it, and ask it to investigate the whole change.

Give me its findings in the skill's format. Don't change anything, and don't post anything on GitHub.
