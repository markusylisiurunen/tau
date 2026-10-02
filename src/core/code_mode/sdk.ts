import { z } from "zod";
import type { TauCodeModeApi } from "../../code_mode/runtime.js";
import type { CodeModeCapability } from "./capability.js";

export function bindCodeModeSdk(capabilities: CodeModeCapability[]): {
  api: TauCodeModeApi;
  documentation: string;
} {
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));
  if (byName.size !== capabilities.length || byName.has("docs"))
    throw new Error("duplicate or reserved code-mode capability");
  return {
    documentation: [
      "## Tau capabilities",
      "",
      ...capabilities.map(({ name, description }) => `- tau.${name}: ${description}`),
      "",
      'Before using a capability, read its documentation in a separate call: printText(await tau.docs("bash")). Reuse documentation already visible in the conversation. Do not guess signatures. tau.docs(name) accepts exactly one enabled capability name and returns its complete API reference.',
      `
## Composing programs

Use a program when keeping intermediate data in JavaScript makes the task clearer: pass one call's result into another, combine independent evidence, or reduce a large response to the relevant facts. A single direct tool call is fine when composition adds nothing. Only enabled capabilities are callable, and their use restrictions still apply inside a program.

Plan around dependencies. Await a result before using it; run independent calls concurrently only when every result is needed, with a small explicit bound below the runtime's concurrency limit. Use service filters and pagination to bound inputs before processing them. Keep reusable logic in small functions and avoid elaborate frameworks for one-shot work.

Check results before passing them onward: command exit and truncation fields, per-item retrieval errors, and model completion or refusal status can indicate failure even when the call itself resolves. Stop dependent work when required input is incomplete. For independent work, catch errors per item only when partial results are useful, and report what is missing rather than silently treating failures as empty data.

Print a concise result with evidence, identifiers, and any limitations needed for the next decision. Intermediate values stay in the program unless printed. Side effects and external charges are not rolled back. After failure or interruption, inspect what completed and retry only the necessary work, not the whole program blindly.

### Examples for adaptation

These illustrate possibilities, not required workflows. Use only capabilities available for the task, read their references first, and adapt inputs, model choices, and result checks to the actual request.

Chain shell output into focused inference (requires Bash and models):

\`\`\`js
const run = await tau.bash.run({ command: "git diff --stat" });
if (run.exitCode !== 0 || run.truncated || run.timedOut || run.aborted)
  throw new Error("incomplete diff summary");
const result = await tau.models.chat({
  model: "openai/gpt-6-luna",
  prompt: "Summarize this change footprint without inferring implementation details:\\n" + run.stdout,
});
if (result.finish_reason !== "stop" || result.refusal || !result.answer)
  throw new Error("model did not produce a complete answer");
printText(result.answer);
\`\`\`

Combine a bounded set of independent searches and deduplicate evidence (requires web and a task that calls for web search):

\`\`\`js
const queries = ["CSS nesting browser support", "CSS nesting known limitations"];
const responses = await Promise.all(
  queries.map(query => tau.web.search(query, { numResults: 3 })),
);
const unique = new Map();
for (const response of responses) {
  for (const status of response.statuses) {
    if (status.status !== "success") printText("Retrieval failed: " + status.id);
  }
  for (const result of response.results) unique.set(result.url, result);
}
for (const result of unique.values()) printText(result.title + "\\n" + result.url);
\`\`\`

Keep useful independent results when one operation fails (requires Bash):

\`\`\`js
const commands = ["git status --short", "git diff --stat"];
const results = await Promise.allSettled(
  commands.map(command => tau.bash.run({ command })),
);
for (const [index, result] of results.entries()) {
  printText(commands[index]);
  if (result.status === "rejected") {
    printText("Command unavailable: " + String(result.reason));
  } else {
    const run = result.value;
    if (run.exitCode !== 0 || run.truncated || run.timedOut || run.aborted)
      printText("Incomplete command result; do not treat it as full evidence.");
    printText(truncateLines(run.output, { maxLines: 30 }));
  }
}
\`\`\`
`,
    ].join("\n"),
    api: {
      ...Object.fromEntries(capabilities.map(({ name, api }) => [name, api])),
      docs: (args) => {
        const [name] = z.tuple([z.string().min(1)]).parse(args);
        const capability = byName.get(name);
        if (!capability) throw new Error(`unavailable code-mode capability '${name}'`);
        return capability.documentation;
      },
    },
  };
}
