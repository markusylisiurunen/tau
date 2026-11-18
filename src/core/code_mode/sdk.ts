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
      "## Capability references",
      "",
      `Enabled capabilities: ${capabilities.map(({ name }) => `tau.${name}`).join(", ")}. The code tool description says what each one is for.`,
      "",
      'Read a capability\'s reference before you use it, for example with printText(await tau.docs("bash")), in a documentation-only call before the program that uses it. You can print several references, and this guide, in the same call. Reuse references already visible in the conversation, and do not guess signatures. tau.docs(name) accepts exactly one enabled capability name and returns its complete API reference.',
      `
## Foreground and background programs

A foreground program has a 5-minute deadline by default. Set \`timeout\` in milliseconds, up to 60 minutes, when the work needs longer. Its printed output is returned when the program ends, within the \`maxOutputTokens\` budget.

A program launched with \`background: true\` runs as a code job and has no overall deadline, but each capability call keeps its own time limit. The launch accepts neither \`timeout\` nor \`maxOutputTokens\`. The job keeps its printed text and images. Read them with \`read_code_job\` or \`wait_for_code_jobs\`, which take their own \`maxOutputTokens\`. Stop a job with \`stop_code_job\`.

## Saved programs and preloads

Pass \`file\` to run a saved .js program in place of inline \`code\`. Any program can run library files first by naming them in \`// @preload ./lib/helpers.js\` lines among its opening comments. Relative paths resolve from the directory of the file that declares them, or from the current working directory for inline code. Each file runs once, after its own preloads, in the same sandbox with the same input and capabilities, and all files share the program's limits. Top-level declarations stay private to each file, so a library shares helpers through \`globalThis\`, as in \`globalThis.helpers ??= {}; helpers.format = (value) => String(value);\`. Circular preloads fail, and a file that throws stops the files after it.

## Writing programs

Use a program when keeping intermediate data in JavaScript helps: passing one call's result into another, combining independent evidence, or reducing a large response to the relevant facts. A direct tool call is fine when a program adds nothing. Only enabled capabilities are callable, and their use restrictions still apply inside a program.

Many calls resolve even when the work failed. A command can exit nonzero or be truncated, a page can fail to load inside a successful search, and a model can refuse. Check those fields before you pass a result on, stop dependent work when required input is incomplete, and report what is missing instead of treating a failure as empty data.

Run independent calls concurrently only when you need every result, with a small explicit bound below the concurrency limit. For paginated work, print the continuation values and resume in another program before the call or output budget runs out. Side effects and external charges are not rolled back, so after a failure or interruption, check what completed and redo only what is needed.

For example, chain shell output into a model call and check both results (requires bash and models):

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
