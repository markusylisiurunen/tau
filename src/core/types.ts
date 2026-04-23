import type { Api, Model, SimpleStreamOptions, ThinkingLevel } from "@mariozechner/pi-ai";
import { z } from "zod";
import type { SubagentConfigMap } from "./subagents/types.js";
import type { ToolName } from "./tools/tool_names.js";

export const RiskLevelSchema = z.enum(["read-only", "read-write"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export type ReasoningEffort = ThinkingLevel | "none";
export type ServiceTier = "priority" | "flex";

export type PersonaSource = "builtin" | "user" | "project";

export type PersonaSettings = Omit<SimpleStreamOptions, "reasoning"> & {
  reasoning?: ReasoningEffort;
  interleavedThinking?: boolean;
  serviceTier?: ServiceTier;
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
export const ServiceTierSchema = z.enum(["priority", "flex"]);

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
  tools?: ToolName[];
  skills: string[] | "*";
  source: PersonaSource;
}
