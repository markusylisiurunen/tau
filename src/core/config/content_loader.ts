import { basename, dirname, join, resolve, sep } from "node:path";
import type { Api, KnownProvider, Model, Tool } from "@mariozechner/pi-ai";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { personas as builtinPersonas } from "../personas.js";
import type { PromptTemplate } from "../prompts.js";
import type {
  SubagentConfigMap,
  SubagentPersonaConfig,
  SubagentToolName,
} from "../subagents/types.js";
import { DEFAULT_SUBAGENT_NAME, SUBAGENT_TOOL_NAMES } from "../subagents/types.js";
import { BASH_TOOL } from "../tools/bash.js";
import { EDIT_TOOL } from "../tools/edit.js";
import { SEND_INPUT_TO_AGENT_TOOL } from "../tools/send_input_to_agent.js";
import { SPAWN_AGENT_TOOL } from "../tools/spawn_agent.js";
import { TERMINATE_AGENT_TOOL } from "../tools/terminate_agent.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_TERMINATE_AGENT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WAIT_FOR_AGENT,
  TOOL_NAME_WRITE,
} from "../tools/tool_names.js";
import { VIEW_IMAGE_TOOL } from "../tools/view_image.js";
import { WAIT_FOR_AGENT_TOOL } from "../tools/wait_for_agent.js";
import { WRITE_TOOL } from "../tools/write.js";
import type { Persona, Skill } from "../types.js";
import { ReasoningEffortSchema, RiskLevelSchema } from "../types.js";
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

interface FileEntry {
  path: string;
  content: string;
}

type MarkdownEntry = FileEntry;

type MarkdownPathsResult = {
  paths: string[];
  errors: string[];
};

type JsonEntry = FileEntry;

type JsonPathsResult = {
  paths: string[];
  errors: string[];
};

export type ThemeAppearance = "dark" | "light";

export type ThemeVariantTokens = Partial<Record<ThemeAppearance, Record<string, string>>>;

export interface ThemeDefinition {
  id: string;
  tokens: Record<string, string>;
  variants?: ThemeVariantTokens;
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

interface PartialSubagentConfig {
  [name: string]: SubagentPersonaConfig;
}

const SubagentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

type SubagentName = z.infer<typeof SubagentNameSchema>;

function parseSubagentName(value: unknown): { name: SubagentName } | { error: string } {
  const parsed = SubagentNameSchema.safeParse(value);
  if (!parsed.success) {
    return { error: `invalid subagent: ${formatZodError(parsed.error)}` };
  }

  return { name: parsed.data };
}

const SubagentSpecSchema = z
  .object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoning: ReasoningEffortSchema.optional(),
    tools: z.unknown().optional(),
    riskLevel: RiskLevelSchema.optional(),
    systemPrompt: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
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

const subagentToolsSchema = z.union([z.string(), z.array(z.string())]).optional();

const SUBAGENT_TOOL_NAME_SET = new Set<SubagentToolName>(SUBAGENT_TOOL_NAMES);

function parseSubagentTools(toolsRaw: unknown): { tools?: SubagentToolName[]; error?: string } {
  if (toolsRaw === undefined) {
    return {};
  }

  const parsed = subagentToolsSchema.safeParse(toolsRaw);
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

  const selected: SubagentToolName[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const name of cleaned) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (SUBAGENT_TOOL_NAME_SET.has(name as SubagentToolName)) {
      selected.push(name as SubagentToolName);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    const allowed = SUBAGENT_TOOL_NAMES.join(", ");
    return { error: `unknown subagent tool(s): ${unknown.join(", ")}. allowed: ${allowed}` };
  }

  return { tools: selected };
}

function parseSubagentConfig(subagentsRaw: unknown): {
  config?: PartialSubagentConfig;
  defaultDisabled?: boolean;
  error?: string;
} {
  if (subagentsRaw === undefined) {
    return {};
  }

  const config: PartialSubagentConfig = {};
  let defaultDisabled = false;

  // Handle list of subagent names
  if (Array.isArray(subagentsRaw)) {
    for (const nameRaw of subagentsRaw) {
      const nameResult = parseSubagentName(nameRaw);
      if ("error" in nameResult) {
        return { error: nameResult.error };
      }

      const name = nameResult.name;
      if (name !== DEFAULT_SUBAGENT_NAME) {
        return {
          error: `subagent ${name}: custom subagents require an object with systemPrompt`,
        };
      }

      config[name] = {};
    }
    return { config, defaultDisabled };
  }

  // Handle object with per-subagent config
  const configParsed = z.record(z.string(), z.unknown()).safeParse(subagentsRaw);
  if (configParsed.success) {
    for (const [name, specRaw] of Object.entries(configParsed.data)) {
      const nameResult = parseSubagentName(name);
      if ("error" in nameResult) {
        return { error: nameResult.error };
      }

      const validatedName = nameResult.name;

      if (validatedName === DEFAULT_SUBAGENT_NAME) {
        if (specRaw === false) {
          defaultDisabled = true;
          continue;
        }
        return {
          error: `subagent ${validatedName}: default subagent does not accept overrides (use default: false to disable)`,
        };
      }

      if (!specRaw || typeof specRaw !== "object") {
        return {
          error: `subagent ${validatedName}: systemPrompt is required for custom subagents`,
        };
      }

      const spec = SubagentSpecSchema.safeParse(specRaw);
      if (!spec.success) {
        return { error: `subagent ${validatedName}: ${formatZodError(spec.error)}` };
      }

      if (!spec.data.systemPrompt) {
        return {
          error: `subagent ${validatedName}: systemPrompt is required for custom subagents`,
        };
      }

      const provider = spec.data.provider;
      const model = spec.data.model;
      const toolsResult = parseSubagentTools(spec.data.tools);
      if (toolsResult.error) {
        return { error: `subagent ${validatedName}: ${toolsResult.error}` };
      }
      const tools = toolsResult.tools;
      const riskLevel = spec.data.riskLevel;
      const settings =
        spec.data.reasoning !== undefined && spec.data.reasoning !== "none"
          ? { reasoning: spec.data.reasoning }
          : undefined;

      let modelObj: Model<Api> | undefined;
      if (provider && model) {
        modelObj = resolveModel(provider, model);
        if (!modelObj) {
          return {
            error: `subagent ${validatedName}: failed to resolve model "${provider}:${model}"`,
          };
        }
      }

      const entry: SubagentPersonaConfig = {
        systemPrompt: spec.data.systemPrompt,
        ...(spec.data.description ? { description: spec.data.description } : {}),
        ...(modelObj ? { model: modelObj } : {}),
        ...(settings ? { settings } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(riskLevel ? { riskLevel } : {}),
      };

      config[validatedName] = entry;
    }

    return { config, defaultDisabled };
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

function loadEntries(
  dir: string,
  deps: ConfigDeps,
  listFiles: (dir: string, deps: ConfigDeps) => { paths: string[]; errors: string[] },
): { entries: FileEntry[]; errors: string[] } {
  if (!deps.fs.exists(dir)) {
    return { entries: [], errors: [] };
  }

  const { paths, errors } = listFiles(dir, deps);
  const entries: FileEntry[] = [];

  for (const path of paths) {
    try {
      entries.push({ path, content: deps.fs.readFile(path) });
    } catch {
      errors.push(`failed to read file: ${path}`);
    }
  }

  return { entries, errors };
}

function loadMarkdownEntries(
  dir: string,
  deps: ConfigDeps,
  listFiles: (dir: string, deps: ConfigDeps) => MarkdownPathsResult,
): { entries: MarkdownEntry[]; errors: string[] } {
  return loadEntries(dir, deps, listFiles);
}

function loadJsonEntries(
  dir: string,
  deps: ConfigDeps,
  listFiles: (dir: string, deps: ConfigDeps) => JsonPathsResult,
): { entries: JsonEntry[]; errors: string[] } {
  return loadEntries(dir, deps, listFiles);
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
  [TOOL_NAME_BASH, BASH_TOOL],
  [TOOL_NAME_WRITE, WRITE_TOOL],
  [TOOL_NAME_EDIT, EDIT_TOOL],
  [TOOL_NAME_VIEW_IMAGE, VIEW_IMAGE_TOOL],
  [TOOL_NAME_SPAWN_AGENT, SPAWN_AGENT_TOOL],
  [TOOL_NAME_SEND_INPUT_TO_AGENT, SEND_INPUT_TO_AGENT_TOOL],
  [TOOL_NAME_WAIT_FOR_AGENT, WAIT_FOR_AGENT_TOOL],
  [TOOL_NAME_TERMINATE_AGENT, TERMINATE_AGENT_TOOL],
]);

const DEFAULT_PERSONA_TOOLS = [BASH_TOOL, WRITE_TOOL, EDIT_TOOL, VIEW_IMAGE_TOOL];
const DEFAULT_SUBAGENT_TOOLS = [
  SPAWN_AGENT_TOOL,
  SEND_INPUT_TO_AGENT_TOOL,
  WAIT_FOR_AGENT_TOOL,
  TERMINATE_AGENT_TOOL,
];

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

  let finalSubagents: SubagentConfigMap | undefined;
  if (subagentsRaw === undefined) {
    if (basePersona?.subagents) {
      finalSubagents = {};

      for (const [name, cfg] of Object.entries(basePersona.subagents)) {
        if (!cfg) continue;
        finalSubagents[name] = { ...cfg };
      }

      if (Object.keys(finalSubagents).length === 0) {
        finalSubagents = undefined;
      }
    }
  } else if (subagentsResult.config && Object.keys(subagentsResult.config).length > 0) {
    finalSubagents = { ...subagentsResult.config };
  }

  if (subagentsRaw !== undefined) {
    if (!subagentsResult.defaultDisabled) {
      if (!finalSubagents) {
        finalSubagents = {};
      }
      if (!finalSubagents[DEFAULT_SUBAGENT_NAME]) {
        finalSubagents[DEFAULT_SUBAGENT_NAME] = {};
      }
    } else if (finalSubagents?.[DEFAULT_SUBAGENT_NAME]) {
      delete finalSubagents[DEFAULT_SUBAGENT_NAME];
    }
  } else if (!finalSubagents) {
    finalSubagents = { [DEFAULT_SUBAGENT_NAME]: {} };
  }

  if (finalSubagents && Object.keys(finalSubagents).length === 0) {
    finalSubagents = undefined;
  }

  const defaultTools = finalSubagents
    ? [...DEFAULT_PERSONA_TOOLS, ...DEFAULT_SUBAGENT_TOOLS]
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
