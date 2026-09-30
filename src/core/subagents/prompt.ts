import { renderSubagentWrapperPrompt } from "../static/index.js";

export function buildSubagentSystemPrompt(mainPersonaSystemPrompt: string): string {
  return renderSubagentWrapperPrompt({
    inheritedInstructions: mainPersonaSystemPrompt,
  });
}
