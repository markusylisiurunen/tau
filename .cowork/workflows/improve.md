---
target: pull-request
triggers: [command]
persona: gpt-6.2-sol-chatgpt-coder
reasoning: medium
---

Improve the design of the pull request without changing what it is meant to do, and push the result to its branch. Use `gh` to read the pull request and its discussion. Then check out its head branch. The comment that started this run may add guidance, such as what to focus on. Follow it, because it is the user's latest word.

Run the improvement with the `improve` workflow from skill `tau-workflows`. This workflow authorizes its delegation and its edits. The workflow plans and runs the design reviews and implements their recommendations, so do not launch reviewers of your own or make a separate pass over the code.

Pass these inputs:

- `base`: the merge base of the pull request's target branch and its head, as a full commit ID.
- `head`: the pull request's head commit, as a full commit ID. It must match the checked-out `HEAD`.
- `context`: written as the skill describes, usually just `Read issue #120 for context.` with the actual issue number. Add any guidance from the triggering comment.

The workflow leaves its changes uncommitted, and its result lists the changes, the suggestions it rejected and why, and what it left unresolved. The workflow has already weighed each change, so keep its changes as they are, without reviewing, fixing, or discarding them.

If the workflow completes with changes, run the verification the repository requires, commit, and push to the existing branch. Push even when a required check fails, so the work is not lost and the user can see the failure on the pull request. Never push an empty commit, and never force-push. If someone pushed to the branch while the workflow ran, build on their commits instead of overwriting them. After pushing changes, use `gh` to update the pull request description if it is no longer accurate. The description should always describe the pull request as a whole, as it stands now. Do not turn it into a log of what changed in each push. Keep content that is still valid and any required metadata, and change only what needs to change.

Finish with exactly one short pull request comment, posted with `gh`. If you pushed changes, say what changed and why it is better, which suggestions were rejected and why, and what is still unresolved. If nothing needed changing, say that the workflow looked and found nothing worth changing. If the result lists warnings, such as a reviewer that failed, mention them. Name each check that failed, whether in your verification or in the workflow's own run, and say what failed. If the workflow itself fails or cannot run, leave any edits in place, push nothing, and say in the comment that the improvement did not complete and why.

Use skill `github-workflow` for all communication with the user.
