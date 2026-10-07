# Contributing to Tau as an agent

Tau is a terminal AI client. Local and remote sessions share one host and runtime. This guide records what the code cannot tell you: intent, cross-cutting invariants, prohibitions the compiler does not enforce, taste, and workflow. For exact behavior, read the owning source and its tests. They win over this file.

Sources and their roles:

- `README.md`: landing page and first run.
- `docs/*.md`: version-matched public product docs for users, operators, integrators, and Tau's own agent.
- `AGENTS.md` (this file plus nested ones): contributor rules and design context.
- Source and tests: authoritative current behavior.

## Hard rules

- **Shared, dirty worktree.** Existing changes are intentional. Never revert, overwrite, reformat, or "fix" unrelated work. Read a file's current contents before editing it. If it changes between your read and write, stop and ask.
- **Nested guides are mandatory.** `src/diff_tool/AGENTS.md` and `src/nook/AGENTS.md` add rules for their subtrees.
- **macOS and Linux only.** Never add Windows support or a Windows fallback (`src/core/platform_support.ts`).
- **Pre-v1: no compatibility scaffolding,** except for stored sessions (see [Design principles](#design-principles)).
- **Client, host, and execution environment are separate machines,** even in one process (see [Ownership](#ownership)).
- **Never run `npm start` or `node dist/main.js`.** They need a real terminal.
- **No commits, releases, or work-destroying git commands** unless the user explicitly asks for that exact operation. That includes `git reset --hard`, `git checkout -- <file>`, `git restore`, `git stash`, rebase, cherry-pick, and force-push.
- **Never edit durable Tau state directly** (auth storage, session documents, history databases and outboxes, Telegram runner state, managed workspaces, Nook storage). Use the supported command, protocol, or recovery path.
- **Confirm before destructive operations** such as deleting files or dropping data.
- **Do only the requested change.** No surrounding cleanup, speculative config, or speculative abstractions. Match local naming, structure, error handling, and test style.

## Design principles

Pre-v1, optimize for one clean v1 contract, even when the change is breaking.

- Change a contract at its owner and update every caller.
- Make a field required when every caller can provide it. Use optionality only when absence is a real domain state, and then define and test the absent case and how consumers react.
- No fallback branches, aliases, dual readers, legacy unions, migrations, or shims unless the user asks.
- Keep types narrow so invalid states are unrepresentable.
- When required data cannot be produced, fail at the owning boundary. Never silently omit it.

**Stored-session exception.** Session documents under `~/.config/tau/sessions` are shipped user data, and newer Tau must open supported older ones.

- The guarantee covers semantic conversation and session data, not byte-identical documents or identical rendering. Derived, cached, and presentation state may be regenerated, dropped, or rendered generically.
- Compatibility lives only at the storage/recovery boundary: `src/store/session_snapshot_migrations.ts`, `src/store/file_session_store.ts`, `src/host/local_session_host.ts`. Use sequential migrations, versioned payloads, recovery normalization, regeneration, or an explicit degraded/read-only mode. Never leak old shapes into runtime, protocol, host, or TUI types.
- Rejecting corrupt documents or documents from a newer storage version is fine. Recovery may also fail when the recorded execution environment cannot be restored.
- Test with a representative old document through store loading, host recovery, and the affected consumer (`test/file_session_store.test.js`, `test/local_session_host.test.js`).

## Ownership

Path of a request: client → SDK session facade → protocol transport → host → `ChatRuntime` → `AgentRuntime`. Events return through the host's serialized snapshot projection as protocol deltas to every observer. `SessionChatApp` and `SessionChatController` are the one TUI path for local and remote sessions. WebSocket attach, SDK, and Telegram reuse the same host and runtime. Public descriptions: `docs/ownership-and-scope.md`, `docs/remote-sessions.md`, `docs/node-sdk.md`.

| Owner | Owns |
| --- | --- |
| Client | TUI, editor and drafts, terminal appearance and theme, local speech, diff tool process, command client tools |
| Host | Orchestration, persistence and recovery, model calls, credentials, model catalogs, history, tool binding, execution-environment lifecycle |
| Execution environment | Everything agent-visible: paths, `cwd`, home, repository, project config and content, `AGENTS.md`, skills, platform, Node, `PATH`, files, commands |
| Telegram runner | Polling, routing, attachments, prepared workspaces, outbound messages, runner state. It is a client of in-process sessions. |

Rules that follow:

- Every agent-visible access goes through `ExecutionEnvironment` and `ToolExecutionBackend` (`src/execution/execution_environment.ts`, `src/core/tools/execution_backend.ts`), even for local sessions. Co-location must never create a second runtime path or a local-only filesystem shortcut.
- Client and host code must not inspect execution-environment paths. The only exception is narrow pre-creation metadata a client reads from an environment it manages directly.
- Session creation attributes are complete, authoritative client input. Host and stores never infer or normalize them.
- Process-local temp paths come from `node:os` `tmpdir()`, never a hard-coded `/tmp`. Target temp paths come from target capabilities, never from the caller's temp directory.
- Model catalogs and their cache belong to the host. Model metadata comes only from the bundled and refreshed catalogs. Execution environments and backends never read the cache; host-side config resolution may receive an immutable catalog snapshot. A live session keeps one catalog generation until explicit reload. Startup refresh is async and never a recurring timer.
- API-key config is global-only (credential precedence: `src/core/auth/`). Codex OAuth uses exactly one active stored account. Do not add session pinning, quota-based selection, or failover.
- Telegram workspaces are prepared once per session and preserved across runner restarts (`docs/telegram.md`, `test/telegram_workspace.test.js`).

**Adapters are dumb.** Execution environments and tool backends expose generic capabilities: run Bash or Node, read and write files, list directories. Tau logic (prompts, personas, config precedence, content parsing, session semantics) belongs in `src/core/config/`, `src/core/runtime/`, or `src/host/`, built on those generic operations. When hosted resolution needs several target files, prefer one target-side Node script over many round trips.

## Agent runtime

`src/core/agent/agent_runtime.ts` is the single stateful runtime for main sessions, subagents, and ephemeral threads. It owns subturns, streaming, retries, compaction, steering, interruption, recovery, and durable agent state. Never fork these into a mode-specific runner.

- Neighbors: `ChatRuntime` resolves model, prompt, and the bound `AgentSpec`. `src/core/tools/catalog.ts` binds tool dependencies. `model_sampler.ts` does stateless inference against a target the caller chooses; never couple it to the active persona. `src/core/subagents/agent_supervisor.ts` owns child lifecycle, limits, waits, usage, and cleanup. `src/host/hosted_ephemeral_agent_session.ts` owns ephemeral threads and forks.
- A logical turn captures its full `AgentSpec` (tools, model settings) for all its subturns and steering continuations. A settings change applies to the next turn, not the active one.
- **Event sink contract.** Every `AgentRuntime` has one required, awaited `AgentEventSink` (`src/core/agent/events.ts`). Mutate durable state, emit the event, await acknowledgement, then continue. Sink failure aborts execution. Never add fire-and-forget semantic events.
- Subagents are general-purpose workers. Do not add named worker types or configurable worker definitions; only the launch-model allowlist is configurable. Persona tool selection controls whether they can be launched. Children inherit the prompt and eligible tools.
- A subagent with another working directory rebuilds only target-dependent context (environment, repository, `AGENTS.md`, context files, skills). Persona, model catalog and settings, and tool policy stay with the parent.

## Sessions, snapshots, and protocol

`src/protocol/session_protocol.ts` owns wire DTOs, strict parsers, the snapshot schema, delta application, and protocol limits. A protocol change updates its tests (`test/session_protocol.test.js`), the SDK or host integration tests that consume it, and `docs/session-protocol.md` / `docs/session-protocol-methods.md`. Never copy limits or field lists into other files. Test payload bounds, including UTF-8 projection, at the protocol and host boundaries.

**Snapshot.** The snapshot is the recoverable source of truth.

- Ordered deltas applied to the previous snapshot must reproduce the next snapshot exactly.
- These counters are independent and must never be mixed up: protocol snapshot revision, agent revision, model context key, timeline epoch, pending-message revision, subagent-activity revision.
- Compaction, rewind, and resync use structured delta causes. Never infer a transition from titles, IDs, counts, or content.
- Render order comes from `timeline.items`. Mutable tool and operation state lives in keyed maps, and timeline items reference it.
- Successful compaction increments the epoch exactly once. Failed, skipped, or aborted compaction stays in the same epoch.
- Rewind never lowers the sequence high-water mark, and removed sequence numbers are never reused.
- After compaction, retained messages may stay model-visible without timeline items. Model context and rendered transcript are different sets.
- A client present during compaction may keep the old epoch as local presentation. A newly attached client renders only the persisted active epoch.
- Tool outcome is snapshot status. Never derive it from activity or presentation facets.

**Turns and failures.**

- Every accepted logical turn has a receipt in the snapshot's `turns` ledger, keyed by the submitted user history entry ID. Persist a running receipt before model work and the settlement before returning the live result. Compaction and rewind preserve receipts. Recovery aborts running receipts.
- Provider failures and interruptions are assistant-message state. A failed or blocked turn without a failed assistant message settles exactly once as a semantic core notice.
- Clients switch on notice `kind` and the live request outcome, never on titles, IDs, counts, or timing. `tau.*` kinds are reserved; other kinds are lowercase and dotted.
- One per-session mutation queue serializes durable writes with streamed and transient projections. Publish only state built on a committed predecessor. Roll back the projection when persistence fails. Observer-listener failure never fails a committed event.

**Streaming and live channels.**

- Assistant streaming goes through the shared protocol path: coalesce partials and prefer `message.content.append`. No local TUI shortcut.
- While a tool call streams, expose only tool identity and draft origin. Partial arguments never enter the protocol.
- `session.pendingUserMessages`, `session.subagentActivities`, and `session.ephemeral` are separate from the snapshot and from each other. None is persisted, and all start empty after recovery. A sequenced ephemeral `timeline.item` still advances and persists the timeline high-water mark, but never appears in snapshots. Observation installs the snapshot, pending-input, and subagent-activity baselines before any later update.
- Host maintenance such as compaction is semantic operation state, never an ephemeral footer lifecycle.

**Recovery.** Child processes do not survive a restart. Recovery therefore drops supervised agents and their presentation, normalizes unrecoverable tool state, and cancels running work in place. Expected results: `test/local_session_host.test.js`.

**Instructions in messages.**

- Keep exactly one native system prompt: the persona/base prompt, stored as the first message.
- Inject new instructions as leading `<system>...</system>\n` blocks in `role: "user"` messages via `src/core/utils/user_metadata.ts`. This includes storage migrations. Never add new native intermediate `role: "system"` messages, and never promote these blocks to native instructions.
- `src/protocol/system_message.ts` supports existing intermediate system messages. That support does not authorize new uses. When handling them, keep their plain-text contract and versioned metadata: strip metadata for model calls, keep it for recovery and forks. Sections and tool mutations are unsupported.
- Snapshot user text is raw. Strip Tau metadata before model calls and display. Hide leading `<system>` blocks only when displaying user messages, never in assistant, tool-result, or system messages.

**State that does not belong in the snapshot:** themes (client-local, fixed catalog), prompt bodies (catalogs hold metadata, bodies load lazily through the execution environment), and path autocomplete. Searchable history (`src/core/history/`, `docs/history.md`) is a separate transcript and cannot recover session state. Rewind truncates it; compaction does not.

## Tools and processes

Read `docs/tools.md`, `docs/client-tools.md`, and `docs/security.md` before changing a tool contract. The tool inventory lives in `src/core/tools/catalog.ts`, `registry.ts`, and `tool_names.ts`.

- **MCP** (`src/core/mcp/manager.ts`): bound once per host and shared with main and child registries. Server config comes from the host's launch-directory config layers, never from execution-environment config. Stdio servers deliberately run on the host with host authority. Keep calls bounded and cancellable, never retry mutations, and await cleanup at shutdown. The `mcp` tool reuses code mode.
- **Client tools** are capabilities of attached clients, not host registry entries. Commands run on the client machine. Tool names must be unique among observers. Validate arguments against the configured schema, honor cancellation, and kill active process groups on detach or transport failure.
- **Code mode** (`src/code_mode/` sandbox and output, `src/core/code_mode/` capability APIs, `src/core/tools/code.ts` binding):
  - Generated code receives only the declared API. Credentials and service clients stay in the trusted parent. Target file and process access goes through the execution backend.
  - Only `printText` text and `await printImage(block)` images reach the result. Image validation and preparation run outside the sandbox. An image keeps the position where it was emitted, not where preparation finished, all the way to clients.
  - Direct tools and composed operations share the same services. Model usage inside code mode is an awaited `tool_usage` event, persisted even if the program fails.
- **Bash.** Each call runs a fresh, noninteractive login Bash in the execution environment, so no shell state persists. Capture, timeout, env sanitization, and termination stay centralized in `src/core/tools/execution_backend.ts`. Background jobs (`src/core/tools/bash_jobs.ts`) are live-only, shared within one `ChatRuntime`, and never recovered. Jobs survive turn interruption and observer release, and running jobs prevent session eviction. Disposal must stop running jobs before waiting for them.
- **Process safety.** Preserve process-group termination with `SIGKILL` escalation so aborted commands do not orphan children. Do not weaken local env sanitization of secret-like names; it is not a complete security boundary either.
- Keep immediate tool-call schemas strict.

## Presentation and copy

- XML-like prompt tags use dash-case: `<available-skills>`, `<tool-result>`. Never snake_case.
- Feedback titles: concise lowercase fragments, no trailing punctuation, failures as `failed to ...`. Diagnostics and IDs go in content. Error tone for failures, default tone for information, expected cancellation, and nonfatal degradation.
- Tool cards: producers own a bounded `ToolRunPresentation`. One generic renderer, no tool-specific renderers, no expanded mode. Preview policy lives in `src/core/tools/presentation.ts`. Lifecycle: `preparing` → `queued` → `running` → terminal status.
- Presentation facets have their own version. Missing or historical presentation degrades to tool name, status, and text result without revealing stored arguments. Malformed current-version presentation fails validation.
- TUI colors use semantic palette tokens (`src/tui/ui/theme/`). Add a new token for a new state; never reuse an unrelated one.
- Telegram replies, notices, and button labels: natural lowercase sentences that weave identifiers into prose and translate internal states, never metadata-style labels. Never change the casing of user content, saved prompts, or model output.

## Where to start

Start with the smallest owning area, its callers, and its tests.

| Task | Owners | Tests and docs |
| --- | --- | --- |
| CLI and mode wiring | `src/main.ts`, `src/core/cli.ts`, `src/core/modes/` | `test/cli.test.js`, `docs/getting-started.md` |
| Runtime, turns, retries, compaction | `src/core/agent/`, `src/core/runtime/`, `src/core/session/`, `src/core/utils/model_stream.ts` | `test/agent_runtime.test.js`, `test/chat_runtime.test.js`, `test/model_stream.test.js`, `docs/sessions.md` |
| Host lifecycle | `src/host/` | `test/local_session_host.test.js`, `test/hosted_ephemeral_agent_session.test.js` |
| Protocol | `src/protocol/` | `test/session_protocol.test.js`, `docs/session-protocol.md` |
| Persistence | `src/store/` | `test/session_store.test.js`, `test/file_session_store.test.js` |
| Execution environments | `src/execution/`, `src/core/tools/execution_backend.ts` | `test/local_execution_environment.test.js`, `test/fly_sprite_execution_environment.test.js` |
| Transports, SDK | `src/transport/`, `src/sdk/` | `test/in_process_session_transport.test.js`, `test/sdk_client_integration.test.js`, `docs/node-sdk.md` |
| Config, models, personas, prompts | `src/core/config/`, `src/core/models/`, `src/core/personas.ts`, `src/core/runtime/runtime_bootstrap.ts` | `test/config_layers.test.js`, `test/model_catalog.test.js`, `test/skills_discovery.test.js`, `docs/config-reference.md` |
| Credentials | `src/core/auth/` | `test/auth_storage.test.js`, `test/auth_cli.test.js`, `docs/credentials.md` |
| Host tools, code mode | `src/core/tools/`, `src/code_mode/`, `src/core/code_mode/`, `src/core/static/code_mode/` | `test/tool_catalog.test.js`, `test/code_mode.test.js`, `docs/tools.md` |
| Client tools | `src/core/config/client_tools.ts`, `src/core/client_tools/`, `src/host/client_tool_broker.ts`, `src/sdk/client_tool_command.ts` | `test/client_tool_broker.test.js`, `test/command_client_tools.test.js` |
| Subagents | `src/core/subagents/`, agent tools in `src/core/tools/` | `test/agent_supervisor.test.js`, `test/spawn_agent_tool.test.js` |
| TUI | `src/tui/` | `test/session_chat_controller.test.js`, `test/tool_card.test.js`, `docs/tui.md` |
| Diff review | `src/core/diff_review/`, `src/diff_tool/` | `test/diff_review_protocol.test.js`, `test/diff_tool_builtin.test.js` |
| History | `src/core/history/`, `src/history/worker/`, `src/core/code_mode/history.ts` | `test/history.test.js`, `docs/history.md` |
| Telegram | `src/core/telegram/` | `test/telegram_adapter.test.js`, `test/telegram_workspace.test.js` |
| Nook | `src/core/nook/`, `src/core/code_mode/nook.ts`, `src/nook/` | `test/nook.test.js`, `docs/nook.md` |
| Docs packaging | `docs/manifest.json`, `scripts/copy-tau-docs.js`, `src/core/tools/tau_docs.ts` | `test/tau_docs.test.js`, `test/tau_docs_corpus.test.js` |

**New slash command:** the union and registry in `src/core/commands/registry.ts`, the handler in `src/tui/session_chat_controller.ts`, suggestions in `src/tui/ui/slash_autocomplete.ts` if needed, tests for parsing and dispatch, and `docs/tui.md`.

**History viewer development:** `npm run history:dev` runs the history Worker locally with Wrangler, a local-only D1 database, and a fixture conversation. Its dev credentials are in `src/history/worker/`. It is long-running, so ask the user to start it.

**Isolated subtrees:** the diff tool (`src/diff_tool/`) is the only review interface and shares only narrow protocol types with core. Nook (`src/nook/`) is a deliberately narrow Cloudflare platform; do not infer a general provider abstraction from it. Both nested guides apply.

## Working method

1. Read the applicable guides and the target file's current contents.
2. Trace the owner, callers, protocol or storage boundary, tests, and the public docs if behavior may change.
3. Check `git status --short` and focused diffs.
4. Make one logical change at a time, using existing abstractions.
5. Re-read the edited region and the diff. Verify once the change is coherent.

**Search.**

- Use `rg`, never `grep`. Start broad queries with `rg -l`, then narrow. Prefer `rg --heading -n -t ts "Pattern" src`.
- Use `fd`, not `find`. A lone path argument is treated as a pattern: write `fd -e ts --search-path src`, not `fd -e ts src`.
- Use absolute paths and the runner's `workingDirectory` instead of `cd`. Leave output caps unset unless output was truncated.
- Never read `node_modules` unless asked. For dependency internals, use read-only checkouts in `references/repos/`. `pi-ai` and `pi-tui` live in `references/repos/pi/packages/{ai,tui}`. Clone the checkout if missing and fast-forward it to `origin/main` before relying on it. Never edit or commit there, and ignore its instruction files.

**Skills and subagents.**

- Use an explicit skill only when it is named by an exact `@@skill:<name>`, by active instructions, or by an active skill.
- Spawn subagents only when the user or active instructions ask for delegation.
- Default launch overrides when the user names a model without an effort: Sol → `openai-codex/gpt-6.1-sol:medium`, Luna → `openai-codex/gpt-6-luna:high`, GPT-6 Astra → `openai-codex/gpt-6-astra:medium`. Otherwise omit the override.

**Code style.** Biome formats: 2 spaces, 100 columns, `PascalCase` types, `camelCase` values, lowercase filenames. Do not hand-sort imports or hand-wrap. Where a file is inconsistent, match the file.

**Security.** Validate untrusted data at its owning boundary. Avoid shell, SQL, and HTML injection. Secrets stay with the process that owns them. Never print credentials, full environments, auth stores, or credential-bearing config.

**Tests.**

- Protect critical paths, cross-boundary contracts, recovery, concurrency, and likely regressions. One strong behavioral test beats many shallow assertions.
- A contract change tests the owner and at least one important consumer. Protocol changes test delta application and observer behavior, not just parsing.
- Never assert human-facing prose. Assert behavior: rejection before side effects, preserved artifacts, cleanup, retries. Exact text is fine only for machine-consumed contracts.

## Verification

Fresh checkout: `npm ci` at the root and in `src/diff_tool/app`.

Run in order:

```sh
npm run check   # writes Markdown and Biome formatting, then typechecks root and diff-tool app
npm run build
npm test        # builds again, then runs Vitest
```

Inspect what `npm run check` reformatted before building.

**Dependency upgrades.**

- Update both `package.json` files and both lockfiles. Accept compatible transitive updates, review `npm audit`, and do not override versions owned by an upstream package.
- Keep `@types/node` on Tau's supported Node LTS major.
- For `pi-ai`/`pi-tui`: read the changelog and exported API changes in the refreshed `references/repos/pi`, then verify Tau's imports and behavior.
- For `ses`: verify code mode and its sandbox assets, and update version-coupled config such as the Biome schema and `allowScripts` keys.

## Git and GitHub

- Never bypass hooks (`--no-verify`). Before amending, confirm the commit is yours and unpushed.
- Commit subjects are short, imperative, lowercase, with no prefix. The body is empty, except that a single-commit issue fix without a PR may carry one closing-keyword line (`fixes #123`).
- Branch names are a few lowercase descriptive words, with no prefix or issue number.
- PR titles are concise and lowercase except proper nouns. PR bodies are prose with `## why` and `## what` (plus `## details` when useful) and end with a closing-keyword line when tied to an issue. Do not list routine verification commands. Pass multiline bodies with `gh pr create --title "..." --body-file - <<'EOF'`.
- Use `gh` without `--repo`. Read issues with `gh issue view <id> --json closed,author,labels,title,body,comments`.
- Never query or watch CI unless asked. When asked for status, run one non-waiting query and report it. Wait or watch only when asked to.

## Releases

Only when the user explicitly asks. A published GitHub Release triggers npm publishing through Actions (`NPM_TOKEN` secret).

Preconditions: the branch is `main`, the worktree is clean (unpushed commits are fine), dependencies are installed in both roots, and check, build, and test pass in order. If the branch or worktree condition fails, stop and ask. Never clean or switch branches yourself.

```sh
# patch (use `minor` for a minor release)
npm version patch && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes

# alpha prerelease (npm tag `alpha`)
if node -p "require('./package.json').version.includes('-alpha.')"; then npm version prerelease --preid alpha; else npm version preminor --preid alpha; fi
git push --follow-tags
gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease
```

## Writing

Before writing, identify the reader and what they need to do. Use only concepts that reader has. An implementation fact being true does not make it relevant.

| Surface | Reader | Content |
| --- | --- | --- |
| Agent prompts, tool and parameter descriptions, injected context | The agent doing the user's task | What it can do and observe: files, commands, working directory, current chat. Never internal machinery. Write "send a local file to the current Telegram chat", not "from the execution environment". |
| `docs/*.md` | People and agents using, operating, configuring, or integrating Tau | Self-contained product docs: behavior, prerequisites, public interfaces, exact schemas and limits, where things run. No repository structure or internal abstractions. Never written as instructions to Tau's agent: agent behavior in third person, direct instructions only for the reader's own actions. |
| CLI help and diagnostics | Anyone running the command, inside or outside Tau | Usage, prerequisites, actionable errors, public doc links. Never depend on `tau_docs`. |
| `README.md` | Prospective and first-time users | What Tau is, how to start, where to go next. |
| `AGENTS.md` | Contributors | What code cannot say: intent, invariants, prohibitions, ownership, workflow. Point to the owning source and tests instead of copying field lists, limits, inventories, or step-by-step logic. If a sentence would need editing whenever the code changes, it probably does not belong here. |
| Code comments | Maintainers | Non-obvious constraints and reasons, not narration. |

**Docs maintenance.**

- Describe the current product only. No change narratives ("added", "replaced", "no longer"); those belong in PRs and release notes.
- Update the affected `docs/*.md` pages when supported behavior changes. Update `README.md` only when the landing or first-run path changes. Update this file when workflow, ownership, architecture, or a safeguard changes.
- Do not document unrelated undocumented behavior unless asked.
- The docs corpus is flat. Each page appears once in `docs/manifest.json`, uses valid flat links, and stays within packaging bounds (`test/tau_docs_corpus.test.js`).
