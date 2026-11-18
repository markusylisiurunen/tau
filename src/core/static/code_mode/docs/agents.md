# @tau/agents

Manage workers you started and their descendants. Follow the delegation policy in your instructions. Workers keep running when a program finishes or is cancelled.

```js
import { spawn, waitUntilIdle, readResponse } from "@tau/agents";
import { printText } from "@tau/core";

const { id } = await spawn("Review docs/code-mode.md for unclear examples.", {
  title: "Review Code Mode docs",
});
await waitUntilIdle(id);
printText(await readResponse(id));
```

## Worker lifecycle

- `launchOptions()` returns the inherited model, allowed model overrides, and current capacity. Capacity is shared across the session and is not a reservation.
- `spawn(prompt, { title, model?, workingDirectory?, notifyOnCompletion? })` starts a worker and returns its state. The prompt must include the context the worker needs. The model and directory default to the caller's. Supply a model only when your instructions call for an allowed override. The main agent can disable completion notifications with `notifyOnCompletion: false` when notifications are available.
- `list()` returns `{ agents, capacity }`, with access limited to descendants. `read(id)` returns the current state of one worker. State includes `status`, pending input counts, usage, and a `reason` when idle (`completed`, `failed`, or `interrupted`).
- `sendInput(id, message, { mode })` accepts `mode: "queue"` to start a separate turn after current work, or `"steer"` to deliver input during the current turn as soon as possible. Either starts a new turn if the worker is idle.
- `interrupt(id, { wait?, scope? }?)` interrupts the turn and clears pending input. It waits for the worker by default. Set `wait: false` to return before stopping finishes or `scope: "subtree"` to include descendants. Background jobs the workers started keep running.
- `waitUntilIdle(id)` returns the worker's state when it has no active turn or pending input. Failed and interrupted turns still return state. Cancelling the wait leaves the worker running. This does not wait for descendants or background jobs.
- `setCompletionNotification(id, enabled)` is available to the main agent when notifications are enabled. It applies to future completions of workers it started directly.

## Responses and traces

`readResponse(id)` returns the full text of the latest normally completed turn. It throws if the latest turn is active, failed, interrupted, or has no complete response. It never reads an older turn in its place. A normally completed turn can still report that the worker did not accomplish its task.

`trace(id, { kinds?, toolName?, limit?, cursor? }?)` returns `{ entries, nextCursor, historyEvicted }`. Kinds include `input`, `assistant`, `tool_call`, `tool_result`, `notice`, and `status`. Entries have a `seq`, a timestamp, a `kind`, and fields specific to that kind. Read inline content directly. Referenced content has a `ref` for further reads.

`readText(id, seq)` reads the complete text of an assistant or tool result entry, including text from an interrupted turn. If the entry is unavailable or contains mixed content, it throws. Use `truncate()` to display a preview. `readContent(id, ref, { cursor }?)` reads referenced content in pages and returns `{ blocks, nextCursor }`. Join text chunks in order. Images and JSON blocks arrive whole. The trace is bounded and does not outlive the worker; use `@tau/history` for saved transcripts when your request calls for them.
