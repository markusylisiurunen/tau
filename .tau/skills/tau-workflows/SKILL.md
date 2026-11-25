---
name: "tau-workflows"
description: "Run reusable JavaScript workflows through Tau's code tool: `find-sessions` finds past sessions, `answer-from-history` answers questions from them, `review` reviews committed changes, `gather-context` collects the conversations behind them, `improve` improves their design, `review-and-improve` combines code review and improvement, `prune` removes what they add that does not earn its place, `rewrite` rewrites text for its readers, and `explain` explains a change in a Markdown file or an Inko document and keeps it up to date. Use only when the user explicitly names this skill or active repository or skill instructions explicitly require it; do not activate merely because a task is related. Trigger: explicit."
---

Each workflow is a script in `scripts/`. Its header comment lists its steps, and its prompts show what each agent is asked to do. Read the script when you need more detail than this file gives.

Run a script as a background code job, with its absolute path as `file` and its inputs in `input`. The script collects its workers' results and suppresses their completion notifications. Wait with `wait_for_code_jobs` at its maximum timeout of `300000` milliseconds, and repeat until the job finishes. A wait timeout leaves the job running, but the default foreground deadline can stop a workflow while its agents keep working.

The output is a timestamped log, with each step's duration, cost, running total, and key results such as finding titles, followed by any warnings and the final result. It is normally enough. Each step's prompt and results are also saved in the run folder printed at the start. Read them only when the output is not enough, or to continue after a failure, because rerunning a script starts from the beginning. The log and agent IDs do not survive a Tau restart.

The workflows start subagents and call models, so they fail when your instructions list either as unavailable. Each script fixes the models it uses, and the workflows that work on committed changes share theirs by role in `scripts/lib/review.js`. The subagent launch allowlist must include them. A failed model call fails the step, and no other model is tried.

## Search past sessions

- `scripts/find-sessions.js` finds sessions that match a `description`, such as "the conversation where we set up the Ruu bot", and lists each with a reason.
- `scripts/answer-from-history.js` answers a `question` and cites its source sessions.

Both take the same selection, and search all of it:

- `since` and `until`: ISO timestamps for the window, with the user's UTC offset, because a bare date means midnight UTC. The start is inclusive and the end exclusive, and the end defaults to now. The window selects sessions by when they were last updated, so a session that continued after `until` is left out.
- `scopes`: attribute filters. A session is selected when it matches any filter, and all attributes in one filter must match. A value is an exact string or `{ "contains": "…" }` for a case-sensitive substring. Omit `scopes` to search all sessions.
- `sessionIds`: specific sessions to search, such as ones found earlier. The window and scopes still narrow them.

Each workflow has Jev screen session summaries, together with the entries each summary does not yet cover, then classify the whole transcripts of the sessions that remain. It gives the sessions that pass to a read-only Terra agent, which reads them and writes the result. Unreadable sessions and failed model calls are logged as warnings. When no session passes, the workflow says so without starting the agent.

Pass `since`, `sessionIds`, or both. Subagent sessions are included only by ID. Pass `"preview": true` to count the candidates by source without reading transcripts or calling models. Preview a broad selection first: the workflows refuse more than 512 candidates.

| Sessions                                      | Filter                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| Telegram conversations                        | `{ "source": "telegram" }`                                               |
| One assistant, such as Ada                    | `{ "source": "telegram", "project": "ada" }`                             |
| Terminal sessions                             | `{ "source": "tui" }`                                                    |
| Claude Code sessions                          | `{ "source": "claude-code" }`                                            |
| Cowork sessions                               | `{ "source": "cowork" }`                                                 |
| One Cowork workflow, such as PR conversations | `{ "source": "cowork", "cowork_workflow": "pull-request-conversation" }` |
| Sessions run in a repository                  | `{ "repository": { "contains": "github.com/markusylisiurunen/tau" } }`   |

Older sessions often lack attributes such as `cowork_workflow`, `telegram_bot`, `machine`, and `cwd`, so a missing attribute does not put a session outside a scope. Repository attributes say where a session ran, not what it discussed. When completeness matters, use a broader scope and let the workflow filter by content. Use the history tool to inspect session metadata for other attributes.

The request must authorize history access and delegation.

## Work on committed changes

The review, improvement, prune, rewrite, and explain workflows work on a repository's committed changes or text. Each needs a clean working tree, including untracked files, except that Explain allows untracked files. They share these inputs:

- `base` and `head`: full commit IDs, which rewrite needs only when its target is a committed change. For a branch, use `git merge-base <target branch> HEAD` as `base`, because a target branch that has moved on would show its newer changes as reversions. `HEAD` must match `head`.
- `workingDirectory`: the repository to work in, such as a clone in an assistant workspace. It defaults to the session's working directory.
- `context`: optional, up to 4,096 tokens. Review, Improve, Review and Improve, and Gather context do not take it.

For workflows that take `context`, the agents read the diff and the repository themselves, so it carries only what they cannot find there, such as why the change exists and the decisions behind it. Point to where that is recorded, or state it in a sentence or two. A summary of what the change does adds nothing they cannot see, and it anchors their judgment to yours. Put anything those workflows need from earlier sessions in the context. Good contexts look like these:

- `Read issue #123 for context.`
- `Read issue #123 for context. We chose to drop the v1 config format, so code that reads it can go.`
- `This is the first version of the setup guide, for people who have never used the CLI.`

Review requires authorization to delegate, Explain to delegate and write its output, and the other workflows to delegate and edit. Edits are left uncommitted. If a workflow is interrupted, inspect the printed agent IDs, the run folder, and the working tree before retrying.

### Review and improve

- `scripts/review.js` returns the findings worth raising and the dropped candidates with reasons. It changes nothing.
- `scripts/improve.js` runs design reviews, which use `design-afresh` and `deslop`, then implements their recommendations.
- `scripts/review-and-improve.js` combines code and design reviews, then fixes the findings and implements the design recommendations together.

The improvement workflows list the changes, the suggestions they rejected and why, and what they left unresolved.

The final agents write the findings and unresolved items for the person who acts on them, and the result formats them for reading. Show them to the user as the result has them, without summarizing, rewording, or dropping any, unless the user asks otherwise.

The classifier plans the reviews from the diff alone. Review and Review and Improve run code reviews at a depth the classifier chooses: light runs one general code review, standard two on different models, and deep adds up to three focused reviews of specific risks. Pass `depth` as `light`, `standard`, or `deep` only to override that choice. Review and Improve also chooses zero to two design reviews, and Improve one or two.

The reviewers work read-only in parallel. A failed reviewer leaves its coverage missing, which the result reports as a warning, and the workflow stops before the final agent only when no reviewer completed. In Review, the final agent merges the findings and decides which to raise. In the improvement workflows, it implements the design recommendations. When two recommendations conflict, it chooses one. Review and Improve also filters the code-review findings and fixes those worth fixing.

All three scripts take the same optional inputs:

- `focus`: set only when the user asks to limit the work, for example `Only the retry logic in src/sync/.`. It scopes planning, reviews, and any edits. With no focus, the workflow covers the whole change.
- `gatherContext`: defaults to `false` when calling a script directly. Tau branch prompts and Cowork set it to `true` unless the user asks to skip it. Gathering reads Tau history, so the request must authorize that access.

When enabled, context gathering starts alongside classification. The reviewers still judge the code without issues, pull request discussions, or Tau history. Only the final agent consults the gathered sources, where a finding or proposed edit depends on intent. It rejects suggestions that contradict settled decisions. If a suggestion reveals a concrete consequence the decision did not account for, it raises a question and leaves the code unchanged.

Agents in the reviewed repository need the `clear-writing` skill, `code-review` for code reviews, and `deslop` and `design-afresh` for design reviews.

For example, any of the three:

```json
{
  "base": "<full merge-base commit ID>",
  "head": "<full implementation commit ID>",
  "workingDirectory": "repos/tau",
  "gatherContext": true
}
```

### Gather context

`scripts/gather-context.js` collects the conversations behind a commit range, the same step Review, Improve, and Review and Improve run with `gatherContext`. The range can be a pull request, an unpublished branch, or a single local commit. A Sol agent starts from the commits, selects the pull request and the issues behind the change, and searches Tau history for sessions where the user shaped the change. It looks only at the user's Tau terminal, Claude Code, and Telegram assistant sessions in a short window around the commits. A helper screens them by summary and tail with Jev and classifies the remaining transcripts in chunks. Changes with no decisions behind them, such as dependency upgrades, skip the history search. The log shows each search with its window, its cost, and how many sessions matched the filters, passed screening, and passed classification.

The workflow exports the selected discussions and sessions as numbered entries in time order. It writes `manifest.md` with sources in start-time order, their active dates in UTC, why each was included, and any gaps.

It takes `base`, `head`, and `workingDirectory`. The request must authorize history access and delegation.

### Prune

`scripts/prune.js` cuts a committed change down to what earns its place. An Opus pruner first studies the change and forms its own view, while three Terra finders look for candidates in parallel, one each for tests, defensive code, and structure and text. The pruner then weighs their candidates as signals alongside its own view, decides what to prune across the whole change, and makes the edits. Pruning may change behavior in cases not worth the code, such as a guard for a state that cannot happen in practice, and the result names each such change. It lists what was pruned and who found it, which candidates were kept and why, and what needs a decision. Agents follow the repository's testing policy where it sets a different bar.

Pass an optional `focus` to narrow the run, such as `Only tests.` or `Only src/sync/.` Every step stays within it.

### Rewrite

`scripts/rewrite.js` rewrites text for its readers. Text means anything written for a reader, wherever it lives, such as documentation, agent instructions, prompts and tool descriptions in code, or interface copy. An Opus writer works out what each text is for and who reads it, rewrites it in place, and writes a short, high-level brief. Two Opus readers then look at the draft, one as its intended reader and one comparing what it says with the original. The writer weighs their feedback as signals and revises in the same session. A rewrite weighs whether each point belongs as well as how it is worded, so it may remove content the readers do not need. It may also change what the text asks its reader to do when that serves its purpose, and it may change code where the text needs it. The result notes where the text now says something different that is worth checking.

Pass `target`, a description of the text to rewrite, such as file paths, "the README's setup section", or "the text this branch changes".

### Explain

`scripts/explain.js` explains a committed change to someone about to review or work with it, sitting between a pull request description and the raw diff. The workflow ensures the destination exists, creating an empty Markdown file or empty Inko document when needed, then hands that explicit target to a single Sol agent. The agent studies the change, plans a top-to-bottom structure around the ideas the reader needs, and writes or updates the destination directly in plain narrative prose, using small concrete examples where they communicate faster than prose and leaving low-level mechanics to the diff.

Pass `output` as one of these:

- A Markdown file path, absolute or relative to the session's working directory. Plain Markdown only, with no widgets.
- `"inko"`, to create a new empty Inko document and write into it. Inko explanations can optionally embed HTML visualisation widgets when seeing a structure, flow, state lifecycle, or before-and-after layout makes an idea clearer than prose or text diagrams alone. Requires the Inko MCP server.
- An Inko document URL, to write into or refresh that document in place.

When the target already holds an explanation, the agent compares it against the full current `base..head` change (so it works across force-pushes and rebases) and updates only what is now wrong, incomplete, or obsolete, keeping accurate structure and wording intact for returning readers and Inko comments. Leaving the document unchanged is a valid outcome when it is already accurate.
