---
label: "explain current branch"
---

Explain the current branch against `main` with the `explain` workflow from skill `tau-workflows`. You can delegate and write the explanation to its destination.

Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. Pass `"inko"` as `output` unless I give a Markdown file path or an existing Inko document URL below. Leave `context` and `model` unset unless I explicitly ask for them below. If there are uncommitted changes to tracked files, ask me what to do with them first.

When it finishes, give me the link or path to the explanation along with the workflow's brief summary, updates, and widgets if any. Don't edit tracked files, commit, push, or post anything on GitHub.
