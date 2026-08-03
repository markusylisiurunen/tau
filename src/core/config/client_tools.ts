import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { ConfigLevel } from "./paths.js";

export type CommandClientToolConfig = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  executionTimeoutMs?: number;
};

const CommandClientToolSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    parameters: z
      .record(z.string(), z.unknown())
      .refine((value) => value.type === "object", "must be an object JSON Schema"),
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    executionTimeoutMs: z.number().int().positive().optional(),
  })
  .strip();

export function parseCommandClientToolsConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: CommandClientToolConfig[]; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }
  if (!Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: 'clientTools' must be an array.`] };
  }

  const config: CommandClientToolConfig[] = [];
  const errors: string[] = [];
  const names = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const parsed = CommandClientToolSchema.safeParse(entry);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      const path = typeof field === "string" ? `.${field}` : "";
      errors.push(
        `${sourceLabel}: clientTools[${index}]${path} ${formatClientToolIssue(field, issue?.message)}.`,
      );
      continue;
    }

    if (names.has(parsed.data.name)) {
      errors.push(
        `${sourceLabel}: clientTools[${index}].name duplicates client tool '${parsed.data.name}'.`,
      );
      continue;
    }

    names.add(parsed.data.name);
    config.push(parsed.data);
  }

  return {
    ...(config.length > 0 ? { config } : {}),
    errors,
  };
}

export function resolveCommandClientToolsConfig(
  level: ConfigLevel,
  config: CommandClientToolConfig[],
): CommandClientToolConfig[] {
  return config.map((tool) => ({
    ...tool,
    command: resolveCommand(level.levelRoot, tool.command),
    ...(tool.args ? { args: [...tool.args] } : {}),
    ...(tool.env ? { env: { ...tool.env } } : {}),
  }));
}

function formatClientToolIssue(
  field: PropertyKey | undefined,
  message: string | undefined,
): string {
  switch (field) {
    case "name":
      return "must be a non-empty string";
    case "description":
      return "must be a non-empty string";
    case "parameters":
      return "must be an object JSON Schema with type 'object'";
    case "command":
      return "must be a non-empty string";
    case "args":
      return "must be a string array";
    case "env":
      return "must be an object of string values";
    case "executionTimeoutMs":
      return "must be a positive integer";
    default:
      return message ?? "is invalid";
  }
}

function resolveCommand(levelRoot: string, command: string): string {
  if (isAbsolute(command)) {
    return command;
  }

  if (command.startsWith("./") || command.startsWith("../") || command.includes("/")) {
    return resolve(levelRoot, command);
  }

  return command;
}
