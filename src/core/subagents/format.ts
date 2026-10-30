import type { SubagentConversationState } from "./types.js";

export function formatActiveSubagentsForCompaction(states: SubagentConversationState[]): string {
  return [
    "This subagent state was captured at the time of compaction and may have changed since then. Use tau.agents.list() in code to inspect the current state.",
    JSON.stringify(states),
  ].join("\n\n");
}
