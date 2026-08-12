import {
  createTauCodeModeExecutionEnvironmentFiles,
  executeTauCodeMode,
  type TauCodeModeDefinition,
  validateTauCodeModeDefinition,
} from "../code_mode/runtime.js";
import { truncateTauClientToolText } from "./client_tool_presentation.js";
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
    describe: (args) => createCodeModePresentation(parseCodeArguments(args)),
    execute: async (args, context) => {
      const code = parseCodeArguments(args);
      const result = await executeTauCodeMode({
        ...definition,
        code,
        signal: context.signal,
        invocation: {
          sessionId: context.sessionId,
          agentId: context.agentId,
          callId: context.callId,
        },
        executionEnvironment: context.executionEnvironment,
        files: createTauCodeModeExecutionEnvironmentFiles(
          context.agentId,
          context.executionEnvironment,
        ),
      });
      return { ...result, presentation: createCodeModePresentation(code) };
    },
  };
}

function createCodeModePresentation(code: string) {
  return {
    subject: truncateTauClientToolText(code),
    subjectWrap: "character" as const,
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
