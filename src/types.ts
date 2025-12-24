import type {
  AnyModel,
  ReasoningEffort as IotaReasoningEffort,
  StreamOptions,
  Tool,
} from "@markusylisiurunen/iota";
import { z } from "zod";
import type { SubagentConfigMap } from "./subagents/types.js";

export const RiskLevelSchema = z.enum(["restricted", "read-only", "read-write"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export type ReasoningEffort = IotaReasoningEffort;

export type PersonaSettings = StreamOptions;

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
  model: AnyModel;
  systemPrompt: string;
  settings: PersonaSettings;
  allowedReasoningLevels?: ReasoningEffort[];
  subagents?: SubagentConfigMap;
  tools?: Tool[];
  skills?: string[] | "*";
}
