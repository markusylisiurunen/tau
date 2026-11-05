# Contributing to Tau as an agent

Tau is a terminal AI client. Local and remote sessions share one host and runtime.

This file tells agents working on Tau what they could not learn from the code and would get wrong without being told: intent, invariants that span owners, prohibitions the compiler does not enforce, taste, and workflow. Source and tests are the authority on current behavior and win over this file. `docs/*.md` is the public product manual.

Tau loads this file into every session in the repository, so each line costs context even in sessions that never touch its subject. Before adding a line, ask what an agent would get wrong without it, and whether the code, a test, or a type would catch the mistake anyway. If they would, or the answer is unclear, leave the line out. Keep the whole file below 4,096 tokens, at 6 bytes per token.

Mistakes that AI agents keep making earn more space and blunter wording, even when the rule looks obvious. Documentation is the clearest example: agents tend to add text with every change, relevant or not, so [Documentation](#documentation) is strict and explicit on purpose.

## Hard rules

- **Shared, dirty worktree.** Existing changes are intentional. Never revert, overwrite, reformat, or "fix" unrelated work. Read a file right before editing it. If it changes between your read and write, stop and ask.
- **Do only the requested change.** No surrounding cleanup, speculative config, or speculative abstractions. Match local naming, structure, error handling, and test style.
- **Keep the docs short.** A behavior change does not by itself justify new docs text. Follow [Documentation](#documentation).
- **No commits, releases, or work-destroying git commands** unless the user explicitly asks for that exact operation. That includes `git reset --hard`, `git checkout -- <file>`, `git restore`, `git stash`, rebase, cherry-pick, and force-push.
- **Confirm before destructive operations** such as deleting files or dropping data.
- **Never run `npm start` or `node dist/main.js`.** They need a real terminal. Ask the user to start long-running servers such as `npm run history:dev`.
- **Never edit durable Tau state directly:** auth storage, session documents, history databases and outboxes, Telegram runner state, or managed workspaces. Use the supported command, protocol, or recovery path.
- **Never print credentials,** full environments, auth stores, or credential-bearing config.
- **macOS and Linux only.** Never add Windows support or a Windows fallback.
- **Nested guides are mandatory.** `src/diff_tool/AGENTS.md` adds rules for that isolated subtree, which shares only narrow protocol types with core.

## Design

Before v1, optimize for one clean contract, even when the change is breaking.

- Change a contract at its owner and update every caller.
- Add no fallback branches, aliases, dual readers, legacy unions, migrations, or shims unless the user asks.
- Make a field required when every caller can provide it. Use optionality only when absence is a real domain state, and test how consumers handle it. Keep types narrow so invalid states are unrepresentable.
- When required data cannot be produced, fail at the owning boundary. Never silently omit it.

**Stored sessions are the one exception.** Newer Tau must open supported older documents under `~/.config/tau/sessions`. This covers conversation and session data, not identical bytes or rendering. Compatibility code lives only in `src/store/session_snapshot_migrations.ts`, `src/store/file_session_store.ts`, and `src/host/local_session_host.ts`, and old shapes never reach runtime, protocol, host, or TUI types. Test an old document through store loading, host recovery, and the affected consumer.

## Ownership

A request flows from client to SDK session facade, protocol transport, host, `ChatRuntime`, and `AgentRuntime`. Events return through the host's snapshot projection as protocol deltas to every observer. The TUI, WebSocket attach, SDK, and Telegram all use this one path.

Client, host, and execution environment are separate machines, even in one process:

| Owner | Owns |
| --- | --- |
| Client | TUI, drafts, theme, local speech, diff tool process, command client tools |
| Host | Orchestration, persistence, recovery, model calls, credentials, model catalogs, history, tool binding, execution-environment lifecycle |
| Execution environment | Everything agent-visible: paths, `cwd`, home, repository, project config, `AGENTS.md`, skills, `PATH`, files, commands |
| Telegram runner | Polling, routing, attachments, prepared workspaces, runner state. It is a client of in-process sessions. |

- Every agent-visible access goes through `ExecutionEnvironment` and `ToolExecutionBackend`, even locally. Co-location never justifies a filesystem shortcut.
- Client and host code do not inspect execution-environment paths, except narrow pre-creation metadata from an environment a client manages directly.
- The host sets the `machine` and `cwd` attributes. Clients own all other creation attributes. Nothing infers or normalizes them, and recovery never changes them.
- Local temp paths come from `tmpdir()`, never a hard-coded `/tmp`. Target temp paths come from target capabilities.
- Each config field has one owner in `src/core/config/ownership.ts`. Never read a session-owned setting from a startup directory: it comes from `src/host/session_bootstrap.ts` or the session's runtime config, and clients learn it through the snapshot catalog. Credentials stay out of what the execution environment resolves.
- The host owns model catalogs. A live session keeps one catalog until explicit reload. Startup refresh is async and never a recurring timer.
- API-key config is global-only. Codex OAuth has one active account. Do not add session pinning, quota-based selection, or failover.
- Execution environments and tool backends stay generic: run commands, read and write files. Tau logic belongs in `src/core/config/`, `src/core/runtime/`, or `src/host/`. When hosted resolution needs several target files, prefer one target-side Node script over many round trips.
- Telegram workspaces are prepared once per session and preserved across runner restarts.

## Agent runtime

`src/core/agent/agent_runtime.ts` is the single runtime for main sessions, native subagents, and ephemeral threads. Never fork subturns, retries, compaction, steering, or recovery into a mode-specific runner.

- A logical turn captures its full `AgentSpec` for all its subturns and steering. Settings changes apply to the next turn.
- Every `AgentRuntime` has one required, awaited `AgentEventSink`. Mutate durable state, emit, await acknowledgement, then continue. Sink failure aborts execution. Never add fire-and-forget semantic events.
- `model_sampler.ts` is stateless. Never couple it to the active persona.

**Subagents.** `AgentSupervisor` holds one flat pool per session. Parent IDs and depth select policy, never a separate execution path.

- Workers are general-purpose. Do not add named worker types or configurable definitions. Only the launch-model allowlist is configurable.
- Having the `agents` tool does not authorize delegation. The assignment or active instructions must ask for it.
- Agents manage descendants only through `tau.agents` and `wait_for_agents`. Do not add other management tools. Never accept a parent or caller ID from the model.
- Children inherit the immediate parent's prompt, model, settings, working directory, and eligible tools. The supervisor enforces depth by removing `agents`. A worker in another directory rebuilds only target-dependent context, and persona and tool policy stay with the parent.
- Interruption targets one agent unless the caller selects its subtree. Waits cover only the requested agents. Rewind removes a whole branch.
- Native and Claude Code runtimes implement one contract (`src/core/subagents/runtime.ts`). A new runtime adds an adapter, never its own trace store. The supervisor owns queued input, and each runtime only delivers steering into its active turn. A turn settles only after every event is acknowledged and every steering delivery has finished, and unapplied steering returns with the settlement instead of being retried.
- Only input from an ancestor starts an idle worker's turn. Background jobs, notifications, and finishing children never wake it.
- Workers are live-only. Traces are never persisted, and a worker's history session never recovers a runtime. Claude Code workers are never recorded in history and cannot start subagents.
- Never copy Claude credentials to the host, forward Tau's MCP connections to Claude Code, or use Claude transcripts for recovery.

## Sessions and protocol

`src/protocol/session_protocol.ts` owns wire types, parsers, the snapshot schema, delta application, and limits. Never copy limits or field lists elsewhere. Protocol changes test delta application and observer behavior, not just parsing.

**Snapshot.** It is the recoverable source of truth, and ordered deltas must reproduce it exactly.

- Never mix these independent counters: snapshot revision, agent revision, model context key, timeline epoch, pending-message revision, subagent-activity revision.
- Compaction, rewind, and resync use structured delta causes. Never infer a transition from titles, IDs, counts, or content.
- Render order comes from `timeline.items`, and tool outcome comes from snapshot status. Model context and rendered transcript are different sets.
- Successful compaction increments the epoch exactly once. Rewind never lowers the sequence high-water mark or reuses a sequence number.

**Turns.** Every accepted turn has a receipt in `turns`. Persist a running receipt before model work and the settlement before returning the result. Compaction and rewind preserve receipts. Provider failures and interruptions are assistant-message state, and a failed or blocked turn without a failed assistant message settles exactly once as a core notice. Clients switch on notice `kind` and request outcome, never on titles or timing. `tau.*` kinds are reserved.

**Durable writes.** One per-session mutation queue serializes durable writes with projections. Publish only state built on a committed predecessor, and roll back the projection when persistence fails. An observer-listener failure never fails a committed event.

**Recovery.** Child processes do not survive a restart. Recovery drops supervised agents, normalizes unrecoverable tool state, aborts running receipts, and cancels running work in place.

**Live channels.** Assistant streaming uses the shared protocol path, with no TUI shortcut. Partial tool arguments never enter the protocol. `session.pendingUserMessages`, `session.subagentActivities`, and `session.ephemeral` stay separate from the snapshot and are never persisted. Themes, prompt bodies, and path autocomplete do not belong in the snapshot, and searchable history cannot recover a session.

**Retention.** Attached clients, a retention hold, and running work are independent reasons to stay loaded. The hold lives in host memory. Clearing it never detaches clients or interrupts work. `session.collect` never loads a runtime, and reports disposal only after execution-environment disposal has finished. A failed disposal blocks that report until the host restarts, because workspace safety is unknown. Operations that use the execution environment count as running work. Retention duration is client policy, so add no host default.

**Instructions in messages.** Keep exactly one native system prompt, stored first. Inject new instructions as leading `<system>...</system>\n` blocks in user messages through `src/core/utils/user_metadata.ts`, and never add native intermediate system messages. Support for existing ones in `src/protocol/system_message.ts` does not authorize new uses. Snapshot user text is raw, so strip metadata before model calls and display. Hide `<system>` blocks only in user messages.

## Tools

The inventory lives in `src/core/tools/catalog.ts`, `registry.ts`, and `tool_names.ts`.

- **MCP.** Stdio servers run on the host with host authority, so remote execution environments bind no servers, and remote config must never become host commands. Each hosted session owns one manager. Definitions stay frozen while a session is loaded. Keep calls bounded and cancellable, await cleanup at disposal, and never retry mutations.
- **Client tools** belong to attached clients and are not host registry entries. Names are unique among observers. Validate arguments against the schema, honor cancellation, and kill active process groups on detach or transport failure.
- **Code mode.** Generated code receives only the declared API. Credentials stay in the trusted parent. Target access goes through the execution backend. Only `printText` and `await printImage` reach the result, and an image keeps the position where it was emitted. Direct tools and composed operations share the same services. Model usage is an awaited `tool_usage` event, persisted even if the program fails. Stopping a code job does not stop Bash jobs it started, and disposal stops code jobs first.
- **Bash.** Capture, timeout, env sanitization, and termination stay centralized in `src/core/tools/execution_backend.ts`. Each agent owns its job registries, so never share them with a parent, child, sibling, or thread. Jobs survive turn interruption and detaching, prevent session eviction, and are never recovered. Disposal stops running jobs before waiting for them.
- **Process safety.** Preserve process-group termination with `SIGKILL` escalation. Do not weaken env sanitization of secret-like names.
- Keep immediate tool-call schemas strict.

## Presentation

- XML-like prompt tags use dash-case: `<available-skills>`.
- Feedback titles are lowercase fragments with no trailing punctuation, and failures read `failed to ...`.
- Tool cards use one generic renderer and a bounded `ToolRunPresentation`, with no tool-specific renderers or expanded mode. New tools default to a middle-truncated preview of the exact result returned to the model, using the shared policy in `src/core/tools/presentation.ts`.
- Missing or historical presentation degrades to tool name, status, and text result without revealing stored arguments. Malformed current-version presentation fails validation.
- TUI colors use semantic palette tokens. Add a new token for a new state.
- Telegram text is natural lowercase sentences, never metadata-style labels. Never change the casing of user content or model output.

## Workflow

- **Start** with the smallest owning area, its callers, and its tests.
- **Search.** Use `rg`, never `grep`, and `fd`, not `find`. Write `fd -e ts --search-path src`, because a lone path argument is treated as a pattern. Use absolute paths and the runner's `workingDirectory` instead of `cd`, and leave output caps unset unless output was truncated.
- **Dependencies.** Never read `node_modules` unless asked. For `pi-ai` and `pi-tui`, use the read-only checkout in `references/repos/pi/packages/`. Clone it if missing, fast-forward it first, and ignore its instruction files.
- **Delegation.** Spawn subagents only when the user or active instructions ask. Use an explicit skill only when named by `@@skill:<name>`, active instructions, or an active skill.
- **Temporary files.** Use `mktemp` or `mktemp -d`, never paths in the worktree.
- **Style.** Biome formats. Do not hand-sort imports or hand-wrap. Use `PascalCase` types, `camelCase` values, and lowercase filenames.
- **Tests.** Protect critical paths, cross-boundary contracts, recovery, and concurrency. A contract change tests the owner and at least one important consumer. Never assert human-facing prose. Assert behavior, such as rejection before side effects, cleanup, and retries.
- **Git and GitHub.** Use skill `github-workflow`.

**Verification.** After `npm ci` at the root and in `src/diff_tool/app`, run these in order, and inspect what `check` reformatted. `test:only` needs an up-to-date build:

```sh
npm run check
npm run build
npm run test:only
```

**Dependency upgrades.** Update both `package.json` files and both lockfiles, and review `npm audit`. Keep `@types/node` on the supported Node LTS major. For `pi-ai` and `pi-tui`, read the changelog and API changes in the refreshed checkout, then verify imports and behavior. For `ses`, verify code mode and update version-coupled config such as the Biome schema and `allowScripts`.

**Releases.** Only when the user explicitly asks. The branch must be `main` with a clean worktree, and verification must pass. If not, stop and ask. A published GitHub Release triggers npm publishing.

```sh
# patch, or minor
npm version patch && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes

# alpha prerelease
if node -p "require('./package.json').version.includes('-alpha.')"; then npm version prerelease --preid alpha; else npm version preminor --preid alpha; fi
git push --follow-tags
gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease
```

## Writing

Use skill `clear-writing` for all prose. Identify the reader first, and use only concepts that reader has. An implementation fact being true does not make it relevant.

- **Agent prompts and tool descriptions:** what the agent can do and observe. Write "send a local file to the current Telegram chat", not "from the execution environment".
- **CLI help and diagnostics:** usage, prerequisites, actionable errors, and public doc links. Never depend on `tau_docs`.
- **`README.md`:** what Tau is, how to start, and where to go next. Update it only when that path changes.
- **Code comments:** non-obvious constraints and reasons, never narration.

## Documentation

`docs/` is the version-matched manual for people and agents who use, operate, configure, or integrate Tau. It is short on purpose. It once grew past 70,000 estimated tokens because each change added its own details, and agents load a whole page with each read. Agents tend to repeat this: they add a paragraph for every change and call it thoroughness. Hold every change and every review to these rules.

**The default is no docs change.** Most bug fixes and internal changes need none. A new slash command rarely needs one, because `/help` lists it.

When behavior changes:

1. Correct anything in the docs that has become wrong. Wrong docs are never acceptable.
2. Add text only if a reader would otherwise fail a task, choose wrongly, or make a consequential mistake. Ask what the reader would do differently without the passage. If the answer is unclear, leave it out.
3. Describe a new feature briefly: what it is for, how to use it, and limits that could change the reader's approach.
4. Give each rule one home, and link to it from other pages.
5. Prefer replacing text over adding it. When a page grows, cut something.

A question the docs do not answer is not by itself a reason to add text. Check reports from people and agents against the source, then apply the same test.

Never add:

- Internals: class names, call chains, state transitions, and how components coordinate.
- Rare failures, validation details, and limits or deadlines that do not change what the reader does.
- Anything readers get from `--help`, `/help`, tool descriptions, `tau.docs`, or exported types.
- General developer knowledge, and setup steps owned by other products.
- Instructions for the agent, feature history, change narratives ("added", "no longer"), or security advice beyond `docs/security.md`.
- Unrelated undocumented behavior, unless someone asks.

Form:

- Lead with the normal path. Show configuration and contracts as handwritten types and small examples. Integrators get an overview and can read the source.
- Describe agent behavior in the third person. Give direct instructions only for the reader's own actions.
- Check every example and type against the source, because examples get copied.
- Add a page only for a separate reader task, never to fit a size limit. The corpus is flat, and each page appears once in `docs/manifest.json`.
- The limits in `test/tau_docs_corpus.test.js` and `scripts/copy-tau-docs.js` are a last resort. Staying under them does not make an addition acceptable. Do not raise them unless the user asks.

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
