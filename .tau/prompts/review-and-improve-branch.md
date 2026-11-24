---
label: "review and improve current branch"
---

Review the current branch against `main` and improve it based on the reviews with the `review-and-improve` workflow from skill `tau-workflows`, without changing what the branch is meant to do. You can delegate and let the workflow edit files.

Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. Write the context as the skill describes, with only what the diff can't show, such as why I'm making this change and what I've decided about it here or in an issue. Let the workflow choose the depth unless I name one below. If there are uncommitted changes, ask me what to do with them first.

Leave the workflow's edits uncommitted, without reviewing, changing, or rechecking them. Report any check failures it lists, and use its result to tell me what changed and why, which findings it fixed, which suggestions were rejected and why, and what's still open. Don't commit, push, or post anything on GitHub.
