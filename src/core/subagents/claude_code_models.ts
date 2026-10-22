import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelResolver } from "../models/catalog.js";

export const CLAUDE_CODE_PROVIDER = "claude-code";

export const CLAUDE_CODE_MODEL_IDS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;
const MODEL_IDS: ReadonlySet<string> = new Set(CLAUDE_CODE_MODEL_IDS);

export function resolveClaudeCodeModel(
  id: string,
  resolveModel: ModelResolver,
): Model<Api> | undefined {
  if (!MODEL_IDS.has(id)) return undefined;
  const model = resolveModel("anthropic", id);
  return model ? { ...model, provider: CLAUDE_CODE_PROVIDER } : undefined;
}
