---
name: "deslop"
description: "Improve a specified implementation while preserving its intended behavior. Reconsider its design, then inspect code-level shortcuts such as fake optionality, fallback parsing, redundant guards, thin wrappers, and low-value tests. By default, apply the improvements and verify the result. Use only when the user explicitly names this skill or active repository or skill instructions explicitly require it; do not activate merely because a task is related. Trigger: explicit."
---

Use the `design-afresh` skill to reason about the design and the `clear-writing` skill for all communication with the user.

Improve the named target, such as a branch, current changes, a package, or a feature. By default, implement the improvements. If the user asks only for an assessment or a discussion, do that instead. Do not commit, push, or publish unless the request or active workflow calls for it.

Preserve intended behavior and established obligations. Fix verified bugs within the target and state which behavior each fix corrects. Do not add features, make product decisions nobody asked for, or expand the task into unrelated cleanup.

## Understand the target and choose the design

Establish the scope from the request and read the applicable repository guidance. Before editing, inspect the implementation, its callers, its contracts, and its tests. For a branch or change set, use the diff as the starting point and follow the affected behavior into surrounding code.

If a repository provides a `deslop-patterns` skill, use it for local context such as maturity, ownership, compatibility, and verification. If no such skill exists, continue without it.

Apply `design-afresh` across the target before settling for local fixes. Form a preferred design, compare it with the current implementation, and decide what to reuse or change. Carry necessary changes into shared contracts and their consumers so that the result is coherent, while respecting explicit scope limits. A sound result may need a substantial refactor. It may also need very few edits.

Then inspect the implementation details with the patterns below. When a local symptom reveals a larger design problem, return to the design level. The patterns add to the design work and never replace it.

Load [references/typescript.md](references/typescript.md) for TypeScript or JavaScript and [references/go.md](references/go.md) for Go. Load both for a mixed target. For other languages, use the same reasoning and the project's idioms.

## Look for code-level shortcuts

Code written with AI assistance or through fast iteration often collects local workarounds that hide unfinished work. Treat the patterns below as signals to investigate. They do not prove that code should be deleted. Before changing code, trace its callers and establish the actual contract.

### Optional fields that hide incomplete changes

A new field is sometimes optional only because updating every caller was inconvenient. A default such as `value ?? []` then hides the missing work. If every caller must choose a value, require it and update the callers. Keep absence when it has a defined meaning.

```ts
// Every caller is expected to choose which attachments to send.
// Before: missing updates silently become an empty list.
type Input = { attachments?: Attachment[] };
const attachments = input.attachments ?? [];

// After: the contract exposes callers that still need updating.
type Input = { attachments: Attachment[] };
const attachments = input.attachments;
```

### Type assertions that hide broken contracts

Look for casts, unchecked assertions, suppression directives, and widened types that silence a type mismatch without resolving it. In TypeScript, examples include `as any` and `as unknown as T`. Find out why the actual value and the expected type differ. Then correct the owning type, validate the external input, or finish updating the callers. Keep an assertion when a real guarantee justifies it and the compiler cannot express that guarantee. Do not replace weak assertions with wrappers that are just as weak.

### Fallback parsing and compatibility without a requirement

Look for chains of old and new property names, readers that guess between shapes, legacy aliases, and deployment-skew guards that were added without evidence of need. Check whether shipped data, external consumers, or independently deployed components depend on them. Remove dual paths that nothing needs, and keep real compatibility at the owning boundary. Do not reset or discard data just to simplify a reader.

### Repeated validation and impossible-state guards

Trace where external input becomes a trusted internal value. If values are trimmed, parsed, shape-checked, or defaulted again deeper in the call path, the boundary may be weak or its guarantees unclear. Strengthen the owning boundary and remove the checks that are proven duplicates. A static type alone does not validate runtime input, and checks at separate trust boundaries may both be necessary.

### Defensive output construction

Conditional spreads, truthiness checks, and selective omission can hide which fields the output contract requires. Once the values are established, build the output directly. Preserve meaningful distinctions between absent, empty, zero, and false values.

### Duplicate representations and derived state

Look for one concept that passes through models, API payloads, storage, UI state, and prompts while its names or optionality drift. Where the contracts match, share one owned representation. Where they differ, make the transformation explicit. Derive values from their owner and avoid redundant state, unless consistency, performance, or compatibility justifies storing both.

### Indirection that adds no understanding

Inspect redundant intermediate variables, pass-through wrappers, one-off generic utilities, trivial adapters, and interfaces introduced only to mock a call. Remove indirection that makes the reader do more work and provides no useful boundary. A small helper or an interface with one implementation can still be valuable when it names a concept, hides complexity, or isolates a dependency. Judge each one by what it saves its callers from having to understand.

### Error handling that hides failure

Look for broad catches, logging-and-continuing, silent returns, and empty results that turn unexpected failures into apparent success. Handle the failures that the current layer owns, and pass useful information on to callers. Keep a fallback when it is intended behavior with a clear contract.

### Configuration and state with no real role

Question options whose callers all make the same choice, fields that are never read, variants that cannot occur, and parameters carried through layers without being used. Before you call any of them dead, check external consumers and supported configurations. When you remove a path, remove its contracts, serialization, callers, helpers, and obsolete tests in the same change.

### Comments and tests that mirror the implementation

Remove comments that narrate obvious control flow, describe the editing history, or explain avoidable intricacy. Keep reasoning, constraints, and invariants that the code cannot express.

Inspect tests that depend on private structure, test trivial delegation, or repeat other assertions. Keep tests that protect important behavior or guard against a plausible regression, even when the current implementation is easy to read. Before removing a test, identify what it protects and check whether the remaining tests still provide that protection. Heavy mocking is a reason to examine the boundary. It does not automatically justify deleting coverage.

### Local style drift

Compare new code with the surrounding module. Unfamiliar naming, import patterns, control flow, or error handling may come from an isolated implementation choice and not from a real need. Follow the established conventions where they fit. Keep deliberate differences that serve the design, and do not let this check grow into unrelated formatting or restyling.

### Contracts that changed only halfway

Look for updated implementations with stale callers, schemas, defaults, error messages, tests, or documentation. Check the limits, truncation, and parsing rules that consumers need to know about, including those in model-facing prompts and tool definitions. Carry each changed decision through its owning contract and all code that depends on it.

## Complete and verify the improvements

Work in coherent increments. Keep existing code that is already good. Do not invent changes to satisfy a checklist, and do not aim for a high count of deleted lines.

Use the project's verification guidance and checks appropriate to the affected behavior. Update tests and contract documentation where needed. Do not add tests only to raise coverage, and do not write a story of the cleanup into repository files. Fix failures that your changes caused. Investigate other failures far enough to tell them apart from regressions, then report unrelated blockers without expanding the task to fix them.

Inspect the final net change for incomplete contract updates, accidental behavior changes, and unnecessary scope. Summarize the main improvements, any bugs fixed, and the verification results. Mention removed tests when the loss of coverage matters, and list unresolved risks or blockers. Keep the report in proportion to the work.
