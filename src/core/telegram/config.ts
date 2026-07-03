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
  .strict();

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
  .strict();

function createProjectSchema(configDir: string) {
  return z
    .object({
      repo: nonEmptyStringSchema.refine((value) => isGithubRepoRef(value), {
        message: "must be in owner/repo format (GitHub).",
      }),
      ref: nonEmptyStringSchema.optional(),
      workspaceRoot: nonEmptyStringSchema
        .transform((value) => resolve(configDir, value))
        .optional(),
      workingDirectory: nonEmptyStringSchema
        .refine((value) => !isAbsolute(value), {
          message: "must be a relative path.",
        })
        .optional(),
      description: nonEmptyStringSchema.optional(),
      bootstrapCommands: z
        .array(
          z.string().refine((value) => value.trim().length > 0),
          {
            message: "must be a non-empty string array.",
          },
        )
        .min(1, "must be a non-empty string array.")
        .optional(),
      backgroundBootstrapCommands: z
        .array(
          z.string().refine((value) => value.trim().length > 0),
          {
            message: "must be a non-empty string array.",
          },
        )
        .min(1, "must be a non-empty string array.")
        .optional(),
      persona: z.string().optional(),
      riskLevel: z.enum(["read-only", "read-write"]).optional(),
      noAgentContextFiles: z.boolean().optional(),
    })
    .strict();
}

function formatUnknownKeysError(sourceLabel: string, fieldPath: string, keys: string[]): string {
  const unknownKeys = [...keys].sort();
  const keyLabel = unknownKeys.length === 1 ? "key" : "keys";
  return `${sourceLabel}: unknown ${keyLabel} in ${fieldPath}: ${unknownKeys.join(", ")}.`;
}

function formatSectionZodErrors(
  error: z.ZodError,
  sourceLabel: string,
  fieldPath: string,
): string[] {
  const errors: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      errors.push(formatUnknownKeysError(sourceLabel, fieldPath, issue.keys));
      continue;
    }

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

function parseProject(
  raw: unknown,
  sourceLabel: string,
  projectId: string,
  configDir: string,
): { config?: TelegramProjectConfig; errors: string[] } {
  const schema = createProjectSchema(configDir);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { errors: formatSectionZodErrors(parsed.error, sourceLabel, `projects.${projectId}`) };
  }

  const config: TelegramProjectConfig = parsed.data;
  const errors: string[] = [];

  if (config.persona !== undefined) {
    const parsedPersona = parsePersonaReference(config.persona);
    if (parsedPersona.error === "empty-persona") {
      errors.push(`${sourceLabel}: projects.${projectId}.persona must be a non-empty string.`);
    } else if (parsedPersona.error === "missing-reasoning") {
      errors.push(
        `${sourceLabel}: projects.${projectId}.persona is missing a reasoning level after ':'.`,
      );
    } else if (parsedPersona.error === "invalid-reasoning") {
      errors.push(
        `${sourceLabel}: projects.${projectId}.persona has invalid reasoning level '${parsedPersona.rawReasoning}'. allowed levels: ${REASONING_LEVELS.join(", ")}.`,
      );
    } else if (parsedPersona.personaId) {
      config.persona = formatPersonaReference({
        personaId: parsedPersona.personaId,
        reasoning: parsedPersona.reasoning,
      });
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

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
    if (!projectId.trim()) {
      errors.push(`${sourceLabel}: projects keys must be non-empty.`);
      continue;
    }

    const parsed = parseProject(value, sourceLabel, projectId, configDir);
    if (parsed.config) {
      projects[projectId] = parsed.config;
    }
    errors.push(...parsed.errors);
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
