---
label: "prune current branch"
---

Prune the current branch against `main` with the `prune` workflow from skill `tau-workflows`, so it keeps only what earns its place. You can delegate and let the workflow edit files.

Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. Write the context as the skill describes, with only what the diff can't show, such as why I'm making this change and what I've decided about it here or in an issue. If I narrow the pruning below, such as to tests only, pass that as the focus. If there are uncommitted changes, ask me what to do with them first.

Leave the workflow's edits uncommitted, without reviewing, changing, or rechecking them. Report any check failures it lists, and use its result to tell me what was pruned, including any behavior that changed, what was kept and why, and what's still open. Don't commit, push, or post anything on GitHub.
