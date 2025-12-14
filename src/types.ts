import type { Api, Model, ReasoningEffort, SimpleStreamOptions, Tool } from "@mariozechner/pi-ai";
import type { SubagentConfigMap } from "./subagents/types.js";

export type RiskLevel = "none" | "read-only" | "read-write";

export const REASONING_LEVELS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export interface Persona {
  id: string;
  label: string;
  description?: string;
  model: Model<Api>;
  systemPrompt: string;
  settings: SimpleStreamOptions;
  allowedReasoningLevels?: ReasoningEffort[];
  subagents?: SubagentConfigMap;
  tools?: Tool[];
}
