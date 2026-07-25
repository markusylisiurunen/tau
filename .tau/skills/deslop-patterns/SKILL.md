---
name: "deslop-patterns"
description: "Apply Tau-specific pre-v1 canonical-change, architecture, protocol, execution-boundary, compatibility, and verification patterns during deslop cleanup. Use only alongside the deslop skill in the Tau repository. Trigger: explicit."
---

# Tau deslop patterns

Use these patterns alongside `deslop` and `AGENTS.md`.

If the user provides a trigger phrase such as "ack when you are done," acknowledge and stop until they follow up.

## Canonical change policy

Tau is pre-v1 and prioritizes a clean stable v1 design over backward compatibility. Prefer one explicit canonical contract even when the change is breaking.

- Make new fields, options, attributes, and methods required when callers can provide them. Optionality must represent a real absent state with documented behavior.
- Update every caller when a contract changes. Do not add fallback branches, aliases, legacy shapes, dual readers, or migrations for unshipped state unless explicitly requested.
- Fail fast at the owning boundary when a required value cannot be produced.
- When release or persisted-state compatibility is genuinely unclear, ask once whether the behavior shipped or data must survive. Without evidence of a compatibility requirement, simplify to the canonical shape.

## Architecture boundaries

Preserve the detailed ownership map in `AGENTS.md`. The highest-risk boundaries are:

- TUI/client, host, and execution environment are separate logical machines. Agent-visible files and processes must go through the execution environment, even when physically local.
- `CoreSession` owns session state and core events; `SessionEngine` owns internal streaming and tool dispatch; runtime modules own prompt composition and turn orchestration.
- `src/protocol/` is the canonical session wire contract shared by transports, hosts, and SDK clients.
- `src/transport/` owns transport mechanics; `src/host/` owns session lifecycle and protocol handling; `src/store/` owns persisted snapshots.
- Execution backends expose generic target capabilities only. Tau-specific config, prompt, resource, and session semantics belong above them.
- SDK, RPC, WebSocket, TUI, Telegram, and diff-review paths must share canonical protocol behavior rather than local shortcuts.
- The built-in diff tool is an isolated reference implementation. Share narrow protocol types, not app implementation details.

When a feature does not fit these boundaries, reshape the owning abstraction instead of adding a second path.

## Contract alignment

Hunt Tau-specific drift across:

- protocol DTOs, constructors, strict parsers, transports, host handlers, and SDK facades
- snapshot state, deltas, persistence, recovery, and client view models
- core events, tool metadata, tool registries, tool UI models, prompts, and documentation
- config schema, precedence, virtual defaults, loaders, and execution-environment snapshots
- model catalog metadata, persona settings, reasoning levels, and provider adapters
- truncation limits, token budgets, metadata descriptions, and the prompts that tell agents about them

Parser and serializer behavior must be symmetric. Streaming and recovery must preserve one snapshot-owned source of truth. Do not hide protocol drift behind optional fields or permissive parsers.

## Repository conventions

Use TypeScript, strict types, Biome formatting, lowercase filenames, semantic UI theme tokens, and established event and error patterns. Prefer required contracts and exhaustive branches. Keep Windows unsupported unless product policy changes.

Do not inspect `node_modules`; use refreshed read-only checkouts under `references/repos/` for dependency internals. Do not run the interactive app.

## Tests and verification

Keep tests for protocol reconstruction, streaming, interruption, persistence, recovery, execution boundaries, hosted/local parity, tool dispatch, sandboxing, and other regression-prone behavior. Avoid low-value tests for visible literals, direct delegation, or simple rendering.

Start with formatting and type checking, then build and test:

```sh
npm run check
npm run build
npm test
```

Fresh clones may require `npm ci` in `src/diff_tool/app`. Never run `npm start` or `node dist/main.js`.
