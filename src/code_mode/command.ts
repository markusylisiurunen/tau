import { runTauClientToolCommand } from "../sdk/client_tool_command.js";
import {
  buildTauClientToolPresentation,
  truncateTauClientToolSubject,
} from "../sdk/client_tool_presentation.js";
import {
  createTauCodeModeExecutionEnvironmentFiles,
  executeTauCodeMode,
  type TauCodeModeDefinition,
  validateTauCodeModeDefinition,
} from "./runtime.js";

export async function runTauCodeModeCommand(definition: TauCodeModeDefinition): Promise<void> {
  validateTauCodeModeDefinition(definition);
  await runTauClientToolCommand({
    name: definition.name,
    describe: (args) =>
      buildTauClientToolPresentation({
        toolName: definition.name,
        operation: definition.name,
        subject: truncateTauClientToolSubject(parseCodeArguments(args)),
        subjectWrap: "character",
      }),
    execute: async (args, context) => {
      const code = parseCodeArguments(args);
      return await executeTauCodeMode({
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
    },
  });
}

function parseCodeArguments(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    throw new Error("code-mode command arguments must be an object");
  }
  const args = value as Record<string, unknown>;
  if (
    typeof args.code !== "string" ||
    !args.code.trim() ||
    Object.keys(args).some((key) => key !== "code")
  ) {
    throw new Error("code-mode command arguments must contain exactly one non-empty 'code' string");
  }
  return args.code;
}
