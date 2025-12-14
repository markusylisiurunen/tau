import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, KnownProvider, Model } from "@mariozechner/pi-ai";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { personas as builtinPersonas } from "./personas.js";
import type { PromptTemplate } from "./prompts.js";
import { prompts as builtinPrompts } from "./prompts.js";
import { BASH_TOOL } from "./tools/bash.js";
import { EDIT_TOOL } from "./tools/edit.js";
import { WRITE_TOOL } from "./tools/write.js";
import type { Persona, ReasoningEffort } from "./types.js";
import { REASONING_LEVELS } from "./types.js";

interface FrontMatter {
  [key: string]: unknown;
}

function parseMarkdownWithFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const lines = content.split("\n");

  // Check for opening delimiter
  if (lines[0]?.trim() !== "---") {
    return { frontMatter: {}, body: content };
  }

  // Find closing delimiter
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontMatter: {}, body: content };
  }

  const frontMatterLines = lines.slice(1, endIndex);
  const bodyLines = lines.slice(endIndex + 1);

  // Parse simple YAML
  const frontMatter = parseSimpleYaml(frontMatterLines.join("\n"));
  const body = bodyLines.join("\n").trim();

  return { frontMatter, body };
}

function parseSimpleYaml(yamlText: string): FrontMatter {
  const result: FrontMatter = {};
  const lines = yamlText.split("\n");

  let currentKey: string | undefined;
  let currentList: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // List item
    if (trimmed.startsWith("- ")) {
      const item = trimmed.slice(2).trim();
      currentList.push(item);
      continue;
    }

    // Finalize any pending list
    if (currentKey && currentList.length > 0) {
      result[currentKey] = currentList;
      currentList = [];
    }

    // Scalar key: value
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      currentKey = line.substring(0, colonIndex).trim();
      const valueStr = line.substring(colonIndex + 1).trim();

      if (valueStr) {
        // Parse value: treat as string by default
        // Simple heuristic: "true"/"false" -> boolean, numbers -> number
        if (valueStr.toLowerCase() === "true") {
          result[currentKey] = true;
        } else if (valueStr.toLowerCase() === "false") {
          result[currentKey] = false;
        } else if (!Number.isNaN(Number(valueStr))) {
          result[currentKey] = Number(valueStr);
        } else {
          result[currentKey] = valueStr;
        }
      }
    }
  }

  // Finalize pending list
  if (currentKey && currentList.length > 0) {
    result[currentKey] = currentList;
  }

  return result;
}

function isKnownProvider(value: string): value is KnownProvider {
  return getProviders().includes(value as KnownProvider);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_LEVELS.includes(value as ReasoningEffort);
}

function resolveModel(provider: string, modelId: string): Model<Api> | undefined {
  if (!isKnownProvider(provider)) return undefined;
  return getModels(provider).find((m) => m.id === modelId) as Model<Api> | undefined;
}

export async function loadUserPersonas(): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const personasDir = join(configDir, "tau", "personas");
  const personas: Persona[] = [];
  const errors: string[] = [];

  if (!existsSync(personasDir)) {
    return { personas, errors };
  }

  let files: string[] = [];
  try {
    files = readdirSync(personasDir).filter((f) => f.endsWith(".md"));
  } catch {
    errors.push(`failed to read personas directory: ${personasDir}`);
    return { personas, errors };
  }

  const builtinIds = new Set(builtinPersonas.map((p) => p.id.toLowerCase()));

  for (const file of files) {
    const filePath = join(personasDir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const { frontMatter, body } = parseMarkdownWithFrontMatter(content);

      // Validate required fields
      const id = frontMatter.id as string | undefined;
      const label = frontMatter.label as string | undefined;
      const provider = frontMatter.provider as string | undefined;
      const model = frontMatter.model as string | undefined;

      if (!id || !provider || !model) {
        errors.push(`${file}: missing required fields (id, provider, model). skipped.`);
        continue;
      }

      // Check for collision with built-ins
      if (builtinIds.has(id.toLowerCase())) {
        errors.push(`${file}: persona id "${id}" conflicts with built-in. skipped.`);
        continue;
      }

      try {
        const modelObj = resolveModel(provider, model);
        if (!modelObj) {
          errors.push(`${file}: failed to load model "${provider}:${model}". skipped.`);
          continue;
        }

        const description = frontMatter.description as string | undefined;
        const reasoningRaw = frontMatter.reasoning;
        const allowedReasoningLevelsRaw = frontMatter.allowedReasoningLevels;

        const settings: Persona["settings"] = {};
        if (isReasoningEffort(reasoningRaw)) {
          settings.reasoning = reasoningRaw;
        }

        const filteredReasoningLevels = Array.isArray(allowedReasoningLevelsRaw)
          ? allowedReasoningLevelsRaw.filter(isReasoningEffort)
          : undefined;

        const persona: Persona = {
          id,
          label: label || "custom",
          model: modelObj,
          systemPrompt: body,
          settings,
          tools: [BASH_TOOL, WRITE_TOOL, EDIT_TOOL],
          ...(description && { description }),
          ...(filteredReasoningLevels && filteredReasoningLevels.length > 0
            ? { allowedReasoningLevels: filteredReasoningLevels }
            : {}),
        };

        personas.push(persona);
      } catch (err) {
        errors.push(`${file}: failed to load persona. skipped.`);
      }
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }

  return { personas, errors };
}

export async function loadUserPrompts(): Promise<{
  prompts: PromptTemplate[];
  errors: string[];
}> {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const promptsDir = join(configDir, "tau", "prompts");
  const prompts: PromptTemplate[] = [];
  const errors: string[] = [];

  if (!existsSync(promptsDir)) {
    return { prompts, errors };
  }

  let files: string[] = [];
  try {
    files = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
  } catch {
    errors.push(`failed to read prompts directory: ${promptsDir}`);
    return { prompts, errors };
  }

  const builtinIds = new Set(builtinPrompts.map((p) => p.id.toLowerCase()));

  for (const file of files) {
    const filePath = join(promptsDir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const { frontMatter, body } = parseMarkdownWithFrontMatter(content);

      // Validate required fields
      const id = frontMatter.id as string | undefined;
      if (!id) {
        errors.push(`${file}: missing required field 'id'. skipped.`);
        continue;
      }

      // Check for collision with built-ins
      if (builtinIds.has(id.toLowerCase())) {
        errors.push(`${file}: prompt id "${id}" conflicts with built-in. skipped.`);
        continue;
      }

      const label = frontMatter.label as string | undefined;
      const description = frontMatter.description as string | undefined;

      const prompt: PromptTemplate = {
        id,
        template: body,
        ...(label && { label }),
        ...(description && { description }),
      };

      prompts.push(prompt);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }

  return { prompts, errors };
}

export async function loadAllContent(): Promise<{
  personas: Persona[];
  prompts: PromptTemplate[];
  errors: string[];
}> {
  try {
    const userPersonasResult = await loadUserPersonas();
    const userPromptsResult = await loadUserPrompts();

    const allErrors = [...userPersonasResult.errors, ...userPromptsResult.errors];

    return {
      personas: [...builtinPersonas, ...userPersonasResult.personas],
      prompts: [...builtinPrompts, ...userPromptsResult.prompts],
      errors: allErrors,
    };
  } catch (err) {
    // Safeguard: should not happen if loadUserPersonas/loadUserPrompts are robust,
    // but wrap to ensure we never throw during startup
    return {
      personas: builtinPersonas,
      prompts: builtinPrompts,
      errors: [`unexpected error loading user content: ${(err as Error).message}`],
    };
  }
}
