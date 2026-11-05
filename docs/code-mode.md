# Code mode

Code mode lets the agent do many operations in one tool call. The `code` tool runs a short JavaScript program against Tau's APIs, and only what the program prints goes back to the model. The agent can therefore run ten searches or read a large result, keep the two lines that matter, and use little context.

The program runs in a sandbox with no imports, timers, files, network, environment variables, or credentials of its own. It can act only through the `tau` namespace, which holds the capabilities the persona selected:

| API | What it does |
| --- | --- |
| `tau.bash` | Run commands and manage background jobs. |
| `tau.web` | Search the web, fetch pages, and discover Markdown versions of pages. |
| `tau.history` | Search and read past transcripts. See [history](history.md). |
| `tau.mcp` | Find and call tools on [MCP servers](mcp.md). |
| `tau.models` | Run standalone model calls through OpenRouter. These see no session context. |
| `tau.agents` | Start and manage [subagents](subagents.md). |

The agent reads the API reference when it needs it, by printing `docs` or `await tau.docs("web")`, so you do not need to learn these APIs to use Tau. You will want to know them when you write skills or review what an agent did.

## Examples

**Keep only what matters.** Run a noisy command and return only the failures:

```js
const result = await tau.bash.run({ command: "npm test" });
const failures = result.output
  .split("\n")
  .filter((line) => line.includes("FAIL"));
printText(`exit ${result.exitCode}, ${failures.length} failures`);
printText(truncate(failures.join("\n"), { maxChars: 4000 }));
```

**Work in parallel.** Run several searches and print a short summary of each:

```js
const queries = ["node 24 release notes", "node 24 breaking changes"];
const responses = await Promise.all(
  queries.map((query) => tau.web.search(query, { numResults: 3 })),
);
for (const response of responses) {
  for (const page of response.results) {
    printText(
      `${page.title}\n${page.url}\n${(page.highlights ?? []).join("\n")}\n`,
    );
  }
  for (const notice of response.notices) printText(`notice: ${notice.message}`);
}
```

**Combine capabilities.** Find open issues on an MCP server and check each one against the repository:

```js
const { tools } = await tau.mcp.searchTools("list open issues", { limit: 1 });
const list = await tau.mcp.callTool(tools[0].server, tools[0].name, {
  state: "open",
});
if (list.isError) throw new Error(list.content[0].text);
const issues = JSON.parse(list.content[0].text);
for (const issue of issues) {
  const grep = await tau.bash.run({
    command: `git log --oneline --grep="#${issue.number}"`,
  });
  printText(
    `#${issue.number} ${issue.title}: ${grep.stdout.trim() || "no commits"}`,
  );
}
```

**Classify with a cheap model.** Ask a decision model typed questions, so the program can act on the answers without parsing prose. `tau.models` sees only what you pass:

```js
const reports = await tau.bash.run({ command: "cat reports/*.txt" });
const { answers } = await tau.models.decisions({
  model: "openai/gpt-6-luna-decisions",
  state: reports.stdout,
  questions: {
    has_crash: {
      type: "noul",
      instructions: "Do these reports describe a crash?",
    },
    urgency: {
      type: "score",
      instructions: "How urgent is the worst report?",
      criteria: ["Can wait", "Fix soon", "Blocking revenue"],
    },
  },
});
printText(JSON.stringify(answers));
```

**Run subagents and collect results.** Start one worker per package, wait for all of them, and print a status line for each. Subagents keep running if the program ends early:

```js
const packages = ["api", "web", "worker"];
const workers = await Promise.all(
  packages.map((name) =>
    tau.agents.spawn({
      title: `audit ${name}`,
      prompt: `Audit packages/${name} for unused dependencies and list them.`,
    }),
  ),
);
const states = await Promise.all(
  workers.map(({ id }) => tau.agents.waitUntilIdle({ id })),
);
for (const state of states)
  printText(`${state.title}: ${state.status}, ${state.reason}`);
```

**Reuse a program.** A skill can ship a reviewed program and run it with different input, so the agent does not write it again. The agent passes `file` in place of inline code:

```js
code({
  file: ".agents/skills/audit/audit.js",
  input: { project: "checkout", limit: 100 },
});

// audit.js
const { project, limit } = input;
```

A saved program is a single file of at most 1 MiB and cannot import other files. `input` is any JSON value up to 16 KiB.

## Output

Only `printText(string)` and `await printImage({ data, mimeType })` produce output. Return values are ignored. `truncate(text, { maxChars })` and `truncateLines(text, { maxLines })` shorten text before printing.

Long text is cut in the middle to `maxOutputTokens`, which defaults to 8,192. When that happens, Tau tries to save the text to a temporary file and reports the path. The agent should read that file, because running the program again would repeat its side effects.

## Limits

A foreground program times out after 5 minutes, and `timeout` can raise this to 60 minutes. Programs can make 4,096 API requests, 32 at a time, and each request and response can be up to 64 MiB. Programs are never retried, and a failed program does not undo what it did.

## Background programs

With `background: true`, `code` returns a job ID right away and the program has no overall deadline. `list_code_jobs`, `read_code_job`, `wait_for_code_jobs`, and `stop_code_job` work like the [Bash job tools](tools.md). Stopping a program does not stop the Bash jobs or subagents it started.

## Your own code-mode tools

An SDK program or a client tool command can give the model its own API in the same sandbox. See [client tools](client-tools.md).
