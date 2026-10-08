# Session protocol method reference

This page lists every request method of the protocol version that ships with this Tau release. It is a compact reference for clients that already know how to connect, observe, and apply deltas, as described in the [session protocol](session-protocol.md).

Every request is `{ version, type: "request", id, method, params }`, and every successful response is `{ version, type: "response", id, ok: true, result }`. `version` is the number the server sends in `ready`. `params` is required even when empty, and unknown fields are removed.

## Common values

A `sessionId` is a non-empty opaque string returned by `session.create` or `session.list`. A client-supplied `historyEntryId` is also a non-empty opaque string; omit it to let Tau generate one.

Reasoning values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

Turn methods return one of these final outcomes:

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

A successful request can therefore report a failed, aborted, or blocked turn. The request itself fails only when the host cannot accept or finish it.

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
  protocolVersion: number; // same as `version` in `ready`
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
        kind: "fly-sprite";
        spriteName: string;
        cwd: string;
      };
  attributes: Record<string, string>;
  personaId?: string;
  reasoning?: Reasoning;
  autoCompactThresholdTokens?: number | null;
}

result: { sessionId: string }
```

`cwd` must be an absolute path inside the chosen execution environment. A Fly Sprite must already exist, and the host must have a `flySprites` connection configured. Tau does not create the target or the repository.

`attributes` is required, even when empty. It accepts at most 32 pairs, which never change after creation. Keys are 1 to 64 characters and values at most 1,024 characters. Tau stores them as given and does not fill in missing ones. Conventional attributes and their use are covered in [sessions](sessions.md) and [history](history.md).

A local `env` sets environment variables for the execution environment. Names must be valid variable names, values cannot contain NUL, and `HOME` is not allowed because the execution environment sets it. These variables are saved with the session, so do not put secrets there unless the session store is protected accordingly.

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

Install all three before applying later messages. Calling `observe` again returns fresh starting states; it does not create a second session.

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

This changes the context and waits its turn behind other changes. It can interrupt a running turn, and rejects pending queued and steering requests before adding the message. Use it for text written by the user that the model should see, not for client diagnostics.

### `session.submit`

Appends user text and runs one ordinary turn. The session must be idle.

```ts
params: { sessionId: string; text: string; historyEntryId?: string }
result: { userHistoryEntryId: string; turn: TurnOutcome }
```

Once accepted, the turn is recorded in `snapshot.turns[userHistoryEntryId]`. Updates arrive through the observed channels while the request is open.

### `session.queue`

Same parameters and result as `session.submit`. When the session is idle, the turn starts right away. While a turn is running, the message is listed as pending and starts once the session is idle.

```ts
params: { sessionId: string; text: string; historyEntryId?: string }
result: { userHistoryEntryId: string; turn: TurnOutcome }
```

The response arrives when that turn finishes.

### `session.steer`

Changes the direction of the running turn.

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

When idle, steering starts an ordinary turn. During a turn, Tau waits for the next safe point, batches steering messages in arrival order, and continues the turn with them before any queued work. Batched requests share the same generated `userHistoryEntryId`. Steering does not accept a history ID from the caller.

### `session.cancelPendingMessages`

Cancels all pending queued and steering requests without interrupting running work.

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

The session must be idle.

### `session.interrupt`

Asks the session's running work to stop: turns, direct commands, model samples, and maintenance.

```ts
params: {
  sessionId: string;
}
result: {
  interrupted: boolean;
  isTurnRunning: boolean;
}
```

`isTurnRunning` may stay `true` until the cancellation finishes. The method also cancels steering that has not been applied. It does not interrupt or remove subagents; use `session.interruptSubagent` for a subagent.

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

When `args` is present, Bash receives the first value as `$0` and the rest as `$@`. To run one executable safely, use `command: 'exec "$0" "$@"'` with the executable and its arguments in `args`. `cwd` sets the starting directory; it does not restrict the command to it.

Commands can run at the same time as turns, samples, session changes, and other commands. Clients must coordinate workspace access when consistency matters.

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

Runs a standalone model call with the session's current model. It uses only the context you supply, and does not change the session, run tools, send deltas, or add to the session's cost.

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

`context.messages` and the returned message use Tau's provider-independent message format. System messages after the first use the plain-text format with versioned metadata described in the [session protocol](session-protocol.md); the metadata is not sent to the provider. Sections and tool changes are rejected. Tool calls in the response are returned as data and never run. Samples can run at the same time, and `session.interrupt`, transport shutdown, or host shutdown cancels them.

## Read and change session state

### `session.snapshot`

Returns the complete current snapshot.

```ts
params: {
  sessionId: string;
}
result: SessionProtocolSnapshot;
```

Use this after observation, on demand, or to recover from a delta revision gap. The [session protocol](session-protocol.md) describes the snapshot and client application rules.

### `session.setAutoCompactThreshold`

Changes the main conversation's automatic-compaction threshold, starting with the next logical turn.

```ts
params: {
  sessionId: string;
  thresholdTokens: number | null;
}
result: {
  revision: number;
  settings: SessionProtocolSettingsSnapshot;
}
```

`thresholdTokens` must be a safe integer of at least 50,000, or `null` to restore the model-based default. Numeric strings are rejected. Session creation accepts the same values in the optional `autoCompactThresholdTokens` field, which defaults to `null`.

The default threshold is the model's context window minus 16,384 tokens. With an override, the effective threshold is the smaller of the configured value and that default. A model with a small context window can therefore have an effective threshold below 50,000.

The host saves the setting and publishes a `settings.set` delta to observers. Changing it does not start compaction. A running turn and its steering continuations keep their original threshold.

Reloads, persona changes, and recovery preserve the configured value. The effective threshold is recalculated for the selected model. Subagents and ephemeral threads use their model-based defaults. See [automatic compaction](sessions.md#automatic-compaction) for request-size limits and costs.

### `session.setReasoning`

Changes the reasoning effort, starting with the next turn.

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

The change waits its turn behind other changes but does not interrupt a running turn. Running turns, including their steering, keep their settings.

### `session.setPersona`

Changes the persona to an id in the session catalog.

```ts
params: {
  sessionId: string;
  personaId: string;
}
result: SessionProtocolSnapshot;
```

This changes the context and waits its turn behind other changes. It interrupts a running turn and rejects pending input, then returns the new snapshot.

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

The snapshot catalog holds only prompt IDs and labels. Call this when the user chooses a prompt.

### `session.autocompletePaths`

Returns a limited list of path suggestions from the execution environment.

```ts
params: { sessionId: string; query: string; limit: number }
result: { paths: string[] }
```

`limit` is a positive integer no greater than 100. Results can include directories with a trailing `/` and are not snapshot state.

## Reload, compact, and rewind

### `session.reload`

Reloads the session's configuration and content from the execution environment.

```ts
params: { sessionId: string }
result: {
  snapshot: SessionProtocolSnapshot;
  warnings: string[];
  counts: { personas: number; prompts: number; skills: number };
}
```

Reload changes the context and waits its turn behind other changes. It interrupts a running turn and rejects pending input. It does not reload client themes or tools, process environment variables, or host services. See [configuration](configuration.md) for when changes apply.

### `session.compact`

Replaces the model's context with a generated summary.

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

Compaction interrupts a running turn, rejects pending input, and returns the new snapshot. A successful compaction advances the timeline epoch.

### `session.rewind`

Removes one user message and everything after it.

```ts
params: { sessionId: string; historyEntryId: string }
result: {
  snapshot: SessionProtocolSnapshot;
  historyEntryId: string;
  text: string;
  removedEntryIds: string[];
}
```

Rewind requires an idle session with no pending input, and returns `busy` instead of interrupting work. The returned `text` is the removed user message, for putting back in an editor.

## Control subagents and ephemeral contexts

### `session.interruptSubagent`

Interrupts one subagent's current run. The subagent stays available for follow-ups.

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

Creates an agent context on the host that is not saved and is separate from the main conversation.

```ts
params: {
  sessionId: string;
  instructions: string;
  tools: Array<"bash" | "write" | "edit" | "view_image" | "web">;
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
result: {
  contextId: string;
}
```

The context uses the session's persona and execution environment, with the given instructions and exactly the given tools. `reasoning` sets the starting effort for new threads. Without it, the context uses the session's effort at creation time. Later changes to the session's settings do not affect the context. It does not survive a host restart.

### `session.ephemeral.submit`

Runs or continues one thread in an ephemeral context.

```ts
params: {
  sessionId: string;
  contextId: string;
  threadId: string;
  forkFromThreadId?: string;
  message: string;
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
result: { threadId: string; response: string }
```

`reasoning` changes the thread's effort before running the message, and stays in effect for later messages. Without it, the thread keeps its current effort. `forkFromThreadId` creates a new thread from an idle thread in the same context, copying its effort; a `reasoning` value given here applies only to the new fork. A second submission to a busy thread returns `busy`, while different threads can run at once.

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

These methods are for clients that offered tools in `initialize`. Other clients never call them.

### `session.clientTool.ack`

Acknowledges a `session.clientTool.call` before its deadline.

```ts
params: {
  sessionId: string;
  callId: string;
  presentation?: {
    subject?: string;
    subjectWrap?: "word" | "character";
    details?: Array<{
      text: string;
      tone?: "added" | "removed";
      wrap?: "word" | "character";
    }>;
    metadata?: string[];
  };
}
result: {
  accepted: boolean;
}
```

The optional presentation partly overrides the running tool card. If given, `subject` must be non-empty and may contain line feeds but not carriage returns. Each detail text and metadata value is one line. Presentation objects are limited to 1 MiB; subjects and detail values to 256 KiB each; metadata values to 16 KiB each; and detail and metadata collections to 1,024 entries each.

The host keeps fields you set, within those limits, and fills in omitted fields with defaults truncated as Tau truncates its own cards. It sets the action and operation, and records the final presentation. An empty `details` or `metadata` array hides that default. Once the acknowledgement is accepted, the client may start work.

### `session.clientTool.result`

Completes a call with model-visible content or an error.

```ts
type PresentationOverride = {
  subject?: string;
  subjectWrap?: "word" | "character";
  details?: Array<{
    text: string;
    tone?: "added" | "removed";
    wrap?: "word" | "character";
  }>;
  metadata?: string[];
};

params:
  | {
      sessionId: string;
      callId: string;
      ok: true;
      content: Array<
        | { type: "text"; text: string; textSignature?: string }
        | { type: "image"; data: string; mimeType: "image/jpeg" | "image/png" | "image/webp" }
      >;
      presentation?: PresentationOverride;
    }
  | {
      sessionId: string;
      callId: string;
      ok: false;
      error: string;
      presentation?: PresentationOverride;
    };
result: { accepted: boolean };
```

`content` keeps the order of text and image blocks in the model's result, snapshots, and deltas. It may be empty and can have at most 1,024 blocks, including at most 16 images in valid padded base64 of at most 3.5 MiB each. Images are never shown in the tool card.

The optional presentation applies only to the finished card, separately from the running one. The host keeps fields you set once they pass validation, and fills in omitted fields with truncated defaults. If no result arrives, the host shows a complete default card for the timeout, cancellation, detach, or other outcome.

A successful result is accepted only after the host has accepted the acknowledgement. An error sent before acknowledging records a preparation failure, such as an error from `describe`, and the tool never runs. An error sent afterward records an execution failure.

`accepted: false` means a successful result arrived before the call was acknowledged, or the call was cancelled, timed out, detached, unknown, or already finished. Do not retry or send more results for that call.
