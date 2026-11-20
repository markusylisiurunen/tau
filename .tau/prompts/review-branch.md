---
label: "review current branch"
---

Review the current branch against `main` with the `review` workflow from skill `tau-workflows`. You can delegate as the workflow needs.

Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. Set `gatherContext` to `true` unless I say below not to gather context. The workflow gathers it from my Tau history and GitHub itself, so don't look for context or pass any. Leave the focus unset unless I ask below for a review of something specific, and then pass that as the focus. Let the workflow choose the depth unless I name one below. If there are uncommitted changes, ask me what to do with them first.

When it finishes, show me the findings worth raising and any warnings. Don't change anything, and don't post anything on GitHub.
