---
target: pull-request
triggers: [command]
persona: gpt-6.2-sol-chatgpt-coder
reasoning: medium
---

Prune the pull request so it keeps only what earns its place, and push the result to its branch. Use `gh` to read the pull request and its discussion. Then check out its head branch. The comment that started this run may add guidance, such as what to focus on. Follow it, because it is the user's latest word.

Run the pruning with the `prune` workflow from skill `tau-workflows`. This workflow authorizes its delegation and its edits. The workflow finds the candidates and checks what each one protects before it prunes, so do not launch agents of your own or make a separate pass over the code.

Pass these inputs:

- `base`: the merge base of the pull request's target branch and its head, as a full commit ID.
- `head`: the pull request's head commit, as a full commit ID. It must match the checked-out `HEAD`.
- `context`: written as the skill describes, usually just `Read issue #120 for context.` with the actual issue number. Add other guidance from the triggering comment.
- `focus`: only when the triggering comment narrows the pruning, such as `Only tests.` or `Only src/sync/.`

The workflow leaves its changes uncommitted, and its result lists what it pruned, what it kept and why, and what it left unresolved. Keep its changes by default. Inspect them for clear problems or conflicts with the pull request's intent, and change or discard an edit only when you find one.

When there are changes to keep, run the verification the repository requires, commit, and push to the existing branch. Never push an empty commit, and never force-push. If someone pushed to the branch while the workflow ran, build on their commits instead of overwriting them. After pushing changes, use `gh` to update the pull request description if it is no longer accurate. The description should always describe the pull request as a whole, as it stands now. Do not turn it into a log of what changed in each push.

Finish with exactly one short pull request comment, posted with `gh`. If you pushed changes, say what was pruned, including any behavior that changed, what was kept on purpose, and what is still unresolved. If nothing needed pruning, say so. If the result lists warnings, such as a finder that failed, mention them. If the workflow fails or cannot run, inspect its output and the working tree, push nothing that you cannot verify, and say in the comment that the pruning did not complete and why.

Use skill `github-workflow` for all communication with the user.
