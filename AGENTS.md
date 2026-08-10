# Contributing to Tau as an agent

Tau is a terminal AI client with shared local and remote session machinery, streaming model and tool execution, durable recovery, and client-owned interfaces. This file is the repository contribution guide for agents. It records cross-cutting design constraints and safe workflow, not the complete product manual.

Use the repository's information sources for their intended roles:

- `README.md` is the public landing page and first-run entry.
- `docs/` is the canonical, version-matched public product documentation for people and agents.
- `AGENTS.md` contains contribution instructions and implementation context.
- Source and tests are the authoritative current behavior.

## Read before editing

- Tau supports macOS and Linux. Windows is unsupported. Do not add Windows support or a Windows-specific fallback path. See `src/core/platform_support.ts` and `test/platform_support.test.js`.
- Read the applicable `AGENTS.md` before changing code. The root guide applies repository-wide. `src/diff_tool/AGENTS.md` and `src/nook/AGENTS.md` add mandatory subtree-specific rules.
- Treat the worktree as shared and potentially dirty. Existing changes are intentional unless the user says otherwise. Never revert, overwrite, reformat, or "fix" unrelated work.
- Before editing a changed file, read its current contents and work with those changes. If a target file changes unexpectedly between your read and write, stop and ask how to proceed.
- Make the requested change, not a surrounding cleanup. Match the local naming, structure, error handling, and test style. Do not add speculative configuration, abstractions, or compatibility.
- Confirm before destructive operations such as deleting files, dropping data, rewriting history, or force-pushing. Prefer supported Tau operations over direct edits to durable state.

## Canonical pre-v1 design

Tau is pre-v1. Optimize for one clean, explicit v1 contract rather than compatibility scaffolding, even when the canonical change is breaking.

- Make a new field, option, or attribute required when every caller can provide it. Use optionality only when absence is a real domain state.
- Do not add fallback branches, aliases, dual readers, legacy unions, migration paths, or compatibility shims unless the user explicitly requests them.
- Change a contract at its owner and update every caller to the new shape.
- Keep types narrow enough that invalid states are unrepresentable.
- Fail at the owning boundary when required data cannot be produced. Do not silently omit it.
- When absence is intentional, define and test both the absent behavior and the consumer response.

### Durable session exception

Filesystem-backed `tau-session` documents under `~/.config/tau/sessions` are shipped user data. Newer Tau versions must keep supported older sessions openable. This exception overrides the normal preference against compatibility work, but it guarantees access to recoverable semantic data, not byte-for-byte identity or exact historical presentation.

- Put compatibility at the owning storage or recovery boundary. Use a sequential stored-document migration, independently versioned payload, recovery normalization, canonical regeneration, or an explicit degraded/read-only mode when safe continuation is impossible.
- Keep the current runtime, protocol, host, and TUI contracts canonical. Do not spread legacy unions or old-shape branches beyond the compatibility boundary.
- Preserve important semantic conversation and session data. Derived, cached, or presentation-only state may be normalized, regenerated, omitted, or rendered generically when exact recovery is impractical.
- Test representative older documents through normal store loading, host recovery, and the current affected consumer. Openability and semantic access matter more than identical rendering.
- It is valid to reject corrupted documents and documents written by a genuinely newer unsupported storage version. Recovery can also fail independently when the recorded execution environment can no longer be restored.

The owners are `src/store/session_snapshot_migrations.ts`, `src/store/file_session_store.ts`, and `src/host/local_session_host.ts`. The primary regressions live in `test/file_session_store.test.js` and `test/local_session_host.test.js`.

## Architecture and ownership boundaries

A common path is client input to the SDK session facade, through a session protocol transport, into the host, then `ChatRuntime` and the shared `AgentRuntime`. Runtime events return through the host's serialized snapshot projection and protocol deltas to every observer. `SessionChatApp` and `SessionChatController` are the canonical TUI path for both local and remote sessions. WebSocket attach, SDK, and Telegram use the same host/runtime architecture with different owners and transports.

For public mode behavior, read `docs/ownership-and-scope.md`, `docs/remote-sessions.md`, and `docs/node-sdk.md`. Keep the following implementation rules inline while changing code.

### Client, host, and execution environment

Treat the client, host, and execution environment as separate logical machines even when they share one process and filesystem.

- The client owns the TUI, editor and drafts, terminal appearance and theme, local speech, the diff tool process, and configured command client tools.
- The host owns session orchestration, persistence and recovery, model calls, credentials, history, tool binding, and execution-environment lifecycle.
- The execution environment is the agent's machine. It owns every agent-visible path, `cwd`, home, repository, project configuration and content, `AGENTS.md`, skills, model overlays, platform, Node version, `PATH`, filesystem operation, and command.
- The Telegram runner owns Telegram polling, routing, attachments, prepared workspaces, outbound messages, and runner-specific persisted state. It is a client of local in-process sessions.

Outside narrow pre-creation metadata obtained by a client from an environment it directly manages, client and host filesystem APIs must not inspect execution-environment paths. Session creation attributes are complete, authoritative client input. The host and stores do not infer or normalize them. All agent-visible access must cross `ExecutionEnvironment` and `ToolExecutionBackend`, even for a local session. Physical co-location must not create a second runtime path.

The boundary contracts are in `src/execution/execution_environment.ts` and `src/core/tools/execution_backend.ts`. Host integration is in `src/host/`, and ownership behavior is covered by `test/local_execution_environment.test.js`, hosted-environment tests, and `test/local_session_host.test.js`.

### Generic adapters and Tau logic

Execution environments and tool backends are deliberately dumb target adapters. They may run Bash or Node, read and write files, list directories, and expose other generic capabilities. Do not put Tau-specific prompt, persona, config precedence, content parsing, or session semantics there.

Put Tau resource resolution and business rules in `src/core/config/`, `src/core/runtime/`, or the host layer, and implement them through generic backend operations. When hosted resolution needs to inspect several target files, prefer one target-side Node script over many network round trips. Keep local and hosted environments on the same interface, without local-only filesystem shortcuts.

### Shared agent runtime and supervision

`src/core/agent/agent_runtime.ts` is the context-neutral stateful runtime for main sessions, supervised subagents, and ephemeral threads. It owns model and tool subturns, streaming, retries, compaction, steering, interruption, recovery, and durable agent state. Do not fork those semantics into a mode-specific runner.

- `src/core/runtime/chat_runtime.ts` resolves the main model, prompt, and fully bound `AgentSpec`.
- `src/core/tools/catalog.ts` binds tool dependencies outside `AgentRuntime`.
- `src/core/runtime/model_sampler.ts` performs stateless inference against an explicit resolved model target. The caller selects that target; do not couple isolated sampling to the active persona in `AgentRuntime`.
- `src/core/subagents/agent_supervisor.ts` owns child records, limits, waits, follow-ups, interruption, progress, usage attribution, and cleanup.
- `src/host/hosted_ephemeral_agent_session.ts` owns ephemeral thread and fork lifecycle while using ordinary `AgentRuntime` instances.

A logical turn captures its complete `AgentSpec`, including tools and model settings, for model/tool subturns and steering continuations. A concurrent settings change applies to the next independently started or queued turn, not the active one.

Every `AgentRuntime` has one required, awaited `AgentEventSink` from `src/core/agent/events.ts`. Mutate durable agent state, emit the semantic event, and await acknowledgement before dependent work. Sink failure aborts execution. Do not add fire-and-forget semantic event paths. The main host adapter serializes snapshot and transient projections through one per-session mutation queue, applies and persists a durable mutation before acknowledging its event, and settles durable turn state before returning the live response. See the backpressure and failure tests in `test/agent_runtime.test.js`, `test/agent_supervisor.test.js`, and `test/local_session_host.test.js`.

When a subagent uses an alternate working directory, rebuild only target-dependent environment, repository, `AGENTS.md`, configured context, and discovered skills. The parent remains authoritative for persona, subagent definition, model catalog and settings, and tool policy.

## Session, snapshot, and protocol invariants

`src/protocol/session_protocol.ts` owns the wire DTOs, strict parsers, snapshot schema, delta application, and protocol limits shared by transports and SDK clients. Public integration behavior belongs in `docs/session-protocol.md` and `docs/session-protocol-methods.md`. Any protocol change must update the owning protocol tests and the SDK or host integration tests that consume it.

### Snapshot and timeline

The session snapshot is the recoverable source of truth. It owns immutable creation attributes and timestamp, goal, independent agent state, settings, cumulative cost, bootstrap/catalog metadata, execution-environment identity, complete synchronized messages and turn receipts, the active timeline, semantic tools/operations/agents, and client-facing facets.

Do not conflate protocol snapshot revision, agent revision, model context key, timeline epoch, pending-message revision, or subagent-activity revision.

- Applying ordered `session.delta` patches or a reset to the previous snapshot must reconstruct the exact next snapshot. Validate revision continuity and apply each patch atomically in order.
- Use structured delta causes for compaction, rewind, and resync. Never infer a transition from titles, IDs, message counts, or content.
- Render active order from `timeline.items`. Mutable tool and operation state lives in keyed maps; timeline items give those records permanent placement by reference.
- A timeline has a positive epoch and a monotonic per-epoch sequence high-water mark. Successful compaction increments the epoch exactly once and replaces the recoverable active timeline. Failed, skipped, or aborted compaction stays in the same epoch.
- Rewind removes current-epoch state at the selected boundary but never lowers the sequence high-water mark. Removed sequence numbers are not reused.
- A client present during compaction may freeze the previous epoch as local presentation. A newly attached client renders only the persisted active epoch.
- Retained messages after compaction may remain model-visible without timeline items. Do not assume model context and rendered transcript are identical sets.
- Operation state is discriminated. Running operations have no terminal fields; terminal operations require `finishedAt` and their status-specific error or reason.
- Tool lifecycle status is semantic snapshot state. Tool activity and presentation facets do not determine the outcome.

`test/session_protocol.test.js` exercises schema, delta, timeline, reset, notice, and operation invariants. `test/local_session_host.test.js` covers their persisted and streamed projections.

### Turns, persistence, and failures

Accepted host-level logical turns are durably keyed by submitted user history entry ID in the snapshot's `turns` ledger, independently of messages and presentation. Persist a running receipt before model work and persist settlement before returning the live result. Compaction and rewind preserve receipts, removed sequence numbers are not identities to reuse, and recovery aborts persisted running receipts.

Provider failures and interruptions remain canonical assistant-message state. If an exceptional failed or blocked turn has no failed assistant message, settle it exactly once as the corresponding semantic core notice. Clients switch on notice `kind` and live request outcome, never notice titles, generated IDs, counts, or delivery timing. Core notice kinds reserve `tau.*`; other kinds are open, lowercase, and dotted.

The hosted session mutation queue must serialize durable writes with streamed and transient projections. Publish only state based on a successfully committed predecessor. Roll protocol projection back after persistence failure. Observer-listener failure must not retroactively fail a committed runtime event.

### Streaming and live channels

High-rate assistant streaming must stay on the shared session protocol path. Coalesce partials and prefer `message.content.append` over full-message replacement. Do not add a local TUI shortcut.

During streamed tool-call construction, expose only tool identity and draft-message origin. Partial arguments must not enter the protocol. The complete assistant `toolCall` establishes the executable call reference before execution.

Pending input, subagent activity, and ephemeral events are not interchangeable with snapshot state. An observation installs the complete snapshot, pending-input, and subagent-activity baselines before the client processes later updates:

- `session.pendingUserMessages` is an independently revisioned full replacement shared by clients while a hosted session is live. It is not persisted and starts empty on recovery.
- `session.subagentActivities` is independently revisioned, bounded supervision state, not a facet. Observation returns a complete baseline; later updates replace changed agents or explicitly remove them. It represents only the current run and starts empty on recovery.
- `session.ephemeral` carries nonrecoverable feedback and thread updates. A sequenced ephemeral `timeline.item` advances and persists the timeline high-water mark but is omitted from snapshots. Stateful host work such as compaction belongs in semantic operation state, not a parallel footer lifecycle.

Keep exact activity and payload bounds in `src/protocol/session_protocol.ts`; test UTF-8 projection at the protocol and host boundaries instead of copying volatile numbers into another contract.

### Recovery, user text, and history

Recovery discards supervised agents and agent-owned presentation because child processes do not survive restart. It normalizes unrecoverable tool state, aborts running turn receipts, cancels running maintenance operations with reason `session-recovered` while preserving their timeline placement, and blocks active goals until explicitly resumed.

Effective system instructions are the first committed message. Snapshot user text is raw recoverable Tau session text. Strip Tau metadata before model calls and display, and hide leading exact `<system>...</system>\n` blocks only in user-message display projection. Do not apply user projection to assistant, tool-result, or protocol system messages.

Searchable history is a separate flat transcript of committed user entries, assistant text, and completed tools. Rewind truncates it; compaction does not. Remote replication proceeds asynchronously from the durable local outbox. History is not sufficient to recover session state. See `docs/sessions.md`, `docs/history.md`, and tests under `test/history.test.js` and `test/local_session_host.test.js`.

Themes are client-local and never belong in a snapshot. Prompt catalogs contain metadata only; prompt bodies resolve lazily through the execution environment. Path autocomplete is also lazy and must not become persisted session state.

## Tool, process, and presentation boundaries

Host tools, client tools, and execution-environment operations have different owners. Read `docs/tools.md`, `docs/client-tools.md`, and `docs/security.md` before changing their contracts.

- `ToolCatalog` builds dependency-bound host registries. The intrinsic `tau_docs` tool is present for main and child agents, and main-session goal tools are independent of persona allowlists. Treat `src/core/tools/catalog.ts`, `src/core/tools/registry.ts`, and `src/core/tools/tool_names.ts` as the volatile inventory.
- Client-provided tools are advertised capabilities of attached clients, not host registry entries. Their commands execute on the client machine; their execution-environment facade crosses the session protocol. Keep tool-name ownership unique among observers, validate arguments against the configured object schema, honor cancellation, and terminate active process groups on detach or terminal transport failure.
- Keep immediate tool-call schemas strict. For code-mode tools, generated code receives only the declared bounded API. Credentials and service clients stay in the trusted parent, and agent-visible target file or process access crosses the execution backend. Only console output is the code-mode result.

Every Bash invocation runs in a fresh, noninteractive login Bash in the execution environment. Shell state does not persist. `HOME` and command resolution belong to that environment, there is no TTY or interactive stdin, and Git is forced noninteractive. Login startup files must not write banners, prompt, read stdin, require a TTY, launch editors, or terminate the shell unexpectedly. Tau does not filter startup output. Keep capture, timeout, environment sanitization, and termination logic centralized in `src/core/tools/execution_backend.ts` and test it in execution and Bash tests.

### Prompt and presentation conventions

- Use dash-case for XML-like prompt/context tags, for example `<available-skills>`, `<tool-call>`, `<tool-result>`, and `<last-assistant-message-verbatim>`. Do not introduce snake_case tag names.
- Tau-authored feedback titles are concise lowercase fragments without trailing punctuation, except for proper nouns and identifiers. Use action-first `failed to ...` titles for failures. Put diagnostics and IDs in content, use the error tone for failed or invalid operations, and use the default tone for information, expected cancellation, and nonfatal degradation.
- Tool producers own bounded `ToolRunPresentation`. Preserve the canonical lifecycle from `preparing` to `queued` to `running` to a terminal protocol status. Keep one generic tool-card renderer, with no tool-specific renderers or expanded mode. Exact preview policies belong in `src/core/tools/presentation.ts` and their tests, not in the TUI.
- Tool presentation facets have an independent version. Missing or historical presentation degrades from canonical tool name, status, and textual result without revealing stored arguments. Malformed current-version presentation fails validation.
- Use semantic palette tokens for TUI colors. Add a dedicated token for a new semantic state; never repurpose an unrelated token. See `src/tui/ui/theme/` and terminal appearance tests.
- Programmatic Telegram replies and notices must be natural-language sentences. Integrate project and session identifiers into prose and translate internal states instead of emitting metadata-style labels.

## Codebase map

Start with the smallest owning area, its callers, and its tests. This map is task-oriented rather than an exhaustive inventory.

| Task | Primary owners | Start with tests/docs |
| --- | --- | --- |
| CLI startup and mode wiring | `src/main.ts`, `src/core/cli.ts`, `src/core/modes/` | `test/cli.test.js`, `test/websocket_session_transport.test.js`, `docs/getting-started.md` |
| Runtime, model turns, retries, compaction | `src/core/agent/`, `src/core/runtime/`, `src/core/session/`, `src/core/utils/model_stream.ts` | `test/agent_runtime.test.js`, `test/chat_runtime.test.js`, `test/model_stream.test.js`, `docs/sessions.md` |
| Host lifecycle and session mutations | `src/host/` | `test/local_session_host.test.js`, `test/hosted_ephemeral_agent_session.test.js` |
| Wire protocol and deltas | `src/protocol/session_protocol.ts` | `test/session_protocol.test.js`, `docs/session-protocol.md`, `docs/session-protocol-methods.md` |
| Persistence and migrations | `src/store/` | `test/session_store.test.js`, `test/file_session_store.test.js`, `test/local_session_host.test.js` |
| Execution environments | `src/execution/`, `src/core/tools/execution_backend.ts` | `test/local_execution_environment.test.js`, `test/cloudflare_sandbox_execution_environment.test.js`, `test/fly_sprite_execution_environment.test.js`, `docs/ownership-and-scope.md` |
| Transports and Node SDK | `src/transport/`, `src/sdk/` | `test/in_process_session_transport.test.js`, `test/sdk_client_integration.test.js`, `docs/node-sdk.md`, `docs/remote-sessions.md` |
| Config, content, models, prompts | `src/core/config/`, `src/core/models/`, `src/core/personas.ts`, `src/core/runtime/runtime_bootstrap.ts` | `test/config_layers.test.js`, `test/model_catalog.test.js`, `test/skills_discovery.test.js`, `docs/configuration.md`, `docs/config-reference.md` |
| Credentials and authentication | `src/core/auth/` | `test/auth_storage.test.js`, `test/auth_cli.test.js`, `docs/credentials.md` |
| Host tools and code mode | `src/core/tools/`, `src/code_mode/`, `src/core/static/code_mode/` | `test/tool_catalog.test.js`, `test/code_mode.test.js`, `test/web_tool.test.js`, `docs/tools.md` |
| Command client tools | `src/core/config/client_tools.ts`, `src/core/client_tools/`, `src/host/client_tool_broker.ts`, `src/sdk/client_tool_command.ts` | `test/client_tool_broker.test.js`, `test/command_client_tools.test.js`, `docs/client-tools.md` |
| Subagent supervision | `src/core/subagents/`, spawn/follow-up tools in `src/core/tools/` | `test/agent_supervisor.test.js`, `test/spawn_agent_tool.test.js`, `docs/subagents.md` |
| TUI and presentation | `src/tui/`, `src/tui/ui/` | `test/session_chat_controller.test.js`, `test/tool_card.test.js`, `test/tool_ui_router.test.js`, `docs/tui.md` |
| Diff review | `src/core/diff_review/`, `src/diff_tool/` | `test/diff_review_protocol.test.js`, `test/diff_tool_builtin.test.js`, then `src/diff_tool/AGENTS.md` |
| History | `src/core/history/`, `src/history/worker/`, `src/core/tools/history.ts` | `test/history.test.js`, `docs/history.md` |
| Telegram | `src/core/telegram/` | `test/telegram_adapter.test.js`, `test/telegram_workspace.test.js`, `docs/telegram.md` |
| Nook | `src/core/nook/`, `src/core/tools/nook.ts`, `src/nook/` | `test/nook.test.js`, `docs/nook.md`, then `src/nook/AGENTS.md` |
| Documentation packaging | `docs/manifest.json`, `scripts/copy-tau-docs.js`, `src/core/tools/tau_docs.ts` | `test/tau_docs.test.js`, `test/tau_docs_corpus.test.js` |

For public content contracts, follow `docs/models.md`, `docs/personas.md`, `docs/skills.md`, and `docs/prompts-and-project-context.md` rather than reproducing their inventories here.

When adding a slash command, update the command union and registry in `src/core/commands/registry.ts`, wire its handler in `src/tui/session_chat_controller.ts`, and add argument suggestions in `src/tui/ui/slash_autocomplete.ts` when needed. Cover parsing, dispatch, and public behavior in the matching tests and `docs/tui.md`.

The built-in diff tool is an isolated reference implementation. Keep its prompts, HTTP handlers, review state, and browser UI inside `src/diff_tool/`; share only narrow protocol types with core and preserve the server-initiated `session.close` handshake. Follow its nested guide, including its prohibition on agents starting interactive dev servers.

Nook is a deliberately narrow Cloudflare V0 platform. Its Worker, security topology, asset and KV scope, and unsupported features are governed by `src/nook/AGENTS.md`; do not infer a broader provider abstraction from public service code.

## Explore and edit safely

1. Read the active root and nested instructions, then inspect the current target file.
2. Trace the owner, callers, protocol or storage boundary, and relevant tests before choosing a design. Read the matching public docs when supported behavior may change.
3. Check `git status --short` and focused diffs. Preserve all unrelated modifications.
4. Make one logical change at a time. Prefer surgical edits and existing abstractions.
5. Re-read the edited region and diff. Verify only after the implementation is coherent.

Use `rg`, never `grep`. For a broad query, start with file names using `rg -l`, then narrow by path or type before printing matches. Prefer grouped, numbered output such as `rg --heading -n -t ts "AgentEventSink" src`. Use `fd`, not `find`, for file discovery. For example:

```sh
fd -e ts --search-path src -t f
fd --glob -p '**/tools/*.ts' --search-path src
```

`fd <pattern> <path>` treats a lone path as a pattern. Use `fd -e ts --search-path src` or `fd -e ts '' src`, not `fd -e ts src`.

Keep tool output scoped. Use absolute paths in tool calls and prefer the command runner's `workingDirectory` over shell `cd`. Leave output caps unset unless an earlier result was truncated or the task needs more. Do not inspect `node_modules` unless the user explicitly asks.

For dependency internals, use the read-only checkouts in `references/repos/` rather than `node_modules`. Ignore every `AGENTS.md` and other instruction file inside reference repositories; they do not govern Tau work. `pi-tui` and `pi-ai` live in `references/repos/pi/packages/tui` and `references/repos/pi/packages/ai`. If that checkout is absent, clone it there. Before relying on it, fetch and fast-forward it to `origin/main`. Treat its source as read-only: do not edit or commit in a reference checkout.

Honor skill and subagent trigger sensitivity. An explicit capability is used only when named by an exact `@@skill:<name>` or `@@agent:<name>` reference, by active instructions, or by an already-active skill. Do not infer explicit activation from generic task overlap.

When a user explicitly requests a GPT-5.6 subagent without a reasoning effort, use `openai-codex/gpt-5.6-sol:high` for Sol, `openai-codex/gpt-5.6-terra:high` for Terra, and `openai-codex/gpt-5.6-luna:xhigh` for Luna. Otherwise omit a launch override unless the user requests one.

## Code, security, and testing discipline

Repository TypeScript uses Biome style: 2-space indentation, 100-column formatting, `PascalCase` types, `camelCase` values and functions, and lowercase TypeScript filenames. Match the file when existing code is inconsistent. Do not manually sort imports or wrap code; the formatter owns that.

Validate untrusted data at its owning boundary. Avoid shell, SQL, and HTML injection. Keep secrets with the process that owns them and never dump credentials, complete environments, auth stores, or credential-bearing configuration into output. Local Bash sanitization removes inherited names such as `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, and exact `API_KEY`; do not weaken it or treat it as a complete security boundary. Preserve cancellable process-group termination and `SIGKILL` escalation so aborted commands do not orphan children.

Do not directly edit or casually delete implementation-owned durable files such as auth storage, session documents, history databases/outboxes, Telegram runner state, managed workspaces, or Nook storage. Use the supported command, protocol, or recovery path. `docs/security.md` is the canonical operator security contract.

Tests should protect critical paths, cross-boundary contracts, recovery, concurrency, and likely regressions. Prefer one high-impact behavioral test over broad low-value assertion churn. When a contract changes, test the owner and at least one important consumer. For stored sessions, include a representative old document and normal recovery. For protocol state, verify delta application and observer behavior, not only parser acceptance.

## Formatting and verification

A fresh checkout needs dependencies in both package roots:

```sh
npm ci
(cd src/diff_tool/app && npm ci)
```

Run verification in this order:

```sh
npm run check
npm run build
npm test
```

`npm run check` writes canonical Markdown and Biome formatting before typechecking both the root and diff-tool app. Run it first whenever files may need formatting, then inspect its changes before build and tests. `npm run build` clears generated output, builds the diff-tool app, and compiles Tau. `npm test` builds again and runs the Vitest suite.

Never run `npm start` or `node dist/main.js`. They launch the interactive TUI and require a real terminal. Also follow nested prohibitions on starting diff-tool development servers.

## Git and GitHub

Do not commit unless the user explicitly asks. Never bypass hooks with `--no-verify`. Do not use work-destroying or history-mutating commands such as `git reset --hard`, `git checkout -- <file>`, `git restore`, `git stash`, rebase, cherry-pick, or force-push unless the user explicitly requests the exact operation. Before amending, verify the commit is yours and has not been pushed.

- Commit subjects are short, imperative, lowercase, and have no prefix. The body is empty unless a single-commit issue change has no PR; then the only body line may be a closing keyword such as `fixes #123`. Put the closing keyword in the PR body when opening a PR.
- Branch names are lowercase, a few descriptive words, and contain no prefixes or issue references.
- PR titles are concise and lowercase except for proper nouns. PR bodies are readable prose with required `## why` and `## what` sections, plus `## details` only when useful. Do not list routine verification commands. End with a closing keyword line when associated with an issue.

Use `gh` for GitHub operations and omit `--repo`, which resolves from this repository. Read an issue and all comments with:

```sh
gh issue view <id> --json closed,author,labels,title,body,comments
```

Use a heredoc for multiline PR bodies:

```sh
gh pr create --title "short title" --body-file - <<'EOF'
## why

Reason for the change.

## what

What changed.

fixes #123
EOF
```

## Releases

Never run a release flow unless the user explicitly asks. Publishing occurs through GitHub Actions when a GitHub Release is published and uses the `NPM_TOKEN` repository secret.

Before releasing, require all of the following:

- The branch is `main`.
- The worktree is clean. Unpushed commits are acceptable because the flow pushes commits and tags.
- Dependencies are installed in both package roots for a clean checkout.
- `npm run check && npm run build && npm test` succeeds in that order.

If the branch or worktree requirement is not met, stop and ask what to do. Do not clean or switch it yourself.

Patch release:

```sh
npm version patch && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes
```

Minor release:

```sh
npm version minor && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes
```

Alpha prerelease, published under the `alpha` npm tag rather than `latest`:

```sh
if node -p "require('./package.json').version.includes('-alpha.')"; then npm version prerelease --preid alpha; else npm version preminor --preid alpha; fi
git push --follow-tags
gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease
```

## Documentation responsibilities

Keep each documentation surface within its role. Do not copy volatile product inventories into this guide.

- Update the relevant flat `docs/*.md` pages when changing supported user, operator, configuration, integration, security, or troubleshooting behavior. Protocol changes usually affect `docs/session-protocol.md` and `docs/session-protocol-methods.md`; SDK changes usually affect `docs/node-sdk.md`.
- Update `README.md` only when the public landing or first-run path changes.
- Update `AGENTS.md` when contributor workflow, source ownership, cross-cutting architecture, or a safeguard changes.
- Update source and tests together. Neither this guide nor public docs replace reading the current implementation.
- Do not opportunistically document unrelated previously undocumented behavior unless the user asks.

The public documentation corpus is flat and version-matched. Every Markdown page must appear once in `docs/manifest.json`, use valid flat internal links, and remain within packaging bounds. It is copied by `scripts/copy-tau-docs.js`, served to agents by `src/core/tools/tau_docs.ts`, and enforced by `test/tau_docs_corpus.test.js` and `test/tau_docs.test.js`.
