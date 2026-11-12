---
name: "tau-workflows"
description: "Run reusable JavaScript workflows through Tau's code tool: `find-sessions` finds past sessions that match a description, `answer-from-history` answers a question from past sessions, `review` reviews a committed change, and `review-and-improve` also improves it. Use only when the user explicitly names this skill or active repository or skill instructions explicitly require it; do not activate merely because a task is related. Trigger: explicit."
---

Each workflow is a script in `scripts/`. Its header comment lists its steps, and its prompts show what each agent is asked to do. Read the script when you need more detail than this file gives.

Run a script as a background code job, with its absolute path as `file` and its inputs in `input`. The script collects its workers' results and suppresses their completion notifications. Wait with `wait_for_code_jobs` at its maximum timeout of `300000` milliseconds, and repeat until the job finishes. A wait timeout leaves the job running, but the default foreground deadline can stop a workflow while its agents keep working.

The output is a timestamped log, with each step's duration, cost, running total, and key results such as finding titles, followed by any warnings and the final result. It is normally enough. Each step's prompt and results are also saved in the run folder printed at the start. Read them only when the output is not enough, or to continue after a failure, because rerunning a script starts from the beginning. The log and agent IDs do not survive a Tau restart.

The workflows need Tau's agents, bash, and models capabilities, and the history workflows also need history. Each script fixes the models it uses, so the subagent launch allowlist must include them. A failed model call fails the step, and no other model is tried.

## Search past sessions

- `scripts/find-sessions.js` finds sessions that match a `description`, such as "the conversation where we set up the Ruu bot", and lists each with a reason.
- `scripts/answer-from-history.js` answers a `question` and cites its source sessions.

Both take the same selection, and search all of it:

- `since` and `until`: ISO timestamps for the window, with the user's UTC offset, because a bare date means midnight UTC. The start is inclusive and the end exclusive, and the end defaults to now.
- `scopes`: attribute filters. A session is selected when it matches any filter, and all attributes in one filter must match. A value is an exact string or `{ "contains": "…" }` for a case-sensitive substring. Omit `scopes` to search all sessions.
- `sessionIds`: specific sessions to search, such as ones found earlier. The window and scopes still narrow them.

Each workflow reads the selected transcripts, has Jev screen session summaries and then classify transcript chunks, and gives the sessions that pass to a read-only Terra agent, which reads them and writes the result. Unreadable sessions and failed model calls are logged as warnings. When no session passes, the workflow says so without starting the agent.

Pass `since`, `sessionIds`, or both. Subagent sessions are included only by ID. Pass `"preview": true` to count the candidates by source without reading transcripts or calling models. Preview a broad selection first: the workflows refuse more than 512 candidates.

| Sessions                                      | Filter                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| Telegram conversations                        | `{ "source": "telegram" }`                                             |
| One assistant, such as Ada                    | `{ "source": "telegram", "project": "ada" }`                           |
| Terminal sessions                             | `{ "source": "tui" }`                                                  |
| Cowork sessions                               | `{ "source": "cowork" }`                                               |
| One Cowork workflow, such as PR conversations | `{ "source": "cowork", "cowork_workflow": "pull-request-fix" }`        |
| Sessions run in a repository                  | `{ "repository": { "contains": "github.com/markusylisiurunen/tau" } }` |

Older sessions often lack attributes such as `cowork_workflow`, `telegram_bot`, `machine`, and `cwd`, so a missing attribute does not put a session outside a scope. Repository attributes say where a session ran, not what it discussed. When completeness matters, use a broader scope and let the workflow filter by content. Use the history tool to inspect session metadata for other attributes.

The request must authorize history access and delegation.

## Review committed changes

- `scripts/review.js` returns the findings worth raising and the dropped candidates with reasons. It changes nothing.
- `scripts/review-and-improve.js` also runs design reviews, then edits the code and leaves the changes uncommitted. Its result lists the changes, the suggestions it rejected and why, and what it left unresolved.

A classifier reads the context, writes a brief of what the diff cannot show, and chooses a depth unless `depth` is set: light runs one general code review, standard two on different models, and deep adds up to three focused reviews of specific risks. Review and Improve also chooses zero to two design reviews. The reviewers work read-only in parallel. A failed reviewer leaves its coverage missing, which the result reports as a warning, and the workflow stops before the final agent only when no reviewer completed. In Review, the final agent merges the findings and decides which to raise. In Review and Improve, it filters the findings the same way, then fixes them and implements the design recommendations together.

Agents in the reviewed repository need the `code-review` and `clear-writing` skills, and Review and Improve also needs `deslop` and `design-afresh`.

Pass full commit IDs as `base` and `head`. For a branch, use `git merge-base <target branch> HEAD` as `base`, because a target branch that has moved on would show its newer changes as reversions. `HEAD` must match `head`, and the working tree must be clean, including untracked files.

The workflows run in the session's working directory. To review a repository elsewhere, such as a clone in an assistant workspace, pass its path as `workingDirectory`.

Pass an optional `context` of up to 4,096 tokens that says where the intent and decisions behind the change are recorded, or states them. Reviewers read the diff themselves, so point to what the diff cannot show. Neither workflow searches Tau history, so run `scripts/answer-from-history.js` first when earlier sessions matter. Pass `depth` as `light`, `standard`, or `deep` only to override the automatic choice. For example:

```json
{
  "base": "<full merge-base commit ID>",
  "head": "<full implementation commit ID>",
  "workingDirectory": "repos/tau",
  "context": "Read issue #123 for context."
}
```

Review requires authorization to delegate, and Review and Improve to delegate and edit. If a workflow is interrupted, inspect the printed agent IDs, the run folder, and for Review and Improve the working tree, before retrying.
