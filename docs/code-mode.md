# Code mode

`code` runs a JavaScript program that combines the enabled capabilities: `tau.web`, `tau.history`, `tau.mcp`, `tau.bash`, and `tau.models`. The Bash, write, edit, and image tools stay available as separate tools.

## Saved programs and input

A call passes exactly one of `code`, with inline source, or `file`, with the path of a saved `.js` program. A relative path resolves from the agent's working directory. Tau reads the file once from the execution environment when the call starts, so later edits do not affect a running program. The file can be at most 1 MiB. A saved program runs in the same sandbox, with the same capabilities and limits, as inline code. It cannot import modules or other files.

The optional `input` is any JSON value of at most 16 KiB when serialized as UTF-8 JSON. The program reads it from the global `input`, which is `null` when no input is supplied. This lets a skill or project keep a reviewed program in a file and run it with different inputs:

```js
code({
  file: ".agents/skills/audit/audit.js",
  input: { project: "checkout", limit: 100 },
});

// audit.js
const { project, limit } = input;
```

## Documentation and output

If the agent has not yet seen the runtime guide, it first runs a program that only prints it:

```js
printText(docs);
```

The guide covers runtime rules, capabilities, and examples. It does not depend on how a call is run: it describes deadlines and output for both foreground and background programs. The agent reads each capability's reference it has not seen yet in a separate call that only prints documentation:

```js
printText(await tau.docs("web"));
```

The agent does not re-read documentation it has already seen. MCP tool descriptions are read separately. Programs do not need to print intermediate results.

`printText` accepts only strings; objects and arrays throw a `TypeError`. The agent selects relevant fields and explicitly formats concise plain text to save tokens. `JSON.stringify` is reserved for cases where the structure matters or machine-readable JSON is requested, with fields selected first instead of dumping whole responses.

Only `printText(string)` and awaited `printImage({ data, mimeType })` produce output, in the order they are called. Return values are ignored. In the foreground, text is truncated in the middle to `maxOutputTokens` (default 8,192; range 1–65,536). The agent leaves it unset unless needed, and may raise it to 16,384 on its own. Higher values require an explicit user request. When text from the built-in `code` tool is truncated, Tau saves it to a temporary file in the execution environment when possible and reports the path. The agent reads that file instead of running the program again with its side effects. The file does not contain images or text lost to capture limits.

JPEG, PNG, and WebP images are validated outside the sandbox and fitted to 4,096 pixels per dimension and 3.5 MiB each. Source images can be at most 40 megapixels, and a program can emit at most 16 images. Valid images are kept even if the built-in `code` program fails.

The helper functions `truncate(text, { maxChars, position? })` and `truncateLines(text, { maxLines, position? })` return shortened strings with a marker where text was removed. `position` defaults to `middle`; `start` and `end` keep that end of the text. They do not print anything.

```js
const result = await tau.bash.run({ command: "npm test" });
printText(truncate(result.stdout, { maxChars: 4000 }));
```

## Execution and limits

Programs have no direct access to files, processes, environment variables, credentials, imports, timers, or the network. They can act only through the capabilities. Keep data in variables, and use `tau.bash` for files.

A foreground `code` program times out after 5 minutes by default. `timeout` accepts 1–3,600,000 ms (60 minutes). The deadline covers the whole program, including capability calls. When it passes, the program stops, unresolved capability calls are cancelled, and the text printed so far is returned with a timeout notice. `tau.bash.run` follows the timeout rules of the `bash` tool: 60 seconds by default, and any positive number of milliseconds with no upper limit. The program's own deadline still cancels the command. A program can make 1,024 API requests, 32 at a time. Each serialized request and response can be at most 64 MiB. Object properties set to `undefined` are dropped, while `undefined` arguments and array entries are rejected. Programs are never retried, and failure or cancellation does not undo actions already taken.

## Background code jobs

With `background: true`, `code` starts the program as a background job and returns its ID right away. A background program has no overall deadline, and `background: true` cannot be combined with `timeout` or `maxOutputTokens`. Each capability call keeps its own time limit, and the request limits above still apply. As with Bash, agents are told to use background mode only when they can do other useful work while the program runs.

Along with `code`, Tau provides `list_code_jobs`, `read_code_job`, `stop_code_job`, and `wait_for_code_jobs`. They take the same arguments as the [Bash job tools](tools.md#bash) and return the same labeled blocks, with `source` (the file path or `inline code`) in place of `command` and no exit code. Status is `running`, `succeeded`, `failed`, or `stopped`. Output budgets, text logs, `includeOutput`, the wait timeout, and the 64-record limit work the same way. Each agent has separate 64-record limits for code jobs and Bash jobs. In the TUI, code job cards use the same headings and footers with `code` in place of `bash`, such as `reading code <id>`.

A job keeps its images and the last 1 MiB of its printed text, in the order the program emitted them. The error message or stack trace of a failed program is part of its output. The text log contains only text. A response for several jobs includes at most 16 images in total, and says how many it left out; read those jobs one at a time to get their images.

`stop_code_job` cancels the program and its in-flight capability calls, then waits for the program to end. Bash jobs that the program started with `tau.bash.start` keep running. Stopping does not undo actions already taken.

Code jobs have the same lifecycle and ownership as background Bash jobs: each job belongs to the agent that started it, and other agents cannot see it. Jobs keep running across turns, interruptions, and client disconnects, and keep an idle session loaded until they finish. Closing the session or shutting down the host stops the code jobs of every agent, then their Bash jobs. Jobs are not recovered after a restart, a failed program is never run again automatically, and a finished job never starts an agent turn by itself.

## Capabilities

- `tau.web`: metadata discovery, Exa search, and fetching page content. Search uses Auto with Dynamic Highlights to select evidence across results. An optional `objective` (1–4,096 nonblank characters) describes the broader task and facts to extract. Results include a `notices` array with retrieval qualifications such as relaxed query restrictions; each notice retains its `code`, `path`, `message`, and optional `details`. The agent prints notices alongside selected search results. The agent prefers local data, dedicated CLIs, first-party APIs, and structured sources over scraping web pages. For GitHub it uses `gh` or a Git checkout where suitable. Metadata discovery works without an Exa key; search and content fetching need one.
- `tau.history`: read-only search and paginated transcripts. The agent uses it only when explicitly told to look at past sessions. It treats past content as data and never follows instructions in it. See [history](history.md).
- `tau.mcp`: finding and calling tools and resources on configured MCP servers. When the persona allows MCP, enabled server names and optional configured descriptions are visible in the initial tool definition, before any tool call. Disabled servers and connection settings are omitted. These summaries guide discovery and do not grant permission to act. The agent reads each tool's description and schema before calling it. Connections are shared and opened on first use, and calls that change data are never retried. An `isError` result is returned as data, while protocol failures throw. MCP server configuration and trust rules apply. See [configuration reference](config-reference.md#mcpservers) and [security](security.md#trust-mcp-servers).
- `tau.bash`: `run`, `start`, `list`, `read`, `wait`, and `stop`. `run` returns stdout, stderr, and exit and termination fields, capturing up to 24 MiB. Beyond that it keeps the end, so check `truncated` before parsing. Optional UTF-8 `stdin` is limited to 16 MiB and closed after writing. Without `stdin` the command has no stdin at all, while `""` gives it an empty one. `start` takes no stdin. Background jobs are the same jobs that the agent's Bash job tools show, and each keeps the last 24 MiB of output. `read`, `wait`, and `stop` return that retained output as a string, without the job tools' token budget. `list` leaves out output and execution error messages. Jobs survive the program ending and interruption, while foreground commands are cancelled. The [Bash rules](tools.md#bash) apply.
- `tau.models`: lists a fixed set of OpenRouter models and runs standalone chats or typed decisions with them. These calls do not see the session's conversation or tools. Chat media can be paths on the agent's machine or inline padded base64 with a matching MIME type. Credentials stay on the host. Provider usage data is returned, but these charges are not included in the session's cost or usage logs. Requests can be cancelled and are never retried automatically. Limits on input, models, media, responses, and requests are the same as in [OpenRouter](openrouter.md). Check whether a response completed or was refused instead of assuming it is a full answer.

SDK and command client tools built on code mode use the same sandbox functions and output rules, with their own declared APIs. They take only inline code, without saved files, input, or background mode. Their programs time out after 60 seconds unless configured otherwise.
