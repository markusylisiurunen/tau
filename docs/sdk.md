# Node SDK

The SDK is a typed client for creating and controlling Tau sessions from Node, without handling the [wire protocol](session-protocol.md). This page gives an overview. The exported types describe every option and result, and the [source](https://github.com/markusylisiurunen/tau) is the reference for details.

```sh
npm install @markusylisiurunen/tau
```

Tau is an ES module package and requires Node.js 26 or newer. Everything you need is exported from `@markusylisiurunen/tau/sdk`.

## Run a session

```ts
import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient();
try {
  const session = await client.sessions.create({
    executionEnvironment: { kind: "local", cwd: process.cwd() },
    attributes: { source: "my-app" },
  });
  const result = await session.submit("Summarize the current changes.");
  const snapshot = await session.snapshot();
  console.log(result.turn.status, snapshot.revision);
} finally {
  await client.close();
}
```

`cwd` must be an absolute path in the execution environment, which can also be `{ kind: "fly-sprite", spriteName, cwd }`. A successful call does not mean the turn succeeded, so check `result.turn.status`, which is `completed`, `failed`, `aborted`, or `blocked`.

## Choose a client

| Function | Host | When to use it |
| --- | --- | --- |
| `createTauSdkClient(options?)` | In your process | Your application runs Tau itself. Closing the client saves sessions and stops the host. |
| `createTauSdkWebSocketClient({ url, authToken?, ... })` | `tau serve` | You share a long-running host. Closing only ends the connection. |
| `createTauSdkClientFromTransport(transport)` | Your choice | You bring your own `SessionProtocolTransport`. |

The in-process client accepts `persona`, `reasoning`, `noAgentContextFiles`, `refreshModelCatalog`, `clientTools`, and `onDiagnostic`. Sessions read their configuration from their own execution environment. The host never writes diagnostics to stdout or stderr. They arrive through `onDiagnostic`, including configuration warnings and history failures.

## Use a session

`client.sessions` has `create`, `list`, `observe`, `setRetention`, and `collect`. A session object has these groups of methods:

| Purpose | Methods |
| --- | --- |
| Send input | `submit`, `queue`, `steer`, `record`, `retry`, `cancelPendingMessages` |
| Stop work | `interrupt`, `interruptSubagent` |
| Read state | `snapshot`, `pendingUserMessages`, `subagentActivities` |
| Change settings | `setPersona`, `setReasoning`, `setAutoCompactThreshold`, `reload` |
| Manage context | `compact`, `rewindToHistoryEntryId` |
| Use the environment | `exec`, `autocompletePaths`, `resolvePrompt` |
| Call a model | `sample`, `createEphemeralContext`, `submitEphemeralThread`, `closeEphemeralContext` |
| Finish | `unobserve` |

`exec` runs a command in the execution environment without adding it to the conversation:

```ts
const result = await session.exec("git status --short", { timeoutMs: 10_000 });
```

`sample` runs a standalone model call with the session's model and only the context you pass, and it never changes the session. Ephemeral contexts run separate agent threads that are not saved, for side tasks such as answering a question about a diff.

`submit`, `queue`, and `record` accept a `historyEntryId`. `getTauSdkSessionTurnRecord(snapshot, id)` tells you whether an accepted turn is unknown, running, or finished, which helps after a reconnect.

## Follow live state

```ts
const stop = session.onDelta((delta) => render(delta));
```

Apply deltas to your snapshot with `applySessionProtocolDelta`, and fetch `session.snapshot()` if a revision is missing. `onPendingUserMessages` and `onSubagentActivities` send their current state right away and then each change. `onEphemeral` carries live notices that are not guaranteed to arrive. The [session protocol](session-protocol.md) explains these channels.

Before showing user text from a snapshot, use `getTauUserDisplayText`, which removes Tau metadata and hidden `<system>` blocks.

## Provide client tools

Pass `clientTools` to give the model tools that run in your process:

```ts
const client = await createTauSdkClient({
  clientTools: [
    {
      schema: {
        name: "workspace_status",
        description: "Report the Git status of the workspace.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        executionTimeoutMs: 60_000, // null for no deadline
      },
      execute: async (args, context) => {
        const status = await context.executionEnvironment.exec(
          "git status --short",
          {
            signal: context.signal,
          },
        );
        return { content: status.output || "Working tree is clean." };
      },
    },
  ],
});
```

The handler runs in your process, and `executionEnvironment.exec` runs on the session's machine. Return a string or `{ content, presentation? }`, or `{ ok: false, error }` for a handled failure. An optional `describe` function customizes the running tool card. See [client tools](client-tools.md).

`createTauCodeModeClientTool` gives the model a [code mode](code-mode.md) sandbox for an API you define:

```ts
const tickets = createTauCodeModeClientTool({
  name: "tickets",
  description: "Read support tickets with JavaScript.",
  documentation: "# Tickets API\n\nUse `tickets.get(id)` to read one ticket.",
  api: {
    get: async ([id], { signal }) => ticketClient.get(String(id), { signal }),
  },
});
```

## Host a diff review

`startTauSdkDiffReview` serves the browser review interface for an observed session, without opening a browser:

```ts
const review = await startTauSdkDiffReview({
  session,
  source: { kind: "git_diff", diffArgs: ["main...HEAD"] },
});
console.log(review.url);
try {
  const result = await review.result;
  if (result.status === "returned") console.log(result.outcome, result.review);
} finally {
  await review.close();
}
```

The server listens on loopback and has no authentication, so put it behind a protected proxy to expose it. Pass `storage` to save review state and `onSubmit` to save a submission before the browser sees success.

## Errors and closing

Errors extend `TauSessionClientError`. `TauSessionProtocolResponseError` means the host returned an error, so branch on its `code`. `TauTransportError` means the connection failed.

Most methods take no `AbortSignal`, so call `session.interrupt()` to stop work on the host. `session.exec` accepts a signal for that command. Always call `client.close()` in `finally`. It rejects open requests and waits for running client tool handlers.

To keep a session loaded without clients, or to confirm it is unloaded before deleting its files, see [session protocol](session-protocol.md).
