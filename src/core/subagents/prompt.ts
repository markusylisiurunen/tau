import { renderSubagentPrefixPrompt } from "../static/index.js";

export function buildSubagentSystemPrompt(
  systemPrompt: string,
  context: { sessionIds: string[]; historyEnabled: boolean },
): string {
  return `${renderSubagentPrefixPrompt(context)}\n\n${systemPrompt}`;
}
