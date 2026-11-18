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

## Delegate reviews and collect the answers

`@tau/agents`. Workers run concurrently, and the program waits for all of them.

```js
import { readResponse, spawn, waitUntilIdle } from "@tau/agents";
import { printText } from "@tau/core";

const areas = ["src/auth", "src/billing"];
const workers = await Promise.all(areas.map((area) =>
  spawn(`Review ${area} for unchecked errors. Report file, line, and problem.`, {
    title: `Review ${area}`,
  })));
for (const [index, { id }] of workers.entries()) {
  const worker = await waitUntilIdle(id);
  printText(`## ${areas[index]}\n` + (worker.reason === "completed"
    ? await readResponse(id)
    : `worker ${id} ended: ${worker.reason}`));
}
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

## Find MCP tools by meaning

`@tau/mcp` and `@tau/models`. A task such as "find customer conversations about login failures" may need a tool described as "search support tickets", which shares none of its words, so `searchTools` misses it. A decision model scores every tool description instead. Mind the call limit for very large catalogs, and read the chosen tool's schema with `describeTool` before calling it.

```js
import { printText } from "@tau/core";
import { listServers, listTools } from "@tau/mcp";
import { decisions, list } from "@tau/models";

const task = "Find customer conversations about login failures from last week";
const { decisions: [model] } = await list();
if (!model) throw new Error("No decision model available");
const tools = [];
for (const server of await listServers()) {
  let offset = 0;
  do {
    const page = await listTools(server.name, { limit: 100, offset });
    for (const tool of page.tools) {
      tools.push({
        id: `tool_${tools.length}`,
        server: server.name,
        name: tool.name,
        description: (tool.description ?? "").slice(0, 1000),
      });
    }
    offset = page.nextOffset;
  } while (offset !== undefined);
}

const ranked = [];
for (let start = 0; start < tools.length; start += 128) {
  const batch = tools.slice(start, start + 128);
  const questions = Object.fromEntries(batch.map((tool) => [tool.id, {
    type: "score",
    instructions: `Rate how useful candidate ${tool.id} is for the task, judging only its own name and description.`,
    criteria: [
      "Unrelated, or performs an incompatible action.",
      "Related topic, but no evidence it can do the task.",
      "Useful for a necessary part of the task.",
      "Directly provides the main capability the task needs.",
    ],
  }]));
  const { answers } = await decisions({ task, candidates: batch }, { model: model.id, questions });
  for (const tool of batch) {
    const answer = answers[tool.id];
    if (answer.type === "score" && answer.score >= 2) ranked.push({ ...tool, score: answer.score });
  }
}
ranked.sort((a, b) => b.score - a.score);
for (const { server, name, score } of ranked.slice(0, 8)) printText(`${server}/${name} ${score}`);
if (ranked.length === 0) printText("No relevant tools found.");
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
