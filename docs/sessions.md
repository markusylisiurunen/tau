# Sessions

A session is one conversation and the execution environment it works in. The host saves it as it goes, so it can continue after you detach or the host restarts.

## Turns

A submitted message is saved before model work starts. Only one turn runs at a time. Further input is either queued as a new turn or steers the running one at its next safe point. A turn keeps its model, tools, and settings until it ends, so reasoning changes and reloads apply from the next turn. Pending input is shared by attached clients and is lost if the host restarts.

Interrupting stops the running turn, but subagents keep running. Retry continues from the current history without repeating the last message, so completed tools do not run again.

Exiting a local TUI shuts down its host and interrupts running work. Detaching from `tau serve` leaves work running.

## Compaction

Compaction replaces what the model sees with a summary that the model writes, so a session can continue past the context window. Searchable [history](history.md) keeps the original entries. Summaries lose detail over time.

**Automatic compaction** runs when context exceeds a threshold, and Tau keeps recent messages (up to 20,000 estimated tokens). The threshold is the first of these that is set:

1. the session override, set with `/auto-compact 50k`
2. a Telegram bot's `autoCompactThresholdTokens`
3. the persona's `autoCompactThresholdTokens`
4. the model's context window minus 16,384 tokens

The minimum is 50,000 tokens, and the last value is also the maximum. Applying a persona clears the session override. A lower threshold can reduce the cost of later requests, but each summary also costs tokens.

Before an automatic compaction, Tau tries to save the old context to an archive in the execution environment's temporary directory and tells the agent where it is. The files are temporary and can be removed by system cleanup.

**Manual compaction** runs with `/compact-all` or `/compact-keep-last` while idle. It keeps no recent messages and saves no archive. Text after the command guides the summary:

```text
/compact-all preserve the deployment constraints
```

## Rewind

`/rewind` removes a chosen user message and everything after it, then puts the text back in the editor. It also removes those entries from history and cannot be undone. It needs an idle session with no pending messages and no running subagents.

## Reload

`/reload` reads configuration, personas, prompts, skills, and `AGENTS.md` again from the working directory, reports warnings, and applies them to later turns. It keeps the current persona if it still exists. It does not change MCP servers, the execution environment, running subagents, or anything owned by the client. See [how Tau works](how-tau-works.md) for what needs a restart.

## Background jobs

Background [Bash and code jobs](tools.md) belong to the agent that started them and survive turns, interruption, and detaching. A running job keeps the session loaded. Jobs stop when the session closes or the host shuts down.

## What survives

| Event | Saved session | Pending messages | Running work and subagents |
| --- | --- | --- | --- |
| Client detaches from `tau serve` | Kept | Kept | Continue |
| TUI restarts, host keeps running | Kept | Kept | Continue |
| Local TUI exits | Saved | Lost | Interrupted |
| Host restarts | Recovered | Lost | Stopped, session returns idle |

After a restart, unfinished turns are marked as aborted and subagents are gone. Conversation, persona, reasoning, cost, and the execution environment are restored. The host can list and recover a session only if it can reconnect its environment. A missing directory or Sprite connection makes recovery fail, so restore it and try again.

Once the last client detaches and work has finished, the host unloads the session from memory and its subagents are gone. The session stays saved. Newer Tau versions open sessions saved by older ones, but older versions cannot read newer sessions, so do not downgrade a host.

## Reopen a saved session

Reattach through a running host. To reopen a local session, start one as the same user:

```sh
tau serve
tau attach --session 0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3 ws://127.0.0.1:8787
```

Without `--session`, `tau attach` opens a selector.

## Run one task from a script

`tau run` runs one turn without the TUI, so a script or another agent, such as Claude Code, can hand a task to Tau. It reads the task from stdin, starts a session in the current directory, and prints the final assistant response. The session ID goes to stderr, and `--json` prints the ID, turn outcome, and response together:

```sh
tau run --persona gpt-6.1-terra-chatgpt:medium --json <<'TASK'
Find why the retry test is flaky and fix it. Summarize what you changed.
TASK
```

To continue, pass the ID with `--session`. Each call is one turn, and background jobs stop when the command exits. A session open in another Tau process, such as a TUI, cannot be continued until that process closes it. Read the full transcript with [`tau history read`](history.md#export-a-transcript).

## Session attributes

Each session has creation attributes that never change and are used to filter [history](history.md). Tau sets `machine` and `cwd`. Clients set the others, such as `source` and `repository`.

## Usage and cost

`tau usage` summarizes token use and estimated cost from the logs in the host user's `~/.config/tau/logs`, so run it on the host:

```sh
tau usage --since 2026-08-01 --provider openai-codex --group-by model
```

Other filters are `--persona` and `--model`. Costs are estimates, and they do not include calls made through `tau.models` or command-line tools.
