---
label: "review current branch"
---

Review the current branch against `main` with the `review` workflow from skill `tau-workflows`. You can delegate as the workflow needs.

Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. Set `gatherContext` to `true` unless I say below not to gather context. The workflow gathers it from my Tau history and GitHub itself, so don't look for context or pass any. Leave `focus` unset unless I ask below to limit the workflow to something specific, and then pass that as the focus. Let the workflow choose the depth unless I name one below. If there are uncommitted changes, ask me what to do with them first.

When it finishes, show me any warnings and then its findings exactly as the result has them. The workflow has already chosen which findings are worth raising and written them for me, so don't summarize, reword, reformat, or drop any, and don't check them again or add your own. Don't change anything, and don't post anything on GitHub.
