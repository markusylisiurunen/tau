import type { Api, Model, ReasoningEffort, SimpleStreamOptions, Tool } from "@mariozechner/pi-ai";

export type RiskLevel = "none" | "read-only" | "read-write";
export type AllowedReasoningLevel = ReasoningEffort | "none";

export const REASONING_LEVELS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
export const REASONING_LEVELS_WITH_NONE: ReasoningEffort[] = REASONING_LEVELS;

export interface Persona {
  id: string;
  label: string;
  description?: string;
  model: Model<Api>;
  systemPrompt: string;
  settings: SimpleStreamOptions;
  allowedReasoningLevels?: AllowedReasoningLevel[];
  tools?: Tool[];
}
