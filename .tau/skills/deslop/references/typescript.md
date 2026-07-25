# TypeScript and JavaScript patterns

Load this reference when the deslop target contains TypeScript or JavaScript.

## Prefer required, canonical types

Use required properties, non-nullable values, discriminated unions, and exhaustive switches when they represent the real domain. Making a new field optional merely to avoid changing callers hides incomplete work from the compiler.

```ts
// slop
interface Input {
  attachments?: Attachment[];
  system?: string[];
}

function process(input: Input) {
  const attachments = input.attachments ?? [];
  const system = input.system ?? [];
}
```

If every caller has a meaningful value, require the fields and update every call site. Pass `[]`, `null`, or an explicit no-op implementation only when that value is the canonical contract.

```ts
// tighter
interface Input {
  attachments: Attachment[];
  system: string[];
}

function process(input: Input) {
  use(input.attachments, input.system);
}
```

## Validate once at the boundary

Inside trusted code, repeated `Array.isArray`, `typeof`, property-existence checks, and fallback defaults usually indicate a weak type or a missing validation boundary.

```ts
// slop inside typed internal code
if (!Array.isArray(input.attachments)) return;
if (typeof input.system !== "string") return;
```

Validate external input once with the project's established parser or schema library, produce a strong internal type, and trust that type downstream. Do not scatter hand-written shape guards through business logic.

```ts
// tighter boundary
const input = inputSchema.parse(request.body);
process(input);

function process(input: Input) {
  use(input.attachments, input.system);
}
```

## Parse one shape

Do not keep old and new property names alive without a compatibility requirement.

```ts
// slop
const result =
  readString(value, "result") ?? readString(value, "outputText") ?? "";
const content = readContent(value.content, result) ?? [
  { type: "text", text: result },
];
```

Choose the canonical serialized shape. Make its parser and serializer symmetric, reject unexpected alternatives, and migrate or reset obsolete data when project context permits.

```ts
// tighter
const result = readRequiredString(value, "result");
const content = readRequiredContent(value, "content");
```

## Construct canonical objects directly

Avoid defensive spreading that conditionally includes fields the contract requires.

```ts
// slop
return {
  ...(width === undefined ? {} : { width }),
  ...(height === undefined ? {} : { height }),
};
```

Once boundary parsing has established both values, construct the canonical object directly.

```ts
// tighter
return { width, height };
```

## Remove guards for impossible typed states

```ts
// slop
function send(message: Message) {
  if (!message) return;
  if (!message.content) return;
  if (typeof message.content !== "string") return;
  channel.write(message.content);
}
```

If `Message` requires `content: string`, delete the guards. If callers can violate that contract, fix the boundary or type instead of silently turning the violation into a no-op.

```ts
// tighter
function send(message: Message) {
  channel.write(message.content);
}
```

## Keep representations aligned

Watch for the same concept independently declared in domain code, API clients, wire payloads, persistence models, and UI state with slightly different optionality. Reuse one owned type where appropriate or define explicit transformations between genuinely distinct layers.

Avoid runtime branching that guesses which version of a union or payload arrived. Prefer a canonical discriminant and exhaustive handling.

## Remove thin helpers and abstractions

Inline a helper with one trivial caller unless it owns a non-obvious invariant. Remove wrapper functions that only rename another call, generic utilities used once, interfaces with one implementation and no meaningful boundary, and types that merely alias another type without narrowing or adding semantics.

```ts
// slop
const loadUser = (id: string) => userRepository.get(id);
const user = await loadUser(id);

// tighter
const user = await userRepository.get(id);
```

## Preserve useful errors

Avoid broad `try/catch` blocks that convert unrelated failures into a generic message or fallback value. Catch the narrow failure the current layer can handle. Otherwise let the original error propagate with its useful context.

Do not use `catch` to normalize programmer errors or impossible typed states into successful empty results.

```ts
// slop
try {
  return await loadConfig();
} catch {
  return {};
}

// tighter when this layer cannot recover
return await loadConfig();
```

## Remove dead contracts completely

When removing an obsolete field, variant, parser branch, or compatibility shape, remove its type members, runtime handling, serializers, callers, and tests together. Search for both property names and string literals so dead wire-format handling does not survive the type cleanup.
