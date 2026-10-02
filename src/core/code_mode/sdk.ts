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
      "Only explicitly exposed capabilities are callable. Print the results and progress useful for the task; intermediate return values do not enter the conversation. A failed program does not undo completed actions. Do not retry a whole program blindly after failure or interruption.",
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
