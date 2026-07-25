---
name: "deslop-patterns"
description: "Apply Tau-specific architecture and contract-alignment patterns during deslop cleanup, using AGENTS.md as the source of truth for repository policy and conventions. Use only alongside the deslop skill in the Tau repository. Trigger: explicit."
---

# Tau deslop patterns

Use these patterns alongside `deslop`. Treat `AGENTS.md` as the source of truth for Tau's canonical change policy, architecture and execution boundaries, repository conventions, dependency inspection rules, and verification commands.

If the user provides a trigger phrase such as "ack when you are done," acknowledge and stop until they follow up.

## Apply repository policy

Use the ownership map and canonical change policy in `AGENTS.md` as cleanup criteria, not background context. When the target violates them, update the complete contract and its callers rather than adding another representation, fallback, or local shortcut. When new behavior does not fit an existing boundary, reshape the owning abstraction instead of creating a second path.

When release or persisted-state compatibility is genuinely unclear, ask once whether the behavior shipped or data must survive. Without evidence of a compatibility requirement, simplify to the canonical shape.

## Contract alignment

Hunt Tau-specific drift across:

- protocol DTOs, constructors, strict parsers, transports, host handlers, and SDK facades
- snapshot state, deltas, persistence, recovery, and client view models
- core events, tool metadata, tool registries, tool UI models, prompts, and documentation
- config schema, precedence, virtual defaults, loaders, and execution-environment snapshots
- model catalog metadata, persona settings, reasoning levels, and provider adapters
- truncation limits, token budgets, metadata descriptions, and the prompts that tell agents about them

Parser and serializer behavior must be symmetric. Streaming and recovery must preserve one snapshot-owned source of truth. Do not hide protocol drift behind optional fields or permissive parsers.

## Tau regression surfaces

Within the testing guidance in `deslop` and `AGENTS.md`, prioritize meaningful coverage for protocol reconstruction, streaming, interruption, persistence, recovery, execution boundaries, hosted/local parity, tool dispatch, sandboxing, and other regression-prone behavior. Simple rendering does not need dedicated tests unless it protects a non-obvious invariant.
