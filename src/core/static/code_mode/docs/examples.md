# Code Mode examples

## Find release notes for the installed Node version

```js
import { bash, printText } from "@tau/core";
import { search } from "@tau/web";

const version = (await bash.text("node --version")).trim();
const { results, notices } = await search(`Node.js ${version} release notes`, {
  includeDomains: ["nodejs.org"],
  numResults: 3,
});
for (const { title, url } of results) printText(`${title}: ${url}`);
for (const { message } of notices) printText(message);
```

## Edit two related lines and show the diff

```js
import { bash, files, printText } from "@tau/core";

await files.edit("docs/quickstart.md", [
  { oldText: "npm run dev", newText: "npm start" },
  { oldText: "Open port 3000", newText: "Open port 4000" },
]);
printText(await bash.text("git diff -- docs/quickstart.md"));
```

## Ask a model about a screenshot

Pass the image path as `input.screenshot`.

```js
import { input, printText } from "@tau/core";
import { chat, list } from "@tau/models";

const { chat: models } = await list();
const model = models.find(({ inputs }) => inputs.includes("image"));
if (!model) throw new Error("No image model available");

const result = await chat([
  { role: "user", content: [
    { type: "text", text: "What error is visible in the screenshot?" },
    { type: "image", path: input.screenshot },
  ] },
], { model: model.id });

if (result.status === "complete") printText(result.answer);
else printText(`No answer: ${result.status}`);
```

## Find MCP tools by meaning

A task like "find customer conversations about login failures" may need a tool described as "search support tickets", which shares none of its words, so `searchTools` misses it. This program asks a decision model to score every tool description against the task. It needs `@tau/mcp` and `@tau/models`, and prints the best matches. Tools with equal scores keep their catalog order. For very large catalogs, keep the program's call limit and timeout in mind. Read a selected tool's schema with `describeTool` before calling it.

```js
import { listServers, listTools } from "@tau/mcp";
import { decisions, list } from "@tau/models";
import { printText } from "@tau/core";

const task = "Find customer conversations about login failures from last week";
const { decisions: models } = await list();
const model = models[0];
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
  const questions = {};
  for (const tool of batch) {
    questions[tool.id] = {
      type: "score",
      instructions:
        `Rate how useful candidate ${tool.id} is for the supplied task. ` +
        "Evaluate its own capabilities, not its rank within this batch. " +
        "Do not assume capabilities missing from its name and description.",
      criteria: [
        "Unrelated to the task, or performs an incompatible action.",
        "Related topic, but insufficient evidence it can help perform the task.",
        "Clearly useful for a necessary part of the task.",
        "Directly provides the main capability needed for the task.",
      ],
    };
  }

  const result = await decisions({ task, candidates: batch }, {
    model: model.id,
    questions,
  });

  for (const tool of batch) {
    const answer = result.answers[tool.id];
    if (answer.type !== "score") throw new Error("Expected a relevance score");
    if (answer.score >= 2) {
      ranked.push({ ...tool, score: answer.score });
    }
  }
}

ranked.sort((a, b) => b.score - a.score);
const matches = ranked.slice(0, 8);
if (matches.length === 0) {
  printText("No relevant tools found in the catalog summaries.");
} else {
  for (const tool of matches) {
    printText(JSON.stringify({
      server: tool.server,
      name: tool.name,
      description: tool.description,
      score: tool.score,
    }));
  }
}
```
