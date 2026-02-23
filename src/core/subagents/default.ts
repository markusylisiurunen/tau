import { renderDefaultSubagentWrapperPrompt } from "../static/index.js";

export const DEFAULT_SUBAGENT_DESCRIPTION =
  "General-purpose sub-agent for background work. Trigger: explicit.";

export function buildDefaultSubagentSystemPrompt(mainPersonaSystemPrompt: string): string {
  return renderDefaultSubagentWrapperPrompt({
    inheritedInstructions: mainPersonaSystemPrompt,
  });
}
