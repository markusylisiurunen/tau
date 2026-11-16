---
label: "rewrite text in current branch"
---

Rewrite the text in the current branch with the `rewrite` workflow from skill `tau-workflows`, so it serves its readers. Text means anything written for a reader, such as docs, agent instructions, prompts and tool descriptions in code, and interface copy. You can delegate and let the workflow edit files.

The target is the text the branch changes against `main`, and text elsewhere in the repository that the branch should have changed but didn't, unless I name a narrower one below. Use the merge base of `main` and `HEAD` as the base and `HEAD` as the head. Write the context as the skill describes, with only what the diff can't show, such as why I'm making this change and what I've said about the writing here. If there are uncommitted changes, ask me what to do with them first.

When it finishes, tell me briefly what changed, and point out where the text now says or asks for something different. Leave the changes uncommitted, and don't commit, push, or post anything on GitHub.
