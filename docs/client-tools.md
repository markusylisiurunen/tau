# Client tools

Client tools are tools that an attached client adds to a session. A TUI can open a local review interface, a Telegram runner can send files to its chat, and an SDK client can provide an in-process handler. The model sees an ordinary tool, but the tool runs in the client that offered it.

In a remote session, the client, the host, and the execution environment may be three different machines. A client tool handler runs on the client machine. To read or change the agent's workspace, it must use the execution-environment API that Tau provides. It cannot assume the workspace is on its own filesystem.

## Which client advertises which tools

Tau's TUI advertises two built-in client tools, both with local `tau` and with `tau attach`:

- `diff_review` runs diff review on the TUI machine, reading repository data from the session's execution environment.
- `prefill_input` puts a draft in an empty TUI editor for the user to edit and submit. It never submits the draft and does not replace existing editor text.

A Telegram runner offers the built-in `send_photo_to_telegram`, `send_video_to_telegram`, `send_audio_to_telegram`, and `send_document_to_telegram` tools. These [file delivery tools](tools.md#sending-files-to-telegram) send files to the session's chat. The runner does not offer the TUI's tools.

Node SDK clients can pass `TauSdkClientTool` handlers when they initialize. Their schemas may set `executionTimeoutMs` to `null` for no execution deadline, or omit it for the 60-second default. See [Node SDK](node-sdk.md#provide-client-tools) for the handler API.

Only a client that is observing a session can add tools to it. The tools disappear when that client detaches or disconnects. When several clients observe one session, only one may offer a given tool name, and Tau rejects the later client if names collide. Client tool names also must not match host tools or built-in tools.

Only the session's main agent can call client tools. [Subagents](subagents.md#tools) never get them.

## Disable TUI client tools

Start a local or attached TUI with:

```bash
tau --no-client-tools
```

For attach mode, place the flag with the attach options:

```bash
tau attach --no-client-tools ws://host.example:8787
```

This disables the TUI's built-in `diff_review` and `prefill_input`. Host tools and the built-in `tau_docs` tool are not affected.

A client offers its tools when it starts and connects. `/reload` does not change the tools a TUI offers. Restart or reconnect the TUI after changing `--no-client-tools`.

Diff review uses Tau’s built-in browser tool on the TUI machine. See [TUI](tui.md).

## Run commands in the execution environment

An SDK handler's `context.executionEnvironment.exec()` runs a command in the session's execution environment, not on the client machine. Use it for the agent's files, repository commands, and workspace state:

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

The handler context also has `sessionId`, the calling `agentId`, and `callId`. `sessionId` identifies the session, `agentId` the agent that made the call (for scratch space and attribution), and `callId` this call. Never use one ID in place of another, and never reuse a context across calls.

`context.signal` aborts when the turn is interrupted, the host cancels or times out the tool, the client closes, or the connection fails. Pass it to all local work that can be cancelled and to execution-environment calls.

## Implement code-mode client tools

`createTauCodeModeClientTool` creates an in-process `TauSdkClientTool` that lets the model run JavaScript against an API you define. Pass the returned tool in `clientTools`. `executeTauCodeMode` runs a program outside a session. The SDK and the `@markusylisiurunen/tau/code-mode` entry point both export it.

The helper provides the call IDs, cancellation, the execution-environment API, `docs`, the bridge to your API, and output and truncation functions. The card subject is the submitted code, truncated and wrapped by character. You write the tool description; the shared description builder is optional.

`await printImage(block)` emits ordered text/image blocks in `content`; see [tools](tools.md) for limits. `maxOutputTokens` defaults to 8,192 estimated tokens. Saving output requires a `persistOutput` callback.

The definition's optional `timeoutMs` sets a deadline for each program, including time spent waiting for API calls. The default is 60,000 ms. The SDK helper appends this deadline to the tool description and uses `timeoutMs` as the tool's `executionTimeoutMs`.

If the tool can start processes or reach the network, say so in its description. See [Node SDK](node-sdk.md#build-a-code-mode-tool) for an example.

## Limits

- Execution-environment stdin is limited to 16 MiB decoded, and capture can be requested up to 24 MiB per execution.
- Each presentation override is limited to 1 MiB in total: the subject to 256 KiB, each metadata value to 16 KiB, each detail value to 256 KiB, and `details` and `metadata` to 1,024 entries each. These are safety limits, not recommended display sizes. Tau keeps values within them unchanged. Use `truncateTauClientToolText` for a short preview.

## Disconnects, reconnects, and durability

Completed client tool results are saved in the session. In-flight delivery state is not saved. Tau never replays calls and never moves them to another client when the owning client goes away.

When the owning client detaches, Tau removes its tools from later turns and cancels its running calls. When the client closes or its connection fails for good, local handlers and the execution-environment commands they started are aborted. Closing waits for running handlers to finish, but no results are sent once the connection is gone.

After reconnecting, the client offers its current tools again, and they become available once it observes the session. If another client already offers one of those names, the attachment fails.

## Security and troubleshooting

An SDK client tool runs with your client process's permissions. Use narrow JSON Schemas, limit local work, honor cancellation, and return only data the model needs.

The execution-environment API is just as powerful, on the session machine. Validate every argument from the model before building a command, prefer fixed command names and argument arrays, never concatenate untrusted text into shell code, and use the context signal and capture limits.

When a tool is missing, check:

1. The owning client is currently observing the session.
2. `--no-client-tools` is not active for the TUI.
3. No other observer or host tool owns the same name.
4. The client was restarted or reconnected after changes to its tools.

For failures, first tell apart errors from your handler and errors from `executionEnvironment.exec()` on the session machine. Then check the execution environment's `cwd`, login startup files, and whether the command exists there. See [tools](tools.md), [security](security.md), and [troubleshooting](troubleshooting.md).
