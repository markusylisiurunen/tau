import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { parseMarkdownFrontMatter } from "../config/markdown_frontmatter.js";
import type {
  AsyncProjectConfig,
  AsyncServerTelegramBotConfig,
  AsyncServerTelegramConfig,
} from "../config/schema.js";
import { formatPersonaReference, parsePersonaReference } from "../persona_reference.js";
import { REASONING_LEVELS } from "../types.js";
import type { AsyncCronJobConfig } from "./cron.js";
import { parseCronSchedule } from "./cron.js";

export type AsyncDaemonCronConfig = {
  systemMessage?: string;
  jobsDir?: string;
};

export type AsyncDaemonConfig = {
  host: string;
  port: number;
  authToken?: string;
  maxSessions?: number;
  workspaceRoot: string;
  systemMessage?: string;
  telegram?: AsyncServerTelegramConfig;
  cron?: AsyncDaemonCronConfig;
  projects: Record<string, AsyncProjectConfig>;
  cronJobs?: Record<string, AsyncCronJobConfig>;
};

export class AsyncDaemonConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncDaemonConfigError";
  }
}

const nonEmptyStringSchema = z.string().trim().min(1, "must be a non-empty string.");

const CRON_JOB_FRONTMATTER_KEYS = new Set(["id", "projectId", "schedule", "enabled"]);

const positiveIntegerSchema = z
  .number()
  .int("must be a positive integer.")
  .positive("must be a positive integer.");

const asyncIdListSchema = z.array(z.number().int(), {
  message: "must be an array of integers.",
});

const asyncStringListSchema = z.array(nonEmptyStringSchema, {
  message: "must be an array of non-empty strings.",
});

const asyncDaemonCronSchema = z
  .object({
    systemMessage: nonEmptyStringSchema.optional(),
    jobsDir: nonEmptyStringSchema.optional(),
  })
  .strict();

const asyncDaemonTopLevelSchema = z
  .object({
    host: nonEmptyStringSchema.optional(),
    port: z
      .number()
      .int("must be a positive integer <= 65535.")
      .positive("must be a positive integer <= 65535.")
      .max(65535, "must be a positive integer <= 65535.")
      .optional(),
    authToken: nonEmptyStringSchema.optional(),
    maxSessions: positiveIntegerSchema.optional(),
    workspaceRoot: nonEmptyStringSchema.optional(),
    systemMessage: nonEmptyStringSchema.optional(),
    telegram: z.unknown().optional(),
    cron: z.unknown().optional(),
    projects: z.unknown().optional(),
  })
  .strict();

const telegramBotSchema = z
  .object({
    botToken: nonEmptyStringSchema,
    allowedProjectIds: asyncStringListSchema.min(1, "must not be empty.").optional(),
    allowedUserIds: asyncIdListSchema.optional(),
    allowedChatIds: asyncIdListSchema.optional(),
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
      sandbox: z.boolean().optional(),
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
): { config?: AsyncServerTelegramBotConfig; errors: string[] } {
  const parsed = telegramBotSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: formatSectionZodErrors(parsed.error, sourceLabel, fieldPath) };
  }

  const config: AsyncServerTelegramBotConfig = parsed.data;
  const errors: string[] = [];

  if (config.allowedProjectIds) {
    const missingProjectIds = config.allowedProjectIds.filter(
      (projectId) => !knownProjectIds.has(projectId),
    );
    if (missingProjectIds.length > 0) {
      errors.push(
        `${sourceLabel}: ${fieldPath}.allowedProjectIds contains unknown project ids: ${missingProjectIds.join(", ")}`,
      );
    }
  }

  if (config.defaultProjectId && !knownProjectIds.has(config.defaultProjectId)) {
    errors.push(
      `${sourceLabel}: ${fieldPath}.defaultProjectId '${config.defaultProjectId}' is not configured`,
    );
  }

  if (
    config.defaultProjectId &&
    config.allowedProjectIds &&
    !config.allowedProjectIds.includes(config.defaultProjectId)
  ) {
    errors.push(
      `${sourceLabel}: ${fieldPath}.defaultProjectId must be included in ${fieldPath}.allowedProjectIds`,
    );
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { config, errors: [] };
}

function parseTelegramConfig(
  raw: unknown,
  sourceLabel: string,
  knownProjectIds: Set<string>,
): { config?: AsyncServerTelegramConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsedObject = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsedObject.success) {
    return { errors: [`${sourceLabel}: telegram must be an object.`] };
  }

  const entries = Object.entries(parsedObject.data);
  if (entries.length === 0) {
    return { errors: [`${sourceLabel}: telegram must define at least one bot id.`] };
  }

  const config: AsyncServerTelegramConfig = {};
  const errors: string[] = [];

  for (const [botId, botRaw] of entries) {
    if (!botId.trim()) {
      errors.push(`${sourceLabel}: telegram bot id must be a non-empty string.`);
      continue;
    }

    const parsed = parseTelegramBotConfig(
      botRaw,
      `telegram.${botId}`,
      sourceLabel,
      knownProjectIds,
    );
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

function parseCronConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AsyncDaemonCronConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = asyncDaemonCronSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: formatSectionZodErrors(parsed.error, sourceLabel, "cron") };
  }

  const config = parsed.data;
  if (Object.keys(config).length === 0) {
    return { errors: [] };
  }

  return { config, errors: [] };
}

function isGithubRepoRef(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function parseProject(
  raw: unknown,
  sourceLabel: string,
  projectId: string,
  configDir: string,
): { config?: AsyncProjectConfig; errors: string[] } {
  const schema = createProjectSchema(configDir);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { errors: formatSectionZodErrors(parsed.error, sourceLabel, `projects.${projectId}`) };
  }

  const config: AsyncProjectConfig = parsed.data;
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
): { projects: Record<string, AsyncProjectConfig>; errors: string[] } {
  const parsedObject = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!parsedObject.success) {
    return { projects: {}, errors: [`${sourceLabel}: projects must be an object.`] };
  }

  const errors: string[] = [];
  const projects: Record<string, AsyncProjectConfig> = {};

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

function parseCronJobMarkdownFile(
  filePath: string,
  projects: Record<string, AsyncProjectConfig>,
  sourceLabel: string,
): { id?: string; job?: AsyncCronJobConfig; errors: string[] } {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      errors: [
        `${sourceLabel}: failed to read cron job file '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const markdownResult = parseMarkdownFrontMatter(content);
  if (!markdownResult.ok) {
    return { errors: [`${sourceLabel}: ${filePath}: ${markdownResult.message}.`] };
  }

  const { frontMatter, body } = markdownResult;

  const fileId = basename(filePath, ".md").trim();
  const errors: string[] = [];

  const unknownKeys = Object.keys(frontMatter)
    .filter((key) => !CRON_JOB_FRONTMATTER_KEYS.has(key))
    .sort();
  if (unknownKeys.length > 0) {
    errors.push(formatUnknownKeysError(sourceLabel, `${filePath} frontmatter`, unknownKeys));
  }

  const enabledRaw = frontMatter.enabled;
  if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter enabled must be a boolean when set.`);
    return { errors };
  }

  if (enabledRaw === false) {
    return { errors: [] };
  }

  const id = typeof frontMatter.id === "string" ? frontMatter.id.trim() : "";
  if (!id) {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter id must be a non-empty string.`);
    return { errors };
  }

  if (id !== fileId) {
    errors.push(
      `${sourceLabel}: ${filePath}: frontmatter id "${id}" must match file name "${fileId}".`,
    );
  }

  const projectId = typeof frontMatter.projectId === "string" ? frontMatter.projectId.trim() : "";
  if (!projectId) {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter projectId must be a non-empty string.`);
  } else if (!projects[projectId]) {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter projectId refers to an unknown project.`);
  }

  const schedule = typeof frontMatter.schedule === "string" ? frontMatter.schedule.trim() : "";
  if (!schedule) {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter schedule must be a non-empty string.`);
  } else {
    try {
      parseCronSchedule(schedule);
    } catch (error) {
      errors.push(
        `${sourceLabel}: ${filePath}: frontmatter schedule is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const prompt = body.trim();
  if (!prompt) {
    errors.push(`${sourceLabel}: ${filePath}: cron job prompt body must be non-empty.`);
  }

  if (errors.length > 0 || !projectId || !schedule || !prompt) {
    return { errors };
  }

  return {
    id,
    job: {
      projectId,
      schedule,
      prompt,
    },
    errors: [],
  };
}

function parseCronJobsDir(
  jobsDir: string | undefined,
  sourceLabel: string,
  configDir: string,
  projects: Record<string, AsyncProjectConfig>,
): {
  configured: boolean;
  cronJobs: Record<string, AsyncCronJobConfig>;
  errors: string[];
} {
  if (jobsDir === undefined) {
    return { configured: false, cronJobs: {}, errors: [] };
  }

  const cronJobsDir = resolve(configDir, jobsDir);

  let directoryStat: ReturnType<typeof statSync>;
  try {
    directoryStat = statSync(cronJobsDir);
  } catch (error) {
    return {
      configured: true,
      cronJobs: {},
      errors: [
        `${sourceLabel}: cron.jobsDir does not exist: ${cronJobsDir} (${error instanceof Error ? error.message : String(error)})`,
      ],
    };
  }

  if (!directoryStat.isDirectory()) {
    return {
      configured: true,
      cronJobs: {},
      errors: [`${sourceLabel}: cron.jobsDir is not a directory: ${cronJobsDir}`],
    };
  }

  let fileNames: string[];
  try {
    fileNames = readdirSync(cronJobsDir)
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort();
  } catch (error) {
    return {
      configured: true,
      cronJobs: {},
      errors: [
        `${sourceLabel}: failed to read cron.jobsDir '${cronJobsDir}': ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const errors: string[] = [];
  const cronJobs: Record<string, AsyncCronJobConfig> = {};

  for (const fileName of fileNames) {
    const filePath = join(cronJobsDir, fileName);
    const parsed = parseCronJobMarkdownFile(filePath, projects, sourceLabel);
    errors.push(...parsed.errors);

    if (!parsed.id || !parsed.job) {
      continue;
    }

    if (cronJobs[parsed.id]) {
      errors.push(`${sourceLabel}: duplicate cron job id '${parsed.id}'.`);
      continue;
    }

    cronJobs[parsed.id] = parsed.job;
  }

  return { configured: true, cronJobs, errors };
}

export function loadAsyncDaemonConfig(configFilePath: string): AsyncDaemonConfig {
  const resolvedPath = resolve(configFilePath);
  const sourceLabel = `async daemon config (${resolvedPath})`;
  const configDir = dirname(resolvedPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
  } catch (error) {
    throw new AsyncDaemonConfigError(
      `${sourceLabel}: failed to read/parse json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsedConfigObject = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!parsedConfigObject.success) {
    throw new AsyncDaemonConfigError(`${sourceLabel}: config must be an object.`);
  }

  const data = parsedConfigObject.data;
  const errors: string[] = [];

  const topLevelResult = asyncDaemonTopLevelSchema.safeParse(data);
  if (!topLevelResult.success) {
    errors.push(...formatSectionZodErrors(topLevelResult.error, sourceLabel, "config"));
  }

  const topLevel = topLevelResult.success ? topLevelResult.data : {};
  const host = topLevel.host ?? "127.0.0.1";
  const port = topLevel.port ?? 7788;
  const authToken = topLevel.authToken;
  const maxSessions = topLevel.maxSessions;
  const workspaceRoot = resolve(configDir, topLevel.workspaceRoot ?? ".tau/async-workspaces");
  const systemMessage = topLevel.systemMessage;

  const projectsResult = parseProjects(data.projects, sourceLabel, configDir);
  const telegramResult = parseTelegramConfig(
    data.telegram,
    sourceLabel,
    new Set(Object.keys(projectsResult.projects)),
  );
  const cronResult = parseCronConfig(data.cron, sourceLabel);
  const cronJobsResult = parseCronJobsDir(
    cronResult.config?.jobsDir,
    sourceLabel,
    configDir,
    projectsResult.projects,
  );

  errors.push(
    ...projectsResult.errors,
    ...telegramResult.errors,
    ...cronResult.errors,
    ...cronJobsResult.errors,
  );

  if (errors.length > 0) {
    throw new AsyncDaemonConfigError(errors.join("\n"));
  }

  return {
    host,
    port,
    authToken,
    maxSessions,
    workspaceRoot,
    ...(systemMessage ? { systemMessage } : {}),
    ...(telegramResult.config ? { telegram: telegramResult.config } : {}),
    ...(cronResult.config ? { cron: cronResult.config } : {}),
    ...(cronJobsResult.configured ? { cronJobs: cronJobsResult.cronJobs } : {}),
    projects: projectsResult.projects,
  };
}
