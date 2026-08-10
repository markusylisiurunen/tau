# Client tools

Client tools let an attached client contribute capabilities that the host does not own. A TUI can open a local review interface, a Telegram runner can invoke a workspace-specific command, and an SDK client can provide an in-process handler. The model sees an ordinary tool schema, but execution stays with the client that advertised it.

This boundary matters in remote sessions. The client process, host, and execution environment may be three different machines. A command client tool starts on the client machine. If it needs to inspect or change the agent's workspace, it must use the provided execution-environment facade rather than assuming the same filesystem is locally mounted.

## Which client advertises which tools

Tau's TUI advertises two built-in client tools:

- `diff_review` runs the TUI-local diff review flow while capturing repository data through the session execution environment.
- `prefill_input` puts a draft in an empty TUI editor for the user to edit and submit. It never submits the draft and does not replace existing editor text.

The TUI also advertises the configured command client tools selected for its current client-side working directory. This is true for local `tau` and for `tau attach`. During remote attach, the command executable and its environment belong to the attaching machine, not the remote host.

A Telegram runner advertises only the configured command client tools selected from each prepared workspace's Tau configuration. It does not advertise TUI-only tools. Repository, persistent-directory, and composite workspace preparation determines the client-side configuration scope used for that Telegram session. See [Telegram](telegram.md) for workspace ownership.

Node SDK clients can supply `TauSdkClientTool` handlers directly when they initialize. The same session routing, cancellation, and execution-environment contracts apply.

Only an observing client can contribute tools to a session. The tools disappear when that client detaches or disconnects. If several clients observe one session, at most one may advertise a given client-tool name. Tau rejects the later attachment on a name collision. Client-tool names must also not collide with host or intrinsic tools.

## Configure command client tools globally

Executable client-tool definitions are accepted only from the global `~/.config/tau/config.json`, and that global level is in scope only when the client-side working directory is inside home. Project configuration cannot define executable commands. This prevents a checked-out repository from silently introducing a process that runs on the client machine.

A definition requires `name`, `defaultEnabled`, `description`, `parameters`, and `command`:

```json
{
  "clientTools": [
    {
      "name": "notify_desktop",
      "defaultEnabled": true,
      "description": "Show a desktop notification after completing requested work.",
      "parameters": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "message": { "type": "string" }
        },
        "required": ["title", "message"],
        "additionalProperties": false
      },
      "command": "./bin/tau-notify",
      "args": ["--protocol"],
      "executionTimeoutMs": 10000
    }
  ]
}
```

The exact fields are:

| Field | Requirement |
| --- | --- |
| `name` | Required non-empty string. Names must be unique within `clientTools` and must not collide with tools already bound to the session. |
| `defaultEnabled` | Required boolean. Controls selection when no project level supplies `enabledClientTools`. |
| `description` | Required non-empty model-facing description. State when the tool should be used and any important side effects. |
| `parameters` | Required object JSON Schema whose root has `"type": "object"`. Tau passes the remaining schema through and validates each invocation against it. |
| `command` | Required non-empty executable name or path. |
| `args` | Optional array of literal string arguments. |
| `executionTimeoutMs` | Optional positive integer. The default is 60,000 ms. |

Unknown fields on a definition are discarded. Invalid entries are skipped with configuration diagnostics; valid siblings remain available. Duplicate names are exact and case-sensitive.

### Command path resolution

A `command` containing `/` is resolved as a path from home, the root of the global configuration level. For example, `./bin/tau-notify` resolves to `~/bin/tau-notify`. A bare command such as `tau-notify` is left unchanged and resolved through the client process's `PATH` when invoked.

Tau starts the executable directly with `args`. It does not use a shell, expand globs, interpolate variables, or process quoting syntax. If shell behavior is truly needed, configure an explicit shell executable and arguments, but a dedicated executable is easier to validate and cancel safely.

The process inherits the owning client process's environment unchanged. Unlike execution-environment Bash, Tau does not remove credential-shaped variables from command client tools. Treat every configured executable as trusted local code and give it only the credentials it needs.

## Select tools per project

Project `.tau/config.json` files may set `enabledClientTools` to an exact allowlist of globally defined names:

```json
{
  "enabledClientTools": ["notify_desktop", "open_ticket"]
}
```

Tau uses the nearest project level that defines this field. It does not merge allowlists across project levels.

Selection has three distinct states:

- If no project level defines `enabledClientTools`, Tau selects global definitions with `defaultEnabled: true`.
- If the nearest definition is a non-empty array, Tau selects exactly the known names in that array, regardless of `defaultEnabled`.
- If the nearest definition is `[]`, Tau disables every configured command client tool for that workspace.

Unknown selected names are ignored without an error. Repeated names are deduplicated. Names are matched exactly and case-sensitively.

`enabledClientTools` selects trusted global definitions; it cannot change their command, arguments, schema, description, or timeout. The field is valid only at project scope. Conversely, `clientTools` is valid only at global scope.

For Telegram, `enabledClientTools: []` is the normal way to disable configured tools for a prepared workspace. For the TUI, the startup flag described below can disable all client tools at once.

## Disable TUI client tools

Start a local or attached TUI with:

```bash
tau --no-client-tools
```

For attach mode, place the flag with the attach options:

```bash
tau attach --no-client-tools ws://host.example:8787
```

This disables both configured command tools and the TUI's built-in `diff_review` and `prefill_input`. It does not disable host tools, intrinsic `tau_docs`, or session goal tools.

Client tools are selected and advertised when the owning client starts and connects. `/reload` refreshes host-side session configuration and content but does not recreate the TUI or Telegram client's advertised tool set. Restart or reconnect the owning client after changing `clientTools`, `enabledClientTools`, or `--no-client-tools` behavior.

Diff-tool launcher settings are separate from command client-tool definitions. They choose how the TUI starts its local diff review application. See [TUI](tui.md).

## Implement a command tool with Tau's helper

Command client tools use Tau's version 3 bidirectional NDJSON protocol over stdin and stdout. Use the exported helper instead of implementing framing manually:

```ts
import { runTauClientToolCommand } from "@markusylisiurunen/tau/code-mode";

await runTauClientToolCommand(async (args, context) => {
  const input = args as { title: string; message: string };
  context.signal.throwIfAborted();

  await showNotification(input.title, input.message, context.signal);
  return { content: "Notification displayed." };
});
```

`runTauClientToolCommand` reads the invocation, provides a standard context, handles execution-environment request and cancellation framing, and writes the final result. It also reacts to `SIGINT`, `SIGTERM`, and protocol input closure by aborting the handler.

Reserve stdout for the helper's protocol. Write diagnostics to stderr. Return either a string or `{ content: string }`; that text becomes the model-visible tool result.

The handler receives:

```ts
{
  sessionId: string;
  agentId: string;
  callId: string;
  signal: AbortSignal;
  executionEnvironment: {
    exec(command: string, options?): Promise<ExecResult>;
  };
}
```

`sessionId` routes the owning session. `agentId` identifies the owning agent for scratch-space and attribution purposes. `callId` identifies this invocation. Do not substitute one identity for another or cache context across calls.

`signal` aborts when the assistant turn is interrupted, the host cancels or times out the tool, the owning client closes, the transport fails, or the protocol input closes. Pass it to all cancellable local work and to execution-environment calls.

### Use the execution-environment facade

`context.executionEnvironment.exec()` runs a command in the session execution environment through the existing session execution boundary. It does not run on the client machine. Use it for agent-visible files, repository commands, and workspace state:

```ts
const result = await context.executionEnvironment.exec("git status --short", {
  cwd: "/workspace/atlas",
  timeoutMs: 10000,
  maxCaptureBytes: 256 * 1024,
  signal: context.signal,
});

return { content: result.output || "Working tree is clean." };
```

The optional execution settings are `args`, `env`, binary `stdin`, `cwd`, `timeoutMs`, `maxCaptureBytes`, and `signal`. The result reports combined and split output, exit status, truncation, timeout, cancellation, and closing signal. Commands use the execution environment's login Bash behavior, path resolution, environment, and authority. `HOME` belongs to that environment and cannot be overridden through the session execution request.

Up to eight execution requests may be active while their responses are being delivered. Each request ID is single-use. Cancelling one request does not cancel unrelated requests, although cancellation of the whole client-tool context aborts all of them.

## Implement code-mode client tools

Tau exports two higher-level helpers for client tools that expose a bounded JavaScript API:

- `createTauCodeModeClientTool` creates an in-process `TauSdkClientTool` for an SDK client.
- `runTauCodeModeCommand` runs a code-mode definition as a command client-tool executable.

For an executable configured through `clientTools`, keep the exact parameters schema to one required `code` string with no additional properties, then call `runTauCodeModeCommand` in the executable. For SDK clients, pass the returned tool from `createTauCodeModeClientTool` in the client's `clientTools` array.

Both helpers supply the invocation identities, cancellation signal, execution-environment facade, progressive `docs` value, bounded API bridge, and agent-scoped scratch files. The model-facing description remains explicit caller input. Use Tau's optional shared description builder only when its progressive-disclosure wording fits the tool; Tau does not silently rewrite a configured description.

The generic code-mode runtime is documented through its exported types and generated tool documentation. Do not layer another unbounded process or network channel behind it without making that authority clear in the tool description.

## Limits and failure behavior

The command protocol is intentionally bounded:

- The command-to-client stdout NDJSON stream is limited to 512 frames and 192 MiB in total.
- Each frame on that stdout stream is limited to 24 MiB.
- The final UTF-8 result is limited to 1 MiB.
- Captured stderr is limited to 1 MiB. Exceeding it terminates the command and fails the tool.
- Execution-environment stdin is limited to 16 MiB decoded, and capture can be requested up to 24 MiB per execution.
- At most eight execution requests may be unresolved concurrently.

The configured `executionTimeoutMs` covers the whole command invocation and defaults to 60 seconds. The host also requires the owning client to acknowledge a dispatched call promptly. Standard Tau SDK clients handle acknowledgement before invoking the tool handler.

Tau starts each configured command in a detached process group. Cancellation sends termination to the group and escalates to `SIGKILL` after a short grace period, even if the original group leader exits first. The helper aborts pending execution-environment requests and stops accepting work when stdin closes.

A successful command must exit with status zero after producing one final version 3 result. Missing results, malformed framing, data after the result, reused execution request IDs, nonzero exit, timeout, cancellation, excessive output, and protocol-limit violations fail the call. Stderr is included in failure diagnostics but is not a successful result channel.

## Disconnects, reconnects, and durability

Client-tool execution is transient. Calls are not persisted for replay, and Tau does not move them to another client when the owner disappears.

When an observing owner detaches, Tau removes its schemas from subsequent turns and cancels its active calls. Client close and terminal transport failure abort local handlers and targeted execution-environment commands. The client waits for active handlers to settle before close completes, but it does not send late results after the transport is terminal.

After reconnecting, the new client advertises its current tool definitions and must observe the session before they become available there. If another observer already owns one of those names, attachment fails on the collision. A reconnect does not resume a command process from the previous connection.

## Security and troubleshooting

Command client tools are trusted executables with the full environment and operating-system authority of the client process. Keep definitions in the user-owned global configuration, use narrow JSON Schemas, avoid shell interpolation, bound local work, honor cancellation, and return only data the model needs. A project allowlist is permission to select a global definition, not permission to provide executable code.

The execution-environment facade is powerful in a different place. Validate every model-supplied argument before building commands, prefer fixed command names and argument arrays, avoid concatenating untrusted text into shell source, and use the context signal and bounded capture options.

When a tool is unexpectedly absent, check:

1. The owning client is currently observing the session.
2. The global definition is valid and in scope for the client-side `cwd`.
3. The nearest `enabledClientTools` selection includes the exact name, or `defaultEnabled` applies.
4. `--no-client-tools` is not active for the TUI.
5. No other observer or host tool owns the same name.
6. The client was restarted or reconnected after configuration changes.

For execution failures, distinguish client-local process errors from `executionEnvironment.exec()` errors on the session machine. Check executable permissions, the client `PATH`, stderr diagnostics, timeout and framing limits, then the execution environment's own `cwd`, login startup files, and command availability. See [tools](tools.md), [security](security.md), and [troubleshooting](troubleshooting.md).
