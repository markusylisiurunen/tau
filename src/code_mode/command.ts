import { runTauClientToolCommand } from "../sdk/client_tool_command.js";
import { truncateTauClientToolText } from "../sdk/client_tool_presentation.js";
import {
  executeTauCodeMode,
  parseCodeModeArguments,
  type TauCodeModeDefinition,
  validateTauCodeModeDefinition,
} from "./runtime.js";

export async function runTauCodeModeCommand(definition: TauCodeModeDefinition): Promise<void> {
  validateTauCodeModeDefinition(definition);
  await runTauClientToolCommand({
    name: definition.name,
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
  });
}

function createCodeModePresentation(code: string) {
  return {
    subject: truncateTauClientToolText(code),
    subjectWrap: "character" as const,
  };
}
