# Security

Tau gives an agent real tools that change files, run processes, and call configured services. A tool runs as soon as the model calls it. Tau adds no confirmation dialog, no restriction to the repository, and no general sandbox.

So before starting a session, decide which machine the agent may change, which credentials that machine may hold, and which project content you trust. The [ownership and scope](ownership-and-scope.md) page defines the client, host, execution environment, and Telegram runner used below.

## Direct execution and operating-system authority

Host tools such as `bash`, `write`, and `edit` act in the session's execution environment. They have that environment's operating-system permissions and are not limited to the repository. Absolute paths work wherever the operating system allows. Changes to files and processes remain even if the tool output is truncated, the turn is interrupted, or the model request fails.

Client tools have separate permissions. A command client tool runs as the client's user, with the client process's current directory and environment. It can also ask to run commands in the execution environment. In a remote session, one turn can therefore act with the permissions of two different machines.

Give each part only the access it needs:

- Run Tau and its execution environment as a dedicated, unprivileged user when the workspace does not need access to a personal home directory.
- Use a container, virtual machine, or separate hosted environment when work should be isolated from the host. Tau respects that isolation, but not every execution environment type is a security sandbox.
- Mount or copy only the repositories and files the task needs. Do not point an execution environment at a broad home directory for convenience.
- Give the host only the provider and service credentials needed for its sessions. Give client-tool processes only the client-local credentials they need.
- Use a persona with a shorter `tools` list for work that should not change files or call external services. The built-in `tau_docs` tool is always available regardless of that list.

Interruption, timeouts, output limits, and process-group termination limit how long and how much a command runs. They do not ask for approval and cannot undo anything already done. Review destructive commands, and use Tau's normal session operations instead of asking an agent to change Tau's internal files.

## Treat project content as executable policy

Tau loads more than source files from the execution environment. It reads project `.tau/config.json`, personas, prompts, skills, `.agents/skills`, and `AGENTS.md` from the working directory and its parents. This content can choose models and tools, add instructions, define workflows, and change which of your global client tools are offered.

Trusting a repository therefore means trusting this content. Before using a repository with valuable credentials or write access, read its `.tau/`, `.agents/`, and `AGENTS.md` content, including nested levels. Look especially at:

- persona system prompts, tool lists, and model launch allowlists;
- skill instructions and any scripts they direct the agent to run;
- project configuration that sets Nook targets, model notices, or hosted-environment connections;
- `enabledClientTools`, which can turn on commands from your global configuration; and
- provision scripts or other repository automation used by integrations such as Telegram.

Project configuration cannot define client tool commands. It can only select commands defined in global configuration. A repository therefore cannot add a new process to your machine, but a selected command can still do anything it was written to do.

`--no-agent-context-files` turns off `AGENTS.md` loading and the list of nested `AGENTS.md` files. Project configuration, personas, skills, and tools still load. `--no-client-tools` turns off TUI client tools, not host tools. Neither flag is a general safe mode.

Prompt templates are inserted into the editor for you to review; they are never sent automatically. Leading `<system>` blocks, persona prompts, model notices, and session messages are sent to the model and may be saved in the session. Never put secrets in instructions, prompts, or model notices.

## Trust remote model metadata as routing configuration

A Tau host that runs models refreshes compatible provider catalogs from `pi.dev` and caches them in `~/.config/tau/models-store.json`. Treat this like a software update channel. A remote model record can change the model's API adapter, endpoint, headers, compatibility settings, limits, and pricing. If that service were compromised or misconfigured, it could redirect provider requests, along with their credentials. Set `TAU_OFFLINE` to turn off automatic catalog requests.

## Keep secrets with the process that needs them

Most model and service credentials belong on the host, because the host makes model calls, web searches, history replication, and Nook requests for the session tool. TUI speech credentials and command client tool credentials belong on the client. Telegram bot, transcription, and voice credentials belong to the Telegram runner. Credentials for hosted execution environments belong in the host's startup configuration.

When attached to a remote host, a credential exported on the laptop does not reach the host. Putting a host credential into the execution environment's shell would needlessly expose it to every process there. See [credentials](credentials.md) for which source wins.

For personal secrets, prefer host environment variables or global configuration over project files. Some integrations accept a field that names an environment variable, which keeps the secret out of JSON. Telegram stores each bot token in the runner's configuration file, so protect that file like any other secret.

Never put credentials in:

- committed project files;
- persona, prompt, skill, `AGENTS.md`, or model-notice text;
- Bash command lines likely to enter shell history or process listings;
- tool results, session messages, issue comments, or debug output; or
- Nook static assets or browser KV.

Do not debug authentication by printing an environment, a configuration file, `auth.json`, or a service response that includes headers. Check that the expected source is set up for the right process, then run a small operation that uses it. `tau auth list` shows Codex account identities and status without showing tokens.

If a credential appears in a session, log, shell history, repository, Nook deployment, Telegram message, or history, treat it as exposed. First revoke or rotate it at the provider. Then replace the stored value through configuration or the auth command, restart the process that uses it if needed, and delete the exposed copy where retention rules allow. Redacting the copy does not replace rotation.

## Understand environment sanitization

Commands in a local execution environment start from a filtered copy of the Tau process environment. Tau removes inherited variables whose names end in `_KEY`, `_SECRET`, `_TOKEN`, or `_PASSWORD`, and the exact name `API_KEY`. This reduces accidental leaks from a local host into the agent's Bash commands.

The filter has clear limits:

- It is name-based, so a secret under another name is not recognized.
- Variables set explicitly for the execution environment are applied after filtering and can add a secret back.
- Hosted execution environments start from their own environment.
- Command client tools inherit the client process environment unchanged.
- Tau's own model and service code on the host uses the host credentials it needs.

The filter is neither a secret store nor an access control. Avoid printing whole environments, and keep secrets out of every process that does not need them.

## Keep login shells automation-safe

Tau runs each command in a fresh non-interactive login Bash. The execution environment's `HOME` decides which startup files are read. Bash can read `/etc/profile`, the first user login file it finds, and `BASH_ENV`, and a login file may also source `.bashrc`.

These files run with the same permissions as every tool command. A compromised or careless startup file can change `PATH`, run commands, leak data, exit the shell, or print unexpected output. Review the startup files in each execution environment, especially ones created from shared images or existing user homes.

Startup files must not print banners, prompt, read stdin, require a TTY, open an editor, or exit the shell. Tau does not suppress their output. There is no TTY and the agent's Bash calls have no stdin, so interactive logins and terminal prompts fail or hang until the timeout. Set up Git, SSH, package managers, and cloud CLIs to work without prompts.

## Trust command client tools as local programs

Command client tools are defined only in your global configuration, and projects can only select them. Tau starts the executable directly, without a shell, and validates the model's arguments against the configured schema. The command still runs as trusted local code, with the client's full environment and file permissions.

Before enabling one:

1. Review the executable and pin or control how it is updated.
2. Use a narrow schema and describe side effects accurately for the model.
3. Avoid building shell source from model-provided strings. Prefer fixed commands and argument arrays.
4. Honor cancellation and set a bounded execution timeout.
5. Return only the data the model needs, with diagnostics on stderr.
6. Run commands in the execution environment only for work that really belongs on the session machine.

A project's `enabledClientTools` can only select definitions you already trust globally. Unknown names are ignored without an error, so check which tools are actually offered after a change. Start an untrusted project with `--no-client-tools` until you have reviewed its selection.

The TUI's built-in diff review tool also runs as a process on the client machine.

## Use code mode as a capability boundary

JavaScript written by the model for `code` and code-mode client tools runs in a restricted sandbox. It receives only the declared capabilities, `docs`, `printText`, the async `printImage`, the `truncate` and `truncateLines` helpers, the real `Date`, and `Math.random()`. It has no imports, processes, environment variables, credentials, timers, fetch, files, or network access of its own. When Bash is selected, `tau.bash` runs commands with the same permissions as the Bash tool, and the sandbox does not limit what those commands do.

The API behind each capability runs outside the sandbox, with whatever access the tool gives it. The sandbox limits the model's code to the declared capabilities, but a capability that is too powerful is still dangerous. Tool authors should validate every argument, offer narrow operations, keep credentials outside the sandbox, honor cancellation, and never return secrets.

`tau.models` sends only the inputs given in each request to OpenRouter. File attachments are read from the session machine, and inline media is checked against its bytes. Provider credentials stay outside the sandbox. Reported model costs are recorded even if the program fails later.

The `history` API is read-only, but it can see transcripts from every repository and execution environment in the configured collection. The agent uses it only when the user or active instructions directly ask. That rule is no substitute for access control on the history service.

## Trust MCP servers

MCP servers come from the global and project configuration of the directory where the host was launched. Launching a host inside a repository lets that repository's configuration start commands on the host and use host credentials, with no approval step. MCP is available to every session on that host whose persona allows `mcp`, and to their subagents. It is not separated per repository or client. Configuration in a session's execution environment cannot add servers.

A stdio MCP server is trusted code on the host. It runs outside the code-mode sandbox with the host account's file and process permissions and its full environment, including credentials. Review the executable and arguments before configuring a server. HTTP servers receive the configured headers and the arguments sent to their tools. Use HTTPS for remote servers and give them only the access they need.

MCP has no confirmation step. Tools can change external systems or host resources immediately. Interrupting a call cannot undo what already happened, and when the outcome is unknown, retrying a change is not safe. Treat server descriptions, instructions, annotations, and results as untrusted data. Annotations such as `readOnlyHint` are not enforced.

How a stdio server shuts down depends on the MCP transport. Child processes that ignore `SIGTERM` can outlive the server, so do not rely on shutdown to stop untrusted server processes.

The execution environment does not contain an MCP server that runs on the host. A server that exposes host files or commands gives the agent access to the host, even when Bash runs in a remote sandbox. If that access is not acceptable, remove `mcp` from the persona or disable the server. Connections and credentials stay outside the model's JavaScript, but the server decides what its tools return.

## Protect remote session transports

`tau serve` listens on loopback by default. Keep it that way unless you need remote network access. Without `--auth-token` or `TAU_WS_AUTH_TOKEN`, the WebSocket server has no authentication, and any client that connects can observe and change hosted sessions.

The token gives full access to all sessions. Tau sends it in the WebSocket URL as the `tau_token` query parameter. Use a strong random value, avoid typing it on command lines that end up in shell history, and make sure reverse proxies and access logs do not record it.

Tau serves plain WebSocket and has no TLS settings. Across an untrusted network, use one of these setups:

- bind Tau to loopback and forward it through SSH;
- place it behind a trusted TLS reverse proxy and connect with `wss://`; or
- keep it on a private network whose access controls and confidentiality are understood.

A reverse proxy must pass through the WebSocket upgrade and the query string, and keep both protected. Limit who can reach the server even when a token is set. Every attached client has full control: it can submit, steer, interrupt, rewind, and offer client tools. See [remote sessions](remote-sessions.md).

## Secure Telegram access and workspaces

A Telegram runner is both a client exposed to the network and a local Tau host. Its bot configuration decides who can start turns that run tools in the configured workspaces.

Set `allowedUserIds` for allowed senders and `allowedChatIds` for allowed chats. Without `allowedUserIds`, any user can message the bot in a private chat, and without `allowedChatIds`, any private chat is allowed. Group chats are ignored unless their chat id is in `allowedChatIds`, and a group turn starts only when the bot is mentioned. Messages, attachments, audio transcripts, and errors from an allowed group can become context for a later turn, so group membership and history are part of what you trust.

Each bot's `allowedProjectIds` should list only the intended projects. Telegram sessions are separate per bot and chat, but a persistent-directory project uses the same directory for all of its sessions. Work in one session is visible to later sessions and to other allowed chats that select the same project. Never use a personal home, a credential directory, or an unrelated shared directory as a persistent project.

Repository and composite projects use managed workspaces and persistent bare repository caches. New or reconstructed repositories may run an executable `.tau/scripts/provision` in the background. Review that script like any other trusted project automation. Persistent-directory projects are never provisioned and never deleted by Tau.

Protect the runner configuration, session state, project-preference state, managed workspace root, and temporary attachment storage with a suitable OS account and file permissions. Never run two Telegram runners on the same state. Operational details are in [Telegram](telegram.md) and [Telegram projects and workspaces](telegram-projects.md).

## Know what history retains

Tau keeps a flat transcript history in the host user's home, separate from saved sessions. It contains user messages, intermediate system instructions, assistant text, and completed tool calls. The initial persona prompt is not included. Compaction does not remove entries. Rewind removes entries after the rewind point. Apart from that, entries stay; history is not a temporary cache.

Without remote history, it stays in a SQLite database on the host. The `tau.history` capability can search all of it, within the persona's tools and the agent's usage rules. Protect the host account and database as you would the transcripts themselves.

With global `history` configuration, entries are still written to local SQLite first, and a persistent outbox copies them to the configured service in the background. Remote entries are limited in size, with large content truncated in the middle, but they can still contain source code, tool output, instructions, and personal data. The service also summarizes transcript content with its configured Cloudflare AI service.

Before turning on remote history, confirm who runs the service, its retention policy and region, who holds access keys, and which projects may be sent. One service key can search the whole shared collection. Rotate it if exposed. Removing the configuration does not delete data that was already copied. See [history](history.md) for storage and service behavior.

## Treat Nook output as published content

Nook deploys static files to HTTPS URLs. Deployments are private by default, and `--public` makes a site's files reachable by anyone. Review the built output, not just the source, before deploying. Static files must never contain provider keys, source maps with secrets, private configuration, or data that should stay on the execution environment.

Each site has a JSON KV store for the browser that survives redeploys. On a public site, anyone can read and write it. On a private site, it requires a Cloudflare Access identity, but it is still application data that every allowed user and the site's code can read. It is not a place for credentials.

Cloudflare Access should protect only the `/__nook/*` control plane at the root. Public site paths must stay reachable without Access, while private sites sign in through `/__nook/auth`. The Nook Worker validates Access JWTs; service-token headers only get a request past Access. Follow the exact Access application, audience, cookie, and service token setup in [Nook](nook.md).

The Nook session tool and the `tau nook` CLI can deploy, delete, copy, and change KV without asking for confirmation. The model's JavaScript never receives Access credentials, but Tau uses them for the Nook API calls the program makes.

## Edit configuration without widening authority accidentally

A configuration change can redirect network traffic, expose tools, or send credentials somewhere new. Follow these steps:

1. Find out what reads the setting, and its machine, `cwd`, home, and Tau version.
2. Read the field's entry in [configuration](configuration.md) and the [configuration reference](config-reference.md).
3. Check nearer configuration levels that may replace or merge the field.
4. Back up only the file you are changing, with permissions no broader than the original.
5. Make the smallest edit at the narrowest level that works. Keep secrets out of project files.
6. Validate the JSON or frontmatter without printing the whole file into a shared transcript.
7. For a local startup, run `tau --debug` from the relevant directory, if its prompt output can stay private. For a running session, run `/reload` while idle and read every warning.
8. If the setting is read at startup, restart the client, host, or runner. Test one small operation before continuing.

Unknown fields are removed without a warning, so valid JSON can still have no effect. An invalid nearer value may be skipped, leaving a broader value in effect. Check the behavior instead of assuming your edit applied.

## Do not edit durable internals

Tau's internal files hold the state it needs to recover. They are not configuration. Do not edit or casually delete:

- `~/.config/tau/auth.json`;
- `~/.config/tau/models-store.json`;
- files under `~/.config/tau/sessions`;
- `~/.config/tau/history.sqlite` and its SQLite side files;
- Telegram runner session and project-preference state;
- managed Telegram workspaces or repository caches as a first-line repair;
- code-mode or compaction temporary files as if they were durable state; or
- Nook R2 or Durable Object records outside supported Nook operations.

Use `tau auth` for Codex accounts, TUI or session protocol operations for sessions, configuration for behavior, and the documented commands for history and Nook. If recovery reports corruption, keep the original data, stop any other process writing to it, write down the exact error and Tau version, and investigate through normal recovery before trying any repair that deletes data.
