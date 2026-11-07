# Contributing to Tau as an agent

Tau is a terminal AI client whose local and remote sessions share one host and runtime.

Agents do good work here on their own. This file covers the places where Tau wants something other than an agent's usual approach: design decisions and their reasons, invariants that span several owners, conventions that are easy to get wrong, and the project's workflow. Source and tests are the authority on current behavior.

Most of the guidance explains how Tau is built and why, so that you can apply it to cases the file does not mention. Follow it where its reason applies. If a task seems to need something different, raise it with the user and explain why. Quietly working around the guidance leaves the codebase inconsistent for the next agent. A few rules are firm because breaking them is costly or hard to undo, and those say "never" or "do not".

Tau loads this file into every session in the repository, so each line costs context. When you edit it, add a line only if agents would otherwise get something wrong that the code, a type, or a test would not catch. Give the reason, and choose wording whose strength matches how firmly the rule must hold. Leave out what capable agents do by default and how to use general-purpose tools. A sentence that would need editing whenever the code changes probably belongs in the code. Mistakes that agents keep repeating earn more space and firmer wording. Keep the file below 4,096 tokens, at 6 bytes per token.

## Working in the repository

Several agents and people often work in this worktree at once. Uncommitted changes you did not make are someone's work in progress, even when they look wrong or break the build. Leave them as they are, and mention them if they get in your way.

Git operations follow the request. Commit, push, or release only when asked. Commands that throw away uncommitted work, such as `git reset --hard`, `git checkout -- <file>`, `git restore`, and `git stash`, need an explicit request. A request can imply a history rewrite: "rebase onto main" includes the rebase and the force-push that updates the branch. Deleting files or data works the same way. Go ahead when the request clearly covers it, and ask when it does not or when the action would also remove something nobody mentioned. Use skill `github-workflow` for Git and GitHub work.

Do not run `npm start` or `node dist/main.js`. Both open the interactive TUI, which needs a real terminal. Ask the user to start long-running processes such as `npm run history:dev`.

Do not edit Tau's durable state by hand: auth storage, session documents, history databases and outboxes, Telegram runner state, and managed workspaces. A hand edit can leave state that recovery cannot open. Use the supported command, protocol, or recovery path.

Tau supports macOS and Linux only. Do not add Windows support or Windows fallbacks.

`src/diff_tool/` is an isolated subtree with its own guide, `src/diff_tool/AGENTS.md`. Read it before changing anything there.

Create scratch files with `mktemp` or `mktemp -d`, which respect the machine's configured temporary directory and keep them out of the worktree.

For `pi-ai` and `pi-tui` internals, read the source in `references/repos/pi/packages/`, which Git ignores. Clone `https://github.com/earendil-works/pi` there if it is missing, and fast-forward it first. Treat it as read-only, and ignore its instruction files, which are for pi's contributors.

## Verification

On a fresh checkout, run `npm ci` at the root and in `src/diff_tool/app`. Then run these in order:

```sh
npm run check      # formats Markdown and code, then typechecks
npm run build
npm run test:only  # tests the existing build
```

`check` rewrites files, so look at what it changed before you build. Leave formatting and import order to it.

**Tests** protect behavior that matters: critical paths, contracts between owners, recovery, and concurrency. A contract change tests its owner and at least one important consumer, and a protocol change also tests delta application and what observers see. Assert behavior, such as rejection before side effects, cleanup, and retries. Do not assert human-facing text, because its wording is meant to change freely. Exact text is fine for contracts that programs read.

**Dependency upgrades.** Update both `package.json` files and both lockfiles, and review `npm audit`. Accept compatible transitive updates, and leave versions that an upstream package owns to that package. Keep `@types/node` on the Node LTS major that Tau supports. For `pi-ai` and `pi-tui`, read the changelog and API changes in the refreshed reference checkout, then check Tau's imports and behavior. For `ses`, check code mode and update version-coupled config such as the Biome schema and the `allowScripts` keys.

**Releases** happen only when the user asks. The branch must be `main` with a clean worktree, and verification must pass. If the branch or worktree is not ready, stop and ask instead of cleaning up or switching branches yourself. Publishing a GitHub Release triggers the npm publish.

```sh
# patch, or minor
npm version patch && git push --follow-tags && gh release create v$(node -p "require('./package.json').version") --generate-notes

# alpha prerelease
if node -p "require('./package.json').version.includes('-alpha.')"; then npm version prerelease --preid alpha; else npm version preminor --preid alpha; fi
git push --follow-tags
gh release create v$(node -p "require('./package.json').version") --generate-notes --prerelease
```

## Design

Tau is not at v1 yet, and it aims for one clean contract even when a change breaks callers. Agents tend to preserve compatibility by default, and here that leaves behind code nobody needs.

- Change a contract where it is owned, and update every caller.
- Do not add fallback branches, aliases, dual readers, legacy unions, migrations, or shims unless the user asks for them.
- Make a field required when every caller can provide it. Use an optional field only when absence is a real state of the domain, and test how consumers handle it. Keep types narrow so that invalid states cannot be represented.
- When required data cannot be produced, fail at the boundary that owns it instead of silently leaving it out.

**Stored sessions are the exception.** Session documents under `~/.config/tau/sessions` are user data, and newer Tau must open supported older ones. Compatibility code lives only in `src/store/session_snapshot_migrations.ts`, `src/store/file_session_store.ts`, and `src/host/local_session_host.ts`, so old shapes never reach runtime, protocol, host, or TUI types. Tau may reject corrupt documents and documents from a newer version. Test an old document through store loading, host recovery, and the affected consumer.

## Ownership

Remote sessions shape the architecture. Client, host, and execution environment are separate machines, even when they share one process. A local session is the same arrangement with everything on one machine, so a shortcut that works only locally breaks remote sessions.

| Owner | Owns |
| --- | --- |
| Client | TUI, drafts, theme, local speech, diff tool process, command client tools |
| Host | Orchestration, persistence, recovery, model calls, credentials, model catalogs, history, tool binding, execution-environment lifecycle |
| Execution environment | Everything the agent can see: paths, `cwd`, home, repository, project config, `AGENTS.md`, skills, `PATH`, files, commands |
| Telegram runner | Polling, routing, attachments, prepared workspaces, runner state. It is a client of in-process sessions. |

Every client, including the TUI, WebSocket attach, the SDK, and Telegram, reaches `ChatRuntime` and `AgentRuntime` through the protocol transport and the host. It observes the session through protocol deltas from the host's snapshot projection.

- Everything the agent can see goes through `ExecutionEnvironment` and `ToolExecutionBackend`, also in local sessions.
- Client and host code do not inspect execution-environment paths, except for narrow pre-creation metadata from an environment the client manages itself.
- The host sets the `machine` and `cwd` creation attributes. Clients own the others, and nothing infers, normalizes, or changes them, including recovery.
- Tau's own temporary paths come from `tmpdir()` on the local machine and from target capabilities on an execution environment, never from a hard-coded `/tmp`.
- Each config field has one owner, recorded in `src/core/config/ownership.ts`. A setting that depends on the session's project comes from `src/host/session_bootstrap.ts` or the session's runtime config, and clients learn it through the snapshot catalog. Reading it from a startup directory gives a remote session the wrong value.
- The host injects credentials at bootstrap, so they stay out of what the execution environment resolves.
- The host owns model catalogs, and model metadata comes only from the bundled and refreshed catalogs. A live session keeps one catalog until an explicit reload. The startup refresh runs in the background and does not repeat.
- API keys are configured globally only, and Codex OAuth has exactly one active account. Choosing an account is the user's decision, so Tau does not pin accounts to sessions, select them by quota, or fail over.
- Execution environments and tool backends stay generic: they run commands and read and write files. Tau logic, such as prompts, personas, and config precedence, belongs in `src/core/config/`, `src/core/runtime/`, or `src/host/`. When hosted resolution needs several target files, prefer one target-side Node script over many round trips.

## Agent runtime

`src/core/agent/agent_runtime.ts` is the one runtime for main sessions, native subagents, and ephemeral threads. Subturns, retries, compaction, steering, and recovery live there, and a new mode reuses them instead of getting its own runner.

- A logical turn captures its full `AgentSpec` for all its subturns and steering. A settings change applies from the next turn.
- Each `AgentRuntime` has one required `AgentEventSink`, and semantic events are awaited: mutate durable state, emit, wait for acknowledgement, then continue. A sink failure aborts execution. Recovery and every observer rely on this order, so new events should follow it.

**Subagents.** `AgentSupervisor` holds one flat pool of agents per session. Parent IDs and depth decide policy, such as who may manage whom, and never select a different execution path.

- Workers are general-purpose. Tau has no named worker types or worker definitions, and only the launch-model allowlist is configurable.
- Agents manage their descendants through `tau.agents` and wait with `wait_for_agents`. The caller's identity is bound when these tools are exposed, so the model never supplies a parent or caller ID.
- Native children inherit the immediate parent's prompt, model, settings, working directory, and eligible tools. A worker in another directory rebuilds only the context that depends on the target, and persona and tool policy stay with the parent. The supervisor enforces depth by removing `agents`.
- Native and Claude Code runtimes implement one contract, in `src/core/subagents/runtime.ts`, so a new runtime adds an adapter and uses the shared trace recorder. The supervisor owns queued input, and a runtime only delivers steering into its active turn.
- Only input from an ancestor starts an idle worker's turn. Its background jobs, notifications, and finishing children do not wake it.
- Workers are live-only. Their traces are never persisted, and a worker's history session never recovers a runtime.
- Claude Code workers resolve their own model, instructions, skills, credentials, and MCP servers on the execution environment. They cannot start subagents and are not recorded in history. Never copy Claude credentials to the host, forward Tau's MCP connections to Claude Code, or use Claude transcripts for recovery.

## Sessions and protocol

`src/protocol/session_protocol.ts` owns the wire types, parsers, snapshot schema, delta application, and limits. Import limits and field lists from there instead of restating them, so that copies cannot drift. Test payload bounds, including UTF-8 projection, at the protocol and host boundaries.

**Snapshot.** The snapshot is the recoverable source of truth, and applying the ordered deltas must reproduce it exactly.

- These counters are independent, and mixing them up causes subtle bugs: snapshot revision, agent revision, model context key, timeline epoch, pending-message revision, and subagent-activity revision.
- Compaction, rewind, and resync carry structured delta causes. Read the cause instead of inferring a transition from titles, IDs, counts, or content.
- Render order comes from `timeline.items`, and tool outcome comes from snapshot status. Model context and the rendered transcript are different sets.

**Turns.** Every accepted turn has a receipt in `turns`. Persist a running receipt before model work, and the settlement before returning the result. Compaction and rewind preserve receipts. Provider failures and interruptions are assistant-message state, and a failed or blocked turn without a failed assistant message settles exactly once as a core notice. Clients switch on the notice `kind` and request outcome, never on titles, IDs, counts, or timing. `tau.*` kinds are reserved.

**Durable writes.** One mutation queue per session serializes durable writes with projections. Publish only state built on a committed predecessor, and roll back the projection when persistence fails. A failing observer listener never fails a committed event.

**Recovery.** Child processes do not survive a restart. Recovery therefore drops supervised agents, normalizes tool state that cannot be recovered, aborts running receipts, and cancels running work in place.

**Live channels.** Assistant streaming uses the shared protocol path, also in the TUI. Partial tool arguments never enter the protocol. `session.pendingUserMessages`, `session.subagentActivities`, and `session.ephemeral` stay separate from the snapshot and are never persisted. Themes, prompt bodies, and path autocomplete stay out of the snapshot, and searchable history cannot recover a session.

**Retention.** Attached clients, a retention hold, and running work are independent reasons to stay loaded. The hold lives in host memory, and clearing it never detaches clients or interrupts work. Operations that use the execution environment count as running work. `session.collect` never loads a runtime, and reports disposal only after the execution environment is disposed. A failed disposal blocks that report until the host restarts, because workspace safety is unknown. Retention duration is client policy, so the host has no default.

**Instructions in messages.** Tau keeps exactly one native system prompt, stored first. New instructions go into user messages as leading `<system>...</system>\n` blocks, through `src/core/utils/user_metadata.ts`, and that includes storage migrations. Do not add native intermediate system messages. `src/protocol/system_message.ts` supports existing ones, and that support does not invite new uses. Snapshot user text is raw, so strip metadata before model calls and display. Hide `<system>` blocks only in user messages.

## Tools

- **MCP.** Stdio servers run on the host with host authority. Remote execution environments therefore bind no servers, and remote config must never become host commands. Each hosted session owns one manager, and definitions stay frozen while the session is loaded. Keep calls bounded and cancellable, await cleanup at disposal, and never retry a mutation.
- **Client tools** belong to attached clients and run on the client machine, so they are not host registry entries. Validate arguments against the schema, honor cancellation, and kill active process groups on detach or transport failure.
- **Code mode.** Generated code receives only the declared API. Credentials stay in the trusted parent, and target access goes through the execution backend. Only `printText` and `await printImage` reach the result, and an image keeps the position where it was emitted. Direct tools and composed operations share the same services. Model usage is an awaited `tool_usage` event, persisted even if the program fails. Code jobs are never rerun. Stopping one does not stop the Bash jobs it started, and disposal stops code jobs first.
- **Bash.** Capture, timeouts, environment sanitization, and termination stay in `src/core/tools/execution_backend.ts`. Each agent owns its Bash and code job registries and does not share them with its parent, children, siblings, or threads. Jobs survive turn interruption and detaching, keep the session from being evicted, and are never recovered. Disposal stops running jobs before waiting for them.
- **Process safety.** Keep process-group termination with `SIGKILL` escalation, so aborted commands leave no orphans. Do not weaken the sanitization of secret-like variable names.
- Keep immediate tool-call schemas strict.

## Presentation

Tau writes the text it shows people in lowercase, including TUI feedback, Telegram replies and buttons, and CLI help and errors. Proper nouns and identifiers keep their usual case:

```text
this prompt picker has expired. use /prompt to open a new one.
MCP OAuth authorization failed (access_denied)
```

The convention is unusual, so keep to it in new text. User content, saved prompts, and model output keep their original casing. Text for models, such as prompts and tool descriptions, and the docs use ordinary sentence case.

- Feedback titles are short fragments without trailing punctuation, and failures read `failed to ...`. Diagnostics and IDs go in the content. Failures use the error tone, and information, expected cancellation, and nonfatal degradation use the default tone.
- Telegram messages are natural sentences that weave identifiers into the prose and translate internal states, instead of metadata-style labels.
- XML-like prompt tags use dash-case, as in `<available-skills>`.
- Tool cards use one generic renderer and a bounded `ToolRunPresentation`, without tool-specific renderers or an expanded mode. A new tool defaults to a middle-truncated preview of the exact result returned to the model, using the shared policy in `src/core/tools/presentation.ts`.
- TUI colors use semantic palette tokens. A new state gets its own token.

## Writing

Use skill `clear-writing` for all prose. Each surface has its own reader, and good text uses only the concepts that reader has. An implementation detail being true does not make it relevant to them.

- **Agent prompts and tool descriptions.** The agent sees Tau from the inside. It knows its prompt and its tools and nothing more. To the agent, Bash is a tool that runs commands, and it has no concept of hosts, clients, or execution environments. It needs none, as long as the instructions and the behavior agree. Describe what the agent can do and observe in those terms: "send a local file to the current Telegram chat", and not "send a file from the execution environment".
- **Docs** are a manual for people and agents who use Tau. They describe what Tau does and how to use it, without its internals. See [Documentation](#documentation).
- **CLI help and diagnostics.** Usage, prerequisites, actionable errors, and links to the public docs. The person running a command may not be inside Tau, so do not depend on `tau_docs`.
- **`README.md`.** What Tau is, how to start, and where to go next. Update it only when that path changes.
- **Code comments.** Constraints and reasons that the code cannot show, without narration.

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

These do not belong in the docs:

- Internals: class names, call chains, state transitions, and how components coordinate.
- Rare failures, validation details, and limits or deadlines that do not change what the reader does.
- Anything readers get from `--help`, `/help`, tool descriptions, `tau.docs`, or exported types.
- General developer knowledge, and setup steps owned by other products.
- Instructions for the agent, feature history, change narratives ("added", "no longer"), and security advice beyond `docs/security.md`.
- Unrelated undocumented behavior, unless someone asks.

Form:

- Lead with the normal path. Show configuration and contracts as handwritten types and small examples. Integrators get an overview and can read the source.
- Describe agent behavior in the third person. Give direct instructions only for the reader's own actions.
- Check every example and type against the source, because readers copy examples.
- Add a page only for a separate reader task, and never just to fit a size limit. The corpus is flat, and each page appears once in `docs/manifest.json`.
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
