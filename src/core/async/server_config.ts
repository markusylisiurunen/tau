import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AsyncProjectConfig,
  AsyncServerTelegramBotConfig,
  AsyncServerTelegramConfig,
} from "../config/schema.js";
import type { AsyncCronJobConfig } from "./cron.js";
import { parseCronSchedule } from "./cron.js";

type RiskLevel = "read-only" | "read-write";

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

type FrontMatter = {
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0
  );
}

function parseMarkdownWithFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontMatter: {}, body: content.trim() };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontMatter: {}, body: content.trim() };
  }

  const frontMatterLines = lines.slice(1, endIndex);
  const bodyLines = lines.slice(endIndex + 1);

  return {
    frontMatter: parseYamlFrontMatter(frontMatterLines.join("\n")),
    body: bodyLines.join("\n").trim(),
  };
}

function parseYamlFrontMatter(yamlText: string): FrontMatter {
  try {
    const parsed = parseYaml(yamlText) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as FrontMatter;
  } catch {
    return {};
  }
}

function parseAsyncIdList(
  raw: unknown,
  fieldPath: string,
  sourceLabel: string,
): { values?: number[]; errors: string[] } {
  if (!Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: ${fieldPath} must be an array of integers.`] };
  }

  const values: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || !Number.isInteger(entry)) {
      return { errors: [`${sourceLabel}: ${fieldPath} must be an array of integers.`] };
    }
    values.push(entry);
  }

  return { values, errors: [] };
}

function parseAsyncStringList(
  raw: unknown,
  fieldPath: string,
  sourceLabel: string,
): { values?: string[]; errors: string[] } {
  if (!Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: ${fieldPath} must be an array of non-empty strings.`] };
  }

  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      return { errors: [`${sourceLabel}: ${fieldPath} must be an array of non-empty strings.`] };
    }
    values.push(entry.trim());
  }

  return { values, errors: [] };
}

const TELEGRAM_DEFAULT_BOT_ID = "default";
const TELEGRAM_BOT_CONFIG_KEYS = new Set([
  "botToken",
  "allowedProjectIds",
  "allowedUserIds",
  "allowedChatIds",
  "defaultProjectId",
  "systemMessage",
  "pollIntervalMs",
  "requestTimeoutSeconds",
]);

function parseTelegramBotConfig(
  raw: unknown,
  fieldPath: string,
  sourceLabel: string,
  knownProjectIds: Set<string>,
): { config?: AsyncServerTelegramBotConfig; errors: string[] } {
  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: ${fieldPath} must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: AsyncServerTelegramBotConfig = {};
  const errors: string[] = [];

  if (data.botToken !== undefined) {
    if (typeof data.botToken === "string" && data.botToken.trim()) {
      config.botToken = data.botToken.trim();
    } else {
      errors.push(`${sourceLabel}: ${fieldPath}.botToken must be a non-empty string.`);
    }
  }

  if (data.allowedProjectIds !== undefined) {
    const parsed = parseAsyncStringList(
      data.allowedProjectIds,
      `${fieldPath}.allowedProjectIds`,
      sourceLabel,
    );

    if (parsed.values) {
      if (parsed.values.length === 0) {
        errors.push(`${sourceLabel}: ${fieldPath}.allowedProjectIds must not be empty.`);
      } else {
        const missingProjectIds = parsed.values.filter(
          (projectId) => !knownProjectIds.has(projectId),
        );
        if (missingProjectIds.length > 0) {
          errors.push(
            `${sourceLabel}: ${fieldPath}.allowedProjectIds contains unknown project ids: ${missingProjectIds.join(", ")}`,
          );
        } else {
          config.allowedProjectIds = parsed.values;
        }
      }
    }

    errors.push(...parsed.errors);
  }

  if (data.allowedUserIds !== undefined) {
    const parsed = parseAsyncIdList(
      data.allowedUserIds,
      `${fieldPath}.allowedUserIds`,
      sourceLabel,
    );
    if (parsed.values) {
      config.allowedUserIds = parsed.values;
    }
    errors.push(...parsed.errors);
  }

  if (data.allowedChatIds !== undefined) {
    const parsed = parseAsyncIdList(
      data.allowedChatIds,
      `${fieldPath}.allowedChatIds`,
      sourceLabel,
    );
    if (parsed.values) {
      config.allowedChatIds = parsed.values;
    }
    errors.push(...parsed.errors);
  }

  if (data.defaultProjectId !== undefined) {
    if (typeof data.defaultProjectId === "string" && data.defaultProjectId.trim()) {
      config.defaultProjectId = data.defaultProjectId.trim();
    } else {
      errors.push(`${sourceLabel}: ${fieldPath}.defaultProjectId must be a non-empty string.`);
    }
  }

  if (data.systemMessage !== undefined) {
    if (typeof data.systemMessage === "string" && data.systemMessage.trim()) {
      config.systemMessage = data.systemMessage.trim();
    } else {
      errors.push(`${sourceLabel}: ${fieldPath}.systemMessage must be a non-empty string.`);
    }
  }

  if (data.pollIntervalMs !== undefined) {
    if (isPositiveInteger(data.pollIntervalMs)) {
      config.pollIntervalMs = data.pollIntervalMs;
    } else {
      errors.push(`${sourceLabel}: ${fieldPath}.pollIntervalMs must be a positive integer.`);
    }
  }

  if (data.requestTimeoutSeconds !== undefined) {
    if (isPositiveInteger(data.requestTimeoutSeconds)) {
      config.requestTimeoutSeconds = data.requestTimeoutSeconds;
    } else {
      errors.push(`${sourceLabel}: ${fieldPath}.requestTimeoutSeconds must be a positive integer.`);
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

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function parseTelegramConfig(
  raw: unknown,
  sourceLabel: string,
  knownProjectIds: Set<string>,
): { config?: AsyncServerTelegramConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: telegram must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const entries = Object.entries(data);
  const hasLegacyKeys = entries.some(([key]) => TELEGRAM_BOT_CONFIG_KEYS.has(key));
  const hasNamedBots = entries.some(([key]) => !TELEGRAM_BOT_CONFIG_KEYS.has(key));

  if (hasLegacyKeys && hasNamedBots) {
    return {
      errors: [
        `${sourceLabel}: telegram must be either a single bot config object or a map of bot ids to bot config objects.`,
      ],
    };
  }

  const config: AsyncServerTelegramConfig = {};
  const errors: string[] = [];

  if (hasLegacyKeys || entries.length === 0) {
    const parsed = parseTelegramBotConfig(data, "telegram", sourceLabel, knownProjectIds);
    if (parsed.config) {
      config[TELEGRAM_DEFAULT_BOT_ID] = parsed.config;
    }
    errors.push(...parsed.errors);
  } else {
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

  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: cron must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: AsyncDaemonCronConfig = {};
  const errors: string[] = [];

  if (data.systemMessage !== undefined) {
    if (typeof data.systemMessage === "string" && data.systemMessage.trim()) {
      config.systemMessage = data.systemMessage.trim();
    } else {
      errors.push(`${sourceLabel}: cron.systemMessage must be a non-empty string.`);
    }
  }

  if (data.jobsDir !== undefined) {
    if (typeof data.jobsDir === "string" && data.jobsDir.trim()) {
      config.jobsDir = data.jobsDir.trim();
    } else {
      errors.push(`${sourceLabel}: cron.jobsDir must be a non-empty string.`);
    }
  }

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function parseRiskLevel(raw: unknown): RiskLevel | undefined {
  if (raw === "read-only" || raw === "read-write") {
    return raw;
  }

  return undefined;
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
  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: projects.${projectId} must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const errors: string[] = [];

  const repoRaw = data.repo;
  if (typeof repoRaw !== "string" || !repoRaw.trim()) {
    errors.push(`${sourceLabel}: projects.${projectId}.repo must be a non-empty string.`);
  } else if (!isGithubRepoRef(repoRaw.trim())) {
    errors.push(
      `${sourceLabel}: projects.${projectId}.repo must be in owner/repo format (GitHub).`,
    );
  }

  const config: AsyncProjectConfig = {
    repo: typeof repoRaw === "string" ? repoRaw.trim() : "",
  };

  if (data.ref !== undefined) {
    if (typeof data.ref === "string" && data.ref.trim()) {
      config.ref = data.ref.trim();
    } else {
      errors.push(`${sourceLabel}: projects.${projectId}.ref must be a non-empty string.`);
    }
  }

  if (data.workspaceRoot !== undefined) {
    if (typeof data.workspaceRoot === "string" && data.workspaceRoot.trim()) {
      config.workspaceRoot = resolve(configDir, data.workspaceRoot.trim());
    } else {
      errors.push(
        `${sourceLabel}: projects.${projectId}.workspaceRoot must be a non-empty string.`,
      );
    }
  }

  if (data.workingDirectory !== undefined) {
    if (typeof data.workingDirectory === "string" && data.workingDirectory.trim()) {
      const workingDirectory = data.workingDirectory.trim();
      if (isAbsolute(workingDirectory)) {
        errors.push(
          `${sourceLabel}: projects.${projectId}.workingDirectory must be a relative path.`,
        );
      } else {
        config.workingDirectory = workingDirectory;
      }
    } else {
      errors.push(
        `${sourceLabel}: projects.${projectId}.workingDirectory must be a non-empty string.`,
      );
    }
  }

  if (data.description !== undefined) {
    if (typeof data.description === "string" && data.description.trim()) {
      config.description = data.description.trim();
    } else {
      errors.push(`${sourceLabel}: projects.${projectId}.description must be a non-empty string.`);
    }
  }

  if (data.bootstrapCommands !== undefined) {
    if (!Array.isArray(data.bootstrapCommands) || data.bootstrapCommands.length === 0) {
      errors.push(
        `${sourceLabel}: projects.${projectId}.bootstrapCommands must be a non-empty string array.`,
      );
    } else {
      const commands: string[] = [];
      for (const command of data.bootstrapCommands) {
        if (typeof command !== "string" || !command.trim()) {
          errors.push(
            `${sourceLabel}: projects.${projectId}.bootstrapCommands must be a non-empty string array.`,
          );
          break;
        }
        commands.push(command);
      }
      if (commands.length > 0) {
        config.bootstrapCommands = commands;
      }
    }
  }

  if (data.persona !== undefined) {
    if (typeof data.persona === "string" && data.persona.trim()) {
      config.persona = data.persona.trim();
    } else {
      errors.push(`${sourceLabel}: projects.${projectId}.persona must be a non-empty string.`);
    }
  }

  if (data.riskLevel !== undefined) {
    const riskLevel = parseRiskLevel(data.riskLevel);
    if (riskLevel) {
      config.riskLevel = riskLevel;
    } else {
      errors.push(
        `${sourceLabel}: projects.${projectId}.riskLevel must be read-only or read-write.`,
      );
    }
  }

  if (data.sandbox !== undefined) {
    if (typeof data.sandbox === "boolean") {
      config.sandbox = data.sandbox;
    } else {
      errors.push(`${sourceLabel}: projects.${projectId}.sandbox must be a boolean.`);
    }
  }

  if (data.noAgentContextFiles !== undefined) {
    if (typeof data.noAgentContextFiles === "boolean") {
      config.noAgentContextFiles = data.noAgentContextFiles;
    } else {
      errors.push(`${sourceLabel}: projects.${projectId}.noAgentContextFiles must be a boolean.`);
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
  if (!isRecord(raw)) {
    return { projects: {}, errors: [`${sourceLabel}: projects must be an object.`] };
  }

  const errors: string[] = [];
  const projects: Record<string, AsyncProjectConfig> = {};

  for (const [projectId, value] of Object.entries(raw)) {
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

  const { frontMatter, body } = parseMarkdownWithFrontMatter(content);
  const fileId = basename(filePath, ".md").trim();
  const errors: string[] = [];

  const enabledRaw = frontMatter.enabled;
  if (enabledRaw !== undefined && typeof enabledRaw !== "boolean") {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter enabled must be a boolean when set.`);
    return { errors };
  }

  if (enabledRaw === false) {
    return { errors: [] };
  }

  const idRaw = frontMatter.id;
  const id = typeof idRaw === "string" ? idRaw.trim() : "";
  if (!id) {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter id must be a non-empty string.`);
    return { errors };
  }

  if (id !== fileId) {
    errors.push(
      `${sourceLabel}: ${filePath}: frontmatter id "${id}" must match file name "${fileId}".`,
    );
  }

  const projectIdRaw = frontMatter.projectId;
  const projectId = typeof projectIdRaw === "string" ? projectIdRaw.trim() : "";
  if (!projectId) {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter projectId must be a non-empty string.`);
  } else if (!projects[projectId]) {
    errors.push(`${sourceLabel}: ${filePath}: frontmatter projectId refers to an unknown project.`);
  }

  const scheduleRaw = frontMatter.schedule;
  const schedule = typeof scheduleRaw === "string" ? scheduleRaw.trim() : "";
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

  if (errors.length > 0) {
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

  if (!isRecord(parsed)) {
    throw new AsyncDaemonConfigError(`${sourceLabel}: config must be an object.`);
  }

  const data = parsed as Record<string, unknown>;
  const errors: string[] = [];

  let host = "127.0.0.1";
  if (data.host !== undefined) {
    if (typeof data.host === "string" && data.host.trim()) {
      host = data.host.trim();
    } else {
      errors.push(`${sourceLabel}: host must be a non-empty string.`);
    }
  }

  let port = 7788;
  if (data.port !== undefined) {
    if (isPositiveInteger(data.port) && data.port <= 65535) {
      port = data.port;
    } else {
      errors.push(`${sourceLabel}: port must be a positive integer <= 65535.`);
    }
  }

  let authToken: string | undefined;
  if (data.authToken !== undefined) {
    if (typeof data.authToken === "string" && data.authToken.trim()) {
      authToken = data.authToken.trim();
    } else {
      errors.push(`${sourceLabel}: authToken must be a non-empty string.`);
    }
  }

  let maxSessions: number | undefined;
  if (data.maxSessions !== undefined) {
    if (isPositiveInteger(data.maxSessions)) {
      maxSessions = data.maxSessions;
    } else {
      errors.push(`${sourceLabel}: maxSessions must be a positive integer.`);
    }
  }

  let workspaceRoot = resolve(configDir, ".tau", "async-workspaces");
  if (data.workspaceRoot !== undefined) {
    if (typeof data.workspaceRoot === "string" && data.workspaceRoot.trim()) {
      workspaceRoot = resolve(configDir, data.workspaceRoot.trim());
    } else {
      errors.push(`${sourceLabel}: workspaceRoot must be a non-empty string.`);
    }
  }

  let systemMessage: string | undefined;
  if (data.systemMessage !== undefined) {
    if (typeof data.systemMessage === "string" && data.systemMessage.trim()) {
      systemMessage = data.systemMessage.trim();
    } else {
      errors.push(`${sourceLabel}: systemMessage must be a non-empty string.`);
    }
  }

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
