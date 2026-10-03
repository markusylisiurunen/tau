import {
  CODE_MODE_MAX_OUTPUT_TOKENS_DESCRIPTION,
  executeTauCodeMode,
  parseCodeModeArguments,
  TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
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
          maxOutputTokens: {
            type: "integer",
            minimum: 1,
            maximum: TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
            description: CODE_MODE_MAX_OUTPUT_TOKENS_DESCRIPTION,
          },
          code: {
            type: "string",
            description:
              "JavaScript source to execute. Use printText(text) for text and await printImage(block) to return images.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
      ...(options.timeoutMs === undefined ? {} : { executionTimeoutMs: options.timeoutMs }),
    },
    describe: (args) => createCodeModePresentation(parseCodeModeArguments(args).code),
    execute: async (args, context) => {
      const { code, maxOutputTokens } = parseCodeModeArguments(args);
      const result = await executeTauCodeMode({
        ...definition,
        code,
        maxOutputTokens,
        signal: context.signal,
        invocation: {
          sessionId: context.sessionId,
          agentId: context.agentId,
          callId: context.callId,
        },
        executionEnvironment: context.executionEnvironment,
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
