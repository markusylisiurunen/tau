# Troubleshooting

Most Tau problems become clear once you know which part is failing. The same path can be a laptop path, a host path, or an execution environment path, and a configuration change may need a session reload, a client restart, a host restart, or a new session.

Start from the symptom. Keep checks narrow, keep saved state intact, and never paste configuration, environments, saved sessions, databases, or transcripts into diagnostics.

## Start with the installed command and owner

Use the help of the executable that is actually failing:

```sh
tau --help
tau attach --help
tau auth --help
tau history --help
tau nook --help
tau telegram --help
```

Help describes that installed binary, and `tau_docs` describes the host's installed version. An attached TUI, a remote host, and deployed history or Nook services can each run a different version, so the host's documentation may not match an older client's flags or a separately deployed service.

For a local startup, `tau --debug` loads configuration and content from the current directory, prints warnings and catalog information, and exits without opening the TUI:

```sh
cd /path/that-should-own-the-session
tau --debug
```

Add `--persona <exact-id>` to check one persona. The output includes the complete project context sent to the model, so keep it private and do not use it to dump configuration. It cannot inspect a running remote host, a hosted environment, or an attached client.

Inside the TUI, `/help` shows the commands, loaded skills, and context file paths of the current session. `/reload` asks the host to load session content again.

## A configuration change has no effect

Find what reads the setting, using [ownership and scope](ownership-and-scope.md). Session content and host tools come from the execution environment and the host. Themes, speech, the diff tool, and TUI client tools come from the client. History and hosted environment connections belong to the host. Telegram routing and workspaces come from the runner's own configuration.

Confirm that part's machine, `cwd`, home, and tool paths. In an attached session, these checks report the execution environment, not the laptop:

```text
!!pwd
!!printf '%s\n' "$HOME"
!!command -v git
```

The global level is skipped when the relevant `cwd` is outside home. Every project level on the path applies, with rules that depend on the field. Read the warnings and [configuration](configuration.md) for these common causes:

- a nearer value, object, or `enabledClientTools` list replaced the broader one;
- a merging field kept keys from another level;
- a relative path resolved from the level that declared it;
- an invalid nearer value was skipped, so a broader value still applies; or
- a misspelled field was removed without a warning.

Validate JSON without printing it:

```sh
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' \
  /path/to/config.json
```

Run `tau --debug` from the intended directory for a new local startup. For a running session, run `/reload` while idle and read every warning.

| Change | How to apply |
| --- | --- |
| Session configuration and content | `/reload` while idle |
| Theme, diff, speech, or TUI client tools | Restart `tau` or `tau attach` |
| Host environment, `apiKeys`, history, hosted environments, listener, or Tau version | Restart the host |
| Default persona or execution environment | Create a new session if it must change |
| Telegram config, routing, speech, or workspaces | Restart the runner |

## `/reload` is unavailable, refused, or not enough

`/reload` is a TUI command for the current session. It is refused while a turn or another conflicting operation is running. Wait for the turn to finish, or interrupt it, and run the command again.

Reload updates configuration, personas, prompts, skills, `AGENTS.md` context, and host tools for later turns. It does not:

- change the execution environment, its `cwd`, or its home;
- reload an attached client's themes, diff tool, speech settings, or tools;
- read environment variables again in a running process;
- reload the host's history service or hosted environment settings;
- update Tau's code or built-in documentation; or
- change subagents that are already running.

A turn keeps the persona, model settings, tools, and policies it started with. Reasoning changes and reloads do not affect the running turn or its steering. A queued message uses the settings current when it starts. If behavior seems unchanged, let a new turn start after the reload before deciding the change failed.

Protocol and SDK clients can call `session.reload` directly, with the same rules.

## A persona, prompt, skill, model, or theme is missing

Session content comes from the execution environment, and themes come from the TUI. Check the exact discovery path and the `/reload` warnings.

### Persona

For a new local session, run `tau --debug --persona <exact-id>`. The filename must match `id`, and `provider`, `model`, and a non-empty prompt body are required. Startup IDs are exact and case-sensitive. See [personas](personas.md).

### Prompt

Run `/reload` after adding, removing, or renaming a prompt or changing its label. The body is read each time the prompt is used, so using it fails if the file has since become unreadable or invalid. `/prompt:<id>` only fills the editor. See [prompts and project context](prompts-and-project-context.md).

### Skill

Use `/help` to see loaded skills. A skill needs `SKILL.md` in uppercase, valid frontmatter, a lowercase name with dashes, and a matching directory name. At one level, `.tau/skills` wins over `.agents/skills`, and nearer levels win overall.

Every persona can use all discovered skills. The trigger decides when the agent opens one. `allowed-tools` is ignored. See [skills](skills.md).

### Model

Providers must be known, and model IDs are exact and case-sensitive. Check warnings for unknown providers or models. `tau --debug --persona <id>` shows how a local startup resolves the model, and a small request confirms the endpoint, account, and credentials. Refresh the catalog and reload while idle. See [models](models.md).

### Theme

Check the exact built-in theme ID and the client's `defaultTheme`. Use `/theme:<id>` for the current run, or restart the TUI to apply a new default. A remote host's theme does not affect attached clients.

## A tool or subagent is unavailable

Work out which kind of tool is missing before changing configuration.

For a host tool, check the active persona's `tools` list. A list replaces the defaults. Run `tau --debug --persona <id>` for a new local session, or reload the current session while idle. Missing credentials make a tool fail but usually do not remove it. Nook is the exception: it also needs `nook` configuration.

For subagents, check three things:

1. The main persona has `spawn_agent` and any other subagent tools needed.
2. A requested model exactly matches an entry in the launch allowlist.
3. Fewer than eight subagents are running.

A running subagent keeps its model, tools, and working directory after a reload. Recovery does not restore subagents, so old IDs cannot receive follow-ups after a host restart. Use `list_agents` to see live subagents. See [subagents](subagents.md).

If `tau_docs` is missing, the problem is the host's installation or version, not a persona. Check the host package and restart it.

## A command client tool is missing or fails

A command client tool exists only while its client observes the session. On the client side, check:

1. The definition is in global configuration on the client machine, and the client's `cwd` is inside home.
2. The entry is valid and its schema has an object root.
3. The nearest project `enabledClientTools` includes the exact, case-sensitive name, or no project sets the field and `defaultEnabled` applies.
4. The TUI was not started with `--no-client-tools`.
5. No other client and no host tool uses the same name.
6. The client was restarted or reconnected after the configuration change.

Unknown names in the selection are ignored, and an empty `enabledClientTools` selects none. `/reload` does not refresh client tools.

For failures, find which side failed. Launch, permission, `PATH`, timeout, stderr, framing, and nonzero-exit errors come from the client machine. Errors from `executionEnvironment.exec` come from the session machine. The executable runs directly, without a shell, with the client process's directory and environment.

When the client detaches, its tools disappear and running calls are cancelled. Reconnecting does not resume the earlier process. See [client tools](client-tools.md).

## A credential is reported missing or rejected

Find the process that makes the request:

| Operation | Where the credential belongs |
| --- | --- |
| Model calls, host `web`, `history`, or `nook` | Host |
| `/listen`, `/speak`, or TUI client tools | Client |
| Telegram bot or transcription | Runner |
| `tau nook`, `tau history`, or `tau tool` commands | The machine running the command |
| Fly Sprite connection | Host startup configuration |

A variable set on the laptop does not reach a remote host. After changing environment variables or `apiKeys`, restart the process that uses them. `apiKeys` in a project file are rejected; check the process's environment and its global configuration.

Never print the secret, the environment, or the whole configuration. Check the expected source privately, read the error message, and make one small request. See [credentials](credentials.md).

## A Codex account cannot be selected

Run this on the session host, not on an attached client:

```sh
tau auth list
```

It shows stored accounts, which one is active, refresh status, and usage windows, without showing tokens. Fix the problem with these commands:

```sh
tau auth login codex
tau auth use codex --account developer@example.com
tau auth logout codex --account developer@example.com
```

Log in again when credentials have expired or refresh failed. Choose an account with `auth use`. Logging out the active account leaves none active, and Tau never switches accounts because of usage or failures. A new selection applies to later requests in every session, not to requests already in progress.

Do not edit `~/.config/tau/auth.json`; the auth commands handle updates and permissions.

## Bash prints unexpected text, prompts, or reports no TTY

Every command runs in a fresh non-interactive login Bash in the execution environment. Test startup with `!!bash -lc 'printf ok'`. Check `/etc/profile`, the first user login file, `BASH_ENV`, and any `.bashrc` they source. A file that prints, reads stdin, prompts, sets up the terminal, or exits affects every command.

Use flags that avoid prompts. Set up credentials beforehand, configure Git and SSH to work without prompts, and avoid editors and tools that need a terminal. Aliases, variables, `cd`, and functions do not carry over between calls, so pass `workingDirectory` or write a complete command each time.

In local environments, Tau removes inherited variables with credential-like names. If a command needs authentication, use that tool's own non-interactive credential setup instead of passing the whole environment through. Hosted environments use their own environment.

## WebSocket attachment is unauthorized or unsafe

Confirm that client and server use the same token. `--auth-token` wins when given; otherwise `TAU_WS_AUTH_TOKEN` can supply it on either side. Check that it is set without logging its value.

Tau sends the token as the `tau_token` query parameter. A reverse proxy must pass through the query string and the WebSocket upgrade, and should remove query strings from its logs. A rejected token shows up in the client as an unexpected WebSocket close, so compare with the server's or proxy's logs.

Tau does not handle TLS. Use `wss://` behind a trusted TLS reverse proxy, or keep the server on loopback and use an SSH tunnel. Run without a token only where every client that can connect is trusted with full session access.

If attachment reports an unsupported protocol version or an invalid message, upgrade host and client to the same Tau release and restart both. Do not downgrade a host that may have saved sessions in a newer format.

## Remote attach uses the wrong directory or cannot create a session

For `tau attach --new`, `--cwd` must be an absolute path inside the chosen execution environment. With the default local kind, it is a path on the host, not on the attaching machine. Tau does not create the directory, clone a repository, or detect repository attributes.

For a Fly Sprite session, check on the host that:

- `flySprites` is set in the host's startup configuration;
- its token is available to the host process;
- the named Sprite exists;
- the absolute `cwd` exists in the Sprite; and
- the configured `home` matches the account you intend to use.

Changing the Sprite connection or its token requires a host restart. `/reload` cannot change a session's environment or fix a missing target.

Without `--session` or `--new`, attach needs a TTY for its selector, so pass one of them in scripts. Local `--persona` flags are not attach options. Set the host's default for new sessions, or switch with `/persona:<id>` while idle.

## A session is missing, interrupted, or will not recover

The selector shows only sessions the host can load and reconnect. Confirm that the machine, OS user, home, Tau version, hosted environment settings, and target match the ones that created the session. Another user's `~/.config/tau/sessions` is a separate store. Restore missing settings, credentials, directories, or Sprites. Never edit session files to change the target or `cwd`.

A recovered session is idle. Unfinished turns are recorded as aborted, running maintenance is cancelled, and subagents are gone. Look at the last assistant message and tool results, then check `!!pwd` and `!!git status --short`. Retry continues from the current history without running completed tools again.

A WebSocket client disconnecting does not interrupt a long-running host, but a server shutdown does. Closing a local TUI shuts down its host, so recovering an interrupted turn is expected there.

A session saved in a newer storage format needs that Tau version or later. Newer Tau versions upgrade supported older sessions automatically. For invalid JSON, snapshot, or ID errors, keep the file and the exact error, stop other hosts using the same store, and investigate through normal recovery. Do not edit or delete the file first.

## History, Nook, or Telegram

These features have their own troubleshooting sections:

- [History](history.md#troubleshooting): missing API key, service errors, sessions missing from remote search, and local history failures.
- [Nook](nook.md#common-errors): configuration, Access and authorization errors, wrong visibility, and deploy rejections.
- [Telegram](telegram.md#troubleshooting): ignored messages, project selection, audio, voice replies, and late or missing replies.
- [Telegram projects and workspaces](telegram-projects.md#troubleshooting): repository preparation, provisioning, and workspace recovery.
