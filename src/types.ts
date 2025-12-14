import type {
  Api,
  Model,
  ReasoningEffort as PiReasoningEffort,
  SimpleStreamOptions,
  Tool,
} from "@mariozechner/pi-ai";
import type { SubagentConfigMap } from "./subagents/types.js";

export type RiskLevel = "none" | "read-only" | "read-write";

export type ReasoningEffort = PiReasoningEffort | "none";

export type PersonaSettings = Omit<SimpleStreamOptions, "reasoning"> & {
  reasoning?: ReasoningEffort;
};

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
  settings: PersonaSettings;
  allowedReasoningLevels?: ReasoningEffort[];
  subagents?: SubagentConfigMap;
  tools?: Tool[];
}
