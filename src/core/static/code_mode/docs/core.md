# Code programs and @tau/core

A program is JavaScript that imports the packages listed in the tool description. Use one to chain dependent calls, run independent calls in parallel with `Promise.all`, and print only what your answer needs.

```js
import { printText } from "@tau/core";
import * as bash from "@tau/bash";

const [branch, status] = await Promise.all([
  bash.text("git branch --show-current"),
  bash.text("git status --short"),
]);
printText(`${branch.trim()}\n${status || "clean"}`);
```

## How programs run

- Programs are ES modules with static imports and top-level `await`. Import named functions, or a namespace such as `import * as bash from "@tau/bash"` when names are generic. Relative `.js` imports load local files when the tool runs saved programs: a path resolves from the importing file, or from the working directory for inline code. Node built-ins, npm packages, dynamic `import()`, `require`, `fetch`, timers, and `console` are unavailable.
- Each call starts a fresh program, so nothing carries over between calls. The return value is ignored, and only printed output comes back, cut from the middle when it exceeds the call's `maxOutputTokens`.
- Every package function returns a promise. Arguments and results are JSON values, except that `Uint8Array` bytes pass through unchanged. Object properties set to `undefined` are dropped from arguments.
- A failed call rejects with an `Error`. Arguments that do not match the reference fail with `code: "invalid_arguments"` before anything happens, and each reference lists the other codes its package uses. An uncaught error ends the program, and what it printed so far still comes back.
- Some capabilities can be unavailable to you, such as starting subagents or web search. Your instructions list any that are. A call that needs one fails with `code: "unavailable"`, and an option that depends on one defaults to what you actually get.
- When a program times out or is cancelled, its pending calls are cancelled too. Completed side effects stay, so check what a mutation did before you repeat it.

| Limit | Value |
| --- | --- |
| Source files | 64 per program, 1 MiB each, 8 MiB in total |
| Package calls | 4,096 per program, 32 at a time |
| Arguments or result of one call | 64 MiB |
| Printed images | 16 per program |

A result over the size limit fails instead of being truncated, so request less with filters, pagination, or file paths when a result could be large.

## @tau/core

```ts
const input: JsonValue; // the tool call's input, or null
function printText(text: string): void;
function printImage(image: Uint8Array | { data: string; mimeType: string }): Promise<void>;
function truncate(text: string, limit: TruncateLimit): string;
function docs(page?: string): Promise<string>;

type TruncateLimit = ({ maxChars: number } | { maxLines: number }) & {
  keep?: "head" | "tail" | "both"; // default "both"
};
```

- `printText` accepts only strings, so select the fields you need and format them as short lines. Include the IDs you will use in later calls. Use `JSON.stringify` on selected values only when their structure matters.
- `printImage` forwards JPEG, PNG, or WebP bytes, or a block with base64 `data` such as MCP tools return. Await it. Text and images come back in the order you print them. Never print base64 data as text.
- `truncate` shortens text to a positive number of characters or lines. The `…` marker does not count toward the limit, and in line mode it takes its own line. Text that fits comes back unchanged.
- `docs()` returns this page. `docs(name)` returns the reference of an available package, or another page the tool description names.

`docs` fails with `unknown_page` for any other name.
