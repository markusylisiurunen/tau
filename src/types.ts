import type { Api, Model, ReasoningEffort, SimpleStreamOptions, Tool } from "@mariozechner/pi-ai";

export type ToolAccessLevel = "none" | "read" | "all";
export type AllowedReasoningLevel = ReasoningEffort | "none";

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
