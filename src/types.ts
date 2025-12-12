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
  /**
   * Allowed reasoning (thinking) levels for this persona.
   * Use "none" to represent no reasoning (omit provider reasoning options).
   * If omitted, defaults to all supported levels for the model.
   */
  allowedReasoningLevels?: AllowedReasoningLevel[];
  tools?: Tool[];
}
