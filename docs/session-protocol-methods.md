# Session protocol method reference

This page defines every request method in protocol version 13. It is the compact wire reference for clients that already understand connection, observation, and delta application from the [session protocol](session-protocol.md).

Every request uses `{ version, type: "request", id, method, params }`. Every successful response uses `{ version, type: "response", id, ok: true, result }`. `params` is required even when empty, and unknown object fields are stripped.

## Common values

A `sessionId` is a non-empty opaque string returned by `session.create` or `session.list`. A client-supplied `historyEntryId` is also a non-empty opaque string; omit it to let Tau generate one.

Reasoning values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Turn methods return one of these terminal outcomes:

```ts
type TurnOutcome =
  | { status: "completed"; stopReason: "stop" | "length" | "toolUse" }
  | { status: "failed"; stopReason: "error"; errorMessage?: string }
  | { status: "aborted"; stopReason: "aborted" }
  | {
      status: "blocked";
      reason: "auto-compaction-failed";
      message: string;
    };
```

A completed protocol request can therefore contain a failed, aborted, or blocked turn outcome. The protocol request itself fails only when the host cannot accept or settle it.

## Connect and find sessions

### `initialize`

Advertises client identity and optional client tools. Send it after `ready`.

```ts
params: {
  client: {
    name: string;
    version: string;
    tools?: Array<{
      name: string;
      description: string;
      parameters: unknown;
      executionTimeoutMs?: number;
    }>;
  };
}

result: {
  protocolVersion: 13;
  methods: string[];
  alreadyInitialized: boolean;
}
```

`name` and `version` must be non-empty. Tool names must not collide with host tools or tools advertised by another observer. Only the first initialization on a connection registers tools; a repeated call reports `alreadyInitialized: true`.

### `session.create`

Creates a session in one explicitly selected execution environment.

```ts
params: {
  executionEnvironment:
    | { kind: "local"; cwd: string; env?: Record<string, string> }
    | {
        kind: "cloudflare-sandbox";
        bridgeId: string;
        sandboxId: string;
        cwd: string;
      }
    | {
        kind: "fly-sprite";
        apiId: string;
        spriteName: string;
        cwd: string;
      };
  attributes: Record<string, string>;
  personaId?: string;
  reasoning?: Reasoning;
}

result: { sessionId: string }
```

`cwd` must be absolute inside the selected execution environment. Cloudflare sandboxes and Fly Sprites must already exist and be reachable through a host-configured resolver. Tau does not provision a target or repository.

`attributes` is required, including when empty. It accepts at most 32 immutable pairs; keys are 1 to 64 characters and values at most 1,024 characters. Tau stores the supplied strings without inferring missing provenance. Conventional attributes and their use are covered in [sessions](sessions.md) and [history](history.md).

A local `env` supplies execution-environment overrides. Names must be valid environment-variable names, values cannot contain NUL, and `HOME` is forbidden because the execution environment owns it. Overrides become durable session state, so do not put secrets there unless the session store is protected accordingly.

Creation returns only an id. Call `session.observe` for state and streamed updates.

### `session.list`

Lists sessions available from this host.

```ts
params: {
}
result: {
  sessions: Array<{ sessionId: string; lifecycle: "idle" | "running" }>;
}
```

### `session.observe`

Observes one session on this connection.

```ts
params: {
  sessionId: string;
}
result: {
  snapshot: SessionProtocolSnapshot;
  pendingUserMessages: PendingUserMessagesState;
  subagentActivities: SubagentActivitiesState;
}
```

Install all three baselines before applying later messages. Calling `observe` again refreshes the baselines without creating a second session.

### `session.unobserve`

Stops this connection's observation without deleting or interrupting the hosted session.

```ts
params: {
  sessionId: string;
}
result: {
  unobserved: true;
}
```

The session must currently be observed by this connection.

## Add user input and run turns

### `session.record`

Appends user-authored text without running an assistant turn.

```ts
params: { sessionId: string; text: string; historyEntryId?: string }
result: { snapshot: SessionProtocolSnapshot; userHistoryEntryId: string }
```

This is a serialized context mutation. It can interrupt an active turn and rejects pending queue or steering requests before appending the message. Use it for user-authored material that should become model-visible, not for arbitrary client diagnostics.

### `session.submit`

Appends user text and runs one ordinary turn. The session must be idle.

```ts
params: { sessionId: string; text: string; historyEntryId?: string }
result: { userHistoryEntryId: string; turn: TurnOutcome }
```

Once accepted, the turn is durably represented in `snapshot.turns[userHistoryEntryId]`. Changes stream through the observed state channels while the request remains open.

### `session.queue`

Uses the same parameters and result as `session.submit`. When the session is idle it starts immediately. While a turn is active, it appears in pending state and starts after the session becomes idle.

```ts
params: { sessionId: string; text: string; historyEntryId?: string }
result: { userHistoryEntryId: string; turn: TurnOutcome }
```

The request response remains pending until its eventual turn settles.

### `session.steer`

Requests a change of direction for active model work.

```ts
params: {
  sessionId: string;
  text: string;
}
result: {
  userHistoryEntryId: string;
  turn: TurnOutcome;
}
```

When idle, steering starts an ordinary turn. During an active turn, Tau waits for a safe continuation boundary, batches steering in arrival order, and starts one continuation turn before queued work. Batched requests share the generated `userHistoryEntryId`. Steering does not accept a caller-provided history id.

### `session.cancelPendingMessages`

Cancels all pending queue and steering requests without interrupting active work.

```ts
params: {
  sessionId: string;
}
result: {
  cancelled: Array<{ id: string; mode: "queue" | "steer"; text: string }>;
}
```

The returned order is steering first, then queued messages. Each cancelled queue or steering request receives a `cancelled` error response.

### `session.retry`

Runs one turn from current history without appending user text.

```ts
params: {
  sessionId: string;
}
result: {
  turn: TurnOutcome;
}
```

The session must be idle. Retry is unavailable while a goal controls the session; use `session.resumeGoal` for a blocked goal.

### `session.interrupt`

Requests cancellation of active session work, including turns, direct executions, model samples, and maintenance.

```ts
params: {
  sessionId: string;
}
result: {
  interrupted: boolean;
  isTurnRunning: boolean;
}
```

`isTurnRunning` may remain `true` while cancellation settles. The method also cancels unapplied boundary steering. It does not dispose reusable subagent threads; use `session.interruptSubagent` for one subagent.

## Run independent execution and sampling

### `session.exec`

Runs a fresh non-interactive login Bash in the session execution environment. It does not change the snapshot or add output to conversation history.

```ts
params: {
  sessionId: string;
  execId: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  stdinBase64?: string;
  cwd?: string;
  timeoutMs?: number;
  maxCaptureBytes?: number;
}

result: {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  closeSignal: string | null;
}
```

`execId` must be unique among active executions in the session. `stdinBase64` is limited to 16 MiB decoded. `maxCaptureBytes` is positive and at most 24 MiB; the default is 1 MiB. `HOME` cannot be overridden.

When `args` is present, Bash receives the first value as `$0` and the rest as `$@`. A safe exact-executable pattern is `command: 'exec "$0" "$@"'` with the executable and arguments in `args`. `cwd` chooses the command directory but is not a confinement boundary.

Executions can overlap turns, samples, mutations, and other executions. Clients must coordinate workspace access when consistency matters.

### `session.cancelExec`

Cancels one active execution without interrupting other work.

```ts
params: {
  sessionId: string;
  execId: string;
}
result: {
  cancelled: boolean;
}
```

### `session.sample`

Runs isolated inference against the session's active resolved model target. It uses only the supplied context and does not mutate the session, execute tool calls, emit deltas, or add to session cost.

```ts
params: {
  sessionId: string;
  context: {
    systemPrompt: string;
    messages: Message[];
    tools?: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  };
  options: { reasoning?: Reasoning; maxTokens?: number };
}

result: { message: AssistantMessage }
```

`context.messages` and the returned message use Tau's provider-neutral model message shape. Returned tool calls are data only. Samples can run concurrently and are cancelled by `session.interrupt`, transport shutdown, or host shutdown.

## Read and change session state

### `session.snapshot`

Returns the complete authoritative snapshot.

```ts
params: {
  sessionId: string;
}
result: SessionProtocolSnapshot;
```

Use this after observation, on demand, or to recover from a delta revision gap. The [session protocol](session-protocol.md) describes the snapshot and client application rules.

### `session.setReasoning`

Changes the reasoning effort for the next independently started turn.

```ts
params: {
  sessionId: string;
  reasoning: Reasoning;
}
result: {
  revision: number;
  settings: SessionProtocolSettingsSnapshot;
}
```

The update is serialized but does not interrupt a running turn. Active turns and steering continuations retain their captured settings.

### `session.setPersona`

Changes the persona to an id in the session catalog.

```ts
params: {
  sessionId: string;
  personaId: string;
}
result: SessionProtocolSnapshot;
```

This is a serialized context mutation. It interrupts an active turn and rejects pending input before returning the authoritative snapshot.

### `session.resolvePrompt`

Loads one current prompt body from the execution environment.

```ts
params: {
  sessionId: string;
  promptId: string;
}
result: {
  promptId: string;
  text: string;
}
```

Snapshot catalog entries contain prompt metadata only. Call this lazily when the user invokes a prompt.

### `session.autocompletePaths`

Returns bounded path suggestions from the execution environment.

```ts
params: { sessionId: string; query: string; limit: number }
result: { paths: string[] }
```

`limit` is a positive integer no greater than 100. Results can include directories with a trailing `/` and are not snapshot state.

## Manage goals

### `session.startGoal`

Creates a persistent active goal, commits its objective as user input, and runs autonomous continuations until the goal completes, blocks, fails, or is interrupted.

```ts
params: {
  sessionId: string;
  objective: string;
}
result: {
  userHistoryEntryId: string;
  turn: TurnOutcome;
}
```

Only one goal can exist. Queued messages wait for goal work to settle.

### `session.resumeGoal`

Resumes a blocked goal without adding a visible user message.

```ts
params: {
  sessionId: string;
}
result: {
  turn: TurnOutcome;
}
```

### `session.clearGoal`

Clears the current goal and returns the updated snapshot.

```ts
params: {
  sessionId: string;
}
result: SessionProtocolSnapshot;
```

If no goal exists, the method returns `invalid_request`. Clearing interrupts an active turn and rejects pending input.

## Reload, compact, and rewind

### `session.reload`

Reloads session-owned configuration and content from the execution environment.

```ts
params: { sessionId: string }
result: {
  snapshot: SessionProtocolSnapshot;
  warnings: string[];
  counts: { personas: number; prompts: number; skills: number };
}
```

Reload is a serialized context mutation. It interrupts an active turn and rejects pending input. It does not reload client-owned themes or tools, process environment variables, or host-wide services. See [configuration](configuration.md) for apply boundaries.

### `session.compact`

Manually replaces active model context with a generated summary.

```ts
params: {
  sessionId: string;
  mode: "summary-only" | "summary-and-last";
  guidance?: string;
}
result: {
  snapshot: SessionProtocolSnapshot;
  compactionMessage: string;
  includedLastAssistant: boolean;
}
```

Compaction interrupts an active turn, rejects pending input, and returns an authoritative replacement snapshot. A successful compaction advances the timeline epoch.

### `session.rewind`

Removes one selected user history entry and all later active state.

```ts
params: { sessionId: string; historyEntryId: string }
result: {
  snapshot: SessionProtocolSnapshot;
  historyEntryId: string;
  text: string;
  removedEntryIds: string[];
}
```

Rewind requires no active turn and no pending user input. It returns `busy` rather than interrupting work. The returned `text` is the selected user text for restoring to an editor.

## Control subagents and ephemeral contexts

### `session.interruptSubagent`

Interrupts the current run of one supervised subagent without disposing its reusable thread.

```ts
params: {
  sessionId: string;
  subagentId: string;
}
result: {
  found: boolean;
}
```

### `session.ephemeral.create`

Creates a non-persisted host-owned agent context independent of the main timeline.

```ts
params: {
  sessionId: string;
  instructions: string;
  tools: Array<"bash" | "write" | "edit" | "view_image" | "web">;
}
result: {
  contextId: string;
}
```

The context uses the hosted session's persona and execution environment plus the supplied instructions and exact tool set. It is not recoverable after host restart.

### `session.ephemeral.submit`

Runs or continues one thread in an ephemeral context.

```ts
params: {
  sessionId: string;
  contextId: string;
  threadId: string;
  forkFromThreadId?: string;
  message: string;
}
result: { threadId: string; response: string }
```

`forkFromThreadId` creates a new thread from an idle thread in the same context. Overlapping submissions to the same thread return `busy`; independent threads can run concurrently.

### `session.ephemeral.close`

Closes a context and interrupts its live threads.

```ts
params: {
  sessionId: string;
  contextId: string;
}
result: {
  closed: boolean;
}
```

`closed` is `false` when the context was not present.

## Complete delegated client-tool calls

These methods are for a client that advertised tools during `initialize`. Ordinary clients do not call them.

### `session.clientTool.ack`

Acknowledges a `session.clientTool.call` before its deadline.

```ts
params: {
  sessionId: string;
  callId: string;
  presentation: {
    actionByStatus: Record<
      "preparing" | "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled",
      string
    >;
    operation?: string;
    subject: string;
    subjectWrap: "word" | "character";
    details: Array<{
      text: string;
      tone?: "added" | "removed";
      wrap: "word" | "character";
    }>;
    metadata: string[];
  };
}
result: {
  accepted: boolean;
}
```

The presentation must already satisfy the canonical tool-card bounds. The host validates and records it without selecting or semantically truncating the subject. An accepted acknowledgement authorizes the client to begin execution.

### `session.clientTool.result`

Completes an acknowledged call with model-visible content or an error.

```ts
params:
  | { sessionId: string; callId: string; ok: true; content: string }
  | { sessionId: string; callId: string; ok: false; error: string }
result: { accepted: boolean }
```

`accepted: false` means the call was cancelled, timed out, detached, unknown, or already completed. Do not retry or send additional results for that call.
