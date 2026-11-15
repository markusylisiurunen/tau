---
label: "improve current branch"
---

Improve the design of the current branch against `main` with the `improve` workflow from skill `tau-workflows`, without changing what the branch is meant to do. You can delegate and let the workflow edit files.

Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. In the context, tell the reviewers what the diff can't show: why I'm making this change and what I've decided about it, from this conversation and any issue it points to. If there are uncommitted changes, ask me what to do with them first.

Keep the workflow's changes unless one of them has a clear problem or goes against what the branch is for. Leave them uncommitted, and tell me what changed and why it's better, which suggestions were rejected and why, and what's still open. Don't commit, push, or post anything on GitHub.
