# @tau/agents

Start workers, steer and wait for them, and read what they did. You can manage the workers you started and the workers they started. Follow the delegation policy in your instructions. Workers keep running when a program ends or is cancelled.

```js
import { readResponse, spawn, waitUntilIdle } from "@tau/agents";
import { printText } from "@tau/core";

const areas = ["src/auth", "src/billing"];
const workers = await Promise.all(areas.map((area) =>
  spawn(`Review ${area} for unchecked errors. Report file, line, and problem.`, {
    title: `Review ${area}`,
  })));
for (const [index, { id }] of workers.entries()) {
  const worker = await waitUntilIdle(id);
  printText(`## ${areas[index]}\n` + (worker.reason === "completed"
    ? await readResponse(id)
    : `worker ${id} ended: ${worker.reason}`));
}
```

## API

```ts
function launchOptions(): Promise<{
  inherited: { model: string };
  overrides: Array<{ model: string }>; // models you may pass to spawn
  capacity: Capacity;
}>;
function spawn(prompt: string, options: SpawnOptions): Promise<Worker>;
function list(): Promise<{ agents: Worker[]; capacity: Capacity }>;
function read(id: string): Promise<Worker>;
function sendInput(id: string, message: string, options: { mode: "queue" | "steer" }): Promise<Worker>;
function interrupt(id: string, options?: { wait?: boolean; scope?: "agent" | "subtree" }): Promise<Worker>;
function waitUntilIdle(id: string): Promise<Worker>;
function readResponse(id: string): Promise<string>;
function trace(id: string, options?: TraceOptions): Promise<TracePage>;
function readText(id: string, seq: number): Promise<string>;
function readContent(id: string, ref: string, options?: { cursor?: string }): Promise<ContentPage>;
function setCompletionNotification(id: string, enabled: boolean): Promise<Worker>;

type SpawnOptions = {
  title: string; // one line
  model?: string; // an allowed override from launchOptions()
  workingDirectory?: string; // defaults to yours
  notifyOnCompletion?: boolean; // default: true when completion notifications are available to you, otherwise false
};

type Capacity = { running: number; limit: number }; // shared across the session, not reserved

type Worker = {
  id: string;
  parentId: string;
  depth: number;
  title: string;
  model: string;
  workingDirectory: string;
  notifyOnCompletion: boolean; // whether you are notified when it finishes
  pending: { queue: number; steer: number };
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    contextTokens: number;
    contextWindow: number;
    cost: number;
  };
} & (
  | { status: "working" | "stopping" }
  | { status: "idle"; reason: "completed" | "interrupted" }
  | { status: "idle"; reason: "failed"; error: { code: string; message: string } }
);

type TraceOptions = {
  kinds?: Array<"input" | "assistant" | "tool_call" | "tool_result" | "notice" | "status">;
  toolName?: string;
  limit?: number; // 1–50, default 20
  cursor?: string;
};
type TracePage = { entries: TraceEntry[]; nextCursor?: string; historyEvicted: boolean };
type TraceEntry = { seq: number; timestamp: number } & (
  | { kind: "input"; mode: "initial" | "queue" | "steer"; content: TraceContent }
  | { kind: "assistant"; content: TraceContent }
  | { kind: "tool_call"; callId: string; toolName: string; arguments: TraceContent }
  | {
      kind: "tool_result";
      callId: string;
      toolName: string;
      outcome: "succeeded" | "failed" | "blocked" | "cancelled";
      content: TraceContent;
    }
  | { kind: "notice"; code: string; content: TraceContent }
  | { kind: "status"; status: "working" | "stopping" | "idle"; reason?: "completed" | "failed" | "interrupted" }
);
type TraceContent =
  | { kind: "inline"; blocks: ContentBlock[] }
  | { kind: "reference"; ref: string; bytes: number };
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "json"; value: JsonValue }
  | { type: "image"; mimeType: string; data: string }
  | { type: "unavailable"; reason: string };
type ContentPage = { blocks: ContentBlock[]; nextCursor?: string };
```

## Workers

The prompt must carry all the context a worker needs. A worker inherits your model and working directory. Pass a `model` only when your instructions call for one of the allowed overrides.

`sendInput` with `"queue"` starts a separate turn after current work, and `"steer"` delivers the message during the current turn as soon as possible. Either starts a turn when the worker is idle. `interrupt` stops the turn and drops pending input, and by default waits until the worker has stopped. `scope: "subtree"` includes the worker's descendants. Background jobs that workers started keep running.

Completion notifications tell you when a worker you started finishes, so you can end your turn and continue when it does. When your instructions list them as unavailable, wait for workers before you rely on their results. `notifyOnCompletion: true` and `setCompletionNotification` then fail with `unavailable`.

`waitUntilIdle` returns once the worker has no active turn or pending input, also after a failed or interrupted turn. It does not wait for the worker's descendants or jobs, and cancelling the wait leaves the worker running.

## Responses and traces

`readResponse` returns the full text of the latest turn and fails unless that turn completed normally. A completed turn can still report that the worker did not accomplish its task.

`trace` returns the newest matching entries, and `nextCursor` pages back through older ones. Small content is inline. Larger content has a `ref`: read it with `readText` for an assistant or tool result entry, or page through it with `readContent`, joining text blocks in order. The trace is bounded and ends with the worker, and `historyEvicted` reports that early entries were dropped.

## Errors

| `code` | Meaning |
| --- | --- |
| `unknown_agent` | The ID is not a worker you can manage. |
| `operation_failed` | The request cannot be done now, such as a full capacity, a stopping worker, a model you may not use, or a turn that did not complete. |
| `expired_content` | The content is no longer available or not complete. |
| `invalid_cursor` | The cursor does not belong to this query. |
| `unavailable` | The call needs a capability you lack: starting and managing subagents, which every function needs, or completion notifications. |
