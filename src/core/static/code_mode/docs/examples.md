# Code program examples

Each recipe names the packages it needs. Adapt names, paths, and limits to the task.

## Summarize several pages in parallel

`@tau/web` and `@tau/models`. Fetch pages in one call, then summarize each successful page concurrently.

```js
import { input, printText } from "@tau/core";
import { chat, list } from "@tau/models";
import { fetch } from "@tau/web";

const { results, statuses } = await fetch(input.urls, { text: { maxCharacters: 8_000 } });
const { chat: [model] } = await list();
if (!model) throw new Error("No chat model available");
const summaries = await Promise.all(results.map(async (page) => {
  const { answer, status } = await chat(`Summarize in three bullets:\n\n${page.text}`, {
    model: model.id,
  });
  return `${page.title} (${page.url})\n${answer ?? `no summary: ${status}`}`;
}));
printText(summaries.join("\n\n"));
for (const { id, status } of statuses) if (status === "error") printText(`failed: ${id}`);
```

## Fix a failing test and show the diff

`@tau/bash` and `@tau/files`. Failures from `run` are data, so the program decides what to print.

```js
import * as bash from "@tau/bash";
import { printText, truncate } from "@tau/core";
import * as files from "@tau/files";

await files.edit("src/date.js", [{ oldText: "getYear()", newText: "getFullYear()" }]);
const result = await bash.run("npm test -- date 2>&1", { timeout: 300_000 });
printText(await bash.text("git diff -- src/date.js"));
printText(result.exitCode === 0 ? "tests pass" : truncate(result.stdout, { maxLines: 60, keep: "tail" }));
```

## Read the relevant part of a past conversation

`@tau/history`. Find the session, then print short excerpts instead of the transcript.

```js
import { printText, truncate } from "@tau/core";
import { read, search } from "@tau/history";

const { sessions: [session] } = await search({ query: "release checklist", limit: 1 });
if (!session) throw new Error("No matching session");
const { entries, nextCursor } = await read(session.sessionId, { limit: 100 });
for (const entry of entries) {
  if (entry.type !== "assistant" || !entry.content.includes("checklist")) continue;
  printText(`[${entry.id}] ${truncate(entry.content, { maxChars: 800 })}`);
}
if (nextCursor) printText("more entries follow");
```

## Show a screenshot from an MCP tool

`@tau/mcp`. Images are forwarded only when the program prints them.

```js
import { printImage, printText } from "@tau/core";
import { callTool } from "@tau/mcp";

const result = await callTool("browser", "screenshot", { url: "https://example.com" });
if (result.isError) throw new Error("screenshot failed");
for (const block of result.content) {
  if (block.type === "image") await printImage(block);
  else if (block.type === "text") printText(block.text);
}
```

## Share code between saved programs

A saved program runs with `file` in place of `code`, takes its arguments from `input`, and imports helpers by relative path.

```js
// .agents/skills/audit/audit.js
import * as bash from "@tau/bash";
import { input, printText } from "@tau/core";
import { formatFindings } from "./lib/format.js";

const output = await bash.text("npm audit --json || true", { workingDirectory: input.project });
printText(formatFindings(JSON.parse(output), input.limit));
```
