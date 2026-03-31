import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { ConfigLevel } from "./paths.js";

export type DiffToolConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

const DiffToolSchema = z
  .object({
    command: z.string().trim().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export function parseDiffToolConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: DiffToolConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = DiffToolSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    if (issues.some((issue) => issue.path[0] === "command")) {
      return { errors: [`${sourceLabel}: diffTool.command must be a non-empty string.`] };
    }
    if (issues.some((issue) => issue.path[0] === "args")) {
      return { errors: [`${sourceLabel}: diffTool.args must be a string array.`] };
    }
    if (issues.some((issue) => issue.path[0] === "env")) {
      return { errors: [`${sourceLabel}: diffTool.env must be an object of string values.`] };
    }
    return { errors: [`${sourceLabel}: 'diffTool' must be an object.`] };
  }

  return {
    config: parsed.data,
    errors: [],
  };
}

export function resolveDiffToolConfig(level: ConfigLevel, config: DiffToolConfig): DiffToolConfig {
  const command = resolveDiffToolCommand(level.levelRoot, config.command);
  return {
    ...config,
    command,
    ...(config.args ? { args: [...config.args] } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
  };
}

function resolveDiffToolCommand(levelRoot: string, command: string): string {
  if (isAbsolute(command)) {
    return command;
  }

  if (command.startsWith("./") || command.startsWith("../") || command.includes("/")) {
    return resolve(levelRoot, command);
  }

  return command;
}
