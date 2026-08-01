import { basename, join } from "node:path";
import { z } from "zod";
import type { LoadedModelResolver, ModelResolver } from "../models/catalog.js";
import type { PromptTemplate } from "../prompts.js";
import { parseSubagentLaunchModelList } from "../subagents/launch_model.js";
import type {
  SubagentConfigMap,
  SubagentPersonaConfig,
  SubagentToolName,
} from "../subagents/types.js";
import { DEFAULT_SUBAGENT_NAME, SUBAGENT_TOOL_NAMES } from "../subagents/types.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_NOOK,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_TERMINATE_AGENT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
  type ToolName,
} from "../tools/tool_names.js";
import type { Persona, Skill } from "../types.js";
import { ReasoningEffortSchema, ServiceTierSchema } from "../types.js";
import { formatZodError } from "../utils/zod.js";
import type { ConfigDeps } from "./deps.js";
import { parseMarkdownFrontMatter } from "./markdown_frontmatter.js";
import type { ConfigLevel, ConfigLevelScope } from "./paths.js";
import type { Config } from "./schema.js";
import { loadSkillsContent as loadCanonicalSkillsContent } from "./skills_loader.js";
import { buildVirtualBundle } from "./virtual_bundle.js";

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

const SubagentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

type SubagentName = z.infer<typeof SubagentNameSchema>;

const SubagentSpecSchema = z
  .object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    reasoning: ReasoningEffortSchema.optional(),
    serviceTier: ServiceTierSchema.optional(),
    tools: z.array(z.string()).optional(),
    launchModels: z.array(z.string()).optional(),
    systemPrompt: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strip()
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

const SUBAGENT_TOOL_NAME_SET = new Set<SubagentToolName>(SUBAGENT_TOOL_NAMES);

const SubagentConfigInputSchema = z.record(
  SubagentNameSchema,
  z.union([z.literal(false), SubagentSpecSchema]),
);

const TrimmedNonEmptyStringListSchema = z
  .array(z.string())
  .transform((list) => list.map((item) => item.trim()))
  .refine((list) => list.every(Boolean), {
    message: "entries must be non-empty strings",
  });

function parseSubagentTools(toolsRaw: string[] | undefined): {
  tools?: SubagentToolName[];
  error?: string;
} {
  if (toolsRaw === undefined) {
    return {};
  }

  const parsed = TrimmedNonEmptyStringListSchema.safeParse(toolsRaw);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message === "entries must be non-empty strings"
          ? "tools entries must be non-empty strings"
          : "tools must be a list of strings",
    };
  }

  const cleaned = parsed.data.map((tool) => tool.toLowerCase());

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
      continue;
    }

    unknown.push(name);
  }

  if (unknown.length > 0) {
    const allowed = SUBAGENT_TOOL_NAMES.join(", ");
    return { error: `unknown subagent tool(s): ${unknown.join(", ")}. allowed: ${allowed}` };
  }

  return { tools: selected };
}

function cloneSubagentPersonaConfig(config: SubagentPersonaConfig): SubagentPersonaConfig {
  return {
    ...config,
    ...(config.settings ? { settings: { ...config.settings } } : {}),
    ...(config.tools ? { tools: [...config.tools] } : {}),
    ...(config.launchModels ? { launchModels: [...config.launchModels] } : {}),
  };
}

function parseSubagentConfig(
  subagentsRaw: unknown,
  modelResolver: ModelResolver,
): {
  config?: SubagentConfigMap;
  defaultDisabled?: boolean;
  error?: string;
} {
  if (subagentsRaw === undefined) {
    return {};
  }

  const config: SubagentConfigMap = {};
  let defaultDisabled = false;

  const configParsed = SubagentConfigInputSchema.safeParse(subagentsRaw);
  if (!configParsed.success) {
    const invalidName = configParsed.error.issues.some(
      (issue) => issue.path.length > 0 && issue.path[0] !== undefined,
    );
    return {
      error: invalidName
        ? `invalid subagent: ${formatZodError(configParsed.error)}`
        : "subagents must be an object",
    };
  }

  for (const [name, specRaw] of Object.entries(configParsed.data)) {
    const validatedName = name as SubagentName;

    if (validatedName === DEFAULT_SUBAGENT_NAME) {
      if (specRaw === false) {
        defaultDisabled = true;
        continue;
      }
      return {
        error: `subagent ${validatedName}: default subagent does not accept overrides (use default: false to disable)`,
      };
    }

    if (specRaw === false) {
      return {
        error: `subagent ${validatedName}: systemPrompt is required for custom subagents`,
      };
    }

    if (!specRaw.systemPrompt) {
      return {
        error: `subagent ${validatedName}: systemPrompt is required for custom subagents`,
      };
    }

    const provider = specRaw.provider;
    const model = specRaw.model;
    const toolsResult = parseSubagentTools(specRaw.tools);
    if (toolsResult.error) {
      return { error: `subagent ${validatedName}: ${toolsResult.error}` };
    }
    const launchModelsResult = parseSubagentLaunchModelList(specRaw.launchModels, {
      resolveModel: modelResolver,
    });
    if (launchModelsResult.error) {
      return {
        error: `subagent ${validatedName}: launchModels ${launchModelsResult.error}`,
      };
    }
    const tools = toolsResult.tools;
    const launchModels = launchModelsResult.launchModels;
    const settings =
      specRaw.reasoning !== undefined || specRaw.serviceTier !== undefined
        ? {
            ...(specRaw.reasoning !== undefined ? { reasoning: specRaw.reasoning } : {}),
            ...(specRaw.serviceTier !== undefined ? { serviceTier: specRaw.serviceTier } : {}),
          }
        : undefined;

    let modelObj: Persona["model"] | undefined;
    if (provider && model) {
      modelObj = modelResolver(provider, model);
      if (!modelObj) {
        return {
          error: `subagent ${validatedName}: failed to resolve model "${provider}:${model}"`,
        };
      }
    }

    const entry: SubagentPersonaConfig = {
      systemPrompt: specRaw.systemPrompt,
      ...(specRaw.description ? { description: specRaw.description } : {}),
      ...(modelObj ? { model: modelObj } : {}),
      ...(settings ? { settings } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(launchModels !== undefined ? { launchModels } : {}),
    };

    config[validatedName] = entry;
  }

  return { config, defaultDisabled };
}

function parsePersonaTools(toolsRaw: unknown): { tools?: ToolName[]; error?: string } {
  if (toolsRaw === undefined) {
    return {};
  }

  const parsed = TrimmedNonEmptyStringListSchema.safeParse(toolsRaw);
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message === "entries must be non-empty strings"
          ? "tools entries must be non-empty strings"
          : "tools must be a list of strings",
    };
  }

  const cleaned = parsed.data.map((tool) => tool.toLowerCase());

  if (cleaned.length === 0) {
    return { tools: [] };
  }

  const selected: ToolName[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const name of cleaned) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (PERSONA_TOOL_NAME_SET.has(name as ToolName)) {
      selected.push(name as ToolName);
    } else {
      unknown.push(name);
    }
  }

  if (unknown.length > 0) {
    const allowed = PERSONA_TOOL_NAMES.join(", ");
    return { error: `unknown tool(s): ${unknown.join(", ")}. allowed: ${allowed}` };
  }

  return { tools: selected };
}

function resolvePersonaModels(
  persona: Persona,
  modelResolver: ModelResolver,
): { persona?: Persona; error?: string } {
  const resolvedPersonaModel = modelResolver(persona.model.provider, persona.model.id);
  if (!resolvedPersonaModel) {
    return {
      error: `failed to resolve model "${persona.model.provider}:${persona.model.id}"`,
    };
  }

  if (!persona.subagents) {
    return {
      persona: {
        ...persona,
        model: resolvedPersonaModel,
      },
    };
  }

  const resolvedSubagents: SubagentConfigMap = {};

  for (const [name, config] of Object.entries(persona.subagents)) {
    if (!config?.model) {
      if (config) {
        resolvedSubagents[name] = cloneSubagentPersonaConfig(config);
      }
      continue;
    }

    const resolvedSubagentModel = modelResolver(config.model.provider, config.model.id);
    if (!resolvedSubagentModel) {
      return {
        error: `subagent ${name}: failed to resolve model "${config.model.provider}:${config.model.id}"`,
      };
    }

    resolvedSubagents[name] = {
      ...cloneSubagentPersonaConfig(config),
      model: resolvedSubagentModel,
    };
  }

  return {
    persona: {
      ...persona,
      model: resolvedPersonaModel,
      subagents: resolvedSubagents,
    },
  };
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

function withDefaultSubagentLaunchModels(
  persona: Persona,
  defaultLaunchModels: string[] | undefined,
): Persona {
  if (!defaultLaunchModels) {
    return persona;
  }

  const defaultConfig = persona.subagents?.[DEFAULT_SUBAGENT_NAME];
  if (!defaultConfig || !persona.subagents) {
    return persona;
  }

  const clonedSubagents: SubagentConfigMap = {};
  for (const [name, config] of Object.entries(persona.subagents)) {
    clonedSubagents[name] = cloneSubagentPersonaConfig(config);
  }

  const defaultSubagent = clonedSubagents[DEFAULT_SUBAGENT_NAME] ?? {};
  clonedSubagents[DEFAULT_SUBAGENT_NAME] = {
    ...defaultSubagent,
    launchModels: [...defaultLaunchModels],
  };

  return {
    ...persona,
    subagents: clonedSubagents,
  };
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

function resolveContentContext(options: { deps: ConfigDeps; levels: ConfigLevel[] }): {
  deps: ConfigDeps;
  levels: ConfigLevel[];
} {
  return {
    deps: options.deps,
    levels: options.levels,
  };
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
    serviceTier: ServiceTierSchema.optional(),
    allowedReasoningLevels: z.array(ReasoningEffortSchema).optional(),
    skills: z.unknown().optional(),
    subagents: z.unknown().optional(),
    tools: z.unknown().optional(),
  })
  .strip();

const skillsSchema = z.union([z.literal("*"), z.array(z.string())]);

const promptFrontMatterSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().optional(),
    description: z.string().trim().optional(),
  })
  .strip();

const PERSONA_TOOL_NAMES = [
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_NOOK,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_TERMINATE_AGENT,
] as const satisfies ReadonlyArray<ToolName>;

const PERSONA_TOOL_NAME_SET = new Set<ToolName>(PERSONA_TOOL_NAMES);
const DEFAULT_PERSONA_TOOLS = [
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_NOOK,
] as const satisfies ReadonlyArray<ToolName>;
const DEFAULT_SUBAGENT_TOOLS = [
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_TERMINATE_AGENT,
] as const satisfies ReadonlyArray<ToolName>;

function parsePersona(
  file: string,
  content: string,
  source: "user" | "project",
  modelResolver: ModelResolver,
  basePersonasById?: Map<string, Persona>,
): { persona?: Persona; error?: string } {
  const markdownResult = parseMarkdownFrontMatter(content);
  if (!markdownResult.ok) {
    return { error: `${file}: ${markdownResult.message}. skipped.` };
  }

  const parsedFrontMatter = personaFrontMatterSchema.safeParse(markdownResult.frontMatter);
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
  const serviceTier = parsedFrontMatter.data.serviceTier;
  const allowedReasoningLevels = parsedFrontMatter.data.allowedReasoningLevels;
  const skillsRaw = parsedFrontMatter.data.skills;
  const subagentsRaw = parsedFrontMatter.data.subagents;
  const toolsRaw = parsedFrontMatter.data.tools;

  const basePersona = extendsId ? basePersonasById?.get(extendsId.toLowerCase()) : undefined;

  if (extendsId && !basePersona) {
    return { error: `${file}: extends "${extendsId}" not found. skipped.` };
  }

  const modelObj = modelResolver(provider, model);
  if (!modelObj) {
    return { error: `${file}: failed to load model "${provider}:${model}". skipped.` };
  }

  const settings: Persona["settings"] = basePersona ? { ...basePersona.settings } : {};
  if (reasoning) {
    settings.reasoning = reasoning;
  }
  if (serviceTier) {
    settings.serviceTier = serviceTier;
  }

  let skills: Persona["skills"];
  if (skillsRaw === undefined) {
    skills = basePersona
      ? Array.isArray(basePersona.skills)
        ? [...basePersona.skills]
        : basePersona.skills
      : "*";
  } else {
    const skillsParsed = skillsSchema.safeParse(skillsRaw);

    if (!skillsParsed.success) {
      return { error: `${file}: skills must be "*" or a list of strings. skipped.` };
    }

    if (skillsParsed.data === "*") {
      skills = "*";
    } else {
      const cleaned = skillsParsed.data.map((skill) => skill.trim());
      if (cleaned.some((skill) => !skill)) {
        return { error: `${file}: skills entries must be non-empty strings. skipped.` };
      }
      skills = cleaned;
    }
  }

  // Parse subagents
  const subagentsResult = parseSubagentConfig(subagentsRaw, modelResolver);
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
        finalSubagents[name] = cloneSubagentPersonaConfig(cfg);
      }

      if (Object.keys(finalSubagents).length === 0) {
        finalSubagents = undefined;
      }
    }
  } else if (subagentsResult.config && Object.keys(subagentsResult.config).length > 0) {
    finalSubagents = {};

    for (const [name, cfg] of Object.entries(subagentsResult.config)) {
      finalSubagents[name] = cloneSubagentPersonaConfig(cfg);
    }

    if (Object.keys(finalSubagents).length === 0) {
      finalSubagents = undefined;
    }
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
    : [...DEFAULT_PERSONA_TOOLS];

  const inheritedTools =
    toolsRaw === undefined && basePersona?.tools ? [...basePersona.tools] : undefined;
  const tools = toolsResult.tools ?? inheritedTools ?? defaultTools;

  const finalLabel = label || basePersona?.label || "custom";
  const finalDescription = description ?? basePersona?.description;
  const finalSystemPrompt = markdownResult.body.trim()
    ? markdownResult.body
    : (basePersona?.systemPrompt ?? markdownResult.body);

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
    skills,
    source,
  };

  return { persona };
}

export function parsePrompt(
  file: string,
  content: string,
): { prompt?: PromptTemplate; error?: string } {
  const markdownResult = parseMarkdownFrontMatter(content);
  if (!markdownResult.ok) {
    return { error: `${file}: ${markdownResult.message}. skipped.` };
  }

  const parsedFrontMatter = promptFrontMatterSchema.safeParse(markdownResult.frontMatter);
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
    template: markdownResult.body,
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

export async function loadUserPersonas(args: {
  basePersonasById: Map<string, Persona>;
  modelResolver: ModelResolver;
  deps: ConfigDeps;
  levels: ConfigLevel[];
}): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args.deps,
    levels: args.levels,
  });
  const globalLevel = levels.find((level) => level.scope === "global");
  if (!globalLevel) {
    return { personas: [], errors: [] };
  }

  const personasDir = globalLevel.personasDir;
  const { entries, errors } = loadMarkdownEntries(personasDir, deps, listMarkdownFiles);
  const personas: Persona[] = [];

  for (const file of entries) {
    const result = parsePersona(
      file.path,
      file.content,
      "user",
      args.modelResolver,
      args.basePersonasById,
    );
    if (result.persona) {
      personas.push(result.persona);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { personas, errors };
}

export async function loadProjectPersonas(args: {
  basePersonasById: Map<string, Persona>;
  modelResolver: ModelResolver;
  deps: ConfigDeps;
  levels: ConfigLevel[];
}): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args.deps,
    levels: args.levels,
  });

  const projectLevels = levels.filter((level) => level.scope === "project");
  if (projectLevels.length === 0) {
    return { personas: [], errors: [] };
  }

  const personas: Persona[] = [];
  const errors: string[] = [];

  // Parent-first order, closest directory wins on conflicts.
  for (const level of projectLevels) {
    const { entries, errors: entryErrors } = loadMarkdownEntries(
      level.personasDir,
      deps,
      listMarkdownFiles,
    );
    errors.push(...entryErrors);

    for (const file of entries) {
      const result = parsePersona(
        file.path,
        file.content,
        "project",
        args.modelResolver,
        args.basePersonasById,
      );
      if (result.persona) {
        personas.push(result.persona);
      } else if (result.error) {
        errors.push(result.error);
      }
    }
  }

  return { personas, errors };
}

export async function loadUserPrompts(args: { deps: ConfigDeps; levels: ConfigLevel[] }): Promise<{
  prompts: PromptTemplate[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args.deps,
    levels: args.levels,
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

export async function loadProjectPrompts(args: {
  deps: ConfigDeps;
  levels: ConfigLevel[];
}): Promise<{
  prompts: PromptTemplate[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args.deps,
    levels: args.levels,
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

export async function loadUserThemes(args: { deps: ConfigDeps; levels: ConfigLevel[] }): Promise<{
  themes: ThemeDefinition[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args.deps,
    levels: args.levels,
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

export async function loadProjectThemes(args: {
  deps: ConfigDeps;
  levels: ConfigLevel[];
}): Promise<{
  themes: ThemeDefinition[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: args.deps,
    levels: args.levels,
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

export async function loadSkillsContent(
  config: Config | undefined,
  options: { deps: ConfigDeps; levels: ConfigLevel[] },
): Promise<{ skills: Skill[]; errors: string[] }> {
  return loadCanonicalSkillsContent(config, options);
}

export async function loadAllContent(
  config: Config | undefined,
  options: {
    deps: ConfigDeps;
    levels: ConfigLevel[];
    modelResolver: LoadedModelResolver;
  },
): Promise<{
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  themes: ThemeDefinition[];
  errors: string[];
}> {
  const { deps, levels } = resolveContentContext({
    deps: options.deps,
    levels: options.levels,
  });

  const virtualBundle = buildVirtualBundle(
    config ?? {},
    options.modelResolver.resolveConfiguredModel,
  );

  try {
    const builtinPersonaErrors: string[] = [];
    const resolvedBuiltinPersonas: Persona[] = [];

    for (const persona of virtualBundle.builtinPersonas) {
      const resolved = resolvePersonaModels(persona, options.modelResolver.resolveModel);
      if (resolved.persona) {
        resolvedBuiltinPersonas.push(resolved.persona);
      } else if (resolved.error) {
        builtinPersonaErrors.push(`builtin persona '${persona.id}': ${resolved.error}`);
      }
    }

    const resolvedVirtualBundlePersonas =
      virtualBundle.personas.length === 0 ? [] : resolvedBuiltinPersonas;

    const basePersonasById = new Map(
      resolvedBuiltinPersonas.map((persona) => [persona.id.toLowerCase(), persona] as const),
    );

    const userPersonasResult = await loadUserPersonas({
      basePersonasById,
      modelResolver: options.modelResolver.resolveModel,
      deps,
      levels,
    });
    const projectPersonasResult = await loadProjectPersonas({
      basePersonasById,
      modelResolver: options.modelResolver.resolveModel,
      deps,
      levels,
    });
    const userPromptsResult = await loadUserPrompts({ deps, levels });
    const projectPromptsResult = await loadProjectPrompts({ deps, levels });
    const skillsResult = await loadSkillsContent(config, { deps, levels });
    const userThemesResult = await loadUserThemes({ deps, levels });
    const projectThemesResult = await loadProjectThemes({ deps, levels });

    const allErrors = [
      ...options.modelResolver.errors,
      ...builtinPersonaErrors,
      ...userPersonasResult.errors,
      ...projectPersonasResult.errors,
      ...userPromptsResult.errors,
      ...projectPromptsResult.errors,
      ...skillsResult.errors,
      ...userThemesResult.errors,
      ...projectThemesResult.errors,
    ];

    const skills = skillsResult.skills;

    // Precedence: virtual bundle < global < nearest .tau levels.
    const defaultLaunchModels = config?.subagents?.defaultLaunchModels;
    const personas = mergeById(
      resolvedVirtualBundlePersonas,
      userPersonasResult.personas,
      projectPersonasResult.personas,
    ).map((persona) => withDefaultSubagentLaunchModels(persona, defaultLaunchModels));

    return {
      personas,
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
