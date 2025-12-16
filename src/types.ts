import type {
  Api,
  Model,
  ReasoningEffort as PiReasoningEffort,
  SimpleStreamOptions,
  Tool,
} from "@mariozechner/pi-ai";
import { z } from "zod";
import type { SubagentConfigMap } from "./subagents/types.js";

export const RiskLevelSchema = z.enum(["none", "read-only", "read-write"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export type ReasoningEffort = PiReasoningEffort | "none";

export type PersonaSettings = Omit<SimpleStreamOptions, "reasoning"> & {
  reasoning?: ReasoningEffort;
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
}
