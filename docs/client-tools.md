# Client tools

A client tool is a tool that an attached client offers to the session. The model sees an ordinary tool, but it runs in the client. In a remote session, that means your laptop, while the agent's files are on another machine.

Built-in client tools are the TUI's `diff_review` and `prefill_input`, and [Telegram's file delivery tools](telegram.md). You can add your own as commands, as described below, or as [SDK handlers](sdk.md).

Only the main agent can call client tools. They exist while their client observes the session, and running calls are cancelled when it detaches. Names must be unique across host tools and all observing clients, so start extra clients with `--no-client-tools`.

## Configure a command tool

Define commands in global configuration on the client machine, so a repository can never add one:

```json
{
  "clientTools": [
    {
      "name": "notify_desktop",
      "defaultEnabled": true,
      "description": "Show a desktop notification after completing requested work.",
      "parameters": {
        "type": "object",
        "properties": { "message": { "type": "string" } },
        "required": ["message"],
        "additionalProperties": false
      },
      "command": "./bin/tau-notify"
    }
  ]
}
```

```ts
type CommandClientTool = {
  name: string;
  defaultEnabled: boolean; // used when no project sets enabledClientTools
  description: string;
  parameters: JsonSchema; // root type must be "object"
  command: string; // on PATH, or relative to home if it contains "/"
  args?: string[];
  executionTimeoutMs?: number; // default 60000
};
```

The command runs directly without a shell, with the client's full environment. A project can select tools from this list with `enabledClientTools`, where the nearest list wins and `[]` selects none:

```json
{ "enabledClientTools": ["notify_desktop"] }
```

Restart the client after a change, because `/reload` does not affect client tools.

## Write a command tool

Use the helper, which handles the protocol and cancellation:

```ts
import { runTauClientToolCommand } from "@markusylisiurunen/tau/code-mode";

await runTauClientToolCommand({
  name: "workspace_status",
  async execute(args, context) {
    const result = await context.executionEnvironment.exec(
      "git status --short",
      {
        timeoutMs: 10000,
        signal: context.signal,
      },
    );
    return { content: result.output || "Working tree is clean." };
  },
});
```

The process runs on the client machine. `context.executionEnvironment.exec()` runs a command in the session's execution environment, so use it for anything that touches the agent's files. Pass `context.signal` to work that can be cancelled.

Return a string or `{ content, presentation? }`, or `{ ok: false, error }` for a handled failure. `content` can be an array of text and image blocks. An optional `describe(args)` function and the `presentation` field customize the tool card with `subject`, `details`, and `metadata`.

Keep stdout free for the protocol and write diagnostics to stderr.

## Without the helper

Any executable can implement the protocol. It exchanges one JSON object per line on stdin and stdout:

```text
tau → { version: 5, type: "prepare", sessionId, agentId, callId, toolName, arguments }
cmd → { version: 5, type: "ready" }
tau → { version: 5, type: "execute" }
cmd → { version: 5, type: "result", ok: true, content: [{ type: "text", text: "done" }] }
```

After `execute`, a command can send `exec` frames to run commands in the execution environment. For the full protocol, read the `@markusylisiurunen/tau/code-mode` types and source.

## Code-mode tools

`runTauCodeModeCommand` and the SDK's `createTauCodeModeClientTool` let the model run JavaScript against an API you define, in the [code mode](code-mode.md) sandbox. Programs have a 60-second deadline unless you set `timeoutMs`. For a command tool, make `executionTimeoutMs` longer than that deadline. See [the SDK page](sdk.md) for an example.
