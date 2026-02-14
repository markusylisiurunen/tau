import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AsyncProjectConfig, AsyncServerTelegramConfig } from "../config/schema.js";

type RiskLevel = "read-only" | "read-write";

export type AsyncDaemonConfig = {
  host: string;
  port: number;
  authToken?: string;
  maxSessions?: number;
  workspaceRoot: string;
  systemMessage?: string;
  telegram?: AsyncServerTelegramConfig;
  projects: Record<string, AsyncProjectConfig>;
};

export class AsyncDaemonConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncDaemonConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0
  );
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

function parseTelegramConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AsyncServerTelegramConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: telegram must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: AsyncServerTelegramConfig = {};
  const errors: string[] = [];

  if (data.botToken !== undefined) {
    if (typeof data.botToken === "string" && data.botToken.trim()) {
      config.botToken = data.botToken.trim();
    } else {
      errors.push(`${sourceLabel}: telegram.botToken must be a non-empty string.`);
    }
  }

  if (data.allowedUserIds !== undefined) {
    const parsed = parseAsyncIdList(data.allowedUserIds, "telegram.allowedUserIds", sourceLabel);
    if (parsed.values) {
      config.allowedUserIds = parsed.values;
    }
    errors.push(...parsed.errors);
  }

  if (data.allowedChatIds !== undefined) {
    const parsed = parseAsyncIdList(data.allowedChatIds, "telegram.allowedChatIds", sourceLabel);
    if (parsed.values) {
      config.allowedChatIds = parsed.values;
    }
    errors.push(...parsed.errors);
  }

  if (data.defaultProjectId !== undefined) {
    if (typeof data.defaultProjectId === "string" && data.defaultProjectId.trim()) {
      config.defaultProjectId = data.defaultProjectId.trim();
    } else {
      errors.push(`${sourceLabel}: telegram.defaultProjectId must be a non-empty string.`);
    }
  }

  if (data.systemMessage !== undefined) {
    if (typeof data.systemMessage === "string" && data.systemMessage.trim()) {
      config.systemMessage = data.systemMessage.trim();
    } else {
      errors.push(`${sourceLabel}: telegram.systemMessage must be a non-empty string.`);
    }
  }

  if (data.pollIntervalMs !== undefined) {
    if (isPositiveInteger(data.pollIntervalMs)) {
      config.pollIntervalMs = data.pollIntervalMs;
    } else {
      errors.push(`${sourceLabel}: telegram.pollIntervalMs must be a positive integer.`);
    }
  }

  if (data.requestTimeoutSeconds !== undefined) {
    if (isPositiveInteger(data.requestTimeoutSeconds)) {
      config.requestTimeoutSeconds = data.requestTimeoutSeconds;
    } else {
      errors.push(`${sourceLabel}: telegram.requestTimeoutSeconds must be a positive integer.`);
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
  const telegramResult = parseTelegramConfig(data.telegram, sourceLabel);
  errors.push(...projectsResult.errors, ...telegramResult.errors);

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
    projects: projectsResult.projects,
  };
}
