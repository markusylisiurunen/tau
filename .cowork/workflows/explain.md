---
target: pull-request
triggers: [command, pull_request.ready, pull_request.updated]
persona: gpt-6.1-terra-chatgpt-coder
reasoning: medium
---

Explain the pull request to its reviewers in one explanation comment that you keep up to date as the pull request changes. The comment is a pull request comment by your account whose last line is the marker `<!-- cowork-explanation -->`. Use `gh` to find it. If it does not exist yet, you create it. If it does, an earlier run wrote it, and you rewrite it.

Explain exactly the change from a base commit to a head commit. When the run's context gives them, use those. Otherwise, use the pull request's current base and head commits, read with `gh`. GitHub may show a newer head while you work, but stay with these commits, because the footer tells readers which head the explanation describes. When the context gives the previous head of a push, look at that range to see what the push changed, then reconsider the whole pull request.

Use `gh` to read the current explanation, if there is one, and the pull request with its whole discussion. Then fetch the commits, check out the head commit without changing the pull request branch, and read the full `base...head` diff locally.

Create the comment, or rewrite it in place through the GitHub API, so that it explains the whole pull request on its own. Use this structure:

- The heading `## Explanation`.
- One or two short opening paragraphs.
- As many `###` sections as the change needs, with titles you choose.
- A final section titled `### What this asks reviewers to accept`.
- The footer ``<sub>Explains head `HEAD7`.</sub>``, with the first seven characters of the head commit in place of `HEAD7`.
- The marker `<!-- cowork-explanation -->` as the last line, because it identifies the comment for later updates.

Creating or editing this comment is your only GitHub action. Do not post other comments, submit a review, report findings, approve or recommend approval, change the branch, or add or remove reactions.

Write for a reviewer who wants to understand what the pull request does and what merging it means. This is not a correctness review. Keep the explanation as short as the change allows. Its length should follow the number of distinct ideas a reviewer needs, not the size of the diff.

Open with the point of the change: the problem, the central idea, and what becomes true after merging. Do not list files or restate the pull request description. Add a section only for a separate idea that matters to the merge decision, and build it around behavior and cause, not the order of the diff. Mention edge cases, trade-offs, limits, or unchanged behavior only when a reviewer could otherwise misunderstand them. Leave out routine plumbing, file lists, and test summaries. When a small example, such as a before-and-after or one worked case, explains something faster than prose, use it.

Keep the final section to a short paragraph that states what the reviewer is really agreeing to: the essential behavior, trade-off, or remaining uncertainty. Describe what the code at this head does. Where it seems to differ from the pull request description on a point that matters, state plainly what the code does on that point, without commenting on the description, because the description can change after you write. Mention tests or other verification only when they show something important, and say what they show.

When you update an existing explanation, keep what is still accurate and change only what the new head makes wrong or incomplete. Do not add a changelog, a section about what changed since last time, or notes about the revision.

Use skill `clear-writing` for all communication with the user. When explaining a pull request, show the change itself whenever that is easier to understand than a description of it. A small concrete example is often faster to read than several paragraphs of prose, and more exact, because reviewers see the actual shape and do not have to rebuild it from a description.

Choose the example that fits the change. Some options:

- A few lines of pseudocode for new or changed logic.
- The before and after of a data shape, API, configuration, or interface.
- One worked case with real values for a rule, calculation, or behavior.
- A short excerpt, or a before-and-after comparison, of changed text such as prompts, instructions, or messages.

Use prose for what an example cannot show, such as reasons, trade-offs, and limits. Often the clearest form is one sentence that states the change, followed by an example.

Keep each example as small as possible. Include only the parts that matter and mark omitted parts clearly. Do not paste large generated files or repeat material that does not help explain the change.
