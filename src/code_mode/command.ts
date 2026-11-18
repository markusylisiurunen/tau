import { runTauClientToolCommand } from "../sdk/client_tool_command.js";
import { createTauCodeModeHandlers } from "../sdk/code_mode.js";
import type { TauCodeModeDefinition } from "./runtime.js";

export async function runTauCodeModeCommand(definition: TauCodeModeDefinition): Promise<void> {
  await runTauClientToolCommand({
    name: definition.name,
    ...createTauCodeModeHandlers(definition),
  });
}
