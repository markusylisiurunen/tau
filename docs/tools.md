# Tools

The agent's tools come from three places:

- **Persona-selected tools** act on the execution environment or host services. The persona's `tools` list selects them.
- **`tau_docs`** is always present and reads this manual.
- **[Client tools](client-tools.md)** come from attached clients, such as the TUI's `diff_review` and `prefill_input`.

A tool runs with the permissions of the machine behind it, and nothing limits it to the repository. See [security](security.md).

## Tool names

| Name in `tools` | Gives the agent |
| --- | --- |
| `bash` | `bash`, its job tools, and `tau.bash` |
| `write`, `edit` | File tools |
| `view_image` | Shows an image to the model |
| `web` | `tau.web`: search, fetch, and discovery (search and fetch need an Exa key) |
| `history` | `tau.history`: read-only [transcript search](history.md) |
| `mcp` | `tau.mcp`: [MCP servers](mcp.md) |
| `models` | `tau.models`: standalone OpenRouter calls |
| `agents` | `tau.agents` and `wait_for_agents`: [subagents](subagents.md) |

Names starting with `tau.` are APIs inside the [`code` tool](code-mode.md), which Tau adds when at least one of them is available.

## Bash

Each call runs a fresh non-interactive login Bash, so `cd`, variables, and aliases do not carry over, but file changes do. Commands have no terminal and no stdin, so anything that prompts fails or hangs until the timeout. Git is set up to never prompt, and output color and pagers are off.

Foreground calls time out after 60 seconds unless the call sets `timeout`. Long output reaches the model as a preview of its beginning and end, and the full text may be saved to a temporary file. The agent can raise the limit with `maxOutputTokens`, up to 16,384 on its own and up to 65,536 when you ask.

In a local execution environment, commands do not inherit variables whose names end in `_KEY`, `_SECRET`, `_TOKEN`, or `_PASSWORD`, or the name `API_KEY`. This filter works on names only, so do not rely on it to protect secrets.

## Background jobs

With `background: true`, a command returns a job ID right away and keeps running:

```js
bash({ command: "npm run dev", background: true });
list_bash_jobs();
read_bash_job({ id });
wait_for_bash_jobs({ ids: [id], timeout: 60000 });
stop_bash_job({ id });
```

Jobs suit services and work the agent does not need to wait for. They have no time limit and survive turns, interruption, and clients detaching. A finished job never starts a turn by itself. Each job belongs to the agent that started it.

Jobs stop when the session closes or the host shuts down, and they are not recovered after a restart. A process that daemonizes itself or runs in tmux is not stopped. An unknown job ID does not prove that the command stopped.

Each agent can have 64 job records, and each job keeps the last 24 MiB of output.

## File and image tools

`write` creates or replaces a whole file. `edit` replaces one exact piece of text, which must match exactly once. Neither reads files, so the agent reads with Bash. Relative paths start from the working directory, and absolute paths work wherever the OS allows.

`view_image` accepts JPEG, PNG, and WebP files up to 50 MiB and shrinks large images. The agent uses it only when you ask.

## Command-line tools

`tau tool` provides standalone utilities that work in any shell. Agents run them through Bash. Their files and credentials must be on the machine running the command.

| Command | Purpose |
| --- | --- |
| `tau tool pdf-unpack` | [OCR a PDF](pdf-unpacking.md) with Mistral. |
| `tau tool image-generate` | [Generate or edit an image](image-generation.md) with Google or OpenAI. |
| `tau tool speech-generate` | [Generate narration or dialogue](speech-generation.md) with ElevenLabs. |
| `tau tool openrouter` | [Typed decisions and text or media analysis](openrouter.md). |

`tau tool <command> --help` lists a command's flags.

## Checking what a session has

`tau --debug --persona <id>` prints the tool schemas of a new local session. A turn keeps the tools it started with, so persona changes, reloads, and clients attaching apply from the next turn.
