import { basename, join } from "node:path";
import { z } from "zod";
import type { LoadedModelResolver, ModelResolver } from "../models/catalog.js";
import type { PromptTemplate } from "../prompts.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_HISTORY,
  TOOL_NAME_INTERRUPT_AGENT,
  TOOL_NAME_LIST_AGENTS,
  TOOL_NAME_MCP,
  TOOL_NAME_NOOK,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
  type ToolName,
} from "../tools/tool_names.js";
import type { Persona, Skill } from "../types.js";
import { ReasoningEffortSchema, ServiceTierSchema } from "../types.js";
import type { ConfigDeps } from "./deps.js";
import { parseMarkdownFrontMatter } from "./markdown_frontmatter.js";
import type { ConfigLevel } from "./paths.js";
import type { Config } from "./schema.js";
import { loadSkillsContent as loadCanonicalSkillsContent } from "./skills_loader.js";
import type { ThemeDefinition } from "./theme_variants.js";
import { buildVirtualBundle } from "./virtual_bundle.js";

interface MarkdownEntry {
  path: string;
  content: string;
}

type MarkdownPathsResult = {
  paths: string[];
  errors: string[];
};

const TrimmedNonEmptyStringListSchema = z
  .array(z.string())
  .transform((list) => list.map((item) => item.trim()))
  .refine((list) => list.every(Boolean), {
    message: "entries must be non-empty strings",
  });

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

  return {
    persona: {
      ...persona,
      model: resolvedPersonaModel,
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

function withSubagentLaunchModels(persona: Persona, launchModels: string[] | undefined): Persona {
  if (!launchModels) {
    return persona;
  }

  return {
    ...persona,
    subagentLaunchModels: [...launchModels],
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

function loadMarkdownEntries(
  dir: string,
  deps: ConfigDeps,
): { entries: MarkdownEntry[]; errors: string[] } {
  if (!deps.fs.exists(dir)) {
    return { entries: [], errors: [] };
  }

  const { paths, errors } = listMarkdownFiles(dir, deps);
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
    label: z.string().trim().optional(),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    description: z.string().trim().optional(),
    reasoning: ReasoningEffortSchema.optional(),
    serviceTier: ServiceTierSchema.optional(),
    allowedReasoningLevels: z.array(ReasoningEffortSchema).optional(),
    tools: z.unknown().optional(),
  })
  .strip();

const promptFrontMatterSchema = z.object({ label: z.string().trim().min(1) }).strip();

const PERSONA_TOOL_NAMES = [
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_NOOK,
  TOOL_NAME_HISTORY,
  TOOL_NAME_MCP,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_LIST_AGENTS,
  TOOL_NAME_INTERRUPT_AGENT,
] as const satisfies ReadonlyArray<ToolName>;

const PERSONA_TOOL_NAME_SET = new Set<ToolName>(PERSONA_TOOL_NAMES);
const DEFAULT_PERSONA_TOOLS = [
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_NOOK,
  TOOL_NAME_HISTORY,
  TOOL_NAME_MCP,
] as const satisfies ReadonlyArray<ToolName>;
const DEFAULT_SUBAGENT_TOOLS = [
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_LIST_AGENTS,
  TOOL_NAME_INTERRUPT_AGENT,
] as const satisfies ReadonlyArray<ToolName>;

function parsePersona(
  file: string,
  content: string,
  source: "user" | "project",
  modelResolver: ModelResolver,
): { persona?: Persona; error?: string } {
  const markdownResult = parseMarkdownFrontMatter(content);
  if (!markdownResult.ok) {
    return { error: `${file}: ${markdownResult.message}. skipped.` };
  }

  const parsedFrontMatter = personaFrontMatterSchema.safeParse(markdownResult.frontMatter);
  if (!parsedFrontMatter.success) {
    return { error: `${file}: missing required fields (id, provider, model). skipped.` };
  }

  const { id, label, provider, model, description } = parsedFrontMatter.data;
  const fileId = basename(file, ".md");
  if (fileId && id !== fileId) {
    return {
      error: `${file}: frontmatter id "${id}" must match file name "${fileId}". skipped.`,
    };
  }
  const reasoning = parsedFrontMatter.data.reasoning;
  const serviceTier = parsedFrontMatter.data.serviceTier;
  const allowedReasoningLevels = parsedFrontMatter.data.allowedReasoningLevels;
  const toolsRaw = parsedFrontMatter.data.tools;

  if (!markdownResult.body.trim()) {
    return { error: `${file}: a base prompt is required. skipped.` };
  }

  const modelObj = modelResolver(provider, model);
  if (!modelObj) {
    return { error: `${file}: failed to load model "${provider}:${model}". skipped.` };
  }

  const settings: Persona["settings"] = {};
  if (reasoning) {
    settings.reasoning = reasoning;
  }
  if (serviceTier) {
    settings.serviceTier = serviceTier;
  }

  const toolsResult = parsePersonaTools(toolsRaw);
  if (toolsResult.error) {
    return { error: `${file}: ${toolsResult.error}. skipped.` };
  }

  const defaultTools = [...DEFAULT_PERSONA_TOOLS, ...DEFAULT_SUBAGENT_TOOLS];

  const tools = toolsResult.tools ?? defaultTools;
  const finalLabel = label || "custom";
  const finalDescription = description;
  const finalSystemPrompt = markdownResult.body;
  const finalAllowedReasoningLevels = allowedReasoningLevels?.length
    ? allowedReasoningLevels
    : undefined;

  const persona: Persona = {
    id,
    label: finalLabel,
    model: modelObj,
    systemPrompt: finalSystemPrompt,
    settings,
    tools,
    ...(finalDescription && { description: finalDescription }),
    ...(finalAllowedReasoningLevels ? { allowedReasoningLevels: finalAllowedReasoningLevels } : {}),
    subagentLaunchModels: [],
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
    return { error: `${file}: missing required non-empty 'label'. skipped.` };
  }

  const prompt: PromptTemplate = {
    id: basename(file, ".md"),
    label: parsedFrontMatter.data.label,
    template: markdownResult.body,
  };

  return { prompt };
}

export async function loadUserPersonas(args: {
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
  const { entries, errors } = loadMarkdownEntries(personasDir, deps);
  const personas: Persona[] = [];

  for (const file of entries) {
    const result = parsePersona(file.path, file.content, "user", args.modelResolver);
    if (result.persona) {
      personas.push(result.persona);
    } else if (result.error) {
      errors.push(result.error);
    }
  }

  return { personas, errors };
}

export async function loadProjectPersonas(args: {
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
    const { entries, errors: entryErrors } = loadMarkdownEntries(level.personasDir, deps);
    errors.push(...entryErrors);

    for (const file of entries) {
      const result = parsePersona(file.path, file.content, "project", args.modelResolver);
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
  const { entries, errors } = loadMarkdownEntries(promptsDir, deps);

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
    const { entries, errors: entryErrors } = loadMarkdownEntries(level.promptsDir, deps);
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

  const virtualBundle = buildVirtualBundle(options.modelResolver.resolveConfiguredModel);

  try {
    const builtinPersonaErrors: string[] = [];
    const resolvedBuiltinPersonas: Persona[] = [];

    for (const persona of virtualBundle.personas) {
      const resolved = resolvePersonaModels(persona, options.modelResolver.resolveModel);
      if (resolved.persona) {
        resolvedBuiltinPersonas.push(resolved.persona);
      } else if (resolved.error) {
        builtinPersonaErrors.push(`builtin persona '${persona.id}': ${resolved.error}`);
      }
    }

    const userPersonasResult = await loadUserPersonas({
      modelResolver: options.modelResolver.resolveModel,
      deps,
      levels,
    });
    const projectPersonasResult = await loadProjectPersonas({
      modelResolver: options.modelResolver.resolveModel,
      deps,
      levels,
    });
    const userPromptsResult = await loadUserPrompts({ deps, levels });
    const projectPromptsResult = await loadProjectPrompts({ deps, levels });
    const skillsResult = await loadSkillsContent(config, { deps, levels });

    const allErrors = [
      ...builtinPersonaErrors,
      ...userPersonasResult.errors,
      ...projectPersonasResult.errors,
      ...userPromptsResult.errors,
      ...projectPromptsResult.errors,
      ...skillsResult.errors,
    ];

    const skills = skillsResult.skills;

    // Precedence: virtual bundle < global < nearest .tau levels.
    const launchModels = config?.subagents?.launchModels;
    const personas = mergeById(
      resolvedBuiltinPersonas,
      userPersonasResult.personas,
      projectPersonasResult.personas,
    ).map((persona) => withSubagentLaunchModels(persona, launchModels));

    return {
      personas,
      prompts: mergeById(userPromptsResult.prompts, projectPromptsResult.prompts),
      skills,
      themes: virtualBundle.themes,
      errors: allErrors,
    };
  } catch (err) {
    return {
      personas: virtualBundle.personas,
      prompts: [],
      skills: [],
      themes: virtualBundle.themes,
      errors: [`unexpected error loading user content: ${(err as Error).message}`],
    };
  }
}
