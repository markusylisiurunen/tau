---
target: pull-request
triggers: [command]
persona: gpt-6.2-sol-chatgpt-coder
reasoning: medium
---

Review the pull request and improve it based on the reviews without changing what it is meant to do, and push the result to its branch. Use `gh` to read the pull request metadata and the triggering request, then check out its head branch. Let the workflow gather the discussion itself. The comment that started this run may add guidance, such as what to focus on. Follow it, because it is the user's latest word.

Run the review and improvement with the `review-and-improve` workflow from skill `tau-workflows`. This workflow authorizes its delegation, edits, and the history access its context gathering needs. The workflow plans and runs the code and design reviews, fixes the findings worth fixing, and implements the design recommendations, so do not launch reviewers of your own or make a separate pass over the code.

Pass these inputs:

- `base`: the merge base of the pull request's target branch and its head, as a full commit ID.
- `head`: the pull request's head commit, as a full commit ID. It must match the checked-out `HEAD`.
- `gatherContext`: `true` unless the triggering comment asks to skip context gathering.
- `focus`: only when the triggering comment asks to limit the workflow to something specific, in the comment's own words. Leave it unset otherwise.

Set `depth` only when the user asks for one.

The workflow leaves its changes uncommitted, and its result lists the changes, the suggestions it rejected and why, and what it left unresolved. The workflow has already weighed each change, so keep its changes as they are, without reviewing, fixing, or discarding them.

If the workflow completes with changes, run the verification the repository requires, commit, and push to the existing branch. Push even when a required check fails, so the work is not lost and the user can see the failure on the pull request. Never push an empty commit, and never force-push. If someone pushed to the branch while the workflow ran, build on their commits instead of overwriting them. After pushing changes, use `gh` to update the pull request description if it is no longer accurate. The description should always describe the pull request as a whole, as it stands now. Do not turn it into a log of what changed in each push. Keep content that is still valid and any required metadata, and change only what needs to change.

Finish with exactly one short pull request comment, posted with `gh`. If you pushed changes, say what changed and why it is better, which findings it fixes, which suggestions were rejected and why, and what is still unresolved. If nothing needed changing, say that the workflow looked and found nothing worth changing. If the result lists warnings, such as a reviewer that failed, mention them. Name each check that failed, whether in your verification or in the workflow's own run, and say what failed. If the workflow itself fails or cannot run, leave any edits in place, push nothing, and say in the comment that the review and improvement did not complete and why.

Use skill `github-workflow` for all communication with the user.
