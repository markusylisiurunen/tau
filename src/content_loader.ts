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

interface MarkdownFile {
  name: string;
  content: string;
}

function parseMarkdownWithFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontMatter: {}, body: content };
  }

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

    if (trimmed.startsWith("- ")) {
      const item = trimmed.slice(2).trim();
      currentList.push(item);
      continue;
    }

    if (currentKey && currentList.length > 0) {
      result[currentKey] = currentList;
      currentList = [];
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      currentKey = line.substring(0, colonIndex).trim();
      const valueStr = line.substring(colonIndex + 1).trim();

      if (valueStr) {
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

function mergeById<T extends { id: string }>(base: T[], overlay: T[], overlay2?: T[]): T[] {
  const map = new Map<string, T>();

  for (const item of base) {
    map.set(item.id.toLowerCase(), item);
  }

  for (const item of overlay) {
    map.set(item.id.toLowerCase(), item);
  }

  if (overlay2) {
    for (const item of overlay2) {
      map.set(item.id.toLowerCase(), item);
    }
  }

  return Array.from(map.values());
}

function loadMarkdownFiles(dir: string): { files: MarkdownFile[]; error?: string } {
  if (!existsSync(dir)) {
    return { files: [] };
  }

  try {
    const names = readdirSync(dir).filter((f) => f.endsWith(".md"));
    return {
      files: names.map((name) => ({
        name,
        content: readFileSync(join(dir, name), "utf-8"),
      })),
    };
  } catch {
    return { files: [], error: `failed to read directory: ${dir}` };
  }
}

function parsePersona(
  file: string,
  content: string,
  forbiddenIds?: Set<string>,
): { persona?: Persona; error?: string } {
  const { frontMatter, body } = parseMarkdownWithFrontMatter(content);

  const id = frontMatter.id as string | undefined;
  const label = frontMatter.label as string | undefined;
  const provider = frontMatter.provider as string | undefined;
  const model = frontMatter.model as string | undefined;

  if (!id || !provider || !model) {
    return { error: `${file}: missing required fields (id, provider, model). skipped.` };
  }

  if (forbiddenIds?.has(id.toLowerCase())) {
    return { error: `${file}: persona id "${id}" conflicts with built-in. skipped.` };
  }

  const modelObj = resolveModel(provider, model);
  if (!modelObj) {
    return { error: `${file}: failed to load model "${provider}:${model}". skipped.` };
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

  return { persona };
}

function parsePrompt(
  file: string,
  content: string,
  forbiddenIds?: Set<string>,
): { prompt?: PromptTemplate; error?: string } {
  const { frontMatter, body } = parseMarkdownWithFrontMatter(content);

  const id = frontMatter.id as string | undefined;
  if (!id) {
    return { error: `${file}: missing required field 'id'. skipped.` };
  }

  if (forbiddenIds?.has(id.toLowerCase())) {
    return { error: `${file}: prompt id "${id}" conflicts with built-in. skipped.` };
  }

  const label = frontMatter.label as string | undefined;
  const description = frontMatter.description as string | undefined;

  const prompt: PromptTemplate = {
    id,
    template: body,
    ...(label && { label }),
    ...(description && { description }),
  };

  return { prompt };
}

export async function loadUserPersonas(): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const personasDir = join(configDir, "tau", "personas");
  const { files, error } = loadMarkdownFiles(personasDir);

  if (error) {
    return { personas: [], errors: [error] };
  }

  const builtinIds = new Set(builtinPersonas.map((p) => p.id.toLowerCase()));
  const personas: Persona[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const result = parsePersona(file.name, file.content, builtinIds);
    if (result.persona) {
      personas.push(result.persona);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { personas, errors };
}

export async function loadProjectPersonas(): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const personasDir = join(process.cwd(), ".tau", "personas");
  const { files, error } = loadMarkdownFiles(personasDir);

  if (error) {
    return { personas: [], errors: [error] };
  }

  const personas: Persona[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const result = parsePersona(file.name, file.content);
    if (result.persona) {
      personas.push(result.persona);
    } else if (result.error) {
      errors.push(result.error);
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
  const { files, error } = loadMarkdownFiles(promptsDir);

  if (error) {
    return { prompts: [], errors: [error] };
  }

  const builtinIds = new Set(builtinPrompts.map((p) => p.id.toLowerCase()));
  const prompts: PromptTemplate[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const result = parsePrompt(file.name, file.content, builtinIds);
    if (result.prompt) {
      prompts.push(result.prompt);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { prompts, errors };
}

export async function loadProjectPrompts(): Promise<{
  prompts: PromptTemplate[];
  errors: string[];
}> {
  const promptsDir = join(process.cwd(), ".tau", "prompts");
  const { files, error } = loadMarkdownFiles(promptsDir);

  if (error) {
    return { prompts: [], errors: [error] };
  }

  const prompts: PromptTemplate[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const result = parsePrompt(file.name, file.content);
    if (result.prompt) {
      prompts.push(result.prompt);
    } else if (result.error) {
      errors.push(result.error);
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
    const projectPersonasResult = await loadProjectPersonas();
    const userPromptsResult = await loadUserPrompts();
    const projectPromptsResult = await loadProjectPrompts();

    const allErrors = [
      ...userPersonasResult.errors,
      ...projectPersonasResult.errors,
      ...userPromptsResult.errors,
      ...projectPromptsResult.errors,
    ];

    return {
      personas: mergeById(
        builtinPersonas,
        userPersonasResult.personas,
        projectPersonasResult.personas,
      ),
      prompts: mergeById(builtinPrompts, userPromptsResult.prompts, projectPromptsResult.prompts),
      errors: allErrors,
    };
  } catch (err) {
    return {
      personas: builtinPersonas,
      prompts: builtinPrompts,
      errors: [`unexpected error loading user content: ${(err as Error).message}`],
    };
  }
}
