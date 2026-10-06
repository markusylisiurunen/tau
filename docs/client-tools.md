# Client tools

Client tools are tools that an attached client adds to a session. A TUI can open a local review interface, a Telegram runner can run a workspace-specific command, and an SDK client can provide an in-process handler. The model sees an ordinary tool, but the tool runs in the client that offered it.

In a remote session, the client, the host, and the execution environment may be three different machines. A command client tool starts on the client machine. To read or change the agent's workspace, it must use the execution-environment API that Tau provides. It cannot assume the workspace is on its own filesystem.

## Which client advertises which tools

Tau's TUI advertises two built-in client tools:

- `diff_review` runs diff review on the TUI machine, reading repository data from the session's execution environment.
- `prefill_input` puts a draft in an empty TUI editor for the user to edit and submit. It never submits the draft and does not replace existing editor text.

The TUI also offers the configured command client tools selected for its own working directory, both with local `tau` and with `tau attach`. When attached to a remote host, the command and its environment are on the attaching machine, not on the host.

A Telegram runner offers the built-in `send_photo_to_telegram`, `send_video_to_telegram`, `send_audio_to_telegram`, and `send_document_to_telegram` tools, plus the command client tools selected by each prepared workspace's Tau configuration. The built-in [file delivery tools](tools.md#sending-files-to-telegram) send files to the session's chat and are not affected by `enabledClientTools`. The runner does not offer the TUI's tools. The session's workspace, whether repository, persistent directory, or composite, decides which configuration selects its tools. See [Telegram projects and workspaces](telegram-projects.md) for workspace types.

Node SDK clients can pass `TauSdkClientTool` handlers when they initialize. The same rules for routing, cancellation, and execution-environment access apply.

Only a client that is observing a session can add tools to it. The tools disappear when that client detaches or disconnects. When several clients observe one session, only one may offer a given tool name, and Tau rejects the later client if names collide. Client tool names also must not match host tools or built-in tools.

## Configure command client tools globally

Client tool commands can be defined only in the global `~/.config/tau/config.json`, and only when the client's working directory is inside home. Project configuration cannot define commands, so a cloned repository can never add a process that runs on your machine.

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
| `parameters` | Required JSON Schema whose root has `"type": "object"`. Tau passes the rest of the schema through unchanged and validates every call against it. |
| `command` | Required non-empty executable name or path. |
| `args` | Optional array of literal string arguments. |
| `executionTimeoutMs` | Optional positive integer. The default is 60,000 ms. |

Unknown fields on a definition are ignored. An invalid entry is skipped with a configuration warning, and the other entries stay available. Names are compared exactly, including case, when checking for duplicates.

### Command path resolution

A `command` that contains `/` resolves from home, because the definition is global. For example, `./bin/tau-notify` resolves to `~/bin/tau-notify`. A bare command such as `tau-notify` resolves through the client process's `PATH` when the tool runs.

Tau starts the executable directly with `args`. It does not use a shell, expand globs, substitute variables, or process quotes. If you really need a shell, configure the shell as the command with explicit arguments, but a dedicated executable is easier to validate and to cancel safely.

The process inherits the client process's environment unchanged. The agent's Bash tool removes variables that look like credentials, but command client tools keep them. Treat every configured executable as trusted local code and give it only the credentials it needs.

## Select tools per project

Project `.tau/config.json` files may set `enabledClientTools` to an exact allowlist of globally defined names:

```json
{
  "enabledClientTools": ["notify_desktop", "open_ticket"]
}
```

Tau uses the nearest project level that sets this field. Lists from different levels are not combined.

There are three cases:

- If no project level defines `enabledClientTools`, Tau selects global definitions with `defaultEnabled: true`.
- If the nearest definition is a non-empty array, Tau selects exactly the known names in that array, regardless of `defaultEnabled`.
- If the nearest definition is `[]`, Tau disables every configured command client tool for that workspace.

Unknown names are ignored without an error. Repeated names are removed. Names match exactly, including case.

`enabledClientTools` only selects global definitions. It cannot change their command, arguments, schema, description, or timeout. The field is allowed only in project configuration, and `clientTools` only in global configuration.

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

This disables the configured command tools and the TUI's built-in `diff_review` and `prefill_input`. Host tools and the built-in `tau_docs` tool are not affected.

A client selects and offers its tools when it starts and connects. `/reload` does not change the tools a TUI or Telegram client offers. Restart or reconnect the client after changing `clientTools`, `enabledClientTools`, or `--no-client-tools`.

Diff review uses Tau’s built-in browser tool on the TUI machine, separately from command client-tool definitions. See [TUI](tui.md).

## Implement a command tool with Tau's helper

Command client tools use Tau's version 5 bidirectional NDJSON protocol over stdin and stdout. Use the exported helper instead of implementing framing manually:

```ts
import {
  runTauClientToolCommand,
  truncateTauClientToolText,
} from "@markusylisiurunen/tau/code-mode";

await runTauClientToolCommand({
  name: "notify_desktop",
  describe(args) {
    const input = args as { title: string; message: string };
    return {
      subject: truncateTauClientToolText(input.title),
    };
  },
  async execute(args, context) {
    const input = args as { title: string; message: string };
    context.signal.throwIfAborted();

    await showNotification(input.title, input.message, context.signal);
    return {
      content: "Notification displayed.",
      presentation: {
        subject: truncateTauClientToolText(input.title),
      },
    };
  },
});
```

`describe` is optional. If present, it runs before the call is accepted and may return a partial presentation for the running tool card, with any of `subject`, `subjectWrap`, `details`, or `metadata`. The execution result may include the same partial shape for the finished card. Tau fills in every omitted field, controls the card's lifecycle and the operation label (derived from the tool name), and shows a complete default card if execution ends without a result.

Tau keeps every presentation field you set, up to the protocol limits. It does not truncate or normalize client text for display. `truncateTauClientToolText` truncates text for you, with optional `maxLines`, `maxLineChars`, and a `head` or `middle` strategy. Its defaults match the length Tau uses for its own subjects, and you can choose larger or smaller limits.

For a subject, use the returned string directly. For a block of detail text, split the returned string on `\n` and map each line to one `details` entry:

```ts
const details = truncateTauClientToolText(output, {
  maxLines: 7,
  maxLineChars: 512,
  strategy: "middle",
})
  .split("\n")
  .map((text) => ({ text }));
```

Each detail or metadata entry is one line, so use `maxLines: 1` when putting the helper's result directly into one entry. The helper only shapes text; the protocol's byte and count limits still apply. An empty `details` or `metadata` array hides that phase's default content.

`runTauClientToolCommand` reads the `prepare` frame, writes `ready` with any running presentation, waits until the host accepts the call, then runs your handler and writes the final result. It also handles execution-environment requests and their cancellation. On `SIGINT`, `SIGTERM`, or closed stdin, it aborts the handler.

Reserve stdout for the helper's protocol. Write diagnostics to stderr. Return a string or `{ content, presentation? }` for success. Return `{ ok: false, error, presentation? }` for a structured tool failure. `content` may be a string or ordered text/image blocks; the helper wraps strings in text blocks.

### Version 5 frame reference

Write each frame as one JSON object followed by a newline. Unknown fields are invalid.

Tau starts the exchange by writing:

- `{ version: 5, type: "prepare", sessionId, agentId, callId, toolName, arguments }` exactly once. The ID fields are non-empty strings, and `arguments` is the model's input after validation.
- `{ version: 5, type: "execute" }` after Tau accepts the command's `ready` frame. The command may not start work before this frame.

The command writes:

- `{ version: 5, type: "ready", presentation?: PresentationOverride }` exactly once after preparation.
- `{ version: 5, type: "result", ok: true, content, presentation?: PresentationOverride }` or `{ version: 5, type: "result", ok: false, error, presentation?: PresentationOverride }` exactly once, after `execute`. `error` is a string. `content` is an ordered array of at most 1,024 text (`{ type: "text", text }`) or image (`{ type: "image", data, mimeType }`) blocks. At most 16 images are allowed: padded base64, at most 3.5 MiB decoded each, JPEG/PNG/WebP MIME types.

After `execute`, the command may write `{ version: 5, type: "exec", requestId, command, options }`. The non-empty `command` string runs in the session execution environment. `options` is required and may contain `args: string[]`, `env: Record<string, string>`, base64-encoded string `stdinBase64`, string `cwd`, positive integer `timeoutMs`, and positive integer `maxCaptureBytes`.

Tau answers with the same `requestId` and either:

- `{ version: 5, type: "exec.result", requestId, ok: true, result: ExecResult }`
- `{ version: 5, type: "exec.result", requestId, ok: false, error: string }`

`ExecResult` contains string `output`, `stdout`, and `stderr`; nullable `exitCode` and `closeSignal`; and boolean `truncated`, `timedOut`, and `aborted`. A command may cancel one unresolved request with `{ version: 5, type: "exec.cancel", requestId }`. Request IDs must be non-empty strings and cannot be reused within a call.

### Implement the protocol directly in JavaScript

A JavaScript command can implement the version 5 handshake using only Node.js built-ins, without importing Tau or the code-mode package:

```js
#!/usr/bin/env node

import { arch, platform, release } from "node:os";
import { createInterface } from "node:readline";

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
const input = lines[Symbol.asyncIterator]();

async function readFrame() {
  const next = await input.next();
  if (next.done) throw new Error("Tau closed the command protocol");
  return JSON.parse(next.value);
}

function writeFrame(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const prepare = await readFrame();
if (
  prepare.version !== 5 ||
  prepare.type !== "prepare" ||
  prepare.toolName !== "system_info"
) {
  throw new Error("Invalid system_info preparation");
}

writeFrame({
  version: 5,
  type: "ready",
  presentation: {
    subject: "local system",
  },
});

const execute = await readFrame();
if (execute.version !== 5 || execute.type !== "execute") {
  throw new Error("Invalid system_info authorization");
}

writeFrame({
  version: 5,
  type: "exec",
  requestId: "git-status",
  command: "git status --short",
  options: {
    maxCaptureBytes: 256 * 1024,
  },
});

const response = await readFrame();
if (
  response.version !== 5 ||
  response.type !== "exec.result" ||
  response.requestId !== "git-status"
) {
  throw new Error("Invalid execution-environment response");
}
if (!response.ok) throw new Error(response.error);

const localSystem = `${platform()} ${release()} ${arch()}`;
const workspaceStatus =
  response.result.output.trim() || "Working tree is clean.";
writeFrame({
  version: 5,
  type: "result",
  ok: true,
  content: [{ type: "text", text: `${localSystem}\n\n${workspaceStatus}` }],
  presentation: {
    subject: "local system",
  },
});

lines.close();
```

The `exec` frame asks Tau to run `git status --short` in the session execution environment, which may be a different machine from the JavaScript process. Tau returns the matching `exec.result` on stdin. Request IDs are single-use, and the command must check both the ID and `ok` before consuming the result.

Make the file executable with `chmod +x`. Diagnostics and uncaught errors go to stderr; stdout remains reserved for protocol frames.

### Implement a simple command tool in Bash

A small command that only needs the client machine can also implement the handshake in Bash. This example depends on `jq` for safe JSON parsing and encoding:

```bash
#!/usr/bin/env bash
set -euo pipefail

IFS= read -r prepare
jq -e '
  .version == 5 and
  .type == "prepare" and
  .toolName == "system_info"
' >/dev/null <<<"$prepare"

jq -cn '{
  version: 5,
  type: "ready",
  presentation: {
    subject: "local system"
  }
}'

IFS= read -r execute
jq -e '.version == 5 and .type == "execute"' >/dev/null <<<"$execute"

content=$(uname -a)
jq -cn --arg content "$content" '{
  version: 5,
  type: "result",
  ok: true,
  content: [{type: "text", text: $content}]
}'
```

Configure either executable as an argument-free command tool:

```json
{
  "name": "system_info",
  "defaultEnabled": true,
  "description": "Report operating-system information from the client machine.",
  "parameters": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "command": "./bin/tau-system-info"
}
```

`ready.presentation` and `result.presentation` are optional partial objects with `subject`, `subjectWrap`, `details`, and `metadata`. The `ready` value applies while the call runs, and the `result` value applies to the finished card. Omit either object, or any field in it, to use Tau's default. An empty `details` or `metadata` array hides that default. The script must write `ready` before it reads the `execute` frame. Direct implementations can send the same `exec` frames as the JavaScript example, but the TypeScript helper is the better choice when the tool makes several execution-environment requests, needs to forward cancellation, or handles the protocol in more complex ways.

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

`sessionId` identifies the session, `agentId` the agent that made the call (for scratch space and attribution), and `callId` this call. Never use one ID in place of another, and never reuse a context across calls.

`signal` aborts when the turn is interrupted, the host cancels or times out the tool, the client closes, the connection fails, or stdin closes. Pass it to all local work that can be cancelled and to execution-environment calls.

### Run commands in the execution environment

`context.executionEnvironment.exec()` runs a command in the session's execution environment, not on the client machine. Use it for the agent's files, repository commands, and workspace state:

```ts
const result = await context.executionEnvironment.exec("git status --short", {
  cwd: "/workspace/atlas",
  timeoutMs: 10000,
  maxCaptureBytes: 256 * 1024,
  signal: context.signal,
});

return { content: result.output || "Working tree is clean." };
```

The optional settings are `args`, `env`, binary `stdin`, `cwd`, `timeoutMs`, `maxCaptureBytes`, and `signal`. The result has combined and separate output, exit status, and whether output was truncated, timed out, or aborted, plus the closing signal. Commands run in the execution environment's login Bash, with its paths, environment, and permissions. `HOME` comes from that environment and cannot be overridden in the request.

Up to eight requests may be unresolved at once. Each request ID can be used only once. Cancelling one request does not affect the others, but cancelling the whole tool call aborts all of them.

## Implement code-mode client tools

Tau exports two helpers for client tools that let the model run JavaScript against an API you define:

- `createTauCodeModeClientTool` creates an in-process `TauSdkClientTool` for an SDK client.
- `runTauCodeModeCommand` runs a code-mode definition as a command client-tool executable.

Command tools need a parameters schema with a required `code` string, an optional `maxOutputTokens` integer (1–65,536), and no other properties. SDK clients pass the tool returned by the helper in `clientTools`.

Both helpers provide the call IDs, cancellation, the execution-environment API, `docs`, the bridge to your API, and output and truncation functions. The card subject is the submitted code, truncated and wrapped by character. You write the tool description; the shared description builder is optional.

`await printImage(block)` emits ordered text/image blocks in `content`; see [tools](tools.md) for limits. `maxOutputTokens` defaults to 8,192 estimated tokens. Saving output requires a `persistOutput` callback.

If the tool can start processes or reach the network, say so in its description.

## Limits and failure behavior

The command protocol has fixed limits:

- The command-to-client stdout NDJSON stream is limited to 512 frames and 192 MiB in total.
- Each frame on that stdout stream is limited to 80 MiB.
- Final result text is limited to 1 MiB; images use the bounds above.
- Captured stderr is limited to 1 MiB. Exceeding it terminates the command and fails the tool.
- Execution-environment stdin is limited to 16 MiB decoded, and capture can be requested up to 24 MiB per execution.
- At most eight execution requests may be unresolved concurrently.
- Each presentation override is limited to 1 MiB in total: the subject to 256 KiB, each metadata value to 16 KiB, each detail value to 256 KiB, and `details` and `metadata` to 1,024 entries each. These are safety limits, not recommended display sizes. Tau keeps values within them unchanged. Use the exported helper for a short preview.

`executionTimeoutMs` covers both preparation and execution, and defaults to 60 seconds. The host also expects the client to prepare and accept each call promptly. A command writes `ready` and any running presentation first, then waits for Tau's `execute`.

Tau starts each command in its own process group. Cancellation sends a termination signal to the group and follows with `SIGKILL` after a short grace period, even if the main process has already exited. When stdin closes, the helper aborts pending execution-environment requests and accepts no more work.

A successful exchange writes one `ready` frame, waits for `execute`, writes one `result` frame with `ok: true` or `ok: false`, and exits with status zero. `ok: false` reports a tool failure the command handled. Process and framing failures still use stderr and a nonzero exit. The call fails on: a missing or repeated `ready`, output before `execute`, a missing result, malformed frames, output after the result, a reused request ID, timeout, cancellation, too much output, or any other limit violation.

## Disconnects, reconnects, and durability

Client tool calls are not saved. Tau never replays them and never moves them to another client when the owning client goes away.

When the owning client detaches, Tau removes its tools from later turns and cancels its running calls. When the client closes or its connection fails for good, local handlers and the execution-environment commands they started are aborted. Closing waits for running handlers to finish, but no results are sent once the connection is gone.

After reconnecting, the client offers its current tools again, and they become available once it observes the session. If another client already offers one of those names, the attachment fails. A reconnect never resumes a command process from the earlier connection.

## Security and troubleshooting

Command client tools are trusted executables with the client process's full environment and operating-system permissions. Keep definitions in your global configuration, use narrow JSON Schemas, avoid shell interpolation, limit local work, honor cancellation, and return only data the model needs. A project's `enabledClientTools` can only select global definitions; it can never supply code to run.

The execution-environment API is just as powerful, on the session machine. Validate every argument from the model before building a command, prefer fixed command names and argument arrays, never concatenate untrusted text into shell code, and use the context signal and capture limits.

When a tool is missing, check:

1. The owning client is currently observing the session.
2. The global definition is valid, and the client's `cwd` is inside home.
3. The nearest `enabledClientTools` selection includes the exact name, or `defaultEnabled` applies.
4. `--no-client-tools` is not active for the TUI.
5. No other observer or host tool owns the same name.
6. The client was restarted or reconnected after configuration changes.

For failures, first tell apart errors from the local process and errors from `executionEnvironment.exec()` on the session machine. Check executable permissions, the client's `PATH`, stderr output, and timeout and framing limits. Then check the execution environment's `cwd`, login startup files, and whether the command exists there. See [tools](tools.md), [security](security.md), and [troubleshooting](troubleshooting.md).
