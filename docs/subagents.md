# Subagents

Subagents are background workers that the host supervises. Each has its own task and conversation, and several can run at once. There are no named worker types.

An agent starts subagents only when you or active instructions ask for delegation, in ordinary language. Tau checks that a launch is valid, but the agent itself decides whether delegation was requested.

## Turning them on and off

The `agents` tool enables subagents, and built-in personas have it. A persona with a `tools` list that lacks `agents` cannot start or manage them, and there is no other switch. See [personas](personas.md).

## What a subagent gets

A native subagent works like a main agent of the same persona in its working directory, with the same prompt, skills, and project instructions. It sees none of the parent's conversation, so the launch prompt must contain what it needs.

It inherits its parent's model, settings, and tools, and it has `tau_docs`. It never gets client tools. With another `workingDirectory`, it uses the `AGENTS.md` files and skills of that directory.

## Levels and limits

```text
main
├── A (depth 1)
│   ├── B (depth 2)
│   └── C (depth 2)
└── D (depth 1)
```

The main agent and depth 1 native subagents can start subagents. An agent can manage only its own descendants, so here A manages B and C, and D manages none.

At most 16 subagents can work at once in a session. A launch beyond that fails right away. A parent waiting for its children counts as working.

## Choosing a model

By default, a subagent uses its parent's model and reasoning. An agent can choose another model only from an allowlist, which you set in `config.json`:

```json
{
  "subagents": {
    "launchModels": [
      "openai/gpt-6-luna:medium",
      "anthropic/claude-haiku-4-5:low"
    ]
  }
}
```

The nearest list replaces broader ones. Each entry is an exact `<provider>/<model>:<effort>` combination. Agents omit the model unless you or active instructions ask for one.

A subagent without an override uses its parent's compaction threshold. With an override, it uses the persona's `subagentAutoCompactThresholdTokens` entry for that model, or the model's default.

## Managing subagents

Agents use `tau.agents` inside [`code`](code-mode.md), and the `wait_for_agents` tool. They read the full reference with `await tau.docs("agents")`.

```js
const { id } = await tau.agents.spawn({
  title: "review authentication",
  prompt:
    "Review the session expiry checks in src/auth and report any problems.",
});
```

| Method | Purpose |
| --- | --- |
| `spawn({ title, prompt, model?, workingDirectory? })` | Start a subagent. |
| `list()`, `read({ id })` | See state and usage. |
| `sendInput({ id, message, mode })` | Add input, with `mode` set to `queue` or `steer`. |
| `interrupt({ id, wait?, scope? })` | Stop a turn and drop pending input. `scope: "subtree"` includes descendants. |
| `waitUntilIdle({ id })` | Wait inside a program. |
| `trace({ id, ... })`, `readText(...)`, `readContent(...)` | Read what the subagent said and did. |

`wait_for_agents` returns as soon as one requested subagent is idle, with its last response. A `completed` status means the turn ended normally, so the parent still has to read the answer to know whether the task succeeded.

When a subagent that the main agent started becomes idle, Tau notifies the main agent. An idle main agent then starts a turn on its own, even with no client attached. After you interrupt the main agent, or one of its turns fails, it waits for your next message instead.

In the TUI, Alt+Down selects a running subagent and Ctrl+G interrupts it. Interrupting the main session does not interrupt subagents.

## Lifetime

Subagents belong to the running session on the host. They keep running when clients detach. They end when the host unloads the session, and none survive a host restart, so important results should reach the main agent or a file before that. Rewind removes subagents started by the removed messages, and it is refused while a subagent is running.

Running subagents keep their setup after `/reload`. Native subagents are recorded in [history](history.md) as child sessions.

## Claude Code subagents

The `claude-code` provider runs a Claude Code worker on your Claude subscription. Agents manage these workers with the same methods.

1. Install Claude Code on the execution environment, with `claude` on its login-shell `PATH`.
2. Sign in there with a Claude subscription. A login on another machine does not reach it.
3. Add the combinations to allow:

```json
{
  "subagents": {
    "launchModels": [
      "claude-code/claude-opus-5-5:medium",
      "claude-code/claude-sonnet-5-5:medium",
      "claude-code/claude-haiku-5-5:low"
    ]
  }
}
```

Tau checks for a subscription login before sending a task and has no API fallback. Extra usage on your Claude account can still incur charges, so disable it there if you want to stay within the included allowance.

These workers differ from native subagents:

- They use Claude Code's own prompt, instructions, skills, compaction, and MCP configuration from the execution environment.
- Tau tools map to Claude Code tools: `bash` gives Bash, Read, Glob, and Grep, and `view_image` gives Read, Glob, and Grep. `write`, `edit`, and `web` map to Write, Edit, and WebSearch with WebFetch.
- They run with permission checks bypassed and the Claude Code sandbox disabled, so review the local Claude settings first.
- They cannot start subagents or use Tau's `code` capabilities, `tau_docs`, or MCP connections. Hooks and automatic memory are off.
- They are not recorded in history. A follow-up resumes the same Claude session while the parent session is alive.
