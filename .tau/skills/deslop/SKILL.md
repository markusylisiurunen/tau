---
name: "deslop"
description: "Clean up, canonicalize, and tighten a specified target (often a branch of PR work from a junior or AI agent, but also a package, the current changes, or any other bounded slice), refactoring freely within the target when that raises overall quality. Trigger: explicit."
---

## Goal

Assume the code in your target was written by an inexperienced junior (human or AI). It passes its existing checks. It solves the original problem. But it carries the telltale weight of whoever reached for the first thing that worked: inputs that are optional only for convenience, parsers that accept multiple shapes, defensive wrappers, narrative comments, low-value tests, compatibility shims for behavior that never shipped, and runtime checks that paper over weak contracts.

Your job is to read it critically and tighten it. Leave the codebase strictly better than you found it: stronger contracts, one canonical representation for each concept, clear ownership of validation and normalization, no redundant plumbing, and tests that genuinely earn their keep.

Sloppy cleanup accumulates more debt than the original slop. Understand first, then cut.

## Mindset

- **Assume flaws.** Every function, type or schema, test, and comment is on trial. Default to removing before keeping; every optional input, fallback, helper, comment, and test needs to justify its existence.
- **Respect repository maturity.** Prefer the clean canonical contract over compatibility scaffolding for unreleased behavior. Preserve compatibility when existing data, deployments, or external clients require it.
- **Respect the repository architecture.** Keep established module and ownership boundaries clean. If new code twists around an existing boundary, consider whether the boundary should move.
- **Review at every level of abstraction.** Start wide (architecture, module boundaries, shared abstractions), then narrow (functions, contracts, expressions). Each level has its own slop, and architectural drift is usually the highest-leverage thing to fix.
- **Reshape abstractions when new code does not fit.** Sometimes the target adds something that cannot sit cleanly inside existing patterns. Do not contort the new code to fit; evolve the patterns until the new code fits naturally. This takes more thought and more edits than local cleanup, and the end result is dramatically better. It is often the single most valuable thing you can do.
- **Scope is flexible.** The target is the starting point, not a fence. If a larger refactor inside the touched area makes the overall codebase meaningfully better, do it. If you spot a real bug adjacent to your changes, fix it and call it out.
- **One way to do a thing.** When two shapes, two parsers, or two code paths exist for the same concept, collapse to one. Pick the cleaner one and delete the other.
- **Validate at the edge; trust internals.** Normalize and reject at the system boundary. Downstream code takes well-formed values and uses them. Stop re-validating, re-parsing, and re-defaulting at every layer.
- **Make contracts explicit.** Absence must represent a real domain state, not convenience. If callers should always make a choice, require it. Use the strongest guarantees available in the target language and project.
- **Simple beats clever.** Dumb, direct, obvious code wins over elegant abstractions. If you can delete an indirection, delete it. Optimize for clarity, never for the amount of code you had to edit.
- **Defensive code is noise.** Guards against impossible states, checks for inputs callers never produce, and catch-alls that swallow real errors clutter code without adding safety. Delete them or strengthen the boundary that should make them unnecessary.
- **Match the codebase.** Read surrounding code. Follow existing naming, structure, style, tooling, and error patterns. "Cleaner" does not mean "my preferred style"; it means closer to the repository's established conventions.

## Workflow

Complete each phase before moving on.

### Phase 1: Understand

A repository may provide an optional companion skill named `deslop-patterns` with product, maturity, architecture, ownership, compatibility, and verification context.

1. Know the target. The invoking prompt names it (a branch, a package, a set of changes, a file tree) and tells you how to enumerate it. Resolve the concrete files and interfaces that belong to the target before anything else.
2. If you can see a `deslop-patterns` skill, activate `@@skill:deslop-patterns` and use it alongside this skill. Continue without it when unavailable.
3. Read `AGENTS.md` files that cover the target. Respect project-specific conventions.
4. Load [`references/typescript.md`](references/typescript.md) when the target contains TypeScript or JavaScript. Load [`references/go.md`](references/go.md) when it contains Go. Load both for a mixed target. For other languages, use this skill and the project's established patterns without forcing guidance from an unrelated language.
5. Read the target's files to build up your understanding, not just the pieces you plan to edit. Follow call sites, related contracts, and tests.
6. Form a mental model of what the code does end-to-end and what the changes' intent is. Do not start editing until you could describe it without re-reading the source.

### Phase 2: Hunt slop

Scan at every level of abstraction. Start wide: does the architecture still hold with the new changes, are module and package boundaries sensible, do the existing abstractions still carry the new code cleanly? Then narrow into functions, contracts, and expressions. Treat the catalog below and the language references as starting points, not checklists, and bring your own architectural questions.

For each instance, decide: remove, collapse, refactor, simplify, or leave. Prefer remove and collapse; prefer reshaping an abstraction over working around it.

Additional signals worth noticing, among others:

- **Abstractions that no longer fit.** New code twists around an existing pattern or duplicates logic that an abstraction was meant to centralize. The pattern may be what needs to change.
- **Module or package boundaries in the wrong place.** Two modules own pieces of one concept, or one module owns unrelated responsibilities.
- **Real bugs** present in or exposed by the target, such as cleanup affecting the wrong resource, swallowed errors, missing authorization or tenant scoping, races, and boundary errors.
- **Redundant plumbing** carrying the same fact across several layers when one owner would do.
- **Inputs that are optional only for convenience.** Every caller supplies a value, or absence has no defined meaning.
- **Dual representations** of the same concept that have drifted apart.
- **Runtime branching on shape** that a stronger contract should eliminate.
- **Contract drift** across domain models, public interfaces, persisted formats, transport shapes, view models, prompts, and documentation.
- **Hidden budgets, truncation, or parser rules** that can fail at runtime without being represented in prompts, tests, and metadata contracts.
- **Defensive code for states the system already forbids.**

### Phase 3: Execute

Make the changes. Stay incremental: prefer a series of focused edits over one sprawling rewrite. After each meaningful change, re-read the surrounding code to confirm you have not broken a contract.

When cleanup requires changes outside the original target (for example, tightening a shared contract forces call-site updates elsewhere), do them. The goal is a consistent codebase, not a minimized edit count.

When compatibility versus simplicity is genuinely a judgment call, inspect `deslop-patterns`, repository guidance, issue and pull request context, release history, and source for evidence that existing data or contracts must be preserved. Ask the user only when the workflow allows interaction and the answer cannot be established from the available context.

### Phase 4: Verify

Follow the Verification section below. Do not skip checks, and do not rationalize failures as "unrelated." Any failure you introduced or uncovered is yours to fix.

## Slop patterns

Hunt these aggressively. The language references show concrete forms.

### Fallback parsing and multi-shape readers

If the canonical shape is known, parse only that shape and reject anything else. Migrate or reset old data instead of accepting obsolete forms forever when compatibility is not required.

### Fake optionality and implicit defaults

Require values that every caller supplies. Make meaningful absence explicit. Remove defaults that merely hide forgotten call sites or weak contracts.

### Defensive serialization

Construct the canonical output directly. Do not conditionally omit required values or spread fields only when truthy when the contract already determines their presence.

### Defensive code for impossible states

Delete guards against states that validated inputs, static contracts, or construction rules already prohibit. If the state is possible, fix the contract or validation boundary instead of silently returning.

### Duplicated representations

Collapse duplicate models where ownership allows it. When layers genuinely need different representations, make their transformation explicit and keep serialization and parsing symmetric.

### Thin indirection

Inline helpers, wrappers, interfaces, and adapters that have one trivial caller and enforce no meaningful invariant. Keep an abstraction when it owns complexity, defines a real boundary, or has multiple genuine implementations.

### Narrative comments

Delete comments that narrate fallback logic, obvious control flow, or historical implementation steps. Keep comments for non-obvious invariants, external constraints, or context the code cannot express.

### Silently accepting unexpected input

Reject unknown fields, unsupported forms, and invalid combinations at the owning boundary. Do not ignore or coerce input merely to keep execution moving.

### Configuration without a real choice

If every caller supplies the same value, remove the option. If a default is never deliberately overridden, it is not a useful default.

### Compatibility scaffolding without compatibility requirements

Remove migrations, dual reads, deployment-skew guards, and legacy aliases when no shipped data, external consumer, or independent deployment requires them. Preserve them when project context establishes a real compatibility contract.

### Tests that restate implementation

Delete tests that only repeat a return literal, validation string, trivial delegation, or behavior already covered at a stronger boundary. Preserve the only test protecting a meaningful regression.

### Over-broad error handling

Do not turn specific failures into generic success, empty values, or vague errors. Handle only failures the current layer owns and preserve useful context for the caller.

### Vestigial state

Remove fields, parameters, variants, branches, and helpers that are always empty, zero-valued, unreachable, or ignored. Delete the entire dead path, including tests.

## Cleanup principles

### Evolve abstractions when new code does not fit

The highest-leverage cleanup is usually not a local edit. When the target duplicates logic an abstraction was meant to centralize, forces awkward branching in a shared helper, or crosses a boundary drawn in the wrong place, the existing pattern may need to change.

Understand why the pattern exists and what constraint has shifted. When a better shape becomes clear, make the change: split or merge modules, rename concepts, redraw boundaries, or replace the abstraction. A larger coherent diff is better than a small workaround that leaves the design worse.

### Validation ownership

Every external value has one owning boundary where it is validated and normalized. Downstream code trusts the validated representation. Push repeated parsing, defaulting, trimming, type checks, and length checks to that boundary and delete duplicates.

### Canonical shapes

Each concept has one authoritative representation per necessary boundary. Serializer and parser behavior should be symmetric. If the serializer always writes a field, the matching parser should require it. If multiple layers need different representations, define the transformation explicitly.

### Derive, don't duplicate

If one value can be computed reliably from canonical data, do not carry both through every layer. Derive it at the owner or consumer unless performance, consistency, or compatibility requirements justify materializing it.

### Explicit contracts beat runtime defaults

Use the language's type system, schemas, constructors, parsers, and validation tools to make invalid states difficult or impossible to represent. Do not weaken a contract merely to avoid updating callers.

### Remove entire code paths

When deleting a dual path, remove its contracts, helpers, branches, and tests. Do not leave unreachable functions, dead variants, or compatibility aliases behind.

### Inline small refactors as you go

When you touch a function to remove a fallback and notice a redundant variable three lines down, remove it too. Small coherent edits belong together. Do not turn cleanup into a stylistic rewrite of unrelated code.

## Tests

The bar for tests is deliberately high. Often the correct answer is no new test.

A hacky test is worse than no test. It adds maintenance cost, noise, and false confidence without catching anything a careful reader would miss. If a test requires heavy mocks, intricate setup, or deep knowledge of internals, that often signals a design problem or a test that is not earning its place.

Only write or keep a test when the behavior cannot reasonably be verified by reading the code and reasoning through it. Examples that can clear that bar include:

- **Lifecycle**: startup, shutdown, draining, and recovery after interruption.
- **Storage**: migrations, persistence semantics, and crash safety.
- **Cross-component behavior**: composition, forwarding, normalization, and sanitization.
- **Isolation**: security boundaries and exposure to untrusted code.
- **Non-trivial algorithms**: parsing, scheduling, media processing, and other edge-case-heavy behavior.
- **Easy-to-regress invariants**: behavior that could silently break without focused protection.

Delete tests that restate implementation, assert visible literals, exercise trivial delegation, duplicate stronger coverage, or depend on elaborate mocks that break on every refactor. Before deleting, verify remaining tests still protect the underlying behavior. Never delete the only thing catching a real class of bug.

Never add a test only to raise coverage, demonstrate that obvious code works, or reassure yourself. If you need reassurance, read the code more carefully or test the meaningful boundary.

## Non-goals

- **Do not restyle unrelated code.** Cleanup licenses structural refactors that serve the target and fixes to adjacent bugs. It does not license rewriting files the target never interacts with.
- **Do not introduce new features.** Cleanup is cleanup.
- **Do not add tests to raise coverage numbers.** Add a test only when a meaningful invariant genuinely needs protection.
- **Do not add documentation files.** No README updates, changelog entries, or narratives of the cleanup unless project guidance explicitly requires a contract update.
- **Do not be clever.** Simple, direct, obvious code beats elegant indirection.

## Verification

Before reporting done, verify the touched code end-to-end. Use commands and conventions from `deslop-patterns`, applicable `AGENTS.md` files, and existing project configuration. Run formatting first when required, then the project's checks, build, and relevant tests. Do not run unrelated interactive applications or inspect dependencies unless the target requires it.

Any failure is yours, even if it surfaces outside the original target because your contract change broke it. Fix it before finishing.

## Output

When done, reply with:

1. **What changed**: a short, scannable list grouped by theme (contracts, boundaries, tests, real bugs). Use `path:line` references where useful.
2. **Bugs fixed along the way**: correctness issues fixed outside the strict cleanup scope, called out explicitly.
3. **Tests removed**: a brief list, each with one line on why remaining coverage is sufficient.
4. **Verified**: the exact commands run and their result.

Do not narrate the process. Do not apologize. Do not offer to keep going. Do not create Markdown summary files. The diff and the summary are the output.
