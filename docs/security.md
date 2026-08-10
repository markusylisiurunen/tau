# Security

Tau gives an agent real tools for changing files, running processes, and calling configured services. Those tools execute when the model calls them. Tau does not insert a confirmation dialog, repository fence, or universal sandbox between a tool call and its owner.

Safe operation therefore starts with authority: decide which machine may be changed, which credentials it may hold, and which project content is trusted before starting a session. The [ownership and scope](ownership-and-scope.md) page defines the client, host, execution environment, and Telegram runner used below.

## Direct execution and operating-system authority

Host tools such as `bash`, `write`, and `edit` act through the session execution environment. They inherit the operating-system permissions of that environment and are not confined to the repository root. Absolute paths are accepted when the operating system permits them. File and process side effects persist even if tool output is later truncated, a turn is interrupted, or the model request fails.

Client tools are a separate authority. A command client tool runs as the owning client user, with that process's current directory and inherited environment. Its execution-environment facade can additionally request commands on the session target. A remote session can therefore expose two independent operating-system authorities to one logical turn.

Use the narrowest practical authority for each role:

- Run Tau and its execution environment as a dedicated, unprivileged user when the workspace does not need access to a personal home directory.
- Use a container, virtual machine, or separately provisioned hosted environment when work should be isolated from the host. Tau preserves that external boundary, but it does not claim that every configured backend is a security sandbox.
- Mount or copy only the repositories and files the task needs. Do not point an execution environment at a broad home directory for convenience.
- Give the host only the provider and service credentials needed for its sessions. Give client-tool processes only the client-local credentials they need.
- Use a persona with a narrower `tools` list for work that should not modify files or invoke external services. Remember that main-session goal tools and intrinsic `tau_docs` do not come from that list.

Interruption, timeouts, output limits, and process-group termination bound execution. They are not approval controls and cannot undo an operation that already completed. Review destructive commands and use Tau's normal session operations instead of asking an agent to manipulate internal state.

## Treat project content as executable policy

The execution environment supplies more than source files. Tau can load project `.tau/config.json`, `.tau/models.json`, personas, prompts, skills, `.agents/skills`, and `AGENTS.md` from the working directory and its discovery path. This content can change model endpoints and headers, select tools, add instructions, define workflows, or alter which globally trusted client tools are advertised.

A repository checkout is therefore part of Tau's trust boundary. Before using it with meaningful credentials or write access, inspect relevant `.tau/`, `.agents/`, and `AGENTS.md` content, including nearer nested levels. Pay particular attention to:

- persona system prompts, tool lists, subagent definitions, and model launch allowlists;
- skill instructions and any scripts they direct the agent to run;
- model overlays that replace endpoints, headers, capabilities, or token limits;
- project configuration that supplies API keys, Nook targets, model notices, or hosted-environment definitions;
- `enabledClientTools`, which can select commands previously trusted in the user's global configuration; and
- provision scripts or other repository automation used by integrations such as Telegram.

Project configuration cannot define a command client-tool executable. It can only select definitions from global configuration. That restriction prevents a checkout from directly introducing a new client process, but it does not make a selected command harmless.

`--no-agent-context-files` disables `AGENTS.md` and configured context injection. It does not disable project configuration, personas, skills, model overlays, or tools. `--no-client-tools` disables TUI-provided tools, not host tools. Use the appropriate control rather than treating either flag as a general safe mode.

Prompt templates are inserted into the editor for review rather than submitted automatically. Leading `<system>` blocks, persona prompts, model notices, and committed session messages are model-facing and may become durable session content. Do not place secrets in instructions, prompts, or model notices.

## Keep secrets with the process that needs them

Most model and service credentials belong to the host because the host performs model calls, web search, history replication, and host-tool Nook requests. TUI speech credentials and command client-tool credentials belong to the client. Telegram bot and transcription credentials belong to the Telegram runner. Hosted-environment bridge and API credentials belong to host startup.

In a remote attachment, a credential exported on the laptop does not authenticate the remote host. Conversely, putting a host credential into the execution target's shell environment unnecessarily exposes it to target processes. Follow [credentials](credentials.md) for exact resolution precedence.

Prefer host process environment variables or private global configuration over project files for personal secrets. Some integrations support a configuration field that names an environment variable, which keeps the secret value out of JSON. Telegram currently stores each bot token in its separate runner configuration file, so protect that file as secret material.

Never put credentials in:

- committed `.tau/config.json` or `.tau/models.json` files;
- persona, prompt, skill, `AGENTS.md`, or model-notice text;
- Bash command lines likely to enter shell history or process listings;
- tool results, session messages, issue comments, or debug output; or
- Nook static assets or browser KV.

Do not diagnose authentication by dumping an environment, configuration file, `auth.json`, or service response containing headers. Check whether the expected source is configured on the owning process, then exercise a small operation that uses it. `tau auth list` reports Codex account identity and health without displaying tokens.

If a credential appears in a session, log, shell history, repository, Nook deployment, Telegram message, or transcript history, treat it as exposed. Revoke or rotate it at the provider first, replace the stored value through the supported configuration or auth command, restart the owning process when needed, and remove the exposed copy from systems where retention policy permits. Redaction is not a substitute for rotation.

## Understand environment sanitization

Local execution-environment commands start from a sanitized copy of the Tau process environment. Tau removes inherited variables whose names end in `_KEY`, `_SECRET`, `_TOKEN`, or `_PASSWORD`, and the exact name `API_KEY`. This reduces accidental leakage from a local host into ordinary agent Bash commands.

The filter is deliberately limited:

- It is name-based, so a secret under another name is not recognized.
- Explicit execution-environment overrides are applied after sanitization and can reintroduce a value.
- Hosted execution backends start from the target environment supplied by that backend.
- Command client tools inherit the client process environment unchanged.
- Host-owned model and service code can access the host credentials it is designed to consume.

Do not rely on sanitization as a secret store or authorization boundary. Avoid broad environment inspection, and keep secrets out of any process that does not need them.

## Keep login shells automation-safe

Tau command execution uses a fresh non-interactive login Bash. The execution environment's `HOME` controls login startup discovery. Bash can read `/etc/profile`, the first available user login file, and `BASH_ENV`; a login file may also source `.bashrc`.

These files execute with the same operating-system authority as every tool command. A compromised or overly broad startup file can change `PATH`, run commands, disclose data, terminate the shell, or produce unexpected output. Review startup files in each execution environment, especially targets created from shared images or user homes.

Startup files must not print banners, prompt for input, read stdin, require a TTY, launch an editor, or exit the shell unexpectedly. Tau does not suppress their output. There is no TTY, and ordinary agent Bash calls have no stdin, so interactive authentication and terminal prompts fail or wait until timeout. Configure Git, SSH, package managers, and cloud CLIs for deliberate noninteractive use.

## Trust command client tools as local programs

Command client tools are defined only in user-owned global configuration, then selected for a project. Tau starts the configured executable directly, without a shell, and validates model arguments against its configured object schema. The command still runs as trusted local code with the client's full inherited environment and filesystem permissions.

Before enabling one:

1. Review the executable and pin or control how it is updated.
2. Use a narrow schema and describe side effects accurately for the model.
3. Avoid building shell source from model-provided strings. Prefer fixed commands and argument arrays.
4. Honor cancellation and set a bounded execution timeout.
5. Return only the data the model needs, with diagnostics on stderr.
6. Use the execution-environment facade only for work that truly belongs on the session target.

A project `enabledClientTools` list is permission to select an already trusted global definition. Unknown selected names are ignored, so verify effective advertisement after changes. Start an untrusted project with `--no-client-tools` until its selection has been reviewed.

The TUI's diff launcher is also a client-local process. A custom `diffTool.command` and its configured environment should be treated as trusted code.

## Use code mode as a capability boundary

The generated JavaScript used by `web`, `history`, `nook`, and code-mode client tools runs in Tau's bounded worker runtime. It receives only a declared API, `docs`, console output, live `Date`, `Math.random()`, and, when configured, agent-scoped UTF-8 scratch files. Generated code has no direct imports, process, environment, credentials, timers, `fetch`, or arbitrary network access.

API handlers run outside that worker and retain the authority deliberately exposed by the tool. The boundary therefore limits generated code to declared capabilities, but it does not make an overpowered API safe. Tool authors should validate every argument, expose narrow operations, keep credentials in the parent, enforce cancellation, and avoid returning secrets.

Scratch files live in a private execution-environment temporary directory derived from the agent id. They are shared across code-mode tools for that agent, are not persisted in the session snapshot, and are not a durable secret store. Their limits and temporary lifetime are described in [tools](tools.md).

The `history` code-mode API is read-only, but it can see transcripts across repositories and execution environments in the configured collection. Its agent policy requires a direct user or active-instruction request before use. That policy does not replace access control on the history service.

## Protect remote session transports

`tau serve` binds to loopback by default. Keep that default unless remote network access is required. A WebSocket server without `--auth-token` or `TAU_WS_AUTH_TOKEN` is unauthenticated, and any connected client can observe and mutate hosted sessions.

The server's token grants full session access. Tau places it in the WebSocket connection URL as the `tau_token` query parameter. Use a strong random value, avoid command-line literals that enter shell history, and ensure reverse proxies and access logs do not record it.

Tau's listener is plain WebSocket and has no certificate configuration. Across an untrusted network, use one of these patterns:

- bind Tau to loopback and forward it through SSH;
- place it behind a trusted TLS reverse proxy and connect with `wss://`; or
- keep it on a private network whose access controls and confidentiality are understood.

A reverse proxy must preserve WebSocket upgrade behavior and the request query string while protecting both. Restrict who can reach the listener even when a token is configured. Multiple observers are active participants, not read-only viewers: they can submit, steer, interrupt, rewind, and advertise client tools. See [remote sessions](remote-sessions.md).

## Secure Telegram access and workspaces

A Telegram runner is both a network-facing client and a local Tau host. Its bot configuration determines who can create turns that may execute tools in configured workspaces.

Set `allowedUserIds` for authorized senders and `allowedChatIds` for authorized chats. If these lists are absent, private chats are not restricted by that dimension. Group chats are ignored unless their chat id is explicitly present in `allowedChatIds`, and group turns require an explicit bot mention. Messages, attachments, audio transcripts, and processing errors from an allowed group can become pending context for a later triggering turn, so membership and chat history are part of the trust decision.

Each bot's `allowedProjectIds` should expose only intended projects. Telegram chat sessions are scoped by bot and chat, but a persistent-directory project deliberately reuses one existing directory across all of that project's sessions. Work in one session is visible to later sessions and to other authorized chats selecting the same project. Do not configure a personal home, credential directory, or unrelated shared tree as a persistent project.

Repository and composite projects use managed workspaces and persistent bare caches. New or reconstructed repositories may execute an executable `.tau/scripts/provision` asynchronously. Review that script as trusted project automation. Persistent-directory projects are not provisioned and are never deleted by Tau.

Protect the runner configuration, generated session state, project-preference state, managed workspace root, and attachment temporary storage with an appropriate OS account and filesystem permissions. Do not run two Telegram runners against the same state. Operational details are in [Telegram](telegram.md).

## Know what history retains

Tau writes a flat transcript history in the host home independently of recoverable session snapshots. It contains committed user entries, assistant text, and completed tool entries. Compaction does not remove it. Rewind truncates entries after the selected boundary, but history is not an ephemeral cache.

Without remote history configuration, this collection stays in the host's local SQLite database. The `history` tool can search the complete machine-local collection, subject to its persona and invocation policy. Protect the host account and database as transcript data.

When global `history` configuration is present, local SQLite remains the first durable write and a persistent outbox replicates operations to the configured service asynchronously. Remote entry projections are byte-bounded and large payloads are middle-truncated, but they can still contain source code, tool output, instructions, and personal data. The deployed service also generates semantic digests from transcript content through its configured Cloudflare AI service.

Before enabling remote replication, confirm the service owner, retention policy, region, access-key distribution, and acceptable project scope. One service credential can query the shared remote collection. Rotate it if exposed, and do not assume removing the client configuration deletes data already replicated. See [history](history.md) for storage and service behavior.

## Treat Nook output as published content

Nook deploys static files to path-based HTTPS URLs. Deployments are private by default; `--public` makes the site assets anonymously reachable. Review the built output, not just source files, before deployment. Static assets must never contain provider keys, source maps with secrets, private configuration, or data that should remain on the execution environment.

Each site has browser JSON KV that survives redeploys. Public-site KV is anonymously readable and writable. Private-site KV requires Cloudflare Access identity, but it is still application data available to authorized browser users and site code. It is not a credential vault.

Cloudflare Access should protect only the root `/__nook/*` control plane. Public site paths must remain reachable without Access, while private navigation authenticates through `/__nook/auth`. The Nook Worker validates Access JWTs; raw service-token headers only pass the outer Access policy. Follow the exact Access application, audience, cookie, and service-auth setup in [Nook](nook.md).

The host-owned Nook tool and `tau nook` CLI can deploy, delete, copy, and modify KV without a separate confirmation layer. Code-mode JavaScript never receives Access credentials directly, but the parent Nook client acts with them on approved API calls.

## Edit configuration without widening authority accidentally

Configuration changes can redirect network traffic, expose tools, or move credentials across trust boundaries. Use this sequence:

1. Identify the consuming component and its machine, `cwd`, home, and Tau version.
2. Read the exact version-matched field contract in [configuration](configuration.md) and [configuration reference](config-reference.md).
3. Inspect nearer configuration levels that may replace or merge the field.
4. Back up only the user-authored file being changed, with permissions no broader than the original.
5. Make the smallest edit at the narrowest valid scope. Keep secrets out of project files.
6. Validate JSON or frontmatter without printing the whole file into a shared transcript.
7. For a local startup, use `tau --debug` from the relevant directory when its potentially sensitive prompt output can remain private. For a live session, use `/reload` while idle and read every warning.
8. Restart the owning client, host, or runner when the field is startup-owned. Test one small operation before resuming broader work.

Unknown configuration fields are stripped, so syntactically valid JSON can still have no effect. Invalid nearer values may be skipped, leaving a broader value effective. Verify behavior rather than assuming the edited value won.

## Do not edit durable internals

Tau's durable files are implementation-owned recovery state, not configuration surfaces. Do not directly edit or casually delete:

- `~/.config/tau/auth.json`;
- files under `~/.config/tau/sessions`;
- `~/.config/tau/history.sqlite` and its SQLite side files;
- Telegram runner session and project-preference state;
- managed Telegram workspaces or repository caches as a first-line repair;
- code-mode or compaction temporary files as if they were durable state; or
- Nook R2 or Durable Object records outside supported Nook operations.

Use `tau auth` for Codex accounts, session protocol and TUI operations for sessions, normal configuration for behavior, and documented service commands for History and Nook. If recovery reports corruption, preserve the original data, stop competing writers, record the exact error and installed version, and investigate through normal recovery before considering any destructive repair.
