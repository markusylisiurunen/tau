import {
  buildTauCodeModeToolDescription,
  CODE_MODE_MAX_OUTPUT_TOKENS_DESCRIPTION,
  executeTauCodeMode,
  parseCodeModeArguments,
  TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
  type TauCodeModeDefinition,
  validateTauCodeModeDefinition,
} from "../code_mode/runtime.js";
import type { TauClientToolPresentation } from "./client_tool_presentation.js";
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
  const handlers = createTauCodeModeHandlers(definition);
  const description = buildTauCodeModeToolDescription({
    name: options.name,
    description: options.description,
    timeoutMs: options.timeoutMs,
  });

  return {
    schema: {
      name: options.name,
      description,
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
              "JavaScript source to execute. Print text with printText and forward images with awaited printImage, both from @tau/core.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
      ...(options.timeoutMs === undefined ? {} : { executionTimeoutMs: options.timeoutMs }),
    },
    ...handlers,
  };
}

/** Runs programs for a code-mode client tool, whether the SDK or a command hosts it. */
export function createTauCodeModeHandlers(definition: TauCodeModeDefinition): {
  describe(args: unknown): TauClientToolPresentation;
  execute: TauSdkClientTool["execute"];
} {
  validateTauCodeModeDefinition(definition);
  return {
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
