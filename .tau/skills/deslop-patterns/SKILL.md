---
name: "deslop-patterns"
description: "Apply Tau-specific canonical-contract, ownership-boundary, protocol-alignment, and regression patterns during deslop cleanup. Use only alongside the deslop skill in the Tau repository. Trigger: explicit."
---

# Tau deslop patterns

Use these patterns alongside `deslop`.

## Canonical Tau contracts

Tau is pre-v1. Treat compatibility scaffolding for unshipped behavior as slop and converge on one explicit contract.

- Make fields, options, attributes, and methods required when callers can provide them. Optionality must represent a real absent state.
- Update every caller when a contract changes. Remove fallback branches, aliases, legacy shapes, dual readers, and migrations that have no shipped data or external compatibility requirement.
- Validate and normalize at the owning boundary, then trust the canonical internal representation.
- Fail fast when a required value cannot be produced instead of silently omitting, defaulting, or coercing it.
- When release or persisted-state compatibility is genuinely unclear, ask once whether the behavior shipped or data must survive. Without evidence of a compatibility requirement, simplify to the canonical shape.

## Ownership-boundary slop

Flag code that creates a second owner or bypasses an existing boundary:

- TUI/client or host code inspecting agent-visible files and processes instead of using the execution environment
- Tau-specific config, prompt, resource, or session semantics placed in generic execution backends
- local-only behavior that bypasses the session protocol used by SDK, RPC, WebSocket, TUI, Telegram, or diff-review paths
- session state reconstructed from parallel caches instead of the snapshot and its canonical deltas
- transport mechanics mixed with session lifecycle, persistence, runtime orchestration, or presentation concerns
- built-in diff-tool implementation details shared outside the narrow diff-review protocol

Move behavior to its single owning layer. When new behavior does not fit cleanly, reshape that abstraction instead of adding another path.

## Contract alignment

Hunt Tau-specific drift across:

- protocol DTOs, constructors, strict parsers, transports, host handlers, and SDK facades
- snapshot state, deltas, persistence, recovery, and client view models
- core events, tool metadata, tool registries, tool UI models, and prompts
- config schema, precedence, virtual defaults, loaders, and execution-environment snapshots
- model catalog metadata, persona settings, reasoning levels, and provider adapters
- truncation limits, token budgets, metadata descriptions, and the prompts that tell agents about them

Parser and serializer behavior must be symmetric. Streaming and recovery must preserve one snapshot-owned source of truth. Do not hide protocol drift behind optional fields, permissive parsers, duplicate state, or client-specific shortcuts.

## Tau regression surfaces

Keep tests when they protect protocol reconstruction, streaming, interruption, persistence, recovery, execution boundaries, hosted/local parity, tool dispatch, sandboxing, or another non-obvious invariant. Delete tests for simple rendering, visible literals, and direct delegation when stronger coverage already protects the behavior.
