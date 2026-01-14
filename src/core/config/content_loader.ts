import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Api, KnownProvider, Model, Tool } from "@mariozechner/pi-ai";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { applyGeminiSubagents, personas as builtinPersonas } from "../personas.js";
import type { PromptTemplate } from "../prompts.js";
import { prompts as builtinPrompts } from "../prompts.js";
import type { SubagentConfigMap, SubagentPersonaConfig } from "../subagents/types.js";
import { BASH_TOOL } from "../tools/bash.js";
import { EDIT_TOOL } from "../tools/edit.js";
import { FORK_TOOL } from "../tools/fork.js";
import { GREP_TOOL } from "../tools/grep.js";
import { LIST_TOOL } from "../tools/list.js";
import { READ_TOOL } from "../tools/read.js";
import { TASK_TOOL } from "../tools/task.js";
import { WRITE_TOOL } from "../tools/write.js";
import type { Persona, ReasoningEffort, Skill } from "../types.js";
import { ReasoningEffortSchema } from "../types.js";
import { getGitRoot } from "../utils/git.js";
import { formatZodError } from "../utils/zod.js";
import type { Config } from "./schema.js";
import { isGoogleAuthAvailable } from "./schema.js";

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

function findProjectTauDirsFromCwd(args: {
  subdir: "personas" | "prompts" | "skills";
  cwd?: string;
}): string[] {
  const cwd = args.cwd ?? process.cwd();
  const cwdAbs = resolve(cwd);
  const homeAbs = resolve(homedir());

  const gitRoot = getGitRoot(cwd);
  const gitRootAbs = gitRoot ? resolve(gitRoot) : undefined;

  const stopAbs =
    gitRootAbs && (cwdAbs === gitRootAbs || cwdAbs.startsWith(gitRootAbs + sep))
      ? gitRootAbs
      : cwdAbs === homeAbs || cwdAbs.startsWith(homeAbs + sep)
        ? homeAbs
        : cwdAbs;

  const found: string[] = [];

  let dir = cwdAbs;
  // Closest-first order: cwd, parent, ..., stop.
  while (true) {
    const candidate = join(dir, ".tau", args.subdir);
    if (existsSync(candidate)) {
      found.push(candidate);
    }

    if (dir === stopAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  return found;
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
  ["read", READ_TOOL],
  ["list", LIST_TOOL],
  ["grep", GREP_TOOL],
  ["task", TASK_TOOL],
  ["fork", FORK_TOOL],
]);

const DEFAULT_PERSONA_TOOLS = [BASH_TOOL, WRITE_TOOL, EDIT_TOOL];

function parsePersona(
  file: string,
  content: string,
  forbiddenIds: Set<string> | undefined,
  source: "user" | "project",
  basePersonasById?: Map<string, Persona>,
): { persona?: Persona; error?: string } {
  const { frontMatter, body } = parseMarkdownWithFrontMatter(content);

  const parsedFrontMatter = personaFrontMatterSchema.safeParse(frontMatter);
  if (!parsedFrontMatter.success) {
    return { error: `${file}: missing required fields (id, provider, model). skipped.` };
  }

  const { id, extends: extendsId, label, provider, model, description } = parsedFrontMatter.data;
  const reasoning = parsedFrontMatter.data.reasoning;
  const allowedReasoningLevels = parsedFrontMatter.data.allowedReasoningLevels;
  const skillsRaw = parsedFrontMatter.data.skills;
  const subagentsRaw = parsedFrontMatter.data.subagents;
  const toolsRaw = parsedFrontMatter.data.tools;

  const basePersona = extendsId ? basePersonasById?.get(extendsId.toLowerCase()) : undefined;

  if (extendsId && !basePersona) {
    return { error: `${file}: extends "${extendsId}" not found. skipped.` };
  }

  if (forbiddenIds?.has(id.toLowerCase())) {
    return { error: `${file}: persona id "${id}" conflicts with built-in. skipped.` };
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

function parsePrompt(
  file: string,
  content: string,
  forbiddenIds?: Set<string>,
): { prompt?: PromptTemplate; error?: string } {
  const { frontMatter, body } = parseMarkdownWithFrontMatter(content);

  const parsedFrontMatter = promptFrontMatterSchema.safeParse(frontMatter);
  if (!parsedFrontMatter.success) {
    return { error: `${file}: missing required field 'id'. skipped.` };
  }

  const { id, label, description } = parsedFrontMatter.data;

  if (forbiddenIds?.has(id.toLowerCase())) {
    return { error: `${file}: prompt id "${id}" conflicts with built-in. skipped.` };
  }

  const prompt: PromptTemplate = {
    id,
    template: body,
    ...(label && { label }),
    ...(description && { description }),
  };

  return { prompt };
}

export async function loadUserPersonas(args?: {
  basePersonasById?: Map<string, Persona>;
  forbiddenIds?: Set<string>;
}): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const personasDir = join(configDir, "tau", "personas");
  const { files, error } = loadMarkdownFiles(personasDir);

  if (error) {
    return { personas: [], errors: [error] };
  }

  const personas: Persona[] = [];
  const errors: string[] = [];

  const basePersonasById =
    args?.basePersonasById ?? new Map(builtinPersonas.map((p) => [p.id.toLowerCase(), p] as const));

  for (const file of files) {
    const result = parsePersona(
      file.name,
      file.content,
      args?.forbiddenIds,
      "user",
      basePersonasById,
    );
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
}): Promise<{
  personas: Persona[];
  errors: string[];
}> {
  const personasDirs = findProjectTauDirsFromCwd({
    subdir: "personas",
    cwd: args?.cwd,
  });
  if (personasDirs.length === 0) {
    return { personas: [], errors: [] };
  }

  const personas: Persona[] = [];
  const errors: string[] = [];

  const basePersonasById =
    args?.basePersonasById ?? new Map(builtinPersonas.map((p) => [p.id.toLowerCase(), p] as const));

  // Parent-first order, closest directory wins on conflicts.
  for (const personasDir of personasDirs.slice().reverse()) {
    const { files, error } = loadMarkdownFiles(personasDir);

    if (error) {
      errors.push(error);
      continue;
    }

    for (const file of files) {
      const result = parsePersona(file.name, file.content, undefined, "project", basePersonasById);
      if (result.persona) {
        personas.push(result.persona);
      } else if (result.error) {
        errors.push(result.error);
      }
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

export async function loadProjectPrompts(args?: { cwd?: string }): Promise<{
  prompts: PromptTemplate[];
  errors: string[];
}> {
  const promptsDirs = findProjectTauDirsFromCwd({
    subdir: "prompts",
    cwd: args?.cwd,
  });
  if (promptsDirs.length === 0) {
    return { prompts: [], errors: [] };
  }

  const prompts: PromptTemplate[] = [];
  const errors: string[] = [];

  // Parent-first order, closest directory wins on conflicts.
  for (const promptsDir of promptsDirs.slice().reverse()) {
    const { files, error } = loadMarkdownFiles(promptsDir);

    if (error) {
      errors.push(error);
      continue;
    }

    for (const file of files) {
      const result = parsePrompt(file.name, file.content);
      if (result.prompt) {
        prompts.push(result.prompt);
      } else if (result.error) {
        errors.push(result.error);
      }
    }
  }

  return { prompts, errors };
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
    const skillDir = join(skillsDir, entry);

    let isDir = false;
    try {
      isDir = statSync(skillDir).isDirectory();
    } catch {
      continue;
    }

    if (!isDir) continue;

    const filePath = join(skillDir, "SKILL.md");
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

export async function loadProjectSkills(args?: { cwd?: string }): Promise<{
  skills: Skill[];
  errors: string[];
}> {
  const skillsDirs = findProjectTauDirsFromCwd({
    subdir: "skills",
    cwd: args?.cwd,
  });
  if (skillsDirs.length === 0) {
    return { skills: [], errors: [] };
  }

  const skills: Skill[] = [];
  const errors: string[] = [];

  // Parent-first order, closest directory wins on conflicts.
  for (const skillsDir of skillsDirs.slice().reverse()) {
    const result = loadSkillsFromDir(skillsDir);
    skills.push(...result.skills);
    errors.push(...result.errors);
  }

  return { skills, errors };
}

export async function loadAllContent(
  config?: Config,
  options?: { cwd?: string },
): Promise<{
  personas: Persona[];
  prompts: PromptTemplate[];
  skills: Skill[];
  errors: string[];
}> {
  try {
    const cwd = options?.cwd;
    const builtinBasePersonas = builtinPersonas;
    const builtinDisplayPersonas =
      config && isGoogleAuthAvailable(config)
        ? applyGeminiSubagents(builtinBasePersonas)
        : builtinBasePersonas;

    const basePersonasById = new Map(
      builtinBasePersonas.map((p) => [p.id.toLowerCase(), p] as const),
    );

    const includeBuiltins = !config?.disableBuiltinPersonas;
    const forbiddenIds = includeBuiltins
      ? new Set(builtinBasePersonas.map((p) => p.id.toLowerCase()))
      : undefined;

    const userPersonasResult = await loadUserPersonas({ basePersonasById, forbiddenIds });
    const projectPersonasResult = await loadProjectPersonas({ basePersonasById, cwd });
    const userPromptsResult = await loadUserPrompts();
    const projectPromptsResult = await loadProjectPrompts({ cwd });
    const userSkillsResult = await loadUserSkills();
    const projectSkillsResult = await loadProjectSkills({ cwd });

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

    const effectiveBuiltins = includeBuiltins ? builtinDisplayPersonas : [];

    // Precedence: built-ins < user < project.
    return {
      personas: mergeById(
        effectiveBuiltins,
        userPersonasResult.personas,
        projectPersonasResult.personas,
      ),
      prompts: mergeById(builtinPrompts, userPromptsResult.prompts, projectPromptsResult.prompts),
      skills,
      errors: allErrors,
    };
  } catch (err) {
    const baseBuiltins =
      config && isGoogleAuthAvailable(config)
        ? applyGeminiSubagents(builtinPersonas)
        : builtinPersonas;

    const effectiveBuiltins = config?.disableBuiltinPersonas ? [] : baseBuiltins;

    return {
      personas: effectiveBuiltins,
      prompts: builtinPrompts,
      skills: [],
      errors: [`unexpected error loading user content: ${(err as Error).message}`],
    };
  }
}
