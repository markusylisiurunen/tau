import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type {
  TelegramBotConfig as SchemaTelegramBotConfig,
  TelegramProjectConfig as SchemaTelegramProjectConfig,
} from "../config/schema.js";
import { formatPersonaReference, parsePersonaReference } from "../persona_reference.js";
import { REASONING_LEVELS } from "../types.js";

export type TelegramBotConfig = SchemaTelegramBotConfig;
export type TelegramProjectConfig = SchemaTelegramProjectConfig;

export type TelegramConfig = {
  maxSessions?: number;
  workspaceRoot: string;
  systemMessage?: string;
  bots: Record<string, TelegramBotConfig>;
  projects: Record<string, TelegramProjectConfig>;
};

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramConfigError";
  }
}

const TELEGRAM_BUILTIN_COMMAND_COUNT = 10;
const TELEGRAM_MAX_COMMAND_COUNT = 100;
const TELEGRAM_PROJECT_COMMAND_PREFIX = "use_";
const TELEGRAM_MAX_COMMAND_LENGTH = 32;
const TELEGRAM_MAX_PROJECT_ID_LENGTH =
  TELEGRAM_MAX_COMMAND_LENGTH - TELEGRAM_PROJECT_COMMAND_PREFIX.length;

const nonEmptyStringSchema = z.string().trim().min(1, "must be a non-empty string.");

const positiveIntegerSchema = z
  .number()
  .int("must be a positive integer.")
  .positive("must be a positive integer.");

const idListSchema = z.array(z.number().int(), {
  message: "must be an array of integers.",
});

const stringListSchema = z.array(nonEmptyStringSchema, {
  message: "must be an array of non-empty strings.",
});

const telegramTopLevelSchema = z
  .object({
    maxSessions: positiveIntegerSchema.optional(),
    workspaceRoot: nonEmptyStringSchema.optional(),
    systemMessage: nonEmptyStringSchema.optional(),
    bots: z.unknown().optional(),
    projects: z.unknown().optional(),
  })
  .strip();

const telegramBotSchema = z
  .object({
    botToken: nonEmptyStringSchema,
    allowedProjectIds: stringListSchema.min(1, "must not be empty.").optional(),
    allowedUserIds: idListSchema.optional(),
    allowedChatIds: idListSchema.optional(),
    defaultProjectId: nonEmptyStringSchema.optional(),
    systemMessage: nonEmptyStringSchema.optional(),
    pollIntervalMs: positiveIntegerSchema.optional(),
    requestTimeoutSeconds: positiveIntegerSchema.optional(),
  })
  .strip();

function createProjectBaseShape() {
  return {
    description: nonEmptyStringSchema.optional(),
  };
}

function createManagedProjectBaseShape(configDir: string) {
  return {
    ...createProjectBaseShape(),
    workspaceRoot: nonEmptyStringSchema.transform((value) => resolve(configDir, value)).optional(),
  };
}

function createRepositoryProjectSchema(configDir: string) {
  return z
    .object({
      ...createManagedProjectBaseShape(configDir),
      repo: nonEmptyStringSchema.refine((value) => isGithubRepoRef(value), {
        message: "must be in owner/repo format (GitHub).",
      }),
      ref: nonEmptyStringSchema.optional(),
      workingDirectory: nonEmptyStringSchema
        .refine((value) => !isAbsolute(value), {
          message: "must be a relative path.",
        })
        .optional(),
      persona: z.string().optional(),
      noAgentContextFiles: z.boolean().optional(),
    })
    .strip();
}

function createDirectoryProjectSchema(configDir: string) {
  return z
    .object({
      ...createProjectBaseShape(),
      directory: nonEmptyStringSchema.transform((value) => resolve(configDir, value)),
      persona: z.string().optional(),
      noAgentContextFiles: z.boolean().optional(),
    })
    .strip();
}

function createCompositeProjectSchema(configDir: string) {
  return z
    .object({
      ...createManagedProjectBaseShape(configDir),
      projectIds: stringListSchema.min(2, "must contain at least two project ids."),
      persona: z.string(),
      instructions: nonEmptyStringSchema.optional(),
    })
    .strip();
}

function formatSectionZodErrors(
  error: z.ZodError,
  sourceLabel: string,
  fieldPath: string,
): string[] {
  const errors: string[] = [];
  for (const issue of error.issues) {
    const issuePath = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
    errors.push(`${sourceLabel}: ${fieldPath}${issuePath} ${issue.message}`);
  }

  return errors;
}

function parseTelegramBotConfig(
  raw: unknown,
  fieldPath: string,
  sourceLabel: string,
  knownProjectIds: Set<string>,
): { config?: TelegramBotConfig; errors: string[] } {
  const parsed = telegramBotSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: formatSectionZodErrors(parsed.error, sourceLabel, fieldPath) };
  }

  const config: TelegramBotConfig = parsed.data;
  const errors: string[] = [];

  if (config.allowedProjectIds) {
    const missingProjectIds = config.allowedProjectIds.filter(
      (projectId) => !knownProjectIds.has(projectId),
    );
    if (missingProjectIds.length > 0) {
      errors.push(
        `${sourceLabel}: ${fieldPath}.allowedProjectIds contains unknown project ids: ${missingProjectIds.join(", ")}.`,
      );
    }

    if (new Set(config.allowedProjectIds).size !== config.allowedProjectIds.length) {
      errors.push(
        `${sourceLabel}: ${fieldPath}.allowedProjectIds must contain unique project ids.`,
      );
    }
  }

  if (config.defaultProjectId && !knownProjectIds.has(config.defaultProjectId)) {
    errors.push(
      `${sourceLabel}: ${fieldPath}.defaultProjectId '${config.defaultProjectId}' is not configured.`,
    );
  }

  if (
    config.defaultProjectId &&
    config.allowedProjectIds &&
    !config.allowedProjectIds.includes(config.defaultProjectId)
  ) {
    errors.push(
      `${sourceLabel}: ${fieldPath}.defaultProjectId must be included in ${fieldPath}.allowedProjectIds.`,
    );
  }

  const projectCount = config.allowedProjectIds?.length ?? knownProjectIds.size;
  if (projectCount + TELEGRAM_BUILTIN_COMMAND_COUNT > TELEGRAM_MAX_COMMAND_COUNT) {
    errors.push(
      `${sourceLabel}: ${fieldPath} exposes ${projectCount} projects, exceeding Telegram's ${TELEGRAM_MAX_COMMAND_COUNT}-command limit with built-in commands.`,
    );
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { config, errors: [] };
}

function parseBots(
  raw: unknown,
  sourceLabel: string,
  knownProjectIds: Set<string>,
): { config?: Record<string, TelegramBotConfig>; errors: string[] } {
  const parsedObject = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsedObject.success) {
    return { errors: [`${sourceLabel}: bots must be an object.`] };
  }

  const entries = Object.entries(parsedObject.data);
  if (entries.length === 0) {
    return { errors: [`${sourceLabel}: bots must define at least one bot id.`] };
  }

  const config: Record<string, TelegramBotConfig> = {};
  const errors: string[] = [];

  for (const [botId, botRaw] of entries) {
    if (!botId.trim()) {
      errors.push(`${sourceLabel}: bot id must be a non-empty string.`);
      continue;
    }

    const parsed = parseTelegramBotConfig(botRaw, `bots.${botId}`, sourceLabel, knownProjectIds);
    if (parsed.config) {
      config[botId] = parsed.config;
    }
    errors.push(...parsed.errors);
  }

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function isGithubRepoRef(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function parsePersona(
  rawPersona: string,
  sourceLabel: string,
  fieldPath: string,
): { persona?: string; errors: string[] } {
  const parsedPersona = parsePersonaReference(rawPersona);
  if (parsedPersona.error === "empty-persona") {
    return { errors: [`${sourceLabel}: ${fieldPath} must be a non-empty string.`] };
  }
  if (parsedPersona.error === "missing-reasoning") {
    return { errors: [`${sourceLabel}: ${fieldPath} is missing a reasoning level after ':'.`] };
  }
  if (parsedPersona.error === "invalid-reasoning") {
    return {
      errors: [
        `${sourceLabel}: ${fieldPath} has invalid reasoning level '${parsedPersona.rawReasoning}'. allowed levels: ${REASONING_LEVELS.join(", ")}.`,
      ],
    };
  }
  if (!parsedPersona.personaId) {
    return { errors: [`${sourceLabel}: ${fieldPath} must be a non-empty string.`] };
  }

  return {
    persona: formatPersonaReference({
      personaId: parsedPersona.personaId,
      reasoning: parsedPersona.reasoning,
    }),
    errors: [],
  };
}

function parseProject(
  raw: unknown,
  sourceLabel: string,
  projectId: string,
  configDir: string,
): { config?: TelegramProjectConfig; errors: string[] } {
  const fieldPath = `projects.${projectId}`;
  const rawObject = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!rawObject.success) {
    return { errors: [`${sourceLabel}: ${fieldPath} must be an object.`] };
  }

  const hasRepo = Object.hasOwn(rawObject.data, "repo");
  const hasDirectory = Object.hasOwn(rawObject.data, "directory");
  const hasProjectIds = Object.hasOwn(rawObject.data, "projectIds");
  if ([hasRepo, hasDirectory, hasProjectIds].filter(Boolean).length !== 1) {
    return {
      errors: [
        `${sourceLabel}: ${fieldPath} must define exactly one of repo, directory, or projectIds.`,
      ],
    };
  }

  const incompatibleFields = hasRepo
    ? ["directory", "projectIds", "instructions"]
    : hasDirectory
      ? ["repo", "ref", "workingDirectory", "workspaceRoot", "projectIds", "instructions"]
      : ["repo", "directory", "ref", "workingDirectory", "noAgentContextFiles"];
  const configuredIncompatibleFields = incompatibleFields.filter((field) =>
    Object.hasOwn(rawObject.data, field),
  );
  if (configuredIncompatibleFields.length > 0) {
    return {
      errors: [
        `${sourceLabel}: ${fieldPath} does not support ${configuredIncompatibleFields.join(", ")}.`,
      ],
    };
  }

  const schema = hasRepo
    ? createRepositoryProjectSchema(configDir)
    : hasDirectory
      ? createDirectoryProjectSchema(configDir)
      : createCompositeProjectSchema(configDir);
  const parsed = schema.safeParse(rawObject.data);
  if (!parsed.success) {
    return { errors: formatSectionZodErrors(parsed.error, sourceLabel, fieldPath) };
  }

  const config = parsed.data as TelegramProjectConfig;
  if ("projectIds" in config && new Set(config.projectIds).size !== config.projectIds.length) {
    return { errors: [`${sourceLabel}: ${fieldPath}.projectIds must contain unique project ids.`] };
  }

  if (config.persona === undefined) {
    return { config, errors: [] };
  }

  const personaResult = parsePersona(config.persona, sourceLabel, `${fieldPath}.persona`);
  if (!personaResult.persona) {
    return { errors: personaResult.errors };
  }
  config.persona = personaResult.persona;
  return { config, errors: [] };
}

function parseProjects(
  raw: unknown,
  sourceLabel: string,
  configDir: string,
): { projects: Record<string, TelegramProjectConfig>; errors: string[] } {
  const parsedObject = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsedObject.success) {
    return { projects: {}, errors: [`${sourceLabel}: projects must be an object.`] };
  }

  const errors: string[] = [];
  const projects: Record<string, TelegramProjectConfig> = {};

  for (const [projectId, value] of Object.entries(parsedObject.data)) {
    if (!/^[a-z0-9_]+$/.test(projectId) || projectId.length > TELEGRAM_MAX_PROJECT_ID_LENGTH) {
      errors.push(
        `${sourceLabel}: project id '${projectId}' must contain only lowercase letters, digits, and underscores and be at most ${TELEGRAM_MAX_PROJECT_ID_LENGTH} characters.`,
      );
      continue;
    }

    const parsed = parseProject(value, sourceLabel, projectId, configDir);
    if (parsed.config) {
      projects[projectId] = parsed.config;
    }
    errors.push(...parsed.errors);
  }

  for (const [projectId, project] of Object.entries(projects)) {
    if (!("projectIds" in project)) {
      continue;
    }

    for (const memberProjectId of project.projectIds) {
      const memberProject = projects[memberProjectId];
      if (!memberProject) {
        errors.push(
          `${sourceLabel}: projects.${projectId}.projectIds contains unknown project id '${memberProjectId}'.`,
        );
      } else if (!("repo" in memberProject)) {
        const memberKind = "directory" in memberProject ? "directory" : "composite";
        errors.push(
          `${sourceLabel}: projects.${projectId}.projectIds must reference repository projects, not ${memberKind} project '${memberProjectId}'.`,
        );
      }
    }
  }

  return { projects, errors };
}

export function loadTelegramConfig(configFilePath: string): TelegramConfig {
  const resolvedPath = resolve(configFilePath);
  const sourceLabel = `telegram config (${resolvedPath})`;
  const configDir = dirname(resolvedPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
  } catch (error) {
    throw new TelegramConfigError(
      `${sourceLabel}: failed to read/parse json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsedConfigObject = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!parsedConfigObject.success) {
    throw new TelegramConfigError(`${sourceLabel}: config must be an object.`);
  }

  const data = parsedConfigObject.data;
  const errors: string[] = [];

  const topLevelResult = telegramTopLevelSchema.safeParse(data);
  if (!topLevelResult.success) {
    errors.push(...formatSectionZodErrors(topLevelResult.error, sourceLabel, "config"));
  }

  const topLevel = topLevelResult.success ? topLevelResult.data : {};
  const maxSessions = topLevel.maxSessions;
  const workspaceRoot = resolve(configDir, topLevel.workspaceRoot ?? ".tau/telegram-workspaces");
  const systemMessage = topLevel.systemMessage;

  const projectsResult = parseProjects(data.projects, sourceLabel, configDir);
  const botsResult = parseBots(
    data.bots,
    sourceLabel,
    new Set(Object.keys(projectsResult.projects)),
  );

  errors.push(...projectsResult.errors, ...botsResult.errors);

  if (errors.length > 0) {
    throw new TelegramConfigError(errors.join("\n"));
  }

  return {
    ...(maxSessions === undefined ? {} : { maxSessions }),
    workspaceRoot,
    ...(systemMessage ? { systemMessage } : {}),
    bots: botsResult.config ?? {},
    projects: projectsResult.projects,
  };
}
