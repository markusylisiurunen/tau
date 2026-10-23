export const CLAUDE_CODE_PROVIDER = "claude-code";

export const CLAUDE_CODE_MODEL_IDS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;
export type ClaudeCodeModel = {
  provider: typeof CLAUDE_CODE_PROVIDER;
  id: (typeof CLAUDE_CODE_MODEL_IDS)[number];
};

export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function resolveClaudeCodeModel(id: string): ClaudeCodeModel | undefined {
  const modelId = CLAUDE_CODE_MODEL_IDS.find((candidate) => candidate === id);
  return modelId ? { provider: CLAUDE_CODE_PROVIDER, id: modelId } : undefined;
}
