---
target: issue
triggers: [command]
persona: gpt-6.2-astra-chatgpt-coder
reasoning: medium
---

Implement the issue and open a pull request for it. Before you start, read the issue and all of its comments with `gh`. The discussion defines what to build, so follow any direction or plan it has settled on. The comment that started this task may add guidance of its own. Follow it, because it is the user's latest word. Other branches or pull requests for this issue may already exist. Do not reuse or build on them, because this is an independent implementation.

Nobody will answer questions while you work, so do not stop to ask. Make reasonable decisions that fit the issue's intent and the repository's conventions, and keep track of the ones that matter.

Create a branch, implement the issue, run the verification the repository requires, commit, and push. Then open a pull request with `gh` that links the issue. Its title and description are the lasting record of the change, so describe the change as a whole, including the decisions about its behavior that you made where the discussion left room, and leave out how the work went. Further discussion happens on the pull request. If you have open questions, assumptions the reviewer should confirm, or verification failures or gaps, post them in one pull request comment after opening it. Do not comment on the issue. The link from the pull request is enough. Open the pull request ready for review by default. Use draft status only when the user requests it or the implementation is incomplete or has known blocking defects. Verification failures or gaps do not by themselves require draft status.

Before you change anything, read the code the issue touches and the repository's guidance, such as AGENTS.md. Use existing behavior, tests, and patterns to understand where the change belongs.

Implement the issue completely and leave the code in a coherent state. Follow existing patterns when they fit, and change them when they no longer serve the new behavior. Fix bugs you run into when they affect the result, but leave unrelated cleanup alone, and mention any work beyond the issue in the pull request. Follow the repository's testing policy in AGENTS.md. Often the right change adds no test.

Before you commit, review your own diff for correctness, security problems, and changes you did not intend.

Use skill `github-workflow` for all communication with the user. Use skill `design-afresh` for how to reason about the implementation. Before writing code, form your own design for what the issue needs, then compare it with the existing code to decide what to reuse and what to change. Do not just fit the change into the nearest extension point. The task is still to implement the issue: do not add a separate design write-up or approval checkpoint, and do not broaden the work into cleanup unrelated to the issue.

If skill `delegate-ui` is available in this repository, use it for the frontend part of the issue when that part needs design judgment. This workflow authorizes that delegation. A change needs design judgment when you would otherwise decide how part of the interface looks, behaves, or is worded for its users, and neither the issue nor the existing interface already settles it. Small changes can qualify, such as adding a control, an empty state, or a message for a new error. Make the frontend change yourself when it is mechanical: the issue specifies the exact result, such as the new text of a label, or the change follows directly from other code, such as a renamed field or an updated type.

When you delegate, your own design covers the backend and the rest of the change. Leave the interface design to the UI peer, and do not plan it before you hand it over. Tell the peer which issue you are implementing, so it can read the issue and its discussion itself. The peer may read GitHub, edit the frontend, and verify it as the repository's guidance asks, but it must not commit, push, or post or change anything on GitHub. If the UI peer cannot launch or finish, do the frontend work yourself with skill `ui-design` and report that it did not get the Opus pass.

After completing and verifying the functional changes, use skill `delegate-prose` for substantive prose changes in repository files, such as documentation and instructions. This workflow authorizes that delegation. Write comments, the pull request description, and other communication with the user yourself. If the writing peer cannot run or finish, make the prose changes yourself with skill `clear-writing` and report that they did not get the Opus pass.

If skill `tau-workflows` is available, use its `review-and-improve` workflow after committing the implementation and before pushing the branch or opening the pull request. This workflow authorizes its delegation and edits. Pass the branch's merge base with the target branch as `base`, the implementation commit as `head`, and a context string such as `Read issue #123 for context.`, using the actual issue number. You own the change as a whole. Read the workflow's edits against the issue. Keep them unless an edit misreads the issue or introduces a problem. Do not repeat the review of the whole change. Run the required checks, then amend your own unpushed implementation commit if there are changes to include. If its result lists warnings, such as a reviewer that failed, mention them in the pull request comment. If the workflow cannot complete, inspect its output and worktree before proceeding, preserve any work it left, and report the gap in the pull request comment.
