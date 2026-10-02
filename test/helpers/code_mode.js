import { bindCodeModeSdk } from "../../dist/core/code_mode/sdk.js";
import {
  createCodeModeToolDefinition,
  executeInternalCodeMode,
} from "../../dist/core/tools/code_mode.js";

export function createCapabilityTool(backend, capability, { timeoutMs = 60_000 } = {}) {
  const sdk = bindCodeModeSdk([capability]);
  return createCodeModeToolDefinition({
    schema: { name: "code", description: capability.description, parameters: { type: "object" } },
    timeoutMs,
    parseArguments(raw) {
      const code = raw?.code ?? "";
      const valid =
        typeof code === "string" && code.trim() && Object.keys(raw).every((key) => key === "code");
      return valid
        ? { ok: true, code, subject: code }
        : { ok: false, error: "invalid code arguments", code, subject: "(invalid code)" };
    },
    execute: ({ code, context }) =>
      executeInternalCodeMode({
        name: "tau",
        ...sdk,
        code,
        backend,
        signal: context.signal,
        timeoutMs,
      }),
  });
}
