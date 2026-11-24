# Code mode

The `code` tool runs a JavaScript program that combines Tau capabilities in one call. The agent uses it to pass results between calls, run independent work in parallel, and print only what its answer needs.

Every program can import `@tau/core`, which holds the program's input, output, and docs. Every agent can also import the other packages, such as `@tau/bash`, `@tau/web`, or `@tau/models`, though some calls fail when a capability is [unavailable](tools.md). Programs have no file, network, credential, or process access of their own, only what those packages provide.

```js
import * as bash from "@tau/bash";
import { printText } from "@tau/core";

const status = await bash.text("git status --short");
printText(status || "Working tree is clean.");
```

The agent loads the reference for each package when it needs it, so you do not need to learn the APIs to use Tau. To read them yourself, for example when writing or reviewing a saved program, ask the agent to print `docs()` from `@tau/core`, a package reference such as `docs("@tau/web")`, or `docs("examples")`.

## Saved programs

A skill can ship a reviewed program, which the agent runs with `file` in place of inline code and a JSON `input` of up to 16 KiB. Programs share code through absolute or relative `.js` imports:

```js
// .agents/skills/audit/audit.js
import { input, printText } from "@tau/core";
import { report } from "./lib/report.js";

printText(report(input.project, input.limit));
```

```js
code({
  file: ".agents/skills/audit/audit.js",
  input: { project: "checkout", limit: 100 },
});
```

## Background programs

With `background: true`, `code` returns a job ID right away and the program has no overall deadline. The code job tools work like the [Bash job tools](tools.md#background-jobs). Stopping a program does not stop the Bash jobs or subagents it started.

## Your own APIs

An SDK program or client tool command can give the model its own API in the same sandbox. See [client tools](client-tools.md#code-mode-tools).
