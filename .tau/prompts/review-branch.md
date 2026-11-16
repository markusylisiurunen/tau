---
label: "review current branch"
---

Review the current branch against `main` with the `review` workflow from skill `tau-workflows`. You can delegate as the workflow needs.

Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. Write the context as the skill describes, with only what the diff can't show, such as why I'm making this change and what I've decided about it here or in an issue. Let the workflow choose the depth unless I name one below. If there are uncommitted changes, ask me what to do with them first.

When it finishes, show me the findings worth raising and any warnings. Don't change anything, and don't post anything on GitHub.
