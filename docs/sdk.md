# node sdk

tau ships a Node SDK at `@markusylisiurunen/tau/sdk`. it starts `tau rpc` as a subprocess and provides a typed client for request/response calls plus streamed core events.

## install and import

```sh
npm install @markusylisiurunen/tau
```

```ts
import { createTauSdkClient } from "@markusylisiurunen/tau/sdk";
```

## quick start

```ts
import {
  TauRpcResponseError,
  TauTransportError,
  createTauSdkClient,
} from "@markusylisiurunen/tau/sdk";

const client = await createTauSdkClient({
  persona: "gpt-5.4-coder",
  riskLevel: "read-only",
});

const unsubscribe = client.onEvent((event) => {
  // event.event is the core event envelope from tau rpc
  console.log(event.type, event.requestId);
});

try {
  const submit = await client.submit("summarize this repository");
  console.log(submit.userHistoryEntryId, submit.turn.aborted);

  const snapshot = await client.snapshot();
  console.log(snapshot.sessionId, snapshot.historyLength);

  await client.shutdown();
} catch (error) {
  if (error instanceof TauRpcResponseError) {
    console.error(error.code, error.message, error.data);
  } else if (error instanceof TauTransportError) {
    console.error(error.message);
  } else {
    throw error;
  }
} finally {
  unsubscribe();
  await client.close();
}
```

## api

### `createTauSdkClient(options?)`

creates, connects, and initializes a new sdk client.

default behavior:

- spawns `process.execPath`
- runs tau via the package's bundled `dist/main.js`
- invokes the `rpc` subcommand
- waits up to `5000ms` for the rpc `ready` message
- sends rpc `initialize` with default metadata `{ client: { name: "tau-sdk", version: "1" } }`

returns a connected `TauSdkClient` instance.

#### options

- `cwd?: string`
  - working directory for the rpc subprocess
- `env?: NodeJS.ProcessEnv`
  - extra environment variables merged on top of `process.env`
- `persona?: string`
  - forwarded as `--persona <id>[:<reasoning>]`
- `riskLevel?: "read-only" | "read-write"`
  - forwarded as `--risk <level>`
- `noAgentContextFiles?: boolean`
  - forwarded as `--no-agent-context-files`
- `connectTimeoutMs?: number`
  - ready/initialize timeout (default `5000`)
- `initialize?: { client: { name: string; version: string } }`
  - metadata sent with rpc `initialize`
  - `client.name` and `client.version` must be non-empty strings
- `executable?: string`
  - process command to spawn (default `process.execPath`)
- `executableArgs?: string[]`
  - args inserted before script invocation
- `scriptPath?: string | null`
  - script path passed to `executable`
  - default is tau's bundled `dist/main.js`
  - pass `null` to skip script injection entirely
- `scriptArgs?: string[]`
  - args inserted between script path and `rpc`
- `rpcArgs?: string[]`
  - extra args appended after `rpc` and sdk-managed flags
- `spawn?: TauSdkSpawnFunction`
  - custom spawn implementation (mostly for tests)

example for running from a local checkout:

```ts
const client = await createTauSdkClient({
  executable: process.execPath,
  scriptPath: "dist/main.js",
});
```

### `TauSdkClient`

- `ready: TauSdkReadyMessage`
  - the rpc ready payload (`sessionId`, supported methods, protocol versions)
- `onEvent(listener)`
  - subscribes to streamed rpc `event` messages
  - returns an unsubscribe function
- `submit(text, options?)`
  - sends `session.submit`
  - `options.historyEntryId` forwards a custom user history id
- `interrupt()`
  - sends `session.interrupt`
- `snapshot()`
  - sends `session.snapshot`
- `reset()`
  - sends `session.reset`
- `shutdown()`
  - sends `session.shutdown`, then closes transport
  - idempotent
- `close()`
  - closes transport without requiring rpc shutdown
  - idempotent

## events

`onEvent` receives `TauSdkEvent`, which is the same rpc event envelope emitted by `tau rpc`:

```json
{
  "version": 1,
  "type": "event",
  "requestId": 2,
  "event": {
    "version": 1,
    "event": {
      "type": "assistant_partial"
    }
  }
}
```

for core event payload semantics, see [docs/rpc.md](./rpc.md).

## errors

sdk calls may reject with:

- `TauRpcResponseError`
  - rpc returned `ok: false` with a protocol error (`busy`, `invalid_params`, etc)
  - includes `code`, `message`, `requestId`, and optional `data`
- `TauTransportError`
  - connection/setup failures, malformed subprocess output, timeout, or closed client
- `TauProcessError` (extends `TauTransportError`)
  - subprocess failure with `exitCode`, `signal`, and captured `stderr`

all sdk-specific errors extend `TauSdkError`.
