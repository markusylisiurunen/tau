---
name: "deslop"
description: "Clean up, canonicalize, and tighten a specified Tau target (often a branch of PR work from a junior or AI agent, but also a package, the current changes, or any other bounded slice), refactoring freely within the target when that raises overall quality. Trigger: explicit."
---

## Goal

Assume the code in your target was written by an inexperienced junior (human or AI). It compiles. It solves the original problem. But it carries the telltale weight of whoever reached for the first thing that worked: optional fields that are never actually optional, parsers that accept two shapes, defensive wrappers, narrative comments, low-value tests, compat shims for code that never shipped, runtime type guards that paper over weak types.

Your job is to read it critically and tighten it. Leave the codebase strictly better than you found it: tighter types, one canonical way to represent each concept, clear ownership of validation and normalization, no redundant plumbing, tests that genuinely earn their keep.

Sloppy cleanup accumulates more debt than the original slop. Understand first, then cut.

## Mindset

- **Assume flaws.** Every function, type, test, and comment is on trial. Default to removing before keeping; every optional parameter, fallback, helper, comment, and test needs to justify its existence.
- **Tau is pre-v1.** Prefer the clean canonical contract over compatibility scaffolding. When a contract changes, update all call sites instead of supporting both old and new shapes. Do not add migration paths for unshipped data unless explicitly asked.
- **Respect Tau architecture.** Keep `ChatApp`, `ChatController`, `CoreSession`, `SessionEngine`, runtime helpers, events, tools, diff review, SDK, and TUI boundaries clean. If new code twists around an existing boundary, consider whether the boundary should move.
- **Review at every level of abstraction.** Start wide (architecture, module boundaries, shared abstractions), then narrow (functions, types, expressions). Each level has its own slop, and architectural drift is usually the highest-leverage thing to fix.
- **Reshape abstractions when new code does not fit.** Sometimes the target adds something that cannot sit cleanly inside existing patterns. Do not contort the new code to fit; evolve the patterns until the new code fits naturally. This takes more thought and more edits than local cleanup, and the end result is dramatically better. It is often the single most valuable thing you can do.
- **Scope is flexible.** The target is the starting point, not a fence. If a larger refactor inside the touched area makes the overall codebase meaningfully better, do it. If you spot a real bug adjacent to your changes, fix it and call it out.
- **One way to do a thing.** When two shapes, two parsers, or two code paths exist for the same concept, collapse to one. Pick the cleaner one, delete the other.
- **Validate at the edge; trust internals.** Normalize and reject at the system boundary (HTTP handler, deserializer, CLI entry). Downstream code takes well-formed values and uses them. Stop re-validating, re-parsing, and re-defaulting at every layer.
- **Types are your first reviewer.** Prefer required fields, non-nullable types, and exhaustive switches. When you add a new argument, option, field, or method to a shared contract, make it required unless absence is a real domain state. Changing every call site is the point: the compiler tells you exactly what was forgotten. Never choose optional to avoid editing files.
- **Make contracts explicit.** Optionality is for meaningful absence, not convenience. If callers should always make a choice, require the field. If implementations should all expose a capability, require the method. Use explicit empty values or no-op implementations at the edge instead of pushing `?.`, `??`, and implicit defaults through the codebase.
- **Simple beats clever.** Dumb, direct, obvious code wins over elegant abstractions. If you can delete an indirection, delete it. Optimize for clarity, never for the amount of code you had to edit.
- **Defensive code is noise.** Guards against states the types forbid, checks for inputs callers never produce, and catch-alls that swallow real errors clutter code without adding safety. They are harder to read and easier to misinterpret than the straight-line version. Delete them.
- **Match the codebase.** Read surrounding code. Follow existing naming, structure, and style. "Cleaner" does not mean "my preferred style"; it means closer to the repo's established patterns. For Tau, use TypeScript, 2-space Biome formatting, lower-case file names, semantic UI theme tokens, and existing error/event patterns.

## Workflow

Complete each phase before moving on.

### Phase 1: Understand

1. Know the target. The invoking prompt names it (a branch, a package, a set of changes, a file tree) and tells you how to enumerate it. Resolve the concrete files and interfaces that belong to the target before anything else.
2. Read `AGENTS.md` files that cover the target. Respect project-specific conventions.
3. Read the target's files to build up your understanding, not just the pieces you plan to edit. Follow call sites, related types, and tests.
4. Form a mental model of what the code does end-to-end and what the changes' intent is. Do not start editing until you could describe it without re-reading the source.

If the user provides a trigger phrase like "ack when you are done," acknowledge and stop until they follow up.

### Phase 2: Hunt slop

Scan at every level of abstraction. Start wide: does the architecture still hold with the new changes, are module and package boundaries sensible, do the existing abstractions still carry the new code cleanly? Then narrow into functions, types, and expressions. The "Slop patterns" catalog below leans line-level, so treat it as a starting point, not a checklist, and bring your own architectural questions.

For each instance, decide: remove, collapse, refactor, simplify, or leave. Prefer remove and collapse; prefer reshaping an abstraction over working around it.

Additional signals worth noticing, among others:

- **Abstractions that no longer fit.** The new code has to twist around an existing pattern, or duplicates logic that an abstraction was meant to centralize. The pattern is what needs to change, not the new code.
- **Module or package boundaries in the wrong place.** Two packages owning pieces of one concept, or one package doing two unrelated jobs.
- **Real bugs** present in or exposed by the target, such as cleanup-on-wrong-path (destroying persisted state after the server already accepted it), swallowed errors, missed `org_id` scoping, off-by-one in ranges, misordered defers.
- **Redundant plumbing**: the same fact carried across three layers when one would do.
- **Optional fields that are never actually optional.** Every call site ends up passing a value, or the field should be nullable instead of optional.
- **Dual representations** of the same concept that have drifted apart.
- **Runtime branching on shape** that the type system should enforce at compile time.
- **Tau contract drift** across core events, RPC/SDK types, tool metadata, TUI view models, prompts, and docs. Keep these shapes canonical and symmetric.
- **Hidden budgets, truncation, or parser rules** that can fail at runtime without being represented in prompts, tests, and metadata contracts.
- **Defensive code for states the types already forbid.**

### Phase 3: Execute

Make the changes. Stay incremental: prefer a series of focused edits over one sprawling rewrite. After each meaningful change, re-read the surrounding code to confirm you have not broken a contract.

When cleanup requires changes outside the original target (for example, tightening a shared type forces call-site updates elsewhere), do them. The goal is a consistent codebase, not a minimized edit count.

When compatibility versus simplicity is genuinely a judgment call, ask the user once: "Is this feature released? Do we need to preserve existing data or contracts?" Absent a clear yes, prefer wiping and simplifying.

### Phase 4: Verify

Follow the Verification section below. Do not skip checks, and do not rationalize failures as "unrelated." Any failure you introduced or uncovered is yours to fix.

## Slop patterns

Hunt these aggressively. Examples are illustrative; more patterns will show up in real diffs.

### Fallback parsing and multi-shape readers

```ts
// before
result = readString(o, "result") ?? readString(o, "outputText") ?? "";
content = readContent(o.content, result) ?? [{ type: "text", text: result }];
```

If the canonical shape is known, parse only that shape and throw on anything else. Migrate or reset old data instead of accepting it forever.

### Optional arguments that are always passed

```ts
// before
interface Input {
  attachments?: Attachment[];
  system?: string[];
}
// inside: attachments: input.attachments ?? [], system: input.system ?? [],
```

Require them in the type. Delete the `??`. Update call sites to pass `[]`, `null`, or an explicit implementation when that is the real contract.

### Defensive spreading to "only include when truthy"

```ts
// before
return {
  ...(width === undefined ? {} : { width }),
  ...(height === undefined ? {} : { height }),
};
```

If the field is required on the wire, parse it as required and construct `{ width, height }` directly.

### Defensive code for impossible states

```ts
function send(message: Message) {
  if (!message) return;
  if (!message.content) return;
  if (typeof message.content !== "string") return;
  channel.write(message.content);
}
```

If `Message` requires `content: string`, none of these guards can fire. Delete them. The type is the guard. Checks for inputs callers never produce, null guards against non-nullable values, and catch-alls that swallow errors the caller should see are visual debt: they obscure the real logic without adding safety, and they routinely mask bugs by turning unexpected states into silent no-ops.

### Runtime type guards that duplicate the type system

```ts
function process(input: ProcessInput) {
  if (!Array.isArray(input.attachments)) return;
  if (typeof input.system !== "string") {
    // ...
  }
}
```

If the type says `attachments: Attachment[]`, trust it. Scattered `Array.isArray`, `typeof x === "string"`, or hand-rolled shape guards inside non-boundary code mean one of two things: the type is weak (tighten it), or validation was skipped at the boundary (validate once with a schema parser like Zod, then trust). Runtime branching on shape is a substitute for a type the compiler should enforce.

### Duplicated types across layers

Watch for a domain type duplicated in the API client, the browser, and a DTO, each with slightly different optionality. Collapse to one shape or make the derivation explicit (for example, derive a download URL from an ID client-side instead of sending redundant metadata over the wire).

### Helpers with one caller

Inline them. Named helpers earn their name when there are at least two real callers or when they encapsulate a non-trivial invariant. A named wrapper around one call site usually obscures more than it helps.

### Narrative comments

```ts
// Try the new attachments field, fall back to metadata for older payloads.
```

If the code needs a comment to explain this, the code is wrong. Fix the code, delete the comment. Keep comments only for genuine tribal knowledge or non-obvious invariants.

### Silently accepting unexpected input

Multipart parsers that ignore unknown field names. JSON parsers that accept either `metadata.attachments` or top-level `attachments`. HTTP handlers that accept any content type. Reject unknown inputs with a clear error.

### Optional config with the same effective default everywhere

If every caller passes the same value, remove the option. If a "default" is never deliberately overridden, it is not a default, it is noise.

### Compat shims, migration paths, and deployment-skew guards

Migrations that rewrite old payload shapes for a feature that never shipped. Dual-read code paths guarding against nonexistent historical data. Service A defensively coercing responses from Service B in case an old version is still deployed. None of this applies here: services ship together, unreleased features have no historical data, and there are no external clients to support. Drop the data, tighten the schema, move on. Confirm with the user only if genuinely uncertain whether something is released.

### Tests that restate the code

`test("create returns the thing")` where the body calls `create` and asserts the shape the function literally returns. Delete it. A reader can verify that by reading the function.

### Over-broad try/catch

Wrapping a block in `try/catch` to turn a specific expected failure into a generic "something went wrong" erases useful information. Catch the narrowest case, or let it propagate.

### Vestigial fields and parameters

A parameter that is now always `nil`, a struct field that is always the zero value, a response field that is always empty. Remove.

## Cleanup principles

### Evolve abstractions when new code does not fit

The highest-leverage cleanup is usually not a local edit. When the target adds something that duplicates logic an abstraction was meant to centralize, forces awkward branching in a shared helper, or crosses a module boundary drawn in the wrong place, the existing pattern is what needs to change, not the new code.

This takes effort. You have to understand why the pattern was drawn the way it was, what constraint has now shifted, and what shape would carry the whole system cleanly. When you can see the better shape, make the change: split or merge modules, rename concepts, redraw boundaries, replace one abstraction with another. The diff will be larger than a local tidy-up. The result will be dramatically cleaner than any amount of line-level polish.

### Validation ownership

Every piece of data has one boundary where it is validated and normalized (HTTP handler, deserializer, client entry point). Downstream code takes the already-validated value and trusts it. A schema parser like Zod at the edge is often the cleanest form of this.

When you find `?? ""`, `?? []`, `?? 0`, `strings.TrimSpace`, runtime type checks, or repeated length checks deep inside a function, ask: where should this have been enforced? Push the check to the boundary. Delete the duplicates.

### Canonical shapes

For each concept in the system (user message, tool result, attachment, and similar), there is one canonical shape. It appears in:

- one domain type
- one serializer
- one parser
- one set of wire DTOs mirroring it

Parser and serializer should be symmetric. If the serializer always writes a field, the parser should require it.

### Derive, don't duplicate

If B can be computed from A, don't plumb B through the system next to A. A file download URL can be computed from a file ID. A content type can often be inferred from a filename extension. Derive at the consumer, not at the producer.

### Strict types beat runtime defaults

Prefer required fields, non-nullable types, and exhaustive switches over permissive shapes with runtime fallbacks. Let the compiler be the first reviewer.

When you add a new argument, option, or field, add it as required. Changing every call site is the point. The biggest source of drift in a pre-release codebase is "I'll make it optional so I don't have to edit those other files." That is optimizing for work saved instead of for correctness. Do not do it.

### Remove entire code paths

When deleting a dual code path, remove the whole thing: types, helpers, branches, tests. Do not leave an unreachable function or a dead enum variant.

### Inline small refactors as you go

When you touch a function to remove a fallback and notice a redundant variable three lines down, remove it too. Small coherent edits belong together. Do not turn cleanup into a stylistic rewrite of unrelated code.

## Tests

The bar for tests is deliberately high. Often the correct answer is no test at all.

A hacky test is worse than no test. It adds maintenance cost, noise in the test runner, and false confidence without catching anything a careful reader would miss. If writing the test requires heavy mocks, intricate setup, or deep knowledge of internals, that is usually a signal the design is wrong or the test is not earning its place.

Only write or keep a test when the behavior cannot reasonably be verified by reading the code and reasoning through it. Examples of behavior that can clear that bar, among others:

- **Lifecycle**: startup, shutdown, drain, recovery after interruption.
- **Storage**: migrations, persistence semantics, crash safety.
- **Cross-service behavior**: how components compose, what gets forwarded, what gets sanitized.
- **Sandbox or isolation**: security boundaries, what is and is not exposed to untrusted code.
- **Non-trivial algorithms**: parsing, scheduling, image processing, anything with edge cases a reader cannot run in their head.
- **Easy-to-regress invariants**: things that would silently break without a test, such as which fields are redacted in a response envelope.

Delete tests that fall outside this bar. Common categories, not exhaustive:

- Tests that restate what a function literally does.
- Tests that assert a specific validation string a reader can see inline.
- Tests for a wrapper that just delegates to another function.
- Tests duplicating coverage already provided by an end-to-end test.
- Tests propped up by elaborate mocks that break on every refactor.

When deleting, verify remaining tests still cover the underlying behavior somewhere. Never delete the only thing catching a real class of bug.

Never add a test to raise coverage, demonstrate that code works, or reassure yourself. If you need reassurance, read the code more carefully.

## Non-goals

- **Do not restyle unrelated code.** Cleanup licenses structural refactors that serve the target and fixes to adjacent bugs. It does not license reformatting or rewriting files that the target never interacts with.
- **Do not introduce new features.** Cleanup is cleanup.
- **Do not add tests to raise coverage numbers.** Only add a test when a new invariant genuinely needs protection and it clears the bar above.
- **Do not add documentation files.** No README updates, no CHANGELOG entries, no markdown narratives of what you did. The diff is the record.
- **Do not be clever.** Simple, dumb, obvious code beats elegant abstractions.

## Verification

Before reporting done, verify the touched code end-to-end. The relevant `AGENTS.md` files define the commands (build, lint, format, tests) and conventions (line lengths, tooling, style) for each app you touched. Read them and follow them. For Tau, start with `npm run check`, then run the smallest relevant tests; for branch-level cleanup prefer `npm test` when practical. Do not run the interactive app (`npm start`, `node dist/main.js`) and do not inspect `node_modules` unless explicitly asked.

Any failure is yours, even if it surfaces in a file you did not touch but your type change broke. Fix it before finishing.

## Output

When done, reply with:

1. **What changed**: a short, scannable list grouped by theme (types, boundaries, tests, real bugs). Use `path:line` references where useful.
2. **Bugs fixed along the way**: any real correctness issues you fixed outside the strict cleanup scope, called out explicitly.
3. **Tests removed**: brief list, each with one line on why the remaining coverage is sufficient.
4. **Verified**: the exact commands you ran and their result.

Do not narrate the process. Do not apologize. Do not offer to keep going. Do not create markdown summary files. The diff and the summary are the output.
