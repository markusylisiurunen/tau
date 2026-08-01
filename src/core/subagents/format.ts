import { formatAdaptiveNumber } from "../utils/format.js";
import type { SubagentCapacitySnapshot, SubagentStateSnapshot } from "./types.js";

function formatCount(value: number): string {
  return formatAdaptiveNumber(value, 1, 1);
}

function formatCost(value: number): string {
  return `$${formatAdaptiveNumber(value, 2, 5)}`;
}

function formatUsage(state: SubagentStateSnapshot): string {
  const { usage } = state;
  return [
    `tokens in ${formatCount(usage.input)}`,
    `out ${formatCount(usage.output)}`,
    `cache read ${formatCount(usage.cacheRead)}`,
    `write ${formatCount(usage.cacheWrite)}`,
    `context ${formatCount(usage.contextWindowUsageTokens)}/${formatCount(usage.contextWindow)}`,
  ].join(" · ");
}

function formatSubagentState(
  state: SubagentStateSnapshot,
  options: { includeResponse: boolean },
): string {
  const lines = [
    `**${state.id}** · ${state.title}`,
    `${state.name} · ${state.availability} · ${state.model.provider}/${state.model.id} · reasoning ${state.model.reasoning}`,
    `${state.workingDirectory} · run ${state.run.revision} ${state.run.status}`,
    `cost ${formatCost(state.costTotal)} · turns ${state.turns} · tools ${state.toolCalls}`,
    formatUsage(state),
  ];

  if (state.run.progress) {
    lines.push(`progress: ${state.run.progress}`);
  }
  if (state.run.status === "failed" || state.run.status === "interrupted") {
    const stopReason =
      state.run.failure.kind === "provider-error"
        ? ` · stop reason ${state.run.failure.stopReason}`
        : "";
    lines.push(`failure ${state.run.failure.kind}${stopReason}: ${state.run.failure.message}`);
  }
  lines.push(`response: ${state.run.status === "succeeded" ? "available" : "unavailable"}`);
  if (options.includeResponse && state.run.status === "succeeded") {
    lines.push("", "Response:", state.run.response || "(empty response)");
  }

  return lines.join("\n");
}

export function formatSubagentStates(
  states: SubagentStateSnapshot[],
  capacity: SubagentCapacitySnapshot,
  options: { includeResponses: boolean },
): string {
  const heading = `Agents: ${states.length} · running ${capacity.running}/${capacity.limit}`;
  if (states.length === 0) return `${heading}\n\nNo subagents have been spawned.`;
  return [
    heading,
    "",
    ...states.flatMap((state, index) => [
      ...(index > 0 ? [""] : []),
      formatSubagentState(state, { includeResponse: options.includeResponses }),
    ]),
  ].join("\n");
}
