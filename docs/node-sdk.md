# Node SDK

Tau's Node SDK is a typed client for creating, observing, and controlling sessions without handling the wire protocol yourself. Use the in-process client when your application should run the host itself, the WebSocket client to connect to a long-running `tau serve` host, or the transport adapter to bring your own connection.

The SDK speaks the same [session protocol](session-protocol.md) as the TUI, so sessions behave the same in local applications, remote integrations, and the terminal.

## Install and import

Tau requires Node.js 24 or later.

```sh
npm install @markusylisiurunen/tau
```

Import the SDK from its package entry point:

```ts
import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";
```

Tau is an ES module package.

## Choose a client

### Own an in-process host

`createTauSdkClient()` creates a local host and connects through an in-process transport:

```ts
const client = await createTauSdkClient({
  persona: "gpt-6.1-sol-coder:high",
});
```

The host uses the current user's Tau session store and history database. The `cwd` option decides which configuration the host reads at startup, for host-wide services, and defaults to `process.cwd()`. Each session reads its own configuration and content from the execution environment and `cwd` passed to `client.sessions.create()`.

The in-process options are:

```ts
type TauSdkClientOptions = {
  cwd?: string;
  persona?: string;
  reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  noAgentContextFiles?: boolean;
  refreshModelCatalog?: boolean;
  onDiagnostic?: (diagnostic: TauSdkHostDiagnostic) => void;
  connectTimeoutMs?: number;
  initialize?: { client: { name: string; version: string } };
  clientTools?: TauSdkClientTool[];
};
```

`persona`, `reasoning`, and `noAgentContextFiles` apply to sessions created by this host. `connectTimeoutMs` defaults to 5,000 ms. Default initialization metadata is `{ client: { name: "tau-sdk", version: "1" } }`.

The in-process host never writes background diagnostics to stdout or stderr. Set `onDiagnostic` to receive them as structured objects, such as history replication failures that will be retried, and route them to your application's logging.

By default, creating an in-process client starts one background check of the model catalog against `pi.dev`. The host loads `~/.config/tau/models-store.json` first, never refreshes on a timer, and keeps each session on the catalog it started with until `session.reload()`. Set `refreshModelCatalog: false` to skip this client's check, or set `TAU_OFFLINE` to skip automatic checks for the whole process. Neither removes an existing cache or blocks an explicit `tau models refresh`. See [models](models.md) for details and [security](security.md) for why the catalog is trusted.

Closing this client saves live sessions and shuts down its host. It also cancels its catalog refresh and waits for it. A refresh shared with another in-process client continues until the last of them closes.

### Connect to `tau serve`

`createTauSdkWebSocketClient()` connects to a long-running WebSocket host:

```ts
import { createTauSdkWebSocketClient } from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkWebSocketClient({
  url: "wss://tau.example.com",
  authToken: process.env.TAU_WS_AUTH_TOKEN,
  initialize: {
    client: { name: "acme-automation", version: "1.0.0" },
  },
});
```

Options are `url`, optional `authToken`, `connectTimeoutMs`, `initialize`, `clientTools`, and an optional `webSocketFactory` for runtimes that need their own WebSocket implementation. Closing the client closes only its connection; the sessions stay on the server.

The WebSocket token gives full access to all sessions. See [remote sessions](remote-sessions.md) for deployment and TLS, and [security](security.md) for the trust model.

### Supply a protocol transport

`createTauSdkClientFromTransport(transport, options?)` builds the same client on top of any `SessionProtocolTransport`, so you can use another transport with the same session behavior.

A custom transport implements:

```ts
type SessionProtocolTransport = {
  readonly ready: SessionProtocolReadyMessage;
  connect(initializeParams, timeoutMs): Promise<void>;
  request(method, params): Promise<unknown>;
  onDelta(listener): () => void;
  onEphemeral(listener): () => void;
  onPendingUserMessages(listener): () => void;
  onSubagentActivities(listener): () => void;
  onClientTool(listener): () => void;
  onFailure(listener): () => void;
  close(): Promise<void>;
};
```

When the transport fails for good, it must call the `onFailure` listeners, so the SDK can abort client tools and reject open requests.

## Create and run a session

A typical integration creates a session (which also observes it), listens for updates, submits work, and closes cleanly:

```ts
import {
  TauSessionProtocolResponseError,
  TauTransportError,
  createTauSdkClient,
} from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient();
const session = await client.sessions.create({
  executionEnvironment: {
    kind: "local",
    cwd: process.cwd(),
  },
  attributes: {
    source: "sdk",
    repository: "github.com/example/atlas",
  },
});

const unsubscribe = session.onDelta((delta) => {
  console.log(delta.sessionId, delta.fromRevision, delta.toRevision);
});

try {
  const result = await session.submit("Summarize the current changes.");
  const snapshot = await session.snapshot();
  console.log(result.userHistoryEntryId, result.turn.status, snapshot.revision);
} catch (error) {
  if (error instanceof TauSessionProtocolResponseError) {
    console.error(error.code, error.message);
  } else if (error instanceof TauTransportError) {
    console.error(error.message);
  } else {
    throw error;
  }
} finally {
  unsubscribe();
  await session.unobserve();
  await client.close();
}
```

`client.sessions.create(input)` sends `session.create`, then observes the new session before returning. `client.sessions.observe(sessionId)` observes an existing session. `client.sessions.list()` returns `{ sessionId, lifecycle }` for each session.

Creating a session requires the full execution environment and the creation attributes, which never change afterward. The `cwd` must be absolute and is a path in the chosen environment, which may not be where the SDK runs. A Fly Sprite session refers to an existing Sprite that the host is configured to reach. See [sessions](sessions.md) for creation attributes and [ownership and scope](ownership-and-scope.md) for which machine owns which paths.

Session creation also accepts `autoCompactThresholdTokens?: number | null`. Use a safe integer of at least 50,000 to set the main conversation’s auto-compaction trigger; omit it or use `null` for the model-based default. `session.setAutoCompactThreshold(50000)` changes it for the next logical turn, and `session.setAutoCompactThreshold(null)` resets it. Snapshots expose the configured and effective values in `settings`; see [automatic compaction](sessions.md#automatic-compaction).

`session.unobserve()` stops observing, and that `TauSdkSession` object can no longer be used. The session itself is not deleted. `client.close()` closes the whole client and is safe to call more than once.

The connected `TauSdkClient` exposes:

| Member | Purpose |
| --- | --- |
| `ready` | The validated server `ready` message and advertised methods. |
| `sessions.create(input)` | Create and observe a session, and return its object. |
| `sessions.list()` | List hosted session summaries. |
| `sessions.observe(sessionId)` | Observe an existing session and return its object. |
| `subscribe(listener)` | Receive deltas for every observed session on this connection. |
| `subscribePendingUserMessages(listener)` | Receive pending-state replacements across observed sessions. |
| `subscribeSubagentActivities(listener)` | Receive subagent-activity changes across observed sessions. |
| `subscribeEphemeral(listener)` | Receive ephemeral events, which are not guaranteed, across observed sessions. |
| `close()` | Close the client and everything it owns. |

Each subscription returns an unsubscribe function.

## Use the session object

`TauSdkSession.id` is the session's ID. Each method corresponds to a protocol method; the [method reference](session-protocol-methods.md) gives exact results, turn outcomes, and when a call returns `busy` or interrupts work.

| SDK method | Purpose |
| --- | --- |
| `record(text, options?)` | Append user text without running a turn. |
| `submit(text, options?)` | Append user text and run an idle session turn. |
| `queue(text, options?)` | Run now, or after the running turn. |
| `steer(text)` | Change the running turn's direction at its next safe point. |
| `cancelPendingMessages()` | Cancel all queued messages and steering not yet applied. |
| `retry()` | Run from current history without appending user text. |
| `exec(command, options?)` | Run a command in a login Bash in the execution environment. |
| `sample({ context, options })` | Run a standalone model call without changing the session. |
| `interrupt()` | Ask the session's running work to stop. |
| `snapshot()` | Read the complete current snapshot. |
| `setAutoCompactThreshold(thresholdTokens)` | Set or reset automatic compaction, starting with the next logical turn. |
| `setReasoning(reasoning)` | Set reasoning, starting with the next turn. |
| `setPersona(personaId)` | Change persona and return the updated snapshot. |
| `resolvePrompt(promptId)` | Load a current prompt body from the execution environment. |
| `autocompletePaths({ query, limit })` | Get a limited list of path suggestions from the execution environment. |
| `reload()` | Reload the session's configuration and content. |
| `compact(mode, options?)` | Manually compact model context. |
| `rewindToHistoryEntryId(id)` | Rewind from one user history entry while idle. |
| `interruptSubagent(subagentId)` | Interrupt one live subagent run. |
| `createEphemeralContext(options)` | Create an agent context on the host that is not saved. |
| `submitEphemeralThread(options)` | Run or continue one ephemeral thread. |
| `closeEphemeralContext(contextId)` | Close an ephemeral context and its threads. |
| `unobserve()` | Stop observing; this object can no longer be used. |

`submit`, `queue`, and `record` accept `{ historyEntryId?: string }`; without it, Tau generates the ID. Use `getTauSdkSessionTurnRecord(snapshot, id)` to tell whether an accepted turn is unknown, running, or finished, or `getTauSdkSessionTurnOutcome(snapshot, id)` when you only need the final outcome.

`createEphemeralContext` and `submitEphemeralThread` accept an optional `reasoning` effort. Without it, a new context uses the session's current effort. On submission, the given effort becomes the thread's effort before the turn runs. A fork copies the source thread's effort, then applies any given effort.

### Execute a command

`exec` generates a unique execution ID for you. It supports exact positional arguments, environment variables other than `HOME`, binary stdin, a starting `cwd`, a timeout, a capture limit, and a cancellation signal:

```ts
const controller = new AbortController();
const result = await session.exec('exec "$0" "$@"', {
  args: ["git", "status", "--short"],
  cwd: "/srv/workspaces/atlas",
  timeoutMs: 10_000,
  maxCaptureBytes: 256 * 1024,
  signal: controller.signal,
});

console.log(result.exitCode, result.output);
```

Aborting the signal cancels only this command, with `session.cancelExec`, and rejects the call. Turns and other commands keep running. The command is never added to the conversation.

### Sample a model

`sample` uses the session's current model and credentials, but only the context you supply, in Tau's provider-independent format:

```ts
const sampled = await session.sample({
  context: {
    systemPrompt: "Classify the request in one word.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "I cannot log in." }],
        timestamp: Date.now(),
      },
    ],
  },
  options: { reasoning: "low", maxTokens: 100 },
});

console.log(sampled.message.content);
```

You can reuse the returned assistant message in a later sample's context. If you pass tool schemas, the model may return tool calls, but Tau never runs them. Sampling sends no deltas, changes neither the snapshot revision nor the cost, and adds nothing to the conversation.

## Consume streamed state

`TauSdkClient` has subscriptions for all sessions on the connection, and `TauSdkSession` has subscriptions for one session. Prefer the session's own unless one component handles several sessions.

### Snapshot deltas

`session.onDelta(listener)` receives only that session's `TauSdkDelta` messages. Deltas that arrive before the first listener is added are kept and delivered to it. Apply them to your snapshot with `applySessionProtocolDelta`. If a revision is missing or a change is invalid, fetch a fresh copy with `session.snapshot()`.

Methods that return a full snapshot, such as reload, compact, rewind, and persona change, let the session object drop the kept deltas up to that revision. Do not replay UI effects from those dropped deltas.

### Pending input

`session.pendingUserMessages()` returns a copy of the full pending-message state. `session.onPendingUserMessages(listener)` sends the current state right away, then each newer full replacement. Its revision is separate from the snapshot's.

```ts
const stopPending = session.onPendingUserMessages(({ state }) => {
  console.log(state.messages.map((message) => [message.mode, message.text]));
});
```

All clients observing the live session share pending input. It is empty after recovery.

### Subagent activity

`session.subagentActivities()` returns the current live activity. `session.onSubagentActivities(listener)` sends the current subagents right away as `agent.set` changes, then later replacements and removals for each subagent.

To keep your own copy, use `applySessionProtocolSubagentActivitiesMessage`. This channel has its own revision and does not replace the saved `snapshot.agents`.

### Ephemeral events

`session.onEphemeral(listener)` receives footer notices, ephemeral thread progress, and timeline notices that are not saved. Delivery is not guaranteed, and these events are never replayed or included in `session.snapshot()`.

If you show `timeline.item` events, accept only the current epoch and place each by its sequence number. Compaction and rewind causes decide which of these items you keep. The [session protocol](session-protocol.md) gives the application rules.

## Host a browser diff review

`startTauSdkDiffReview()` starts the built-in browser review UI for an observed session, without the TUI and without opening a browser. Your application can put it behind its own reverse proxy, store review state, restore earlier conversations, and receive the submitted review once through a callback.

See [SDK browser diff review](sdk-diff-review.md) for startup, storage, submission, and lifecycle.

## Provide client tools

Pass `TauSdkClientTool` entries in `clientTools` to give the model tools that run in your process:

```ts
import {
  createTauSdkClient,
  truncateTauClientToolText,
} from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient({
  clientTools: [
    {
      schema: {
        name: "local_picker",
        description: "Choose one item from the user's local workspace.",
        parameters: {
          type: "object",
          properties: {
            choice: { type: "string" },
          },
          required: ["choice"],
          additionalProperties: false,
        },
        executionTimeoutMs: 60_000,
      },
      describe: (args) => {
        const input = args as { choice: string };
        return {
          subject: truncateTauClientToolText(input.choice),
        };
      },
      execute: async (args, context) => {
        const input = args as { choice: string };
        context.signal.throwIfAborted();
        const status = await context.executionEnvironment.exec(
          "git status --short",
          {
            signal: context.signal,
          },
        );
        return {
          content: status.output || "Working tree is clean.",
          presentation: {
            subject: truncateTauClientToolText(input.choice),
          },
        };
      },
    },
  ],
});
```

The handler receives `sessionId`, the calling `agentId`, `callId`, an `AbortSignal`, and the execution-environment API. The handler runs on the client machine, while `context.executionEnvironment.exec()` runs commands in the session's execution environment.

`describe` is optional. If present, the SDK calls it before accepting the call, with the arguments and a smaller context of `sessionId`, `agentId`, `callId`, and `signal`, without execution-environment access. It may return a partial presentation for the running card, with `subject`, `subjectWrap`, `details`, or `metadata`. Tau sets the action and operation, fills in omitted fields, and acknowledges with the result before calling `execute`.

The execution result may include the same partial shape for the finished card. Return a string or `{ content, presentation? }` for success, or `{ ok: false, error, presentation? }` for a handled failure. `content` may be a string, sent as one text block, or an ordered array of text and image blocks. Omitted presentation fields get Tau's defaults, and an empty `details` or `metadata` array hides that default. If `describe` throws, the SDK reports a preparation error and does not call `execute`. If no result is returned, because of cancellation, timeout, detach, or another failure, the host shows a complete default card.

Tau keeps every presentation field you set, up to the protocol limits, without truncating or normalizing it. `truncateTauClientToolText` truncates text for you by lines and characters, keeping the start or the middle. Use its result directly as a subject. For a block of detail text, split the result on `\n` and make each line one `details` entry; use `maxLines: 1` when the result goes into a single entry. The helper does not replace protocol validation. The SDK aborts handlers when the host cancels, the client closes, or the transport fails, and `client.close()` waits for running handlers to finish.

Each assistant turn keeps the tool definitions it started with. Client tools are not affected by the persona's tool list. Names must not match host tools or tools of another observing client. See [client tools](client-tools.md) for authority, limits, command-backed tools, and disconnect behavior.

### Build a code-mode tool

`createTauCodeModeClientTool()` turns an API you define into a client tool that runs one-off JavaScript programs against it:

```ts
import {
  buildTauCodeModeToolDescription,
  createTauCodeModeClientTool,
} from "@markusylisiurunen/tau/sdk";

const name = "tickets";
const tickets = createTauCodeModeClientTool({
  name,
  description: buildTauCodeModeToolDescription({
    name,
    description: "Read support tickets.",
  }),
  documentation: "# Tickets API\n\nUse `tickets.get(id)` to read one ticket.",
  api: {
    get: async ([id], { signal }) => ticketClient.get(String(id), { signal }),
  },
});
```

Pass `tickets` in `clientTools`. The model's code receives your API namespace, `docs` (read on demand), `printText`, the async `printImage`, `truncate` and `truncateLines`, and the real `Date` and `Math`. API calls pass through a size-limited JSON bridge. The submitted code, truncated and wrapped, is the subject of the running and finished tool cards. You write the description; the description builder is optional.

Use `await printImage({ data, mimeType })` to return a base64 image. Results contain an ordered `content` array of text and image blocks, and SDK client tools keep that order: consecutive text output forms one block, and each image splits the text before and after it. The helper validates and prepares JPEG, PNG, or WebP images outside the sandbox, creates no files, and uses the limits described in [tools](tools.md).

Code-mode calls and standalone runs accept an optional `maxOutputTokens` (1 through 65,536), with a default text budget of 8,192 tokens. Saving output to files is off unless the definition provides a `persistOutput` callback.

The SDK also exports `executeTauCodeMode` for standalone runs. The separate `@markusylisiurunen/tau/code-mode` entry point also exports `runTauClientToolCommand` and `runTauCodeModeCommand` for command tools. Use these helpers instead of implementing the protocol yourself.

## Cancel and close deliberately

Most turn and session-changing methods do not accept an `AbortSignal`. Call `session.interrupt()` to stop running work on the host. `session.exec()` is the exception: its optional signal cancels only that command.

`session.unobserve()` ends one session object. `client.close()` ends the connection: it rejects open requests, aborts client tool handlers, waits for them to finish, and closes the transport. For the default in-process client, it also saves sessions and shuts down the host. Over WebSocket, the remote host and its sessions keep running.

Always close clients in `finally`. Never use a session object after `unobserve()`, or a client after `close()`.

## Handle errors

All exported SDK and transport errors extend `TauSessionClientError`:

- `TauSessionProtocolResponseError` means the host returned a protocol error. It exposes `code`, `message`, `requestId`, and optional `data`.
- `TauTransportError` means the connection failed: during setup, framing, version checks, a timeout, closing, or another fatal transport error.

Branch on a protocol error's `code`, not its message. A successful request can still return a failed, aborted, or blocked turn outcome, so inspect `result.turn.status` separately.

An exception in one listener does not stop delivery to others. Handle errors inside your listeners, and keep state updates deterministic.

## Use the public types and helpers

The SDK entry point exports every type an integration needs, so you never import from internal modules:

- `TauSdkClient`, `TauSdkSession`, client option types, session summaries, and request and result aliases;
- `TauSdkDelta`, `SessionProtocolSnapshot`, pending-message types, subagent-activity types, and ephemeral event types;
- `TauSdkClientTool`, its execution context and execution-environment API, and code-mode definition and result types;
- `SessionProtocolTransport`, listener types, WebSocket options, and transport errors.

It also exports `applySessionProtocolDelta`, `applySessionProtocolSubagentActivitiesMessage`, the turn-ledger helpers, and user-text projection helpers:

```ts
import {
  getTauUserDisplayText,
  getTauUserModelText,
  projectTauUserText,
} from "@markusylisiurunen/tau/sdk";
```

Use `getTauUserDisplayText` before showing user text from a snapshot. It removes Tau metadata and leading hidden `<system>` blocks. `getTauUserModelText` removes Tau metadata but keeps the hidden blocks the model sees. `projectTauUserText` returns both. These helpers are for user messages only.
