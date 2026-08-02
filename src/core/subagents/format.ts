import { formatAdaptiveNumber, formatTokenWindow, formatUsdCost } from "../utils/format.js";
import type { SubagentCapacitySnapshot, SubagentStateSnapshot } from "./types.js";

function formatCapacity(capacity: SubagentCapacitySnapshot): string {
  return `${capacity.running}/${capacity.limit}`;
}

function formatRuntime(state: SubagentStateSnapshot): string {
  return `${state.name} · ${state.model.provider}/${state.model.id}:${state.model.reasoning}`;
}

function formatContext(state: SubagentStateSnapshot): string {
  const { contextWindowUsageTokens, contextWindow } = state.usage;
  const percent = contextWindow > 0 ? (contextWindowUsageTokens / contextWindow) * 100 : 0;
  return `context ${formatAdaptiveNumber(percent, 1, 3)}% (${formatTokenWindow(contextWindowUsageTokens)}/${formatTokenWindow(contextWindow)})`;
}

function formatAccounting(state: SubagentStateSnapshot): string {
  return `${formatContext(state)} · cost ${formatUsdCost(state.costTotal)}`;
}

function formatFailure(state: SubagentStateSnapshot): string[] {
  if (state.run.status !== "failed" && state.run.status !== "interrupted") return [];
  const stopReason =
    state.run.failure.kind === "provider-error"
      ? ` (stop reason: ${state.run.failure.stopReason})`
      : "";
  return [`failure: ${state.run.failure.message}${stopReason}`];
}

function formatListState(state: SubagentStateSnapshot): string {
  const runState =
    state.run.status === "running"
      ? `running · run ${state.run.revision}`
      : `idle · run ${state.run.revision} ${state.run.status}`;
  const response = state.run.status === "succeeded" ? " · response available" : "";
  const failureKind =
    state.run.status === "failed" || state.run.status === "interrupted"
      ? ` · ${state.run.failure.kind}`
      : "";
  return [
    `\`${state.id}\` · ${state.title}`,
    `${runState}${response}${failureKind}`,
    ...formatFailure(state),
    formatRuntime(state),
    `cwd ${state.workingDirectory}`,
    formatAccounting(state),
  ].join("\n");
}

function formatWaitState(state: SubagentStateSnapshot): string {
  const status = state.run.status === "running" ? "still running" : state.run.status;
  const failureKind =
    state.run.status === "failed" || state.run.status === "interrupted"
      ? ` · ${state.run.failure.kind}`
      : "";
  const lines = [
    `\`${state.id}\` · ${state.title}`,
    `run ${state.run.revision} ${status}${failureKind} · ${formatAccounting(state)}`,
    ...formatFailure(state),
  ];
  if (state.run.status === "succeeded") {
    lines.push("", "Response:", state.run.response || "(empty response)");
  }
  return lines.join("\n");
}

export function formatSpawnAgentResult(
  state: SubagentStateSnapshot,
  capacity: SubagentCapacitySnapshot,
): string {
  return [
    `Spawned \`${state.id}\` · ${state.title}`,
    `${formatRuntime(state)} · ${state.workingDirectory}`,
    `run ${state.run.revision} ${state.run.status} · capacity ${formatCapacity(capacity)}`,
  ].join("\n");
}

export function formatSendInputToAgentResult(
  state: SubagentStateSnapshot,
  capacity: SubagentCapacitySnapshot,
): string {
  return [
    `Started run ${state.run.revision} for \`${state.id}\` · ${state.title}`,
    `capacity ${formatCapacity(capacity)}`,
  ].join("\n");
}

export function formatListAgentsResult(
  states: SubagentStateSnapshot[],
  capacity: SubagentCapacitySnapshot,
): string {
  const heading = `Agents · ${capacity.running} running / ${capacity.limit}`;
  if (states.length === 0) return `${heading}\n\nNo subagents have been spawned.`;
  return [heading, ...states.map(formatListState)].join("\n\n");
}

export function formatActiveSubagentsForCompaction(states: SubagentStateSnapshot[]): string {
  return [
    "This subagent state was captured at the time of compaction and may have changed since then. Use list_agents to inspect the current state.",
    ...states.map(formatListState),
  ].join("\n\n");
}

export function formatWaitForAgentsResult(
  states: SubagentStateSnapshot[],
  capacity: SubagentCapacitySnapshot,
): string {
  return [...states.map(formatWaitState), `Capacity: ${formatCapacity(capacity)} running`].join(
    "\n\n",
  );
}

export function formatInterruptAgentResult(
  state: SubagentStateSnapshot,
  capacity: SubagentCapacitySnapshot,
  wasRunning: boolean,
): string {
  if (wasRunning) {
    return [
      `Interrupted run ${state.run.revision} for \`${state.id}\` · ${state.title}`,
      `Thread is idle and available for follow-up · capacity ${formatCapacity(capacity)}`,
    ].join("\n");
  }

  const failureKind =
    state.run.status === "failed" || state.run.status === "interrupted"
      ? ` · ${state.run.failure.kind}`
      : "";
  const response = state.run.status === "succeeded" ? " · response available" : "";
  return [
    `\`${state.id}\` is already idle`,
    `latest run ${state.run.revision} ${state.run.status}${response}${failureKind}`,
    ...formatFailure(state),
  ].join("\n");
}
