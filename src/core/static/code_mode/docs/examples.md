# Code program examples

Each recipe combines several packages for a realistic task. Single-package examples are in each package's reference. Adapt names, paths, and limits to the task.

## Summarize several pages in parallel

`@tau/web` and `@tau/models`. Fetch the pages in one call, then summarize each one concurrently and report pages that failed.

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

`@tau/files` and `@tau/bash`. A failed `run` is data, so the program decides what to print.

```js
import * as bash from "@tau/bash";
import { printText, truncate } from "@tau/core";
import * as files from "@tau/files";

await files.edit("src/date.js", [{ oldText: "getYear()", newText: "getFullYear()" }]);
const result = await bash.run("npm test -- date 2>&1", { timeout: 300_000 });
printText(await bash.text("git diff -- src/date.js"));
printText(result.exitCode === 0 ? "tests pass" : truncate(result.stdout, { maxLines: 60, keep: "tail" }));
```

## Classify a CI failure

`@tau/bash` and `@tau/models`. A schema turns the model's answer into fields the program can format.

```js
import * as bash from "@tau/bash";
import { input, printText, truncate } from "@tau/core";
import { chat, list } from "@tau/models";

const log = await bash.text(`gh run view ${Number(input.runId)} --log-failed`);
const { chat: [model] } = await list();
if (!model) throw new Error("No chat model available");
const { status, answer } = await chat(
  `Why did this CI run fail?\n\n${truncate(log, { maxLines: 400, keep: "tail" })}`,
  {
    model: model.id,
    schema: {
      type: "object",
      properties: {
        cause: { type: "string", enum: ["test", "build", "lint", "infrastructure", "flaky"] },
        summary: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["cause", "summary", "files"],
      additionalProperties: false,
    },
  },
);
if (status !== "complete") throw new Error(`no classification: ${status}`);
printText(`${answer.cause}: ${answer.summary}\n${answer.files.join("\n")}`);
```

## Find a past decision

`@tau/history` and `@tau/models`. Each matching transcript goes to a model, so only the decisions reach your context. Use history only when the user asks for past conversations.

```js
import { input, printText } from "@tau/core";
import { read, search } from "@tau/history";
import { chat, list } from "@tau/models";

const { sessions } = await search({ query: input.topic, limit: 5 });
const { chat: [model] } = await list();
if (!model) throw new Error("No chat model available");
const decisions = await Promise.all(sessions.map(async ({ sessionId, webUrl }) => {
  const { entries } = await read(sessionId, { limit: 100 });
  const transcript = entries
    .filter((entry) => entry.type === "user" || entry.type === "assistant")
    .map((entry) => `${entry.type}: ${typeof entry.content === "string" ? entry.content : "[media]"}`)
    .join("\n")
    .slice(0, 60_000);
  const { answer } = await chat(
    `What did this conversation decide about ${input.topic}? Reply "none" if nothing.\n\n${transcript}`,
    { model: model.id },
  );
  return `${webUrl ?? sessionId}: ${answer ?? "no answer"}`;
}));
printText(decisions.join("\n"));
```

## Write an MCP query to a report

`@tau/mcp` and `@tau/files`. The tool's schema was read with `describeTool` in an earlier program. The report goes to a file, and only a summary is printed.

```js
import { printText } from "@tau/core";
import * as files from "@tau/files";
import { callTool } from "@tau/mcp";

const result = await callTool("tracker", "search_issues", { query: "label:bug state:open", limit: 50 });
if (result.isError) {
  throw new Error(result.content.find((block) => block.type === "text")?.text ?? "search failed");
}
const issues = result.structuredContent?.issues ?? [];
const lines = issues.map((issue) => `- ${issue.id} ${issue.title} (${issue.assignee ?? "unassigned"})`);
const { path } = await files.writeText("reports/open-bugs.md", `# Open bugs\n\n${lines.join("\n")}\n`);
printText(`${issues.length} issues written to ${path}`);
```

## Read a documentation page as Markdown

`@tau/web` and `@tau/bash`. Prefer a Markdown version when the site offers one, and fall back to extracted text. The URL reaches `curl` through `stdin`, not through the command line.

```js
import * as bash from "@tau/bash";
import { input, printText, truncate } from "@tau/core";
import { discover, fetch } from "@tau/web";

const { markdown } = await discover(input.url);
const text = markdown.length
  ? await bash.text('curl -fsSL -H "Accept: text/markdown" "$(cat)"', { stdin: markdown[0].url })
  : (await fetch(input.url, { text: true })).results[0]?.text ?? "";
printText(truncate(text, { maxChars: 6_000 }));
```
