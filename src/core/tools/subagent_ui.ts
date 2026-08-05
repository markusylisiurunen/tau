import { formatAdaptiveNumber, formatDurationMs } from "../utils/format.js";
import { buildToolRunPresentation, type ToolRunPresentation } from "./presentation.js";

export function buildSubagentPresentation(args: {
  toolName: string;
  subject: string;
  output: string;
  metadata?: string[];
}): ToolRunPresentation {
  const output = args.output.trimEnd();
  return buildToolRunPresentation({
    toolName: args.toolName,
    subject: args.subject,
    details: output ? output.split("\n").map((text) => ({ text })) : [],
    metadata: args.metadata ?? [],
  });
}

export function formatSubagentMetadata(args: { costTotal: number; durationMs?: number }): string[] {
  return [
    `cost $${formatAdaptiveNumber(args.costTotal, 2, 5)}`,
    `duration ${formatDurationMs(args.durationMs)}`,
  ];
}
