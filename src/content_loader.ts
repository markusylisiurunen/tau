import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, KnownProvider, Model } from "@mariozechner/pi-ai";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { personas as builtinPersonas } from "./personas.js";
import type { PromptTemplate } from "./prompts.js";
import { prompts as builtinPrompts } from "./prompts.js";
import type { SubagentConfigMap, SubagentPersonaConfig } from "./subagents/types.js";
import { BASH_TOOL } from "./tools/bash.js";
import { EDIT_TOOL } from "./tools/edit.js";
import { TASK_TOOL } from "./tools/task.js";
import { WRITE_TOOL } from "./tools/write.js";
import type { Persona, ReasoningEffort, Skill } from "./types.js";
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

function isSubagentName(value: unknown): value is "explore" | "web" {
  return value === "explore" || value === "web";
}

interface PartialSubagentConfig {
  [name: string]: {
    model?: Model<Api>;
    reasoning?: ReasoningEffort;
  };
}

function parseSubagentConfig(subagentsRaw: unknown): {
  config?: PartialSubagentConfig;
  error?: string;
} {
  if (!subagentsRaw) {
    return {};
  }

  const config: PartialSubagentConfig = {};

  // Handle list of subagent names
  if (Array.isArray(subagentsRaw)) {
    for (const name of subagentsRaw) {
      if (typeof name !== "string") {
        return { error: "subagents list must contain only strings" };
      }
      if (!isSubagentName(name)) {
        return { error: `unknown subagent: ${name}` };
      }
      // Enable with default settings (use main persona's model)
      config[name] = {};
    }
    return { config };
  }

  // Handle object with per-subagent config
  if (typeof subagentsRaw === "object" && subagentsRaw !== null) {
    for (const [name, spec] of Object.entries(subagentsRaw)) {
      if (!isSubagentName(name)) {
        return { error: `unknown subagent: ${name}` };
      }

      if (!spec || typeof spec !== "object") {
        // Empty config, will use defaults
        config[name] = {};
        continue;
      }

      const specObj = spec as Record<string, unknown>;
      const provider = specObj.provider as string | undefined;
      const model = specObj.model as string | undefined;
      const reasoning = specObj.reasoning;

      // Resolve model if provided
      if (provider || model) {
        if (!provider || !model) {
          return {
            error: `subagent ${name}: both provider and model are required if specified`,
          };
        }

        const modelObj = resolveModel(provider, model);
        if (!modelObj) {
          return {
            error: `subagent ${name}: failed to resolve model "${provider}:${model}"`,
          };
        }

        config[name] = {
          model: modelObj,
          ...(isReasoningEffort(reasoning) && reasoning !== "none" && { reasoning }),
        };
      } else {
        // No model specified, will use main persona's model
        config[name] = {};
      }
    }
    return { config };
  }

  return { error: "subagents must be a list or object" };
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

  const skillsRaw = frontMatter.skills;
  let skills: string[] | "*" | undefined;
  if (typeof skillsRaw === "string") {
    const trimmed = skillsRaw.trim();
    if (trimmed === "*") {
      skills = "*";
    } else {
      skills = trimmed ? [trimmed] : undefined;
    }
  } else if (Array.isArray(skillsRaw)) {
    for (const skill of skillsRaw) {
      if (typeof skill !== "string") {
        return { error: `${file}: skills must contain only strings. skipped.` };
      }
    }
    const trimmed = skillsRaw.map((s) => s.trim()).filter(Boolean);
    skills = trimmed.length > 0 ? trimmed : undefined;
  } else if (skillsRaw !== undefined) {
    return { error: `${file}: skills must be a string, "*", or list of strings. skipped.` };
  }

  // Parse subagents
  const subagentsResult = parseSubagentConfig(frontMatter.subagents);
  if (subagentsResult.error) {
    return { error: `${file}: ${subagentsResult.error}. skipped.` };
  }

  // Fill in main persona's model for subagents that don't specify one
  let finalSubagents: SubagentConfigMap | undefined;
  if (subagentsResult.config && Object.keys(subagentsResult.config).length > 0) {
    finalSubagents = {};
    for (const [name, cfg] of Object.entries(subagentsResult.config)) {
      if (!isSubagentName(name)) continue; // Validate name is a known subagent
      const subagentModel = cfg.model ?? modelObj;

      let subagentSettings: SubagentPersonaConfig["settings"] | undefined;
      if (cfg.reasoning !== undefined) {
        subagentSettings = cfg.reasoning === "none" ? {} : { reasoning: cfg.reasoning };
      } else if (Object.keys(settings).length > 0) {
        const { reasoning, ...rest } = settings;
        subagentSettings = {
          ...rest,
          ...(reasoning && reasoning !== "none" ? { reasoning } : {}),
        };
      }

      finalSubagents[name] = {
        model: subagentModel,
        ...(subagentSettings && { settings: subagentSettings }),
      };
    }

    if (Object.keys(finalSubagents).length === 0) {
      finalSubagents = undefined;
    }
  }

  const tools = finalSubagents
    ? [BASH_TOOL, WRITE_TOOL, EDIT_TOOL, TASK_TOOL]
    : [BASH_TOOL, WRITE_TOOL, EDIT_TOOL];

  const persona: Persona = {
    id,
    label: label || "custom",
    model: modelObj,
    systemPrompt: body,
    settings,
    tools,
    ...(description && { description }),
    ...(filteredReasoningLevels && filteredReasoningLevels.length > 0
      ? { allowedReasoningLevels: filteredReasoningLevels }
      : {}),
    ...(finalSubagents && { subagents: finalSubagents }),
    ...(skills && { skills }),
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

function parseSkill(filePath: string, content: string): { skill?: Skill; error?: string } {
  const { frontMatter } = parseMarkdownWithFrontMatter(content);

  const name = typeof frontMatter.name === "string" ? frontMatter.name.trim() : "";
  const description =
    typeof frontMatter.description === "string" ? frontMatter.description.trim() : "";

  if (!name || !description) {
    return { error: `${filePath}: missing required fields (name, description). skipped.` };
  }

  return {
    skill: {
      name,
      description,
      path: resolve(filePath),
    },
  };
}

function loadSkillsFromDir(skillsDir: string): { skills: Skill[]; errors: string[] } {
  if (!existsSync(skillsDir)) {
    return { skills: [], errors: [] };
  }

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return { skills: [], errors: [`failed to read directory: ${skillsDir}`] };
  }

  const skills: Skill[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
    const filePath = join(skillsDir, entry, "SKILL.md");
    if (!existsSync(filePath)) continue;

    let content = "";
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      errors.push(`failed to read file: ${filePath}`);
      continue;
    }

    const result = parseSkill(filePath, content);
    if (result.skill) {
      skills.push(result.skill);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { skills, errors };
}

export async function loadUserSkills(): Promise<{
  skills: Skill[];
  errors: string[];
}> {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const skillsDir = join(configDir, "tau", "skills");
  return loadSkillsFromDir(skillsDir);
}

export async function loadProjectSkills(): Promise<{
  skills: Skill[];
  errors: string[];
}> {
  const skillsDir = join(process.cwd(), ".tau", "skills");
  return loadSkillsFromDir(skillsDir);
}

export async function loadAllContent(): Promise<{
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  errors: string[];
}> {
  try {
    const userPersonasResult = await loadUserPersonas();
    const projectPersonasResult = await loadProjectPersonas();
    const userPromptsResult = await loadUserPrompts();
    const projectPromptsResult = await loadProjectPrompts();
    const userSkillsResult = await loadUserSkills();
    const projectSkillsResult = await loadProjectSkills();

    const allErrors = [
      ...userPersonasResult.errors,
      ...projectPersonasResult.errors,
      ...userPromptsResult.errors,
      ...projectPromptsResult.errors,
      ...userSkillsResult.errors,
      ...projectSkillsResult.errors,
    ];

    const skillsByName = new Map<string, Skill>();
    for (const skill of userSkillsResult.skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }
    for (const skill of projectSkillsResult.skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }

    const skills = Array.from(skillsByName.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    return {
      personas: mergeById(
        builtinPersonas,
        userPersonasResult.personas,
        projectPersonasResult.personas,
      ),
      prompts: mergeById(builtinPrompts, userPromptsResult.prompts, projectPromptsResult.prompts),
      skills,
      errors: allErrors,
    };
  } catch (err) {
    return {
      personas: builtinPersonas,
      prompts: builtinPrompts,
      skills: [],
      errors: [`unexpected error loading user content: ${(err as Error).message}`],
    };
  }
}
