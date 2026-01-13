import type {
  Api,
  Model,
  OpenAIResponsesOptions,
  SimpleStreamOptions,
  ThinkingLevel,
  Tool,
} from "@mariozechner/pi-ai";
import { z } from "zod";
import type { SubagentConfigMap } from "./subagents/types.js";

export const RiskLevelSchema = z.enum(["restricted", "read-only", "read-write"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export type ReasoningEffort = ThinkingLevel | "none";

export type PersonaSource = "builtin" | "user" | "project";

export type PersonaSettings = Omit<SimpleStreamOptions, "reasoning"> & {
  reasoning?: ReasoningEffort;
  serviceTier?: OpenAIResponsesOptions["serviceTier"];
  interleavedThinking?: boolean;
};

export const REASONING_LEVELS_TUPLE = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const ReasoningEffortSchema = z.enum(REASONING_LEVELS_TUPLE);

export const REASONING_LEVELS: ReasoningEffort[] = [...REASONING_LEVELS_TUPLE];

export interface Skill {
  name: string;
  description: string;
  path: string;
}

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
  skills?: string[] | "*";
  source: PersonaSource;
}
