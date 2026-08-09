import {
  executeTauCodeMode,
  type TauCodeModeDefinition,
  validateTauCodeModeDefinition,
} from "../code_mode/runtime.js";
import type { TauSdkClientTool } from "./types.js";

export type TauSdkCodeModeClientToolOptions = TauCodeModeDefinition & {
  description: string;
};

export function createTauCodeModeClientTool(
  options: TauSdkCodeModeClientToolOptions,
): TauSdkClientTool {
  const definition: TauCodeModeDefinition = {
    name: options.name,
    documentation: options.documentation,
    api: options.api,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.persistOutput === undefined ? {} : { persistOutput: options.persistOutput }),
  };
  validateTauCodeModeDefinition(definition);
  if (!options.description.trim()) {
    throw new Error("code-mode client tool description must not be empty");
  }

  return {
    schema: {
      name: options.name,
      description: options.description,
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript source to execute. Use console output to return information.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
      ...(options.timeoutMs === undefined ? {} : { executionTimeoutMs: options.timeoutMs }),
    },
    execute: async (args, context) => {
      const code = parseCodeArguments(args);
      return await executeTauCodeMode({
        ...definition,
        code,
        signal: context.signal,
        invocation: {
          sessionId: context.sessionId,
          callId: context.callId,
        },
      });
    },
  };
}

function parseCodeArguments(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    throw new Error("code-mode client tool arguments must be an object");
  }
  const args = value as Record<string, unknown>;
  if (
    typeof args.code !== "string" ||
    !args.code.trim() ||
    Object.keys(args).some((key) => key !== "code")
  ) {
    throw new Error(
      "code-mode client tool arguments must contain exactly one non-empty 'code' string",
    );
  }
  return args.code;
}
