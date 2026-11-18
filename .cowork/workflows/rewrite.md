---
target: pull-request
triggers: [command]
persona: gpt-6.2-sol-chatgpt-coder
reasoning: medium
---

Rewrite the text of the pull request so it serves its readers, and push the result to its branch. Use `gh` to read the pull request description, any linked issue, and the discussion to understand what the pull request is for. Then check out its head branch. The comment that started this run may add guidance. Follow it, because it is the user's latest word.

Run the rewrite with the `rewrite` workflow from skill `tau-workflows`. This workflow authorizes its delegation and its edits. Do not launch agents of your own or rewrite the text yourself.

Pass these inputs:

- `target`: `The text this pull request changes, and text anywhere in the repository that it should have changed but did not.` When the triggering comment names a narrower target, such as one file, describe that instead.
- `base`: the merge base of the pull request's target branch and its head, as a full commit ID.
- `head`: the pull request's head commit, as a full commit ID. It must match the checked-out `HEAD`.
- `context`: written as the skill describes, usually just `Read issue #120 for context.` with the actual issue number. Add any guidance on the writing from the triggering comment.

Keep the workflow's changes. Do not review them, fix them, or ask for more changes. When there are changes, commit them and push to the existing branch without force-pushing. Then post one short pull request comment with `gh` that says briefly what changed and points out where the text now says or asks for something different, or that the text needed no changes. Use skill `github-workflow` for the commit and the comment.

If the workflow fails or cannot run, push nothing, and post a comment that says the rewrite did not complete and why.
