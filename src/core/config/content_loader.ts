import { basename, dirname, join, resolve, sep } from "node:path";
import type { Api, KnownProvider, Model, Tool } from "@mariozechner/pi-ai";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { personas as builtinPersonas } from "../personas.js";
import type { PromptTemplate } from "../prompts.js";
import type { SubagentConfigMap, SubagentPersonaConfig } from "../subagents/types.js";
import { BASH_TOOL } from "../tools/bash.js";
import { EDIT_TOOL } from "../tools/edit.js";
import { FORK_TOOL } from "../tools/fork.js";
import { TASK_TOOL } from "../tools/task_schema.js";
import { WRITE_TOOL } from "../tools/write.js";
import type { Persona, ReasoningEffort, Skill } from "../types.js";
import { ReasoningEffortSchema } from "../types.js";
import { formatZodError } from "../utils/zod.js";
import type { ConfigDeps } from "./deps.js";
import { createDefaultConfigDeps } from "./deps.js";
import type { ConfigLevel, ConfigLevelScope } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";
import type { Config } from "./schema.js";
import { buildVirtualBundle } from "./virtual_bundle.js";

interface FrontMatter {
  [key: string]: unknown;
}

interface MarkdownEntry {
  path: string;
  content: string;
}

type MarkdownPathsResult = {
  paths: string[];
  errors: string[];
};

interface JsonEntry {
  path: string;
  content: string;
}

type JsonPathsResult = {
  paths: string[];
  errors: string[];
};

export interface ThemeDefinition {
  id: string;
  tokens: Record<string, string>;
  sourcePath: string;
  scope: ConfigLevelScope;
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

  const frontMatter = parseYamlFrontMatter(frontMatterLines.join("\n"));
  const body = bodyLines.join("\n").trim();

  return { frontMatter, body };
}

function parseYamlFrontMatter(yamlText: string): FrontMatter {
  try {
    const parsed = parseYaml(yamlText) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as FrontMatter;
  } catch {
    return {};
  }
}

function isKnownProvider(value: string): value is KnownProvider {
  return getProviders().includes(value as KnownProvider);
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

const SubagentNameSchema = z.enum(["explore", "web"]);

const SubagentSpecSchema = z
  .object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoning: ReasoningEffortSchema.optional(),
  })
  .passthrough()
  .superRefine((spec, ctx) => {
    const hasProvider = spec.provider !== undefined;
    const hasModel = spec.model !== undefined;
    if (hasProvider !== hasModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "both provider and model are required if specified",
      });
    }
  });

// Union schema: either a list of subagent names or an object mapping names to specs
const SubagentConfigRawSchema = z.union([
  z.array(z.string()),
  z.record(SubagentNameSchema, z.union([z.undefined(), z.object({}).passthrough()])),
]);

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
    for (const nameRaw of subagentsRaw) {
      const nameParsed = SubagentNameSchema.safeParse(nameRaw);
      if (!nameParsed.success) {
        return { error: `invalid subagent: ${formatZodError(nameParsed.error)}` };
      }

      const name = nameParsed.data;
      // Enable with default settings (use main persona's model)
      config[name] = {};
    }
    return { config };
  }

  // Handle object with per-subagent config
  const configParsed = z.record(z.string(), z.unknown()).safeParse(subagentsRaw);
  if (configParsed.success) {
    for (const [name, specRaw] of Object.entries(configParsed.data)) {
      const nameParsed = SubagentNameSchema.safeParse(name);
      if (!nameParsed.success) {
        return { error: `invalid subagent: ${formatZodError(nameParsed.error)}` };
      }

      const validatedName = nameParsed.data;

      if (!specRaw || typeof specRaw !== "object") {
        // Empty config, will use defaults
        config[validatedName] = {};
        continue;
      }

      const spec = SubagentSpecSchema.safeParse(specRaw);
      if (!spec.success) {
        return { error: `subagent ${validatedName}: ${formatZodError(spec.error)}` };
      }

      const provider = spec.data.provider;
      const model = spec.data.model;

      // Resolve model if provided
      if (provider && model) {
        const modelObj = resolveModel(provider, model);
        if (!modelObj) {
          return {
            error: `subagent ${validatedName}: failed to resolve model "${provider}:${model}"`,
          };
        }

        config[validatedName] = {
          model: modelObj,
          ...(spec.data.reasoning !== undefined && spec.data.reasoning !== "none"
            ? { reasoning: spec.data.reasoning }
            : {}),
        };
      } else {
        // No model specified, will use main persona's model
        config[validatedName] = {
          ...(spec.data.reasoning !== undefined && spec.data.reasoning !== "none"
            ? { reasoning: spec.data.reasoning }
            : {}),
        };
      }
    }

    return { config };
  }

  return { error: "subagents must be a list or object" };
}

function parsePersonaTools(toolsRaw: unknown): { tools?: Tool[]; error?: string } {
  if (toolsRaw === undefined) {
    return {};
  }

  const parsed = toolsSchema.safeParse(toolsRaw);
  if (!parsed.success) {
    return { error: "tools must be a string or list of strings" };
  }

  if (parsed.data === undefined) {
    return {};
  }

  const rawList = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const cleaned = rawList.map((tool) => tool.trim().toLowerCase()).filter(Boolean);
  if (cleaned.length === 0) {
    return { tools: [] };
  }

  const selected: Tool[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const name of cleaned) {
    if (seen.has(name)) continue;
    seen.add(name);
    const tool = PERSONA_TOOL_DEFINITIONS.get(name);
    if (tool) {
      selected.push(tool);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    const allowed = Array.from(PERSONA_TOOL_DEFINITIONS.keys()).join(", ");
    return { error: `unknown tool(s): ${unknown.join(", ")}. allowed: ${allowed}` };
  }

  return { tools: selected };
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

function listMarkdownFiles(dir: string, deps: ConfigDeps): MarkdownPathsResult {
  try {
    const names = deps.fs.listDir(dir).filter((f) => f.endsWith(".md"));
    return { paths: names.map((name) => join(dir, name)), errors: [] };
  } catch {
    return { paths: [], errors: [`failed to read directory: ${dir}`] };
  }
}

function listJsonFiles(dir: string, deps: ConfigDeps): JsonPathsResult {
  try {
    const names = deps.fs.listDir(dir).filter((f) => f.endsWith(".json"));
    return { paths: names.map((name) => join(dir, name)), errors: [] };
  } catch {
    return { paths: [], errors: [`failed to read directory: ${dir}`] };
  }
}

function listSkillFiles(dir: string, deps: ConfigDeps): MarkdownPathsResult {
  let entries: string[];
  try {
    entries = deps.fs.listDir(dir);
  } catch {
    return { paths: [], errors: [`failed to read directory: ${dir}`] };
  }

  const paths: string[] = [];

  for (const entry of entries) {
    const skillDir = join(dir, entry);

    let isDir = false;
    try {
      isDir = deps.fs.stat(skillDir).isDirectory();
    } catch {
      continue;
    }

    if (!isDir) continue;

    const filePath = join(skillDir, "SKILL.md");
    if (!deps.fs.exists(filePath)) continue;

    paths.push(filePath);
  }

  return { paths, errors: [] };
}

function loadMarkdownEntries(
  dir: string,
  deps: ConfigDeps,
  listFiles: (dir: string, deps: ConfigDeps) => MarkdownPathsResult,
): { entries: MarkdownEntry[]; errors: string[] } {
  if (!deps.fs.exists(dir)) {
    return { entries: [], errors: [] };
  }

  const { paths, errors } = listFiles(dir, deps);
  const entries: MarkdownEntry[] = [];

  for (const path of paths) {
    try {
      entries.push({ path, content: deps.fs.readFile(path) });
    } catch {
      errors.push(`failed to read file: ${path}`);
    }
  }

  return { entries, errors };
}

function loadJsonEntries(
  dir: string,
  deps: ConfigDeps,
  listFiles: (dir: string, deps: ConfigDeps) => JsonPathsResult,
): { entries: JsonEntry[]; errors: string[] } {
  if (!deps.fs.exists(dir)) {
    return { entries: [], errors: [] };
  }

  const { paths, errors } = listFiles(dir, deps);
  const entries: JsonEntry[] = [];

  for (const path of paths) {
    try {
      entries.push({ path, content: deps.fs.readFile(path) });
    } catch {
      errors.push(`failed to read file: ${path}`);
    }
  }

  return { entries, errors };
}

function resolveContentContext(options?: {
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
  cwd?: string;
}): { deps: ConfigDeps; levels: ConfigLevel[] } {
  const deps = options?.deps ?? createDefaultConfigDeps();
  const levels = options?.levels ?? resolveConfigLevels(deps, { cwd: options?.cwd });
  return { deps, levels };
}

const personaFrontMatterSchema = z
  .object({
    id: z.string().trim().min(1),
    extends: z.string().trim().min(1).optional(),
    label: z.string().trim().optional(),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    description: z.string().trim().optional(),
    reasoning: ReasoningEffortSchema.optional(),
    allowedReasoningLevels: z.array(ReasoningEffortSchema).optional(),
    skills: z.unknown().optional(),
    subagents: z.unknown().optional(),
    tools: z.unknown().optional(),
  })
  .passthrough();

const skillsSchema = z.union([z.literal("*"), z.string(), z.array(z.string())]).optional();

const promptFrontMatterSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().optional(),
    description: z.string().trim().optional(),
  })
  .passthrough();

const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const skillDescriptionSchema = z.string().trim().min(1).max(1024);

const skillFrontMatterSchema = z
  .object({
    name: skillNameSchema,
    description: skillDescriptionSchema,
    license: z.string().trim().min(1).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().trim().min(1).optional(),
  })
  .passthrough();

const toolsSchema = z.union([z.string(), z.array(z.string())]).optional();

const PERSONA_TOOL_DEFINITIONS = new Map([
  ["bash", BASH_TOOL],
  ["write", WRITE_TOOL],
  ["edit", EDIT_TOOL],
  ["task", TASK_TOOL],
  ["fork", FORK_TOOL],
]);

const DEFAULT_PERSONA_TOOLS = [BASH_TOOL, WRITE_TOOL, EDIT_TOOL];

function parsePersona(
  file: string,
  content: string,
  source: "user" | "project",
  basePersonasById?: Map<string, Persona>,
): { persona?: Persona; error?: string } {
  const { frontMatter, body } = parseMarkdownWithFrontMatter(content);

  const parsedFrontMatter = personaFrontMatterSchema.safeParse(frontMatter);
  if (!parsedFrontMatter.success) {
    return { error: `${file}: missing required fields (id, provider, model). skipped.` };
  }

  const { id, extends: extendsId, label, provider, model, description } = parsedFrontMatter.data;
  const fileId = basename(file, ".md");
  if (fileId && id !== fileId) {
    return {
      error: `${file}: frontmatter id "${id}" must match file name "${fileId}". skipped.`,
    };
  }
  const reasoning = parsedFrontMatter.data.reasoning;
  const allowedReasoningLevels = parsedFrontMatter.data.allowedReasoningLevels;
  const skillsRaw = parsedFrontMatter.data.skills;
  const subagentsRaw = parsedFrontMatter.data.subagents;
  const toolsRaw = parsedFrontMatter.data.tools;

  const basePersona = extendsId ? basePersonasById?.get(extendsId.toLowerCase()) : undefined;

  if (extendsId && !basePersona) {
    return { error: `${file}: extends "${extendsId}" not found. skipped.` };
  }

  const modelObj = resolveModel(provider, model);
  if (!modelObj) {
    return { error: `${file}: failed to load model "${provider}:${model}". skipped.` };
  }

  const settings: Persona["settings"] = basePersona ? { ...basePersona.settings } : {};
  if (reasoning) {
    settings.reasoning = reasoning;
  }

  if (modelObj.provider !== "openai" && settings.serviceTier !== undefined) {
    delete settings.serviceTier;
  }

  const { serviceTier: _serviceTier, ...subagentBaseSettings } = settings;

  let skills: string[] | "*" | undefined;
  if (skillsRaw === undefined && basePersona?.skills !== undefined) {
    skills = Array.isArray(basePersona.skills) ? [...basePersona.skills] : basePersona.skills;
  } else {
    const skillsParsed = skillsSchema.safeParse(skillsRaw);

    if (skillsParsed.success) {
      const val = skillsParsed.data;

      if (val === "*") {
        skills = "*";
      } else if (typeof val === "string") {
        const trimmed = val.trim();
        skills = trimmed ? [trimmed] : undefined;
      } else if (Array.isArray(val)) {
        const trimmed = val.map((s) => s.trim()).filter(Boolean);
        skills = trimmed.length > 0 ? trimmed : undefined;
      }
    } else if (skillsRaw !== undefined) {
      if (Array.isArray(skillsRaw)) {
        return { error: `${file}: skills must contain only strings. skipped.` };
      }
      return { error: `${file}: skills must be a string, "*", or list of strings. skipped.` };
    }
  }

  // Parse subagents
  const subagentsResult = parseSubagentConfig(subagentsRaw);
  if (subagentsResult.error) {
    return { error: `${file}: ${subagentsResult.error}. skipped.` };
  }

  const toolsResult = parsePersonaTools(toolsRaw);
  if (toolsResult.error) {
    return { error: `${file}: ${toolsResult.error}. skipped.` };
  }

  // Fill in main persona's model for subagents that don't specify one
  let finalSubagents: SubagentConfigMap | undefined;
  if (subagentsRaw === undefined) {
    if (basePersona?.subagents) {
      finalSubagents = {};

      for (const [name, cfg] of Object.entries(basePersona.subagents)) {
        if (!isSubagentName(name) || !cfg) continue;

        finalSubagents[name] = {
          model: modelObj,
          ...(cfg.settings ? { settings: cfg.settings } : { settings: subagentBaseSettings }),
        };
      }

      if (Object.keys(finalSubagents).length === 0) {
        finalSubagents = undefined;
      }
    }
  } else if (subagentsResult.config && Object.keys(subagentsResult.config).length > 0) {
    finalSubagents = {};

    for (const [name, cfg] of Object.entries(subagentsResult.config)) {
      if (!isSubagentName(name)) continue; // Validate name is a known subagent
      const subagentModel = cfg.model ?? modelObj;

      let subagentSettings: SubagentPersonaConfig["settings"] | undefined;
      if (cfg.reasoning !== undefined) {
        subagentSettings = { reasoning: cfg.reasoning };
      } else {
        subagentSettings = subagentBaseSettings;
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

  const defaultTools = finalSubagents
    ? [...DEFAULT_PERSONA_TOOLS, TASK_TOOL]
    : DEFAULT_PERSONA_TOOLS;

  const inheritedTools = toolsRaw === undefined ? basePersona?.tools : undefined;
  const tools = toolsResult.tools ?? inheritedTools ?? defaultTools;

  const finalLabel = label || basePersona?.label || "custom";
  const finalDescription = description ?? basePersona?.description;
  const finalSystemPrompt = body.trim() ? body : (basePersona?.systemPrompt ?? body);

  const finalAllowedReasoningLevels =
    allowedReasoningLevels && allowedReasoningLevels.length > 0
      ? allowedReasoningLevels
      : basePersona?.allowedReasoningLevels;

  const persona: Persona = {
    id,
    label: finalLabel,
    model: modelObj,
    systemPrompt: finalSystemPrompt,
    settings,
    tools,
    ...(finalDescription && { description: finalDescription }),
    ...(finalAllowedReasoningLevels ? { allowedReasoningLevels: finalAllowedReasoningLevels } : {}),
    ...(finalSubagents && { subagents: finalSubagents }),
    ...(skills && { skills }),
    source,
  };

  return { persona };
}

function parsePrompt(file: string, content: string): { prompt?: PromptTemplate; error?: string } {
  const { frontMatter, body } = parseMarkdownWithFrontMatter(content);

  const parsedFrontMatter = promptFrontMatterSchema.safeParse(frontMatter);
  if (!parsedFrontMatter.success) {
    return { error: `${file}: missing required field 'id'. skipped.` };
  }

  const { id, label, description } = parsedFrontMatter.data;
  const fileId = basename(file, ".md");
  if (fileId && id !== fileId) {
    return {
      error: `${file}: frontmatter id "${id}" must match file name "${fileId}". skipped.`,
    };
  }

  const prompt: PromptTemplate = {
    id,
    template: body,
    ...(label && { label }),
    ...(description && { description }),
  };

  return { prompt };
}

function parseTheme(
  entry: JsonEntry,
  scope: ConfigLevelScope,
): {
  theme?: ThemeDefinition;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.content) as unknown;
  } catch (err) {
    return {
      error: `${entry.path}: failed to parse json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${entry.path}: theme must be a json object of palette tokens.` };
  }

  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      continue;
    }
    const cleanedKey = key.trim();
    const cleanedValue = value.trim();
    if (!cleanedKey) continue;
    tokens[cleanedKey] = cleanedValue;
  }

  const id = basename(entry.path, ".json").trim();
  if (!id) {
    return { error: `${entry.path}: theme id is missing.` };
  }

  return {
    theme: {
      id,
      tokens,
      sourcePath: entry.path,
      scope,
    },
  };
}

export async function loadUserPersonas(args?: {
  basePersonasById?: Map<string, Persona>;
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
  cwd?: string;
}): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args?.deps,
    levels: args?.levels,
    cwd: args?.cwd,
  });
  const globalLevel = levels.find((level) => level.scope === "global");
  if (!globalLevel) {
    return { personas: [], errors: [] };
  }
  const personasDir = globalLevel.personasDir;
  const { entries, errors } = loadMarkdownEntries(personasDir, deps, listMarkdownFiles);

  const personas: Persona[] = [];

  const basePersonasById =
    args?.basePersonasById ?? new Map(builtinPersonas.map((p) => [p.id.toLowerCase(), p] as const));

  for (const file of entries) {
    const result = parsePersona(file.path, file.content, "user", basePersonasById);
    if (result.persona) {
      personas.push(result.persona);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { personas, errors };
}

export async function loadProjectPersonas(args?: {
  basePersonasById?: Map<string, Persona>;
  cwd?: string;
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
}): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args?.deps,
    levels: args?.levels,
    cwd: args?.cwd,
  });

  const projectLevels = levels.filter((level) => level.scope === "project");
  if (projectLevels.length === 0) {
    return { personas: [], errors: [] };
  }

  const personas: Persona[] = [];
  const errors: string[] = [];

  const basePersonasById =
    args?.basePersonasById ?? new Map(builtinPersonas.map((p) => [p.id.toLowerCase(), p] as const));

  // Parent-first order, closest directory wins on conflicts.
  for (const level of projectLevels) {
    const { entries, errors: entryErrors } = loadMarkdownEntries(
      level.personasDir,
      deps,
      listMarkdownFiles,
    );
    errors.push(...entryErrors);

    for (const file of entries) {
      const result = parsePersona(file.path, file.content, "project", basePersonasById);
      if (result.persona) {
        personas.push(result.persona);
      } else if (result.error) {
        errors.push(result.error);
      }
    }
  }

  return { personas, errors };
}

export async function loadUserPrompts(args?: {
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
  cwd?: string;
}): Promise<{
  prompts: PromptTemplate[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args?.deps,
    levels: args?.levels,
    cwd: args?.cwd,
  });
  const globalLevel = levels.find((level) => level.scope === "global");
  if (!globalLevel) {
    return { prompts: [], errors: [] };
  }
  const promptsDir = globalLevel.promptsDir;
  const { entries, errors } = loadMarkdownEntries(promptsDir, deps, listMarkdownFiles);

  const prompts: PromptTemplate[] = [];

  for (const file of entries) {
    const result = parsePrompt(file.path, file.content);
    if (result.prompt) {
      prompts.push(result.prompt);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { prompts, errors };
}

export async function loadProjectPrompts(args?: {
  cwd?: string;
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
}): Promise<{
  prompts: PromptTemplate[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args?.deps,
    levels: args?.levels,
    cwd: args?.cwd,
  });

  const projectLevels = levels.filter((level) => level.scope === "project");
  if (projectLevels.length === 0) {
    return { prompts: [], errors: [] };
  }

  const prompts: PromptTemplate[] = [];
  const errors: string[] = [];

  // Parent-first order, closest directory wins on conflicts.
  for (const level of projectLevels) {
    const { entries, errors: entryErrors } = loadMarkdownEntries(
      level.promptsDir,
      deps,
      listMarkdownFiles,
    );
    errors.push(...entryErrors);

    for (const file of entries) {
      const result = parsePrompt(file.path, file.content);
      if (result.prompt) {
        prompts.push(result.prompt);
      } else if (result.error) {
        errors.push(result.error);
      }
    }
  }

  return { prompts, errors };
}

export async function loadUserThemes(args?: {
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
  cwd?: string;
}): Promise<{
  themes: ThemeDefinition[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args?.deps,
    levels: args?.levels,
    cwd: args?.cwd,
  });
  const globalLevel = levels.find((level) => level.scope === "global");
  if (!globalLevel) {
    return { themes: [], errors: [] };
  }
  const { entries, errors } = loadJsonEntries(globalLevel.themesDir, deps, listJsonFiles);

  const themes: ThemeDefinition[] = [];

  for (const entry of entries) {
    const result = parseTheme(entry, "global");
    if (result.theme) {
      themes.push(result.theme);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { themes, errors };
}

export async function loadProjectThemes(args?: {
  cwd?: string;
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
}): Promise<{
  themes: ThemeDefinition[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args?.deps,
    levels: args?.levels,
    cwd: args?.cwd,
  });

  const projectLevels = levels.filter((level) => level.scope === "project");
  if (projectLevels.length === 0) {
    return { themes: [], errors: [] };
  }

  const themes: ThemeDefinition[] = [];
  const errors: string[] = [];

  // Parent-first order, closest directory wins on conflicts.
  for (const level of projectLevels) {
    const { entries, errors: entryErrors } = loadJsonEntries(level.themesDir, deps, listJsonFiles);
    errors.push(...entryErrors);

    for (const entry of entries) {
      const result = parseTheme(entry, "project");
      if (result.theme) {
        themes.push(result.theme);
      } else if (result.error) {
        errors.push(result.error);
      }
    }
  }

  return { themes, errors };
}

function parseSkill(filePath: string, content: string): { skill?: Skill; error?: string } {
  const { frontMatter } = parseMarkdownWithFrontMatter(content);

  const parsedFrontMatter = skillFrontMatterSchema.safeParse(frontMatter);
  if (!parsedFrontMatter.success) {
    return {
      error: `${filePath}: invalid frontmatter (name/description required, and must follow the skills spec). skipped.`,
    };
  }

  const dirName = dirname(filePath).split(sep).pop();
  if (dirName && parsedFrontMatter.data.name !== dirName) {
    return {
      error: `${filePath}: frontmatter name "${parsedFrontMatter.data.name}" must match directory name "${dirName}". skipped.`,
    };
  }

  return {
    skill: {
      name: parsedFrontMatter.data.name,
      description: parsedFrontMatter.data.description,
      path: resolve(filePath),
    },
  };
}

export async function loadUserSkills(args?: {
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
  cwd?: string;
}): Promise<{
  skills: Skill[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args?.deps,
    levels: args?.levels,
    cwd: args?.cwd,
  });
  const globalLevel = levels.find((level) => level.scope === "global");
  if (!globalLevel) {
    return { skills: [], errors: [] };
  }
  const { entries, errors } = loadMarkdownEntries(globalLevel.skillsDir, deps, listSkillFiles);
  const skills: Skill[] = [];

  for (const entry of entries) {
    const result = parseSkill(entry.path, entry.content);
    if (result.skill) {
      skills.push(result.skill);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { skills, errors };
}

export async function loadProjectSkills(args?: {
  cwd?: string;
  deps?: ConfigDeps;
  levels?: ConfigLevel[];
}): Promise<{
  skills: Skill[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args?.deps,
    levels: args?.levels,
    cwd: args?.cwd,
  });
  const projectLevels = levels.filter((level) => level.scope === "project");
  if (projectLevels.length === 0) {
    return { skills: [], errors: [] };
  }

  const skills: Skill[] = [];
  const errors: string[] = [];

  // Parent-first order, closest directory wins on conflicts.
  for (const level of projectLevels) {
    const { entries, errors: entryErrors } = loadMarkdownEntries(
      level.skillsDir,
      deps,
      listSkillFiles,
    );
    errors.push(...entryErrors);

    for (const entry of entries) {
      const result = parseSkill(entry.path, entry.content);
      if (result.skill) {
        skills.push(result.skill);
      } else if (result.error) {
        errors.push(result.error);
      }
    }
  }

  return { skills, errors };
}

export async function loadAllContent(
  config?: Config,
  options?: { cwd?: string; deps?: ConfigDeps; levels?: ConfigLevel[] },
): Promise<{
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  themes: ThemeDefinition[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: options?.deps,
    levels: options?.levels,
    cwd: options?.cwd,
  });

  const virtualBundle = buildVirtualBundle(config ?? {}, deps);

  try {
    const basePersonasById = new Map(builtinPersonas.map((p) => [p.id.toLowerCase(), p] as const));

    const userPersonasResult = await loadUserPersonas({
      basePersonasById,
      deps,
      levels,
    });
    const projectPersonasResult = await loadProjectPersonas({ basePersonasById, deps, levels });
    const userPromptsResult = await loadUserPrompts({ deps, levels });
    const projectPromptsResult = await loadProjectPrompts({ deps, levels });
    const userSkillsResult = await loadUserSkills({ deps, levels });
    const projectSkillsResult = await loadProjectSkills({ deps, levels });
    const userThemesResult = await loadUserThemes({ deps, levels });
    const projectThemesResult = await loadProjectThemes({ deps, levels });

    const allErrors = [
      ...userPersonasResult.errors,
      ...projectPersonasResult.errors,
      ...userPromptsResult.errors,
      ...projectPromptsResult.errors,
      ...userSkillsResult.errors,
      ...projectSkillsResult.errors,
      ...userThemesResult.errors,
      ...projectThemesResult.errors,
    ];

    const skillsByName = new Map<string, Skill>();
    for (const skill of virtualBundle.skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }
    for (const skill of userSkillsResult.skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }
    for (const skill of projectSkillsResult.skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }

    const skills = Array.from(skillsByName.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    // Precedence: virtual bundle < global < nearest .tau levels.
    return {
      personas: mergeById(
        virtualBundle.personas,
        userPersonasResult.personas,
        projectPersonasResult.personas,
      ),
      prompts: mergeById(
        virtualBundle.prompts,
        userPromptsResult.prompts,
        projectPromptsResult.prompts,
      ),
      skills,
      themes: mergeById(virtualBundle.themes, userThemesResult.themes, projectThemesResult.themes),
      errors: allErrors,
    };
  } catch (err) {
    return {
      personas: virtualBundle.personas,
      prompts: virtualBundle.prompts,
      skills: virtualBundle.skills,
      themes: virtualBundle.themes,
      errors: [`unexpected error loading user content: ${(err as Error).message}`],
    };
  }
}
