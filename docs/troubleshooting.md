# Troubleshooting

Tau failures usually become straightforward once the failing component is identified. The same path can mean a laptop path, a host path, or an execution-environment path, and the same configuration field can require a session reload, client restart, host restart, or new session.

Work from the observed symptom. Keep checks narrow, preserve durable state, and avoid dumping configuration, environments, snapshots, databases, or transcripts into diagnostics.

## Start with the installed command and owner

Use the help shipped with the executable that is actually failing:

```sh
tau --help
tau attach --help
tau auth --help
tau history --help
tau nook --help
tau telegram --help
```

Help reflects that installed binary. The `tau_docs` corpus reflects the installed host binary. An attached TUI, remote host, and deployed History or Nook service can run different versions, so do not assume host documentation describes an older client's flags or a separately deployed service's behavior.

For a local startup, `tau --debug` resolves configuration and content from the current directory, prints warnings and effective catalog information, then exits without opening the TUI:

```sh
cd /path/that-should-own-the-session
tau --debug
```

Add `--persona <exact-id>` when checking one persona. Debug output includes complete model-facing project context. Keep it private and never use it as a convenient configuration dump. It cannot inspect a running remote host, a hosted target, or an attached client's effective state.

Inside the TUI, `/help` shows current commands, loaded skills, and injected context-file paths. It is useful for current session visibility, while `/reload` is the operation that asks the host to recollect runtime content.

## A configuration change has no effect

Identify the consumer in [ownership and scope](ownership-and-scope.md). Session content and host tools come from the execution environment and host. Themes, speech, diff launchers, and TUI client tools come from the client. History and environment resolvers are host-owned. Telegram routing and workspaces come from its separate runner configuration.

Confirm that component's machine, `cwd`, home, and tool path. In an attached session these safe checks report the execution environment, not the laptop:

```text
!!pwd
!!printf '%s\n' "$HOME"
!!command -v git
```

A global Tau level is omitted when the relevant `cwd` is outside that component's home. Tau applies every recognized ancestor level using field-specific rules. Check warnings and [configuration](configuration.md) for these common causes:

- a nearer scalar, object, or `enabledClientTools` list replaced the broader value;
- a merging field kept keys from another level;
- a relative path resolved from the level that declared it;
- an invalid nearer value was skipped, leaving a broader value effective; or
- a misspelled unknown field was silently stripped.

Validate JSON without displaying it:

```sh
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' \
  /path/to/config.json
```

Use `tau --debug` from the intended directory for a new local startup. For a live session, run `/reload` while idle and read every warning.

| Change owner | Apply boundary |
| --- | --- |
| Current session runtime content | `/reload` while idle |
| Theme, diff, speech, or TUI client tools | Restart `tau` or `tau attach` |
| Host environment, History, resolver, listener, or binary | Restart the host |
| Default persona or environment identity | Create a new session if it must change |
| Telegram config, routing, speech, or workspaces | Restart the runner |

## `/reload` is unavailable, refused, or insufficient

`/reload` is a TUI command backed by the current session. It is unavailable in a plain shell and is refused while a turn or conflicting session operation is active. Wait for the turn to settle or interrupt it deliberately, then run the command again.

Reload updates runtime configuration, `models.json`, personas, prompts, skills, `AGENTS.md` context, and the host-tool registry for future turns. It does not:

- alter the execution environment's kind, identity, `cwd`, or home;
- rebuild an attached client's themes, diff launcher, speech configuration, or advertised tools;
- reread environment variables into an already-running process;
- rebuild host-wide History or hosted-environment resolvers;
- update executable code or built-in documentation; or
- reconfigure an already spawned subagent thread.

A logical turn captures its persona, model settings, tools, and policies when it starts. Reasoning changes and reloads do not change that active turn or its steering continuations. A queued message captures current state only when it later starts. If behavior appears stale, let one independently submitted turn begin after reload before concluding that the change failed.

Protocol and SDK clients can call `session.reload` directly, but the same idle and ownership rules apply.

## A persona, prompt, skill, model, or theme is missing

Session resources come from the execution environment; themes come from the TUI client. Check the exact discovery path and `/reload` warning.

### Persona

For a new local session, run `tau --debug --persona <exact-id>`. The Markdown filename must match `id`; `provider` and `model` are required; `extends` can name only a shipped built-in. Startup IDs are exact and case-sensitive. If built-ins are disabled, at least one custom persona must remain. See [personas](personas.md).

### Prompt

Run `/reload` after changing prompt metadata. Bodies load lazily, so an invocation can fail if the execution-environment file later becomes unreadable or invalid. `/prompt:<id>` only fills the editor; it does not submit. See [prompts and project context](prompts-and-project-context.md).

### Skill

Use `/help` to inspect loaded skills. A skill needs uppercase `SKILL.md`, valid frontmatter, a lowercase-dash name, and a matching directory name. `.agents/skills` wins over `.tau/skills` at one level; nearer levels win overall.

The active persona can still exclude a discovered skill, and its trigger determines when the agent opens it. `allowed-tools` is currently ignored. See [skills](skills.md).

### Model

Providers must be known and model IDs are exact and case-sensitive. Check warnings for malformed `models.json`, invalid metadata, or unknown provider/model references. `tau --debug --persona <id>` shows local resolution; a small request proves endpoint, account, and credential access. Reload overlays while idle. See [models](models.md).

### Theme

Check the client `cwd` and home, exact filename ID, colors, `disableBuiltinThemes`, and `defaultTheme`. `/reload` does not reload themes. Restart the TUI, then select `/theme:<id>`. A remote host's themes do not supply an attached client's theme.

## A tool or subagent is unavailable

Classify the missing capability before changing configuration.

For a persona-controlled host tool, inspect the active persona's exact `tools` list. An explicit list replaces defaults. Run `tau --debug --persona <id>` for a new local session or reload the current session while idle. Credentials can make a selected tool fail, but usually do not remove its schema. Nook is the exception: it also requires effective `nook` configuration.

For a subagent, check all four gates:

1. The active persona defines or enables that subagent name.
2. The main persona exposes `spawn_agent` and any other needed supervision tools.
3. A requested launch model exactly matches the subagent's allowlist.
4. Fewer than eight subagent runs are currently active.

An already spawned thread keeps its captured model, tools, and working directory after reload. Recovery does not restore subagent threads, so old agent IDs cannot receive follow-ups after a host restart. Use `list_agents` to inspect live records. See [subagents](subagents.md).

For `tau_docs` or main-session goal tools, absence indicates a host runtime or version problem, not a persona list. Confirm the host package and restart it.

## A command client tool is missing or fails

A configured command client tool exists only while its owning client observes the session. Check the client side in this order:

1. The definition is in eligible global configuration on the client machine.
2. The entry is valid and has a root object JSON Schema.
3. The nearest project `enabledClientTools` includes the exact case-sensitive name, or `defaultEnabled` applies because no project selection exists.
4. The TUI was not started with `--no-client-tools`.
5. No other observer or host tool already owns the same name.
6. The client was restarted or reconnected after the configuration change.

Unknown selection names are ignored. An empty `enabledClientTools` intentionally selects none. `/reload` does not re-advertise client tools.

For execution failures, decide which half failed. “Command client tool” launch, permission, `PATH`, timeout, stderr, framing, and nonzero-exit errors belong to the client machine. Errors from `executionEnvironment.exec` belong to the session target. The executable runs directly, not through a shell, and inherits the client process's current directory and environment unchanged.

A detached owning client makes its tools unavailable and cancels active calls. Reconnect does not resume the previous process. See [client tools](client-tools.md).

## A credential is reported missing or rejected

Find the process making the request:

| Operation                                   | Owner        |
| ------------------------------------------- | ------------ |
| Model, host `web`, `history`, or `nook`     | Host         |
| `/listen`, `/speak`, or TUI client tool     | Client       |
| Telegram bot or transcription               | Runner       |
| `tau nook`, `tau history`, or PDF unpack    | Invoking CLI |
| Cloudflare Sandbox or Fly Sprite resolution | Host startup |

A laptop variable does not update a remote host. Environment changes require an owner restart. Runtime `apiKeys` can reload, but only from an eligible execution-environment level and subject to feature precedence.

Never print the secret, environment, or whole configuration. Privately confirm the expected source, read the missing-credential message, and make one small request. See [credentials](credentials.md). If failure followed a project change, inspect its `apiKeys`, model endpoint/headers, and persona; a nearer key can replace ambient authentication.

## A Codex account cannot be selected

Run this on the session host, not an attached client:

```sh
tau auth list
```

The output shows stored account identities, enabled state, credential refresh health, usage windows, and current preference without showing tokens.

Use the supported commands for the condition shown:

```sh
tau auth login codex
tau auth enable codex --account developer@example.com
tau auth disable codex --account developer@example.com
tau auth logout codex --account developer@example.com
```

Re-login when credentials are expired or refresh failed. Enable an intentionally disabled account only after confirming that it should be usable. A forced `TAU_CODEX_ACCOUNT` must match an enabled stored account by email or ID and disables automatic failover. Changing that variable requires a host restart.

Account selection is stable within a session. After a quota error, a later request can choose another usable account unless selection is forced. Do not edit `~/.config/tau/auth.json`; the auth commands coordinate updates and preserve permissions.

## Bash prints unexpected text, prompts, or reports no TTY

Every Tau command uses a fresh non-interactive login Bash in the execution environment. Reproduce startup safely with `!!bash -lc 'printf ok'`. Check `/etc/profile`, the first user login file, `BASH_ENV`, and any `.bashrc` sourced from them. A file that prints, reads stdin, prompts, runs terminal setup, or exits affects every command.

Use automation-safe command flags. Configure credentials before invocation, set Git and SSH up for noninteractive access, and avoid editors or tools that require terminal control. Shell aliases, variables, `cd`, and functions do not persist between calls, so pass `workingDirectory` or use a complete command each time.

Local command sanitization removes inherited credential-shaped variable names. If a target command needs authentication, use the tool's own secure noninteractive credential mechanism rather than broad environment forwarding. Hosted targets use their own environment.

## WebSocket attachment is unauthorized or unsafe

Confirm that client and server use the same token source. `--auth-token` wins when supplied; otherwise `TAU_WS_AUTH_TOKEN` can supply either process. Check presence and process configuration without logging the value.

Tau sends the token as the `tau_token` WebSocket query parameter. A reverse proxy must preserve the query string and WebSocket upgrade. It should also redact query strings from logs. An authentication failure currently appears to clients as an unexpected WebSocket close, so correlate it with the server or proxy's redacted status logs.

Tau does not terminate TLS. Use `wss://` behind a trusted TLS reverse proxy, or keep the server on loopback and use an SSH tunnel. An unauthenticated listener is acceptable only within a boundary where every reachable client is trusted with full session access.

If attachment reports an unsupported protocol version or invalid peer message, upgrade the host and client to the same Tau release and restart both. Do not downgrade a host that may have written newer session documents.

## Remote attach uses the wrong directory or cannot create a session

For `tau attach --new`, `--cwd` must be an absolute path inside the selected execution environment. With the default local execution kind it is a host path, not a path on the attaching machine. Tau does not create the directory, clone a repository, or infer remote repository attributes.

For Cloudflare Sandbox or Fly Sprite creation, verify on the host that:

- the named bridge or API id exists in startup configuration;
- its credential is available to the host process;
- the named sandbox or Sprite already exists;
- the absolute target `cwd` exists there; and
- the configured execution home matches the intended target account.

Changing a resolver definition or credential requires a host restart. `/reload` cannot replace a session's environment identity or repair a missing target.

Without `--session` or `--new`, attach needs a TTY for its selector. In automation, pass one explicitly. Normal local startup `--persona` flags are not attach options; choose the host default for new sessions or switch the attached session with `/persona:<id>` while idle.

## A session is missing, interrupted, or will not recover

A selector shows only sessions this host can load and restore. Confirm its machine, OS user, home, Tau version, resolver configuration, and target still match the creator. Another user's `~/.config/tau/sessions` is a different store. Restore missing bridge/API definitions, credentials, local directory, sandbox, or Sprite. Never edit session JSON to substitute a target or `cwd`.

Recovery returns idle, aborts unfinished turns, cancels running maintenance, removes live subagents, and blocks an active goal. Review the last assistant and tools, then safely check `!!pwd` and `!!git status --short`. Resume a goal only after understanding the stop. Retry continues current history without rerunning completed tools automatically.

A WebSocket client disconnect does not interrupt the long-running host; server shutdown does. Closing a local TUI shuts down its owned host, so interrupted recovery is expected.

A newer storage version requires that Tau version or later. For invalid JSON, snapshot, or ID errors, preserve the file and exact error, stop competing hosts, and investigate normal recovery. Do not edit or delete it first. Newer Tau migrates supported older documents automatically.

## History is unavailable, empty, or not current

History is host-owned and independent of session snapshots. Its default database is in the host home, and a failure warns without stopping the session. Check the host user and home, permissions, free space, Node version, and unexpected competing processes. Restart the host after correction. Do not open, edit, replace, or delete SQLite files as an initial repair.

The active persona must select `history`, and its first call prints tool documentation. If the tool is missing, fix the persona and reload. Use it only when the user or another active instruction directly requests historical transcripts.

With remote History configured, queries use the remote collection while local SQLite remains the durable first write and outbox. Replication is asynchronous. An empty result can mean the wrong host/home, filters, endpoint, deployment credential, network path, or pending replication. Restart the host after changing the global target or environment, then run one narrow query.

Do not inspect outbox rows, databases, keys, or unrelated transcripts. Removing remote configuration does not erase replicated data. See [history](history.md).

## Nook is missing, unauthorized, or serving the wrong visibility

The model-facing tool needs both `nook` in the active persona and effective session configuration. Fix the execution-environment level, `/reload` while idle, and start a later turn. Subagents cannot receive Nook.

The CLI instead uses the invoking machine's configuration and credentials. A laptop command does not prove a remote host tool works. Start with installed `tau nook --help` and `tau nook list`; the latter uses effective configured credentials and reports URLs and visibility without printing credential values.

For `401` or Access failures, verify the domain, client id, secret source, service-auth policy, and the deployed Worker's Access team domain and audience. Access must protect only `https://<domain>/__nook/*`, with the Cookie Path Attribute disabled. Private-browser redirect loops usually indicate Access or cookie configuration.

Deploys are private unless `--public` is supplied. Public assets are anonymous and public browser KV is anonymously writable. If visibility is wrong, verify with `list` and redeploy reviewed content without `--public`. Rotate exposed credentials immediately. Use deliberate `delete` only when taking the site offline is intended. KV survives redeploy, so remove sensitive KV with supported commands.

Copy needs an existing empty destination. Static deploys require `index.html`, reject hidden files and symlinks, and reserve `/__nook`. Setup and destroy also require noninteractive Wrangler authentication. Compare the [Nook](nook.md) page and installed help with the deployed Worker version before upgrading or changing infrastructure.

## Telegram ignores messages or selects the wrong project

The Telegram runner uses the JSON file passed to `--config-file`, not a Tau project `config.json`. Relative workspace and project paths resolve from that file's directory. Restart the runner after editing it.

If a private message is ignored, check both `allowedChatIds` and `allowedUserIds`. An omitted list does not restrict private access by that dimension. If a group message is ignored, the group id must be in `allowedChatIds`, the triggering message must explicitly mention the bot, and the sender must pass `allowedUserIds` when that list is configured.

Messages in an allowed group that do not trigger the bot can be buffered as context for the next mentioned turn, including attachments, audio transcripts, and processing errors. Confirm that this sharing is intended before broadening a chat allowlist.

Each bot can restrict `allowedProjectIds`. `/use_<project>` changes the preference for future `/new` sessions but does not move the active session. Use `/status` to distinguish the active session's project from the saved preference.

Runner startup config errors name every invalid bot or project field. Use `tau telegram --help`, validate JSON syntax without printing the file, and fix all reported references, persona suffixes, project kinds, or allowlist IDs before restarting. Keep the file private because it contains bot tokens.

## Telegram workspace preparation or recovery fails

Repository projects need runner-side `gh`, Git, network access, and noninteractive credentials. Check `repo`, `ref`, workspace-root permissions and space, and `workingDirectory` after checkout. Tau maintains a bare cache and can reinitialize it when the repository changes. Do not delete caches or workspaces first; preserve logs and fix access or configuration.

Persistent-directory projects require the configured directory to exist and intentionally share it across sessions. Recovery rejects a stored `cwd` that differs from current configuration. Restore the mapping or create a new session in the new directory, rather than editing state.

Tau reconstructs missing managed workspaces. New and reconstructed repositories may run executable `.tau/scripts/provision` asynchronously after the session is available; preserved workspaces skip it. Failure notifies chats but leaves the session usable. Fix the script or dependencies, then run it manually only when its contract allows, or create a fresh session to provision again.

Recovery needs the same `workspaceRoot`, project definitions, host home, and Tau sessions. Inspect runner logs and `/status`. Do not edit runner state, project preferences, snapshots, or managed workspaces to force a match.

## Telegram audio or attachment processing fails

Telegram audio transcription uses the runner's `speechToText.provider`, which defaults to Mistral. Mistral needs `MISTRAL_API_KEY` or `apiKeys.mistral`; Gemini needs `GEMINI_API_KEY` or `apiKeys.google`; OpenAI needs `OPENAI_API_KEY` or `apiKeys.openai` and runner-side `ffmpeg`. Set the credential for the runner process and restart it after changing the environment or provider.

Distinguish download, materialization, format, and transcription errors. The reply or runner log states which stage failed. Confirm Telegram can deliver the file to the bot, the attachment type is supported, the runner can write its temporary directory, and the selected provider accepts the media type. Do not log media bytes or transcripts merely to prove they exist.

Successful audio turns echo `transcribed: …` before submission. In groups, non-triggering audio can be buffered for later mentioned context. If that is inappropriate for the chat, narrow `allowedChatIds` or avoid enabling the group.

Outgoing `/tts_on` voice responses always need `GEMINI_API_KEY` or `apiKeys.google`, even when incoming audio uses Mistral. They also require runner-side `ffmpeg` with Opus support. A generation or delivery failure sends `voice response failed. please try again.` while detailed diagnostics remain in runner logs. The original text response remains delivered.

## Telegram replies or notifications are delayed or missing

Each outbound chunk has a deadline and retries retryable failures twice. Telegram `retry_after` is honored, and per-chat ordering holds later notifications. Large replies are split, so only a later chunk may have failed.

Check runner logs for method, redacted status, retry class, attempt, chat, session, and message identity. Correct network, rate limit, token, or chat permissions on the runner. Before manual resend, check delivered chunks because ambiguous failures can duplicate them.

Failed/blocked turn and confirmed-unaccepted request notifications persist until delivery succeeds; runner restart rehydrates them. A delivery failure is not a Tau turn failure, and a provision failure is not a session failure. Use `/status` and logs to separate these states. Never repair delivery by editing runner state.
