# Code mode

The `code` tool runs a JavaScript program that can combine Tau capabilities. The agent can run independent operations in parallel, pass results between calls, and print only the evidence needed for its answer.

Programs can run inline or from a saved `.js` file. They import enabled packages such as `@tau/core`, `@tau/web`, or `@tau/models` and can share code through relative imports. They have no direct file, network, credential, or process access. The persona determines which capabilities are available.

```js
import { bash, printText } from "@tau/core";

const status = await bash.text("git status --short");
printText(status || "Working tree is clean.");
```

The `code` tool description explains how to load its built-in guide, package references, and examples. Most users never need to read them. They are useful when authoring a saved program or reviewing one the agent wrote.
