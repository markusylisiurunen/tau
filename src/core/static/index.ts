import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{([a-zA-Z0-9_]+)\}\}/g;

const STATIC_PROMPT_PATHS = {
  "default-subagent-wrapper": "./prompts/default-subagent-wrapper.md",
  "diff-review-wrapper": "./prompts/diff-review-wrapper.md",
} as const;

export type StaticPromptId = keyof typeof STATIC_PROMPT_PATHS;

export function getStaticPromptPath(promptId: StaticPromptId): string {
  return fileURLToPath(new URL(STATIC_PROMPT_PATHS[promptId], import.meta.url));
}

export function loadStaticPrompt(promptId: StaticPromptId): string {
  return readFileSync(getStaticPromptPath(promptId), "utf8");
}

function interpolateTemplate(template: string, values: Record<string, string>): string {
  const templatePlaceholders = Array.from(template.matchAll(TEMPLATE_PLACEHOLDER_PATTERN))
    .map((match) => match[1])
    .filter((key): key is string => typeof key === "string");
  const uniqueTemplatePlaceholders = new Set(templatePlaceholders);

  const missingPlaceholders = Object.keys(values)
    .filter((key) => !uniqueTemplatePlaceholders.has(key))
    .map((key) => `{{${key}}}`);
  if (missingPlaceholders.length > 0) {
    throw new Error(`template is missing placeholders: ${missingPlaceholders.join(", ")}`);
  }

  const unresolvedPlaceholders = Array.from(uniqueTemplatePlaceholders)
    .filter((key) => !Object.hasOwn(values, key))
    .map((key) => `{{${key}}}`);
  if (unresolvedPlaceholders.length > 0) {
    throw new Error(`template has unresolved placeholders: ${unresolvedPlaceholders.join(", ")}`);
  }

  return template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (_match, key: string) => values[key] ?? "");
}

const DEFAULT_SUBAGENT_WRAPPER_PROMPT = loadStaticPrompt("default-subagent-wrapper").trim();
const DIFF_REVIEW_WRAPPER_PROMPT = loadStaticPrompt("diff-review-wrapper").trim();

export function loadDefaultSubagentWrapperPrompt(): string {
  return DEFAULT_SUBAGENT_WRAPPER_PROMPT;
}

export function loadDiffReviewWrapperPrompt(): string {
  return DIFF_REVIEW_WRAPPER_PROMPT;
}

export function renderDefaultSubagentWrapperPrompt(args: {
  inheritedInstructions: string;
}): string {
  return interpolateTemplate(DEFAULT_SUBAGENT_WRAPPER_PROMPT, {
    inherited_instructions: args.inheritedInstructions.trim(),
  });
}

export function renderDiffReviewWrapperPrompt(args: {
  inheritedInstructions: string;
  reviewContext: string;
}): string {
  return interpolateTemplate(DIFF_REVIEW_WRAPPER_PROMPT, {
    inherited_instructions: args.inheritedInstructions.trim(),
    review_context: args.reviewContext.trim(),
  });
}
