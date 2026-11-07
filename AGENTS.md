# Contributing to Tau as an agent

Tau is a terminal AI client whose local and remote sessions share one host and runtime.

This file covers where Tau wants something other than an agent's usual approach: design decisions and their reasons, invariants that span owners, easy-to-miss conventions, workflow, and a map of where things live. Source and tests are the authority on current behavior.

Most guidance explains how Tau is built and why, so apply it to cases the file does not list. When a task seems to need something different, raise it with the user instead of quietly working around it. The few firm rules, marked "never" or "do not", guard against costly or irreversible mistakes.

Tau loads this file into every session in the repository, so each line costs context. When editing it:

- Add a line only if agents would otherwise get something wrong that code, types, or tests would not catch, and give the reason.
- Match the wording's strength to how firmly the rule must hold. Recurring agent mistakes earn more space and firmer wording.
- Leave out what capable agents do by default and how to use general-purpose tools.
- Keep the map at directory level. A line that needs editing whenever the code changes belongs in the code.
- Stay below 4,000 tokens, at 6 bytes per token.

## Breaking changes are expected

Tau has not reached v1, so it changes contracts freely to keep them clean. Breaking callers is the normal way to make a change here: change the contract where it is owned and update every caller in the same change, instead of keeping the old shape alive beside the new one. Agents preserve compatibility by instinct, and here that instinct leaves behind code nobody needs.

- Do not add fallback branches, aliases, dual readers, legacy unions, migrations, or shims unless the user asks.
- Make a field required when every caller can provide it. Use optional fields only when absence is a real domain state, and test how consumers handle it. Keep types narrow so invalid states cannot be represented.
- When required data cannot be produced, fail at the owning boundary instead of silently leaving it out.

**Stored sessions are the exception.** Session documents under `~/.config/tau/sessions` are user data, and newer Tau must open supported older ones. Compatibility code lives only in `src/store/session_snapshot_migrations.ts`, `src/store/file_session_store.ts`, and `src/host/local_session_host.ts`, so old shapes never reach runtime, protocol, host, or TUI types. Test an old document through store loading, host recovery, and the affected consumer.

## Working in the repository

- **Shared worktree.** Several agents and people often work here at once. Uncommitted changes you did not make are someone's work in progress, even when they look wrong or break the build. Leave them, and mention them if they get in your way.
- **Git follows the request.** Commit, push, or release only when asked. Commands that discard uncommitted work, such as `git reset --hard`, `git checkout -- <file>`, `git restore`, and `git stash`, need an explicit request. A request can imply a history rewrite: "rebase onto main" includes the force-push. Deletion works the same way: go ahead when the request clearly covers it, and ask otherwise or when something nobody mentioned would be lost. Use skill `github-workflow`.
- **Do not run `npm start` or `node dist/main.js`.** They open the interactive TUI, which needs a real terminal. Ask the user to start long-running processes such as `npm run history:dev`.
- **Do not edit durable state by hand:** auth storage, session documents, history databases and outboxes, Telegram runner state, or managed workspaces. A hand edit can leave state that recovery cannot open, so use the supported command, protocol, or recovery path.
- **macOS and Linux only.** Do not add Windows support or fallbacks.
- **Scratch files** come from `mktemp` or `mktemp -d`, which respect the configured temporary directory and keep the worktree clean.
- **`pi-ai` and `pi-tui` internals:** read the source in `references/repos/pi/packages/`, which Git ignores. Clone `https://github.com/earendil-works/pi` there if missing, fast-forward it first, treat it as read-only, and ignore its instruction files.

## Map

Tests live flat in `test/`, mostly named after the module they cover.

| Path | Holds |
| --- | --- |
| `src/main.ts`, `src/core/cli.ts`, `src/core/modes/` | CLI entry, `tau serve`, and other modes |
| `src/tui/` | Terminal client; `session_chat_controller.ts` handles input and slash commands |
| `src/sdk/`, `src/transport/` | Node SDK, in-process and WebSocket transports |
| `src/protocol/` | Wire types, snapshot schema, deltas, limits |
| `src/host/` | Session host, bootstrap, recovery, client-tool broker |
| `src/core/runtime/`, `src/core/agent/`, `src/core/session/` | `ChatRuntime`, `AgentRuntime`, compaction |
| `src/core/subagents/` | Supervisor and the native and Claude Code runtimes |
| `src/core/tools/` | Agent tools, Bash and code jobs, tool presentation |
| `src/code_mode/`, `src/core/code_mode/` | Code-mode sandbox and its `tau.*` APIs |
| `src/execution/` | Local and Fly Sprite execution environments |
| `src/store/` | Session persistence and migrations |
| `src/core/config/`, `src/core/personas.ts`, `src/core/models/`, `src/core/auth/` | Config layers, personas and base prompts, model catalogs, credentials |
| `src/core/mcp/`, `src/core/telegram/`, `src/core/tool/` | MCP, the Telegram runner, `tau tool` commands |
| `src/core/history/`, `src/history/worker/` | Local history, and the Cloudflare history service |
| `src/diff_tool/` | Browser diff review, an isolated subtree with its own `AGENTS.md` to read first |
| `docs/` | The manual, also served to agents through `tau_docs` |

## Verification

Install dependencies with `npm ci` at the root and in `src/diff_tool/app`: on a fresh checkout, after pulling or switching branches, and whenever a build or test fails in a way your change does not explain. Stale dependencies often cause such failures here, and reinstalling is cheap and needs no permission. Then run, in order:

```sh
npm run check      # formats Markdown and code, then typechecks
npm run build
npm run test:only  # tests the existing build
```

Leave formatting and import order to `check`.

**Tests have a high bar**, for the same reason as the docs. Agents tend to add tests with every change. Many check the obvious, restate the implementation, or break on harmless refactors, and each one costs time in every later run and change.

- Before adding a test, ask what regression it would catch that existing tests and types would not. If unclear, extend an existing test or add none.
- Tests belong where breakage is costly: critical paths, contracts between owners, recovery, and concurrency. A contract change tests its owner and at least one important consumer. A protocol change also tests delta application and what observers see.
- Assert behavior, such as rejection before side effects, cleanup, and retries. Do not assert human-facing text, because its wording is meant to change freely. Exact text is fine for contracts that programs read.

**Dependency upgrades.** Update both `package.json` files and both lockfiles, and review `npm audit`. Accept compatible transitive updates, but leave upstream-owned versions alone. Keep `@types/node` on Tau's supported Node LTS major. For `pi-ai` and `pi-tui`, read the changelog and API changes in the refreshed reference checkout, then check Tau's imports and behavior. For `ses`, check code mode and update version-coupled config such as the Biome schema and `allowScripts` keys.

**Releases** happen only when the user asks. They need `main`, a clean worktree, and passing verification. Otherwise stop and ask instead of cleaning up or switching branches yourself. A published GitHub Release triggers the npm publish and, if enabled, a deployment of the shared history service, also for prereleases.

```sh
# patch, or minor
npm version patch && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes

# alpha prerelease
if node -p "require('./package.json').version.includes('-alpha.')"; then npm version prerelease --preid alpha; else npm version preminor --preid alpha; fi
git push --follow-tags
gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease
```

## Ownership

Remote sessions shape the architecture: client, host, and execution environment are separate machines, even in one process. A local session is the same arrangement on one machine, so a local-only shortcut breaks remote sessions.

| Owner | Owns |
| --- | --- |
| Client | TUI, drafts, theme, local speech, diff tool process, command client tools |
| Host | Orchestration, persistence, recovery, model calls, credentials, model catalogs, history, tool binding, execution-environment lifecycle |
| Execution environment | Everything the agent can see: paths, `cwd`, home, repository, project config, `AGENTS.md`, skills, `PATH`, files, commands |
| Telegram runner | Polling, routing, attachments, prepared workspaces, and runner state, as a client of in-process sessions |

- Every client (TUI, WebSocket attach, SDK, Telegram) goes through the protocol transport and host, and observes the session through protocol deltas from the host's snapshot projection.
- Everything the agent can see goes through `ExecutionEnvironment` and `ToolExecutionBackend`, also locally. Client and host code do not inspect execution-environment paths, except for narrow pre-creation metadata from an environment the client manages itself.
- The host sets the `machine` and `cwd` creation attributes. Clients own the others, and nothing infers, normalizes, or changes them, including recovery.
- Tau's own temporary paths come from `tmpdir()` locally and from target capabilities on an execution environment, never from a hard-coded `/tmp`.
- Each config field has one owner, in `src/core/config/ownership.ts`. A setting that depends on the session's project comes from `src/host/session_bootstrap.ts` or the session's runtime config, and clients learn it through the snapshot catalog. Reading it from a startup directory gives a remote session the wrong value.
- The host injects credentials at bootstrap, so they stay out of what the execution environment resolves.
- The host owns model catalogs, the only source of model metadata. A live session keeps one catalog until an explicit reload, and the startup refresh runs once in the background.
- API keys are global-only, and Codex OAuth has exactly one active account. Choosing an account is the user's decision, so Tau does not pin accounts to sessions, select them by quota, or fail over.
- Execution environments and tool backends stay generic: they run commands and read and write files. Tau logic, such as prompts, personas, and config precedence, belongs in `src/core/config/`, `src/core/runtime/`, or `src/host/`.

## Agent runtime

`src/core/agent/agent_runtime.ts` is the one runtime for main sessions, native subagents, and ephemeral threads. Subturns, retries, compaction, steering, and recovery live there, and a new mode reuses them instead of getting its own runner.

- A logical turn captures its full `AgentSpec` for all its subturns and steering. Settings changes apply from the next turn.
- Each `AgentRuntime` has one required `AgentEventSink`, and semantic events are awaited: mutate durable state, emit, wait for acknowledgement, then continue. A sink failure aborts execution. Recovery and every observer rely on this order, so new events should follow it.

**Subagents.** `AgentSupervisor` holds one flat pool of agents per session. Parent IDs and depth decide policy, such as who may manage whom, and never select a different execution path.

- Workers are general-purpose, without named types or definitions. Only the launch-model allowlist is configurable.
- Agents manage descendants through `tau.agents` and wait with `wait_for_agents`. Both bind the caller's identity, so the model never supplies a parent or caller ID.
- Native children inherit the immediate parent's prompt, model, settings, working directory, and eligible tools. A worker in another directory rebuilds only target-dependent context, and persona and tool policy stay with the parent.
- Native and Claude Code runtimes implement one contract, `src/core/subagents/runtime.ts`, so a new runtime adds an adapter and uses the shared trace recorder. The supervisor owns queued input, and a runtime only delivers steering into its active turn.
- Only input from an ancestor wakes an idle worker. Its jobs, notifications, and finishing children do not.
- Claude Code workers resolve their own model, instructions, skills, credentials, and MCP servers on the execution environment. They cannot start subagents and are not recorded in history. Never copy Claude credentials to the host, forward Tau's MCP connections to Claude Code, or use Claude transcripts for recovery.

## Sessions and protocol

`src/protocol/session_protocol.ts` owns wire types, parsers, the snapshot schema, delta application, and limits. Import limits and field lists from there so copies cannot drift. Test payload bounds, including UTF-8 projection, at the protocol and host boundaries.

- **Snapshot.** It is the recoverable source of truth, and the ordered deltas must reproduce it exactly. Keep these independent counters apart: snapshot revision, agent revision, model context key, timeline epoch, pending-message revision, and subagent-activity revision. Render order comes from `timeline.items` and tool outcome from snapshot status. Model context and the rendered transcript are different sets.
- **Transitions.** Compaction, rewind, and resync carry structured delta causes, and notices carry a `kind`. Clients switch on those and on the request outcome, never on titles, IDs, counts, content, or timing. `tau.*` notice kinds are reserved.
- **Turns.** Every accepted turn has a receipt in `turns`: persist it as running before model work, and its settlement before returning the result. Provider failures and interruptions are assistant-message state. A failed or blocked turn without a failed assistant message settles exactly once as a core notice.
- **Durable writes.** One mutation queue per session serializes durable writes with projections. Publish only state built on a committed predecessor, and roll back when persistence fails.
- **Recovery.** Child processes do not survive a restart, so recovery drops supervised agents, normalizes unrecoverable tool state, and aborts running receipts and work in place.
- **Live channels.** Assistant streaming uses the shared protocol path, also in the TUI. Partial tool arguments never enter the protocol. `session.pendingUserMessages`, `session.subagentActivities`, and `session.ephemeral` stay separate from the snapshot and are never persisted. Themes, prompt bodies, and path autocomplete stay out of the snapshot, and searchable history cannot recover a session.
- **Retention.** Attached clients, a retention hold, and running work are independent reasons to stay loaded, and operations that use the execution environment count as running work. Retention duration is client policy, so the host has no default.
- **Instructions in messages.** Tau keeps exactly one native system prompt, stored first. New instructions go into user messages as leading `<system>...</system>\n` blocks through `src/core/utils/user_metadata.ts`, including in storage migrations. `src/protocol/system_message.ts` supports existing native intermediate system messages, but do not add new ones. Snapshot user text is raw, so strip metadata before model calls and display, and hide `<system>` blocks only in user messages.

## Tools

- **MCP.** Stdio servers run on the host with host authority, so remote execution environments bind no servers, and remote config must never become host commands. Each hosted session owns one manager, and definitions stay frozen while the session is loaded. Keep calls bounded and cancellable, await cleanup at disposal, and never retry a mutation.
- **Client tools** belong to attached clients and run on the client machine, so they are not host registry entries. Validate arguments against the schema, honor cancellation, and kill active process groups on detach or transport failure.
- **Code mode.** Generated code receives only the declared API. Credentials stay in the trusted parent, and target access goes through the execution backend. Model usage is an awaited `tool_usage` event, persisted even if the program fails.
- **Bash.** Capture, timeouts, environment sanitization, and termination stay in `src/core/tools/execution_backend.ts`. Each agent owns its Bash and code job registries and shares them with no other agent. Jobs are never recovered.
- **Process safety.** Keep process-group termination with `SIGKILL` escalation, so aborted commands leave no orphans. Do not weaken the sanitization of secret-like variable names.

## Presentation

Tau writes the text it shows people in lowercase, including TUI feedback, Telegram replies and buttons, and CLI help and errors. Proper nouns and identifiers keep their case:

```text
this prompt picker has expired. use /prompt to open a new one.
MCP OAuth authorization failed (access_denied)
```

The convention is unusual, so keep to it in new text. User content, saved prompts, and model output keep their casing, and text for models and the docs use ordinary sentence case.

- Feedback titles are short fragments without trailing punctuation, and failures read `failed to ...`. Diagnostics and IDs go in the content. Only failures use the error tone, not expected cancellation or nonfatal degradation.
- Telegram messages are natural sentences that weave in identifiers and translate internal states, instead of metadata-style labels.
- XML-like prompt tags use dash-case, as in `<available-skills>`.
- Tool cards use one generic renderer and a bounded `ToolRunPresentation`, without tool-specific renderers or an expanded mode. A new tool defaults to the shared middle-truncated preview of the exact result returned to the model.
- TUI colors use semantic palette tokens, and a new state gets its own token.

## Writing

Use skill `clear-writing` for all prose. Each surface has its own reader, so use only the concepts that reader has. A true implementation detail is not automatically relevant.

- **Agent prompts and tool descriptions.** The agent sees Tau from the inside and knows only its prompt and tools. To it, Bash is a tool that runs commands, and hosts, clients, or execution environments mean nothing. It needs none of them while instructions and behavior agree. Write "send a local file to the current Telegram chat", and not "send a file from the execution environment".
- **CLI help and diagnostics.** Usage, prerequisites, actionable errors, and public doc links. The person running a command may not be inside Tau, so do not depend on `tau_docs`.
- **`README.md`** is the landing page for someone who has just opened the repository. Read alone, it gives a coherent picture of what Tau is and can do, links to the docs instead of repeating them, and reads in about a minute.
- **Code comments.** Constraints and reasons the code cannot show, without narration.

## Documentation

`docs/` is the version-matched manual for people and agents who use, operate, configure, or integrate Tau. It is short on purpose, because agents load a whole page with each read. Agents tend to add a paragraph for every change and call it thoroughness, which once grew the docs past 70,000 tokens. Hold every change and review to these rules.

**The default is no docs change.** Most bug fixes and internal changes need none, and a new slash command rarely does, because `/help` lists it. When behavior changes:

1. Correct anything in the docs that has become wrong. Wrong docs are never acceptable.
2. Add text only if a reader would otherwise fail a task, choose wrongly, or make a consequential mistake. If it is unclear what the reader would do differently without the passage, leave it out.
3. Describe a new feature briefly: what it is for, how to use it, and limits that could change the reader's approach.
4. Give each rule one home, and link to it from other pages.
5. Prefer replacing text over adding it. When a page grows, cut something.

An unanswered question is not by itself a reason to add text. Check the report against the source, then apply the same test.

These do not belong in the docs:

- Internals: class names, call chains, state transitions, and how components coordinate.
- Rare failures, validation details, and limits or deadlines that do not change what the reader does.
- Anything readers get from `--help`, `/help`, tool descriptions, `tau.docs`, or exported types.
- General developer knowledge, and setup steps owned by other products.
- Instructions for the agent, feature history, change narratives ("added", "no longer"), and security advice beyond `docs/security.md`.
- Unrelated undocumented behavior, unless someone asks.

Form:

- Lead with the normal path, and show configuration and contracts as handwritten types and small examples. Integrators get an overview and can read the source.
- Describe agent behavior in the third person. Give direct instructions only for the reader's own actions.
- Check every example and type against the source, because readers copy examples.
- Add a page only for a separate reader task, never just to fit a size limit. The corpus is flat, and each page appears once in `docs/manifest.json`.
- The size limits in `test/tau_docs_corpus.test.js` and `scripts/copy-tau-docs.js` are a last resort, and staying under them does not make an addition acceptable. Do not raise them unless the user asks.

<!-- agents:subagents:start -->

## Subagent model selection

When neither the user nor active instructions request a subagent model or reasoning effort, omit the model override so the subagent uses the same model and settings as you. A model allowlist alone is not a request to select a model.

When a model is requested without an effort, use its default below. When an effort is explicitly requested, preserve it. If the environment cannot select the requested combination, explain the limitation rather than silently substituting another model.

For Claude subagents, prefer the Claude Code models, which use subscription limits instead of paid API usage. Use the direct Anthropic API only when the user or active instructions ask for it, so a plain request for Sonnet, Opus, or Haiku means the Claude Code model. If Claude Code is unavailable or out of limits, say so instead of switching to the API.

- Luna: `openai-codex/gpt-6-luna`; allowed efforts: low, medium, high, xhigh; default: `medium`.
- Terra: `openai-codex/gpt-6.1-terra`; allowed efforts: low, medium, high; default: `medium`.
- Sol: `openai-codex/gpt-6.1-sol`; allowed efforts: low, medium, high; default: `medium`.
- Astra: `openai-codex/gpt-6-astra`; allowed efforts: low, medium, high; default: `low`.
- Sonnet: `anthropic/claude-sonnet-5-5`; allowed efforts: low, medium, high; default: `medium`.
- Claude Code Sonnet: `claude-code/claude-sonnet-5-5`; allowed efforts: low, medium, high; default: `medium`.
- Claude Code Opus: `claude-code/claude-opus-5-5`; allowed efforts: low, medium, high; default: `medium`.
- Claude Code Haiku: `claude-code/claude-haiku-5-5`; allowed efforts: low, medium, high; default: `medium`.
- Opus: `anthropic/claude-opus-5-5`; allowed efforts: low, medium, high; default: `medium`.

Sonnet, Claude Code Sonnet, Claude Code Opus, Claude Code Haiku, and Opus may be selected as model overrides only when explicitly requested by the user or active instructions. Do not select them on your own. This does not prevent inheriting the parent model when no override is requested.
<!-- agents:subagents:end -->
