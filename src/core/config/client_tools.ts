import { resolve } from "node:path";
import type { TSchema } from "typebox";
import { z } from "zod";
import type { ConfigLevel } from "./paths.js";

export type CommandClientToolConfig = {
  name: string;
  defaultEnabled: boolean;
  description: string;
  parameters: TSchema;
  command: string;
  args?: string[];
  executionTimeoutMs?: number;
};

const commandClientToolParametersSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value.type === "object", "must be an object JSON Schema with type 'object'")
  .transform((value) => value as TSchema);

const CommandClientToolSchema = z
  .object({
    name: z.string().trim().min(1),
    defaultEnabled: z.boolean(),
    description: z.string().trim().min(1),
    parameters: commandClientToolParametersSchema,
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
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

export function parseEnabledClientToolsConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: string[]; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }
  if (!Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: 'enabledClientTools' must be an array.`] };
  }

  const config: string[] = [];
  const errors: string[] = [];
  const names = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      errors.push(`${sourceLabel}: enabledClientTools[${index}] must be a non-empty string.`);
      continue;
    }

    const name = entry.trim();
    if (!names.has(name)) {
      names.add(name);
      config.push(name);
    }
  }

  return { config, errors };
}

export function selectCommandClientTools(
  tools: CommandClientToolConfig[],
  enabledNames?: string[],
): CommandClientToolConfig[] {
  if (enabledNames === undefined) {
    return tools.filter((tool) => tool.defaultEnabled);
  }

  const enabled = new Set(enabledNames);
  return tools.filter((tool) => enabled.has(tool.name));
}

export function resolveCommandClientToolsConfig(
  level: ConfigLevel,
  config: CommandClientToolConfig[],
): CommandClientToolConfig[] {
  return config.map((tool) => ({
    ...tool,
    command: resolveCommand(level.levelRoot, tool.command),
    ...(tool.args ? { args: [...tool.args] } : {}),
  }));
}

function formatClientToolIssue(
  field: PropertyKey | undefined,
  message: string | undefined,
): string {
  switch (field) {
    case "name":
      return "must be a non-empty string";
    case "defaultEnabled":
      return "must be a boolean";
    case "description":
      return "must be a non-empty string";
    case "parameters":
      return message ?? "must be an object JSON Schema with type 'object'";
    case "command":
      return "must be a non-empty string";
    case "args":
      return "must be a string array";
    case "executionTimeoutMs":
      return "must be a positive integer";
    default:
      return message ?? "is invalid";
  }
}

function resolveCommand(levelRoot: string, command: string): string {
  return command.includes("/") ? resolve(levelRoot, command) : command;
}
