import { TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS } from "../../dist/code_mode/runtime.js";
import { bindCodeModeSdk } from "../../dist/core/code_mode/sdk.js";
import {
  createCodeModeToolDefinition,
  executeInternalCodeMode,
} from "../../dist/core/tools/code_mode.js";

export function createCapabilityTool(backend, capability, { timeoutMs = 60_000 } = {}) {
  const sdk = bindCodeModeSdk([capability]);
  return createCodeModeToolDefinition({
    schema: { name: "code", description: capability.description, parameters: { type: "object" } },
    parseArguments(raw) {
      const code = raw?.code ?? "";
      const valid =
        typeof code === "string" && code.trim() && Object.keys(raw).every((key) => key === "code");
      return valid
        ? {
            ok: true,
            code,
            subject: code,
            timeoutMs,
            maxOutputTokens: TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS,
          }
        : { ok: false, error: "invalid code arguments", code, subject: "(invalid code)" };
    },
    execute: ({ code, context, timeoutMs, maxOutputTokens }) =>
      executeInternalCodeMode({
        name: "tau",
        ...sdk,
        code,
        maxOutputTokens,
        backend,
        signal: context.signal,
        timeoutMs,
      }),
  });
}
