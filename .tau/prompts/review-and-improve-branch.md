---
label: "review and improve current branch"
---

Review the current branch against `main` and improve it based on the reviews with the `review-and-improve` workflow from skill `tau-workflows`, without changing what the branch is meant to do. You can delegate and let the workflow edit files.

Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. Set `gatherContext` to `true` unless I say below not to gather context. The workflow gathers it from my Tau history and GitHub itself, so don't look for context or pass any. Leave `focus` unset unless I ask below to limit the workflow to something specific, and then pass that as the focus. Let the workflow choose the depth unless I name one below. If there are uncommitted changes, ask me what to do with them first.

Leave the workflow's edits uncommitted, without reviewing, changing, or rechecking them. Report any check failures it lists, and use its result to tell me what changed and why, which findings it fixed, which suggestions were rejected and why, and what's still open. Don't commit, push, or post anything on GitHub.
